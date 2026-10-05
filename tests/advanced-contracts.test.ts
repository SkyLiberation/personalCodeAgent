import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { PassThrough, Writable } from "node:stream";
import { once } from "node:events";
import { createAgentSession, createTaskController, openTaskController, SessionRepository, RequestContext, ContextCapacityError, createExecutionHost, branchSession, runWorkflow, modelBudgetUsage, sendTaskCommand, serveSessionRpc } from "../src/index.js";
import { valueFixture } from "./e2e/value-fixture.js";
import { fixture, FakeGateway, assistant, config } from "./helpers.js";
import type { AgentTool, ModelMessage, TaskState, ContextPolicy } from "../src/index.js";

test("committed context projection preserves native complete groups, raw history and durable boundary", async context => {
  const f = await fixture(context); const host = await createExecutionHost(); f.cleanupAfter(() => host.close());
  const repo = await SessionRepository.open({ directory: f.dataDirectory, cwd: f.cwd, host });
  const native = { adapter: "pi-ai" as const, message: { role: "assistant", signature: "immutable-native-signature" } };
  await repo.appendMessage({ role: "user", text: "EARLY_NONCE " + "diagnostic ".repeat(1500), timestamp: 1 });
  await repo.appendMessage({ ...assistant("", [{ id: "read-a", name: "read", arguments: {} }]), providerData: native });
  await repo.appendMessage({ role: "tool_result", callId: "read-a", toolName: "read", text: "actual-result", isError: false, timestamp: 2 });
  await repo.appendMessage({ role: "user", text: "continue", timestamp: 3 });
  const original = repo.messages(); const gateway = new FakeGateway(() => assistant("EARLY_NONCE, keep actual file state and failures"));
  const policy = { softTokens: 7000, hardTokens: 50000, keepRecentTokens: 1000, reserveOutputTokens: 1000 };
  const projection = await new RequestContext(repo, gateway, policy, { contract: () => "CURRENT_MILESTONE" }).build([], context.signal);
  assert.ok(JSON.stringify(projection).length < JSON.stringify(original).length && JSON.stringify(projection).includes("EARLY_NONCE"));
  assert.deepEqual(repo.messages(), original, "投影不能改写权威历史");
  assert.ok(projection.at(-1)?.role === "user" && (projection.at(-1) as { text: string }).text.includes("CURRENT_MILESTONE"), "当前合同优先于旧阶段摘要");
  const id = repo.id; await repo.close();
  const reopened = await SessionRepository.open({ directory: f.dataDirectory, cwd: f.cwd, sessionId: id, host }); f.cleanupAfter(() => reopened.close());
  const reuse = new RequestContext(reopened, new FakeGateway(() => { throw new Error("must not resummarize"); }), policy);
  assert.ok(JSON.stringify(await reuse.build([], context.signal)).includes("EARLY_NONCE"));
  const copy = await branchSession(reopened, { directory: join(f.root, "branches"), host }); f.cleanupAfter(() => copy.close());
  assert.deepEqual(copy.messages(), original, "分支保留完整消息，原始会话保持不变");
  await reopened.appendMessage(assistant("", [{ id: "pending-effect", name: "write", arguments: {} }]));
  await assert.rejects(branchSession(reopened, { directory: join(f.root, "unsafe-branch"), host }), /branch_unresolved_effects/);
});

test("orphan summary cannot replace history; required context exceeding capacity fails explicitly", async context => {
  const f = await fixture(context); const repo = await SessionRepository.open({ directory: f.dataDirectory, cwd: f.cwd }); f.cleanupAfter(() => repo.close());
  assert.throws(() => new RequestContext(repo, new FakeGateway(() => assistant()), {} as ContextPolicy), /context_policy_invalid/, "缺少必需阈值的外部配置必须在请求前拒绝");
  await repo.appendMessage({ role: "user", text: "original " + "x".repeat(8000), timestamp: 1 }); await repo.appendMessage({ role: "user", text: "continue", timestamp: 2 });
  const builder = new RequestContext(repo, new FakeGateway(() => assistant("summary")), { softTokens: 5000, hardTokens: 50000, keepRecentTokens: 1000, reserveOutputTokens: 1000 }, { barrier: async () => { throw new Error("crash-before-commit"); } });
  await assert.rejects(builder.build([], context.signal), /crash-before-commit/);
  assert.ok(!repo.facts().some(e => e.kind === "context_compacted") && repo.messages()[0]?.role === "user");
  const hard = new RequestContext(repo, new FakeGateway(() => assistant()), { softTokens: 500, hardTokens: 2000, keepRecentTokens: 100, reserveOutputTokens: 100 }, { contract: () => "x".repeat(3000) });
  await assert.rejects(hard.build([], context.signal), ContextCapacityError);
});

