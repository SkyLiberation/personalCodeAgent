import { randomUUID } from "node:crypto";
import type { ModelEvent, ModelGateway, ModelRequest, Usage } from "../contracts.js";
import type { TaskFact, TaskState } from "../task-contracts.js";
import { throwIfAborted } from "../security.js";
import { estimateContext } from "../harness/context.js";

export class ModelRequestBudgetError extends Error {
  constructor(reason = "model_request_budget_exhausted") { super(`${reason}：全任务模型预算用尽`); }
}

export function modelBudgetUsage(state: TaskState): { tokens: number; durationMs: number; costUsd: number } {
  const price = state.spec.limits.pricing;
  const total = Object.values(state.modelRequests ?? {}).reduce((total, record) => {
    total.tokens += record.usage ? record.usage.inputTokens + record.usage.outputTokens : record.reservation?.tokens ?? (state.spec.limits.maxTokens ? Infinity : 0);
    total.durationMs += record.durationMs ?? record.reservation?.durationMs ?? (state.spec.limits.maxDurationMs ? Infinity : 0);
    total.costUsd += record.usage && price ? (record.usage.inputTokens * price.inputUsdPerMillion + record.usage.outputTokens * price.outputUsdPerMillion) / 1e6 : record.reservation?.costUsd ?? (state.spec.limits.maxCostUsd ? Infinity : 0);
    return total;
  }, { tokens: 0, durationMs: 0, costUsd: 0 });
  total.durationMs += Object.values(state.activities ?? {}).reduce((sum, activity) => sum + (activity.elapsedMs ?? activity.reservedMs), 0);
  total.durationMs += state.retry?.waitMs ?? 0;
  return total;
}
export function modelBudgetReason(state: TaskState): string | undefined {
  if (requestBudgetExhausted(state)) return "model_request_budget_exhausted";
  if (state.spec.limits.maxToolCalls !== undefined && Object.values(state.activities ?? {}).filter(a => a.kind === "tool").length >= state.spec.limits.maxToolCalls) return "model_tool_budget_exhausted";
  const used = modelBudgetUsage(state); const limits = state.spec.limits;
  if (limits.maxTokens !== undefined && used.tokens >= limits.maxTokens) return "model_token_budget_exhausted";
  if (limits.maxDurationMs !== undefined && used.durationMs >= limits.maxDurationMs) return "model_time_budget_exhausted";
  if (limits.maxCostUsd !== undefined && used.costUsd >= limits.maxCostUsd) return "model_cost_budget_exhausted";
  return undefined;
}

export function requestBudgetExhausted(state: TaskState): boolean {
  return state.spec.limits.maxModelRequests !== undefined && Object.keys(state.modelRequests ?? {}).length >= state.spec.limits.maxModelRequests;
}

/** All model purposes share reservations, committed before calling the provider. */
export class BudgetedModelGateway implements ModelGateway {
  private admission: Promise<void> = Promise.resolve();
  constructor(private readonly gateway: ModelGateway, private readonly ledger: {
    state(): TaskState;
    commit(fact: TaskFact): Promise<void>;
    barrier?(name: string): Promise<void>;
    beforeDispatch?(): Promise<void>;
  }) {}

  private async reserve(request: ModelRequest): Promise<string> {
    const id = randomUUID();
    const operation = this.admission.then(async () => {
      const state = this.ledger.state();
      const reason = modelBudgetReason(state); if (reason) throw new ModelRequestBudgetError(reason);
      const used = modelBudgetUsage(state); const limits = state.spec.limits;
      const input = estimateContext(request); const output = state.execution.maxOutputTokens;
      const reservation = { tokens: input + output, durationMs: state.execution.requestTimeoutMs,
        ...(limits.pricing ? { costUsd: (input * limits.pricing.inputUsdPerMillion + output * limits.pricing.outputUsdPerMillion) / 1e6 } : {}) };
      if (limits.maxTokens !== undefined && used.tokens + reservation.tokens > limits.maxTokens) throw new ModelRequestBudgetError("model_token_budget_exhausted");
      if (limits.maxDurationMs !== undefined && used.durationMs + reservation.durationMs > limits.maxDurationMs) throw new ModelRequestBudgetError("model_time_budget_exhausted");
      if (limits.maxCostUsd !== undefined && used.costUsd + (reservation.costUsd ?? Infinity) > limits.maxCostUsd) throw new ModelRequestBudgetError("model_cost_budget_exhausted");
      try {
        await this.ledger.commit({ type: "model_request_reserved", request: {
          id, purpose: request.purpose ?? "execution", status: "reserved",
          reservation, reservedAt: Date.now(),
          ...(state.activeRun ? { runId: state.activeRun.runId } : {}),
        } });
      } catch (error) { throw new Error("persistence_error：模型请求预留未提交", { cause: error }); }
    });
    this.admission = operation.catch(() => undefined);
    await operation; return id;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    throwIfAborted(signal);
    const id = await this.reserve(request);
    const started = performance.now();
    let done: Extract<ModelEvent, { type: "done" }> | undefined;
    let usage: Usage | undefined;
    let failure: unknown;
    let failed = false;
    try {
      await this.ledger.barrier?.("model_request_reserved");
      await this.ledger.beforeDispatch?.();
      throwIfAborted(signal);
      let observed = false;
      for await (const event of this.gateway.stream(request, signal)) {
        if (!observed) { observed = true; await this.ledger.barrier?.("model_request_dispatched"); }
        throwIfAborted(signal);
        if (event.type === "done") {
          if (done) throw new Error("模型流包含多个最终响应");
          done = event; usage = event.usage;
        } else yield event;
      }
      if (!done) throw new Error("模型流结束但没有完整响应");
      await this.ledger.barrier?.("model_response_received");
      throwIfAborted(signal);
    } catch (error) { failed = true; failure = error; }
    try {
      await this.ledger.commit({ type: "model_request_settled", requestId: id,
        status: signal.aborted ? "aborted" : failed ? "failed" : "completed", durationMs: Math.ceil(performance.now() - started), ...(usage ? { usage } : {}) });
    } catch (error) { throw new Error("persistence_error：模型请求结算未提交，禁止执行响应工具", { cause: error }); }
    if (failed) throw failure;
    // A tool call becomes executable only after the request settlement is durable.
    yield done!;
  }
}
