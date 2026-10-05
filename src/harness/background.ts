import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, open, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../storage/journal.js";
import { createExecutionHost } from "../platform/host.js";
import type { ExecutionHost, ProcessResult } from "../platform/host.js";

export interface BackgroundReceipt { operationId: string; commandHash: string; status: "completed" | "failed"; result?: ProcessResult; error?: string }
/** A separate owner executes a bounded command and fsyncs its result; waiters never re-dispatch it. */
export class BackgroundTasks {
  constructor(readonly directory: string, private readonly host: ExecutionHost) {}
  async start(command: { executable: string; args: string[]; cwd: string; timeoutMs: number }, options: { operationId?: string } = {}): Promise<{ operationId: string; commandHash: string }> {
    if (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1) throw new Error("background_timeout_required");
    const operationId = options.operationId ?? randomUUID(); if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("background_id_invalid");
    const commandHash = digest(command); const path = join(this.directory, operationId); await mkdir(path, { recursive: true });
    const lease = await this.host.acquire(join(path, "submission.lease"));
    try {
      const existing = await readFile(join(path, "request.json"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
      if (existing) { if ((JSON.parse(existing) as { commandHash: string }).commandHash !== commandHash) throw new Error("background_operation_conflict"); return { operationId, commandHash }; }
      const file = await open(join(path, "request.json"), "wx", 0o600); try { await file.writeFile(JSON.stringify({ operationId, commandHash, command })); await file.sync(); } finally { await file.close(); }
      let worker = fileURLToPath(new URL("./background-worker.js", import.meta.url));
      const built = await access(worker).then(() => true, () => false);
      if (!built) worker = fileURLToPath(new URL("./background-worker.ts", import.meta.url));
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
      const child = spawn(process.execPath, [...(built ? [] : ["--import", "tsx"]), worker, path], { detached: true, stdio: "ignore", env });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
      return { operationId, commandHash };
    } finally { await lease.close(); }
  }
  async wait(operationId: string, options: { commandHash: string; signal: AbortSignal; timeoutMs: number }): Promise<BackgroundReceipt> {
    if (!/^[a-f0-9-]{36}$/.test(operationId) || options.timeoutMs < 1) throw new Error("background_wait_invalid");
    const path = join(this.directory, operationId); const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      options.signal.throwIfAborted(); const receipt = await readFile(join(path, "receipt.json"), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
      if (receipt) { const parsed = JSON.parse(receipt) as BackgroundReceipt & { checksum: string }; const { checksum, ...record } = parsed;
        if (checksum !== digest(record) || parsed.operationId !== operationId || parsed.commandHash !== options.commandHash) throw new Error("background_receipt_mismatch"); return parsed; }
      if (Date.now() >= deadline) throw new Error("background_wait_timeout: no durable receipt; command not replayed");
      await new Promise(r => setTimeout(r, 30));
    }
  }
  async cancel(operationId: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("background_id_invalid");
    const file = await open(join(this.directory, operationId, "cancel"), "a", 0o600); try { await file.sync(); } finally { await file.close(); }
  }
  async recover(operationId: string): Promise<"running" | "settled" | "effect_unknown"> {
    if (!/^[a-f0-9-]{36}$/.test(operationId)) throw new Error("background_id_invalid");
    const path = join(this.directory, operationId); const host = await createExecutionHost();
    try {
      let lease; try { lease = await host.acquire(join(path, "owner.lease")); } catch (error) { if (String(error).includes("busy")) return "running"; throw error; }
      try {
        const existing = await readFile(join(path, "receipt.json"), "utf8").catch(() => undefined); if (existing) return "settled";
        const request = JSON.parse(await readFile(join(path, "request.json"), "utf8")) as { operationId: string; commandHash: string };
        await host.restoreProcessGroups(join(path, "process-groups.jsonl"));
        const receipt: BackgroundReceipt = { operationId, commandHash: request.commandHash, status: "failed", error: "effect_unknown: owner exited before durable result; command not replayed" };
        const file = await open(join(path, "receipt.json"), "wx", 0o600); try { await file.writeFile(JSON.stringify({ ...receipt, checksum: digest(receipt) })); await file.sync(); } finally { await file.close(); }
        return "effect_unknown";
      } finally { await lease.close(); }
    } finally { await host.close(); }
  }
}
