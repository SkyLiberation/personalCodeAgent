import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDefinition } from "../../src/task-contracts.js";
export async function quoteFixture(root: string, cwd: string): Promise<TaskDefinition> {
  for (const dir of ["app", "lib", "data"]) await mkdir(join(cwd, dir), { recursive: true });
  await mkdir(join(root, "control"), { recursive: true });
  await writeFile(join(cwd, "data/config.json"), '{"discountBps":1000}');
  await writeFile(join(cwd, "lib/quote.mts"), "export function quote(quantity: number, unitPriceCents: number, discountBps: number) { throw new Error('TODO'); }\n");
  await writeFile(join(cwd, "app/server.mts"), "// TODO HTTP service\n");
  await writeFile(join(cwd, "AGENTS.md"), `只修改 app 和 lib，只用 Node 内置模块。lib/quote.mts 导出 quote(quantity, unitPriceCents, discountBps)，返回 {subtotalCents,discountCents,totalCents}；数量必须正整数、单价非负整数。折扣向下取整。app/server.mts 启动 HTTP 服务，从 data/config.json 读取 discountBps，监听端口 0，stdout 单行 JSON {port:实际端口}。POST /quote JSON {quantity,unitPriceCents} 返回报价 JSON，非法输入 400。`);
  const verifier = join(root, "control", "verify.mjs");
  await writeFile(verifier, `import assert from 'node:assert/strict';
import {spawn} from 'node:child_process'; import {pathToFileURL} from 'node:url'; import {join} from 'node:path';
const [cwd,stage]=process.argv.slice(2); let checks=0,passed=0;const failures=[];
async function check(name,fn){checks++;try{await fn();passed++;}catch(e){failures.push(name+': '+e.message);}}
if(stage==='amount') await check('integer cents and rejection',async()=>{const {quote}=await import(pathToFileURL(join(cwd,'lib/quote.mts')));assert.deepEqual(quote(2,1990,1000),{subtotalCents:3980,discountCents:398,totalCents:3582});assert.throws(()=>quote(0,1990,1000));});
else for(let i=0;i<2;i++) await check('real HTTP and persistent config restart '+i,async()=>{
 const p=spawn(process.execPath,[join(cwd,'app/server.mts')],{cwd,stdio:['ignore','pipe','pipe']});const closed=new Promise(r=>p.once('close',r));let error='';p.stderr.on('data',d=>error+=d);
 try {const port=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(new Error('service startup timeout '+error)),8000);p.stdout.on('data',d=>{s+=d;if(s.includes('\\n')){clearTimeout(timer);try{resolve(JSON.parse(s.split('\\n')[0]).port);}catch(e){reject(e);}}});p.on('exit',()=>{clearTimeout(timer);reject(new Error('service exited '+error));});});
 const send=(body)=>fetch('http://127.0.0.1:'+port+'/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const good=await send({quantity:2,unitPriceCents:1990});assert.equal(good.status,200);assert.deepEqual(await good.json(),{subtotalCents:3980,discountCents:398,totalCents:3582});assert.equal((await send({quantity:0,unitPriceCents:1990})).status,400);
 }finally{p.kill();await closed;}
}); console.log(JSON.stringify({checks,passed,failures}));process.exitCode=failures.length?1:0;
`);
  const stages = ["amount", "http"];
  return { workspaceRoot: cwd, outcome: "实现报价计算与 HTTP 服务，支持非法输入拒绝和读取持久配置后重启。", scope: { writablePaths: ["app", "lib"] }, constraints: ["只修改 app/lib；不修改 data、AGENTS.md 和验收"], milestones: stages.map((s, i) => ({ id: `M${i + 1}`, title: s === "amount" ? "实现报价函数" : "实现 HTTP 服务", verificationIds: [s] })), finalVerificationIds: stages, verifiers: stages.map(s => ({ id: s, description: s === "amount" ? "quote(2,1990,1000) => 3980/398/3582，非法数量抛错" : "node app/server.mts；端口0 stdout JSON；POST /quote => 正确报价或400，重启仍读取 data/config.json", command: process.execPath, args: [verifier, cwd, s], inputs: ["app", "lib", "data", "AGENTS.md"], trustedFiles: [verifier, join(cwd, "AGENTS.md"), join(cwd, "data/config.json")], outputs: [], timeoutMs: 25_000 })), limits: { maxRuns: 8, maxRepairs: 3 } };
}
