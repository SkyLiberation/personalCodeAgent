import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTaskController, PiModelGateway, loadConfig, TaskRepository, sendTaskCommand } from "../../src/index.js";
import type { ModelGateway } from "../../src/contracts.js";
import { valueFixture } from "./value-fixture.js";
import { phase2Worker, phase2Resume } from "./phase2-helpers.js";
import { scenario, saveSuiteReport } from "./helpers.js";
after(saveSuiteReport);
async function requests(root: string): Promise<{ pid: number }[]> {
  return (await readFile(join(root, "model-requests.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number });
}

test("LT-05A: real request quota survives pause, new process and contract update; exhausted task can only reverify", { timeout: 180_000 }, async context => {
  await scenario(context, "budget-pause-update", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); spec.limits.maxModelRequests = 1;
    await writeFile(join(root, "audit-model-enabled"), "1");
    const path = join(root, "task.json"); await writeFile(path, JSON.stringify(spec));
    const w = phase2Worker(root, "start", path, "model_response_received"); context.after(() => w.close());
    const id = String((await w.wait("task")).id); await w.wait("barrier");
    await sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command: { id: "pause", type: "pause" } }); w.child.send({ type: "continue" });
    const paused = (await w.wait("result")).state as Awaited<ReturnType<typeof TaskRepository.read>>; await w.close();
    assert.ok(paused.status === "paused" && Object.keys(paused.modelRequests ?? {}).length === 1, "真实请求结算后暂停，额度已经消费");
    const next = await valueFixture(root, cwd, 43); next.limits.maxModelRequests = 1;
    await sendTaskCommand({ taskId: id, dataDirectory: join(root, "state"), command: { id: "update", type: "update", expectedVersion: 1, spec: next } });
    const blocked = await phase2Resume(root, id);
    assert.ok(blocked.status === "budget_exhausted" && blocked.specVersion === 2 && (await requests(root)).length === 1,
      "跨进程更新合同不能重置额度或多发真实请求");
    await writeFile(join(cwd, "lib/value.mts"), "export function value():number{return 43}\n");
    const result = await phase2Resume(root, id);
    assert.ok(result.status === "succeeded" && (await requests(root)).length === 1, "耗尽之后只复验实际交付，不能再调用模型");
    await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
  });
});

for (const boundary of ["model_request_reserved", "model_request_dispatched", "model_response_received"] as const) {
  test(`LT-05B: crash at ${boundary} retains quota and unknown usage across actual process recovery`, { timeout: 180_000 }, async context => {
    await scenario(context, `budget-crash-${boundary}`, async ({ root, cwd }) => {
      const spec = await valueFixture(root, cwd); spec.limits.maxModelRequests = 1;
      await writeFile(join(root, "audit-model-enabled"), "1");
      const path = join(root, "task.json"); await writeFile(path, JSON.stringify(spec));
      const w = phase2Worker(root, "start", path, boundary); context.after(() => w.close());
      const id = String((await w.wait("task")).id); await w.wait("barrier"); await w.close();
      const expected = boundary === "model_request_reserved" ? 0 : 1;
      assert.equal((await requests(root)).length, expected, "审计底层真实网关的分派次数");
      const result = await phase2Resume(root, id); const reservation = Object.values(result.modelRequests ?? {})[0];
      assert.ok(result.status === "budget_exhausted" && reservation?.status === "reserved" && reservation.usage === undefined && (await requests(root)).length === expected,
        "没有结算证据的预留仍占额度，用量未知，恢复不能偷偷发新请求");
      assert.ok((await readFile(join(cwd, "lib/value.mts"), "utf8")).includes("return 0"), "响应尚未结算的工具不能执行");
      await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
    });
  });
}

test("LT-05C: final admitted real model response can finish its tool batch and independently verified delivery", { timeout: 180_000 }, async context => {
  await scenario(context, "budget-final-tool-batch", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); spec.limits.maxModelRequests = 1;
    spec.outcome += " 已提供完整实现 export function value():number{return 42}；第一轮直接使用 write 写入 lib/value.mts，无需先 read 或 shell。";
    const config = loadConfig(); const pi = new PiModelGateway(config); let count = 0;
    const gateway: ModelGateway = { async *stream(request, signal) {
      count++; await writeFile(join(root, "actual-request.json"), JSON.stringify({ modelId: config.modelId, baseUrl: config.baseUrl, messages: request.messages, tools: request.tools }, null, 2));
      yield* pi.stream(request, signal);
    } };
    const c = await createTaskController({ spec, config, gateway, dataDirectory: join(root, "state") }); context.after(() => c.close());
    const result = await c.start();
    assert.ok(result.status === "succeeded" && count === 1, "真实最后一次响应的工具执行后由独立进程验收成功，无需再请求模型");
    const output = await readFile(join(cwd, "lib/value.mts"), "utf8"); assert.ok(output.includes("42"));
    await writeFile(join(root, "final-state.json"), JSON.stringify(result, null, 2));
  });
});
