import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createAgentSession, createExecutionHost, McpClient, MemoryStore, BackgroundTasks, ContainerExecutionHost, loadConfig,
  draftGoal, confirmGoal, PiModelGateway, runWorkflow, serveSessionWeb, type ModelMessage } from "../../src/index.js";
import { LinuxHost } from "../../src/platform/linux.js";
import { seal } from "../../src/storage/journal.js";
import { valueFixture } from "./value-fixture.js";
import { scenario, saveSuiteReport } from "./helpers.js";
after(saveSuiteReport);

test("MCP-02: real stdio timeout cancellation malformed response and disconnect refuse success", { timeout: 30_000 }, async context => {
  await scenario(context, "mcp-protocol-faults", async ({ root, cwd }) => {
    const server = join(root, "fault-server.mjs"); const audit = join(root, "cancellation.jsonl");
    await writeFile(server, `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='notifications/cancelled')appendFileSync(${JSON.stringify(audit)},JSON.stringify(r.params)+'\\n');if(r.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{protocolVersion:'2025-11-25'}})+'\\n');if(r.method==='malformed')process.stdout.write(JSON.stringify({jsonrpc:'bad',id:r.id,result:{}})+'\\n');if(r.method==='disconnect')process.exit(0);});`);
    const client = await McpClient.connect({ command: process.execPath, args: [server], cwd, timeoutMs: 500 }); context.after(() => client.close());
    await assert.rejects(client.request("silent", {}), /mcp_timeout/);
    const stop = new AbortController(); const request = client.request("silent", {}, stop.signal); stop.abort(); await assert.rejects(request, /mcp_cancelled/);
    await assert.rejects(client.request("malformed", {}), /mcp_protocol_invalid/);
    assert.equal((await readFile(audit, "utf8")).trim().split("\n").length, 2, "超时和取消通知到真实服务，不能只结束本地 Promise");
    await assert.rejects(client.request("disconnect", {}), /mcp_disconnected/);
  });
});

test("EX/MCP/MEM: real agent loads scoped skill and trusted extension, calls actual MCP and reads authorized memory", { timeout: 180_000 }, async context => {
  await scenario(context, "resources-mcp-memory", async ({ root, cwd }) => {
    await valueFixture(root, cwd); await mkdir(join(cwd, ".agent/skills/arithmetic"), { recursive: true });
    await writeFile(join(cwd, ".agent/skills/arithmetic/SKILL.md"), "---\nname: arithmetic\ndescription: Exact instructions for this arithmetic delivery; load before implementing.\n---\nUse calc-add with a=17 and b=25; use the actual tool result as value(). Call delivery-note once after writing the module.\n");
    await writeFile(join(cwd, "lib/AGENTS.md"), "Scoped instruction: value.mts must export value():number; follow arithmetic skill for this task.\n");
    const server = join(root, "mcp-server.mjs"); const audit = join(root, "mcp-audit.jsonl");
    await writeFile(server, `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result;if(r.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'arithmetic',version:'1'}};if(r.method==='tools/list')result={tools:[{name:'add',description:'Add two integers using this server',inputSchema:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b'],additionalProperties:false}}]};if(r.method==='tools/call'){appendFileSync(${JSON.stringify(audit)},JSON.stringify(r.params)+'\\n');result={content:[{type:'text',text:String(r.params.arguments.a+r.params.arguments.b)}]}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')});`);
    const client = await McpClient.connect({ command: process.execPath, args: [server], cwd }); context.after(() => client.close());
    const tools = await client.tools("calc", { add: { effect: "read", replay: "safe" } });
    assert.throws(() => tools[0]!.validate({ a: "17", b: 25 }), /mcp_arguments_invalid/, "错误参数不能越过真实 MCP 工具的输入门禁");
    const extension = join(root, "extension.mjs"); const delivery = join(root, "delivery.jsonl"); const disposed = join(root, "disposed.txt");
    await writeFile(extension, `import{appendFile,writeFile}from'node:fs/promises';export default{apiVersion:1,name:'delivery',version:'1',register(){return{tools:[{name:'delivery-note',description:'Record one final delivery note when requested',parameters:{type:'object',properties:{},additionalProperties:false},effect:'write',replay:'never',validate:v=>v,execute:async()=>{await appendFile(${JSON.stringify(delivery)},'delivered\\n');return{text:'recorded',isError:false}}}],dispose:()=>writeFile(${JSON.stringify(disposed)},'disposed')}}};`);
    const sha256 = createHash("sha256").update(await readFile(extension)).digest("hex"); const host = await createExecutionHost(); context.after(() => host.close());
    const memory = new MemoryStore(join(root, "memory.jsonl"), host); await memory.remember({ key: "arithmetic", text: "For arithmetic delivery, use the discovered skill and actual calculator server; exported function is value.", source: "user-approved-preference", authorized: true });
    const session = await createAgentSession({ cwd, dataDirectory: join(root, "sessions"), config: { ...loadConfig(), thinking: "off", maxTurns: 8 }, additionalTools: tools,
      extensions: { paths: [extension], trustedHashes: { [extension]: sha256 } }, noShell: true }); context.after(() => session.close());
    const preferences = await memory.recall("arithmetic");
    const result = await session.submit("根据记忆与项目范围指令，加载 arithmetic skill，调用真实 calc-add，写入 value.mts，再调用 delivery-note 一次。记忆：" + preferences.map(m => m.text).join("\n"));
    await writeFile(join(root, "run-result.json"), JSON.stringify(result)); assert.equal(result.status, "completed", result.error);
    assert.equal((await import(pathToFileURL(join(cwd, "lib/value.mts")).href)).value(), 42);
    const messages = session.repository.messages(); assert.ok(messages.some(m => m.role === "tool_result" && m.toolName === "load-skill") && messages.some(m => m.role === "tool_result" && m.toolName === "calc-add" && m.text === "42"));
    assert.equal((await readFile(audit, "utf8")).trim().split("\n").length, 1); assert.equal((await readFile(delivery, "utf8")).trim().split("\n").length, 1);
    await session.close(); assert.equal(await readFile(disposed, "utf8"), "disposed");
  });
});

