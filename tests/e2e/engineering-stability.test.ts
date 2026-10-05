import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTaskController, loadConfig, runWorkflow } from "../../src/index.js";
import { eventFixture } from "./event-fixture.js";
import { scenario, saveSuiteReport } from "./helpers.js";
after(saveSuiteReport);

test("WF-02: three fixed-config seeded engineering agents use bounded fanout and verified dependencies", { timeout: 600_000 }, async context => {
  await scenario(context, "engineering-three-seeds", async ({ root }) => {
    const seeds = [137, 271, 809]; const config = { ...loadConfig(), thinking: "off" as const, maxTurns: 8, maxOutputTokens: 8192 };
    const controllers: Awaited<ReturnType<typeof createTaskController>>[] = [];
    for (const seed of seeds) {
      const directory = join(root, `seed-${seed}`); const cwd = join(directory, "workspace"); await mkdir(cwd, { recursive: true });
      const spec = await eventFixture(directory, cwd, seed); spec.completionPolicy = "verification";
      controllers.push(await createTaskController({ spec, config, dataDirectory: join(directory, "state") }));
    }
    context.after(async () => { for (const controller of controllers) await controller.close(); });
    let active = 0; let maximum = 0; const intervals: { seed: number; started: number; ended?: number }[] = [];
    const result = await runWorkflow(controllers.map((controller, i) => ({ id: String(seeds[i]), dependsOn: i === 2 ? seeds.slice(0, 2).map(String) : [], run: async signal => {
      active++; maximum = Math.max(maximum, active); const interval: { seed: number; started: number; ended?: number } = { seed: seeds[i]!, started: Date.now() }; intervals.push(interval);
      try { return await controller.start(signal); } finally { interval.ended = Date.now(); active--; }
    } })), { concurrency: 2, signal: context.signal });
    const passed = Object.values(result).filter(r => r.status === "succeeded").length;
    await writeFile(join(root, "stability-report.json"), JSON.stringify({ config: { modelId: config.modelId, baseUrl: config.baseUrl, thinking: config.thinking, maxTurns: config.maxTurns, maxOutputTokens: config.maxOutputTokens }, seeds, samples: 3, passed, maximum, intervals, result }, null, 2));
    assert.equal(passed, 3, "三个固定配置 seed 都要完成真实 CLI，保留全部结果而不选最好的一次"); assert.equal(maximum, 2);
    assert.ok(intervals.find(i => i.seed === 809)!.started >= Math.max(...intervals.filter(i => i.seed !== 809).map(i => i.ended!)), "下游工程只有依赖实际验收成功后才启动");
  });
});