test("durable input IDs deduplicate and consumed message recovers without a second injection", async context => {
  const f = await fixture(context); const gateway = new FakeGateway(() => assistant("accepted"));
  let session = await createAgentSession({ config, cwd: f.cwd, dataDirectory: f.dataDirectory, durableInbox: true, gateway });
  const receipt = await session.acceptInput("persist this request", "follow_up", { inputId: "stable" }); await session.waitInput(receipt.inputId);
  const id = session.id; await session.close();
  session = await createAgentSession({ config, cwd: f.cwd, dataDirectory: f.dataDirectory, sessionId: id, durableInbox: true, gateway }); f.cleanupAfter(() => session.close());
  assert.equal((await session.acceptInput("persist this request", "follow_up", { inputId: "stable" })).status, "settled");
  await assert.rejects(session.acceptInput("conflicting", "follow_up", { inputId: "stable" }), /input_id_conflict/);
  assert.equal(session.repository.messages().filter(m => m.role === "user" && m.text === "persist this request").length, 1);
  assert.equal(gateway.requests.length, 1, "已结算的输入重交不再请求模型");
});

test("parallel-safe independent reads complete before ordered results and serial writes", async context => {
  const f = await fixture(context); let active = 0; let maximum = 0; const completion: string[] = [];
  const tools: AgentTool[] = ["slow", "fast"].map((name, index) => ({ name, description: name, parameters: {}, effect: "read", replay: "safe", parallelSafe: true,
    validate: a => a, async execute() { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, index ? 5 : 30)); active--; completion.push(name); return { text: name, isError: false }; } }));
  tools.push({ name: "write", description: "write", parameters: {}, effect: "write", replay: "never", parallelSafe: true, validate: a => a, async execute() { assert.equal(active, 0); completion.push("write"); return { text: "wrote", isError: false }; } });
  const gateway = new FakeGateway((_r, _s, i) => i ? assistant() : assistant("", tools.map((tool, i) => ({ id: String(i), name: tool.name, arguments: {} }))));
  const session = await createAgentSession({ config, cwd: f.cwd, dataDirectory: f.dataDirectory, gateway, tools, maxReadConcurrency: 2 }); f.cleanupAfter(() => session.close());
  await session.submit("read both then write"); assert.equal(maximum, 2); assert.deepEqual(completion, ["fast", "slow", "write"]);
  assert.deepEqual(session.repository.messages().filter(m => m.role === "tool_result").map(m => m.toolName), ["slow", "fast", "write"]);
});

test("workflow refuses cycles and gates dependent agents on independently verified task success", async context => {
  const state = { status: "succeeded", finalEvidenceIds: ["host-gate"] } as TaskState; let dependent = false;
  const result = await runWorkflow([{ id: "a", dependsOn: [], run: async () => ({ ...state, status: "blocked" }) }, { id: "b", dependsOn: ["a"], run: async () => { dependent = true; return state; } }], { concurrency: 2, signal: context.signal });
  assert.ok(!dependent && result.b?.status === "blocked");
  await assert.rejects(runWorkflow([{ id: "a", dependsOn: ["b"], run: async () => state }, { id: "b", dependsOn: ["a"], run: async () => state }], { concurrency: 2, signal: context.signal }), /workflow_cycle/);
});

