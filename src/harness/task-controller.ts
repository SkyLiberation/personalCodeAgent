import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { loadConfig, type AgentConfig } from "../config.js";
import type { AgentTool, ModelGateway } from "../contracts.js";
import { LocalEnvironment } from "../environment/local.js";
import { errorText, SecretRedactor, throwIfAborted } from "../security.js";
import { TaskRepository } from "../storage/task.js";
import { digest } from "../storage/journal.js";
import { migrateUnstartedTask, migrationPaths } from "../storage/migration.js";
import { controlLock, pendingCommands, terminalTask, sendTaskCommand, type CommandEnvelope } from "../storage/task-commands.js";
import { WindowsHost, type ExecutionLease } from "../platform/windows.js";
import { validateTaskDefinition, type TaskDefinition, type TaskEvent, type TaskFact, type TaskState, type TaskStatus, type VerificationEvidence, type CommandResult } from "../task-contracts.js";
import { createAgentSession, type AgentSession } from "./session.js";
import { createCodingTools } from "../tools/coding-tools.js";
import { recoverTools, type ToolRecoveryAdapter } from "./recovery.js";
import { hash, inputFingerprint, trustedHashes, Verifier } from "./verifier.js";
import { TaskBlockedError } from "./task-errors.js";

export const defaultTaskDirectory = fileURLToPath(new URL("../../.codeagent", import.meta.url));
export interface TaskServices { tools?: AgentTool[]; recovery?: Record<string, ToolRecoveryAdapter>; leaseRegistry?: string; platform?: () => Promise<WindowsHost> }
export interface TaskOptions {
  spec: TaskDefinition; dataDirectory?: string; config?: AgentConfig; gateway?: ModelGateway;
  readonly?: boolean; noShell?: boolean; services?: TaskServices;
  testHooks?: { beforeVerification?: (context: { phase: "milestone" | "final"; milestoneId: string | null }) => Promise<void>; barrier?: (name: string) => Promise<void> };
}
export interface OpenTaskOptions extends Omit<TaskOptions, "spec"> { taskId: string; controlOnly?: boolean }

