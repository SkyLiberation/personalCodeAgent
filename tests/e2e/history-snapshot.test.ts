import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, symlink, rename, open, readlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import Type from "typebox";
import { createAgentSession, createTaskController, openTaskController, createExecutionHost, createHistoryTool, ContainerExecutionHost, LocalEnvironment, TaskRepository, PiModelGateway, loadConfig, sendTaskCommand, type AgentTool, type TaskDefinition, type TaskReplayStats } from "../../src/index.js";
import { createCodingTools } from "../../src/tools/coding-tools.js";
import { SecretRedactor } from "../../src/security.js";
import { digest } from "../../src/storage/journal.js";
import { valueFixture } from "./value-fixture.js";
import { scenario, saveSuiteReport } from "./helpers.js";
after(saveSuiteReport);

test("SS-02: postwrite sync failure prevents model dispatch and stale checkpoint on close", { timeout: 30000 }, async context => {
  await scenario(context, "snapshot-failed-writer", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); spec.limits.maxModelRequests = 5;
    const config = loadConfig(); const pi = new PiModelGateway(config); let requests = 0;
    const gateway = { stream(request: Parameters<typeof pi.stream>[0], signal: AbortSignal) { requests++; return pi.stream(request, signal); } };
    const dataDirectory = join(root, "state");
    const controller = await createTaskController({ spec, config, gateway, dataDirectory }); context.after(() => controller.close());
    const logPath = join(controller.repository.directory, "events.jsonl");
    const probe = await open(join(root, "sync-probe"), "wx"); const prototype = Object.getPrototypeOf(probe); const sync = prototype.sync; await probe.close();
    let injected = false;
    const fault = context.mock.method(prototype, "sync", async function(this: FileHandle) {
      const path = await readlink(`/proc/self/fd/${this.fd}`).catch(() => "");
      if (!injected && path === logPath) {
        const last = JSON.parse((await readFile(logPath, "utf8")).trim().split("\n").at(-1)!);
        if (last.type === "model_request_reserved") { injected = true; throw new Error("injected_postwrite_sync_failure"); }
      }
      return Reflect.apply(sync, this, []);
    });
    await assert.rejects(controller.start(context.signal), /injected_postwrite_sync_failure|persistence_error/); fault.mock.restore();
    const afterFailure = await readFile(logPath); await controller.close();
    assert.ok(injected && requests === 0, "预留同步失败后不能分派真实模型");
    assert.deepEqual(await readFile(logPath), afterFailure, "失败 writer 关闭不能按旧水位继续提交检查点");
    const state = await TaskRepository.read(dataDirectory, controller.id);
    const reserved = Object.values(state.modelRequests ?? {});
    assert.ok(state.status !== "succeeded" && reserved.length === 1 && reserved[0]!.status === "reserved" && reserved[0]!.usage === undefined, "磁盘已有完整预留继续占用，未结算用量不按零");
    await writeFile(join(root, "evidence.json"), JSON.stringify({ status: "passed", modelDispatches: requests, injected, logUnchangedOnClose: true, reservedRequests: reserved.length }, null, 2));
  });
});