test("unknown token reservation blocks another attempt and resume only verifies until audited increase", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.limits.maxTokens = 25000;
  const gateway = new FakeGateway(() => assistant("", [{ id: "read", name: "read", arguments: { path: "lib/value.mts" } }]));
  let controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory });
  const first = await controller.start(); const id = controller.id; await controller.close();
  assert.ok(first.status === "budget_exhausted" && modelBudgetUsage(first).tokens > 0 && Object.values(first.modelRequests ?? {}).every(r => r.usage === undefined), "未知 token 按预留计入，不能当零");
  const count = gateway.requests.length;
  controller = await openTaskController({ taskId: id, config, gateway, dataDirectory: f.dataDirectory });
  const restored = await controller.resume(); await controller.close(); assert.equal(gateway.requests.length, count); assert.equal(restored.runs, first.runs, "恢复不能通过新 run 绕过不足的预留余量");
  const command = { id: "raise", type: "adjust_budget" as const, limits: { ...spec.limits, maxTokens: 60000 }, expectedVersion: 1, reason: "explicit host increase" };
  await sendTaskCommand({ taskId: id, dataDirectory: f.dataDirectory, command });
  await sendTaskCommand({ taskId: id, dataDirectory: f.dataDirectory, command });
  const fixed = new FakeGateway(() => assistant("", [{ id: "write", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }]));
  controller = await openTaskController({ taskId: id, config, gateway: fixed, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => controller.close());
  const final = await controller.resume(); assert.ok(final.status === "succeeded" && final.budgetVersion === 2 && modelBudgetUsage(final).tokens >= modelBudgetUsage(first).tokens);
});

test("run and repair exhaustion permit reverification and only audited increases permit another execution", async context => {
  for (const budget of ["maxRuns", "maxRepairs"] as const) {
    const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.completionPolicy = "verification";
    spec.limits[budget] = budget === "maxRuns" ? 1 : 0;
    const gateway = new FakeGateway(() => assistant());
    let controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory });
    const first = await controller.start(); const id = controller.id; await controller.close();
    assert.equal(first.status, "budget_exhausted"); assert.match(first.reason ?? "", budget === "maxRuns" ? /max_runs/ : /max_repairs/);
    const requestCount = gateway.requests.length;
    controller = await openTaskController({ taskId: id, config, gateway, dataDirectory: f.dataDirectory });
    const reverified = await controller.resume(); await controller.close();
    assert.equal(reverified.status, "budget_exhausted"); assert.equal(gateway.requests.length, requestCount);
    assert.equal(reverified.runs, first.runs); assert.equal(reverified.repairs, first.repairs);
    assert.ok(reverified.evidence.length > first.evidence.length, "额度耗尽仍可核查当前文件，不能跳过复验或新增模型执行");
    await sendTaskCommand({ taskId: id, dataDirectory: f.dataDirectory, command: { id: "increase-exhausted-budget", type: "adjust_budget", limits: { ...spec.limits, [budget]: 4 }, expectedVersion: 1, reason: "explicit bounded continuation" } });
    const fixed = new FakeGateway(() => assistant("", [{ id: "repair", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }]));
    controller = await openTaskController({ taskId: id, config, gateway: fixed, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => controller.close());
    const final = await controller.resume();
    assert.equal(final.status, "succeeded", final.reason); assert.equal(final.budgetVersion, 2);
    assert.ok(final.runs > first.runs && final.repairs >= first.repairs && Object.keys(final.modelRequests ?? {}).length > Object.keys(first.modelRequests ?? {}).length, "继续交付仍累计旧计数");
  }
});

test("small cost/time limits and missing required input reject before provider dispatch", async context => {
  for (const policy of ["cost", "time", "input"] as const) {
    const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); const gateway = new FakeGateway(() => { throw new Error("must not dispatch"); });
    if (policy === "cost") { spec.limits.maxCostUsd = 0.000001; spec.limits.pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }; }
    if (policy === "time") spec.limits.maxDurationMs = 1;
    if (policy === "input") spec.requiredInputs = ["rates.json"];
    const controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => controller.close());
    const state = await controller.start(); assert.equal(gateway.requests.length, 0); assert.equal(state.status, policy === "input" ? "blocked" : "budget_exhausted");
    assert.match(state.reason ?? "", policy === "input" ? /required_input/ : /model_(cost|time)_budget_exhausted/);
  }
});

