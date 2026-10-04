import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TaskRepository, sendTaskCommand, readTaskCommandResult, type TaskState } from "../../src/index.js";
import { quoteFixture } from "./quote-service-fixture.js";
import { valueFixture } from "./value-fixture.js";
import { scenario, saveSuiteReport, runProcess } from "./helpers.js";
import { fileURLToPath } from "node:url";

after(saveSuiteReport);
function worker(root: string, mode: string, arg: string, barrier = "") {
  const child = fork(new URL("./phase2-worker.ts", import.meta.url), [mode, root, arg, barrier], { execArgv: ["--import", "tsx"], windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const mailbox: Record<string, unknown>[] = []; let wake: (() => void) | undefined;
  let output = "", errors = ""; child.stdout?.setEncoding("utf8").on("data", d => output += d); child.stderr?.setEncoding("utf8").on("data", d => errors += d);
  child.on("message", message => { mailbox.push(message as Record<string, unknown>); wake?.(); });
  child.on("exit", () => wake?.());
  return { child, async wait(type: string): Promise<Record<string, unknown>> { for (;;) { const index = mailbox.findIndex(m => m.type === type); if (index >= 0) return mailbox.splice(index, 1)[0]!; if (child.exitCode !== null || child.signalCode !== null) throw new Error(`worker exited: ${errors}`); await new Promise<void>(r => { wake = r; }); } }, async close() { if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise<void>(r => child.once("exit", () => r())); } await writeFile(join(root, `${mode}-${Date.now()}.events.jsonl`), output); await writeFile(join(root, `${mode}-${Date.now()}.stderr.log`), errors); } };
}
async function resume(root: string, id: string): Promise<TaskState> { const w = worker(root, "resume", id); try { return (await w.wait("result")).state as TaskState; } finally { await w.close(); } }

test("LT-10 / LT-07B / LT-08A: pause at verified amount, change workspace, new process resumes real HTTP delivery", { timeout: 900_000 }, async context => {
  await scenario(context, "phase2-quote-resume", async ({ root, cwd }) => {
    const spec = await quoteFixture(root, cwd); const file = join(root, "task.json"); await writeFile(file, JSON.stringify(spec));
    const w = worker(root, "start", file, "milestone_verified"); context.after(() => w.close());
    const id = String((await w.wait("task")).id); await w.wait("barrier");
    const receipt = await sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command: { id: "pause-quote", type: "pause" } });
    assert.equal(receipt.status, "queued", "投递不能冒充暂停生效"); w.child.send({ type: "release" });
    const paused = (await w.wait("result")).state as TaskState; await w.close();
    assert.equal(paused.status, "paused"); assert.equal((await readTaskCommandResult({ taskId: id, dataDirectory: join(root, "state"), commandId: "pause-quote" }))?.status, "applied");
    await writeFile(join(cwd, "lib/quote.mts"), "export function quote(){return {subtotalCents:0,discountCents:0,totalCents:0};}\n");
    const result = await resume(root, id); await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
    assert.ok(result.status === "succeeded" && result.id === id && result.sessionId === paused.sessionId && result.runs > paused.runs && result.specVersion === 1 && result.evidence.filter(e => result.finalEvidenceIds.includes(e.id)).every(e => e.result === "passed"), "保留身份和用量，重验并实际修复后交付 HTTP 服务");
  });
});

test("LT-04A/B: effect receipt recovery blocks unknown, never repeats delivery", { timeout: 900_000 }, async context => {
  await scenario(context, "phase2-receipt-recovery", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd, 42, true); await writeFile(join(root, "receipt-enabled"), "true");
    const file = join(root, "task.json"); await writeFile(file, JSON.stringify(spec));
    const w = worker(root, "start", file, "tool_effect_completed:record-delivery"); context.after(() => w.close());
    const id = String((await w.wait("task")).id); await w.wait("barrier"); await w.close();
    await writeFile(join(root, "unknown"), "unknown");
    const before = await TaskRepository.read(join(root, "state"), id);
    const blocked = await resume(root, id);
    assert.ok(blocked.status === "blocked" && blocked.reason?.includes("effect_unknown") && blocked.runs === before.runs, "未知副作用在后续模型请求之前阻塞");
    const logs = await readFile(join(root, "audit.jsonl"), "utf8"); assert.equal(logs.trim().split("\n").length, 1);
    await unlink(join(root, "unknown")); const result = await resume(root, id); await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
    assert.equal(result.status, "succeeded"); assert.equal((await readFile(join(root, "audit.jsonl"), "utf8")).trim().split("\n").length, 1, "原调用不能重放");
    const durable = await TaskRepository.read(join(root, "state"), id); assert.ok(durable.runs >= 2 && durable.id === id);
  });
});