test("GD/WF: real model drafts confirmed host-gated goal and dependent agent starts only after verified delivery", { timeout: 180_000 }, async context => {
  await scenario(context, "planning-workflow", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); const config = { ...loadConfig(), thinking: "off" as const }; const gateway = new PiModelGateway(config);
    const draft = await draftGoal({ ...spec, writablePaths: ["lib/value.mts"], gateway, signal: context.signal });
    await writeFile(join(root, "draft.json"), JSON.stringify(draft, null, 2)); assert.equal(draft.status, "awaiting_confirmation"); assert.ok((await readFile(join(cwd, "lib/value.mts"), "utf8")).includes("return 0"), "草拟不会执行工程修改");
    await assert.rejects(confirmGoal(draft, { hash: "wrong", confirmed: true }, { config, dataDirectory: join(root, "state") }), /confirmation_mismatch/);
    const controller = await confirmGoal(draft, { hash: draft.hash, confirmed: true }, { config, dataDirectory: join(root, "state") }); context.after(() => controller.close());
    const secondRoot = join(root, "dependent"); const secondCwd = join(secondRoot, "workspace"); await mkdir(secondCwd, { recursive: true }); const secondSpec = await valueFixture(secondRoot, secondCwd, 43);
    const { createTaskController } = await import("../../src/index.js"); const dependent = await createTaskController({ spec: { ...secondSpec, completionPolicy: "verification" }, config, dataDirectory: join(secondRoot, "state") }); context.after(() => dependent.close());
    const result = await runWorkflow([{ id: "first", dependsOn: [], run: signal => controller.start(signal) }, { id: "second", dependsOn: ["first"], run: signal => dependent.start(signal) }], { concurrency: 2, signal: context.signal });
    await writeFile(join(root, "workflow.json"), JSON.stringify(result, null, 2)); assert.ok(result.first?.status === "succeeded" && result.second?.status === "succeeded");
  });
});