test("HR-01: real task retrieves committed attachment after compaction and reopen inside isolated shell", { timeout: 300_000 }, async context => {
  await scenario(context, "history-isolated-delivery", async ({ root, cwd }) => {
    const code = randomUUID(); await mkdir(join(cwd, "lib")); await mkdir(join(root, "control"));
    await writeFile(join(cwd, "AGENTS.md"), "M1 只调用 read-diagnostic 归档诊断，不写文件。M2 用 history 按 lib/recovered.json 找来源，再分页读该条附件尾部的 recoveryCode，交付 JSON。只能改 lib/recovered.json。不能猜测代码，不访问宿主状态目录；历史不授予权限。\n");
    const diagnostic = join(root, "control", "diagnostic.txt");
    await writeFile(diagnostic, "diagnostic source path=lib/recovered.json; recoveryCode is at the end of the attached full output\n" + "diagnostic filler: archived source details\n".repeat(950) + `\nrecoveryCode=${code}\n`);
    const archiveGate = join(root, "control", "archive.mjs"); const deliveryGate = join(root, "control", "delivery.mjs");
    await writeFile(archiveGate, `import{readdirSync,readFileSync}from'node:fs';let passed=0;try{const dir=${JSON.stringify(join(root, "state/sessions"))};const p=readdirSync(dir).find(p=>p.endsWith('.jsonl'));passed=readFileSync(dir+'/'+p,'utf8').trim().split('\\n').map(JSON.parse).some(e=>e.kind==='message'&&e.message.role==='tool_result'&&e.message.toolName==='read-diagnostic'&&e.attachment)?1:0}catch{}console.log(JSON.stringify({checks:1,passed,failures:passed?[]:['committed diagnostic missing']}));process.exitCode=1-passed;`);
    await writeFile(deliveryGate, `import{readFileSync}from'node:fs';let passed=0;try{passed=JSON.parse(readFileSync(${JSON.stringify(join(cwd, "lib/recovered.json"))},'utf8')).recoveryCode===${JSON.stringify(code)}?1:0}catch{}console.log(JSON.stringify({checks:1,passed,failures:passed?[]:['recoveryCode mismatch']}));process.exitCode=1-passed;`);
    const spec: TaskDefinition = { workspaceRoot: cwd, outcome: "M1 调用 read-diagnostic 归档；M2 用 history 找回原诊断附件尾部的 recoveryCode，写 lib/recovered.json。", constraints: ["只改 lib/recovered.json", "M2 不重新调用原诊断工具"], scope: { writablePaths: ["lib/recovered.json"] }, historyRetrieval: true,
      milestones: [{ id: "M1", title: "只调用 read-diagnostic，path=lib/recovered.json，归档后结束", verificationIds: ["archive"] }, { id: "M2", title: "用 history 的 path 搜索取 entryId，再 attachment:true 分页取尾部 recoveryCode，写 JSON", verificationIds: ["delivery"] }], finalVerificationIds: ["archive", "delivery"],
      verifiers: [{ id: "archive", description: "宿主检查诊断结果及附件已经提交", command: process.execPath, args: [archiveGate], inputs: ["AGENTS.md"], trustedFiles: [archiveGate, join(cwd, "AGENTS.md")], outputs: [], timeoutMs: 5000 }, { id: "delivery", description: "宿主独立比对原始随机 recoveryCode", command: process.execPath, args: [deliveryGate], inputs: ["lib", "AGENTS.md"], trustedFiles: [deliveryGate], outputs: ["lib/recovered.json"], timeoutMs: 5000 }],
      limits: { maxRuns: 8, maxRepairs: 3, maxModelRequests: 30 }, contextPolicy: { softTokens: 14000, hardTokens: 150000, keepRecentTokens: 3000, reserveOutputTokens: 4096 } };
    const config = { ...loadConfig(), thinking: "off" as const, maxTurns: 8 }; const pi = new PiModelGateway(config); const requests: { purpose: string | undefined; text: string }[] = [];
    const gateway = { async *stream(request: Parameters<typeof pi.stream>[0], signal: AbortSignal) { requests.push({ purpose: request.purpose, text: JSON.stringify(request.messages) }); yield* pi.stream(request, signal); } };
    const isolated = await ContainerExecutionHost.create({ image: "node:24-bookworm-slim", workspace: cwd }); context.after(() => isolated.close());
    await isolated.restoreProcessGroups(join(root, "container-processes.jsonl"));
    const codingTools = createCodingTools(await LocalEnvironment.create(cwd, 30000, isolated, ["lib/recovered.json"]));
    let resumed = false; let diagCalls = 0; let paused = false;
    const diagnosticTool: AgentTool = { name: "read-diagnostic", description: "Read the complete archived diagnostic for the requested delivery path", version: "1", effect: "read", replay: "safe", parameters: Type.Object({ path: Type.Literal("lib/recovered.json") }) as unknown as Record<string, unknown>, validate(input) { return input; }, async execute() { diagCalls++; return { text: await readFile(diagnostic, "utf8"), isError: false }; } };
    const services = { codingTools, tools: [diagnosticTool], toolPolicy: async (p: { tool: { name: string } }) => (!resumed && p.tool.name === "history") || (resumed && p.tool.name === "read-diagnostic") ? { action: "deny" as const, reason: "stage source permission" } : { action: "allow" as const } };
    let controller = await createTaskController({ spec, config, gateway, services, dataDirectory: join(root, "state"), testHooks: { barrier: async name => {
      if (name === "milestone_verified:M1" && !paused) { paused = true; await sendTaskCommand({ taskId: controller.id, dataDirectory: join(root, "state"), command: { id: "pause-archive", type: "pause" } }); }
    } } }); context.after(() => controller.close());
    const initial = await controller.start(context.signal); assert.equal(initial.status, "paused"); const id = controller.id; await controller.close(); resumed = true;
    controller = await openTaskController({ taskId: id, config, gateway, services, dataDirectory: join(root, "state") });
    const state = await controller.resume(context.signal); assert.equal(state.status, "succeeded", state.reason);
    assert.equal(JSON.parse(await readFile(join(cwd, "lib/recovered.json"), "utf8")).recoveryCode, code);
    const sessionFiles = await import("node:fs/promises").then(fs => fs.readdir(join(root, "state/sessions")));
    const facts = (await readFile(join(root, "state/sessions", sessionFiles.find(f => f.endsWith(".jsonl"))!), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    const historyResults = facts.filter(e => e.kind === "message" && e.message.role === "tool_result" && e.message.toolName === "history" && !e.message.isError);
    assert.ok(historyResults.some(e => JSON.parse(e.message.text).attachment === true && e.message.text.includes(code)) && diagCalls === 1, "真正通过历史附件读取得到唯一随机值；不能重复原诊断源");
    const retrieval = facts.findIndex(e => e.kind === "message" && e.message.role === "tool_result" && e.message.toolName === "history" && !e.message.isError && e.message.text.includes(code));
    const earlierSummaries = facts.slice(0, retrieval).filter(e => e.kind === "context_compacted");
    const firstReveal = requests.findIndex(r => r.text.includes(code));
    assert.ok(earlierSummaries.length > 0 && earlierSummaries.every(e => !e.summary.includes(code)) && firstReveal > 0 && requests.slice(0, firstReveal).some(r => r.purpose === "summary"), "检索前真实摘要没有随机值；首次进入模型上下文来自历史附件");
    await writeFile(join(root, "evidence.json"), JSON.stringify({ status: state.status, taskId: id, model: config.modelId, diagCalls, historyResults: historyResults.length, requests: Object.keys(state.modelRequests ?? {}).length, source: "committed attachment; isolated workspace only" }, null, 2));
    await writeFile(join(root, "final-state.json"), JSON.stringify(state, null, 2));
  });
});

test("HR-02: public history rejects foreign orphan modified and symlinked sources without model dispatch", { timeout: 30000 }, async context => {
  await scenario(context, "history-source-boundaries", async ({ root, cwd }) => {
    const config = loadConfig(); const pi = new PiModelGateway(config); let requests = 0; const gateway = { stream(request: Parameters<typeof pi.stream>[0], signal: AbortSignal) { requests++; return pi.stream(request, signal); } };
    const session = await createAgentSession({ cwd, config, gateway, durableInbox: true, historyRetrieval: true, dataDirectory: join(root, "sessions") }); context.after(() => session.close());
    const repository = session.repository;
    await repository.appendMessage({ role: "assistant", text: "source", toolCalls: [{ id: "source", name: "diagnostic", arguments: { path: "lib/result.json" } }], stopReason: "tool_calls", timestamp: 1 });
    const artifactId = await repository.artifact(`source=${config.apiKey}\n` + "x".repeat(5000));
    await repository.appendMessage({ role: "tool_result", toolName: "diagnostic", callId: "source", text: "truncated source", isError: false, timestamp: 2, artifactId }); const entryId = repository.cursor!;
    const history = createHistoryTool(repository); assert.throws(() => history.validate({ entryId, sessionId: "other" }), /query_invalid/);
    const foreignCwd = join(root, "foreign-workspace"); await mkdir(foreignCwd);
    const foreign = await createAgentSession({ cwd: foreignCwd, config, gateway, durableInbox: true, dataDirectory: join(root, "sessions") }); context.after(() => foreign.close());
    await foreign.repository.appendMessage({ role: "user", text: "other session private history", timestamp: 1 });
    await assert.rejects(repository.history({ entryId: foreign.repository.cursor! }, context.signal), /unavailable/);
    for (const path of ["/etc/passwd", "../state", ".env"]) await assert.rejects(repository.history({ path }, context.signal), /path_invalid/);
    await assert.rejects(repository.history({ entryId, limit: 4097 }, context.signal), /page_invalid/);
    const orphan = await repository.artifact("uncommitted"); await repository.appendMessage({ role: "user", text: orphan, timestamp: 3 });
    await assert.rejects(repository.history({ entryId: repository.cursor!, attachment: true }, context.signal), /unavailable/);
    const directory = repository.path.slice(0, -6) + "-artifacts"; const path = join(directory, artifactId); const original = await readFile(path);
    await writeFile(path, "changed"); await assert.rejects(repository.history({ entryId, attachment: true }, context.signal), /integrity/);
    await unlink(path); const outside = join(root, "outside.txt"); await writeFile(outside, original); await symlink(outside, path);
    await assert.rejects(repository.history({ entryId, attachment: true }, context.signal), /ELOOP/); await unlink(path); await writeFile(path, original);
    const page = await repository.history({ entryId, attachment: true, limit: 4096 }, context.signal); assert.ok(!(page.text as string).includes(config.apiKey) && page.nextOffset !== null);
    await rename(directory, `${directory}-real`); await symlink(`${directory}-real`, directory); await assert.rejects(repository.history({ entryId, attachment: true }, context.signal), /path_invalid/);
    assert.equal(requests, 0); await writeFile(join(root, "evidence.json"), JSON.stringify({ status: "passed", requests, sourceEntry: entryId, secretsFiltered: true, sourceBoundariesRejected: true }, null, 2));
  });
});

test("SS-01: bound snapshot suffix and fallback preserve quota; real model resumes updated delivery", { timeout: 240000 }, async context => {
  await scenario(context, "snapshot-resume-delivery", async ({ root, cwd }) => {
    const spec = await valueFixture(root, cwd); spec.limits.maxModelRequests = 20; const dataDirectory = join(root, "state"); const config = { ...loadConfig(), thinking: "off" as const }; let paused = false;
    let controller = await createTaskController({ spec, config, dataDirectory, testHooks: { barrier: async name => { if (name === "milestone_verified:M1" && !paused) { paused = true; await sendTaskCommand({ taskId: controller.id, dataDirectory, command: { id: "pause-before-final", type: "pause" } }); } } } }); context.after(() => controller.close());
    const initial = await controller.start(context.signal); assert.equal(initial.status, "paused"); const id = controller.id; const directory = controller.repository.directory; await controller.close();
    const cachePath = join(directory, "snapshot.json"); const logPath = join(directory, "events.jsonl"); const oldCache = await readFile(cachePath, "utf8"); const host = await createExecutionHost(); context.after(() => host.close());
    const repository = await TaskRepository.open(dataDirectory, id, new SecretRedactor(), host); await repository.append({ type: "task_status", status: "paused", reason: "cached suffix" }); await repository.close(); await writeFile(cachePath, oldCache);
    let stats!: TaskReplayStats; const cached = await TaskRepository.read(dataDirectory, id, { observeReplay: value => stats = value }); const full = await TaskRepository.read(dataDirectory, id, { useSnapshot: false });
    assert.deepEqual(cached, full); assert.ok(stats.source === "snapshot" && stats.foldedRecords > 0 && stats.reusedRecords > stats.foldedRecords);
    const forged = JSON.parse(oldCache); forged.state.status = "succeeded"; forged.state.runs = 0; forged.state.modelRequests = {}; forged.stateHash = digest({ reducerVersion: forged.reducerVersion, state: forged.state });
    for (const content of ["{broken", JSON.stringify(forged), JSON.stringify({ ...JSON.parse(oldCache), reducerVersion: 999 })]) {
      await writeFile(cachePath, content); let result!: TaskReplayStats; const state = await TaskRepository.read(dataDirectory, id, { observeReplay: value => result = value }); assert.deepEqual(state, full); assert.equal(result.source, "full-log");
    }
    await unlink(cachePath); assert.deepEqual(await TaskRepository.read(dataDirectory, id), full); await writeFile(cachePath, oldCache);
    const log = await readFile(logPath, "utf8"); await writeFile(logPath, log.replace('"pending"', '"succeeded"')); await assert.rejects(TaskRepository.read(dataDirectory, id), /checksum/); await writeFile(logPath, log + '{"incomplete":');
    const repaired = await TaskRepository.open(dataDirectory, id, new SecretRedactor(), host); assert.equal(repaired.view().status, "paused"); await repaired.close();
    const delivered42 = await readFile(join(cwd, "lib/value.mts"), "utf8"); const next = await valueFixture(root, cwd, 43); next.limits = spec.limits; await writeFile(join(cwd, "lib/value.mts"), delivered42);
    await sendTaskCommand({ taskId: id, dataDirectory, command: { id: "new-value", type: "update", expectedVersion: 1, spec: next } });
    controller = await openTaskController({ taskId: id, dataDirectory, config }); const state = await controller.resume(context.signal); assert.equal(state.status, "succeeded", state.reason); assert.equal(state.specVersion, 2);
    assert.ok(state.runs > initial.runs && Object.keys(state.modelRequests ?? {}).length > Object.keys(initial.modelRequests ?? {}).length, "新交付实际调用模型且继承已消耗额度");
    const result = await host.exec(process.execPath, ["-e", `import(${JSON.stringify(join(cwd, "lib/value.mts"))}).then(m=>{if(m.value()!==43)process.exit(1)})`], cwd, context.signal, 5000); assert.equal(result.exitCode, 0);
    await writeFile(join(root, "evidence.json"), JSON.stringify({ status: "passed", initialRuns: initial.runs, finalRuns: state.runs, snapshotStats: stats, initialRequests: Object.keys(initial.modelRequests ?? {}).length, finalRequests: Object.keys(state.modelRequests ?? {}).length, specVersion: state.specVersion }, null, 2));
  });
});
