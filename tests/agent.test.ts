import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentEvent, AgentTool } from "../src/contracts.js";
import { createAgentSession } from "../src/harness/session.js";
import { abortError } from "../src/security.js";
import { assistant, config, FakeGateway, fixture } from "./helpers.js";

test("multiple tools feed their actual results into the next model turn", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "hello.txt"), "hello world");
  const gateway = new FakeGateway((_request, _signal, index) => index === 0 ? assistant("", [
    { id: "read-1", name: "read", arguments: { path: "hello.txt" } },
    { id: "write-1", name: "write", arguments: { path: "result.txt", content: "result" } },
  ]) : assistant("verified"));
  const session = await createAgentSession({ ...f, config, gateway });
  f.cleanupAfter(() => session.close());
  const events: AgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  const result = await session.submit("do the work");
  assert.equal(result.status, "completed");
  assert.equal(result.turns, 2);
  assert.equal(await readFile(join(f.cwd, "result.txt"), "utf8"), "result");
  const results = gateway.requests[1]!.messages.filter((message) => message.role === "tool_result");
  assert.deepEqual(results.map((message) => message.callId), ["read-1", "write-1"]);
  assert.match(results[0]!.text, /hello world/);
  assert.equal(events.at(-1)?.type, "run_settled");
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
});

test("validation and unknown tools return paired errors without side effects", async (t) => {
  const f = await fixture(t);
  const gateway = new FakeGateway((_r, _s, index) => index === 0 ? assistant("", [
    { id: "invalid", name: "write", arguments: { path: "out.txt", content: 3 } },
    { id: "unknown", name: "imaginary", arguments: {} },
  ]) : assistant());
  const session = await createAgentSession({ ...f, config, gateway });
  f.cleanupAfter(() => session.close());
  assert.equal((await session.submit("task")).status, "completed");
  const results = gateway.requests[1]!.messages.filter((m) => m.role === "tool_result");
  assert.equal(results.length, 2);
  assert.ok(results.every((m) => m.isError));
  assert.ok(!(await readdir(f.cwd)).includes("out.txt"));
});

test("read-only policy removes mutating tools and rejects forced calls", async (t) => {
  const f = await fixture(t);
  const gateway = new FakeGateway((_r, _s, index) => index === 0 ? assistant("", [
    { id: "denied", name: "write", arguments: { path: "out.txt", content: "no" } },
  ]) : assistant());
  const session = await createAgentSession({ ...f, config, gateway, readonly: true });
  f.cleanupAfter(() => session.close());
  assert.equal((await session.submit("task")).status, "completed");
  assert.deepEqual(gateway.requests[0]!.tools.map((tool) => tool.name), ["read"]);
  assert.match(gateway.requests[1]!.messages.find((m) => m.role === "tool_result")!.text, /禁用/);
  assert.deepEqual(await readdir(f.cwd), []);
});

test("length-truncated tool calls are never executed", async (t) => {
  const f = await fixture(t);
  const gateway = new FakeGateway((_r, _s, index) => index === 0 ? {
    ...assistant("", [{ id: "partial", name: "write", arguments: { path: "bad.txt", content: "bad" } }]),
    stopReason: "length",
  } : assistant());
  const session = await createAgentSession({ ...f, config, gateway });
  f.cleanupAfter(() => session.close());
  assert.equal((await session.submit("task")).status, "completed");
  assert.deepEqual(await readdir(f.cwd), []);
  const result = gateway.requests[1]!.messages.find((m) => m.role === "tool_result")!;
  assert.ok(result.isError);
  assert.match(result.text, /截断/);
});

test("an endless tool loop stops at the configured turn budget", async (t) => {
  const f = await fixture(t);
  const gateway = new FakeGateway((_r, _s, index) => assistant("", [{
    id: `read-${index}`, name: "read", arguments: { path: "." },
  }]));
  const session = await createAgentSession({ ...f, config: { ...config, maxTurns: 2 }, gateway });
  f.cleanupAfter(() => session.close());
  const result = await session.submit("task");
  assert.equal(result.status, "budget_exhausted");
  assert.equal(gateway.requests.length, 2);
});

test("aborting a model request settles as aborted", async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const gateway = new FakeGateway((_request, signal) => new Promise((_resolve, reject) => {
    entered.resolve();
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  }));
  const session = await createAgentSession({ ...f, config, gateway });
  f.cleanupAfter(() => session.close());
  const result = session.submit("task");
  await entered.promise;
  session.abort();
  assert.equal((await result).status, "aborted");
});

