import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createAgentSession } from "../src/harness/session.js";
import { SessionRepository } from "../src/storage/session.js";
import { assistant, config, FakeGateway, fixture } from "./helpers.js";

test("session appends serialize and preserve parent links", async (t) => {
  const f = await fixture(t);
  const repo = await SessionRepository.open({ directory: f.dataDirectory, cwd: f.cwd });
  f.cleanupAfter(() => repo.close());
  await Promise.all(Array.from({ length: 10 }, (_, index) => repo.appendMessage({
    role: "user", text: String(index), timestamp: Date.now(),
  })));
  const rows = (await readFile(repo.path, "utf8")).trim().split("\n").slice(1).map((line) => JSON.parse(line));
  assert.equal(rows.length, 10);
  rows.forEach((row, index) => assert.equal(row.parentId, index === 0 ? null : rows[index - 1].id));
});

test("exclusive lock prevents two writers and is released on close", async (t) => {
  const f = await fixture(t);
  const options = { directory: f.dataDirectory, cwd: f.cwd, sessionId: "locked" };
  const first = await SessionRepository.open(options);
  await assert.rejects(SessionRepository.open(options), /锁定/);
  await first.close();
  const second = await SessionRepository.open(options);
  await second.close();
});

test("an unfinished JSONL tail is repaired before another append", async (t) => {
  const f = await fixture(t);
  const options = { directory: f.dataDirectory, cwd: f.cwd, sessionId: "tail" };
  const first = await SessionRepository.open(options);
  await first.appendMessage({ role: "user", text: "中文", timestamp: Date.now() });
  await first.close();
  await appendFile(first.path, '{"unfinished":');
  const second = await SessionRepository.open(options);
  assert.equal(second.messages().length, 1);
  assert.equal(second.warnings.length, 1);
  await second.appendMessage({ role: "user", text: "next", timestamp: Date.now() });
  await second.close();
  const third = await SessionRepository.open(options);
  assert.deepEqual(third.messages().map((message) => message.text), ["中文", "next"]);
  await third.close();
});

test("corruption in the middle of a session is rejected", async (t) => {
  const f = await fixture(t);
  const options = { directory: f.dataDirectory, cwd: f.cwd, sessionId: "bad" };
  const first = await SessionRepository.open(options);
  await first.close();
  const header = await readFile(first.path, "utf8");
  await writeFile(first.path, header + 'not-json\n{"tail":true}\n');
  await assert.rejects(SessionRepository.open(options), /损坏/);
});

test("resuming an interrupted call adds an error result without replay", async (t) => {
  const f = await fixture(t);
  const first = await SessionRepository.open({ directory: f.dataDirectory, cwd: f.cwd, sessionId: "interrupted" });
  await first.appendMessage(assistant("", [{ id: "old-write", name: "write", arguments: { path: "unsafe", content: "no" } }]));
  await first.append({ kind: "tool_intent", call: { id: "old-write", name: "write", arguments: {} }, replay: "never" });
  await first.close();
  const gateway = new FakeGateway(() => assistant());
  const session = await createAgentSession({ ...f, config, sessionId: first.id, gateway });
  f.cleanupAfter(() => session.close());
  assert.equal((await session.submit("continue")).status, "completed");
  const repaired = gateway.requests[0]!.messages.find((message) => message.role === "tool_result");
  assert.ok(repaired?.role === "tool_result" && repaired.callId === "old-write" && repaired.isError);
  assert.match(repaired.text, /副作用未知/);
});
