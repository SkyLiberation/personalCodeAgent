import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, truncate, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, RunStatus, ToolCall } from "../contracts.js";
import { SecretRedactor } from "../security.js";
import type { WindowsHost, ExecutionLease } from "../platform/windows.js";
import { digest, journalLines, seal, verifySeal } from "./journal.js";

export interface ToolIntent { operationId: string; assistantEntryId: string; runId: string; call: ToolCall; replay: "safe" | "never"; toolVersion: string; postcondition?: { path: string; sha256: string } }

type Payload =
  | { kind: "message"; message: ModelMessage }
  | ({ kind: "tool_intent"; call: ToolCall; replay: "safe" | "never" } & Partial<ToolIntent>)
  | { kind: "input"; inputId: string; runId: string; specVersion: number; contentHash: string; message: Extract<ModelMessage, { role: "system" | "user" }> }
  | { kind: "tool_recovery"; operationId: string; assistantEntryId: string; callId: string; classification: string; result: { text: string; isError: boolean }; evidenceHash: string }
  | { kind: "run_status"; runId: string; status: "running" | "interrupted" | RunStatus; error?: string };

export type SessionEntry = Payload & { id: string; parentId: string | null; timestamp: number; checksum?: string; previousHash?: string };
interface SessionHeader { type: "session"; schemaVersion: 1 | 2; sessionId: string; cwd: string }

function validMessage(message: unknown): message is ModelMessage {
  if (!message || typeof message !== "object" || !("role" in message) || !("timestamp" in message) ||
      typeof message.timestamp !== "number") return false;
  if (message.role === "user" || message.role === "system") return "text" in message && typeof message.text === "string";
  if (message.role === "tool_result") {
    return "callId" in message && typeof message.callId === "string" && "toolName" in message &&
      typeof message.toolName === "string" && "text" in message && typeof message.text === "string" &&
      "isError" in message && typeof message.isError === "boolean";
  }
  if (message.role === "assistant") {
    return "text" in message && typeof message.text === "string" && "toolCalls" in message &&
      Array.isArray(message.toolCalls) && message.toolCalls.every((call: unknown) =>
        call && typeof call === "object" && "id" in call && typeof call.id === "string" &&
        "name" in call && typeof call.name === "string" && "arguments" in call) &&
      "stopReason" in message && ["stop", "tool_calls", "length"].includes(String(message.stopReason));
  }
  return false;
}

export class SessionRepository {
  private entries: SessionEntry[] = [];
  private handle!: FileHandle;
  private lock!: FileHandle;
  private lease: ExecutionLease | undefined;
  private schemaVersion: 1 | 2 = 1;
  private checksum = "";
  private inputPending: Promise<void> = Promise.resolve();
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  readonly warnings: string[] = [];

  private constructor(
    readonly id: string, readonly cwd: string, readonly path: string,
    private readonly redactor: SecretRedactor,
  ) {}

  static async open(options: {
    directory: string; cwd: string; sessionId?: string; redactor?: SecretRedactor; host?: WindowsHost; logPath?: string;
  }): Promise<SessionRepository> {
    const id = options.sessionId ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("session ID 只能包含字母、数字、下划线和连字符");
    await mkdir(options.directory, { recursive: true });
    const session = new SessionRepository(id, options.cwd, options.logPath ?? join(options.directory, `${id}.jsonl`),
      options.redactor ?? new SecretRedactor());
    try {
      if (options.host) { session.schemaVersion = 2; session.lease = await options.host.acquire(join(options.directory, `${id}.jsonl.lease`)); }
      else { session.lock = await open(`${session.path}.lock`, "wx"); await session.lock.writeFile(JSON.stringify({ pid: process.pid, sessionId: id })); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("会话已被锁定。若前一进程异常退出，请确认它已停止，再删除对应 .jsonl.lock 文件");
      }
      throw error;
    }
    try {
      await session.load();
      session.handle = await open(session.path, "a");
      return session;
    } catch (error) {
      if (session.lease) await session.lease.close();
      else { await session.lock.close(); await unlink(`${session.path}.lock`); }
      throw error;
    }
  }

