import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSession, loadConfig, serveSessionWeb } from "../../src/index.js";
import { valueFixture } from "./value-fixture.js";
import { scenario, saveSuiteReport } from "./helpers.js";
after(saveSuiteReport);

test("RPC-01: actual subprocess JSONL session accepts durable ID and real model edits the workspace", { timeout: 120_000 }, async context => {
  await scenario(context, "rpc-subprocess", async ({ root, cwd }) => {
    await valueFixture(root, cwd); const env: NodeJS.ProcessEnv = { ...process.env, MIMO_THINKING: "off" }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [join(process.cwd(), "dist/rpc/cli.js"), "--cwd", cwd, "--data-dir", join(root, "rpc-sessions")], { stdio: "pipe", env }); context.after(() => { child.kill("SIGKILL"); });
    const messages: any[] = []; const line = createInterface({ input: child.stdout }); line.on("line", text => { messages.push(JSON.parse(text)); void appendFile(join(root, "rpc.jsonl"), text + "\n"); }); child.stderr.on("data", data => { void appendFile(join(root, "rpc.stderr.log"), data); });
    async function wait(predicate: (m: any) => boolean) { const deadline = Date.now() + 100000; for (;;) { context.signal.throwIfAborted(); const value = messages.find(predicate); if (value) return value;
      if (child.exitCode !== null || Date.now() > deadline) throw new Error("rpc response unavailable"); await new Promise(r => setTimeout(r, 30)); } }
    await wait(m => m.method === "ready");
    const request = { jsonrpc: "2.0", id: 1, method: "submit", params: { inputId: "rpc-input", prompt: "只使用 write 实现 lib/value.mts，导出 value():number 返回 42。结束后简述。" } }; child.stdin.write(JSON.stringify(request) + "\n");
    const accepted = await wait(m => m.id === 1); assert.ok(accepted.result?.inputId === "rpc-input");
    const result = await wait(m => m.method === "result" && m.params.inputId === "rpc-input"); assert.equal(result.params.run.status, "completed"); assert.equal((await import(pathToFileURL(join(cwd, "lib/value.mts")).href)).value(), 42);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "steer", params: { inputId: "rpc-steer", prompt: '先通过 shell 执行 node -e "setTimeout(()=>{},3000)" 等待，再使用 write 改为导出 value():number 返回 43，然后结束。' } }) + "\n");
    assert.equal((await wait(m => m.id === 4)).result.inputId, "rpc-steer");
    await wait(m => m.method === "event" && m.params.type === "tool_started" && m.params.call.name === "shell");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "steer", params: { inputId: "rpc-active-steer", prompt: "更新当前需求：最终 value():number 必须返回 44，替代刚才的 43；等当前批次完成后修改并结束。" } }) + "\n");
    assert.equal((await wait(m => m.id === 5)).result.inputId, "rpc-active-steer");
    assert.equal((await wait(m => m.method === "result" && m.params.inputId === "rpc-steer")).params.run.status, "completed");
    assert.equal((await wait(m => m.method === "result" && m.params.inputId === "rpc-active-steer")).params.run.status, "completed");
    assert.equal((await import(pathToFileURL(join(cwd, "lib/value.mts")).href + "?after-steer")).value(), 44);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "status" }) + "\n"); assert.ok((await wait(m => m.id === 2)).result.cursor);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "close" }) + "\n"); await wait(m => m.id === 3); child.stdin.end();
  });
});

test("WEB-01: loopback session UI rejects unauthenticated writes and real agent delivers through HTTP", { timeout: 120_000 }, async context => {
  await scenario(context, "web-loopback", async ({ root, cwd }) => {
    await valueFixture(root, cwd); const session = await createAgentSession({ cwd, dataDirectory: join(root, "web-sessions"), durableInbox: true, config: { ...loadConfig(), thinking: "off" } }); context.after(() => session.close());
    const web = await serveSessionWeb(session); context.after(() => web.close());
    const origin = new URL(web.url); const denied = await fetch(origin.origin + "/submit", { method: "POST", body: JSON.stringify({ prompt: "unauthorized" }) }); assert.equal(denied.status, 403);
    const ui = await fetch(web.url); assert.ok((await ui.text()).includes("Code Agent"));
    origin.pathname = "/submit";
    const accepted = await fetch(origin, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputId: "web-input", prompt: "只使用 write 写入 lib/value.mts，导出 value():number 返回 42；随后结束。" }) }); assert.equal(accepted.status, 200);
    const result = await session.waitInput("web-input"); assert.equal(result.status, "completed", result.error); assert.equal((await import(pathToFileURL(join(cwd, "lib/value.mts")).href)).value(), 42);
    origin.pathname = "/events"; const events = await (await fetch(origin)).json() as { events: unknown[] }; assert.ok(events.events.length); await writeFile(join(root, "web-evidence.json"), JSON.stringify({ denied: denied.status, result, events }, null, 2));
  });
});
