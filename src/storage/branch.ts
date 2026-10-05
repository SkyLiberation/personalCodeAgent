import { SessionRepository } from "./session.js";
import { unresolvedCalls } from "../runtime/agent.js";
import type { ExecutionHost } from "../platform/host.js";
import { SecretRedactor } from "../security.js";

/** New independent journal, immutable ancestry; no process intents/effects are cloned. */
export async function branchSession(source: SessionRepository, options: { directory: string; cursor?: string; host: ExecutionHost; redactor?: SecretRedactor }): Promise<SessionRepository> {
  const facts = source.facts(); const end = options.cursor ? facts.findIndex(f => f.id === options.cursor) : facts.length - 1;
  if (end < 0) throw new Error("branch_cursor_invalid");
  const messages = facts.slice(0, end + 1).flatMap(f => f.kind === "message" || f.kind === "input" || f.kind === "inbox_consumed" ? [f.message] : []);
  if (unresolvedCalls(messages).length) throw new Error("branch_unresolved_effects");
  const destination = await SessionRepository.open({ directory: options.directory, cwd: source.cwd, host: options.host, ...(options.redactor ? { redactor: options.redactor } : {}) });
  try {
    await destination.append({ kind: "branch_created", sourceSessionId: source.id, sourceCursor: facts[end]!.id });
    for (const message of messages) await destination.appendMessage(message);
    return destination;
  } catch (error) { await destination.close(); throw error; }
}
