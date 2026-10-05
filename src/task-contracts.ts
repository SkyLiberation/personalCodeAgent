import { isAbsolute } from "node:path";
import type { AgentEvent, ModelRequest, Usage } from "./contracts.js";
import { validateContextPolicy, type ContextPolicy } from "./harness/context.js";

export interface TaskLimits { maxRuns: number; maxRepairs: number; maxModelRequests?: number; maxToolCalls?: number; maxTokens?: number; maxDurationMs?: number; maxCostUsd?: number;
  pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number } }
export interface RetryPolicy { maxRetries: number; maxWaitMs: number; delayMs: number }

export interface VerificationSpec {
  id: string;
  description: string;
  command: string;
  args: string[];
  inputs: string[];
  trustedFiles: string[];
  outputs: string[];
  timeoutMs: number;
}

export interface TaskDefinition {
  workspaceRoot: string;
  outcome: string;
  constraints: string[];
  scope?: { writablePaths: string[] };
  milestones: { id: string; title: string; verificationIds: string[] }[];
  finalVerificationIds: string[];
  verifiers: VerificationSpec[];
  limits: TaskLimits;
  contextPolicy?: ContextPolicy;
  historyRetrieval?: boolean;
  progressPolicy?: { failureWindow: number; maxReplans: number };
  retryPolicy?: RetryPolicy;
  completionPolicy?: "natural" | "verification";
  requiredInputs?: string[];
}

export interface ModelRequestRecord {
  id: string;
  purpose: NonNullable<ModelRequest["purpose"]>;
  runId?: string;
  status: "reserved" | "completed" | "failed" | "aborted";
  // Missing usage is unknown, never zero. Reservations remain consumed on recovery.
  usage?: Usage;
  reservation?: { tokens: number; durationMs: number; costUsd?: number };
  reservedAt?: number;
  durationMs?: number;
}

export type TaskStatus = "pending" | "running" | "verifying" | "recovering" | "paused" | "succeeded" | "blocked" | "budget_exhausted" | "cancelled" | "failed";

export type TaskCommand = { id: string; type: "pause" | "cancel" } | { id: string; type: "update"; spec: TaskDefinition; expectedVersion: number }
  | { id: string; type: "adjust_budget"; limits: TaskLimits; expectedVersion: number; reason: string };
export interface CommandResult { id: string; contentHash: string; seq: number; status: "queued" | "received" | "applied" | "rejected"; reason?: string }
export interface PlannedRun { runId: string; inputId: string; contentHash: string; prompt: string; milestoneId: string; specVersion: number; inputCursor?: string; status?: string }

export interface VerificationEvidence {
  id: string;
  taskId: string;
  specVersion: number;
  verificationId: string;
  inputFingerprint: string;
  verifierManifestHash: string;
  artifactHashes: Record<string, string>;
  result: "passed" | "failed" | "unavailable";
  checks: number;
  passed: number;
  failures: string[];
  reportArtifact: string;
  sessionCursor: string | null;
  observedAt: number;
}

export interface TaskState {
  schemaVersion: 1 | 2;
  id: string;
  sessionId: string;
  specVersion: number;
  spec: TaskDefinition;
  verifierManifestHash: string;
  trustedHashes: Record<string, string>;
  execution: {
    modelId: string; baseUrl: string; thinking: string; maxTurns: number; maxOutputTokens: number;
    requestTimeoutMs: number; toolTimeoutMs: number; gateway: "pi-ai" | "custom";
    maxReadConcurrency?: number;
  };
  status: TaskStatus;
  verifiedMilestones: string[];
  milestoneEvidence: Record<string, string[]>;
  finalEvidenceIds: string[];
  evidence: VerificationEvidence[];
  runs: number;
  repairs: number;
  modelRequests?: Record<string, ModelRequestRecord>;
  activeRun?: PlannedRun;
  commands?: Record<string, CommandResult>;
  leaseRegistry?: string;
  toolVersions?: Record<string, string>;
  scopeSource?: "explicit" | "legacy_workspace";
  reason?: string;
  progress?: { specVersion: number; failures: number; replans: number; verifiedIds: string[]; strategy?: string; strategyMilestoneId?: string; pendingReplanId?: string };
  retry?: { attempts: number; waitMs: number };
  budgetVersion?: number;
  budgetStoppedVersion?: number;
  budgetStopReason?: string;
  activities?: Record<string, { kind: "tool" | "verification"; reservedMs: number; status: "reserved" | "completed"; elapsedMs?: number }>;
}

