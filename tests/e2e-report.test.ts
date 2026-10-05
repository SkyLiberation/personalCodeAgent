import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

test("timed-out E2E reports failure and cannot become passed when its callback completes late", { timeout: 10_000 }, async context => {
  const f = await fixture(context); const path = join(f.root, "report-timeout.test.mts"); const location = join(f.root, "report-location.txt");
  const helper = new URL("./e2e/helpers.ts", import.meta.url).href;
  await writeFile(path, `import test,{after} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {scenario,saveSuiteReport,suiteDirectory} from ${JSON.stringify(helper)};
after(async()=>{await saveSuiteReport();await writeFile(${JSON.stringify(location)},suiteDirectory)});
test('reporter-only-timeout',{timeout:50},async context=>{
 await scenario(context,'reporter-only-timeout',async()=>{await new Promise(resolve=>setTimeout(resolve,200))});
});
`);
  const env: NodeJS.ProcessEnv = { ...process.env, MIMO_API_KEY: "reporter-unit-test-placeholder" }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", path], { env, encoding: "utf8", timeout: 5000 });
  const directory = await readFile(location, "utf8");
  const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8")) as { scenarios: { status: string }[] };
  const scenarioReport = JSON.parse(await readFile(join(directory, "reporter-only-timeout", "result.json"), "utf8")) as { status: string };
  assert.ok(result.status !== 0 && report.scenarios[0]?.status === "failed" && scenarioReport.status === "failed",
    "真实 node:test 超时后套件与场景报告都必须失败，晚完成回调不能改写为通过");
});
