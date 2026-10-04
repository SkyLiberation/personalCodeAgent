import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { AgentEvent, AgentEventData, AgentTool, ModelGateway, RunResult, ToolCall } from "../contracts.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { WindowsHost } from "../platform/windows.js";
import { LocalEnvironment } from "../environment/local.js";
import { PiModelGateway } from "../model/pi-gateway.js";
import { buildSystemPrompt } from "../resources/instructions.js";
import { AgentRuntime, unresolvedCalls } from "../runtime/agent.js";
import { abortError, errorText, SecretRedactor } from "../security.js";
import { SessionRepository } from "../storage/session.js";
import { createCodingTools } from "../tools/coding-tools.js";
import { ToolExecutor } from "../tools/executor.js";

interface QueuedInput {
  prompt: string;
  runId: string;
  resolve(result: RunResult): void;
  reject(error: unknown): void;
}

export interface SessionOptions {
  cwd?: string;
  config?: AgentConfig;
  sessionId?: string;
  dataDirectory?: string;
  readonly?: boolean;
  noShell?: boolean;
  gateway?: ModelGateway;
  tools?: AgentTool[];
  additionalTools?: AgentTool[];
  host?: WindowsHost;
  writablePaths?: string[];
  taskMode?: boolean;
  logPath?: string;
  hooks?: { beforeModel?: () => Promise<void>; beforeTool?: () => Promise<void>; afterEffect?: (call: ToolCall) => Promise<void> };
}

export class AgentSession {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly queue: QueuedInput[] = [];
  private steeringInputs: string[] = [];
  private active: AbortController | undefined;
  private draining: Promise<void> | undefined;
  private closed = false;
  private runId = "";
  private sequence = 0;

  constructor(
    readonly repository: SessionRepository,
    private readonly runtime: AgentRuntime,
    private readonly environment: LocalEnvironment,
    private readonly redactor: SecretRedactor,
    private readonly policy: { readonly: boolean; noShell: boolean },
    private readonly options: SessionOptions = {},
    private readonly tools: AgentTool[] = [],
  ) {}

  get id(): string { return this.repository.id; }
  get busy(): boolean { return this.active !== undefined || this.queue.length > 0; }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(data: AgentEventData): void {
    const event = this.redactor.json({
      ...data, sessionId: this.id, runId: this.runId, sequence: ++this.sequence, timestamp: Date.now(),
    }) as AgentEvent;
    for (const listener of this.listeners) {
      try { void Promise.resolve(listener(event)).catch(() => undefined); }
      catch { /* Observer errors do not change execution. */ }
    }
  }

  submit(prompt: string, whenBusy: "reject" | "follow_up" = "reject", options: { runId?: string } = {}): Promise<RunResult> {
    if (this.closed) return Promise.reject(new Error("会话已关闭"));
    if (!prompt.trim()) return Promise.reject(new Error("输入不能为空"));
    if (options.runId && !/^[a-zA-Z0-9_-]{1,100}$/.test(options.runId)) return Promise.reject(new Error("run ID 不合法"));
    if (this.busy && whenBusy === "reject") return Promise.reject(new Error("Agent 正在运行，请使用 follow_up 或 steer"));
    const result = new Promise<RunResult>((resolve, reject) => {
      this.queue.push({ prompt: this.redactor.text(prompt), runId: options.runId ?? randomUUID(), resolve, reject });
    });
    this.startDrain();
    return result;
  }

