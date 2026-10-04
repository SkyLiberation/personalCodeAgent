import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDefinition } from "../../src/task-contracts.js";
export async function valueFixture(root: string, cwd: string, value = 42, receipt = false): Promise<TaskDefinition> {
  await mkdir(join(cwd, "lib"), { recursive: true }); await mkdir(join(root, "control"), { recursive: true });
  await writeFile(join(cwd, "lib/value.mts"), "export function value(): number { return 0; }\n");
  await writeFile(join(cwd, "AGENTS.md"), "只修改 lib/value.mts。导出 value():number，按当前任务合同返回要求的整数。只使用 Node 内置模块，不安装依赖。使用 write 工具写入实现。交付登记工具若有要求，在整个任务中只调用一次，恢复后已经确认的登记不要重复。\n");
  const path = join(root, "control", `verify-${value}.mjs`);
  await writeFile(path, `import {pathToFileURL} from 'node:url';import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(join(root,"verifier-runs.jsonl"))},JSON.stringify({pid:process.pid,timestamp:Date.now()})+'\\n');let passed=0;const failures=[];try{const {value}=await import(pathToFileURL(${JSON.stringify(join(cwd,"lib/value.mts"))}));if(value()!==${value})throw new Error('value() 必须为 ${value}');${receipt ? `const {readFileSync}=await import('node:fs');const lines=readFileSync(${JSON.stringify(join(root, "audit.jsonl"))},'utf8').trim().split('\\n');if(lines.length!==1)throw new Error('交付标记必须且只能登记一次');` : ""}passed=1;}catch(e){failures.push(e.message);}console.log(JSON.stringify({checks:1,passed,failures}));process.exitCode=failures.length?1:0;`);
  return { workspaceRoot: cwd, outcome: `实现 lib/value.mts 的 value()，返回整数 ${value}。${receipt ? "首先调用 record-delivery 登记唯一交付标记，整个任务只登记一次，恢复后不要重复。" : ""}`, constraints: ["只修改 lib/value.mts"], scope: { writablePaths: ["lib/value.mts"] }, milestones: [{ id: "M1", title: "实现整数接口并交付", verificationIds: ["value"] }], finalVerificationIds: ["value"], verifiers: [{ id: "value", description: `真实导入 lib/value.mts，value() === ${value}${receipt ? "；交付标记必须且只能登记一次" : ""}`, command: process.execPath, args: [path], inputs: ["lib", "AGENTS.md"], trustedFiles: [path, join(cwd, "AGENTS.md")], outputs: ["lib/value.mts"], timeoutMs: 10_000 }], limits: { maxRuns: 5, maxRepairs: 2 } };
}