test("verification completion waits for the full tool batch and still honors final control", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd, 42, true); spec.completionPolicy = "verification";
  const delivery: AgentTool = { name: "delivery", description: "delivery", parameters: {}, effect: "write", replay: "never", validate: a => a, execute: async () => { await writeFile(join(f.root, "audit.jsonl"), '{}\n'); return { text: "registered", isError: false }; } };
  const gateway = new FakeGateway(() => assistant("", [{ id: "write", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }, { id: "delivery", name: "delivery", arguments: {} }]));
  const controller = await createTaskController({ spec, config, gateway, services: { tools: [delivery] }, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => controller.close());
  const result = await controller.start(); assert.equal(result.status, "succeeded"); assert.equal(gateway.requests.length, 1);
  const facts = await import("node:fs/promises").then(fs => fs.readFile(join(f.dataDirectory, "sessions", `${result.sessionId}.jsonl`), "utf8"));
  assert.ok(facts.includes('"toolName":"delivery"'), "批次后门禁之前交付副作用和结果都已提交");
});

test("verification completion cannot accept a missing delivery gate or override cancellation", async context => {
  for (const cancelled of [false, true]) {
    const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd, 42, !cancelled); spec.completionPolicy = "verification"; spec.limits.maxRepairs = 0;
    const gateway = new FakeGateway((_r, _s, i) => i ? assistant("done") : assistant("", [{ id: "write", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }]));
    let controller: Awaited<ReturnType<typeof createTaskController>>;
    controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory, testHooks: { barrier: async name => {
      if (cancelled && name === "tool_effect_completed:write") await sendTaskCommand({ taskId: controller.id, dataDirectory: f.dataDirectory, command: { id: "cancel", type: "cancel" } });
    } } }); f.cleanupAfter(() => controller.close());
    const result = await controller.start(); assert.equal(result.status, cancelled ? "cancelled" : "budget_exhausted");
    assert.equal(result.finalEvidenceIds.length, 0);
  }
});

test("host policy denies unconfirmed effects durably and explicit approval authorizes only that call", async context => {
  for (const allowed of [false, true]) {
    const f = await fixture(context); await writeFile(join(f.cwd, "value.txt"), "original");
    const gateway = new FakeGateway((_r, _s, i) => i ? assistant() : assistant("", [{ id: "write", name: "write", arguments: { path: "value.txt", content: "approved" } }]));
    const session = await createAgentSession({ config, cwd: f.cwd, dataDirectory: f.dataDirectory, gateway,
      toolPolicy: async () => ({ action: "confirm", reason: "host confirmation required" }), ...(allowed ? { confirmTool: async () => true } : {}) }); f.cleanupAfter(() => session.close());
    await session.submit("write the value"); const fs = await import("node:fs/promises"); assert.equal(await fs.readFile(join(f.cwd, "value.txt"), "utf8"), allowed ? "approved" : "original");
    assert.ok(session.repository.facts().some(fact => fact.kind === "tool_policy" && fact.action === (allowed ? "allow" : "deny")), "准入决策提交后才允许工具效果");
  }
});

test("activity reservation persistence failure refuses returned tool effects", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd);
  const gateway = new FakeGateway(() => assistant("", [{ id: "write", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }]));
  const controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => controller.close());
  const append = controller.repository.append.bind(controller.repository);
  controller.repository.append = async fact => { if (fact.type === "activity_reserved") throw new Error("disk unavailable"); return append(fact); };
  await assert.rejects(controller.start(), /persistence_error/);
  const fs = await import("node:fs/promises"); assert.ok((await fs.readFile(join(f.cwd, "lib/value.mts"), "utf8")).includes("return 0"));
});

