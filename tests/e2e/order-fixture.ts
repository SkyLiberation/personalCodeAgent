import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDefinition } from "../../src/task-contracts.js";

export const brokenCalculator = `export function calculateOrders(lines: any[], discountBps = 0) {
  const groups = new Map<string, any>();
  for (const line of lines) {
    let order = groups.get(line.orderId);
    if (!order) { order = { orderId: line.orderId, items: [], subtotalCents: 0 }; groups.set(line.orderId, order); }
    order.items.push({ sku: line.sku, quantity: line.quantity, unitPriceCents: line.unitPriceCents });
    order.subtotalCents += line.quantity * line.unitPriceCents;
  }
  return [...groups.values()].sort((a, b) => a.orderId.localeCompare(b.orderId)).map(order =>
    ({ ...order, discountCents: 0, totalCents: order.subtotalCents }));
}
`;

// Independent, immutable verifier. Each subprocess executes checks and emits a completion report.
const verifierSource = `import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, stage] = process.argv.slice(2);
let checks = 0, passed = 0;
const failures = [];
async function check(name, action) { checks++; try { await action(); passed++; } catch (e) { failures.push(name + ': ' + e.message); } }
const csv = 'order_id,sku,quantity,unit_price\\r\\nB,中文商品,3,0.10\\r\\nA,"A,1",2,19.90\\r\\nA,B,1,10.00\\r\\n';
const lines = [{ orderId: 'B', sku: '中文商品', quantity: 3, unitPriceCents: 10 },
  { orderId: 'A', sku: 'A,1', quantity: 2, unitPriceCents: 1990 },
  { orderId: 'A', sku: 'B', quantity: 1, unitPriceCents: 1000 }];
function checkTotals(orders) {
  assert.deepEqual(orders.map(o => [o.orderId, o.subtotalCents, o.discountCents, o.totalCents]),
    [['A', 4980, 498, 4482], ['B', 30, 3, 27]]);
  assert.ok(orders[0].items.some(i => i.sku === 'A,1') && orders[1].items.some(i => i.sku === '中文商品'), 'SKU must survive export');
}
if (stage === 'parse') {
  await check('CSV quotes, Chinese fields and integer cents', async () => {
    const { parseOrders } = await import(pathToFileURL(join(root, 'src/parse.mts')).href);
    assert.deepEqual(parseOrders(csv).map(l => [l.orderId, l.sku, l.quantity, l.unitPriceCents]), lines.map(l => [l.orderId, l.sku, l.quantity, l.unitPriceCents]));
    const escaped = 'order_id,sku,quantity,unit_price\\nA,"He said ""hi""",1,0.01\\n';
    assert.equal(parseOrders(escaped)[0].sku, 'He said "hi"');
  });
  await check('reject invalid quantity and price', async () => {
    const { parseOrders } = await import(pathToFileURL(join(root, 'src/parse.mts')).href);
    for (const [q, p] of [['0', '1.00'], ['-1', '1.00'], ['1.5', '1.00'], ['1', '-1.00'], ['1', 'bad'], ['1', '1.999']]) {
      assert.throws(() => parseOrders('order_id,sku,quantity,unit_price\\nA,B,' + q + ',' + p + '\\n'), q + '/' + p + ' must be rejected');
    }
  });
} else if (stage === 'calculate') {
  await check('quantity, cents, discount and stable order', async () => {
    const { calculateOrders } = await import(pathToFileURL(join(root, 'src/calculate.mts')).href);
    checkTotals(calculateOrders(lines, 1000));
    const tiny = calculateOrders([{ orderId: 'T', sku: 'small', quantity: 1, unitPriceCents: 1 }], 1000)[0];
    assert.equal(tiny.totalCents, 1, 'discount must round down to integer cents');
  });
} else if (stage === 'cli') {
  await check('real CLI produces correct JSON', () => {
    const result = spawnSync(process.execPath, [join(root, 'src/cli.mts'), '--input', 'data/orders.csv', '--discount-bps', '1000', '--output', 'out/summary.json'], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    checkTotals(JSON.parse(readFileSync(join(root, 'out/summary.json'), 'utf8')).orders);
  });
  await check('invalid input exits unsuccessfully without success output', () => {
    mkdirSync(join(root, 'out'), { recursive: true });
    const input = join(root, 'out/invalid-input.csv'), output = join(root, 'out/invalid-output.json');
    if (existsSync(output)) rmSync(output);
    writeFileSync(input, 'order_id,sku,quantity,unit_price\\nA,B,0,1.00\\n');
    const result = spawnSync(process.execPath, [join(root, 'src/cli.mts'), '--input', input, '--discount-bps', '1000', '--output', output], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.ok(result.status !== 0 && !existsSync(output), 'invalid order must not be delivered successfully');
  });
} else { throw new Error('unknown stage'); }
console.log(JSON.stringify({ checks, passed, failures }));
process.exitCode = failures.length ? 1 : 0;
`;

