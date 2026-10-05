import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, symlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { createAgentSession, createExecutionHost, createHistoryTool, createTaskController, SessionRepository, TaskRepository, type TaskReplayStats } from "../src/index.js";
import { SecretRedactor } from "../src/security.js";
import { digest } from "../src/storage/journal.js";
import { valueFixture } from "./e2e/value-fixture.js";
import { assistant, config, FakeGateway, fixture } from "./helpers.js";
const signal = () => new AbortController().signal;

async function historyFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t); const host = await createExecutionHost(); let repository = await SessionRepository.open({ directory: f.dataDirectory, cwd: f.cwd, host, redactor: new SecretRedactor([config.apiKey]) });
  f.cleanupAfter(async () => { await repository.close(); await host.close(); });
  await repository.appendMessage(assistant("archived", [{ id: "diag", name: "diagnostic", arguments: { path: "lib/result.json" } }]));
  const id = await repository.artifact("first\n" + config.apiKey + "\n" + "x".repeat(4200) + "\nrecoveryCode=R42");
  await repository.appendMessage({ role: "tool_result", callId: "diag", toolName: "diagnostic", text: "diagnostic excerpt", isError: false, timestamp: Date.now(), artifactId: id });
  const entryId = repository.cursor!;
  return { ...f, host, id, entryId, get repository() { return repository; }, async reopen() { const sessionId = repository.id; await repository.close(); repository = await SessionRepository.open({ directory: f.dataDirectory, cwd: f.cwd, sessionId, host, redactor: new SecretRedactor([config.apiKey]) }); } };
}

test("history source lookup and attachment pages survive reopen with secrets filtered", async t => {
  const f = await historyFixture(t); await f.reopen();
  const search = await f.repository.history({ path: "./lib/result.json" }, signal());
  assert.equal((search.entries as { entryId: string }[])[0]!.entryId, f.entryId);
  const first = await f.repository.history({ entryId: f.entryId, attachment: true, limit: 4096 }, signal());
  const tail = await f.repository.history({ entryId: f.entryId, attachment: true, offset: first.nextOffset as number, limit: 4096 }, signal());
  assert.ok(!(first.text as string).includes(config.apiKey) && (first.text as string).includes("[REDACTED]") && (tail.text as string).includes("recoveryCode=R42"));
});

test("history refuses foreign entries, paths, orphan attachments and invalid query scope", async t => {
  const f = await historyFixture(t); const tool = createHistoryTool(f.repository);
  const foreign = await SessionRepository.open({ directory: join(f.root, "other"), cwd: f.cwd, host: f.host });
  await foreign.appendMessage({ role: "user", text: "private foreign record", timestamp: 1 });
  await assert.rejects(f.repository.history({ entryId: foreign.cursor! }, signal()), /unavailable/); await foreign.close();
  for (const path of ["../outside", "/etc/passwd", ".codeagent/state", ".env"]) await assert.rejects(f.repository.history({ path }, signal()), /path_invalid/);
  assert.throws(() => tool.validate({ entryId: f.entryId, sessionId: "other" }), /query_invalid/);
  assert.throws(() => tool.validate({ path: "lib/result.json", entryId: f.entryId }), /query_invalid/);
  await assert.rejects(f.repository.history({ entryId: f.entryId, limit: 4097 }, signal()), /page_invalid/);
  const orphan = await f.repository.artifact("never committed");
  await f.repository.appendMessage({ role: "tool_result", callId: "orphan", toolName: "diagnostic", text: `attachment=${orphan}`, isError: false, timestamp: 2 });
  await assert.rejects(f.repository.history({ entryId: f.repository.cursor!, attachment: true }, signal()), /attachment_unavailable/);
});

test("history refuses modified or symlinked attachment files and directories", async t => {
  const f = await historyFixture(t); const directory = f.repository.path.slice(0, -6) + "-artifacts"; const path = join(directory, f.id); const original = await readFile(path);
  await writeFile(path, "changed"); await assert.rejects(f.repository.history({ entryId: f.entryId, attachment: true }, signal()), /integrity_invalid/);
  await unlink(path); const outside = join(f.root, "outside.txt"); await writeFile(outside, original); await symlink(outside, path);
  await assert.rejects(f.repository.history({ entryId: f.entryId, attachment: true }, signal()), /ELOOP/);
  await unlink(path); await writeFile(path, original); await rename(directory, `${directory}-real`); await symlink(`${directory}-real`, directory);
  await assert.rejects(f.repository.history({ entryId: f.entryId, attachment: true }, signal()), /path_invalid/);
});

