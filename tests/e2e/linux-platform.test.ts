import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LinuxHost } from "../../src/platform/linux.js";
import { seal } from "../../src/storage/journal.js";

async function directory() {
  const root = join(process.cwd(), ".codeagent", "e2e"); await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "linux-platform-"));
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) { const value = await read(); if (value !== undefined) return value; if (Date.now() > deadline) throw new Error("process observation timed out"); await new Promise(r => setTimeout(r, 30)); }
}
async function active(pid: number): Promise<boolean> {
  const value = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return !!value && value.slice(value.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
}
async function worker(path: string, journal: string) {
  const child = fork(new URL("./platform-worker.ts", import.meta.url), [path, journal], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const first = await new Promise<{ type: string }>((resolve, reject) => { child.once("message", m => resolve(m as { type: string })); child.once("error", reject); });
  assert.equal(first.type, "owned");
  return child;
}
async function kill(child: ReturnType<typeof fork>) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await done;
}

test("LX-01: Linux kernel lease rejects stale takeover; owner crash stops actual parent and child before reuse", { timeout: 30_000 }, async context => {
  const root = await directory(); context.diagnostic(`Artifacts: ${root}`);
  const path = join(root, "owner.lease"); const journal = join(root, "process-groups.jsonl"); const child = await worker(path, journal);
  const host = await LinuxHost.create(); context.after(async () => { await kill(child); await host.close(); });
  await writeFile(join(root, "metadata.json"), '{"timestamp":0}');
  await assert.rejects(host.acquire(path), /busy/, "旧元数据不能夺取存活的内核执行权");
  const file = join(root, "pids.json"); child.send({ type: "run", file });
  const pids = await until(() => readFile(file, "utf8").then(v => JSON.parse(v) as { parent: number; child: number }).catch(() => undefined));
  await kill(child);
  const lease = await until(() => host.acquire(path).catch(error => { if (String(error).includes("busy")) return undefined; throw error; }));
  assert.equal(await active(pids.parent) || await active(pids.child), false, "宿主退出后先停止实际父子进程再释放 lease");
  await host.restoreProcessGroups(journal); await lease.close();
  await writeFile(join(root, "evidence.json"), JSON.stringify({ status: "passed", pids, staleTakeoverRejected: true, effectsStoppedBeforeReuse: true }, null, 2));
});

test("LX-02: Linux abort, timeout and normal leader exit quiesce real descendants", { timeout: 30_000 }, async context => {
  const root = await directory(); context.diagnostic(`Artifacts: ${root}`); const host = await LinuxHost.create(); context.after(() => host.close());
  await host.restoreProcessGroups(join(root, "process-groups.jsonl"));
  for (const mode of ["abort", "timeout", "normal"] as const) {
    const file = join(root, `${mode}.json`); const abort = new AbortController();
    const script = `const fs=require('node:fs');const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(file)},JSON.stringify({parent:process.pid,child:c.pid}));${mode === "normal" ? "process.exit(0)" : "setInterval(()=>{},1000)"}`;
    const result = host.exec(process.execPath, ["-e", script], root, abort.signal, mode === "timeout" ? 500 : 10_000);
    // Observe rejections immediately while waiting for real process startup.
    const settled = result.then(value => ({ value }), error => ({ error: String(error) }));
    const pids = await until(() => readFile(file, "utf8").then(v => JSON.parse(v) as { parent: number; child: number }).catch(() => undefined));
    if (mode === "abort") abort.abort();
    const observed = await settled;
    assert.ok(mode === "abort" ? "error" in observed : "value" in observed && observed.value.timedOut === (mode === "timeout"), "取消/超时保留公开结果语义");
    if ("value" in observed) assert.ok(mode === "normal" ? observed.value.exitCode === 0 : observed.value.exitCode !== 0, "超时杀死进程不能被子进程收割竞态伪装成 exitCode=0");
    assert.equal(await active(pids.parent) || await active(pids.child), false, "各出口都必须清理真实子进程");
  }
  await writeFile(join(root, "evidence.json"), JSON.stringify({ status: "passed", modes: ["abort", "timeout", "normal"], descendantsStopped: true }, null, 2));
});

test("LX-03: dead Linux bridge is recovered by recorded identity; identity mismatch blocks without killing", { timeout: 30_000 }, async context => {
  const root = await directory(); context.diagnostic(`Artifacts: ${root}`);
  const path = join(root, "owner.lease"); const journal = join(root, "process-groups.jsonl"); const child = await worker(path, journal);
  const host = await LinuxHost.create(); context.after(async () => { await kill(child); await host.close(); });
  let bridge: number | undefined;
  for (const name of (await readdir("/proc")).filter(name => /^\d+$/.test(name))) {
    const stat = await readFile(`/proc/${name}/stat`, "utf8").catch(() => "");
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (parent === child.pid && (await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "")).includes("linux-host.py")) bridge = Number(name);
  }
  assert.ok(bridge, "由公开 OS 进程信息定位实际 bridge");
  const file = join(root, "pids.json"); child.send({ type: "run", file });
  const pids = await until(() => readFile(file, "utf8").then(v => JSON.parse(v) as { parent: number; child: number }).catch(() => undefined));
  const original = await readFile(journal, "utf8"); process.kill(bridge, "SIGKILL");
  const lease = await until(() => host.acquire(path).catch(error => { if (String(error).includes("busy")) return undefined; throw error; }));
  const { checksum: _, previousHash: __, ...record } = JSON.parse(original.trim()) as Record<string, unknown>;
  await writeFile(journal, JSON.stringify(seal({ ...record, starttime: "0" }, "")) + "\n");
  await assert.rejects(host.restoreProcessGroups(journal), /process_state_unknown/, "存活组身份不匹配时拒绝恢复");
  assert.equal(await active(pids.parent), true, "身份不明不能盲杀实际进程");
  await writeFile(journal, original); await host.restoreProcessGroups(journal);
  assert.equal(await active(pids.parent) || await active(pids.child), false, "身份确认后恢复清理旧进程组");
  const result = await host.exec(process.execPath, ["-e", "console.log('resumed')"], root, context.signal, 3000);
  assert.equal(result.stdout.trim(), "resumed", "清理后才允许新执行"); await lease.close();
  await writeFile(join(root, "evidence.json"), JSON.stringify({ status: "passed", pids, mismatchedIdentityBlocked: true, confirmedIdentityRecovered: true }, null, 2));
});

test("LX-04: process journal write failure keeps the target behind its startup gate", { timeout: 30_000 }, async context => {
  const root = await directory(); context.diagnostic(`Artifacts: ${root}`); const host = await LinuxHost.create(); context.after(() => host.close());
  await host.restoreProcessGroups(join(root, "missing-directory", "process-groups.jsonl"));
  const marker = join(root, "target-effect.txt");
  await assert.rejects(host.exec(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'effect')`], root, context.signal, 3000), /ENOENT/);
  assert.equal(await readFile(marker, "utf8").catch(() => undefined), undefined, "进程日志持久化失败时真实目标程序不能启动副作用");
  await writeFile(join(root, "evidence.json"), JSON.stringify({ status: "passed", journalFailure: "ENOENT", targetEffectAbsent: true }, null, 2));
});
