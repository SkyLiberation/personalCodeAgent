import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDefinition } from "../../src/task-contracts.js";

export async function eventFixture(root: string, cwd: string, seed: number): Promise<TaskDefinition> {
  await mkdir(join(cwd, "src"), { recursive: true }); await mkdir(join(root, "control"), { recursive: true });
  const instructions = `Use only Node built-ins; .mts runs directly under Node 24. Do not install packages or inspect git.
Public interfaces (implement only the stage requested, read dependencies):
parse.mts: parse(text:string):Event[]; JSONL blank lines ignored; invalid JSON, missing/empty eventId/project, revision not a nonnegative integer, invalid timestamp, severity outside info/warn/error throw Error containing original 1-based line number. Event={eventId:string,revision:number,timestamp:string,project:string,severity:string}.
normalize.mts: normalize(events:Event[]):Event[] returns new objects with timestamp UTC ISO via Date.toISOString(), validates time. Preserve identifiers and Unicode.
dedup.mts: dedup(events:Event[]):Event[] retain greatest revision per eventId regardless of input order, later occurrence wins ties; preserve first-seen ID order.
aggregate.mts: aggregate(events:Event[]):{project:string,day:string,severity:string,count:number}[] group UTC day (timestamp.slice(0,10)), project, severity. Sort project/day/severity lexicographically.
query.mts: query(events:Event[],start:string,end:string,project?:string):Event[] inclusive start, exclusive end comparing instants; optional exact project; preserve order; reject invalid dates or end<start.
cli.mts: node src/cli.mts archive <input.jsonl> <output.json>: parse, normalize, dedup and write JSON array. node src/cli.mts report <archive.json> <start> <end> [project]: query then aggregate; print JSON array. Invalid command/input: nonzero status, stderr diagnostic, no success output. Empty input works.
All named exports above; never change AGENTS.md or host verifier. Model declarations are not acceptance. Do not add wrapper output fences to files.
`;
  await writeFile(join(cwd, "AGENTS.md"), instructions);
  const initial: Record<string, string> = {
    parse: "export function parse(text:string):any[]{return text.split('\\n').filter(Boolean).map(JSON.parse)}",
    normalize: "export function normalize(events:any[]):any[]{return events}",
    dedup: "export function dedup(events:any[]):any[]{return [...new Map(events.map(e=>[e.eventId,e])).values()]}",
    aggregate: "export function aggregate(events:any[]):any[]{return []}",
    query: "export function query(events:any[],start:string,end:string,project?:string):any[]{return events}",
    cli: "console.error('not implemented');process.exitCode=1;",
  };
  for (const [name, source] of Object.entries(initial)) await writeFile(join(cwd, "src", `${name}.mts`), source + "\n");
  // Hidden variants depend on seed and differ from any public sample.
  const project = `项目-${seed}`; const events = [
    { eventId: `a-${seed}`, revision: 7, timestamp: "2026-07-02T00:30:00+08:00", project, severity: "warn" },
    { eventId: `b-${seed}`, revision: 2, timestamp: "2026-07-01T17:00:00Z", project, severity: "error" },
    { eventId: `a-${seed}`, revision: 1, timestamp: "2026-07-02T12:00:00Z", project: "old", severity: "info" },
    { eventId: `c-${seed}`, revision: 0, timestamp: "2026-07-02T01:00:00-05:00", project: "other", severity: "info" },
  ];
  const normalized = events.map(e => ({ ...e, timestamp: new Date(e.timestamp).toISOString() }));
  const unique = [normalized[0], normalized[1], normalized[3]];
  const counts = [{ project, day: "2026-07-01", severity: "error", count: 1 }, { project, day: "2026-07-01", severity: "warn", count: 1 }];
  const verify = join(root, "control", "verify.mjs");
  const source = `import assert from 'node:assert/strict';import{pathToFileURL}from'node:url';import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{spawnSync}from'node:child_process';import{join}from'node:path';
const cwd=${JSON.stringify(cwd)},events=${JSON.stringify(events)},normalized=${JSON.stringify(normalized)},unique=${JSON.stringify(unique)},counts=${JSON.stringify(counts)};
const stage=process.argv[2],load=async name=>import(pathToFileURL(join(cwd,'src',name+'.mts')));let checks=0,passed=0;const failures=[];async function check(name,fn){checks++;try{await fn();passed++}catch(e){failures.push(name+': '+e.message)}}
if(stage==='parse'){const{parse}=await load('parse');await check('valid Unicode and blank lines',()=>assert.deepEqual(parse(events.map(JSON.stringify).join('\\n')+'\\n\\n'),events));for(const bad of ['{',JSON.stringify({...events[0],severity:'fatal'}),JSON.stringify({...events[0],timestamp:'bad'}),JSON.stringify({...events[0],revision:-1}),JSON.stringify({...events[0],project:''})])await check('invalid original line 3',()=>assert.throws(()=>parse('\\n'+JSON.stringify(events[0])+'\\n'+bad),/3/));}
if(stage==='normalize'){const{normalize}=await load('normalize');await check('UTC boundary and preserved original',()=>{const copy=structuredClone(events);assert.deepEqual(normalize(copy),normalized);assert.deepEqual(copy,events)});await check('empty',()=>assert.deepEqual(normalize([]),[]));}
if(stage==='dedup'){const{dedup}=await load('dedup');await check('unordered revisions',()=>assert.deepEqual(dedup(normalized),unique));await check('later tied revision',()=>assert.deepEqual(dedup([normalized[0],{...normalized[0],project:'tie'}]),[{...normalized[0],project:'tie'}]));}
if(stage==='aggregate'){const{aggregate}=await load('aggregate');await check('project UTC day severity sorted',()=>assert.deepEqual(aggregate([...unique,...unique].filter(e=>e.project===${JSON.stringify(project)})),counts.map(e=>({...e,count:2}))));await check('empty',()=>assert.deepEqual(aggregate([]),[]));}
if(stage==='query'){const{query}=await load('query');await check('range project',()=>assert.deepEqual(query(unique,'2026-07-01T16:00:00Z','2026-07-02T00:00:00Z',${JSON.stringify(project)}),unique.slice(0,2)));await check('exclusive end',()=>assert.deepEqual(query(unique,'2026-07-01T17:00:00Z','2026-07-01T17:00:00Z'),[]));await check('bad range',()=>assert.throws(()=>query(unique,'bad','2026-07-02T00:00:00Z')));}
if(stage==='cli'){const input=join(${JSON.stringify(join(root, "control"))},'events.jsonl'),output=join(${JSON.stringify(join(root, "control"))},'archive.json');writeFileSync(input,events.map(JSON.stringify).join('\\n'));const cli=(...args)=>spawnSync(process.execPath,[join(cwd,'src/cli.mts'),...args],{cwd,encoding:'utf8',timeout:5000});await check('archive real CLI',()=>{const r=cli('archive',input,output);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),unique)});await check('report real CLI',()=>{const r=cli('report',output,'2026-07-01T16:00:00Z','2026-07-02T00:00:00Z',${JSON.stringify(project)});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),counts)});writeFileSync(input,'{');await check('invalid diagnostic no success',()=>{const r=cli('archive',input,output);assert.notEqual(r.status,0);assert.ok(r.stderr.includes('1'));assert.equal(r.stdout.trim(),'')});}
console.log(JSON.stringify({checks,passed,failures}));process.exitCode=failures.length?1:0;`;
  // Candidate code runs in a separate process: a bad top-level import/exit must
  // fail the business check, without destroying the trusted reporter itself.
  const candidate = join(root, "control", "verify-candidate.mjs");
  await writeFile(candidate, source);
  await writeFile(verify, `import{spawnSync}from'node:child_process';
const r=spawnSync(process.execPath,[${JSON.stringify(candidate)},process.argv[2]],{cwd:${JSON.stringify(cwd)},encoding:'utf8',timeout:10000});
let report;try{report=JSON.parse(r.stdout.trim().split(/\\r?\\n/).at(-1));if(!Number.isInteger(report.checks)||report.checks<1||!Number.isInteger(report.passed)||!Array.isArray(report.failures))report=undefined}catch{}
if(!report)report={checks:1,passed:0,failures:['candidate failed before producing acceptance: '+(r.error?.message||r.stderr||r.stdout||'exit '+r.status).slice(0,4000)]};
console.log(JSON.stringify(report));process.exitCode=r.status===0&&report.passed===report.checks&&report.failures.length===0?0:1;`);
  const names = Object.keys(initial);
  return { workspaceRoot: cwd, outcome: "交付按 AGENTS.md 接口实现的事件归档和查询 CLI，正确处理隐藏数据变体。", constraints: ["Node 内置模块，不安装依赖", "只修改 src", "逐阶段完成，保持此前接口行为"], scope: { writablePaths: ["src"] },
    milestones: names.map((id, i) => ({ id: `M${i + 1}`, title: `实现 ${id}.mts 公开接口`, verificationIds: [id] })), finalVerificationIds: names,
    verifiers: names.map(id => ({ id, description: `${id}.mts：遵循 AGENTS.md 的该模块全部语义；真实输入和 CLI 验收`, command: process.execPath, args: [verify, id], inputs: ["src", "AGENTS.md"], trustedFiles: [verify, candidate, join(cwd, "AGENTS.md")], outputs: [`src/${id}.mts`], timeoutMs: 15_000 })), limits: { maxRuns: 14, maxRepairs: 6, maxModelRequests: 70 } };
}
