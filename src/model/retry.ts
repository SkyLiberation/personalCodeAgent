import { setTimeout as wait } from "node:timers/promises";
import type { ModelEvent, ModelGateway, ModelRequest } from "../contracts.js";
import type { TaskFact, TaskState } from "../task-contracts.js";
import { ModelRequestBudgetError } from "./request-budget.js";
import { modelBudgetUsage } from "./request-budget.js";
import { throwIfAborted } from "../security.js";

export class GatewayError extends Error {
  constructor(message: string, readonly classification: "rate_limit" | "service" | "connection" | "capacity" | "invalid" | "unknown") { super(message); }
}
export function classifyGatewayError(error: unknown): GatewayError["classification"] {
  if (error instanceof GatewayError) return error.classification;
  // Only explicit transport diagnostics are eligible; arbitrary business/tool errors never pass here.
  const text = error instanceof Error ? error.message : "";
  if (/\b429\b|rate.limit/i.test(text)) return "rate_limit";
  if (/\b50[0234]\b|service unavailable|bad gateway/i.test(text)) return "service";
  if (/connection error|ECONNRESET|ETIMEDOUT|fetch failed/i.test(text)) return "connection";
  if (/context.{0,25}(length|window|exceed)|too many tokens/i.test(text)) return "capacity";
  return "unknown";
}
/** Retry provider attempts only. Complete responses are buffered so failed attempts cannot execute tools. */
export class RetryingModelGateway implements ModelGateway {
  constructor(private readonly gateway: ModelGateway, private readonly ledger: { state(): TaskState; commit(fact: TaskFact): Promise<void>; admission?(): Promise<void> }) {}
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let retry = false;
    for (;;) {
      throwIfAborted(signal); await this.ledger.admission?.();
      try {
        let done: Extract<ModelEvent, { type: "done" }> | undefined;
        for await (const event of this.gateway.stream({ ...request, ...(retry ? { purpose: "retry" } : {}) }, signal)) {
          if (event.type === "done") { if (done) throw new Error("duplicate_model_response"); done = event; }
          else yield event;
        }
        if (!done) throw new Error("incomplete_model_response");
        yield done;
        return;
      } catch (error) {
        if (signal.aborted || error instanceof ModelRequestBudgetError) throw error;
        const classification = classifyGatewayError(error);
        const state = this.ledger.state(); const policy = state.spec.retryPolicy;
        const attempts = state.retry?.attempts ?? 0; const waitMs = state.retry?.waitMs ?? 0;
        if (!policy || !["rate_limit", "service", "connection"].includes(classification) || attempts >= policy.maxRetries) throw error;
        const delayMs = Math.min(policy.delayMs * 2 ** Math.min(attempts, 10), 30_000);
        if (waitMs + delayMs > policy.maxWaitMs) throw error;
        if (state.spec.limits.maxDurationMs !== undefined && modelBudgetUsage(state).durationMs + delayMs > state.spec.limits.maxDurationMs) throw new ModelRequestBudgetError("model_time_budget_exhausted");
        await this.ledger.commit({ type: "retry_scheduled", delayMs, classification });
        await wait(delayMs, undefined, { signal }); retry = true;
      }
    }
  }
}
