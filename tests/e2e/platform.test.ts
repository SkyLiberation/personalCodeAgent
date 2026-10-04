import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WindowsHost } from "../../src/platform/windows.js";

test("LT-08B/C: OS lease survives stale metadata; host crash kills real parent and child", { skip: process.platform !== "win32", timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(process.cwd(), ".codeagent", "platform-"));
  const path = join(directory, "owner.lease");
  const worker = fork(new URL("./platform-worker.ts", import.meta.url), [path], { execArgv: ["--import", "tsx"], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const first = await new Promise<{ type: string }>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  assert.equal(first.type, "owned", "真实执行者持有内核锁");
  const host = await WindowsHost.create();
  worker.on("message", message => { if ((message as { type: string }).type === "run_error") console.error(message); });
  try {
    await writeFile(join(directory, "metadata.json"), '{"timestamp":0}');
    await assert.rejects(host.acquire(path), /busy/, "元数据过期不能夺取存活执行权");
    const file = join(directory, "pids.json");
    worker.send({ type: "run", file });
    let pids: { parent: number; child: number } | undefined;
    const deadline = Date.now() + 10_000;
    while (!pids && Date.now() < deadline) { pids = await readFile(file, "utf8").then(JSON.parse).catch(() => undefined); if (!pids) await new Promise(r => setTimeout(r, 50)); }
    assert.ok(pids, "工具真实父子进程已启动");
    worker.kill();
    await new Promise<void>(resolve => worker.once("exit", () => resolve()));
    let lease;
    while (!lease && Date.now() < deadline) { lease = await host.acquire(path).catch(() => undefined); if (!lease) await new Promise(r => setTimeout(r, 50)); }
    assert.ok(lease, "崩溃清理后自动取得同一内核锁");
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.equal(alive(pids.parent) || alive(pids.child), false, "取得执行权之前旧进程组已停止");
    await lease.close();
    await writeFile(join(directory, "evidence.json"), JSON.stringify({ status: "passed", scenario: "LT-08B/C kernel lease and crash cleanup", parent: pids.parent, child: pids.child, groupsStopped: true, recoveredLease: true }, null, 2));
    contextDiagnostic(directory);
  } finally { worker.kill(); await host.close(); }
});
function contextDiagnostic(directory: string): void { console.log(`Platform evidence: ${join(directory, "evidence.json")}`); }
