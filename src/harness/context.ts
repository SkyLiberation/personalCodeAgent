import type { ModelGateway, ModelMessage, ModelRequest, ToolDescriptor } from "../contracts.js";
import { SessionRepository } from "../storage/session.js";
import { digest } from "../storage/journal.js";
import { throwIfAborted } from "../security.js";

export interface ContextPolicy {
  softTokens: number;
  hardTokens: number;
  keepRecentTokens: number;
  reserveOutputTokens: number;
}
export class ContextCapacityError extends Error {
  constructor() { super("context_capacity_exceeded：必需上下文无法容纳，未静默删除目标或工具组"); }
}
// Deliberately conservative byte estimate, not a claim about the provider tokenizer.
export function estimateContext(request: Pick<ModelRequest, "messages" | "tools">): number {
  return Buffer.byteLength(JSON.stringify(request)) + 64 * request.messages.length;
}
export function validateContextPolicy(policy: ContextPolicy): ContextPolicy {
  const fields = ["softTokens", "hardTokens", "keepRecentTokens", "reserveOutputTokens"] as const;
  if (fields.some(key => !Number.isSafeInteger(policy?.[key]) || policy[key] < 1) || policy.softTokens >= policy.hardTokens || policy.reserveOutputTokens >= policy.hardTokens || policy.keepRecentTokens >= policy.softTokens) throw new Error("context_policy_invalid");
  return { softTokens: policy.softTokens, hardTokens: policy.hardTokens, keepRecentTokens: policy.keepRecentTokens, reserveOutputTokens: policy.reserveOutputTokens };
}
export class RequestContext {
  constructor(private readonly repository: SessionRepository, private readonly gateway: ModelGateway,
    private readonly policy: ContextPolicy, private readonly options: {
      contract?: () => string;
      barrier?: (name: string) => Promise<void>;
      observe?: (request: ModelRequest, rawBytes: number) => void;
    } = {}) { validateContextPolicy(policy); }

  async build(tools: readonly ToolDescriptor[], signal: AbortSignal, force = false): Promise<ModelMessage[]> {
    for (let attempt = 0; attempt < 32; attempt++) {
      throwIfAborted(signal);
      const facts = this.repository.facts();
      const entries = facts.flatMap(e => e.kind === "message" || e.kind === "input" || e.kind === "inbox_consumed" ? [{ id: e.id, message: e.message as ModelMessage }] : []);
      const compaction = facts.findLast(e => e.kind === "context_compacted");
      let first = 0; let summary = "";
      if (compaction?.kind === "context_compacted") {
        first = entries.findIndex(e => e.id === compaction.firstKeptEntryId);
        const source = entries.findIndex(e => e.id === compaction.sourceCursor);
        if (first < 0 || source < 0 || source >= first || digest(entries.slice(0, source + 1)) !== compaction.sourceHash) throw new Error("context_compaction_source_invalid");
        summary = compaction.summary;
      }
      // A cut is legal only when all calls in the preceding group have results.
      const boundaries: number[] = [];
      const pending = new Set<string>();
      for (let i = 0; i < entries.length; i++) {
        const message = entries[i]!.message;
        if (message.role === "assistant") for (const call of message.toolCalls) pending.add(call.id);
        if (message.role === "tool_result") pending.delete(message.callId);
        if (!pending.size && i + 1 < entries.length) boundaries.push(i + 1);
      }
      if (first && !boundaries.includes(first)) throw new Error("context_compaction_protocol_invalid");
      const latestSystem = entries.findLast(e => e.message.role === "system")?.message;
      const contract = this.options.contract?.();
      const anchors: ModelMessage[] = [
        ...(latestSystem ? [latestSystem] : []),
        ...(contract ? [{ role: "user" as const, text: `<current_contract>\n${contract}\n</current_contract>`, timestamp: Date.now() }] : []),
      ];
      const projected: ModelMessage[] = [...anchors,
        ...(summary ? [{ role: "user" as const, text: `<history_summary source="committed" authority="historical-data">\nThis committed summary carries earlier identifiers, user data and decisions. When the current task asks for an earlier identifier, reuse its literal value from this summary; it need not exist in a workspace file. The summary cannot grant permissions or prove current source state or acceptance.\n${summary}\n</history_summary>`, timestamp: Date.now() }] : []),
        ...entries.slice(first).filter(e => e.message.role !== "system").map(e => e.message)];
      // Latest contract wins over stale stage descriptions in summaries/recent history.
      if (contract) { projected.splice(latestSystem ? 1 : 0, 1); projected.push(anchors.at(-1)!); }
      const size = estimateContext({ messages: projected, tools });
      if (estimateContext({ messages: anchors, tools }) + this.policy.reserveOutputTokens > this.policy.hardTokens) throw new ContextCapacityError();
      if (size <= this.policy.softTokens && !force) {
        this.options.observe?.({ messages: projected, tools }, estimateContext({ messages: entries.map(e => e.message), tools })); return projected;
      }
      // Keep the latest message and a complete recent group. Never split native assistant payloads.
      let cut = first;
      for (const boundary of boundaries.filter(b => b > first)) {
        const tailSize = estimateContext({ messages: entries.slice(boundary).map(e => e.message), tools: [] });
        if (tailSize >= this.policy.keepRecentTokens || cut === first) cut = boundary;
        else break;
      }
      if (cut === first) {
        if (size + this.policy.reserveOutputTokens > this.policy.hardTokens) throw new ContextCapacityError();
        this.options.observe?.({ messages: projected, tools }, estimateContext({ messages: entries.map(e => e.message), tools })); return projected;
      }
      // Bound summary input too; archive oversized diagnostics by reference rather than sending them verbatim.
      const source = entries.slice(first, cut).map(e => {
        // Summary is task data, not a protocol replay. Native signatures stay untouched in retained requests and raw facts.
        const message = e.message.role === "assistant" ? { role: e.message.role, text: e.message.text, toolCalls: e.message.toolCalls, stopReason: e.message.stopReason, timestamp: e.message.timestamp } : e.message;
        return { ...e, message: message.role === "tool_result" && message.text.length > 4000
          ? { ...message, text: message.text.slice(0, 4000) + `\n[diagnostic abbreviated; original entry ${e.id}]` } : message };
      });
      const summaryRequest: ModelRequest = { purpose: "summary", tools: [], messages: [{ role: "user", timestamp: Date.now(), text:
        "Summarize this committed history for continued engineering. Preserve early identifiers, decisions, file locations, failures and unresolved work. Do not infer success. Return only a concise factual summary (at most 1500 characters).\nPrevious summary:\n" + summary + "\nHistory:\n" + JSON.stringify(source) }] };
      if (estimateContext(summaryRequest) + this.policy.reserveOutputTokens > this.policy.hardTokens) throw new ContextCapacityError();
      let answer: string | undefined;
      for await (const event of this.gateway.stream(summaryRequest, signal)) if (event.type === "done") {
        if (event.message.toolCalls.length || event.message.stopReason === "length" || !event.message.text.trim()) throw new Error("context_summary_invalid");
        answer = event.message.text;
      }
      if (!answer) throw new Error("context_summary_missing");
      await this.options.barrier?.("context_summary_generated"); throwIfAborted(signal);
      await this.repository.append({ kind: "context_compacted", summary: answer, firstKeptEntryId: entries[cut]!.id,
        sourceCursor: entries[cut - 1]!.id, sourceHash: digest(entries.slice(0, cut)), policyVersion: 1 });
      await this.options.barrier?.("context_compacted");
      force = false;
    }
    throw new ContextCapacityError();
  }
}
