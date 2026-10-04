import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, appendFile, unlink, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskController, loadConfig, TaskRepository } from "../../src/index.js";
import { phase2Worker } from "./phase2-helpers.js";
import { valueFixture } from "./value-fixture.js";
import { runProcess, scenario, saveSuiteReport } from "./helpers.js";
after(saveSuiteReport);
test("LT-04E: real CLI repairs only incomplete tail, rejects corruption/future schema and preserves legacy logs", { timeout: 300_000 }, async context => {
  await scenario(context, "phase2-storage-compat", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); const dataDirectory = join(root, "state");
    const controller = await createTaskController({ spec, config: loadConfig(), dataDirectory }); const id = controller.id; await controller.close();
    const directory = join(dataDirectory, "tasks", id); const path = join(directory, "events.jsonl");
    await unlink(join(directory, "snapshot.json")); await appendFile(path, '{"type":"task_sta');
    const project = fileURLToPath(new URL("../../", import.meta.url));
    const cli = (action: string) => runProcess([join(project, "dist/cli.js"), "task", action, id, "--data-dir", dataDirectory, ...(action === "resume" ? ["--json"] : [])], { cwd: project, signal: context.signal });
    const resumed = await cli("resume"); await writeFile(join(root, "resume.events.jsonl"), resumed.stdout); assert.equal(resumed.exitCode, 0, resumed.stderr);
    assert.ok((await readdir(directory)).some(file => file.includes("tail-backup")), "尾部原文件先备份再修复");
    const valid = await readFile(path, "utf8"); const records = valid.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(JSON.parse((await cli("status")).stdout).status, "succeeded", "缓存缺失不阻碍从事实恢复并实际验收");
    const corrupted = valid.replace('"task_input_applied"', '"future_fact"'); await writeFile(path, corrupted);
    assert.notEqual((await cli("resume")).exitCode, 0); assert.equal(await readFile(path, "utf8"), corrupted, "中间损坏不得截断");
    const future = structuredClone(records); future[0].state.schemaVersion = 999; const futureContent = future.map(record => JSON.stringify(record)).join("\n") + "\n"; await writeFile(path, futureContent);
    assert.notEqual((await cli("resume")).exitCode, 0); assert.equal(await readFile(path, "utf8"), futureContent, "未来格式保留并拒绝执行");
    // Authored compatibility fixture derived from a genuinely verified run. It
    // validates old-format read/refusal; it is not presented as a new model run.
    const legacy = structuredClone(records); legacy[0].state.schemaVersion = 1;
    for (const record of legacy) { delete record.checksum; delete record.previousHash; }
    const terminal = legacy.map(record => JSON.stringify(record)).join("\n") + "\n"; await writeFile(path, terminal);
    assert.equal(JSON.parse((await cli("status")).stdout).status, "succeeded");
    assert.notEqual((await cli("resume")).exitCode, 0); assert.equal(await readFile(path, "utf8"), terminal);
    const active = JSON.stringify({ ...legacy[0], state: { ...legacy[0].state, status: "running" } }) + "\n"; await writeFile(path, active);
    const refused = await cli("resume"); assert.ok(refused.exitCode !== 0 && refused.stderr.includes("migration_handoff_ambiguous")); assert.equal(await readFile(path, "utf8"), active);
    await writeFile(join(root, "legacy-refusal.log"), refused.stderr); await writeFile(path, valid);
    const legacyCwd = join(root, "legacy-workspace"); await mkdir(legacyCwd);
    const legacySpec = await valueFixture(join(root, "legacy-fixture"), legacyCwd);
    const pending = await createTaskController({ spec: legacySpec, config: loadConfig(), dataDirectory }); const pendingId = pending.id; const sessionId = pending.state.sessionId; await pending.close();
    const oldTaskPath = join(dataDirectory, "tasks", pendingId, "events.jsonl"); const oldSessionPath = join(dataDirectory, "sessions", `${sessionId}.jsonl`);
    const oldTask = JSON.parse((await readFile(oldTaskPath, "utf8")).trim()); oldTask.state.schemaVersion = 1; delete oldTask.checksum; delete oldTask.previousHash;
    const oldSession = JSON.parse((await readFile(oldSessionPath, "utf8")).trim()); oldSession.schemaVersion = 1;
    const taskSource = JSON.stringify(oldTask) + "\n", sessionSource = JSON.stringify(oldSession) + "\n"; await writeFile(oldTaskPath, taskSource); await writeFile(oldSessionPath, sessionSource);
    const interrupted = phase2Worker(root, "resume", pendingId, "migration_logs_synced"); context.after(() => interrupted.close());
    await interrupted.wait("barrier"); await interrupted.close();
    assert.equal((await TaskRepository.read(dataDirectory, pendingId)).schemaVersion, 1, "manifest 发布前崩溃的新代际不得成为权威日志");
    const migrated = await runProcess([join(project, "dist/cli.js"), "task", "resume", pendingId, "--data-dir", dataDirectory, "--json"], { cwd: project, signal: context.signal });
    await writeFile(join(root, "migration.events.jsonl"), migrated.stdout); assert.equal(migrated.exitCode, 0, migrated.stderr);
    const manifest = JSON.parse(await readFile(join(dataDirectory, "tasks", pendingId, "migration.json"), "utf8"));
    assert.ok(manifest.taskLog && manifest.sessionLog && manifest.sources.length === 2, "同步两个新日志后发布同一迁移 manifest");
    assert.ok(await readFile(oldTaskPath, "utf8") === taskSource && await readFile(oldSessionPath, "utf8") === sessionSource, "原始两份 v1 日志保持不变");
    const state = await runProcess([join(project, "dist/cli.js"), "task", "status", pendingId, "--data-dir", dataDirectory], { cwd: project, signal: context.signal }); assert.ok(JSON.parse(state.stdout).schemaVersion === 2 && JSON.parse(state.stdout).status === "succeeded");
  });
});
