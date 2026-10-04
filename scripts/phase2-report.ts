import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
// Usage: tsx scripts/phase2-report.ts <output.json> <report/evidence.json> ...
// Explicit passed evidence is selected by the caller; failed historical reports
// remain on disk and are never rewritten by this audit.
const [output, ...sources] = process.argv.slice(2);
if (!output || !sources.length) throw new Error("需要输出路径及报告 / 平台证据路径");
const config = loadConfig();
const accepted = new Map<string, { name: string; source: string; durationMs?: number }>();
for (const source of sources) {
  const value = JSON.parse(await readFile(source, "utf8"));
  const scenarios: { name: string; status: string; durationMs?: number }[] = value.scenarios ?? [{ name: value.scenario, status: value.status }];
  for (const scenario of scenarios) {
    if (scenario.status !== "passed") throw new Error(`未通过证据：${source} / ${scenario.name}`);
    if (scenario.name === "phase2-persistence-failure") continue; // Superseded by distinct task/session cases.
    accepted.set(scenario.name, { name: scenario.name, source: resolve(source), ...(scenario.durationMs !== undefined ? { durationMs: scenario.durationMs } : {}) });
  }
}
let inspectedFiles = 0;
async function scan(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === ".env" || entry.name === "node_modules" || entry.name === ".git") continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (entry.isFile() && /\.(md|ts|cs|json|jsonl|log|txt|mts|mjs)$/.test(entry.name)) {
      if ((await readFile(file)).includes(Buffer.from(config.apiKey))) throw new Error(`secret_found：${file}`);
      inspectedFiles++;
    }
  }
}
for (const directory of ["src", "tests", "scripts", "docs", ".codeagent/e2e"]) await scan(directory);
const report = { recordedAt: new Date().toISOString(), modelId: config.modelId, baseUrl: config.baseUrl, execution: "grouped", passed: accepted.size, secretAudit: { passed: true, inspectedFiles }, scenarios: [...accepted.values()] };
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output: resolve(output), passed: accepted.size, secretAudit: report.secretAudit }));