test("aborting a running tool prevents subsequent tools in its batch", async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  let laterExecutions = 0;
  const tool: AgentTool = {
    name: "wait", description: "wait", parameters: {}, effect: "read", replay: "safe", validate: (input) => input,
    execute: (_args, context) => new Promise((_resolve, reject) => {
      entered.resolve();
      context.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    }),
  };
  const later: AgentTool = { ...tool, name: "later", execute: async () => {
    laterExecutions++;
    return { text: "later", isError: false };
  } };
  const gateway = new FakeGateway(() => assistant("", [
    { id: "wait", name: "wait", arguments: {} }, { id: "later", name: "later", arguments: {} },
  ]));
  const session = await createAgentSession({ ...f, config, gateway, tools: [tool, later] });
  f.cleanupAfter(() => session.close());
  const task = session.submit("task");
  await entered.promise;
  session.abort();
  assert.equal((await task).status, "aborted");
  assert.equal(laterExecutions, 0);
});

test("steering enters after the entire current tool batch", async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const order: string[] = [];
  const tool: AgentTool = {
    name: "wait", description: "wait", parameters: {}, effect: "read", replay: "safe", validate: (input) => input,
    execute: async (_args, context) => {
      order.push(context.callId);
      if (context.callId === "first") { entered.resolve(); await release.promise; }
      return { text: context.callId, isError: false };
    },
  };
  const gateway = new FakeGateway((_r, _s, index) => index === 0 ? assistant("", [
    { id: "first", name: "wait", arguments: {} }, { id: "second", name: "wait", arguments: {} },
  ]) : assistant());
  const session = await createAgentSession({ ...f, config, gateway, tools: [tool] });
  f.cleanupAfter(() => session.close());
  const task = session.submit("original");
  await entered.promise;
  assert.equal(await session.steer("new direction", { inputId: "active-steer" }), "queued");
  const steered = session.waitInput("active-steer");
  release.resolve();
  assert.equal((await task).status, "completed");
  assert.equal((await steered).status, "completed", "活动 steering 有独立 ID 的最终回执，且只能在消费与结果提交后完成");
  assert.deepEqual(order, ["first", "second"]);
  const messages = gateway.requests[1]!.messages;
  assert.equal(messages.at(-1)?.role, "user");
  assert.equal(messages.at(-1)?.text, "new direction");
  assert.equal(messages.at(-2)?.role, "tool_result");
});

test("follow-ups and immediate resubmission do not get lost at settlement", async (t) => {
  const f = await fixture(t);
  const gateway = new FakeGateway(() => assistant());
  const session = await createAgentSession({ ...f, config, gateway });
  f.cleanupAfter(() => session.close());
  const first = session.submit("one");
  await assert.rejects(session.submit("rejected"), /正在运行/);
  const second = session.submit("two", "follow_up");
  assert.equal((await first).status, "completed");
  assert.equal((await second).status, "completed");
  assert.equal((await session.submit("three")).status, "completed");
  assert.equal(gateway.requests.length, 3);
});

test("secrets are removed from events, model context, logs and output attachments", async (t) => {
  const f = await fixture(t);
  const tool: AgentTool = {
    name: "large", description: "large", parameters: {}, effect: "read", replay: "safe", validate: (input) => input,
    execute: async () => ({ text: config.apiKey + "x".repeat(40_000), isError: false }),
  };
  const gateway = new FakeGateway((_r, _s, index) => index === 0
    ? assistant(config.apiKey, [{ id: "large", name: "large", arguments: {} }]) : assistant());
  const session = await createAgentSession({ ...f, config, gateway, tools: [tool] });
  f.cleanupAfter(() => session.close());
  const events: AgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  assert.equal((await session.submit(`never leak ${config.apiKey}`)).status, "completed");
  assert.ok(!JSON.stringify(events).includes(config.apiKey));
  assert.ok(!JSON.stringify(gateway.requests).includes(config.apiKey));
  assert.ok(!(await readFile(session.repository.path, "utf8")).includes(config.apiKey));
  const completed = events.find((event) => event.type === "tool_completed");
  assert.ok(completed?.type === "tool_completed" && completed.result.artifactId);
  const directory = session.repository.path.slice(0, -6) + "-artifacts";
  const artifact = await readFile(join(directory, completed.result.artifactId), "utf8");
  assert.ok(!artifact.includes(config.apiKey));
  assert.ok(artifact.length > 30_000);
});
