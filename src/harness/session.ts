import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../config.js";
import { loadConfig } from "../config.js";
import type { AgentEvent, AgentEventData, AgentTool, ModelGateway, RunResult, ToolCall } from "../contracts.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createExecutionHost, type ExecutionHost } from "../platform/host.js";
import { RequestContext, type ContextPolicy } from "./context.js";
import { LocalEnvironment } from "../environment/local.js";
import { PiModelGateway } from "../model/pi-gateway.js";
import { buildSystemPrompt } from "../resources/instructions.js";
import { AgentRuntime, unresolvedCalls } from "../runtime/agent.js";
import { abortError, errorText, SecretRedactor } from "../security.js";
import { SessionRepository } from "../storage/session.js";
import { createHistoryTool } from "../tools/history.js";
import { createCodingTools } from "../tools/coding-tools.js";
import { ToolExecutor, ToolPreparationError } from "../tools/executor.js";
import { discoverResources, skillTool, loadExtensions } from "../resources/catalog.js";

interface QueuedInput {
  inputId?: string;
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
  host?: ExecutionHost;
  writablePaths?: string[];
  taskMode?: boolean;
  durableInbox?: boolean;
  contextPolicy?: ContextPolicy;
  historyRetrieval?: boolean;
  maxReadConcurrency?: number;
  extensions?: Parameters<typeof loadExtensions>[0];
  discoverSkills?: boolean;
  toolPolicy?: (context: import("../contracts.js").ToolPolicyContext) => Promise<import("../contracts.js").ToolPolicyDecision>;
  confirmTool?: (context: import("../contracts.js").ToolPolicyContext, reason: string) => Promise<boolean>;
  logPath?: string;
  hooks?: { beforeModel?: () => Promise<void>; beforeTool?: (call: ToolCall) => Promise<void>; afterEffect?: (call: ToolCall) => Promise<void>;
    afterBatch?: (signal: AbortSignal) => Promise<boolean>; contract?: () => string; barrier?: (name: string) => Promise<void>;
    observeContext?: (request: import("../contracts.js").ModelRequest, rawBytes: number) => void };
}

export class AgentSession {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly queue: QueuedInput[] = [];
  private steeringInputs: string[] = [];
  private readonly inboxRuns = new Map<string, Promise<RunResult>>();
  private readonly pendingSteers = new Map<string, { resolve(result: RunResult): void; reject(error: unknown): void }>();
  private readonly consumedSteers: string[] = [];
  private active: AbortController | undefined;
  private draining: Promise<void> | undefined;
  private closed = false;
  private runId = "";
  private runningInputId: string | undefined;
  private sequence = 0;
  private accepting = 0;

  constructor(
    readonly repository: SessionRepository,
    private readonly runtime: AgentRuntime,
    private readonly environment: LocalEnvironment,
    private readonly redactor: SecretRedactor,
    private readonly policy: { readonly: boolean; noShell: boolean },
    private readonly options: SessionOptions = {},
    private readonly tools: AgentTool[] = [],
    private readonly context?: RequestContext,
    private readonly ownedHost?: ExecutionHost,
    private readonly disposeExtensions?: () => Promise<void>,
  ) {}

  get id(): string { return this.repository.id; }
  get busy(): boolean { return this.active !== undefined || this.queue.length > 0 || this.accepting > 0; }

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

  submit(prompt: string, whenBusy: "reject" | "follow_up" = "reject", options: { runId?: string; inputId?: string } = {}): Promise<RunResult> {
    if (this.closed) return Promise.reject(new Error("会话已关闭"));
    if (!prompt.trim()) return Promise.reject(new Error("输入不能为空"));
    if (options.runId && !/^[a-zA-Z0-9_-]{1,100}$/.test(options.runId)) return Promise.reject(new Error("run ID 不合法"));
    if (this.busy && whenBusy === "reject") return Promise.reject(new Error("Agent 正在运行，请使用 follow_up 或 steer"));
    if (!this.options.taskMode) {
      this.accepting++;
      return this.acceptInput(prompt, "follow_up", options).then(receipt => { this.accepting--; return this.inboxRuns.get(receipt.inputId)!; }, error => { this.accepting--; throw error; });
    }
    const result = new Promise<RunResult>((resolve, reject) => {
      this.queue.push({ prompt: this.redactor.text(prompt), runId: options.runId ?? randomUUID(), resolve, reject });
    });
    this.startDrain();
    return result;
  }

