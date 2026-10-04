import test, { after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createTaskController, openTaskController, TaskRepository, PiModelGateway, loadConfig, sendTaskCommand } from "../../src/index.js";
import type { ModelGateway } from "../../src/contracts.js";
import type { TaskEvent } from "../../src/task-contracts.js";
import { WindowsHost } from "../../src/platform/windows.js";
import { valueFixture } from "./value-fixture.js";
import { phase2Worker, phase2Resume } from "./phase2-helpers.js";
import { scenario, saveSuiteReport } from "./helpers.js";
after(saveSuiteReport);
test("LT-04F: current file digest mismatch blocks further model work until observable state is restored", { timeout: 300_000 }, async context => {
  await scenario(context, "phase2-file-unknown", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); const path = join(root, "task.json"); await writeFile(path, JSON.stringify(spec));
    const w = phase2Worker(root, "start", path, "tool_effect_completed:write"); context.after(() => w.close());
    const id = String((await w.wait("task")).id); await w.wait("barrier"); await w.close();
    const file = join(cwd, "lib/value.mts"); const completedContent = await readFile(file, "utf8"); const before = await TaskRepository.read(join(root, "state"), id);
    await writeFile(file, "export function value(){return -1}");
    const blocked = await phase2Resume(root, id); assert.ok(blocked.status === "blocked" && blocked.reason?.includes("effect_unknown") && blocked.runs === before.runs, "摘要不符不能闭合原调用或启动新 Run");
    await writeFile(file, completedContent); const result = await phase2Resume(root, id); assert.equal(result.status, "succeeded"); await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
  });
});
test("LT-09: missing verifier blocks actual completed code; explicit contract repair resumes without quota reset", { timeout: 300_000 }, async context => {
  await scenario(context, "phase2-verifier-unavailable", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); const valid = structuredClone(spec); spec.verifiers[0]!.command = join(root, "missing-verifier.exe");
    const config = loadConfig(); let c = await createTaskController({ spec, config, dataDirectory: join(root, "state") }); context.after(() => c.close());
    const events: TaskEvent[] = []; c.subscribe(event => events.push(event));
    const blocked = await c.start(); const id = c.id; await c.close();
    await writeFile(join(root, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    assert.ok(blocked.status === "blocked" && blocked.reason?.includes("verification_unavailable") && !blocked.finalEvidenceIds.length, "模型完成不能替代失效的验收");
    await sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command: { id: "repair-verifier", type: "update", expectedVersion: 1, spec: valid } });
    c = await openTaskController({ taskId: id, config, dataDirectory: join(root, "state") }); c.subscribe(event => events.push(event)); const result = await c.resume();
    await writeFile(join(root, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
    assert.ok(result.status === "succeeded" && result.specVersion === 2 && result.runs === blocked.runs, "修复合同后重验实际文件，无需新模型 Run"); await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
  });
});
for (const target of ["task", "session"] as const) test(`LT-09: actual closed ${target} descriptor prevents first model request and leaves stop uncommitted`, { timeout: 30_000 }, async context => {
  await scenario(context, `phase2-persistence-failure-${target}`, async ({ root, cwd }) => {
    const config = loadConfig(); const pi = new PiModelGateway(config); let requests = 0;
    const gateway: ModelGateway = { stream(request, signal) { requests++; return pi.stream(request, signal); } };
    const spec = await valueFixture(root, cwd); const c = await createTaskController({ spec, config, gateway, dataDirectory: join(root, "state"), testHooks: { barrier: async name => {
      if (target === "task" && name === "run_planned") await (c.repository as unknown as { handle: FileHandle }).handle.close();
      if (target === "session" && name === "input_accepted") await (c as unknown as { session: { repository: { handle: FileHandle } } }).session.repository.handle.close();
    } } }); context.after(() => c.close());
    await assert.rejects(c.start(), /closed|EBADF|persistence_error/); const state = await TaskRepository.read(join(root, "state"), c.id);
    assert.ok(requests === 0 && state.status === "running" && !state.finalEvidenceIds.length, "实际持久写入失败后不启动模型，也不能虚构 durable stop");
    await writeFile(join(root, "result-evidence.json"), JSON.stringify({ modelId: config.modelId, baseUrl: config.baseUrl, requests, taskId: c.id, durableStatus: state.status, fault: `closed_${target}_journal` }, null, 2));
  });
});
test("LT-08C: missing native compiler refuses execution without a weaker lock fallback", { timeout: 30_000 }, async context => {
  await scenario(context, "phase2-platform-unavailable", async ({ root, cwd }) => {
    const config = loadConfig(); const pi = new PiModelGateway(config); let requests = 0;
    const gateway: ModelGateway = { stream(request, signal) { requests++; return pi.stream(request, signal); } };
    const spec = await valueFixture(root, cwd); let failure = "";
    try { await createTaskController({ spec, config, gateway, dataDirectory: join(root, "state"), services: { platform: () => WindowsHost.create({ compiler: join(root, "missing-compiler.exe"), cacheDirectory: join(root, "platform-cache") }) } }); }
    catch (error) { failure = String(error); }
    assert.ok(failure.includes("ENOENT") && requests === 0 && (await readFile(join(cwd, "lib/value.mts"), "utf8")).includes("return 0"), "原生后端缺失时无模型 / 写入动作，不降级抢占");
    await writeFile(join(root, "failure.log"), failure);
  });
});