export type TaskFact =
  | { type: "task_created"; state: TaskState }
  | { type: "task_status"; status: TaskStatus; reason?: string }
  | { type: "task_run_started"; runId: string; milestoneId: string; prompt: string; inputId?: string; contentHash?: string; specVersion?: number }
  | { type: "task_input_applied"; runId: string; inputCursor: string }
  | { type: "task_run_completed"; runId: string; status: string; sessionCursor: string | null }
  | { type: "verification_started"; verificationId: string; phase: "milestone" | "final" }
  | { type: "verification_completed"; evidence: VerificationEvidence }
  | { type: "milestone_verified"; milestoneId: string; evidenceIds: string[] }
  | { type: "repair_requested"; failures: string[] }
  | { type: "model_request_reserved"; request: ModelRequestRecord }
  | { type: "model_request_settled"; requestId: string; status: "completed" | "failed" | "aborted"; usage?: Usage; durationMs?: number }
  | { type: "progress_observed"; specVersion: number; verificationIds: string[]; failures: string[] }
  | { type: "strategy_replan_reserved"; specVersion: number; attemptId: string }
  | { type: "strategy_replanned"; specVersion: number; strategy: string; milestoneId?: string; attemptId?: string; reportArtifact?: string }
  | { type: "retry_scheduled"; delayMs: number; classification: string }
  | { type: "activity_reserved"; activityId: string; kind: "tool" | "verification"; reservedMs: number }
  | { type: "activity_completed"; activityId: string; elapsedMs: number }
  | { type: "budget_adjusted"; limits: TaskLimits; expectedVersion: number; reason: string; result: CommandResult }
  | { type: "command_received"; result: CommandResult }
  | { type: "command_applied"; result: CommandResult; status?: TaskStatus; reason?: string; spec?: TaskDefinition; specVersion?: number; trustedHashes?: Record<string, string>; verifierManifestHash?: string }
  | { type: "recovery_completed"; report: Record<string, unknown> }
  | { type: "evidence_invalidated"; reason: string }
  | { type: "task_settled"; status: TaskStatus; finalEvidenceIds: string[]; reason?: string };

export type TaskRecord = TaskFact & { taskId: string; seq: number; eventId: string; timestamp: number; previousHash?: string; checksum?: string };
export type TaskEvent = TaskRecord | { type: "agent_event"; taskId: string; event: AgentEvent };

