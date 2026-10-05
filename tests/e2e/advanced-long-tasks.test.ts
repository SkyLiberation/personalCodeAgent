import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createTaskController, openTaskController, loadConfig, PiModelGateway, sendTaskCommand, modelBudgetUsage, ContainerExecutionHost, LocalEnvironment, createCodingTools, type ModelGateway } from "../../src/index.js";
import { eventFixture } from "./event-fixture.js";
import { valueFixture } from "./value-fixture.js";
import { scenario, saveSuiteReport } from "./helpers.js";
after(saveSuiteReport);

test("LT-11: natural-run event engineering baseline uses hidden seed and real CLI", { timeout: 480_000 }, async context => {
  await scenario(context, "event-natural-baseline", async ({ root, cwd }) => {
    const seed = Math.floor(Math.random() * 1000000); const spec = await eventFixture(root, cwd, seed);
    const controller = await createTaskController({ spec, config: { ...loadConfig(), thinking: "off", maxTurns: 5, maxOutputTokens: 8192 }, dataDirectory: join(root, "state") }); context.after(() => controller.close());
    const state = await controller.start(context.signal); await writeFile(join(root, "validation.json"), JSON.stringify({ seed, state }, null, 2));
    assert.equal(state.status, "succeeded", state.reason); assert.equal(state.verifiedMilestones.length, 6);
  });
});

test("LT-11/LT-12: seeded six-module event CLI passes independent gates with complete-batch yielding", { timeout: 480_000 }, async context => {
  await scenario(context, "event-engineering", async ({ root, cwd }) => {
    const seed = Math.floor(Math.random() * 1000000); const spec = await eventFixture(root, cwd, seed); spec.completionPolicy = "verification";
    const config = { ...loadConfig(), maxTurns: 6, maxOutputTokens: 8192 };
    const controller = await createTaskController({ spec, config, dataDirectory: join(root, "state") }); context.after(() => controller.close());
    const events: unknown[] = []; controller.subscribe(e => events.push(e));
    const result = await controller.start(context.signal);
    await writeFile(join(root, "validation.json"), JSON.stringify({ seed, state: result, events }, null, 2));
    assert.equal(result.status, "succeeded", result.reason);
    assert.equal(result.verifiedMilestones.length, 6, "全部模块验收通过，不能把单模块成功当成整个工程交付");
    assert.ok(events.some(e => (e as { type: string; status?: string }).type === "task_run_completed" && (e as { status: string }).status === "yielded"), "真实完整批次由验收让出，省去模型完成声明");
  });
});

for (const repairable of [false, true]) test(`LT-06: real repeated regression ${repairable ? "stops after replan and delivers" : "blocks after finite replan"}`, { timeout: 240_000 }, async context => {
  await scenario(context, repairable ? "progress-positive" : "progress-stopped", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); spec.progressPolicy = { failureWindow: 1, maxReplans: 1 }; spec.limits = { maxRuns: 8, maxRepairs: 6, maxModelRequests: 20 };
    const config = { ...loadConfig(), maxTurns: 2, maxOutputTokens: 2048 };
    let replanned = false;
    const controller = await createTaskController({ spec, config, dataDirectory: join(root, "state"), testHooks: {
      barrier: async name => { if (name === "strategy_replanned") replanned = true; },
      beforeVerification: async () => { if (!repairable || !replanned) await writeFile(join(cwd, "lib/value.mts"), "export function value():number{return 0}\n"); },
    } }); context.after(() => controller.close());
    const state = await controller.start(context.signal); await writeFile(join(root, "final-state.json"), JSON.stringify(state, null, 2));
    assert.equal(state.status, repairable ? "succeeded" : "blocked", state.reason);
    assert.equal(state.progress?.replans, 1, "有限真实策略请求，不无限续接");
    assert.ok(Object.values(state.modelRequests ?? {}).some(r => r.purpose === "replan"), "策略调用也进入统一账本");
    if (!repairable) assert.match(state.reason ?? "", /no_progress/);
  });
});

