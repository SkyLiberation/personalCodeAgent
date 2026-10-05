import test, { after } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTaskController, openTaskController, loadConfig, PiModelGateway, sendTaskCommand, type ModelGateway } from "../../src/index.js";
import { scenario, saveSuiteReport } from "./helpers.js";
import { valueFixture } from "./value-fixture.js";
import { phase2Worker, phase2Resume } from "./phase2-helpers.js";
after(saveSuiteReport);

test("LT-03: real committed summary preserves early label through reopen and delivers independently verified files", { timeout: 240_000 }, async context => {
  await scenario(context, "context-summary-reopen", async ({ root, cwd }) => {
    const label = randomUUID(); const spec = await valueFixture(root, cwd); spec.scope = { writablePaths: ["lib"] };
    spec.constraints = ["只修改 lib/value.mts 和 lib/label.txt"];
    await writeFile(join(cwd, "AGENTS.md"), "只修改 lib/value.mts 和 lib/label.txt。value() 返回任务要求的整数。label.txt 保存早期诊断 runLabel，不能编造。使用 write 工具交付；Node 内置模块，不安装依赖。\n");
    spec.outcome += " 同时写入 lib/label.txt，内容必须为早期宿主诊断中的 runLabel，不要编造；该标签只在早期会话材料中。";
    const gate = join(root, "control", "verify-label.mjs"); await writeFile(gate, `import{readFileSync}from'node:fs';let passed=0;try{passed=readFileSync(${JSON.stringify(join(cwd, "lib/label.txt"))},'utf8').trim()===${JSON.stringify(label)}?1:0}catch{}console.log(JSON.stringify({checks:1,passed,failures:passed?[]:['early runLabel missing or mismatch']}));process.exitCode=1-passed;`);
    spec.verifiers.push({ id: "label", description: "label.txt matches the earlier runLabel; use committed summary to retain earlier information", command: process.execPath, args: [gate], trustedFiles: [gate], inputs: ["lib"], outputs: ["lib/label.txt"], timeoutMs: 5000 });
    spec.milestones[0]!.verificationIds.push("label"); spec.finalVerificationIds.push("label"); spec.completionPolicy = "verification";
    spec.contextPolicy = { softTokens: 18000, hardTokens: 120000, keepRecentTokens: 4000, reserveOutputTokens: 4096 }; spec.limits.maxModelRequests = 20;
    const config = { ...loadConfig(), thinking: "off" as const }; const pi = new PiModelGateway(config);
    const gateway: ModelGateway = { async *stream(request, signal) {
      await appendFile(join(root, "requests.jsonl"), JSON.stringify({ purpose: request.purpose, messages: request.messages, bytes: Buffer.byteLength(JSON.stringify(request)) }) + "\n"); yield* pi.stream(request, signal);
    } };
    let injected = false; let paused = false; let controller: Awaited<ReturnType<typeof createTaskController>>;
    controller = await createTaskController({ spec, config, gateway, dataDirectory: join(root, "state"), testHooks: { barrier: async name => {
      if (name === "input_accepted" && !injected) { injected = true; await controller.appendContextMaterial(`runLabel=${label}\n真实诊断归档，保留 runLabel 用于 label.txt 交付。\n` + "diagnostic line: module pending, no verification yet\n".repeat(450)); }
      if (name === "context_compacted" && controller.contextSummary?.includes(label) && !paused) { paused = true; await sendTaskCommand({ taskId: controller.id, dataDirectory: join(root, "state"), command: { id: "pause-summary", type: "pause" } }); }
    } } });
    context.after(() => controller.close()); const initial = await controller.start(context.signal); const id = controller.id; await controller.close(); assert.equal(initial.status, "paused");
    const files = await readdir(join(root, "state", "sessions")); const sessionPath = join(root, "state", "sessions", files.find(f => f.endsWith(".jsonl"))!);
    const committed = (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l));
    const summary = committed.findLast(e => e.kind === "context_compacted"); assert.ok(summary?.summary.includes(label), "标签由真实模型摘要保留，未机械写入合同");
    assert.ok(committed.some(e => e.kind === "message" && e.message.text?.includes("diagnostic line:")), "原始诊断仍在事实日志");
    const restored = await openTaskController({ taskId: id, config, gateway, dataDirectory: join(root, "state") }); context.after(() => restored.close());
    const state = await restored.resume(context.signal); await writeFile(join(root, "final-state.json"), JSON.stringify(state, null, 2)); assert.equal(state.status, "succeeded", state.reason);
    const requests = (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    const summaryRequest = requests.filter(r => r.purpose === "summary").at(-1);
    assert.ok(summaryRequest && requests.filter(r => r.purpose !== "summary").every(r => r.bytes < summaryRequest.bytes && !r.messages.some((m: { text?: string }) => m.text?.includes("diagnostic line: module pending, no verification yet\n".repeat(20)))), "实际执行请求使用缩减投影，不再引入已归档前缀");
    assert.equal((await readFile(join(cwd, "lib/label.txt"), "utf8")).trim(), label);
  });
});

