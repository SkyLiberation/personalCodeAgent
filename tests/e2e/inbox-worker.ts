import { writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, PiModelGateway, loadConfig, type ModelGateway } from "../../src/index.js";
const [mode, root, cwd, boundary = "", sessionId] = process.argv.slice(2) as [string, string, string, string, string | undefined];
const config = { ...loadConfig(), thinking: "off" as const }; const pi = new PiModelGateway(config);
const gateway: ModelGateway = { async *stream(request, signal) { await appendFile(join(root, "dispatch.jsonl"), JSON.stringify({ pid: process.pid, purpose: request.purpose, messages: request.messages }) + "\n"); yield* pi.stream(request, signal); } };
const session = await createAgentSession({ config, cwd, dataDirectory: join(root, "inbox"), durableInbox: true, gateway, ...(sessionId ? { sessionId } : {}), hooks: { barrier: async name => {
  if (name === boundary) { process.send?.({ type: "barrier", sessionId: session.id }); await new Promise<void>(resolve => process.once("message", () => resolve())); }
} } });
process.send?.({ type: "session", id: session.id });
session.subscribe(event => process.stdout.write(JSON.stringify(event) + "\n"));
try {
  if (mode === "start") await session.acceptInput("只使用 write 写入 lib/value.mts，实现 export function value():number{return 42}；然后结束。", "follow_up", { inputId: "durable-input" });
  else await session.resumeInputs();
  const result = await session.waitInput("durable-input"); await writeFile(join(root, "inbox-result.json"), JSON.stringify(result)); process.send?.({ type: "result", result });
} finally { await session.close(); }
