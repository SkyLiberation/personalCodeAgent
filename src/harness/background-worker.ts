import { readFile, open, rename, access } from "node:fs/promises";
import { join } from "node:path";
import { createExecutionHost } from "../platform/host.js";
import { digest } from "../storage/journal.js";
import type { BackgroundReceipt } from "./background.js";

const directory = process.argv[2]!;
const request = JSON.parse(await readFile(join(directory, "request.json"), "utf8")) as { operationId: string; commandHash: string; command: { executable: string; args: string[]; cwd: string; timeoutMs: number } };
if (digest(request.command) !== request.commandHash) throw new Error("background_command_hash_mismatch");
const host = await createExecutionHost(); const lease = await host.acquire(join(directory, "owner.lease"));
try { await access(join(directory, "receipt.json")); await lease.close(); await host.close(); process.exit(0); } catch { /* No settled receipt. */ }
const abort = new AbortController(); const poll = setInterval(() => { void access(join(directory, "cancel")).then(() => abort.abort(), () => undefined); }, 100);
let receipt: BackgroundReceipt;
try {
  await host.restoreProcessGroups(join(directory, "process-groups.jsonl"));
  const result = await host.exec(request.command.executable, request.command.args, request.command.cwd, abort.signal, request.command.timeoutMs);
  receipt = { operationId: request.operationId, commandHash: request.commandHash, status: result.exitCode === 0 && !result.timedOut ? "completed" : "failed", result };
} catch (error) { receipt = { operationId: request.operationId, commandHash: request.commandHash, status: "failed", error: error instanceof Error ? error.message : String(error) }; }
finally { clearInterval(poll); }
const file = await open(join(directory, "receipt.tmp"), "wx", 0o600);
try { await file.writeFile(JSON.stringify({ ...receipt, checksum: digest(receipt) })); await file.sync(); } finally { await file.close(); }
await rename(join(directory, "receipt.tmp"), join(directory, "receipt.json"));
await lease.close(); await host.close();