  async acceptInput(prompt: string, mode: "follow_up" | "steer" = "follow_up", options: { inputId?: string; runId?: string } = {}): Promise<{ inputId: string; status: "accepted" | "consumed" | "settled" }> {
    if (this.closed) throw new Error("会话已关闭");
    const inputId = options.inputId ?? randomUUID();
    const entry = await this.repository.acceptInbox({ inputId, runId: options.runId ?? randomUUID(), mode, prompt });
    if (entry.kind !== "inbox_accepted") throw new Error("inbox_record_invalid");
    await this.options.hooks?.barrier?.("inbox_accepted");
    const settled = this.repository.facts().find(e => e.kind === "inbox_settled" && e.inputId === inputId);
    if (settled?.kind === "inbox_settled") { this.inboxRuns.set(inputId, Promise.resolve(settled.result)); return { inputId, status: "settled" }; }
    const consumed = this.repository.facts().find(fact => fact.kind === "inbox_consumed" && fact.inputId === inputId);
    if (mode === "steer" && this.active && (!consumed || consumed.kind === "inbox_consumed" && consumed.runId === this.runId)) {
      if (!this.inboxRuns.has(inputId)) {
        const deferred = Promise.withResolvers<RunResult>(); void deferred.promise.catch(() => undefined);
        this.pendingSteers.set(inputId, deferred); this.inboxRuns.set(inputId, deferred.promise);
      }
      if (!consumed && !this.steeringInputs.includes(inputId)) this.steeringInputs.push(inputId);
      if (consumed && !this.consumedSteers.includes(inputId)) this.consumedSteers.push(inputId);
    } else if ((!this.inboxRuns.has(inputId) || this.pendingSteers.has(inputId)) && this.runningInputId !== inputId && !this.queue.some(input => input.inputId === inputId)) {
      this.steeringInputs = this.steeringInputs.filter(id => id !== inputId);
      const result = new Promise<RunResult>((resolve, reject) => { this.queue.push({ inputId, prompt: entry.prompt, runId: entry.runId, resolve, reject }); });
      void result.catch(() => undefined); this.inboxRuns.set(inputId, result); this.startDrain();
    }
    return { inputId, status: this.repository.facts().some(e => e.kind === "inbox_consumed" && e.inputId === inputId) ? "consumed" : "accepted" };
  }

  async resumeInputs(): Promise<void> {
    for (const entry of this.repository.facts()) if (entry.kind === "inbox_accepted" && !this.repository.facts().some(e => e.kind === "inbox_settled" && e.inputId === entry.inputId)) {
      await this.acceptInput(entry.prompt, entry.mode, { inputId: entry.inputId, runId: entry.runId });
    }
  }

  async waitInput(inputId: string): Promise<RunResult> {
    const result = this.inboxRuns.get(inputId); if (!result) throw new Error("inbox_not_scheduled"); return result;
  }