test("persistent transport retry stops at its shared cap and invalid provider errors never retry", async context => {
  for (const message of ["429 rate limit", "400 invalid parameter"]) {
    const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.retryPolicy = { maxRetries: 2, maxWaitMs: 100, delayMs: 1 };
    const gateway = new FakeGateway(() => { throw new Error(message); });
    const controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => controller.close());
    const state = await controller.start(); const expected = message.startsWith("429") ? 3 : 1;
    assert.equal(state.status, "blocked"); assert.equal(gateway.requests.length, expected);
    assert.equal(Object.values(state.modelRequests ?? {}).filter(r => r.status === "failed").length, expected, "每个失败尝试仍占预算，不能执行返回工具");
  }
});

test("rejected write preparation is a tool error and can be corrected without weakening persistence failures", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd);
  const gateway = new FakeGateway((_r, _s, i) => i === 0 ? assistant("", [{ id: "outside", name: "write", arguments: { path: "../escape.mts", content: "must not execute" } }]) : i === 1 ? assistant("", [{ id: "valid", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }]) : assistant());
  const controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => controller.close());
  assert.equal((await controller.start()).status, "succeeded");
  const fs = await import("node:fs/promises"); await assert.rejects(fs.stat(join(f.root, "escape.mts")), { code: "ENOENT" });
});

test("invalid replan consumes its durable attempt and recovery cannot retry it", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd);
  spec.progressPolicy = { failureWindow: 1, maxReplans: 1 };
  const gateway = new FakeGateway(() => assistant("invalid planning output"));
  const controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory });
  const state = await controller.start(); const id = controller.id; await controller.close();
  assert.ok(state.status === "blocked" && state.reason?.includes("replan_response_invalid") && state.progress?.replans === 1);
  const reopened = await openTaskController({ taskId: id, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => reopened.close());
  const restored = await reopened.resume();
  assert.ok(restored.status === "blocked" && restored.reason?.includes("no_progress"));
  assert.equal(gateway.requests.filter(r => r.purpose === "replan").length, 1, "无效输出也不能在恢复后获得新策略额度");
});

test("quoted same-line advisory prose can guide a bounded repair without executing the plan", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd);
  spec.progressPolicy = { failureWindow: 1, maxReplans: 1 }; spec.completionPolicy = "verification";
  let replanned = false;
  const gateway = new FakeGateway(request => request.purpose === "replan"
    ? assistant('Diagnosis: value is incorrect.\n\nChanges: lib/value.mts must return the number "42", not a string.\n\nChecks: Import value() and compare it with 42.')
    : assistant("", [{ id: "write-" + Math.random(), name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }]));
  const controller = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory, testHooks: {
    barrier: async name => { if (name === "strategy_replanned") replanned = true; },
    beforeVerification: async () => { if (!replanned) await writeFile(join(f.cwd, "lib/value.mts"), "export function value(){return 0}"); },
  } }); f.cleanupAfter(() => controller.close());
  const state = await controller.start(); assert.ok(state.status === "succeeded" && state.progress?.replans === 1);
});

test("slow RPC display cannot block durable completion and receives resync after draining", async context => {
  const f = await fixture(context); let release: (() => void) | undefined; let stalled = true; const chunks: string[] = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { chunks.push(String(chunk)); if (stalled) release = callback; else callback(); } });
  const gateway = { async *stream() { for (let i = 0; i < 512; i++) yield { type: "text_delta" as const, delta: "progress " }; yield { type: "done" as const, message: assistant("done") }; } };
  const session = await createAgentSession({ config, cwd: f.cwd, dataDirectory: f.dataDirectory, gateway });
  const rpc = serveSessionRpc(session, new PassThrough(), output); f.cleanupAfter(() => rpc.close());
  const receipt = await session.acceptInput("complete despite slow display");
  assert.equal((await session.waitInput(receipt.inputId)).status, "completed");
  assert.ok(session.repository.facts().some(fact => fact.kind === "run_status" && fact.status === "completed"), "显示背压期间结果仍已持久提交");
  const drained = once(output, "drain"); stalled = false; release!(); await drained;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(chunks.some(chunk => chunk.includes('"method":"resync"')), "被省略的展示事件必须提示宿主重新查询持久状态");
});
