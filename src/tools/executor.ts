import type { AgentTool, ToolCall, ToolContext, ToolDescriptor, ToolResult, ToolPolicyContext, ToolPolicyDecision } from "../contracts.js";
import { errorText, SecretRedactor, throwIfAborted } from "../security.js";

export interface ExecutionHooks {
  intent(call: ToolCall, replay: "safe" | "never"): Promise<void | string>;
  afterEffect?(call: ToolCall): Promise<void>;
  exec?: NonNullable<ToolContext["exec"]>;
  progress(callId: string, text: string): Promise<void>;
  artifact(text: string): Promise<string>;
  policy?(call: ToolCall, decision: ToolPolicyDecision): Promise<void>;
}
/** Rejected before intent/reservation; ordinary model mistakes may be corrected. */
export class ToolPreparationError extends Error {}

export class ToolExecutor {
  private readonly tools: Map<string, AgentTool>;

  constructor(
    tools: readonly AgentTool[],
    private readonly options: {
      readonly?: boolean;
      noShell?: boolean;
      maxOutputChars?: number;
      redactor?: SecretRedactor;
      policy?: (context: ToolPolicyContext) => Promise<ToolPolicyDecision>;
      confirm?: (context: ToolPolicyContext, reason: string) => Promise<boolean>;
    } = {},
  ) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    if (this.tools.size !== tools.length) throw new Error("工具名不能重复");
  }

  private allowed(tool: AgentTool): boolean {
    return !(this.options.readonly && tool.effect !== "read") && !(this.options.noShell && tool.effect === "process");
  }

  descriptors(): ToolDescriptor[] {
    return [...this.tools.values()].filter((tool) => this.allowed(tool)).map(({ name, description, parameters }) => ({
      name, description, parameters,
    }));
  }
  parallelSafe(call: ToolCall): boolean {
    const tool = this.tools.get(call.name);
    return !!tool && this.allowed(tool) && tool.effect === "read" && tool.replay === "safe" && tool.parallelSafe === true;
  }

  async execute(call: ToolCall, signal: AbortSignal, hooks: ExecutionHooks): Promise<ToolResult> {
    throwIfAborted(signal);
    const tool = this.tools.get(call.name);
    if (!tool) return { text: `未知工具：${call.name}`, isError: true, code: "unknown_tool" };
    if (!this.allowed(tool)) return { text: `当前策略禁用工具：${call.name}`, isError: true, code: "policy_denied" };
    let args: unknown;
    try {
      args = tool.validate(call.arguments);
    } catch (error) {
      return { text: `参数验证失败：${errorText(error)}`, isError: true, code: "invalid_arguments" };
    }
    if (this.options.policy) {
      const context: ToolPolicyContext = { tool, arguments: args, callId: call.id, signal };
      let decision = await this.options.policy(context);
      if (decision.action === "confirm") {
        const allowed = await this.options.confirm?.(context, decision.reason) ?? false;
        decision = allowed ? { action: "allow" } : { action: "deny", reason: decision.reason };
      }
      throwIfAborted(signal); await hooks.policy?.(call, decision);
      if (decision.action !== "allow") return { text: `policy_denied: ${decision.reason}`, isError: true, code: "policy_denied" };
    }
    // A persistence failure must stop the run before any side effect happens.
    let operationId: void | string;
    try { operationId = await hooks.intent({ ...call, arguments: args }, tool.replay); }
    catch (error) {
      if (error instanceof ToolPreparationError) return { text: error.message, isError: true, code: "tool_precondition" };
      throw error;
    }
    throwIfAborted(signal);
    let result: ToolResult;
    try {
      const context: ToolContext = {
        signal,
        callId: call.id,
        ...(operationId ? { operationId } : {}),
        ...(hooks.exec && tool.effect === "process" ? { exec: hooks.exec } : {}),
        reportProgress: async (text) => hooks.progress(call.id, this.options.redactor?.text(text) ?? text),
      };
      result = await tool.execute(args, context);
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      result = { text: errorText(error), isError: true, code: "execution_error" };
    }
    result = this.options.redactor?.json(result) ?? result;
    await hooks.afterEffect?.(call);
    const limit = this.options.maxOutputChars ?? 30_000;
    if (result.text.length > limit) {
      const artifactId = await hooks.artifact(result.text);
      return { ...result, artifactId, text: `${result.text.slice(0, limit)}\n[输出已截断，完整输出附件：${artifactId}]` };
    }
    return result;
  }
}
