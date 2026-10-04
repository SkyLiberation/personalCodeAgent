import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createAgentSession } from "../src/harness/session.js";
import { loadConfig } from "../src/config.js";
import { SecretRedactor, errorText } from "../src/security.js";

const directory = await mkdtemp(join(tmpdir(), "personal-code-agent-smoke-"));
const tests = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add } from './math.mjs';
test('addition', () => { assert.equal(add(2, 3), 5); assert.equal(add(-1, 4), 3); });
`;
await writeFile(join(directory, "math.mjs"), "export function add(a, b) { return a - b; }\n");
await writeFile(join(directory, "math.test.mjs"), tests);
const config = loadConfig();
const redactor = new SecretRedactor([config.apiKey]);
const session = await createAgentSession({ config, cwd: directory, dataDirectory: join(directory, ".codeagent") });
const called: string[] = [];
session.subscribe((event) => {
  if (event.type === "tool_started") { called.push(event.call.name); console.log(`tool: ${event.call.name}`); }
  if (event.type === "tool_completed") console.log(`result: ${event.toolName} ${event.result.isError ? "error" : "ok"}`);
  if (event.type === "run_settled") console.log(`status: ${event.status}`);
});
try {
  const result = await session.submit("修复 math.mjs 中 add 函数的加法错误。必须先读取 math.mjs 和 math.test.mjs，仅修改 math.mjs，不得修改测试。修改后使用 shell 运行 node --test math.test.mjs 并确认通过。不要添加其他文件。最后简短报告结果。");
  assert.equal(result.status, "completed", result.error);
  assert.equal(await readFile(join(directory, "math.test.mjs"), "utf8"), tests, "Agent 不应修改测试");
  assert.ok(called.includes("read"), "没有读取文件");
  assert.ok(called.includes("edit") || called.includes("write"), "没有实际修改代码");
  assert.ok(called.includes("shell"), "没有执行测试命令");
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "math.test.mjs"], { cwd: directory, stdio: "pipe", windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  assert.equal(exitCode, 0, "独立运行测试未通过");
  const history = await readFile(session.repository.path, "utf8");
  assert.ok(!history.includes(config.apiKey), "会话日志包含密钥");
  console.log(`LIVE_SMOKE_OK\nworkspace: ${directory}\nturns: ${result.turns}\nsession: ${session.id}`);
} catch (error) {
  console.error(redactor.text(errorText(error)));
  console.error(`Smoke workspace retained: ${directory}`);
  process.exitCode = 1;
} finally {
  await session.close();
}