for (const boundary of ["inbox_accepted", "inbox_consumed"] as const) test(`IN-01/02: ${boundary} survives process crash and real model resumes one input`, { timeout: 180_000 }, async context => {
  await scenario(context, boundary, async ({ root, cwd }) => {
    await valueFixture(root, cwd);
    const launch = (mode: string, id?: string) => fork(new URL("./inbox-worker.ts", import.meta.url), [mode, root, cwd, mode === "start" ? boundary : "", ...(id ? [id] : [])], { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const child = launch("start"); child.stdout?.on("data", data => { void appendFile(join(root, "worker.log"), data); }); child.stderr?.on("data", data => { void appendFile(join(root, "worker.stderr.log"), data); });
    context.after(() => { child.kill("SIGKILL"); });
    const barrier = await new Promise<{ sessionId: string }>((resolve, reject) => { child.on("message", m => { if ((m as { type: string }).type === "barrier") resolve(m as { sessionId: string }); }); child.once("error", reject); child.once("exit", code => reject(new Error(`worker exited ${code}`))); });
    const exit = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exit;
    const restored = launch("resume", barrier.sessionId); context.after(() => { restored.kill("SIGKILL"); });
    restored.stdout?.on("data", data => { void appendFile(join(root, "restored.log"), data); }); restored.stderr?.on("data", data => { void appendFile(join(root, "restored.stderr.log"), data); });
    const result = await new Promise<{ result: { status: string } }>((resolve, reject) => { restored.on("message", m => { if ((m as { type: string }).type === "result") resolve(m as { result: { status: string } }); }); restored.once("error", reject); restored.once("exit", code => reject(new Error(`restored worker exited ${code}`))); });
    assert.equal(result.result.status, "completed"); assert.equal((await import(pathToFileURL(join(cwd, "lib/value.mts")).href)).value(), 42);
    const facts = (await readFile(join(root, "inbox", `${barrier.sessionId}.jsonl`), "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l));
    assert.equal(facts.filter(e => e.kind === "inbox_consumed" && e.inputId === "durable-input").length, 1, "跨进程消费不重复注入已确认输入");
  });
});

for (const boundary of ["context_summary_generated", "context_compacted"] as const) test(`LT-03B: actual summary at ${boundary} obeys cross-process commit boundary`, { timeout: 180_000 }, async context => {
  await scenario(context, boundary, async ({ root, cwd }) => {
    const label = randomUUID(); const spec = await valueFixture(root, cwd); spec.contextPolicy = { softTokens: 16000, hardTokens: 150000, keepRecentTokens: 3000, reserveOutputTokens: 4096 };
    await writeFile(join(root, "context-material.txt"), `early runLabel=${label}\n` + "diagnostic: pending value implementation, preserve early identifiers\n".repeat(400));
    if (boundary === "context_compacted") await writeFile(join(root, "context-barrier-label.txt"), label);
    await writeFile(join(root, "audit-model-enabled"), "1"); const taskPath = join(root, "task.json"); await writeFile(taskPath, JSON.stringify(spec));
    const worker = phase2Worker(root, "start", taskPath, boundary); context.after(() => worker.close()); const id = String((await worker.wait("task")).id); await worker.wait("barrier"); await worker.close();
    const files = await readdir(join(root, "state", "sessions")); const sessionPath = join(root, "state", "sessions", files.find(f => f.endsWith(".jsonl"))!);
    const before = (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l));
    const summaries = before.filter(e => e.kind === "context_compacted");
    assert.ok(boundary === "context_summary_generated" ? summaries.length === 0 : summaries.some(e => e.summary.includes(label)), "生成未提交不能生效；已提交的边界可查询");
    const state = await phase2Resume(root, id); assert.equal(state.status, "succeeded", state.reason);
    const after = (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean).map(l => JSON.parse(l));
    if (boundary === "context_compacted") assert.equal(after.filter(e => e.kind === "context_compacted").length, summaries.length, "新进程重用已提交摘要，不重新发送归档前缀");
    assert.ok(after.some(e => e.kind === "message" && e.message.text?.includes(label)), "真实原始材料未改写");
    await writeFile(join(root, "final-state.json"), JSON.stringify(state, null, 2));
  });
});
