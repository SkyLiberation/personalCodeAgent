import { readFile } from "node:fs/promises";
import type { AgentTool, ToolResult } from "../contracts.js";
import { LocalEnvironment } from "../environment/local.js";
import { SessionRepository, type ToolIntent, type SessionEntry } from "../storage/session.js";
import { digest } from "../storage/journal.js";
import { hash } from "./verifier.js";
import { TaskBlockedError } from "./task-errors.js";
import { errorText } from "../security.js";

export type RecoveryObservation = { kind: "unknown" } | { kind: "receipt"; operationId: string; callId: string; result: ToolResult; receipt: unknown };
export type ToolRecoveryAdapter = (intent: ToolIntent) => Promise<RecoveryObservation>;

export async function recoverTools(repository: SessionRepository, environment: LocalEnvironment, tools: AgentTool[], adapters: Record<string, ToolRecoveryAdapter> = {}): Promise<Record<string, unknown>[]> {
  const facts = repository.facts(); const unresolved: { assistantEntryId: string; call: import("../contracts.js").ToolCall }[] = [];
  for (const entry of facts) {
    if (entry.kind !== "message") continue;
    if (entry.message.role === "assistant") for (const call of entry.message.toolCalls) unresolved.push({ assistantEntryId: entry.id, call });
    if (entry.message.role === "tool_result") { const callId = entry.message.callId; const at = unresolved.findLastIndex(item => item.call.id === callId); if (at >= 0) unresolved.splice(at, 1); }
  }
  const report: Record<string, unknown>[] = [];
  for (const item of unresolved) {
    const entry = facts.find(e => e.kind === "tool_intent" && e.assistantEntryId === item.assistantEntryId && e.call.id === item.call.id);
    const intent = entry?.kind === "tool_intent" ? entry as ToolIntent & SessionEntry : undefined;
    let classification = "not_started"; let evidence: unknown = { assistantEntryId: item.assistantEntryId, noIntent: true };
    let result: ToolResult = { text: "恢复核查：原工具未获得执行许可，未启动。", isError: true };
    const prior = facts.find(e => e.kind === "tool_recovery" && e.assistantEntryId === item.assistantEntryId && e.callId === item.call.id);
    if (prior?.kind === "tool_recovery") { result = prior.result; classification = prior.classification; evidence = prior.evidenceHash; }
    else if (intent) {
      if (!intent.operationId || !intent.toolVersion) throw new TaskBlockedError("effect_unknown", `${item.call.name} 缺少稳定操作身份`);
      const tool = tools.find(t => t.name === item.call.name);
      if (!tool || (tool.version ?? "1") !== intent.toolVersion) throw new TaskBlockedError("effect_unknown", `工具 ${item.call.name} 版本不匹配`);
      const adapter = adapters[item.call.name];
      if (adapter) {
        let observation: RecoveryObservation;
        try { observation = await adapter(intent); }
        catch (error) { throw new TaskBlockedError("effect_unknown", `${item.call.name} 回执查询不可用：${errorText(error)}`, { cause: error }); }
        if (observation.kind !== "receipt" || observation.operationId !== intent.operationId || observation.callId !== item.call.id) throw new TaskBlockedError("effect_unknown", `${item.call.name} 缺少匹配回执`);
        classification = "confirmed_receipt"; evidence = observation.receipt; result = observation.result;
      } else if (["write", "edit"].includes(item.call.name) && intent.postcondition && intent.toolVersion === "1") {
        let content: Buffer;
        try { content = await readFile(await environment.path(intent.postcondition.path)); }
        catch (error) { throw new TaskBlockedError("effect_unknown", `${item.call.name} 当前文件无法核查：${errorText(error)}`, { cause: error }); }
        if (hash(content) !== intent.postcondition.sha256) throw new TaskBlockedError("effect_unknown", `${item.call.name} 当前文件与预期摘要不同`);
        classification = "observed_postcondition"; evidence = intent.postcondition; result = { text: "恢复后只读核查：单文件当前内容符合 intent 的预期摘要；未重放原写入，不推断完整历史回执。", isError: false };
      } else if (intent.replay === "safe" && tool.effect === "read") {
        classification = "read_current_state"; result = await tool.execute(tool.validate(item.call.arguments), { callId: item.call.id, operationId: intent.operationId, signal: new AbortController().signal, reportProgress: async () => undefined });
        result.text = "恢复后的当前读取：\n" + result.text; evidence = { currentRead: true };
      } else throw new TaskBlockedError("effect_unknown", `${item.call.name} 副作用尚未确认`);
    }
    const operationId = intent?.operationId ?? `not-started-${item.assistantEntryId}-${item.call.id}`;
    if (!prior) await repository.append({ kind: "tool_recovery", operationId, assistantEntryId: item.assistantEntryId, callId: item.call.id, classification, result: { text: result.text, isError: result.isError }, evidenceHash: digest(evidence) });
    await repository.appendMessage({ role: "tool_result", callId: item.call.id, toolName: item.call.name, text: result.text, isError: result.isError, timestamp: Date.now() });
    report.push({ operationId, classification, evidenceHash: digest(evidence) });
  }
  return report;
}
