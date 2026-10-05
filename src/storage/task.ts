import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { TaskFact, TaskRecord, TaskState } from "../task-contracts.js";
import { validateTaskDefinition } from "../task-contracts.js";
import { SecretRedactor } from "../security.js";
import { createExecutionHost, type ExecutionHost, type ExecutionLease } from "../platform/host.js";
import { digest, journalLines, seal, verifySeal } from "./journal.js";
import { readGuardedFile } from "./guarded-file.js";
import { migrationPaths } from "./migration.js";
export function taskPath(directory: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("task ID 不合法"); return join(directory, "tasks", id);
}
const types = new Set(["task_created", "task_status", "task_run_started", "task_input_applied", "task_run_completed", "verification_started", "verification_completed", "milestone_verified", "repair_requested", "task_settled", "command_received", "command_applied", "recovery_completed", "evidence_invalidated", "model_request_reserved", "model_request_settled"]);
for (const type of ["progress_observed", "strategy_replan_reserved", "strategy_replanned", "retry_scheduled", "budget_adjusted", "activity_reserved", "activity_completed"]) types.add(type);
function fold(state: TaskState, fact: TaskFact): void {
  if (!types.has(fact.type)) throw new Error("未知任务事件，拒绝读取");
  if (fact.type === "task_status" || fact.type === "task_settled") {
    state.status = fact.status; if (fact.reason) state.reason = fact.reason; else delete state.reason;
    if (fact.type === "task_settled") state.finalEvidenceIds = [...fact.finalEvidenceIds];
    if (fact.type === "task_settled" && fact.status === "budget_exhausted") { state.budgetStoppedVersion = state.budgetVersion ?? 1; state.budgetStopReason = fact.reason ?? "budget_exhausted"; }
  }
  if (fact.type === "task_run_started") { state.runs++; if (fact.inputId && fact.contentHash && fact.specVersion) state.activeRun = { runId: fact.runId, inputId: fact.inputId, contentHash: fact.contentHash, specVersion: fact.specVersion, prompt: fact.prompt, milestoneId: fact.milestoneId }; }
  if (fact.type === "task_input_applied") { if (state.activeRun?.runId !== fact.runId) throw new Error("输入引用不匹配 Run"); state.activeRun.inputCursor = fact.inputCursor; }
  if (fact.type === "task_run_completed" && state.activeRun?.runId === fact.runId) state.activeRun.status = fact.status;
  if (fact.type === "repair_requested") state.repairs++;
  if (fact.type === "activity_reserved") {
    const activities = state.activities ??= {};
    if (!fact.activityId || activities[fact.activityId] || !Number.isSafeInteger(fact.reservedMs) || fact.reservedMs < 1 || !["tool", "verification"].includes(fact.kind)) throw new Error("activity_reservation_invalid");
    activities[fact.activityId] = { kind: fact.kind, reservedMs: fact.reservedMs, status: "reserved" };
  }
  if (fact.type === "activity_completed") {
    const activity = state.activities?.[fact.activityId]; if (!activity || activity.status !== "reserved" || !Number.isFinite(fact.elapsedMs) || fact.elapsedMs < 0) throw new Error("activity_settlement_invalid");
    activity.status = "completed"; activity.elapsedMs = fact.elapsedMs;
  }
  if (fact.type === "model_request_reserved") {
    const requests = state.modelRequests ??= {};
    if (!fact.request.id || requests[fact.request.id] || fact.request.status !== "reserved" || !["execution", "summary", "replan", "retry"].includes(fact.request.purpose) || fact.request.usage !== undefined ||
        (state.spec.limits.maxModelRequests !== undefined && Object.keys(requests).length >= state.spec.limits.maxModelRequests)) throw new Error("模型请求预留事实不合法");
    requests[fact.request.id] = structuredClone(fact.request);
  }
  if (fact.type === "model_request_settled") {
    const request = state.modelRequests?.[fact.requestId];
    if (!request || request.status !== "reserved" || !["completed", "failed", "aborted"].includes(fact.status) ||
        (fact.usage && [fact.usage.inputTokens, fact.usage.outputTokens].some(value => !Number.isSafeInteger(value) || value < 0))) throw new Error("模型请求结算事实不合法");
    request.status = fact.status; if (fact.usage) request.usage = { ...fact.usage };
    if (fact.durationMs !== undefined) { if (!Number.isFinite(fact.durationMs) || fact.durationMs < 0) throw new Error("request_duration_invalid"); request.durationMs = fact.durationMs; }
  }
  if (fact.type === "progress_observed") {
    if (fact.specVersion !== state.specVersion) throw new Error("progress_version_invalid");
    const progress = state.progress ??= { specVersion: state.specVersion, failures: 0, replans: 0, verifiedIds: [] };
    const fresh = fact.verificationIds.filter(id => !progress.verifiedIds.includes(id));
    if (fresh.length) { progress.verifiedIds.push(...fresh); progress.failures = 0; }
    else if (fact.failures.length) progress.failures++;
  }
  if (fact.type === "strategy_replan_reserved") {
    if (fact.specVersion !== state.specVersion || !fact.attemptId) throw new Error("strategy_reservation_invalid");
    const progress = state.progress ??= { specVersion: state.specVersion, failures: 0, replans: 0, verifiedIds: [] };
    if (state.spec.progressPolicy && progress.replans >= state.spec.progressPolicy.maxReplans) throw new Error("strategy_budget_exhausted");
    progress.replans++; progress.pendingReplanId = fact.attemptId;
  }
  if (fact.type === "strategy_replanned") {
    if (fact.specVersion !== state.specVersion || !fact.strategy.trim()) throw new Error("strategy_invalid");
    if (fact.milestoneId && !state.spec.milestones.some(m => m.id === fact.milestoneId)) throw new Error("strategy_milestone_invalid");
    const progress = state.progress ??= { specVersion: state.specVersion, failures: 0, replans: 0, verifiedIds: [] };
    if (fact.attemptId) { if (fact.attemptId !== progress.pendingReplanId) throw new Error("strategy_attempt_invalid"); delete progress.pendingReplanId; }
    else progress.replans++; // Earlier journals charged the successful plan itself.
    progress.failures = 0; progress.strategy = fact.strategy;
    if (fact.milestoneId) progress.strategyMilestoneId = fact.milestoneId;
  }
  if (fact.type === "retry_scheduled") {
    const retry = state.retry ??= { attempts: 0, waitMs: 0 }; const policy = state.spec.retryPolicy;
    if (!policy || retry.attempts >= policy.maxRetries || fact.delayMs < 0 || retry.waitMs + fact.delayMs > policy.maxWaitMs) throw new Error("retry_budget_exhausted");
    retry.attempts++; retry.waitMs += fact.delayMs;
  }
  if (fact.type === "budget_adjusted") {
    if (fact.expectedVersion !== (state.budgetVersion ?? 1) || !fact.reason.trim()) throw new Error("budget_version_conflict");
    const next = validateTaskDefinition({ ...state.spec, limits: fact.limits });
    state.spec.limits = next.limits; state.budgetVersion = fact.expectedVersion + 1;
    (state.commands ??= {})[fact.result.id] = fact.result;
  }
  if (fact.type === "verification_completed") state.evidence.push(fact.evidence);
  if (fact.type === "milestone_verified") { if (!state.verifiedMilestones.includes(fact.milestoneId)) state.verifiedMilestones.push(fact.milestoneId); state.milestoneEvidence[fact.milestoneId] = [...fact.evidenceIds]; }
  if (fact.type === "evidence_invalidated") { state.milestoneEvidence = {}; state.finalEvidenceIds = []; }
  if (fact.type === "command_received" || fact.type === "command_applied") {
    (state.commands ??= {})[fact.result.id] = fact.result;
    if (fact.type === "command_applied") {
      if (fact.status) { state.status = fact.status; if (fact.reason) state.reason = fact.reason; else delete state.reason; }
      if (fact.spec) { if (fact.specVersion !== state.specVersion + 1 || !fact.trustedHashes || !fact.verifierManifestHash) throw new Error("合同版本更新事实不合法"); state.spec = fact.spec; state.specVersion = fact.specVersion; state.trustedHashes = fact.trustedHashes; state.verifierManifestHash = fact.verifierManifestHash; state.scopeSource = fact.spec.scope ? "explicit" : "legacy_workspace"; state.milestoneEvidence = {}; state.finalEvidenceIds = []; delete state.progress; }
    }
  }
}
// Bump when business folding semantics change; older checkpoints remain readable,
// but their caches are ignored and the authoritative log is fully folded.
const REDUCER_VERSION = 1;
interface StateCheckpoint {
  type: "state_checkpoint"; taskId: string; seq: number; eventId: string; timestamp: number;
  prefixSeq: number; prefixChecksum: string; reducerVersion: number; stateHash: string;
  checksum: string; previousHash: string;
}
interface Snapshot { snapshotVersion: 1; reducerVersion: number; seq: number; checksum: string; stateHash: string; state: TaskState }
type StoredRecord = TaskRecord | StateCheckpoint;
export interface TaskReplayStats { source: "snapshot" | "full-log"; totalRecords: number; reusedRecords: number; foldedRecords: number }
export interface TaskReadOptions { useSnapshot?: boolean; observeReplay?: (stats: TaskReplayStats) => void }
async function cachedSnapshot(directory: string, options: TaskReadOptions): Promise<Snapshot | undefined> {
  if (options.useSnapshot === false) return undefined;
  try { return JSON.parse((await readGuardedFile(join(directory, "snapshot.json"), 64 * 1024 * 1024)).toString("utf8")) as Snapshot; }
  catch { return undefined; } // Disposable cache; log errors are never caught here.
}
function decode(lines: string[], id: string, cache?: Snapshot, options: TaskReadOptions = {}): { state: TaskState; seq: number; checksum: string } {
  let initial: TaskState | undefined; let seq = 0; let checksum = ""; const seen = new Set<string>(); const records: StoredRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue; const record = JSON.parse(line) as StoredRecord;
    if (record.taskId !== id || record.seq !== seq + 1 || typeof record.eventId !== "string" || seen.has(record.eventId) || !Number.isFinite(record.timestamp) || (!types.has(record.type) && record.type !== "state_checkpoint")) throw new Error("任务日志结构或顺序不合法");
    seen.add(record.eventId);
    if (record.type === "task_created") {
      if (initial || seq !== 0 || ![1, 2].includes(record.state.schemaVersion) || record.state.id !== id) throw new Error("任务版本或创建记录不合法");
      validateTaskDefinition(record.state.spec); initial = record.state;
    } else if (!initial) throw new Error("任务缺少创建记录");
    if (record.type === "state_checkpoint" && (initial!.schemaVersion !== 2 || record.prefixSeq !== seq || record.prefixChecksum !== checksum || !Number.isSafeInteger(record.reducerVersion) || record.reducerVersion < 1 || !/^[a-f0-9]{64}$/.test(record.stateHash))) throw new Error("state_checkpoint_invalid");
    if (initial!.schemaVersion === 2) checksum = verifySeal(record as unknown as Record<string, unknown>, checksum);
    seq = record.seq; records.push(record);
  }
  if (!initial) throw new Error("任务日志为空或缺少有效创建记录");
  let state = initial; let reused = 0; let folded = 1;
  if (cache?.snapshotVersion === 1 && cache.reducerVersion === REDUCER_VERSION && Number.isSafeInteger(cache.seq) && cache.seq >= 2 && cache.state?.schemaVersion === 2 && cache.state.id === id) {
    const anchor = records[cache.seq - 1];
    if (anchor?.type === "state_checkpoint" && anchor.reducerVersion === REDUCER_VERSION && anchor.checksum === cache.checksum && anchor.stateHash === cache.stateHash) {
      let computedHash: string | undefined;
      try { computedHash = digest({ reducerVersion: REDUCER_VERSION, state: cache.state }); }
      catch { /* A JSON-valid but unusable cache must not block authoritative replay. */ }
      if (computedHash === anchor.stateHash) { state = cache.state; reused = cache.seq; folded = 0; }
    }
  }
  for (const record of records.slice(reused || 1)) {
    if (record.type === "state_checkpoint") continue;
    if (record.type === "task_created") throw new Error("任务重复创建");
    fold(state, record); folded++;
  }
  options.observeReplay?.({ source: reused ? "snapshot" : "full-log", totalRecords: records.length, reusedRecords: reused, foldedRecords: folded });
  return { state, seq, checksum };
}
export class TaskRepository {
  private pending: Promise<void> = Promise.resolve(); private seq = 0; private checksum = ""; private closed = false;
  private constructor(readonly directory: string, private state: TaskState, private readonly handle: FileHandle, private readonly lease: ExecutionLease, private readonly host: ExecutionHost, private readonly ownHost: boolean, private readonly redactor: SecretRedactor) {}
  static async create(root: string, initial: TaskState, redactor: SecretRedactor, host?: ExecutionHost): Promise<TaskRepository> {
    const directory = taskPath(root, initial.id); await mkdir(join(root, "tasks"), { recursive: true }); await mkdir(directory);
    const platform = host ?? await createExecutionHost(); let lease: ExecutionLease | undefined; let handle: FileHandle | undefined;
    try { lease = await platform.acquire(join(directory, "execution.lease")); handle = await open(join(directory, "events.jsonl"), "wx"); const repository = new TaskRepository(directory, structuredClone(initial), handle, lease, platform, !host, redactor); await repository.append({ type: "task_created", state: initial }); return repository; }
    catch (error) { await handle?.close(); await lease?.close(); if (!host) await platform.close(); throw error; }
  }
  static async open(root: string, id: string, redactor: SecretRedactor, host: ExecutionHost, options: TaskReadOptions = {}): Promise<TaskRepository> {
    const directory = taskPath(root, id); const lease = await host.acquire(join(directory, "execution.lease"));
    try {
      const { taskLog } = await migrationPaths(directory, id);
      const restored = decode(await journalLines(taskLog), id, await cachedSnapshot(directory, options), options);
      if (restored.state.schemaVersion !== 2) throw new Error("migration_handoff_ambiguous：v1 任务仅可查询，不能推断旧输入与进程身份");
      await journalLines(taskLog, true); // Only repair tails after complete validation.
      const repository = new TaskRepository(directory, restored.state, await open(taskLog, "a"), lease, host, false, redactor); repository.seq = restored.seq; repository.checksum = restored.checksum; return repository;
    } catch (error) { await lease.close(); throw error; }
  }
  static async read(root: string, id: string, options: TaskReadOptions = {}): Promise<TaskState> { const directory = taskPath(root, id); const { taskLog } = await migrationPaths(directory, id); return decode(await journalLines(taskLog), id, await cachedSnapshot(directory, options), options).state; }
  view(): TaskState { return structuredClone(this.state); }
  async append(fact: TaskFact): Promise<TaskRecord> {
    if (this.closed) throw new Error("任务存储已关闭");
    if ((fact as { type: string }).type === "state_checkpoint") throw new Error("state_checkpoint_host_only");
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
    if (this.closed) return; this.closed = true;
    let writerHealthy = true;
    try { await this.pending; } catch { writerHealthy = false; }
    const temporary = join(this.directory, `snapshot-${randomUUID()}.tmp`);
    try {
      if (writerHealthy && this.state.schemaVersion === 2) {
        const stateHash = digest({ reducerVersion: REDUCER_VERSION, state: this.state });
        const checkpoint = seal({ type: "state_checkpoint", taskId: this.state.id, seq: this.seq + 1, eventId: randomUUID(), timestamp: Date.now(),
          prefixSeq: this.seq, prefixChecksum: this.checksum, reducerVersion: REDUCER_VERSION, stateHash }, this.checksum);
        await this.handle.writeFile(JSON.stringify(checkpoint) + "\n"); await this.handle.sync();
        this.seq = checkpoint.seq; this.checksum = checkpoint.checksum;
        const snapshot: Snapshot = { snapshotVersion: 1, reducerVersion: REDUCER_VERSION, seq: this.seq, checksum: this.checksum, stateHash, state: this.state };
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(snapshot)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.directory, "snapshot.json"));
      }
    }
    catch { await unlink(temporary).catch(() => undefined); }
    try { await this.handle.close(); } finally { try { await this.lease.close(); } finally { if (this.ownHost) await this.host.close(); } }
  }
}
