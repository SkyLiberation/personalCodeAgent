import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskRepository } from "../../src/index.js";
import { phase2Worker, phase2Resume } from "./phase2-helpers.js";
import { orderFixture } from "./order-fixture.js";
import { scenario, saveSuiteReport, runProcess } from "./helpers.js";
after(saveSuiteReport);
test("LT-07A: pause orders after M2, CLI update to 2000bps, new process delivers version 2", { timeout: 900_000 }, async context => {
  await scenario(context, "phase2-orders-update", async ({ root, cwd }) => {
    const fixture = await orderFixture(root, cwd); fixture.spec.scope = { writablePaths: ["src"] }; await writeFile(fixture.specPath, JSON.stringify(fixture.spec));
    let w = phase2Worker(root, "start", fixture.specPath, "milestone_verified:M2"); context.after(() => w.close());
    const id = String((await w.wait("task")).id);
    for (let retries = 0; ; retries++) {
      const next = await w.wait("barrier|result"); if (next.type === "barrier") break;
      const state = next.state as { status: string; reason?: string };
      assert.ok(retries < 2 && state.status === "blocked" && state.reason?.startsWith("model_error"), `未达到 M2 暂停屏障：${state.status} ${state.reason}`);
      await w.close(); w = phase2Worker(root, "resume", id, "milestone_verified:M2"); await w.wait("task");
    }
    const project = fileURLToPath(new URL("../../", import.meta.url));
    const cli = async (args: string[]) => runProcess([join(project, "dist/cli.js"), "task", ...args, "--data-dir", join(root, "state")], { cwd: project, signal: context.signal });
    await cli(["pause", id, "--command-id", "orders-pause"]); w.child.send({ type: "release" });
    const paused = (await w.wait("result")).state as { runs: number; status: string }; await w.close(); assert.equal(paused.status, "paused");
    const next = structuredClone(fixture.spec); const verifier = join(root, "control", "verify-v2.mjs");
    await writeFile(verifier, fixture.trustedSource.replaceAll("calculateOrders(lines, 1000)", "calculateOrders(lines, 2000)").replaceAll("'--discount-bps', '1000'", "'--discount-bps', '2000'").replaceAll("498, 4482", "996, 3984").replaceAll("30, 3, 27", "30, 6, 24"));
    for (const v of next.verifiers) { v.args[0] = verifier; v.trustedFiles[0] = verifier; v.description = v.description.replaceAll("1000", "2000").replaceAll("4980/498/4482", "4980/996/3984").replaceAll("30/3/27", "30/6/24"); }
    next.outcome += "最终命令折扣参数2000bps，A总额3984分，B总额24分。";
    const path = join(root, "control", "task-v2.json"); await writeFile(path, JSON.stringify(next));
    for (let i = 0; i < 2; i++) { const result = await cli(["update", id, "--spec", path, "--expected-version", "1", "--command-id", "orders-update", "--wait"]); assert.equal(result.exitCode, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, "applied"); }
    const updated = await TaskRepository.read(join(root, "state"), id); assert.ok(updated.status === "paused" && updated.specVersion === 2 && updated.runs === paused.runs, "更新不解除暂停、不重置额度、不重复增版本");
    const stale = await cli(["update", id, "--spec", path, "--expected-version", "1", "--command-id", "orders-stale", "--wait"]); assert.equal(JSON.parse(stale.stdout).reason, "version_conflict");
    const resumed = await phase2Resume(root, id); await writeFile(join(root, "final-state.json"), JSON.stringify(resumed, null, 2)); assert.equal(resumed.status, "succeeded");
    const independent = await runProcess([verifier, cwd, "cli"], { cwd, signal: context.signal }); assert.equal(independent.exitCode, 0, independent.stderr + independent.stdout);
    const summary = JSON.parse(await readFile(join(cwd, "out/summary.json"), "utf8"));
    assert.deepEqual(summary.orders.map((o: {subtotalCents:number;discountCents:number;totalCents:number}) => [o.subtotalCents,o.discountCents,o.totalCents]), [[4980,996,3984],[30,6,24]]);
    assert.ok(resumed.evidence.filter(e => resumed.finalEvidenceIds.includes(e.id)).every(e => e.specVersion === 2), "最终证据全部绑定新版本");
  });
});
