import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createTaskController, openTaskController, PiModelGateway, loadConfig, type TaskEvent } from "../../src/index.js";
import type { ModelGateway } from "../../src/contracts.js";
import { valueFixture } from "./value-fixture.js";
import { phase2Worker, phase2Resume } from "./phase2-helpers.js";
import { scenario, saveSuiteReport, runProcess } from "./helpers.js";

after(saveSuiteReport);

test("HT-01: source changed before success blocks stale evidence; restored source resumes without model work", { timeout: 300_000 }, async context => {
  await scenario(context, "hardening-final-source-changed", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); const source = join(cwd, "lib/value.mts");
    const config = loadConfig(); const pi = new PiModelGateway(config); let requests = 0; let original = "";
    const gateway: ModelGateway = { stream(request, signal) { requests++; return pi.stream(request, signal); } };
    const events: TaskEvent[] = [];
    let controller = await createTaskController({ spec, config, gateway, dataDirectory: join(root, "state"), testHooks: { barrier: async name => {
      if (name === "before_success") { original = await readFile(source, "utf8"); await writeFile(source, "export function value(){return -1}\n"); }
    } } });
    context.after(() => controller.close()); controller.subscribe(event => events.push(event));
    const blocked = await controller.start(context.signal); const id = controller.id; await controller.close();
    await writeFile(join(root, "blocked-state.json"), JSON.stringify(blocked, null, 2));
    assert.ok(blocked.status === "blocked" && blocked.reason?.includes("verification_inputs_changed") && !blocked.finalEvidenceIds.length,
      "成功提交前变化的源码不能沿用旧证据");
    const failed = await runProcess(spec.verifiers[0]!.args, { cwd, signal: context.signal });
    assert.notEqual(failed.exitCode, 0, "当前坏文件确实不满足独立验收");
    await writeFile(join(root, "independent-failed.log"), failed.stdout + failed.stderr);
    await writeFile(source, original); const before = requests;
    controller = await openTaskController({ taskId: id, config, gateway, dataDirectory: join(root, "state") }); controller.subscribe(event => events.push(event));
    try {
      const restored = await controller.resume(context.signal);
      assert.ok(restored.status === "succeeded" && requests === before, "恢复合格文件后只重验，不启动新的模型请求");
      const passed = await runProcess(spec.verifiers[0]!.args, { cwd, signal: context.signal }); assert.equal(passed.exitCode, 0, passed.stdout + passed.stderr);
      await writeFile(join(root, "final-state.json"), JSON.stringify(restored, null, 2));
      await writeFile(join(root, "independent-passed.log"), passed.stdout + passed.stderr);
    } finally { await controller.close(); await writeFile(join(root, "events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n"); }
  });
});

for (const fault of ["missing-file", "missing-receipt"] as const) {
  test(`HT-02/03: ${fault} stays blocked until restored, with no new model request or repeated effect`, { timeout: 300_000 }, async context => {
    await scenario(context, `hardening-${fault}`, async ({ root, cwd }) => {
      const receipt = fault === "missing-receipt";
      const spec = await valueFixture(root, cwd, 42, receipt); const specPath = join(root, "task.json");
      await writeFile(specPath, JSON.stringify(spec)); await writeFile(join(root, "audit-model-enabled"), "true");
      if (receipt) await writeFile(join(root, "receipt-enabled"), "true");
      const worker = phase2Worker(root, "start", specPath, receipt ? "tool_effect_completed:record-delivery" : "tool_effect_completed:write");
      context.after(() => worker.close()); const id = String((await worker.wait("task")).id); await worker.wait("barrier"); await worker.close();
      const target = receipt ? join(root, (await readdir(root)).find(name => name.startsWith("receipt-") && name.endsWith(".json"))!) : join(cwd, "lib/value.mts");
      const backup = `${target}.host-backup`; await rename(target, backup);
      const before = await readFile(join(root, "model-requests.jsonl"), "utf8");
      const blockedWorker = phase2Worker(root, "resume", id); context.after(() => blockedWorker.close());
      const blocked = (await blockedWorker.wait("result")).state as { status: string; reason?: string; finalEvidenceIds: string[] };
      await blockedWorker.close();
      assert.ok(blocked.status === "blocked" && blocked.reason?.includes("effect_unknown") && !blocked.finalEvidenceIds.length,
        "无法核查文件或回执必须可恢复地阻塞");
      assert.equal(await readFile(join(root, "model-requests.jsonl"), "utf8"), before, "核查失败后没有实际模型请求");
      const logs = (await readdir(root)).filter(name => name.startsWith("resume-") && name.endsWith(".events.jsonl"));
      const toolStarts = (await Promise.all(logs.map(name => readFile(join(root, name), "utf8")))).flatMap(content => content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))).filter(e => e.type === "agent_event" && e.event.type === "tool_started");
      assert.equal(toolStarts.length, 0, "核查失败后没有新的工具启动");
      await rename(backup, target); const restored = await phase2Resume(root, id);
      assert.equal(restored.status, "succeeded", "条件恢复后同任务可显式续接并实际验收");
      if (receipt) assert.equal((await readFile(join(root, "audit.jsonl"), "utf8")).trim().split("\n").length, 1, "非幂等登记不重放");
      else assert.equal(await readFile(join(root, "model-requests.jsonl"), "utf8"), before, "恢复文件后直接验收，不重放写入或请求模型");
      await writeFile(join(root, "blocked-state.json"), JSON.stringify(blocked, null, 2));
      await writeFile(join(root, "final-state.json"), JSON.stringify(restored, null, 2));
    });
  });
}