test("SDK history obeys tool policy before reading committed data", async t => {
  const f = await fixture(t); const gateway = new FakeGateway((_request, _signal, index) => index === 0 ? assistant("", [{ id: "denied", name: "history", arguments: { path: "lib/result.json" } }]) : assistant());
  const session = await createAgentSession({ cwd: f.cwd, config, gateway, dataDirectory: f.dataDirectory, historyRetrieval: true, toolPolicy: async () => ({ action: "deny", reason: "history permission absent" }) });
  f.cleanupAfter(() => session.close()); await session.submit("read earlier diagnostics");
  const result = session.repository.messages().find(m => m.role === "tool_result");
  assert.ok(result?.role === "tool_result" && result.isError && result.text.includes("history permission absent"));
});

async function snapshotFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t); const spec = await valueFixture(f.root, f.cwd); spec.limits.maxModelRequests = 5;
  const controller = await createTaskController({ spec, config, gateway: new FakeGateway(() => { throw new Error("no model expected"); }), dataDirectory: f.dataDirectory });
  f.cleanupAfter(() => controller.close()); const id = controller.id; const directory = controller.repository.directory;
  await controller.repository.append({ type: "model_request_reserved", request: { id: "used", purpose: "execution", status: "reserved" } });
  const expected = controller.state; await controller.close();
  const host = await createExecutionHost(); f.cleanupAfter(() => host.close());
  const read = async (useSnapshot = true) => { let stats!: TaskReplayStats; const state = await TaskRepository.read(f.dataDirectory, id, { useSnapshot, observeReplay: value => stats = value }); return { state, stats }; };
  return { ...f, id, directory, host, expected, read, cache: join(directory, "snapshot.json"), log: join(directory, "events.jsonl") };
}

test("snapshot reuses the bound prefix and folds the authoritative suffix without resetting consumption", async t => {
  const f = await snapshotFixture(t); const old = await readFile(f.cache);
  const repo = await TaskRepository.open(f.dataDirectory, f.id, new SecretRedactor(), f.host);
  await assert.rejects(repo.append({ type: "state_checkpoint" } as never), /host_only/);
  await repo.append({ type: "task_status", status: "paused", reason: "suffix" }); await repo.close(); await writeFile(f.cache, old);
  const cached = await f.read(); const full = await f.read(false);
  assert.deepEqual(cached.state, full.state); assert.equal(cached.state.status, "paused");
  assert.ok(cached.stats.source === "snapshot" && cached.stats.foldedRecords < full.stats.foldedRecords && Object.keys(cached.state.modelRequests!).length === 1);
});

test("missing, legacy, malformed, forged and obsolete caches fall back to the same authoritative budget and state", async t => {
  const f = await snapshotFixture(t); const original = await readFile(f.cache, "utf8"); const cache = JSON.parse(original);
  await unlink(f.cache); assert.equal((await f.read()).stats.source, "full-log");
  const forged = structuredClone(cache); forged.state.status = "succeeded"; forged.state.modelRequests = {}; forged.stateHash = digest({ reducerVersion: forged.reducerVersion, state: forged.state });
  const deeplyNested = original.replace('"state":{', '"state":{"extra":' + "[".repeat(20_000) + "0" + "]".repeat(20_000) + ",");
  for (const content of ["{broken", deeplyNested, JSON.stringify({ seq: cache.seq, checksum: cache.checksum, state: cache.state }), JSON.stringify({ ...cache, reducerVersion: 999 }), JSON.stringify(forged), JSON.stringify({ ...cache, seq: cache.seq + 100 })]) {
    await writeFile(f.cache, content); const restored = await f.read();
    assert.ok(restored.stats.source === "full-log" && restored.state.status === "pending" && Object.keys(restored.state.modelRequests!).length === 1);
  }
});

test("valid snapshot cannot hide damaged prefix; only an incomplete tail is repaired", async t => {
  const f = await snapshotFixture(t); const original = await readFile(f.log, "utf8");
  await writeFile(f.log, original.replace('"pending"', '"succeeded"'));
  await assert.rejects(f.read(), /checksum/); await assert.rejects(TaskRepository.open(f.dataDirectory, f.id, new SecretRedactor(), f.host), /checksum/);
  await writeFile(f.log, original + '{"partial":');
  const repo = await TaskRepository.open(f.dataDirectory, f.id, new SecretRedactor(), f.host); assert.equal(repo.view().status, "pending"); await repo.close();
  assert.equal((await f.read()).state.status, "pending");
});