for (const barrier of ["run_planned", "input_accepted", "session_run_settled", "verification_artifact_written", "tool_effect_completed:write"]) {
  test(`LT-04C/D/F: real crash at ${barrier}`, { timeout: 300_000 }, async context => {
    await scenario(context, `phase2-crash-${barrier.replace(/:/g, "-")}`, async ({ root, cwd }) => {
      const spec = await valueFixture(root, cwd); const file = join(root, "task.json"); await writeFile(file, JSON.stringify(spec));
      const w = worker(root, "start", file, barrier); context.after(() => w.close());
      const id = String((await w.wait("task")).id); await w.wait("barrier"); await w.close();
      const before = await TaskRepository.read(join(root, "state"), id); const result = await resume(root, id);
      await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
      assert.ok(result.status === "succeeded" && result.id === id && result.sessionId === before.sessionId && result.runs >= before.runs, "恢复完成且身份、已预留用量保留");
      const facts = (await readFile(join(root, "state", "sessions", `${result.sessionId}.jsonl`), "utf8")).trim().split("\n").slice(1).map(line => JSON.parse(line));
      const inputs = facts.filter(f => f.kind === "input"); assert.equal(new Set(inputs.map(f => f.inputId)).size, inputs.length, "input ID 不重复接收");
      if (barrier.includes("write")) assert.ok(facts.some(f => f.kind === "tool_recovery" && f.classification === "observed_postcondition"), "默认文件工具只核对后置条件");
    });
  });
}

test("LT-07A / LT-08D: durable update wins final-success race; dedup and CAS preserve usage", { timeout: 300_000 }, async context => {
  await scenario(context, "phase2-contract-update", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); const file = join(root, "task.json"); await writeFile(file, JSON.stringify(spec));
    const w = worker(root, "start", file, "before_success"); context.after(() => w.close());
    const id = String((await w.wait("task")).id); await w.wait("barrier");
    const next = structuredClone(spec); const verifier = join(root, "control", "verify-43.mjs");
    await writeFile(verifier, (await readFile(spec.verifiers[0]!.args[0]!, "utf8")).replaceAll("42", "43"));
    next.outcome = next.outcome.replaceAll("42", "43"); next.verifiers[0]!.description = "真实导入 value() 必须为43"; next.verifiers[0]!.args = [verifier]; next.verifiers[0]!.trustedFiles[0] = verifier;
    const command = { id: "update-v2", type: "update" as const, spec: next, expectedVersion: 1 };
    await sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command });
    await sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command });
    await assert.rejects(sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command: { ...command, expectedVersion: 2 } }), /command_id_conflict/);
    // Only the first success barrier is held; release later barriers as they arrive.
    w.child.on("message", m => { if ((m as { type: string }).type === "barrier") w.child.send({ type: "release" }); }); w.child.send({ type: "release" });
    const result = (await w.wait("result")).state as TaskState; await w.close();
    await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
    assert.ok(result.status === "succeeded" && result.specVersion === 2 && result.runs >= 2 && result.evidence.filter(e => result.finalEvidenceIds.includes(e.id)).every(e => e.specVersion === 2), "旧版本不得先成功，更新只应用一次且不清零额度");
    const terminal = await sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command: { id: "late-cancel", type: "cancel" } }); assert.ok(terminal.status === "rejected" && terminal.reason === "terminal_task");
  });
});

