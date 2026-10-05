import {
  createModels,
  type AssistantMessage as PiAssistantMessage,
  type Message as PiMessage,
  type Model,
  type Tool,
} from "@earendil-works/pi-ai";
import { xiaomiTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn";
import type { TSchema } from "typebox";
import type { AgentConfig } from "../config.js";
import type { ModelEvent, ModelGateway, ModelMessage, ModelRequest } from "../contracts.js";
import { abortError, SecretRedactor, throwIfAborted } from "../security.js";

export function toPiMessage(message: ModelMessage): PiMessage {
  if (message.role === "system" || message.role === "user") {
    return { role: message.role, content: message.text, timestamp: message.timestamp };
  }
  if (message.role === "tool_result") {
    return {
      role: "toolResult",
      toolCallId: message.callId,
      toolName: message.toolName,
      content: [{ type: "text", text: message.text }],
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  if (message.role !== "assistant") throw new Error("不支持的模型消息");
  const native = message.providerData?.message;
  if (native && typeof native === "object" && "role" in native && native.role === "assistant" &&
      "content" in native && Array.isArray(native.content)) {
    // Keep pi's thinking blocks/signatures, tool arguments and provider metadata intact.
    return native as PiAssistantMessage;
  }
  throw new Error("assistant 消息缺少 pi-ai 原始数据，无法可靠恢复推理上下文");
}

export class PiModelGateway implements ModelGateway {
  private readonly models = createModels();
  private readonly model: Model<"openai-completions">;
  private readonly redactor: SecretRedactor;

  constructor(private readonly config: AgentConfig) {
    this.models.setProvider(xiaomiTokenPlanCnProvider());
    const model = this.models.getModel("xiaomi-token-plan-cn", config.modelId);
    if (!model) throw new Error(`pi-ai 的 MiMo 目录没有模型 ${config.modelId}`);
    this.model = { ...model, baseUrl: config.baseUrl } as Model<"openai-completions">;
    const maxOutputTokens = config.maxOutputTokens ?? 8192;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > model.maxTokens) {
      throw new Error(`maxOutputTokens 必须为 1 到 ${model.maxTokens} 之间的整数`);
    }
    this.redactor = new SecretRedactor([config.apiKey]);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    throwIfAborted(signal);
    const stream = this.models.streamSimple(this.model, {
      messages: request.messages.map(toPiMessage),
      tools: request.tools.map((tool): Tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as TSchema,
      })),
    }, {
      apiKey: this.config.apiKey,
      headers: { "api-key": this.config.apiKey },
      signal,
      maxTokens: this.config.maxOutputTokens ?? 8192,
      maxRetries: 0,
      timeoutMs: this.config.requestTimeoutMs,
      ...(this.config.thinking === "off" ? {} : { reasoning: this.config.thinking }),
    });

    for await (const event of stream) {
      throwIfAborted(signal);
      if (event.type === "text_delta") yield { type: "text_delta", delta: event.delta };
      if (event.type === "thinking_delta") yield { type: "thinking_delta", delta: event.delta };
      if (event.type === "error") {
        if (signal.aborted || event.reason === "aborted") throw abortError();
        throw new Error(this.redactor.text(event.error.errorMessage ?? "MiMo 请求失败"));
      }
    }
    const message = await stream.result();
    if (message.stopReason === "aborted") throw abortError();
    if (message.stopReason === "error") {
      throw new Error(this.redactor.text(message.errorMessage ?? "MiMo 请求失败"));
    }
    yield {
      type: "done",
      message: {
        role: "assistant",
        text: message.content.filter((block) => block.type === "text").map((block) => block.text).join(""),
        toolCalls: message.content.filter((block) => block.type === "toolCall").map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        stopReason: message.stopReason === "length" ? "length" :
          message.content.some((block) => block.type === "toolCall") ? "tool_calls" : "stop",
        timestamp: message.timestamp,
        providerData: { adapter: "pi-ai", message },
      },
      usage: { inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, outputTokens: message.usage.output },
    };
  }
}