test("BG-01: real bounded background process has durable receipt across independent waiters and timeout", { timeout: 30_000 }, async context => {
  await scenario(context, "background-receipts", async ({ root, cwd }) => {
    const host = await createExecutionHost(); context.after(() => host.close()); const tasks = new BackgroundTasks(join(root, "background"), host);
    const operation = await tasks.start({ executable: process.execPath, args: ["-e", "setTimeout(()=>console.log('done'),300)"], cwd, timeoutMs: 5000 });
    const successor = new BackgroundTasks(join(root, "background"), host); const receipt = await successor.wait(operation.operationId, { commandHash: operation.commandHash, signal: context.signal, timeoutMs: 10000 });
    assert.ok(receipt.status === "completed" && receipt.result?.stdout.trim() === "done");
    const timeout = await tasks.start({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd, timeoutMs: 200 });
    const failed = await successor.wait(timeout.operationId, { commandHash: timeout.commandHash, signal: context.signal, timeoutMs: 10000 }); assert.ok(failed.status === "failed" && failed.result?.timedOut);
    await writeFile(join(root, "receipts.json"), JSON.stringify([receipt, failed], null, 2));
  });
});

test("ENV-01: real container confines mount, network and cleanup without host-shell fallback", { timeout: 60_000 }, async context => {
  await scenario(context, "container-boundary", async ({ root, cwd }) => {
    const host = await ContainerExecutionHost.create({ image: "node:24-bookworm-slim", workspace: cwd }); context.after(() => host.close()); await host.restoreProcessGroups(join(root, "process-groups.jsonl"));
    const result = await host.exec("node", ["-e", "const fs=require('node:fs');fs.writeFileSync('/workspace/inside.txt','delivered');try{fs.writeFileSync('/forbidden.txt','escape');process.exit(4)}catch{}console.log(fs.existsSync('/var/run/docker.sock')?'unsafe':'isolated');"], cwd, context.signal, 10000);
    await writeFile(join(root, "container-first-result.json"), JSON.stringify(result, null, 2));
    assert.ok(result.exitCode === 0 && result.stdout.trim() === "isolated"); assert.equal(await readFile(join(cwd, "inside.txt"), "utf8"), "delivered");
    const timed = await host.exec("node", ["-e", "setInterval(()=>{},1000)"], cwd, context.signal, 300); assert.ok(timed.timedOut);
    await writeFile(join(root, "container-results.json"), JSON.stringify([result, timed], null, 2));
  });
});

test("LX-05: foreign boot or PID namespace journal blocks before killing a real unrelated process", { timeout: 30_000 }, async context => {
  await scenario(context, "linux-provenance", async ({ root, cwd }) => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" }); context.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const stat = await readFile(`/proc/${child.pid}/stat`, "utf8"); const starttime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); const { readlink } = await import("node:fs/promises"); const pidNamespace = await readlink("/proc/self/ns/pid");
    const path = join(root, "process-groups.jsonl"); const host = await LinuxHost.create(); context.after(() => host.close());
    for (const change of [{ bootId: "foreign-boot" }, { pidNamespace: "pid:[foreign]" }]) {
      await writeFile(path, JSON.stringify(seal({ schemaVersion: 3, backend: "linux", pid: child.pid, starttime, bootId, pidNamespace, ...change }, "")) + "\n");
      await assert.rejects(host.restoreProcessGroups(path), /process_state_unknown/); assert.doesNotThrow(() => process.kill(child.pid!, 0), "来源不匹配不能误杀当前同号进程");
    }
    await writeFile(join(root, "provenance-evidence.json"), JSON.stringify({ pid: child.pid, foreignSourcesBlocked: true, unrelatedProcessAlive: true }));
  });
});