test("LT-08C: two independent resume processes admit exactly one writer", { timeout: 300_000 }, async context => {
  await scenario(context, "phase2-resume-competition", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); const path = join(root, "task.json"); await writeFile(path, JSON.stringify(spec));
    const original = worker(root, "start", path, "run_planned"); context.after(() => original.close());
    const id = String((await original.wait("task")).id); await original.wait("barrier"); await original.close();
    const contestants = [worker(root, "resume", id, "run_planned"), worker(root, "resume", id, "run_planned")];
    for (const w of contestants) context.after(() => w.close());
    const admissions = await Promise.allSettled(contestants.map(w => w.wait("task")));
    const accepted = admissions.findIndex(result => result.status === "fulfilled");
    assert.equal(admissions.filter(result => result.status === "fulfilled").length, 1, "仅一个进程取得恢复执行权");
    const rejected = admissions.find(result => result.status === "rejected"); assert.ok(rejected?.status === "rejected" && String(rejected.reason).includes("busy"), "竞争失败者不得发模型请求");
    const winner = contestants[accepted]!; await winner.wait("barrier"); winner.child.send({ type: "release" });
    const state = (await winner.wait("result")).state as TaskState; assert.equal(state.status, "succeeded");
    await writeFile(join(root, "final-state.json"), JSON.stringify(state, null, 2));
  });
});

test("LT-08D: cancel published after final verification prevents durable success", { timeout: 300_000 }, async context => {
  await scenario(context, "phase2-final-cancel", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); const path = join(root, "task.json"); await writeFile(path, JSON.stringify(spec));
    const w = worker(root, "start", path, "before_success"); context.after(() => w.close());
    const id = String((await w.wait("task")).id); await w.wait("barrier");
    await sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command: { id: "final-cancel", type: "cancel" } }); w.child.send({ type: "release" });
    const state = (await w.wait("result")).state as TaskState; await w.close();
    assert.ok(state.status === "cancelled" && !state.finalEvidenceIds.length && state.evidence.some(e => e.result === "passed"), "实际验收通过也不能覆盖已发布取消");
    await writeFile(join(root, "final-state.json"), JSON.stringify(state, null, 2));
  });
});

for (const type of ["pause", "cancel"] as const) {
  test(`LT-08A/B: ${type} applies to a real active parent-child tool`, { timeout: 300_000 }, async context => {
    await scenario(context, `phase2-active-${type}`, async ({ root, cwd }) => {
      const spec = await valueFixture(root, cwd); spec.outcome += "首先调用 hold-work，只调用一次，然后再实现接口。";
      await writeFile(join(root, "hold-enabled"), "true"); const file = join(root, "task.json"); await writeFile(file, JSON.stringify(spec));
      const w = worker(root, "start", file); context.after(() => w.close()); const id = String((await w.wait("task")).id);
      let pids: { parent: number; child: number } | undefined;
      const deadline = Date.now() + 120_000;
      while (!pids && Date.now() < deadline) { pids = await readFile(join(root, "heartbeat.json"), "utf8").then(JSON.parse).catch(() => undefined); if (!pids) await new Promise(r => setTimeout(r, 50)); }
      assert.ok(pids, "前台工具的真实父子进程已经启动");
      const project = fileURLToPath(new URL("../../", import.meta.url));
      const cli = await runProcess([join(project, "dist/cli.js"), "task", type, id, "--command-id", `active-${type}`, "--data-dir", join(root, "state")], { cwd: project, signal: context.signal });
      assert.equal(cli.exitCode, 0, cli.stderr); const receipt = JSON.parse(cli.stdout);
      if (type === "pause") { assert.ok(["queued", "received"].includes(receipt.status), "工具仍活动时不能声称已暂停"); await writeFile(join(root, "release"), "release"); }
      const result = (await w.wait("result")).state as TaskState; await w.close();
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      assert.ok(result.status === (type === "pause" ? "paused" : "cancelled") && !alive(pids.parent) && !alive(pids.child), "收据生效前真实进程组已经停止");
      assert.equal((await readTaskCommandResult({ taskId: id, dataDirectory: join(root, "state"), commandId: `active-${type}` }))?.status, "applied");
      const resumed = await resume(root, id); await writeFile(join(root, "final-state.json"), JSON.stringify(resumed, null, 2));
      if (type === "cancel") assert.ok(resumed.status === "cancelled" && resumed.runs === result.runs, "取消后重启不得续跑");
      else assert.ok(resumed.status === "succeeded" && resumed.runs > result.runs, "暂停后跨进程续跑并保留累计用量");
    });
  });
}
