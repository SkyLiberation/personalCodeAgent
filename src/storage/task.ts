import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { TaskFact, TaskRecord, TaskState } from "../task-contracts.js";
import { validateTaskDefinition } from "../task-contracts.js";
import { SecretRedactor } from "../security.js";
import { WindowsHost, type ExecutionLease } from "../platform/windows.js";
import { journalLines, seal, verifySeal } from "./journal.js";
import { migrationPaths } from "./migration.js";
export function taskPath(directory: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("task ID 不合法"); return join(directory, "tasks", id);
}
const types = new Set(["task_created", "task_status", "task_run_started", "task_input_applied", "task_run_completed", "verification_started", "verification_completed", "milestone_verified", "repair_requested", "task_settled", "command_received", "command_applied", "recovery_completed", "evidence_invalidated"]);
function fold(state: TaskState, fact: TaskFact): void {
  if (!types.has(fact.type)) throw new Error("未知任务事件，拒绝读取");
  if (fact.type === "task_status" || fact.type === "task_settled") {
    state.status = fact.status; if (fact.reason) state.reason = fact.reason; else delete state.reason;
    if (fact.type === "task_settled") state.finalEvidenceIds = [...fact.finalEvidenceIds];
  }
  if (fact.type === "task_run_started") { state.runs++; if (fact.inputId && fact.contentHash && fact.specVersion) state.activeRun = { runId: fact.runId, inputId: fact.inputId, contentHash: fact.contentHash, specVersion: fact.specVersion, prompt: fact.prompt, milestoneId: fact.milestoneId }; }
  if (fact.type === "task_input_applied") { if (state.activeRun?.runId !== fact.runId) throw new Error("输入引用不匹配 Run"); state.activeRun.inputCursor = fact.inputCursor; }
  if (fact.type === "task_run_completed" && state.activeRun?.runId === fact.runId) state.activeRun.status = fact.status;
  if (fact.type === "repair_requested") state.repairs++;
  if (fact.type === "verification_completed") state.evidence.push(fact.evidence);
  if (fact.type === "milestone_verified") { if (!state.verifiedMilestones.includes(fact.milestoneId)) state.verifiedMilestones.push(fact.milestoneId); state.milestoneEvidence[fact.milestoneId] = [...fact.evidenceIds]; }
  if (fact.type === "evidence_invalidated") { state.milestoneEvidence = {}; state.finalEvidenceIds = []; }
  if (fact.type === "command_received" || fact.type === "command_applied") {
    (state.commands ??= {})[fact.result.id] = fact.result;
    if (fact.type === "command_applied") {
      if (fact.status) { state.status = fact.status; if (fact.reason) state.reason = fact.reason; else delete state.reason; }
      if (fact.spec) { if (fact.specVersion !== state.specVersion + 1 || !fact.trustedHashes || !fact.verifierManifestHash) throw new Error("合同版本更新事实不合法"); state.spec = fact.spec; state.specVersion = fact.specVersion; state.trustedHashes = fact.trustedHashes; state.verifierManifestHash = fact.verifierManifestHash; state.scopeSource = fact.spec.scope ? "explicit" : "legacy_workspace"; state.milestoneEvidence = {}; state.finalEvidenceIds = []; }
    }
  }
}
function decode(lines: string[], id: string): { state: TaskState; seq: number; checksum: string } {
  let state: TaskState | undefined; let seq = 0; let checksum = ""; const seen = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue; const record = JSON.parse(line) as TaskRecord;
    if (record.taskId !== id || record.seq !== seq + 1 || typeof record.eventId !== "string" || seen.has(record.eventId) || !Number.isFinite(record.timestamp) || !types.has(record.type)) throw new Error("任务日志结构或顺序不合法");
    seen.add(record.eventId); seq = record.seq;
    if (record.type === "task_created") { if (state || ![1, 2].includes(record.state.schemaVersion) || record.state.id !== id) throw new Error("任务版本或创建记录不合法"); validateTaskDefinition(record.state.spec); state = record.state; }
    else { if (!state) throw new Error("任务缺少创建记录"); fold(state, record); }
    if (state.schemaVersion === 2) checksum = verifySeal(record as unknown as Record<string, unknown>, checksum);
  }
  if (!state) throw new Error("任务日志为空或缺少有效创建记录"); return { state, seq, checksum };
}
export class TaskRepository {
  private pending: Promise<void> = Promise.resolve(); private seq = 0; private checksum = ""; private closed = false;
  private constructor(readonly directory: string, private state: TaskState, private readonly handle: FileHandle, private readonly lease: ExecutionLease, private readonly host: WindowsHost, private readonly ownHost: boolean, private readonly redactor: SecretRedactor) {}
  static async create(root: string, initial: TaskState, redactor: SecretRedactor, host?: WindowsHost): Promise<TaskRepository> {
    const directory = taskPath(root, initial.id); await mkdir(join(root, "tasks"), { recursive: true }); await mkdir(directory);
    const platform = host ?? await WindowsHost.create(); let lease: ExecutionLease | undefined; let handle: FileHandle | undefined;
    try { lease = await platform.acquire(join(directory, "execution.lease")); handle = await open(join(directory, "events.jsonl"), "wx"); const repository = new TaskRepository(directory, structuredClone(initial), handle, lease, platform, !host, redactor); await repository.append({ type: "task_created", state: initial }); return repository; }
    catch (error) { await handle?.close(); await lease?.close(); if (!host) await platform.close(); throw error; }
  }
  static async open(root: string, id: string, redactor: SecretRedactor, host: WindowsHost): Promise<TaskRepository> {
    const directory = taskPath(root, id); const lease = await host.acquire(join(directory, "execution.lease"));
    try {
      const { taskLog } = await migrationPaths(directory, id);
      const view = decode(await journalLines(taskLog), id);
      if (view.state.schemaVersion !== 2) throw new Error("migration_handoff_ambiguous：v1 任务仅可查询，不能推断旧输入与进程身份");
      const restored = decode(await journalLines(taskLog, true), id);
      const repository = new TaskRepository(directory, restored.state, await open(taskLog, "a"), lease, host, false, redactor); repository.seq = restored.seq; repository.checksum = restored.checksum; return repository;
    } catch (error) { await lease.close(); throw error; }
  }
  static async read(root: string, id: string): Promise<TaskState> { const { taskLog } = await migrationPaths(taskPath(root, id), id); return decode(await journalLines(taskLog), id).state; }
  view(): TaskState { return structuredClone(this.state); }
  async append(fact: TaskFact): Promise<TaskRecord> {
    if (this.closed) throw new Error("任务存储已关闭");
    const operation = this.pending.then(async () => {
      const unsigned = this.redactor.json({ ...fact, taskId: this.state.id, seq: this.seq + 1, eventId: randomUUID(), timestamp: Date.now() });
      const record = (this.state.schemaVersion === 2 ? seal(unsigned, this.checksum) : unsigned) as TaskRecord;
      const next = structuredClone(this.state); if (record.type === "task_created") Object.assign(next, record.state); else fold(next, record);
      await this.handle.writeFile(JSON.stringify(record) + "\n"); await this.handle.sync(); this.seq = record.seq; this.checksum = record.checksum ?? ""; this.state = next; return record;
    }); this.pending = operation.then(() => undefined); void this.pending.catch(() => undefined); return operation;
  }
  async artifact(id: string, contents: unknown): Promise<string> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("验收附件 ID 不合法"); const directory = join(this.directory, "evidence"); await mkdir(directory, { recursive: true }); const path = join(directory, `${id}.json`); const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(this.redactor.text(JSON.stringify(contents, null, 2)) + "\n"); await handle.sync(); } finally { await handle.close(); } return path;
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; await this.pending.catch(() => undefined); const temporary = join(this.directory, `snapshot-${randomUUID()}.tmp`);
    try { const file = await open(temporary, "wx", 0o600); try { await file.writeFile(JSON.stringify({ seq: this.seq, checksum: this.checksum, state: this.state }, null, 2)); await file.sync(); } finally { await file.close(); } await rename(temporary, join(this.directory, "snapshot.json")); }
    catch { await unlink(temporary).catch(() => undefined); }
    try { await this.handle.close(); } finally { try { await this.lease.close(); } finally { if (this.ownHost) await this.host.close(); } }
  }
}
