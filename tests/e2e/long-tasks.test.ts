import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { createTaskController, loadConfig, type TaskEvent, type TaskState } from "../../src/index.js";
import { runProcess, saveSuiteReport, scenario } from "./helpers.js";
import { brokenCalculator, orderFixture } from "./order-fixture.js";

after(saveSuiteReport);

test("LT-01: actual task CLI completes staged order delivery with independent evidence", { timeout: 600_000 }, async (context) => {
  await scenario(context, "LT-01-order-delivery", async ({ root, cwd }) => {
    const fixture = await orderFixture(root, cwd);
    const baseline = await runProcess([fixture.verifierPath, cwd, "calculate"], { cwd, signal: context.signal });
    await writeFile(join(root, "baseline.log"), baseline.stdout + baseline.stderr);
    assert.notEqual(baseline.exitCode, 0, "The initial order implementation must fail its acceptance contract");
    const stateRoot = join(root, "state");
    const cli = await runProcess([join(process.cwd(), "dist/cli.js"), "task", "start", "--spec", fixture.specPath,
      "--data-dir", stateRoot, "--json", "--max-turns", "10"], { cwd: process.cwd(), signal: context.signal, timeoutMs: 550_000 });
    await writeFile(join(root, "task-cli.events.jsonl"), cli.stdout);
    await writeFile(join(root, "task-cli.stderr.log"), cli.stderr);
    const events = cli.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as TaskEvent);
    const settled = events.findLast(event => event.type === "task_settled");
    assert.ok(cli.exitCode === 0 && settled?.type === "task_settled" && settled.status === "succeeded",
      `Task CLI must deliver verified success: ${cli.stderr} ${JSON.stringify(settled)}`);
    const stateResult = await runProcess([join(process.cwd(), "dist/cli.js"), "task", "status", settled.taskId,
      "--data-dir", stateRoot], { cwd: process.cwd(), signal: context.signal });
    const state = JSON.parse(stateResult.stdout) as TaskState;
    await writeFile(join(root, "task-state.json"), stateResult.stdout);
    assert.ok(state.status === "succeeded" && state.verifiedMilestones.length === 3 &&
      fixture.spec.finalVerificationIds.every(id => state.finalEvidenceIds.some(evidenceId => state.evidence.some(e =>
        e.id === evidenceId && e.verificationId === id && e.result === "passed" && e.specVersion === state.specVersion))),
      "Durable task success must reference current-version evidence for all final contracts");
    const independent = await runProcess([fixture.verifierPath, cwd, "cli"], { cwd, signal: context.signal });
    await writeFile(join(root, "independent-verification.log"), independent.stdout + independent.stderr);
    assert.equal(independent.exitCode, 0, independent.stdout + independent.stderr);
    assert.equal(await readFile(fixture.verifierPath, "utf8"), fixture.trustedSource, "Acceptance rules must stay intact");
  });
});

test("LT-02: model completion cannot pass corrupted output; actual model repairs verification feedback", { timeout: 600_000 }, async (context) => {
  await scenario(context, "LT-02-verification-repair", async ({ root, cwd }) => {
    const fixture = await orderFixture(root, cwd);
    const events: TaskEvent[] = [];
    let injected = false;
    const controller = await createTaskController({ spec: fixture.spec, dataDirectory: join(root, "state"),
      config: { ...loadConfig(), maxTurns: 10 },
      testHooks: { beforeVerification: async ({ phase, milestoneId }) => {
        if (!injected && phase === "milestone" && milestoneId === "M3") {
          const run = events.findLast(event => event.type === "task_run_completed");
          assert.ok(run?.type === "task_run_completed" && run.status === "completed", "Inject the regression only after the real model naturally completes its M3 run");
          injected = true;
          await writeFile(join(cwd, "src/calculate.mts"), brokenCalculator);
          await writeFile(join(root, "fault.json"), JSON.stringify({ boundary: "after M3 model run, before verification", injected: true }));
        }
      } },
    });
    controller.subscribe(event => { events.push(event); });
    try {
      const result = await controller.start(context.signal);
      await writeFile(join(root, "task-state.json"), JSON.stringify(result, null, 2));
      const failed = events.findIndex(event => event.type === "verification_completed" && event.evidence.result === "failed");
      const continued = events.findIndex((event, i) => i > failed && event.type === "task_run_started");
      assert.ok(injected && failed >= 0 && continued > failed && result.status === "succeeded",
        `A failed real verifier must prevent success and trigger an actual repair: ${result.reason ?? result.status}`);
      assert.ok(!events.slice(0, continued).some(event => event.type === "task_settled" && event.status === "succeeded"),
        "The task must not claim success before repairing the injected regression");
      const independent = await runProcess([fixture.verifierPath, cwd, "cli"], { cwd, signal: context.signal });
      await writeFile(join(root, "independent-verification.log"), independent.stdout + independent.stderr);
      assert.equal(independent.exitCode, 0, independent.stdout + independent.stderr);
      assert.equal(await readFile(fixture.verifierPath, "utf8"), fixture.trustedSource, "Acceptance rules must stay intact");
    } finally {
      await writeFile(join(root, "task.events.jsonl"), events.map(event => JSON.stringify(event)).join("\n") + "\n");
      await controller.close();
    }
  });
});
