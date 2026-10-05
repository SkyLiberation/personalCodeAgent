import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, appendFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createTaskController, openTaskController, sendTaskCommand, readTaskCommandResult, TaskRepository, SessionRepository } from "../src/index.js";
import { createExecutionHost } from "../src/platform/host.js";
import { digest } from "../src/storage/journal.js";
import { valueFixture } from "./e2e/value-fixture.js";
import { assistant, config, FakeGateway, fixture } from "./helpers.js";
import type { FileHandle } from "node:fs/promises";

test("input identity rejects conflicting content; complete facts survive missing snapshot and partial tail", async context => {
  const f = await fixture(context); const host = await createExecutionHost();
  const options = { directory: f.dataDirectory, cwd: f.cwd, sessionId: "input-contract", host };
  let repo = await SessionRepository.open(options);
  f.cleanupAfter(async () => { await repo.close(); await host.close(); });
  const input = { inputId: "input-1", runId: "run-1", specVersion: 1, prompt: "actual task", contentHash: digest("actual task") };
  await Promise.all([repo.acceptInputOnce(input), repo.acceptInputOnce(input)]);
  await assert.rejects(repo.acceptInputOnce({ ...input, prompt: "different", contentHash: digest("different") }), /input_id_conflict/);
  const path = repo.path; await repo.close(); await appendFile(path, '{"kind":"mess');
  repo = await SessionRepository.open(options);
  assert.equal(repo.facts().filter(e => e.kind === "input").length, 1, "稳定输入只接收一次，修复尾部保留既有事实");
});

test("paused contract update is atomic, deduplicated, CAS protected and does not reset usage", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd);
  const gateway = new FakeGateway(async () => { await writeFile(join(f.cwd, "lib/value.mts"), "export function value(){return 42}"); return assistant(); });
  let controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory });
  f.cleanupAfter(() => controller.close());
  await sendTaskCommand({ taskId: controller.id, dataDirectory: f.dataDirectory, command: { id: "pause", type: "pause" } });
  assert.equal((await controller.start()).status, "paused"); const id = controller.id; await controller.close();
  const next = structuredClone(spec); next.outcome = "value 返回43";
  const v2 = join(f.root, "control", "v2.mjs"); await writeFile(v2, (await readFile(spec.verifiers[0]!.args[0]!, "utf8")).replaceAll("42", "43")); next.verifiers[0]!.args = [v2]; next.verifiers[0]!.trustedFiles[0] = v2;
  const command = { id: "update", type: "update" as const, spec: next, expectedVersion: 1 };
  await sendTaskCommand({ taskId: id, dataDirectory: f.dataDirectory, command }); await sendTaskCommand({ taskId: id, dataDirectory: f.dataDirectory, command });
  await sendTaskCommand({ taskId: id, dataDirectory: f.dataDirectory, command: { ...command, id: "stale" } });
  controller = await openTaskController({ taskId: id, dataDirectory: f.dataDirectory, config, gateway });
  const updated = await controller.processCommands();
  assert.ok(updated.status === "paused" && updated.specVersion === 2 && updated.runs === 0 && updated.commands?.stale?.reason === "version_conflict", "版本与命令结果同一次提交；update 不启动模型、不解除暂停");
  assert.equal((await readTaskCommandResult({ taskId: id, dataDirectory: f.dataDirectory, commandId: "update" }))?.status, "applied");
});

test("same canonical workspace rejects another task across separate state directories", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); const gateway = new FakeGateway(() => assistant());
  const owner = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => owner.close());
  await assert.rejects(createTaskController({ spec, config, gateway, dataDirectory: join(f.root, "other-state") }), /busy/);
  await assert.rejects(openTaskController({ taskId: owner.id, dataDirectory: f.dataDirectory, config, gateway }), /busy/);
});

test("cancel at final barrier wins over success and terminal resume starts no model", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); await writeFile(join(f.cwd, "lib/value.mts"), "export function value(){return 42}");
  const gateway = new FakeGateway(() => assistant());
  let controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory, testHooks: { barrier: async name => { if (name === "before_success") await sendTaskCommand({ taskId: controller.id, dataDirectory: f.dataDirectory, command: { id: "cancel", type: "cancel" } }); } } });
  f.cleanupAfter(() => controller.close());
  const state = await controller.start(); const id = controller.id; await controller.close();
  assert.ok(state.status === "cancelled" && !state.finalEvidenceIds.length, "已发布取消必须在成功结算之前处理");
  const requests = gateway.requests.length; controller = await openTaskController({ taskId: id, dataDirectory: f.dataDirectory, config, gateway });
  assert.ok((await controller.resume()).status === "cancelled" && gateway.requests.length === requests, "取消任务不得自动续跑");
});

