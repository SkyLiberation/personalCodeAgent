import { fork } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskState } from "../../src/task-contracts.js";
export function phase2Worker(root: string, mode: string, arg: string, barrier = "") {
  const child = fork(new URL("./phase2-worker.ts", import.meta.url), [mode, root, arg, barrier], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const mailbox: Record<string, unknown>[] = []; let wake: (() => void) | undefined;
  let output = "", errors = ""; child.stdout?.setEncoding("utf8").on("data", d => output += d); child.stderr?.setEncoding("utf8").on("data", d => errors += d);
  child.on("message", message => { mailbox.push(message as Record<string, unknown>); wake?.(); }); child.on("exit", () => wake?.());
  return { child, async wait(type: string): Promise<Record<string, unknown>> { for (;;) { const index = mailbox.findIndex(m => type.split("|").includes(String(m.type))); if (index >= 0) return mailbox.splice(index, 1)[0]!; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${errors}`); await new Promise<void>(r => { wake = r; }); } }, async close() { if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise<void>(r => child.once("exit", () => r())); } await writeFile(join(root, `${mode}-${Date.now()}.events.jsonl`), output); await writeFile(join(root, `${mode}-${Date.now()}.stderr.log`), errors); } };
}
export async function phase2Resume(root: string, id: string): Promise<TaskState> { const w = phase2Worker(root, "resume", id); try { return (await w.wait("result")).state as TaskState; } finally { await w.close(); } }
