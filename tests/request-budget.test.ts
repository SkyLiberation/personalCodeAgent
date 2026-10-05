import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTaskController, openTaskController, BudgetedModelGateway } from "../src/index.js";
import type { ModelGateway } from "../src/contracts.js";
import { valueFixture } from "./e2e/value-fixture.js";
import { assistant, config, FakeGateway, fixture } from "./helpers.js";

test("last admitted tool batch completes and verified delivery can succeed with no further request", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.limits.maxModelRequests = 1;
  const gateway = new FakeGateway(() => assistant("", [
    { id: "first", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 41}" } },
    { id: "second", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } },
  ]));
  const c = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => c.close());
  assert.ok((await c.start()).status === "succeeded" && gateway.requests.length === 1,
    "最后一个获准响应的完整工具组执行后独立验收可成功，无需多发模型请求");
});

test("spent quota survives reopen; missing usage stays unknown; recovery only rechecks existing files", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.limits.maxModelRequests = 1;
  spec.limits.maxRepairs = 0;
  spec.milestones.push({ id: "M2", title: "再次核查交付接口", verificationIds: ["value"] });
  const gateway = new FakeGateway(() => assistant("", [{ id: "write", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }]));
  let c = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => c.close());
  const state = await c.start(); const id = c.id; await c.close();
  const request = Object.values(state.modelRequests ?? {})[0];
  assert.ok(state.status === "budget_exhausted" && request?.status === "completed" && request.usage === undefined,
    "没有供应商 usage 的完成请求仍消费额度且用量未知");
  await writeFile(join(f.cwd, "lib/value.mts"), "export function value(){return 0}");
  c = await openTaskController({ taskId: id, config, gateway, dataDirectory: f.dataDirectory });
  assert.ok((await c.resume()).reason?.startsWith("model_request_budget_exhausted"), "历史阶段回归也不能把请求额度耗尽变成永久禁止复验的 repair 状态"); await c.close();
  await writeFile(join(f.cwd, "lib/value.mts"), "export function value(){return 42}");
  c = await openTaskController({ taskId: id, config, gateway, dataDirectory: f.dataDirectory });
  assert.ok((await c.resume()).status === "succeeded" && gateway.requests.length === 1,
    "耗尽后恢复能复验宿主修复的交付件，不能请求模型或启动响应工具");
});

test("execution, summary, replan and retry share one serialized admission ledger", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.limits.maxModelRequests = 3;
  const gateway = new FakeGateway(() => assistant());
  const c = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => c.close());
  const ledger = new BudgetedModelGateway(gateway, { state: () => c.state, commit: async fact => { await c.repository.append(fact); } });
  for (const purpose of ["execution", "summary", "replan"] as const) {
    for await (const _ of ledger.stream({ messages: [], tools: [], purpose }, new AbortController().signal)) { /* Consume complete request. */ }
  }
  await assert.rejects(async () => { for await (const _ of ledger.stream({ messages: [], tools: [], purpose: "retry" }, new AbortController().signal)) {} }, /model_request_budget_exhausted/);
  assert.equal(gateway.requests.length, 3, "所有模型用途同用额度，拒绝后不能分派真实网关");
});

test("concurrent admissions cannot exceed the remaining global slot", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.limits.maxModelRequests = 1;
  const gateway = new FakeGateway(() => assistant());
  const c = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => c.close());
  const ledger = new BudgetedModelGateway(gateway, { state: () => c.state, commit: async fact => { await c.repository.append(fact); } });
  const request = async () => { for await (const _ of ledger.stream({ messages: [], tools: [] }, new AbortController().signal)) {} };
  const results = await Promise.allSettled([request(), request()]);
  assert.ok(results.filter(r => r.status === "fulfilled").length === 1 && gateway.requests.length === 1,
    "竞争同一剩余额度时只有一个请求获准");
});

test("request settlement failure cannot authorize returned tools", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.limits.maxModelRequests = 1;
  const response = assistant("", [{ id: "write", name: "write", arguments: { path: "lib/value.mts", content: "export function value(){return 42}" } }]);
  let c = await createTaskController({ spec, config, gateway: new FakeGateway(() => response), dataDirectory: f.dataDirectory,
    testHooks: { barrier: async name => { if (name === "model_response_received") await c.repository.close(); } } });
  f.cleanupAfter(() => c.close());
  await assert.rejects(c.start(), /persistence_error|存储已关闭/);
  assert.ok((await readFile(join(f.cwd, "lib/value.mts"), "utf8")).includes("return 0"), "结算持久化失败后响应工具不能产生效果");
});

test("reservation persistence failure prevents provider dispatch", async context => {
  const f = await fixture(context); const spec = await valueFixture(f.root, f.cwd); spec.limits.maxModelRequests = 1;
  const gateway: ModelGateway = { async *stream() { throw new Error("provider must not be called"); } };
  const c = await createTaskController({ spec, config, gateway, dataDirectory: f.dataDirectory }); f.cleanupAfter(() => c.close());
  const ledger = new BudgetedModelGateway(gateway, { state: () => c.state, commit: async () => { throw new Error("closed journal"); } });
  await assert.rejects(async () => { for await (const _ of ledger.stream({ messages: [], tools: [] }, new AbortController().signal)) {} }, /persistence_error.*预留/);
});
