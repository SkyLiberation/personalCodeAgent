import type {
  AgentEventData, AssistantMessage, ModelGateway, ModelMessage, RunResult, ToolCall, Usage,
} from "../contracts.js";
import type { ExecutionHooks, ToolExecutor } from "../tools/executor.js";
import { errorText, SecretRedactor, throwIfAborted } from "../security.js";

export interface RuntimeServices extends ExecutionHooks {
  commit(message: ModelMessage): Promise<ModelMessage>;
  emit(event: AgentEventData): void;
  steering(): Promise<ModelMessage[]>;
  beforeModel?(): Promise<void>;
}

export class AgentRuntime {
  constructor(
    private readonly gateway: ModelGateway,
    private readonly executor: ToolExecutor,
    private readonly options: { maxTurns: number; redactor: SecretRedactor },
  ) {}

  async run(history: readonly ModelMessage[], signal: AbortSignal, services: RuntimeServices): Promise<RunResult> {
    const messages = [...history];
    let turns = 0;
    let text = "";
    let result: RunResult;
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
          for await (const event of this.gateway.stream({ messages, tools: this.executor.descriptors() }, signal)) {
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
        for (const call of assistant.toolCalls) {
          throwIfAborted(signal);
          services.emit({ type: "tool_started", call });
          const toolResult = assistant.stopReason === "length"
            ? { text: "模型响应被截断，未执行工具；请重新生成完整参数。", isError: true, code: "truncated_response" }
            : await this.executor.execute(call, signal, services);
          const message = await services.commit({
            role: "tool_result", callId: call.id, toolName: call.name,
            text: toolResult.text, isError: toolResult.isError, timestamp: Date.now(),
          });
          messages.push(message);
          services.emit({ type: "message_committed", message });
          services.emit({ type: "tool_completed", callId: call.id, toolName: call.name, result: toolResult });
        }
        services.emit({ type: "turn_completed", turn, ...(usage ? { usage } : {}) });
        const steering = await services.steering();
        messages.push(...steering);
        if (assistant.stopReason === "length" && assistant.toolCalls.length === 0 && steering.length === 0) {
          result = { status: "failed", text, turns, error: "模型响应达到长度限制；请缩小任务或重新提交" };
          return result;
        }
        if (assistant.toolCalls.length === 0 && steering.length === 0 && assistant.stopReason !== "length") {
          result = { status: "completed", text, turns };
          return result;
        }
      }
      result = { status: "budget_exhausted", text, turns, error: "已达到最大轮次，任务可能尚未完成" };
    } catch (error) {
      result = {
        status: signal.aborted ? "aborted" : "failed", text, turns,
        error: this.options.redactor.text(errorText(error)),
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