  private startDrain(): void {
    if (this.draining || this.closed) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      // A submit() continuation can arrive while the previous drain is settling.
      if (this.queue.length > 0) this.startDrain();
    });
  }

  async steer(prompt: string): Promise<"queued" | RunResult> {
    if (this.closed) throw new Error("会话已关闭");
    if (!prompt.trim()) throw new Error("调整消息不能为空");
    if (this.active) {
      this.steeringInputs.push(this.redactor.text(prompt));
      return "queued";
    }
    return this.submit(prompt);
  }

  abort(): string[] {
    this.active?.abort();
    const pending = this.steeringInputs;
    this.steeringInputs = [];
    return pending;
  }

  private async drain(): Promise<void> {
    for (;;) {
      const input = this.queue.shift();
      if (!input) return;
      this.active = new AbortController();
      this.runId = input.runId;
      this.sequence = 0;
      try {
        const result = await this.execute(input.prompt, this.active.signal);
        input.resolve(result);
      } catch (error) {
        input.reject(error);
      } finally {
        this.active = undefined;
      }
    }
  }

  private async execute(prompt: string, signal: AbortSignal): Promise<RunResult> {
    let result: RunResult;
    try {
      // Repair the protocol context, without replaying an uncertain file/process side effect.
      const pending = unresolvedCalls(this.repository.messages());
      if (this.options.taskMode && pending.length) throw new Error("effect_unknown：必须先完成工具恢复");
      for (const call of pending) {
        await this.repository.appendMessage({
          role: "tool_result", callId: call.id, toolName: call.name, timestamp: Date.now(),
          text: "上次运行在调用结果提交前中断。实际副作用未知；请先检查工作区再决定下一步。", isError: true,
        });
      }
      await this.repository.append({ kind: "run_status", runId: this.runId, status: "running" });
      const system = await buildSystemPrompt({ cwd: this.environment.cwd, shell: this.environment.shell, ...this.policy });
      const lastSystem = this.repository.messages().findLast((message) => message.role === "system");
      if (!lastSystem || lastSystem.text !== system) {
        await this.repository.appendMessage({ role: "system", text: system, timestamp: Date.now() });
      }
      if (!this.options.taskMode) await this.repository.appendMessage({ role: "user", text: prompt, timestamp: Date.now() });
      result = await this.runtime.run(this.repository.messages(), signal, {
        commit: (message) => this.repository.appendMessage(message),
        emit: (event) => this.emit(event),
        beforeModel: async () => { await this.options.hooks?.beforeModel?.(); },
        intent: async (call, replay) => {
          await this.options.hooks?.beforeTool?.();
          if (!this.options.taskMode) { await this.repository.append({ kind: "tool_intent", call, replay }); return; }
          const operationId = randomUUID();
          const assistant = this.repository.facts().findLast(entry => entry.kind === "message" && entry.message.role === "assistant");
          if (!assistant) throw new Error("缺少工具所属 assistant");
          let postcondition: { path: string; sha256: string } | undefined;
          const args = call.arguments as { path?: string; content?: string; oldText?: string; newText?: string };
          if (["write", "edit"].includes(call.name) && args.path) {
            const path = await this.environment.path(args.path);
            let content = args.content;
            if (call.name === "edit" && args.oldText !== undefined && args.newText !== undefined) {
              const original = await readFile(path, "utf8"); const at = original.indexOf(args.oldText);
              if (at >= 0 && original.indexOf(args.oldText, at + 1) < 0) content = original.slice(0, at) + args.newText + original.slice(at + args.oldText.length);
            }
            if (content !== undefined) postcondition = { path: args.path, sha256: createHash("sha256").update(content).digest("hex") };
          }
          await this.repository.append({ kind: "tool_intent", call, replay, operationId, assistantEntryId: assistant.id, runId: this.runId, toolVersion: this.tools.find(t => t.name === call.name)?.version ?? "1", ...(postcondition ? { postcondition } : {}) });
          return operationId;
        },
        afterEffect: async call => { await this.options.hooks?.afterEffect?.(call); },
        exec: (executable, args) => this.environment.exec(executable, args, signal),
        progress: async (callId, text) => { this.emit({ type: "tool_progress", callId, text }); },
        artifact: (text) => this.repository.artifact(text),
        steering: async () => {
          const inputs = this.steeringInputs;
          this.steeringInputs = [];
          const messages = [];
          for (const text of inputs) {
            const message = await this.repository.appendMessage({ role: "user", text, timestamp: Date.now() });
            messages.push(message);
            this.emit({ type: "message_committed", message });
          }
          return messages;
        },
      });
    } catch (error) {
      result = { status: signal.aborted ? "aborted" : "failed", text: "", turns: 0,
        error: this.redactor.text(errorText(error)) };
    }
    try {
      await this.repository.append({
        kind: "run_status", runId: this.runId, status: result.status, ...(result.error ? { error: result.error } : {}),
      });
    } catch (error) {
      throw new Error(`persistence_error：会话结果未提交；${this.redactor.text(errorText(error))}`);
    }
    this.emit({ type: "run_settled", status: result.status, ...(result.error ? { error: result.error } : {}) });
    return result;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    for (const queued of this.queue.splice(0)) queued.reject(abortError());
    await this.draining;
    await this.repository.close();
    this.listeners.clear();
  }

  setWritablePaths(paths: string[]): void { this.environment.setWritablePaths(paths); }
}

export async function createAgentSession(options: SessionOptions = {}): Promise<AgentSession> {
  const config = options.config ?? loadConfig();
  const redactor = new SecretRedactor([config.apiKey]);
  const environment = await LocalEnvironment.create(options.cwd ?? process.cwd(), config.toolTimeoutMs, options.host, options.writablePaths);
  const repository = await SessionRepository.open({
    directory: options.dataDirectory ?? fileURLToPath(new URL("../../.codeagent/sessions", import.meta.url)),
    cwd: environment.cwd, redactor, ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(options.host ? { host: options.host } : {}),
    ...(options.logPath ? { logPath: options.logPath } : {}),
  });
  try {
    const tools = [...(options.tools ?? createCodingTools(environment)), ...(options.additionalTools ?? [])];
    const executor = new ToolExecutor(tools, {
      readonly: options.readonly ?? false, noShell: options.noShell ?? false, redactor,
    });
    const runtime = new AgentRuntime(options.gateway ?? new PiModelGateway(config), executor, {
      maxTurns: config.maxTurns, redactor,
    });
    return new AgentSession(repository, runtime, environment, redactor, {
      readonly: options.readonly ?? false, noShell: options.noShell ?? false,
    }, options, tools);
  } catch (error) {
    await repository.close();
    throw error;
  }
}
