import type {
  AgentEventData, AssistantMessage, ModelGateway, ModelMessage, RunResult, ToolCall, Usage,
} from "../contracts.js";
import type { ExecutionHooks, ToolExecutor } from "../tools/executor.js";
import { errorText, SecretRedactor, throwIfAborted } from "../security.js";
import { ModelRequestBudgetError } from "../model/request-budget.js";
import { ContextCapacityError } from "../harness/context.js";
import { classifyGatewayError } from "../model/retry.js";

export interface RuntimeServices extends ExecutionHooks {
  commit(message: ModelMessage & { artifactId?: string }): Promise<ModelMessage>;
  emit(event: AgentEventData): void;
  steering(): Promise<ModelMessage[]>;
  beforeModel?(): Promise<void>;
  context?(tools: ReturnType<ToolExecutor["descriptors"]>, signal: AbortSignal, force?: boolean): Promise<ModelMessage[]>;
  afterBatch?(signal: AbortSignal): Promise<boolean>;
}

export class AgentRuntime {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly executor: ToolExecutor,
    private readonly options: { maxTurns: number; redactor: SecretRedactor; maxReadConcurrency?: number },
  ) {}

  async run(history: readonly ModelMessage[], signal: AbortSignal, services: RuntimeServices): Promise<RunResult> {
    const messages = [...history];
    let turns = 0;
    let text = "";
    let result: RunResult;
    let lengthRecoveries = 0; let capacityRecoveries = 0; let forceCompact = false;
    services.emit({ type: "run_started" });
    try {
      for (let turn = 1; turn <= this.options.maxTurns; turn++) {
        throwIfAborted(signal);
        await services.beforeModel?.();
        throwIfAborted(signal);
        turns = turn;
        services.emit({ type: "turn_started", turn });
        let assistant: AssistantMessage | undefined;
        let usage: Usage | undefined;
        const streamingRedactor = this.options.redactor.stream();
        try {
          const tools = this.executor.descriptors();
          const projected = services.context ? await services.context(tools, signal, forceCompact) : messages;
          forceCompact = false;
          for await (const event of this.gateway.stream({ messages: projected, tools, ...(lengthRecoveries || capacityRecoveries ? { purpose: "retry" } : {}) }, signal)) {
            throwIfAborted(signal);
            if (event.type === "text_delta") {
              const delta = streamingRedactor.write(event.delta);
              if (delta) services.emit({ type: "text_delta", delta });
            }
            if (event.type === "done") {
              if (assistant) throw new Error("模型流包含多个最终响应");
              assistant = this.options.redactor.json(event.message);
              usage = event.usage;
            }
          }
        } catch (error) {
          if (!signal.aborted && !(error instanceof ContextCapacityError) && classifyGatewayError(error) === "capacity" && services.context && capacityRecoveries++ === 0) {
            forceCompact = true; continue;
          }
          throw error;
        } finally {
          const delta = streamingRedactor.end();
          if (delta) services.emit({ type: "text_delta", delta });
        }
        if (!assistant) throw new Error("模型流结束但没有完整响应");
        const ids = assistant.toolCalls.map((call) => call.id);
        if (new Set(ids).size !== ids.length) throw new Error("模型响应中的 tool call ID 重复");
        const committed = await services.commit(assistant);
        messages.push(committed);
        services.emit({ type: "message_committed", message: committed });
        text = assistant.text;
        for (let i = 0; i < assistant.toolCalls.length;) {
          const calls = [assistant.toolCalls[i++]!];
          if (this.executor.parallelSafe(calls[0]!)) while (calls.length < (this.options.maxReadConcurrency ?? 1) && i < assistant.toolCalls.length && this.executor.parallelSafe(assistant.toolCalls[i]!)) calls.push(assistant.toolCalls[i++]!);
          const observed = await Promise.allSettled(calls.map(async call => {
            throwIfAborted(signal); services.emit({ type: "tool_started", call });
            return assistant.stopReason === "length"
              ? { text: "模型响应被截断，未执行工具；请重新生成完整参数。", isError: true, code: "truncated_response" }
              : this.executor.execute(call, signal, services);
          }));
          const failure = observed.find(result => result.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
          for (let j = 0; j < calls.length; j++) {
          const call = calls[j]!; const item = observed[j]!; if (item.status !== "fulfilled") throw new Error("tool_batch_failed"); const toolResult = item.value;
          const message = await services.commit({
            role: "tool_result", callId: call.id, toolName: call.name,
            text: toolResult.text, isError: toolResult.isError, timestamp: Date.now(),
            ...("artifactId" in toolResult && toolResult.artifactId ? { artifactId: toolResult.artifactId } : {}),
          });
          messages.push(message);
          services.emit({ type: "message_committed", message });
          services.emit({ type: "tool_completed", callId: call.id, toolName: call.name, result: toolResult });
          }
        }
        services.emit({ type: "turn_completed", turn, ...(usage ? { usage } : {}) });
        const steering = await services.steering();
        messages.push(...steering);
        if (steering.length === 0 && await services.afterBatch?.(signal)) return { status: "yielded", text, turns, reason: "verification_ready" };
        if (assistant.stopReason === "length" && assistant.toolCalls.length === 0 && steering.length === 0) {
          if (lengthRecoveries++ === 0) {
            const hint = await services.commit({ role: "user", text: "上一响应达到长度上限且没有可执行动作。请缩短推理，直接执行当前最小修改；不要重复长篇分析。仅允许一次截断恢复。", timestamp: Date.now() });
            messages.push(hint); continue;
          }
          result = { status: "failed", text, turns, error: "模型响应达到长度限制；请缩小任务或重新提交" };
          return result;
        }
        if (assistant.toolCalls.length === 0 && steering.length === 0 && assistant.stopReason !== "length") {
          result = { status: "completed", text, turns };
          return result;
        }
      }
      result = { status: "budget_exhausted", text, turns, reason: "turn_limit", error: "已达到最大轮次，任务可能尚未完成" };
    } catch (error) {
      result = {
        status: signal.aborted ? "aborted" : error instanceof ModelRequestBudgetError ? "budget_exhausted" : "failed", text, turns,
        error: this.options.redactor.text(errorText(error)),
        ...(error instanceof ContextCapacityError ? { reason: "context_capacity_exceeded" as const } : error instanceof ModelRequestBudgetError ? { reason: "model_budget" as const } : {}),
      };
    }
    return result;
  }
}

export function unresolvedCalls(messages: readonly ModelMessage[]): ToolCall[] {
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant") for (const call of message.toolCalls) pending.set(call.id, call);
    if (message.role === "tool_result") pending.delete(message.callId);
  }
  return [...pending.values()];
}
