import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { LocalEnvironment } from "../src/environment/local.js";
import { SecretRedactor } from "../src/security.js";
import { fixture } from "./helpers.js";

test("file reads, atomic writes and exact edits handle UTF-8", async (t) => {
  const f = await fixture(t);
  const environment = await LocalEnvironment.create(f.cwd);
  const signal = new AbortController().signal;
  await environment.write("nested/file.txt", "第一行\nsecond\n", signal);
  await environment.edit("nested/file.txt", "second", "第二行", signal);
  assert.equal(await readFile(join(f.cwd, "nested/file.txt"), "utf8"), "第一行\n第二行\n");
  assert.match(await environment.read("nested/file.txt", 2, 1, signal), /2: 第二行/);
  await assert.rejects(environment.edit("nested/file.txt", "missing", "new", signal), /未找到/);
});

test("ambiguous edits leave the file unchanged", async (t) => {
  const f = await fixture(t);
  const environment = await LocalEnvironment.create(f.cwd);
  await writeFile(join(f.cwd, "file.txt"), "same same");
  await assert.rejects(environment.edit("file.txt", "same", "new", new AbortController().signal), /多处/);
  assert.equal(await readFile(join(f.cwd, "file.txt"), "utf8"), "same same");
});

test("traversal, secret files and outside symlinks are rejected", async (t) => {
  const f = await fixture(t);
  const environment = await LocalEnvironment.create(f.cwd);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(f.cwd, ".env"), "secret");
  const signal = new AbortController().signal;
  await assert.rejects(environment.write("../outside/file", "bad", signal), /工作区/);
  await assert.rejects(environment.read(".env", 1, 10, signal), /密钥/);
  await assert.rejects(environment.write(".codeagent/state", "bad", signal), /私有/);
  await symlink(outside, join(f.cwd, "link"), "dir");
  await assert.rejects(environment.write("link/new/file.txt", "bad", signal), /工作区/);
});

test("shell preserves UTF-8 output and nonzero exit status", async (t) => {
  const f = await fixture(t);
  const environment = await LocalEnvironment.create(f.cwd);
  const result = await environment.run("node -e \"process.stdout.write('中文'); process.exit(7)\"",
    environment.shell, new AbortController().signal);
  assert.equal(result.exitCode, 7);
  assert.match(result.output, /中文/);
});

test("shell timeout stops a process instead of waiting for it to complete", async (t) => {
  const f = await fixture(t);
  const environment = await LocalEnvironment.create(f.cwd, 300);
  const result = await environment.run("node -e \"setTimeout(() => {}, 10000)\"", environment.shell,
    new AbortController().signal);
  assert.equal(result.timedOut, true);
});

test("shell abort propagates and closes the process", async (t) => {
  const f = await fixture(t);
  const environment = await LocalEnvironment.create(f.cwd);
  const controller = new AbortController();
  const operation = environment.run("node -e \"setTimeout(() => {}, 10000)\"", environment.shell, controller.signal);
  const rejected = assert.rejects(operation, /取消/);
  await delay(200);
  controller.abort();
  await rejected;
});

test("streaming redaction detects a secret split across chunks", () => {
  const redactor = new SecretRedactor(["secret-token-value"]);
  const stream = redactor.stream();
  const text = stream.write("before sec") + stream.write("ret-token-") + stream.write("value after") + stream.end();
  assert.equal(text, "before [REDACTED] after");
});

test("removed shell contract refuses execution before any workspace effect", async (t) => {
  const f = await fixture(t); const environment = await LocalEnvironment.create(f.cwd);
  const signal = new AbortController().signal;
  await assert.rejects(environment.run("touch rejected-shell-marker", "powershell" as "bash", signal), /unsupported_shell/);
  await assert.rejects(readFile(join(f.cwd, "rejected-shell-marker")), { code: "ENOENT" });
});

test("unsupported platforms reject local execution and ownership before opening resources", async () => {
  const { createExecutionHost } = await import("../src/platform/host.js");
  const { McpClient } = await import("../src/tools/mcp.js");
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  try {
    await assert.rejects(LocalEnvironment.create(process.cwd()), /unsupported_platform/);
    await assert.rejects(createExecutionHost(), /unsupported_platform/);
    await assert.rejects(McpClient.connect({ command: process.execPath, cwd: process.cwd() }), /unsupported_platform/);
  } finally { Object.defineProperty(process, "platform", original); }
});
