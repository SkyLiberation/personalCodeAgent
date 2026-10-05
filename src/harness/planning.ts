import type { ModelGateway } from "../contracts.js";
import { digest } from "../storage/journal.js";
import { validateTaskDefinition, type TaskDefinition, type VerificationSpec } from "../task-contracts.js";
import { createTaskController, type TaskController, type TaskOptions } from "./task-controller.js";

export interface GoalDraft { spec: TaskDefinition; hash: string; status: "awaiting_confirmation" }
export async function draftGoal(input: { outcome: string; workspaceRoot: string; constraints: string[]; writablePaths: string[];
  verifiers: VerificationSpec[]; limits: TaskDefinition["limits"]; gateway: ModelGateway; signal: AbortSignal }): Promise<GoalDraft> {
  if (!input.verifiers.length) throw new Error("planning_requires_host_verifiers");
  let text = "";
  for await (const event of input.gateway.stream({ purpose: "replan", tools: [], messages: [{ role: "user", timestamp: Date.now(), text:
    `Draft engineering milestones for this goal. Return ONLY JSON {"milestones":[{"id":"M1","title":"...","verificationIds":["host-id"]}]}.
Every host verifier must be covered, use only listed IDs; don't invent verifier code, permissions or budgets. Goal: ${input.outcome}\nConstraints: ${input.constraints.join("; ")}\nHost gates: ${JSON.stringify(input.verifiers.map(v => ({ id: v.id, description: v.description })))}` }] }, input.signal)) {
    if (event.type === "done") { if (event.message.toolCalls.length || event.message.stopReason === "length") throw new Error("goal_draft_invalid"); text = event.message.text; }
  }
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { milestones: TaskDefinition["milestones"] };
  const spec = validateTaskDefinition({ workspaceRoot: input.workspaceRoot, outcome: input.outcome, constraints: input.constraints,
    scope: { writablePaths: input.writablePaths }, milestones: parsed.milestones, finalVerificationIds: input.verifiers.map(v => v.id), verifiers: input.verifiers, limits: input.limits });
  if (input.verifiers.some(v => !spec.milestones.some(m => m.verificationIds.includes(v.id)))) throw new Error("goal_draft_missing_host_gate");
  return { spec, hash: digest(spec), status: "awaiting_confirmation" };
}
export async function confirmGoal(draft: GoalDraft, confirmation: { hash: string; confirmed: true }, options: Omit<TaskOptions, "spec"> = {}): Promise<TaskController> {
  if (confirmation.confirmed !== true || confirmation.hash !== draft.hash || digest(draft.spec) !== draft.hash) throw new Error("goal_confirmation_mismatch");
  return createTaskController({ ...options, spec: draft.spec });
}
