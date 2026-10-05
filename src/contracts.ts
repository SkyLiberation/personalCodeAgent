export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantMessage {
  role: "assistant";
  text: string;
  toolCalls: ToolCall[];
  stopReason: "stop" | "tool_calls" | "length";
  timestamp: number;
  // Only the model adapter interprets this payload (including thinking signatures).
  providerData?: { adapter: "pi-ai"; message: unknown };
}

export type ModelMessage =
  | { role: "system" | "user"; text: string; timestamp: number }
  | AssistantMessage
  | {
      role: "tool_result";
      callId: string;
      toolName: string;
      text: string;
      isError: boolean;
      timestamp: number;
    };

export interface ToolDescriptor {
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly ToolDescriptor[];
  purpose?: "execution" | "summary" | "replan" | "retry";
}

export type ModelEvent =
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "done"; message: AssistantMessage; usage?: Usage };

export interface ModelGateway {
  // One stream is one provider attempt; retries must re-enter request admission.
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ToolResult {
  text: string;
  isError: boolean;
  code?: string;
  artifactId?: string;
}

export interface ToolContext {
  signal: AbortSignal;
  callId: string;
  operationId?: string;
  exec?(executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; output: string; exitCode: number; timedOut: boolean }>;
  reportProgress(text: string): Promise<void>;
}

export interface AgentTool extends ToolDescriptor {
  parallelSafe?: boolean;
  version?: string;
  effect: "read" | "write" | "process";
  replay: "safe" | "never";
  validate(input: unknown): unknown;
  execute(args: unknown, context: ToolContext): Promise<ToolResult>;
}
export type ToolPolicyDecision = { action: "allow" } | { action: "deny" | "confirm"; reason: string };
export interface ToolPolicyContext { tool: ToolDescriptor & { effect: AgentTool["effect"]; replay: AgentTool["replay"] }; arguments: unknown; callId: string; signal: AbortSignal }

export type RunStatus = "completed" | "yielded" | "aborted" | "failed" | "budget_exhausted";

export type AgentEventData =
  | { type: "run_started" }
  | { type: "turn_started"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "message_committed"; message: ModelMessage }
  | { type: "tool_started"; call: ToolCall }
  | { type: "tool_progress"; callId: string; text: string }
  | { type: "tool_completed"; callId: string; toolName: string; result: ToolResult }
  | { type: "turn_completed"; turn: number; usage?: Usage }
  | { type: "run_settled"; status: RunStatus; error?: string };

export type AgentEvent = AgentEventData & {
  sessionId: string;
  runId: string;
  sequence: number;
  timestamp: number;
};

export interface RunResult {
  status: RunStatus;
  text: string;
  turns: number;
  error?: string;
  reason?: "turn_limit" | "verification_ready" | "context_capacity_exceeded" | "model_budget";
}