test("RT-01/02: classified transport retries are finite and real model continuation shares request budget", { timeout: 120_000 }, async context => {
  await scenario(context, "retry-real-continuation", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); spec.retryPolicy = { maxRetries: 2, maxWaitMs: 1000, delayMs: 10 }; spec.completionPolicy = "verification";
    const config = loadConfig(); const pi = new PiModelGateway(config); let attempt = 0;
    const gateway: ModelGateway = { async *stream(request, signal) { if (++attempt <= 2) throw new Error("503 Service unavailable (controlled transport fault)"); yield* pi.stream(request, signal); } };
    const controller = await createTaskController({ spec, config, gateway, dataDirectory: join(root, "state") }); context.after(() => controller.close());
    const state = await controller.start(context.signal); await writeFile(join(root, "final-state.json"), JSON.stringify(state, null, 2));
    assert.equal(state.status, "succeeded", state.reason); assert.equal(state.retry?.attempts, 2);
    assert.ok(Object.values(state.modelRequests ?? {}).filter(r => r.status === "failed").length === 2 && Object.values(state.modelRequests ?? {}).some(r => r.purpose === "retry" && r.status === "completed"), "失败和真实重试逐次预算，不重放工具");
  });
});

test("BD-01: real token time cost usage survives audited budget adjustment and recovery", { timeout: 180_000 }, async context => {
  await scenario(context, "cumulative-budgets", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); spec.limits = { ...spec.limits, maxRuns: 1, maxRepairs: 0, maxModelRequests: 1, maxTokens: 100000, maxDurationMs: 300000, maxCostUsd: 1, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } };
    const config = { ...loadConfig(), thinking: "off" as const }; const dataDirectory = join(root, "state");
    const controller = await createTaskController({ spec, config, dataDirectory, testHooks: { beforeVerification: async () => { await writeFile(join(cwd, "lib/value.mts"), "export function value():number{return 0}\n"); } } }); context.after(() => controller.close());
    const initial = await controller.start(context.signal); assert.equal(initial.status, "budget_exhausted"); const id = controller.id; await controller.close();
    const usage = modelBudgetUsage(initial); assert.ok(usage.tokens > 0 && usage.durationMs > 0 && usage.costUsd > 0, "真实 usage 与工具/验收时间累计，不按目录零价估算免费");
    const command = { id: "raise-model-budget", type: "adjust_budget" as const, limits: { ...spec.limits, maxModelRequests: 6 }, expectedVersion: 1, reason: "允许有限继续完成已定义合同" };
    const first = await sendTaskCommand({ taskId: id, dataDirectory, command }); const duplicate = await sendTaskCommand({ taskId: id, dataDirectory, command }); assert.equal(first.seq, duplicate.seq);
    const limited = await openTaskController({ taskId: id, config, dataDirectory }); context.after(() => limited.close());
    const runExhausted = await limited.resume(context.signal); await limited.close();
    assert.equal(runExhausted.status, "budget_exhausted"); assert.match(runExhausted.reason ?? "", /max_runs/);
    assert.equal(Object.keys(runExhausted.modelRequests ?? {}).length, Object.keys(initial.modelRequests ?? {}).length, "只增加请求额度不能绕过执行次数额度");
    const executionCommand = { id: "raise-execution-budget", type: "adjust_budget" as const, limits: { ...command.limits, maxRuns: 6, maxRepairs: 2 }, expectedVersion: 2, reason: "核查后增加有限执行与修复额度" };
    const next = await sendTaskCommand({ taskId: id, dataDirectory, command: executionCommand });
    assert.equal(next.seq, (await sendTaskCommand({ taskId: id, dataDirectory, command: executionCommand })).seq);
    const restored = await openTaskController({ taskId: id, config, dataDirectory }); context.after(() => restored.close()); const state = await restored.resume(context.signal);
    await writeFile(join(root, "budget-report.json"), JSON.stringify({ initial, initialUsage: usage, runExhausted, state, finalUsage: modelBudgetUsage(state) }, null, 2));
    assert.equal(state.status, "succeeded", state.reason); assert.equal(state.budgetVersion, 3); assert.ok(state.runs > initial.runs && Object.keys(state.modelRequests ?? {}).length > Object.keys(initial.modelRequests ?? {}).length, "增加额度不会改写既有预留与执行计数");
  });
});