  private startDrain(): void {
    if (this.draining || this.closed) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      // A submit() continuation can arrive while the previous drain is settling.
      if (this.queue.length > 0) this.startDrain();
    });
  }

  async steer(prompt: string, options: { inputId?: string } = {}): Promise<"queued" | RunResult> {
    if (this.closed) throw new Error("会话已关闭");
    if (!prompt.trim()) throw new Error("调整消息不能为空");
    if (this.active) {
      await this.acceptInput(prompt, "steer", options);
      return "queued";
    }
    const receipt = await this.acceptInput(prompt, "steer", options); return this.waitInput(receipt.inputId);
  }

  abort(): string[] {
    this.active?.abort();
    // Accepted steering remains durable and can be resumed; cancellation cannot erase it.
    return this.steeringInputs.map(inputId => {
      const entry = this.repository.facts().find(fact => fact.kind === "inbox_accepted" && fact.inputId === inputId);
      return entry?.kind === "inbox_accepted" ? entry.prompt : inputId;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const input = this.queue.shift();
      if (!input) return;
      this.active = new AbortController();
      this.runningInputId = input.inputId;
      this.runId = input.runId;
      this.sequence = 0;
      try {
        if (input.inputId) { await this.repository.consumeInbox(input.inputId, this.runId); await this.options.hooks?.barrier?.("inbox_consumed"); }
        const result = await this.execute(input.prompt, this.active.signal);
        if (input.inputId) { await this.repository.append({ kind: "inbox_settled", inputId: input.inputId, result }); this.pendingSteers.get(input.inputId)?.resolve(result); this.pendingSteers.delete(input.inputId); }
        for (const inputId of this.consumedSteers.splice(0)) { await this.repository.append({ kind: "inbox_settled", inputId, result }); this.pendingSteers.get(inputId)?.resolve(result); this.pendingSteers.delete(inputId); }
        input.resolve(result);
      } catch (error) {
        input.reject(error);
      } finally {
        this.active = undefined;
        this.runningInputId = undefined;
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
      result = await this.runtime.run(this.repository.messages(), signal, {
        commit: (message) => this.repository.appendMessage(message),
        emit: (event) => this.emit(event),
        beforeModel: async () => { await this.options.hooks?.beforeModel?.(); },
        ...(this.context ? { context: (tools, signal, force) => this.context!.build(tools, signal, force) } : {}),
        ...(this.options.hooks?.afterBatch ? { afterBatch: this.options.hooks.afterBatch } : {}),
        intent: async (call, replay) => {
          if (!this.options.taskMode) { await this.options.hooks?.beforeTool?.(call); await this.repository.append({ kind: "tool_intent", call, replay }); return; }
          const operationId = randomUUID();
          const assistant = this.repository.facts().findLast(entry => entry.kind === "message" && entry.message.role === "assistant");
          if (!assistant) throw new Error("缺少工具所属 assistant");
          let postcondition: { path: string; sha256: string } | undefined;
          const args = call.arguments as { path?: string; content?: string; oldText?: string; newText?: string };
          if (["write", "edit"].includes(call.name) && args.path) {
            try {
            const path = await this.environment.path(args.path);
            let content = args.content;
            if (call.name === "edit" && args.oldText !== undefined && args.newText !== undefined) {
              const original = await readFile(path, "utf8"); const at = original.indexOf(args.oldText);
              if (at >= 0 && original.indexOf(args.oldText, at + 1) < 0) content = original.slice(0, at) + args.newText + original.slice(at + args.oldText.length);
            }
            if (content !== undefined) postcondition = { path: args.path, sha256: createHash("sha256").update(content).digest("hex") };
            } catch (error) { throw new ToolPreparationError(errorText(error)); }
          }
          await this.options.hooks?.beforeTool?.(call);
          await this.repository.append({ kind: "tool_intent", call, replay, operationId, assistantEntryId: assistant.id, runId: this.runId, toolVersion: this.tools.find(t => t.name === call.name)?.version ?? "1", ...(postcondition ? { postcondition } : {}) });
          return operationId;
        },
        afterEffect: async call => { await this.options.hooks?.afterEffect?.(call); },
        exec: (executable, args) => this.environment.exec(executable, args, signal),
        progress: async (callId, text) => { this.emit({ type: "tool_progress", callId, text }); },
        artifact: (text) => this.repository.artifact(text),
        policy: async (call, decision) => { await this.repository.append({ kind: "tool_policy", callId: call.id, ...decision }); },
        steering: async () => {
          const inputs = this.steeringInputs;
          this.steeringInputs = [];
          const messages = [];
          for (const inputId of inputs) {
            const entry = await this.repository.consumeInbox(inputId, this.runId);
            if (entry.kind !== "inbox_consumed") throw new Error("inbox_consumption_invalid");
            const message = entry.message;
            this.consumedSteers.push(inputId);
            await this.options.hooks?.barrier?.("inbox_consumed");
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
    for (const steer of this.pendingSteers.values()) steer.reject(abortError()); this.pendingSteers.clear();
    try { await this.repository.close(); }
    finally { try { await this.ownedHost?.close(); } finally { await this.disposeExtensions?.(); } }
    this.listeners.clear();
  }

  setWritablePaths(paths: string[]): void { this.environment.setWritablePaths(paths); }
}

export async function createAgentSession(options: SessionOptions = {}): Promise<AgentSession> {
  if (options.maxReadConcurrency !== undefined && (!Number.isSafeInteger(options.maxReadConcurrency) || options.maxReadConcurrency < 1 || options.maxReadConcurrency > 16)) throw new Error("read_concurrency_invalid");
  const config = options.config ?? loadConfig();
  const redactor = new SecretRedactor([config.apiKey]);
  const ownedHost = !options.host && options.durableInbox ? await createExecutionHost() : undefined;
  const host = options.host ?? ownedHost;
  const environment = await LocalEnvironment.create(options.cwd ?? process.cwd(), config.toolTimeoutMs, host, options.writablePaths).catch(async error => { await ownedHost?.close(); throw error; });
  const repository = await SessionRepository.open({
    directory: options.dataDirectory ?? fileURLToPath(new URL("../../.codeagent/sessions", import.meta.url)),
    cwd: environment.cwd, redactor, ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(host ? { host } : {}),
    ...(options.logPath ? { logPath: options.logPath } : {}),
  }).catch(async error => { await ownedHost?.close(); throw error; });
  let extensions: Awaited<ReturnType<typeof loadExtensions>> | undefined;
  try {
    if (ownedHost) await ownedHost.restoreProcessGroups(repository.path.replace(/\.jsonl$/, "-processes.jsonl"));
    const resources = await discoverResources(environment.cwd);
    extensions = options.extensions ? await loadExtensions(options.extensions) : undefined;
    const tools = [...(options.tools ?? createCodingTools(environment)), ...(options.additionalTools ?? []), ...(options.historyRetrieval ? [createHistoryTool(repository)] : []),
      ...(options.discoverSkills !== false && resources.skills.length ? [skillTool(resources.skills)] : []), ...(extensions?.tools ?? [])];
    const executor = new ToolExecutor(tools, {
      readonly: options.readonly ?? false, noShell: options.noShell ?? false, redactor,
      ...(options.toolPolicy ? { policy: options.toolPolicy } : {}), ...(options.confirmTool ? { confirm: options.confirmTool } : {}),
    });
    const gateway = options.gateway ?? new PiModelGateway(config);
    const context = options.contextPolicy ? new RequestContext(repository, gateway, options.contextPolicy, {
      ...(options.hooks?.contract ? { contract: options.hooks.contract } : {}),
      ...(options.hooks?.barrier ? { barrier: options.hooks.barrier } : {}),
      ...(options.hooks?.observeContext ? { observe: options.hooks.observeContext } : {}),
    }) : undefined;
    const runtime = new AgentRuntime(gateway, executor, {
      maxTurns: config.maxTurns, redactor, ...(options.maxReadConcurrency ? { maxReadConcurrency: options.maxReadConcurrency } : {}),
    });
    return new AgentSession(repository, runtime, environment, redactor, {
      readonly: options.readonly ?? false, noShell: options.noShell ?? false,
    }, options, tools, context, ownedHost, extensions?.close);
  } catch (error) {
    await repository.close();
    await ownedHost?.close();
    await extensions?.close();
    throw error;
  }
}
