import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createTaskController, TaskRepository, type TaskDefinition } from "../src/index.js";
import { validateTaskDefinition } from "../src/task-contracts.js";
import { assistant, config, FakeGateway, fixture } from "./helpers.js";

async function taskFixture(context: Parameters<typeof fixture>[0], report = { checks: 1, passed: 1, failures: [] as string[] }) {
  const f = await fixture(context);
  await writeFile(join(f.cwd, "source.txt"), "initial source");
  const verifier = join(f.root, "verify.mjs");
  await writeFile(verifier, `console.log(${JSON.stringify(JSON.stringify(report))});\nprocess.exitCode = ${report.failures.length ? 1 : 0};\n`);
  const spec: TaskDefinition = { workspaceRoot: f.cwd, outcome: "Verify a source artifact", constraints: [],
    milestones: [{ id: "M1", title: "source artifact", verificationIds: ["source"] }], finalVerificationIds: ["source"],
    verifiers: [{ id: "source", description: "Check source", command: process.execPath, args: [verifier],
      inputs: ["source.txt"], trustedFiles: [verifier], outputs: ["source.txt"], timeoutMs: 5000 }],
    limits: { maxRuns: 1, maxRepairs: 0 } };
  return { ...f, verifier, spec };
}

test("verified task success persists evidence and can be read after its owner closes", async (context) => {
  const f = await taskFixture(context);
  const controller = await createTaskController({ spec: f.spec, dataDirectory: f.dataDirectory, config, gateway: new FakeGateway(() => assistant()) });
  f.cleanupAfter(() => controller.close());
  const result = await controller.start();
  await controller.close();
  const durable = await TaskRepository.read(f.dataDirectory, controller.id);
  assert.ok(result.status === "succeeded" && durable.status === "succeeded" && durable.finalEvidenceIds.every(id =>
    durable.evidence.some(e => e.id === id && e.result === "passed" && e.artifactHashes["source.txt"])),
    "Only a passed real process and hashed output may create durable task success");
  const report = JSON.parse(await readFile(durable.evidence.at(-1)!.reportArtifact, "utf8"));
  assert.ok(report.execution.exitCode === 0 && report.evidence.checks > 0, "Evidence must retain actual process results");
});

test("model completed reply cannot override failed acceptance, and repair cap stops further calls", async (context) => {
  const f = await taskFixture(context, { checks: 1, passed: 0, failures: ["wrong subtotal"] });
  const gateway = new FakeGateway(() => assistant("All done, every test passed"));
  const controller = await createTaskController({ spec: f.spec, dataDirectory: f.dataDirectory, config, gateway });
  f.cleanupAfter(() => controller.close());
  const result = await controller.start();
  assert.ok(result.status === "budget_exhausted" && result.evidence.some(e => e.result === "failed") && !result.finalEvidenceIds.length,
    "Failed acceptance must block success despite a completion claim");
  assert.equal(gateway.requests.length, 1, "Zero repair budget must forbid another model request");
});

test("repair feedback carries reproducible failure details without pointing file tools outside the workspace", async (context) => {
  const f = await taskFixture(context);
  const reproduction = "node --test src/check.mts";
  f.spec.verifiers[0]!.description = `复现命令：${reproduction}`;
  await writeFile(f.verifier, `import { readFileSync } from 'node:fs'; const good = readFileSync(${JSON.stringify(join(f.cwd, "source.txt"))}, 'utf8') === 'correct'; console.log(JSON.stringify({checks:1,passed:good?1:0,failures:good?[]:['wrong source']})); process.exitCode=good?0:1;`);
  f.spec.limits = { maxRuns: 2, maxRepairs: 1 };
  let repairPrompt = "";
  const gateway = new FakeGateway(async (request, _signal, index) => {
    if (index > 0) {
      repairPrompt = request.messages.filter(m => m.role === "user").at(-1)!.text;
      await writeFile(join(f.cwd, "source.txt"), "correct");
    }
    return assistant();
  });
  const controller = await createTaskController({ spec: f.spec, dataDirectory: f.dataDirectory, config, gateway });
  f.cleanupAfter(() => controller.close());
  const result = await controller.start();
  assert.ok(result.status === "succeeded" && repairPrompt.includes(reproduction) && repairPrompt.includes("wrong source") &&
    !repairPrompt.includes(join(f.dataDirectory, "tasks")), "The next model request must carry usable diagnostics and keep private evidence paths out of its read targets");
});

test("zero-check exit-zero report cannot be accepted as verification", async (context) => {
  const f = await taskFixture(context, { checks: 0, passed: 0, failures: [] });
  const controller = await createTaskController({ spec: f.spec, dataDirectory: f.dataDirectory, config, gateway: new FakeGateway(() => assistant()) });
  f.cleanupAfter(() => controller.close());
  const result = await controller.start();
  assert.ok(result.status === "blocked" && result.reason?.includes("verification_unavailable"), "No executed checks means unavailable evidence, not success");
});

test("changing trusted verifier after admission blocks success", async (context) => {
  const f = await taskFixture(context);
  const gateway = new FakeGateway(async () => {
    await writeFile(f.verifier, "console.log(JSON.stringify({ checks:1, passed:1, failures:[] }));\n");
    return assistant();
  });
  const controller = await createTaskController({ spec: f.spec, dataDirectory: f.dataDirectory, config, gateway });
  f.cleanupAfter(() => controller.close());
  const result = await controller.start();
  assert.ok(result.status === "blocked" && result.reason?.includes("trusted_file_changed"), "A modified acceptance contract must not authorize success");
});

test("a later verifier changing an already verified output invalidates final success", async (context) => {
  const f = await taskFixture(context);
  const output = join(f.cwd, "answer.json");
  await writeFile(output, '{"answer":1}');
  const changeOutput = join(f.root, "change-output.mjs");
  await writeFile(changeOutput, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(output)}, '{"answer":2}'); console.log(JSON.stringify({checks:1,passed:1,failures:[]}));`);
  f.spec.verifiers[0]!.outputs = ["answer.json"];
  f.spec.verifiers.push({ ...f.spec.verifiers[0]!, id: "later", args: [changeOutput], trustedFiles: [changeOutput], outputs: [] });
  f.spec.finalVerificationIds.push("later");
  const controller = await createTaskController({ spec: f.spec, dataDirectory: f.dataDirectory, config, gateway: new FakeGateway(() => assistant()) });
  f.cleanupAfter(() => controller.close());
  const result = await controller.start();
  assert.ok(result.status === "blocked" && result.reason?.includes("证据失效"), "A passed output receipt cannot authorize a subsequently changed artifact");
});

test("final acceptance cannot omit a milestone's contract or bypass disabled process capability", async (context) => {
  const f = await taskFixture(context);
  assert.throws(() => validateTaskDefinition({ ...f.spec, finalVerificationIds: ["unknown"] }), /不存在/);
  await assert.rejects(createTaskController({ spec: f.spec, dataDirectory: f.dataDirectory, config, noShell: true }), /no-shell/);
});