test("PAR-01: real model batches independent HTTP reads with bounded concurrency before writing delivery", { timeout: 120_000 }, async context => {
  await scenario(context, "parallel-real-reads", async ({ root, cwd }) => {
    await valueFixture(root, cwd); const { createServer } = await import("node:http"); let active = 0; let maximum = 0; const traces: unknown[] = [];
    const server = createServer((request, response) => { active++; maximum = Math.max(maximum, active); traces.push({ path: request.url, active, time: Date.now() });
      setTimeout(() => { response.end(request.url === "/left" ? "17" : "25"); active--; }, 500); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address() as { port: number }; const tools = ["left", "right"].map(name => ({ name: `probe-${name}`, description: `Read independent ${name} operand from host HTTP server; issue both probes in the same tool batch.`, parameters: { type: "object", properties: {}, additionalProperties: false }, effect: "read" as const, replay: "safe" as const, parallelSafe: true, validate: (value: unknown) => value,
      execute: async (_args: unknown, ctx: { signal: AbortSignal }) => ({ text: await (await fetch(`http://127.0.0.1:${address.port}/${name}`, { signal: ctx.signal })).text(), isError: false }) }));
    const session = await createAgentSession({ cwd, dataDirectory: join(root, "sessions"), config: { ...loadConfig(), thinking: "off" }, additionalTools: tools, maxReadConcurrency: 2, noShell: true }); context.after(() => session.close());
    const result = await session.submit("先在同一个工具调用批次中调用 probe-left 和 probe-right，二者独立可并行。得到实际数值后实现 lib/value.mts value() 返回两数之和，之后结束。");
    await writeFile(join(root, "parallel-evidence.json"), JSON.stringify({ result, maximum, traces }, null, 2)); assert.equal(result.status, "completed"); assert.equal(maximum, 2, "实际独立 HTTP 请求重叠，但不能超过配置上限"); assert.equal((await import(pathToFileURL(join(cwd, "lib/value.mts")).href)).value(), 42);
  });
});

test("ENV-02: real coding agent verifies its delivery inside the explicit container backend", { timeout: 180_000 }, async context => {
  await scenario(context, "container-agent-delivery", async ({ root, cwd }) => {
    await valueFixture(root, cwd); const host = await ContainerExecutionHost.create({ image: "node:24-bookworm-slim", workspace: cwd });
    let session: Awaited<ReturnType<typeof createAgentSession>> | undefined; context.after(async () => { await session?.close(); await host.close(); }); await host.restoreProcessGroups(join(root, "processes.jsonl"));
    session = await createAgentSession({ cwd, dataDirectory: join(root, "sessions"), config: { ...loadConfig(), thinking: "off" }, host });
    const result = await session.submit("实现 lib/value.mts value():number 返回 42，然后务必用 shell 在当前工作区运行 node --input-type=module -e \"import {value} from './lib/value.mts'; if(value()!==42)process.exit(1); console.log('verified-in-container')\"，根据实际结果结束。");
    await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2)); assert.equal(result.status, "completed", result.error);
    assert.ok(session.repository.messages().some(m => m.role === "tool_result" && m.toolName === "shell" && !m.isError && m.text.includes("verified-in-container")), "真实模型经过容器 shell 运行交付件，而不是只声明已检查");
  });
});

test("BG-02: crashed background owner is reconciled by real process identity without re-dispatch", { timeout: 30_000 }, async context => {
  await scenario(context, "background-owner-crash", async ({ root, cwd }) => {
    const host = await createExecutionHost(); context.after(() => host.close()); const tasks = new BackgroundTasks(join(root, "background"), host);
    const marker = join(root, "effect.jsonl"); const operation = await tasks.start({ executable: process.execPath, args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)},String(process.pid)+'\\n');setInterval(()=>{},1000)`], cwd, timeoutMs: 10000 });
    const deadline = Date.now() + 10000; while (!await readFile(marker, "utf8").then(() => true, () => false)) { if (Date.now() > deadline) throw new Error("background target unavailable"); await new Promise(r => setTimeout(r, 30)); }
    const { readdir } = await import("node:fs/promises"); let owner: number | undefined;
    for (const name of await readdir("/proc")) if (/^\d+$/.test(name)) { const cmdline = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => ""); if (/background-worker\.(?:js|ts)/.test(cmdline) && cmdline.includes(operation.operationId)) owner = Number(name); }
    assert.ok(owner); process.kill(owner, "SIGKILL"); let recovered: string;
    do { recovered = await tasks.recover(operation.operationId); if (recovered === "running") await new Promise(r => setTimeout(r, 30)); if (Date.now() > deadline) throw new Error("background ownership not released"); } while (recovered === "running");
    assert.equal(recovered, "effect_unknown"); const receipt = await tasks.wait(operation.operationId, { commandHash: operation.commandHash, signal: context.signal, timeoutMs: 5000 });
    assert.ok(receipt.status === "failed" && receipt.error?.includes("effect_unknown")); assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1); await writeFile(join(root, "recovery-evidence.json"), JSON.stringify(receipt));
  });
});
