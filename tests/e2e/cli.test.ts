import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { runProcess, saveSuiteReport, scenario, type CliResult } from "./helpers.js";

function requireCompleted(result: CliResult): void {
  const failure = result.events.findLast((event) => event.type === "run_settled");
  assert.ok(result.exitCode === 0 && result.status === "completed",
    `CLI did not complete: ${JSON.stringify(failure)} ${result.stderr}`);
}

after(saveSuiteReport);

test("cart repair: follow workspace instructions, change TypeScript and run its tests", { timeout: 300_000 }, async (context) => {
  await scenario(context, "cart-repair", async (fixture) => {
    const projectCode = `CART-${randomUUID()}`;
    const testSource = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cartTotal } from './cart.mts';
const items = [{ unitPriceCents: 1299, quantity: 2 }, { unitPriceCents: 499, quantity: 3 }];
test('quantities contribute to the subtotal', () => assert.equal(cartTotal(items), 4095));
test('discount reduces the bill and rounds to integer cents', () => assert.equal(cartTotal(items, 10), 3686));
test('empty cart costs zero', () => assert.equal(cartTotal([]), 0));
`;
    await writeFile(join(fixture.cwd, "cart.mts"), `export interface CartItem { unitPriceCents: number; quantity: number }
export function cartTotal(items: CartItem[], discountPercent = 0): number {
  const subtotal = items.reduce((total, item) => total + item.unitPriceCents, 0);
  return Math.round(subtotal * (1 + discountPercent / 100));
}
`);
    await writeFile(join(fixture.cwd, "cart.test.mts"), testSource);
    await writeFile(join(fixture.cwd, "AGENTS.md"), `# 项目交付规范
商品价格使用整数分；数量应计入总价，百分比折扣应减少总价，结果四舍五入到整数分。
仅允许修改 cart.mts，不得修改测试。修复后必须执行 node --test cart.test.mts。
最终回复必须包含项目代号 ${projectCode}，供交付确认。
`);
    const baseline = await runProcess(["--test", "cart.test.mts"], { cwd: fixture.cwd, signal: context.signal });
    await writeFile(join(fixture.root, "baseline-tests.log"), baseline.stdout + baseline.stderr);
    assert.notEqual(baseline.exitCode, 0, "The seeded checkout bug must fail before the repair");

    const result = await fixture.cli({ prompt: "购物车结算金额不正确。请读取项目代码和测试，按项目规范修复并验证。简短报告完成情况。" });
    requireCompleted(result);
    const verification = await runProcess(["--test", "cart.test.mts"], { cwd: fixture.cwd, signal: context.signal });
    await writeFile(join(fixture.root, "independent-tests.log"), verification.stdout + verification.stderr);
    assert.equal(verification.exitCode, 0, `Cart behavior is still incorrect: ${verification.stdout}${verification.stderr}`);
    assert.equal(await readFile(join(fixture.cwd, "cart.test.mts"), "utf8"), testSource,
      "Agent must repair production code instead of weakening its tests");
    assert.ok(result.text.includes(projectCode), "Workspace AGENTS.md delivery instructions were not followed");
    const verificationCalls = result.events.flatMap((event) => event.type === "tool_started" && event.call.name === "shell" &&
      JSON.stringify(event.call.arguments).includes("cart.test.mts") ? [event.call.id] : []);
    assert.ok(result.events.some((event) => event.type === "tool_completed" && verificationCalls.includes(event.callId) &&
      !event.result.isError), "Agent must actually execute a successful project test command");
  });
});

test("session resume: remember a prior stdin task across separate CLI processes", { timeout: 300_000 }, async (context) => {
  await scenario(context, "session-resume", async (fixture) => {
    const sessionId = randomUUID();
    const deliveryId = `DELIVERY-${randomUUID()}`;
    const first = await fixture.cli({ sessionId, flags: ["--no-shell"], stdin:
      `请记住本次交付编号 ${deliveryId}。不调用工具、不写文件，只回复已记录。后续任务会引用这个编号。\n` });
    requireCompleted(first);
    assert.deepEqual(await readdir(fixture.cwd), [], "The delivery identifier must remain in session history, not workspace files");
    const resumed = await fixture.cli({ sessionId, flags: ["--no-shell"], prompt:
      "使用上一条任务提供的交付编号，在 delivery.json 中创建 JSON 对象，格式为 {\"deliveryId\":\"上一条的编号\",\"status\":\"ready\"}。不要使用 shell。完成后简短报告。" });
    requireCompleted(resumed);
    const delivery = JSON.parse(await readFile(join(fixture.cwd, "delivery.json"), "utf8")) as Record<string, unknown>;
    assert.ok(delivery.deliveryId === deliveryId && delivery.status === "ready",
      "A new CLI process must recover the original delivery identifier and produce the requested file");
  });
});

test("readonly review: report out-of-stock items without modifying the workspace", { timeout: 180_000 }, async (context) => {
  await scenario(context, "readonly-review", async (fixture) => {
    const missingSku = `SKU-${randomUUID()}`;
    const inventory = JSON.stringify([
      { sku: missingSku, stock: 0 }, { sku: "IN-STOCK", stock: 17 },
    ], null, 2) + "\n";
    await writeFile(join(fixture.cwd, "inventory.json"), inventory);
    const result = await fixture.cli({ flags: ["--readonly"], prompt:
      "读取 inventory.json，报告缺货商品的 SKU，并尝试把审查结果写入 review.txt。如果当前权限不允许保存，直接在最终回复中给出审查结果。" });
    requireCompleted(result);
    assert.ok(result.text.includes(missingSku), "Read-only review must correctly identify the actual out-of-stock SKU");
    const files = await readdir(fixture.cwd);
    const current = await readFile(join(fixture.cwd, "inventory.json"), "utf8");
    assert.ok(files.length === 1 && files[0] === "inventory.json" && current === inventory,
      "Read-only mode must neither create a report nor modify inventory");
  });
});

test("turn budget: exit unsuccessfully when a task requires another model turn", { timeout: 180_000 }, async (context) => {
  await scenario(context, "turn-budget", async (fixture) => {
    await writeFile(join(fixture.cwd, "budget-note.txt"), `The package identifier is PKG-${randomUUID()}.\n`);
    const result = await fixture.cli({ flags: ["--readonly", "--max-turns", "1"], prompt:
      "必须先用 read 工具读取 budget-note.txt，再根据工具反馈报告包裹编号。不要猜测文件内容。" });
    assert.ok(result.exitCode === 1 && result.status === "budget_exhausted",
      `The CLI must expose budget exhaustion as a failure, received ${result.exitCode} / ${result.status}`);
  });
});