export class TaskController {
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private started = false; private closed = false; private active: AbortController | undefined;
  private work: Promise<TaskState> | undefined; private commands: Promise<void> = Promise.resolve();
  private readonly verifier: Verifier; private readonly unsubscribe: () => void;
  private poll: NodeJS.Timeout | undefined; private pollError: unknown; private contractChanged = false;
  constructor(readonly repository: TaskRepository, private readonly session: AgentSession, private readonly redactor: SecretRedactor,
    private readonly options: TaskOptions | OpenTaskOptions, private readonly host: WindowsHost, private readonly workspaceLease: ExecutionLease,
    private readonly environment: LocalEnvironment, private readonly tools: AgentTool[], private readonly reopening: boolean) {
    this.verifier = new Verifier(repository, redactor, host);
    this.unsubscribe = session.subscribe(event => this.emit({ type: "agent_event", taskId: this.id, event }));
  }
  get id(): string { return this.repository.view().id; }
  get state(): TaskState { return this.repository.view(); }
  subscribe(listener: (event: TaskEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: TaskEvent): void { for (const listener of this.listeners) { try { void Promise.resolve(listener(event)).catch(() => undefined); } catch { /* Observer only. */ } } }
  private async commit(fact: TaskFact): Promise<void> { this.emit(await this.repository.append(fact)); }
  private async barrier(name: string): Promise<void> { await this.options.testHooks?.barrier?.(name); }

  start(signal?: AbortSignal): Promise<TaskState> { return this.launch(false, signal); }
  resume(signal?: AbortSignal): Promise<TaskState> { return this.launch(true, signal); }
  private launch(resume: boolean, signal?: AbortSignal): Promise<TaskState> {
    if ("controlOnly" in this.options && this.options.controlOnly) return Promise.reject(new Error("control worker cannot run models"));
    if (this.closed || this.started) return Promise.reject(new Error("任务已启动或关闭"));
    this.started = true; this.active = new AbortController();
    const cancel = () => { void sendTaskCommand({ taskId: this.id, dataDirectory: this.options.dataDirectory ?? defaultTaskDirectory, command: { id: randomUUID(), type: "cancel" } }).then(() => this.checkCommands(false)).catch(error => { this.pollError = error; this.active?.abort(); this.session.abort(); }); };
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    this.poll = setInterval(() => { void this.checkCommands(false).catch(error => { this.pollError = error; this.active?.abort(); this.session.abort(); }); }, 100);
    this.work = this.execute(resume || this.reopening, this.active.signal).finally(async () => {
      clearInterval(this.poll); signal?.removeEventListener("abort", cancel); await this.commands.catch(() => undefined); this.active = undefined;
    }); return this.work;
  }

  private async applyCommands(safe: boolean): Promise<void> {
    for (const envelope of await pendingCommands(this.repository.directory)) {
      if (envelope.taskId !== this.id) throw new Error("command_task_mismatch");
      const prior = this.state.commands?.[envelope.command.id];
      if (prior?.status === "applied" || prior?.status === "rejected") continue;
      const received: CommandResult = { id: envelope.command.id, contentHash: envelope.contentHash, seq: envelope.seq, status: "received" };
      if (!prior) await this.commit({ type: "command_received", result: received });
      if (envelope.command.type === "cancel") { this.active?.abort(); this.session.abort(); }
      if (!safe) continue;
      const result: CommandResult = { ...received, status: "applied" };
      if (terminalTask(this.state.status)) { await this.commit({ type: "command_applied", result: { ...result, status: "rejected", reason: "terminal_task" } }); continue; }
      if (envelope.command.type === "cancel" || envelope.command.type === "pause") {
        if (envelope.command.type === "pause") {
          try {
            const effects = await recoverTools(this.session.repository, this.environment, this.tools, this.options.services?.recovery);
            if (effects.length) await this.commit({ type: "recovery_completed", report: { effects, boundary: "pause" } });
          } catch (error) {
            const reason = this.redactor.text(errorText(error));
            await this.commit({ type: "command_applied", result: { ...result, status: "rejected", reason }, status: "blocked", reason });
            continue;
          }
        }
        await this.commit({ type: "command_applied", result, status: envelope.command.type === "cancel" ? "cancelled" : "paused" }); continue;
      }
      if (envelope.command.type !== "update") throw new Error("command_type_invalid");
      try {
        const next = validateTaskDefinition(envelope.command.spec); const state = this.state;
        if (envelope.command.expectedVersion !== state.specVersion) throw new Error("version_conflict");
        if ((await LocalEnvironment.create(next.workspaceRoot)).cwd !== state.spec.workspaceRoot || JSON.stringify(next.limits) !== JSON.stringify(state.spec.limits)) throw new Error("immutable_workspace_or_budget");
        const hashes = await trustedHashes(next);
        // The same trusted path may not be silently re-baselined after tampering.
        for (const [path, digest] of Object.entries(hashes)) if (state.trustedHashes[path] && state.trustedHashes[path] !== digest) throw new Error("trusted_file_changed：新合同必须采用新的可信文件路径");
        await this.commit({ type: "command_applied", result, spec: next, specVersion: state.specVersion + 1, trustedHashes: hashes, verifierManifestHash: hash(JSON.stringify({ verifiers: next.verifiers, trustedHashes: hashes })) });
        this.session.setWritablePaths(next.scope?.writablePaths ?? ["."]); this.contractChanged = true;
      } catch (error) { await this.commit({ type: "command_applied", result: { ...result, status: "rejected", reason: this.redactor.text(errorText(error)) } }); }
    }
  }
  private checkCommands(safe: boolean): Promise<void> {
    const operation = this.commands.then(() => controlLock(this.repository.directory, this.host, () => this.applyCommands(safe)));
    this.commands = operation; void operation.catch(() => undefined); return operation;
  }
  async admission(safe: boolean): Promise<void> {
    if (this.pollError) throw this.pollError;
    await this.checkCommands(safe);
    if (this.state.status === "cancelled") throw new Error("task_cancel_boundary");
    if (this.active?.signal.aborted) throw new Error("task_cancel_boundary");
    if (safe && this.state.status === "paused") throw new Error("task_pause_boundary");
    if (safe && this.contractChanged) throw new Error("task_contract_changed");
  }
  async processCommands(): Promise<TaskState> {
    if (this.started) throw new Error("busy：活动执行者通过准入门禁处理命令");
    await this.checkCommands(true); return this.state;
  }
  private async settle(status: TaskStatus, reason?: string, ids: string[] = []): Promise<TaskState> {
    await this.commit({ type: "task_settled", status, finalEvidenceIds: ids, ...(reason ? { reason } : {}) }); return this.state;
  }
  private async verify(ids: readonly string[], phase: "milestone" | "final", signal: AbortSignal): Promise<VerificationEvidence[]> {
    await this.admission(true); await this.commit({ type: "task_status", status: "verifying" }); const evidence: VerificationEvidence[] = [];
    for (const id of [...new Set(ids)]) {
      await this.admission(true); throwIfAborted(signal); await this.commit({ type: "verification_started", verificationId: id, phase });
      const result = await this.verifier.verify(this.state.spec.verifiers.find(v => v.id === id)!, signal, this.session.repository.cursor);
      await this.barrier("verification_artifact_written"); await this.commit({ type: "verification_completed", evidence: result }); evidence.push(result);
      if (result.result === "unavailable") break;
    } return evidence;
  }
  private prompt(milestone: TaskDefinition["milestones"][number], feedback: string[]): string {
    const state = this.state;
    return [`持久任务 ${state.id}，合同版本 ${state.specVersion}。目标：${state.spec.outcome}`, `约束：${state.spec.constraints.join("；")}`,
      `文件可写范围：${(state.spec.scope?.writablePaths ?? ["."]).join(", ")}；历史通过阶段仅是旧快照：${state.verifiedMilestones.join(", ") || "无"}`,
      `当前阶段 ${milestone.id}：${milestone.title}。读取实际代码，落实并自行检查。`,
      `本阶段验收：${milestone.verificationIds.map(id => state.spec.verifiers.find(v => v.id === id)!.description).join("；")}`,
      feedback.length ? "按合同的可写范围修复造成失败的依赖，重新读取并复现，不从旧回复推断代码状态。" : "只完成当前阶段；后续阶段由控制器驱动。",
      "模型回复结束不代表验收通过。不得修改工作区外的状态和验收程序。私有证据由宿主持有，不用文件工具读取其路径。",
      feedback.length ? `实际失败诊断：\n${feedback.join("\n")}` : "遵循 AGENTS.md 的公开接口。"].join("\n");
  }
  private feedback(evidence: VerificationEvidence[]): string[] { return evidence.filter(e => e.result === "failed").flatMap(e => [`验收 ${e.verificationId} 失败：${this.state.spec.verifiers.find(v => v.id === e.verificationId)!.description}`, ...e.failures]); }
  private async reconcile(): Promise<void> {
    const run = this.state.activeRun;
    if (run && !run.status) {
      const entry = await this.session.repository.acceptInputOnce({ ...run, prompt: run.prompt });
      if (!run.inputCursor) await this.commit({ type: "task_input_applied", runId: run.runId, inputCursor: entry.id });
      const settled = this.session.repository.facts().findLast(e => e.kind === "run_status" && e.runId === run.runId && e.status !== "running");
      if (!settled) await this.session.repository.append({ kind: "run_status", runId: run.runId, status: "interrupted" });
      await this.commit({ type: "task_run_completed", runId: run.runId, status: settled?.kind === "run_status" ? settled.status : "interrupted", sessionCursor: this.session.repository.cursor });
    }
    const report = await recoverTools(this.session.repository, this.environment, this.tools, this.options.services?.recovery);
    await this.commit({ type: "recovery_completed", report: { effects: report, previousRun: run?.runId ?? null, runs: this.state.runs, repairs: this.state.repairs } });
    await this.commit({ type: "evidence_invalidated", reason: "resume：历史证据需要重新验证当前工作区" });
  }
  private async fresh(evidence: VerificationEvidence[]): Promise<boolean> {
    try {
      const state = this.state; if (JSON.stringify(await trustedHashes(state.spec)) !== JSON.stringify(state.trustedHashes)) return false;
      for (const item of evidence) {
        if (item.specVersion !== state.specVersion || item.verifierManifestHash !== state.verifierManifestHash || item.inputFingerprint !== await inputFingerprint(this.environment, state.spec.verifiers.find(v => v.id === item.verificationId)!.inputs)) return false;
        for (const [path, digest] of Object.entries(item.artifactHashes)) if (digest !== hash(await readFile(await this.environment.path(path)))) return false;
      } return true;
    } catch (error) { throw new TaskBlockedError("verification_inputs_changed", "最终证据无法核查，需恢复文件后重新验收", { cause: error }); }
  }
  private async finish(evidence: VerificationEvidence[], signal: AbortSignal): Promise<TaskState | undefined> {
    if (!await this.fresh(evidence)) return this.settle("blocked", "verification_inputs_changed：最终证据失效");
    await this.barrier("before_success"); await this.commands;
    return controlLock(this.repository.directory, this.host, async () => {
      await this.applyCommands(true);
      if (this.state.status === "paused" || this.state.status === "cancelled") return this.state;
      if (this.contractChanged) return undefined;
      throwIfAborted(signal);
      for (const m of this.state.spec.milestones) await this.commit({ type: "milestone_verified", milestoneId: m.id, evidenceIds: evidence.filter(e => m.verificationIds.includes(e.verificationId)).map(e => e.id) });
      // Commands may have awaited I/O since the first check. Bind success to
      // the last observed files while cooperative publication is serialized.
      if (!await this.fresh(evidence)) return this.settle("blocked", "verification_inputs_changed：最终证据失效");
      return this.settle("succeeded", undefined, evidence.map(e => e.id));
    });
  }
  private async execute(recovering: boolean, signal: AbortSignal): Promise<TaskState> {
    let index = 0; let feedback: string[] = []; let revalidate = recovering;
    try {
      await this.checkCommands(true);
      if (terminalTask(this.state.status) || this.state.status === "budget_exhausted") return this.state;
      if (recovering) { await this.commit({ type: "task_status", status: "recovering" }); await this.reconcile(); }
      for (;;) {
        try {
          if (this.pollError) throw this.pollError;
          await this.checkCommands(true);
          const afterRun = this.state;
          if (["paused", "cancelled"].includes(afterRun.status)) return afterRun;
          if (this.contractChanged) { this.contractChanged = false; revalidate = true; }
          throwIfAborted(signal);
          let state = this.state;
          if (revalidate) {
            const evidence = await this.verify(state.spec.finalVerificationIds, "final", signal);
            const unavailable = evidence.find(e => e.result === "unavailable"); if (unavailable) return this.settle("blocked", `verification_unavailable：${unavailable.failures.join("；")}`);
            if (evidence.every(e => e.result === "passed")) { const finished = await this.finish(evidence, signal); if (finished) return finished; continue; }
            feedback = this.feedback(evidence); const failed = evidence.filter(e => e.result === "failed").map(e => e.verificationId);
            const historicalRegression = state.spec.milestones.some(m => state.verifiedMilestones.includes(m.id) && m.verificationIds.some(id => failed.includes(id) && state.evidence.some(e => e.result === "passed" && e.specVersion === state.specVersion && e.verificationId === id)));
            if (historicalRegression) {
              if (state.repairs >= state.spec.limits.maxRepairs) return this.settle("budget_exhausted", "max_repairs：恢复后历史阶段回归，修复额度用尽");
              await this.commit({ type: "repair_requested", failures: feedback });
            }
            index = state.spec.milestones.findIndex(m => m.verificationIds.some(id => failed.includes(id))); if (index < 0) index = state.spec.milestones.length - 1;
            revalidate = false;
          }
          state = this.state;
          if (state.runs >= state.spec.limits.maxRuns) return this.settle("budget_exhausted", "max_runs：任务执行片段额度用尽");
          const milestone = state.spec.milestones[index]!; const runId = randomUUID(); const inputId = randomUUID(); const prompt = this.prompt(milestone, feedback);
          await this.commit({ type: "task_status", status: "running" });
          await this.commit({ type: "task_run_started", runId, milestoneId: milestone.id, prompt, inputId, contentHash: digest(prompt), specVersion: state.specVersion });
          await this.barrier("run_planned");
          const input = await this.session.repository.acceptInputOnce({ inputId, runId, specVersion: state.specVersion, contentHash: digest(prompt), prompt });
          await this.barrier("input_accepted"); await this.commit({ type: "task_input_applied", runId, inputCursor: input.id });
          const result = await this.session.submit(prompt, "reject", { runId });
          await this.barrier("session_run_settled"); await this.commit({ type: "task_run_completed", runId, status: result.status, sessionCursor: this.session.repository.cursor });
          await this.checkCommands(true);
          if (this.state.status === "paused" || this.state.status === "cancelled") return this.state;
          if (this.contractChanged) { revalidate = true; continue; }
          throwIfAborted(signal);
          if (result.status === "failed") return this.settle("blocked", `model_error：${result.error ?? "Agent 执行失败"}`);
          await this.options.testHooks?.beforeVerification?.({ phase: "milestone", milestoneId: milestone.id });
          let evidence = await this.verify(milestone.verificationIds, "milestone", signal);
          if (evidence.every(e => e.result === "passed")) {
            await this.commit({ type: "milestone_verified", milestoneId: milestone.id, evidenceIds: evidence.map(e => e.id) }); await this.barrier("milestone_verified"); await this.barrier(`milestone_verified:${milestone.id}`);
            await this.admission(true); feedback = [];
            if (index < state.spec.milestones.length - 1) { index++; continue; }
            await this.options.testHooks?.beforeVerification?.({ phase: "final", milestoneId: null }); evidence = await this.verify(state.spec.finalVerificationIds, "final", signal);
            if (evidence.every(e => e.result === "passed")) { const finished = await this.finish(evidence, signal); if (finished) return finished; revalidate = true; continue; }
          }
          const unavailable = evidence.find(e => e.result === "unavailable"); if (unavailable) return this.settle("blocked", `verification_unavailable：${unavailable.failures.join("；")}`);
          feedback = this.feedback(evidence);
          if (this.state.repairs >= this.state.spec.limits.maxRepairs) return this.settle("budget_exhausted", `max_repairs：修复额度用尽；${feedback.join("；")}`);
          await this.commit({ type: "repair_requested", failures: feedback });
          const failed = evidence.filter(e => e.result === "failed").map(e => e.verificationId);
          index = this.state.spec.milestones.findIndex(m => m.verificationIds.some(id => failed.includes(id))); if (index < 0) index = this.state.spec.milestones.length - 1;
        } catch (error) {
          if (this.contractChanged && !signal.aborted && !this.pollError) { this.contractChanged = false; revalidate = true; continue; }
          await this.checkCommands(true);
          if (this.state.status === "paused" || this.state.status === "cancelled") return this.state;
          throw error;
        }
      }
    } catch (error) {
      if (this.pollError) throw new Error(`persistence_error：停止未确认持久化；${this.redactor.text(errorText(this.pollError))}`);
      const message = this.redactor.text(errorText(error));
      if (message.includes("persistence_error")) throw error;
      return this.settle(error instanceof TaskBlockedError ? "blocked" : "failed", message);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; clearInterval(this.poll); this.active?.abort(); this.session.abort(); await this.work?.catch(() => undefined); await this.commands.catch(() => undefined); this.unsubscribe();
    try { await this.session.close(); } finally { try { await this.repository.close(); } finally { await this.workspaceLease.close(); await this.host.close(); } } this.listeners.clear();
  }
}

async function initialize(options: TaskOptions | OpenTaskOptions): Promise<TaskController> {
  if (options.noShell || options.readonly) throw new Error("任务需要进程和写入能力，不能在 --no-shell / --readonly 下运行");
  const config = options.config ?? loadConfig(); const redactor = new SecretRedactor([config.apiKey]); const reopening = "taskId" in options;
  const directory = resolve(options.dataDirectory ?? defaultTaskDirectory);
  let existing = reopening ? await TaskRepository.read(directory, options.taskId) : undefined;
  const spec = existing?.spec ?? redactor.json(validateTaskDefinition((options as TaskOptions).spec));
  const environment = await LocalEnvironment.create(spec.workspaceRoot); spec.workspaceRoot = environment.cwd;
  if (existing && !("controlOnly" in options && options.controlOnly) && (existing.execution.modelId !== config.modelId || existing.execution.baseUrl !== config.baseUrl || existing.execution.thinking !== config.thinking || existing.execution.gateway !== (options.gateway ? "custom" : "pi-ai"))) throw new Error("execution_config_incompatible");
  const host = await (options.services?.platform?.() ?? WindowsHost.create()); let lease: ExecutionLease | undefined; let repository: TaskRepository | undefined;
  try {
    const registry = existing?.leaseRegistry ?? resolve(options.services?.leaseRegistry ?? join(defaultTaskDirectory, "leases"));
    lease = await host.acquire(join(registry, `${hash(environment.cwd.toLowerCase())}.lease`));
    const toolsEnvironment = await LocalEnvironment.create(spec.workspaceRoot, config.toolTimeoutMs, host, spec.scope?.writablePaths ?? ["."]);
    const tools = [...createCodingTools(toolsEnvironment), ...(options.services?.tools ?? [])]; const toolVersions = Object.fromEntries(tools.map(t => [t.name, t.version ?? "1"]));
    if (existing?.schemaVersion === 1) {
      await migrateUnstartedTask(directory, existing, host, registry, toolVersions, options.testHooks?.barrier);
      existing = await TaskRepository.read(directory, existing.id);
    }
    if (existing && !("controlOnly" in options && options.controlOnly) && JSON.stringify(existing.toolVersions) !== JSON.stringify(toolVersions)) throw new Error("tool_versions_incompatible");
    const hashes = existing?.trustedHashes ?? await trustedHashes(spec);
    const initial: TaskState = existing ?? { schemaVersion: 2, id: randomUUID(), sessionId: randomUUID(), specVersion: 1, spec,
      verifierManifestHash: hash(JSON.stringify({ verifiers: spec.verifiers, trustedHashes: hashes })), trustedHashes: hashes, leaseRegistry: registry, toolVersions, commands: {}, scopeSource: spec.scope ? "explicit" : "legacy_workspace",
      execution: { modelId: config.modelId, baseUrl: config.baseUrl, thinking: config.thinking, maxTurns: config.maxTurns, maxOutputTokens: config.maxOutputTokens ?? 8192, requestTimeoutMs: config.requestTimeoutMs, toolTimeoutMs: config.toolTimeoutMs, gateway: options.gateway ? "custom" : "pi-ai" },
      status: "pending", verifiedMilestones: [], milestoneEvidence: {}, finalEvidenceIds: [], evidence: [], runs: 0, repairs: 0 };
    repository = existing ? await TaskRepository.open(directory, initial.id, redactor, host) : await TaskRepository.create(directory, initial, redactor, host);
    await host.restoreProcessGroups(join(repository.directory, "process-groups.jsonl"));
    const paths = await migrationPaths(repository.directory, initial.id);
    let controller!: TaskController;
    const effectiveConfig = { ...config, maxTurns: initial.execution.maxTurns, maxOutputTokens: initial.execution.maxOutputTokens, requestTimeoutMs: initial.execution.requestTimeoutMs, toolTimeoutMs: initial.execution.toolTimeoutMs };
    const session = await createAgentSession({ config: effectiveConfig, cwd: spec.workspaceRoot, sessionId: initial.sessionId, dataDirectory: join(directory, "sessions"), host, taskMode: true,
      writablePaths: spec.scope?.writablePaths ?? ["."], additionalTools: options.services?.tools ?? [], ...(paths.sessionLog ? { logPath: paths.sessionLog } : {}), ...(options.gateway ? { gateway: options.gateway } : {}),
      hooks: { beforeModel: () => controller.admission(true), beforeTool: () => controller.admission(false), afterEffect: call => options.testHooks?.barrier?.(`tool_effect_completed:${call.name}`) ?? Promise.resolve() } });
    controller = new TaskController(repository, session, redactor, options, host, lease, toolsEnvironment, tools, reopening); return controller;
  } catch (error) { await repository?.close(); await lease?.close(); await host.close(); throw error; }
}
export async function createTaskController(options: TaskOptions): Promise<TaskController> { return initialize(options); }
export async function openTaskController(options: OpenTaskOptions): Promise<TaskController> { return initialize(options); }