export function validateTaskDefinition(input: unknown): TaskDefinition {
  const strings = (value: unknown, name: string, nonempty = false): string[] => {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim()) || (nonempty && !value.length)) {
      throw new Error(`任务 ${name} 必须为${nonempty ? "非空" : ""}字符串数组`);
    }
    return value;
  };
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`任务 ${name} 不能为空`);
    return value;
  };
  const integer = (value: unknown, name: string, minimum = 1): number => {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`任务 ${name} 必须为 >= ${minimum} 的整数`);
    return Number(value);
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("任务定义对象不合法");
    return value as Record<string, unknown>;
  };
  const source = object(input);
  if (!Array.isArray(source.verifiers) || !source.verifiers.length || !Array.isArray(source.milestones) || !source.milestones.length) {
    throw new Error("任务必须有阶段和可信验收器");
  }
  const verifiers = source.verifiers.map(item => {
    const v = object(item);
    const command = text(v.command, "verifier.command");
    if (!isAbsolute(command)) throw new Error("验收 command 必须为可执行程序的绝对路径");
    const inputs = strings(v.inputs, "verifier.inputs", true);
    const outputs = strings(v.outputs, "verifier.outputs");
    if ([...inputs, ...outputs].some(path => isAbsolute(path) || path.split(/[\\/]/).includes(".."))) {
      throw new Error("验收 inputs / outputs 必须是工作区内的相对路径");
    }
    const trustedFiles = strings(v.trustedFiles, "verifier.trustedFiles", true);
    if (trustedFiles.some(path => !isAbsolute(path))) throw new Error("可信验收文件必须使用绝对路径");
    return { id: text(v.id, "verifier.id"), description: text(v.description, "verifier.description"), command,
      args: strings(v.args, "verifier.args"), inputs, outputs, trustedFiles, timeoutMs: integer(v.timeoutMs, "verifier.timeoutMs") };
  });
  const verifierIds = new Set(verifiers.map(v => v.id));
  if (verifierIds.size !== verifiers.length) throw new Error("验收 ID 重复");
  const milestones = source.milestones.map(item => {
    const m = object(item);
    return { id: text(m.id, "milestone.id"), title: text(m.title, "milestone.title"), verificationIds: strings(m.verificationIds, "milestone.verificationIds", true) };
  });
  if (new Set(milestones.map(m => m.id)).size !== milestones.length) throw new Error("阶段 ID 重复");
  const finalVerificationIds = strings(source.finalVerificationIds, "finalVerificationIds", true);
  if ([...milestones.flatMap(m => m.verificationIds), ...finalVerificationIds].some(id => !verifierIds.has(id))) {
    throw new Error("任务引用了不存在的验收器");
  }
  if (milestones.flatMap(m => m.verificationIds).some(id => !finalVerificationIds.includes(id))) {
    throw new Error("最终验收必须覆盖全部阶段验收合同");
  }
  const limits = object(source.limits);
  const optional = (key: string, minimum = 1) => limits[key] === undefined ? {} : { [key]: integer(limits[key], `limits.${key}`, minimum) };
  const positive = (value: unknown, name: string, allowZero = false): number => { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(`${name} 不合法`); return value; };
  const pricing = limits.pricing === undefined ? undefined : object(limits.pricing);
  if (limits.maxCostUsd !== undefined && !pricing) throw new Error("cost_budget_requires_explicit_pricing");
  const progress = source.progressPolicy === undefined ? undefined : object(source.progressPolicy);
  const retry = source.retryPolicy === undefined ? undefined : object(source.retryPolicy);
  if (source.historyRetrieval !== undefined && typeof source.historyRetrieval !== "boolean") throw new Error("history_capability_invalid");
  const context = source.contextPolicy === undefined ? undefined : object(source.contextPolicy);
  if (source.completionPolicy !== undefined && !["natural", "verification"].includes(String(source.completionPolicy))) throw new Error("completion_policy_invalid");
  const scope = source.scope === undefined ? undefined : { writablePaths: strings(object(source.scope).writablePaths, "scope.writablePaths", true) };
  const requiredInputs = source.requiredInputs === undefined ? undefined : strings(source.requiredInputs, "requiredInputs", true);
  if (requiredInputs?.some(path => isAbsolute(path) || path.split(/[\\/]/).includes(".."))) throw new Error("required_inputs_must_be_relative");
  if (scope?.writablePaths.some(path => isAbsolute(path) || path.split(/[\\/]/).includes(".."))) throw new Error("scope 必须为工作区相对路径");
  return { workspaceRoot: text(source.workspaceRoot, "workspaceRoot"), outcome: text(source.outcome, "outcome"),
    constraints: strings(source.constraints, "constraints"), milestones, finalVerificationIds, verifiers,
    ...(scope ? { scope } : {}),
    ...(requiredInputs ? { requiredInputs } : {}),
    ...(source.completionPolicy ? { completionPolicy: source.completionPolicy as "natural" | "verification" } : {}),
    ...(progress ? { progressPolicy: { failureWindow: integer(progress.failureWindow, "failureWindow"), maxReplans: integer(progress.maxReplans, "maxReplans", 0) } } : {}),
    ...(retry ? { retryPolicy: { maxRetries: integer(retry.maxRetries, "maxRetries", 0), maxWaitMs: integer(retry.maxWaitMs, "maxWaitMs", 0), delayMs: integer(retry.delayMs, "delayMs", 0) } } : {}),
    ...(source.historyRetrieval !== undefined ? { historyRetrieval: source.historyRetrieval as boolean } : {}),
    ...(context ? { contextPolicy: validateContextPolicy({ softTokens: integer(context.softTokens, "softTokens"), hardTokens: integer(context.hardTokens, "hardTokens"), keepRecentTokens: integer(context.keepRecentTokens, "keepRecentTokens"), reserveOutputTokens: integer(context.reserveOutputTokens, "reserveOutputTokens") }) } : {}),
    limits: { maxRuns: integer(limits.maxRuns, "limits.maxRuns"), maxRepairs: integer(limits.maxRepairs, "limits.maxRepairs", 0),
      ...optional("maxModelRequests"), ...optional("maxToolCalls"), ...optional("maxTokens"), ...optional("maxDurationMs"),
      ...(limits.maxCostUsd === undefined ? {} : { maxCostUsd: positive(limits.maxCostUsd, "maxCostUsd") }),
      ...(pricing ? { pricing: { inputUsdPerMillion: positive(pricing.inputUsdPerMillion, "inputUsdPerMillion", true), outputUsdPerMillion: positive(pricing.outputUsdPerMillion, "outputUsdPerMillion", true) } } : {}) } };
}