test("LT-03/LT-05/LT-06: six-module CLI retains early summary and repairs regression after bounded replan", { timeout: 900_000 }, async context => {
  await scenario(context, "event-context-progress-joint", async ({ root, cwd }) => {
    const seed = Math.floor(Math.random() * 1000000); const label = randomUUID(); const spec = await eventFixture(root, cwd, seed);
    await appendFile(join(cwd, "AGENTS.md"), "CLI 最终交付另需 src/run-label.txt，复制早期宿主诊断的 runLabel；不得编造，不在工作区提示文件保存标签。\n");
    const gate = join(root, "control", "verify-label.mjs"); await writeFile(gate, `import{readFileSync}from'node:fs';let passed=0;try{passed=readFileSync(${JSON.stringify(join(cwd, "src/run-label.txt"))},'utf8').trim()===${JSON.stringify(label)}?1:0}catch{}console.log(JSON.stringify({checks:1,passed,failures:passed?[]:['early label missing or mismatch']}));process.exitCode=1-passed;`);
    spec.verifiers.push({ id: "label", description: "src/run-label.txt 保留早期 runLabel，实际文件对照宿主标签", command: process.execPath, args: [gate], inputs: ["src"], trustedFiles: [gate], outputs: ["src/run-label.txt"], timeoutMs: 5000 }); spec.milestones.at(-1)!.verificationIds.push("label"); spec.finalVerificationIds.push("label");
    spec.completionPolicy = "verification";
    spec.contextPolicy = { softTokens: 40000, hardTokens: 250000, keepRecentTokens: 10000, reserveOutputTokens: 8192 }; spec.progressPolicy = { failureWindow: 2, maxReplans: 1 }; spec.limits.maxModelRequests = 80;
    const initialReports = spec.verifiers.filter(v => v.id !== "label").map(v => spawnSync(v.command, v.args, { cwd, encoding: "utf8" }).stdout).join("\n");
    const material = `runLabel=${label}\n实际初始验收报告（重复作为大诊断材料）：\n` + initialReports.repeat(35); const diagnosticPath = join(root, "control", "initial-diagnostics.txt"); await writeFile(diagnosticPath, material);
    const config = { ...loadConfig(), thinking: "off" as const, maxTurns: 8 }; const pi = new PiModelGateway(config);
    const isolated = await ContainerExecutionHost.create({ image: "node:24-bookworm-slim", workspace: cwd }); context.after(() => isolated.close());
    await isolated.restoreProcessGroups(join(root, "isolated-shell-processes.jsonl"));
    const tools = createCodingTools(await LocalEnvironment.create(cwd, config.toolTimeoutMs, isolated, ["src"]));
    const shell = tools.find(tool => tool.name === "shell")!;
    shell.version = "container-v1"; shell.description = "Run bash in the isolated Linux container, cwd /workspace. Only project files are mounted; host diagnostics and Agent state are inaccessible. Use relative project paths and Node built-ins for real checks.";
    const gateway: ModelGateway = { async *stream(request, signal) { await appendFile(join(root, "requests.jsonl"), JSON.stringify({ purpose: request.purpose, messages: request.messages, bytes: Buffer.byteLength(JSON.stringify(request)) }) + "\n"); yield* pi.stream(request, signal); } };
    let injected = false; let replanned = false; let dedupInjections = 0; let controller: Awaited<ReturnType<typeof createTaskController>>;
    controller = await createTaskController({ spec, config, gateway, services: { codingTools: tools }, dataDirectory: join(root, "state"), testHooks: {
      barrier: async name => { if (name === "input_accepted" && !injected) { injected = true; await controller.appendContextMaterial(await readFile(diagnosticPath, "utf8")); } if (name === "strategy_replanned") replanned = true; },
      beforeVerification: async ({ phase, milestoneId }) => { if (phase === "milestone" && milestoneId === "M3" && !replanned) { dedupInjections++; await writeFile(join(cwd, "src/dedup.mts"), "export function dedup(events:any[]):any[]{return events}\n"); } },
    } }); context.after(() => controller.close());
    const state = await controller.start(context.signal); await writeFile(join(root, "validation.json"), JSON.stringify({ seed, state }, null, 2));
    assert.equal(state.status, "succeeded", state.reason); assert.equal(state.progress?.replans, 1); assert.ok(dedupInjections >= 2, "实际去重缺陷连续验收失败后才调整策略和停止覆盖"); assert.equal((await readFile(join(cwd, "src/run-label.txt"), "utf8")).trim(), label);
    assert.ok(Object.values(state.modelRequests ?? {}).some(r => r.purpose === "summary") && Object.values(state.modelRequests ?? {}).some(r => r.purpose === "replan"), "联合任务真实摘要与策略调用共同进入账本");
    const session = await readFile(join(root, "state", "sessions", state.sessionId + ".jsonl"), "utf8");
    assert.ok(session.split("\n").filter(Boolean).map(line => JSON.parse(line)).some(entry => entry.kind === "context_compacted" && entry.summary.includes(label)), "早期标签必须在真实已提交摘要中，不能靠读取宿主日志补交");
  });
});