  private async load(): Promise<void> {
    let content: string;
    try { content = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const header: SessionHeader = { type: "session", schemaVersion: this.schemaVersion, sessionId: this.id, cwd: this.cwd };
      await writeFile(this.path, JSON.stringify(header) + "\n", { flag: "wx", mode: 0o600 });
      return;
    }
    const lines = this.schemaVersion === 2 ? await journalLines(this.path) : content.split("\n");
    const header = JSON.parse(lines[0] ?? "") as Partial<SessionHeader>;
    if (header.type !== "session" || header.schemaVersion !== this.schemaVersion || header.sessionId !== this.id || header.cwd !== this.cwd) {
      throw new Error("会话头、版本或工作区不匹配");
    }
    const seen = new Set<string>();
    let validBytes = Buffer.byteLength((lines[0] ?? "") + "\n");
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim()) { validBytes += Buffer.byteLength(line + "\n"); continue; }
      let entry: SessionEntry;
      try { entry = JSON.parse(line) as SessionEntry; }
      catch (error) {
        if (index === lines.length - 1) {
          await truncate(this.path, validBytes);
          this.warnings.push("已移除未完成的 JSONL 尾部记录");
          break;
        }
        throw new Error(`会话第 ${index + 1} 行损坏`, { cause: error });
      }
      if (!entry || typeof entry.id !== "string" || seen.has(entry.id) || typeof entry.timestamp !== "number" ||
          entry.parentId !== (this.entries.at(-1)?.id ?? null) ||
          !["message", "tool_intent", "run_status", "input", "tool_recovery"].includes(entry.kind) ||
          ((entry.kind === "message" || entry.kind === "input") && !validMessage(entry.message))) {
        throw new Error(`会话第 ${index + 1} 行结构不合法`);
      }
      if (entry.kind === "input" && (entry.message.role !== "user" || entry.contentHash !== digest(entry.message.text) || !entry.inputId || !entry.runId || !Number.isSafeInteger(entry.specVersion) || entry.specVersion < 1 || this.entries.some(e => e.kind === "input" && e.inputId === entry.inputId))) throw new Error("input_record_invalid");
      if (entry.kind === "run_status" && (!entry.runId || !["running", "interrupted", "completed", "aborted", "failed", "budget_exhausted"].includes(entry.status))) throw new Error("run_record_invalid");
      if (entry.kind === "tool_intent") {
        if (!entry.call || typeof entry.call.id !== "string" || typeof entry.call.name !== "string" || !["safe", "never"].includes(entry.replay)) throw new Error("tool_intent_invalid");
        if (this.schemaVersion === 2) {
          const assistant = this.entries.find(e => e.id === entry.assistantEntryId);
          if (!entry.operationId || !entry.runId || !entry.toolVersion || assistant?.kind !== "message" || assistant.message.role !== "assistant" || !assistant.message.toolCalls.some(call => call.id === entry.call.id)) throw new Error("tool_intent_identity_invalid");
        }
      }
      if (entry.kind === "tool_recovery" && (!entry.operationId || !entry.assistantEntryId || !entry.callId || !entry.classification || !entry.result || typeof entry.result.text !== "string" || typeof entry.result.isError !== "boolean" || !entry.evidenceHash)) throw new Error("tool_recovery_invalid");
      seen.add(entry.id);
      if (this.schemaVersion === 2) this.checksum = verifySeal(entry as unknown as Record<string, unknown>, this.checksum);
      this.entries.push(entry);
      validBytes += Buffer.byteLength(line + "\n");
    }
    if (this.schemaVersion === 2) { await journalLines(this.path, true); return; }
    if (!content.endsWith("\n") && this.warnings.length === 0) {
      const handle = await open(this.path, "a");
      try { await handle.writeFile("\n"); } finally { await handle.close(); }
    }
  }

  messages(): ModelMessage[] {
    return this.entries.filter((entry) => entry.kind === "message" || entry.kind === "input").map((entry) => entry.message);
  }

  facts(): SessionEntry[] { return structuredClone(this.entries); }

  acceptInputOnce(input: { inputId: string; runId: string; specVersion: number; prompt: string; contentHash: string }): Promise<SessionEntry> {
    const action = this.inputPending.then(async () => {
      if (digest(input.prompt) !== input.contentHash) throw new Error("input_content_hash_mismatch");
      const existing = this.entries.find(entry => entry.kind === "input" && entry.inputId === input.inputId);
      if (existing?.kind === "input") { if (existing.contentHash !== input.contentHash || existing.runId !== input.runId || existing.specVersion !== input.specVersion) throw new Error("input_id_conflict"); return existing; }
      return this.append({ kind: "input", inputId: input.inputId, runId: input.runId, specVersion: input.specVersion, contentHash: input.contentHash, message: { role: "user", text: input.prompt, timestamp: Date.now() } });
    }); this.inputPending = action.then(() => undefined, () => undefined); return action;
  }

  get cursor(): string | null { return this.entries.at(-1)?.id ?? null; }

  async append(payload: Payload): Promise<SessionEntry> {
    if (this.closed) throw new Error("会话已关闭");
    const write = this.pending.then(async () => {
      const unsigned = this.redactor.json({
        ...payload, id: randomUUID(), parentId: this.entries.at(-1)?.id ?? null, timestamp: Date.now(),
      });
      const entry = (this.schemaVersion === 2 ? seal(unsigned, this.checksum) : unsigned) as SessionEntry;
      await this.handle.writeFile(JSON.stringify(entry) + "\n");
      await this.handle.sync();
      this.entries.push(entry);
      this.checksum = entry.checksum ?? "";
      return entry;
    });
    this.pending = write.then(() => undefined);
    // Preserve a failed writer's rejection for subsequent appends, without an unhandled rejection.
    void this.pending.catch(() => undefined);
    return write;
  }

  async appendMessage(message: ModelMessage): Promise<ModelMessage> {
    const entry = await this.append({ kind: "message", message });
    if (entry.kind !== "message") throw new Error("会话写入类型错误");
    return entry.message;
  }

  async artifact(text: string): Promise<string> {
    const id = randomUUID() + ".txt";
    const directory = join(this.path.slice(0, -6) + "-artifacts");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, id), this.redactor.text(text), { mode: 0o600 });
    return id;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pending.catch(() => undefined);
    try { await this.handle.close(); }
    finally { if (this.lease) await this.lease.close(); else { await this.lock.close(); await unlink(`${this.path}.lock`); } }
  }
}