export async function orderFixture(root: string, cwd: string): Promise<{
  spec: TaskDefinition; specPath: string; trustedSource: string; verifierPath: string;
}> {
  const control = join(root, "control");
  await Promise.all([mkdir(control, { recursive: true }), mkdir(join(cwd, "src"), { recursive: true }), mkdir(join(cwd, "data"), { recursive: true })]);
  const verifierPath = join(control, "verify.mjs");
  await writeFile(verifierPath, verifierSource);
  await writeFile(join(cwd, "src/parse.mts"), `export function parseOrders(csv: string) {
  return csv.trim().split(/\\r?\\n/).slice(1).map(row => {
    const [orderId, sku, q, p] = row.split(',');
    return { orderId, sku, quantity: Number(q), unitPriceCents: Number(p) * 100 };
  });
}
`);
  await writeFile(join(cwd, "src/calculate.mts"), brokenCalculator);
  await writeFile(join(cwd, "src/cli.mts"), `console.log('TODO: implement order CLI');\n`);
  await writeFile(join(cwd, "data/orders.csv"), 'order_id,sku,quantity,unit_price\nB,中文商品,3,0.10\nA,"A,1",2,19.90\nA,B,1,10.00\n');
  await writeFile(join(cwd, "AGENTS.md"), `# 订单工程规范
仅修改 src 下的实现，不得修改 data、AGENTS.md 或工作区之外的验收文件。
Node 24 直接执行 .mts；只使用 Node 内置模块，不安装依赖。
parse.mts 导出 parseOrders(csv: string)，返回 {orderId,sku,quantity,unitPriceCents} 数组；CSV 支持双引号、转义双引号、中文和 CRLF。数量为正整数；单价非负且最多两位小数，非法输入抛错。
CSV 第一行为固定表头 order_id,sku,quantity,unit_price，必须校验；不支持无表头或任意表头推断。保持需求明确的最小实现。
calculate.mts 导出 calculateOrders(lines, discountBps)，返回按 orderId 排序的订单数组，每项有 orderId、items、subtotalCents、discountCents、totalCents；items 保留 sku、quantity、unitPriceCents。
金额使用整数分；subtotalCents 是数量乘单价的和，discountCents = floor(subtotalCents * discountBps / 10000)，totalCents = subtotalCents - discountCents。
cli.mts 支持 --input、--discount-bps、--output；输出 JSON {orders:[...]}，创建所需目录；非法订单非零退出且不产生成功文件。
最终完成由宿主独立验收，不修改验收规则来通过。
`);
  const stages = ["parse", "calculate", "cli"];
  const spec: TaskDefinition = {
    workspaceRoot: cwd,
    outcome: "完善订单处理 CLI，正确解析 CSV、计算整数分金额与折扣、导出 JSON，并拒绝非法订单。",
    constraints: ["仅修改 src，不修改输入数据、项目规范及验收脚本", "只使用 Node 内置模块；保留 AGENTS.md 中的对外接口"],
    milestones: stages.map((stage, i) => ({ id: `M${i + 1}`, title: ["CSV 解析与数据校验", "金额汇总与折扣", "真实 CLI 交付和完整回归"][i]!, verificationIds: [stage] })),
    finalVerificationIds: stages,
    verifiers: stages.map((stage) => ({
      id: stage, description: stage === "cli"
        ? "复现命令：node src/cli.mts --input data/orders.csv --discount-bps 1000 --output out/summary.json；A 的 subtotal/discount/total 为 4980/498/4482，B 为 30/3/27；非法输入必须非零退出。"
        : `独立 ${stage} 验收；遵循 AGENTS.md 的接口与行为`,
      command: process.execPath, args: [verifierPath, cwd, stage],
      inputs: ["src", "data", "AGENTS.md"], trustedFiles: [verifierPath, join(cwd, "data/orders.csv"), join(cwd, "AGENTS.md")],
      outputs: stage === "cli" ? ["out/summary.json"] : [], timeoutMs: 30_000,
    })),
    limits: { maxRuns: 12, maxRepairs: 4 },
  };
  const specPath = join(control, "task.json");
  await writeFile(specPath, JSON.stringify(spec, null, 2) + "\n");
  return { spec, specPath, trustedSource: await readFile(verifierPath, "utf8"), verifierPath };
}