test("a missing unresolved write target stays recoverable until the original content is restored", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd);
  const file = join(f.cwd, "lib/value.mts"); const content = "export function value(){return 42}\n";
  const gateway = new FakeGateway((_request, _signal, index) => index === 0
    ? assistant("", [{ id: "unfinished-write", name: "write", arguments: { path: "lib/value.mts", content } }]) : assistant());
  let controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory,
    testHooks: { barrier: async name => { if (name === "tool_effect_completed:write") throw new Error("test_interrupted_before_result"); } } });
  f.cleanupAfter(() => controller.close());
  await controller.start(); const id = controller.id; await controller.close(); await unlink(file);
  controller = await openTaskController({ taskId: id, config, gateway, dataDirectory: f.dataDirectory });
  const before = gateway.requests.length; const blocked = await controller.resume(); await controller.close();
  assert.ok(blocked.status === "blocked" && blocked.reason?.includes("effect_unknown") && gateway.requests.length === before,
    "缺失文件只意味着无法核查，不能终止任务或请求模型猜测副作用");
  await writeFile(file, content); controller = await openTaskController({ taskId: id, config, gateway, dataDirectory: f.dataDirectory });
  assert.ok((await controller.resume()).status === "succeeded" && gateway.requests.length === before,
    "恢复原文件后同任务直接重验成功，不重放原写操作");
});

test("v2 corruption cannot be repaired as a partial tail; legacy active task remains preserved and blocked", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); const gateway = new FakeGateway(() => assistant());
  const c = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); const id = c.id; await c.close();
  const path = join(f.dataDirectory, "tasks", id, "events.jsonl"); const original = await readFile(path, "utf8");
  await writeFile(path, original.replace('"pending"', '"succeeded"'));
  await assert.rejects(openTaskController({ taskId: id, dataDirectory: f.dataDirectory, config, gateway }), /checksum/);
  assert.equal(await readFile(path, "utf8"), original.replace('"pending"', '"succeeded"'), "损坏日志不得截断后继续");
  const legacy = JSON.parse(original.trim().split("\n")[0]!); delete legacy.checksum; delete legacy.previousHash; legacy.state.schemaVersion = 1; legacy.state.status = "running";
  await writeFile(path, JSON.stringify(legacy) + "\n");
  assert.equal((await TaskRepository.read(f.dataDirectory, id)).schemaVersion, 1);
  await assert.rejects(openTaskController({ taskId: id, dataDirectory: f.dataDirectory, config, gateway }), /migration_handoff_ambiguous/);
});

test("failed required write rejects execution and starts no model or tool", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); const gateway = new FakeGateway(() => assistant());
  let c = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory, testHooks: { barrier: async name => { if (name === "run_planned") await (c.repository as unknown as { handle: FileHandle }).handle.close(); } } });
  f.cleanupAfter(() => c.close());
  await assert.rejects(c.start(), /closed|EBADF/);
  assert.equal(gateway.requests.length, 0, "输入应用记录未提交时禁止模型请求");
  assert.equal((await TaskRepository.read(f.dataDirectory, c.id)).status, "running", "不能虚构持久化成功或停止");
});

test("cancel command published after durable success stays queryably rejected", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); await writeFile(join(f.cwd, "lib/value.mts"), "export function value(){return 42}");
  const controller = await createTaskController({ spec, config, gateway: new FakeGateway(() => assistant()), dataDirectory: f.dataDirectory }); f.cleanupAfter(() => controller.close());
  assert.equal((await controller.start()).status, "succeeded");
  const command = { id: "late", type: "cancel" as const }; await sendTaskCommand({ taskId: controller.id, dataDirectory: f.dataDirectory, command });
  const repeated = await sendTaskCommand({ taskId: controller.id, dataDirectory: f.dataDirectory, command }); const saved = await readTaskCommandResult({ taskId: controller.id, dataDirectory: f.dataDirectory, commandId: "late" });
  assert.ok(repeated.status === "rejected" && saved?.reason === "terminal_task" && (await TaskRepository.read(f.dataDirectory, controller.id)).status === "succeeded");
});
