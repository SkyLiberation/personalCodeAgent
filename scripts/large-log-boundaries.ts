import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createExecutionHost, TaskRepository, SessionRepository } from "../src/index.js";
import { SecretRedactor } from "../src/security.js";
const path = process.argv[2]; if (!path) throw new Error("usage: large-log-boundaries.ts /path/to/scale-report.json");
const report = JSON.parse(await readFile(path, "utf8"));
const data = report.datasets.at(-1) as { root: string; taskId: string; sessionId: string; cwd: string; count: number };
const taskPath = join(data.root, "state/tasks", data.taskId, "events.jsonl");
const sessionPath = join(data.root, "sessions", `${data.sessionId}.jsonl`);
const taskOriginal = await readFile(taskPath, "utf8"); const sessionOriginal = await readFile(sessionPath, "utf8");
const host = await createExecutionHost();
try {
  const lines = taskOriginal.split("\n"); const corrupt = JSON.parse(lines[1]!); corrupt.reason += "modified-prefix"; lines[1] = JSON.stringify(corrupt);
  await writeFile(taskPath, lines.join("\n"));
  await assert.rejects(TaskRepository.read(join(data.root, "state"), data.taskId), /journal_checksum_mismatch/);
  await assert.rejects(TaskRepository.open(join(data.root, "state"), data.taskId, new SecretRedactor(), host), /journal_checksum_mismatch/);
  await writeFile(taskPath, taskOriginal + '{"incomplete":');
  assert.equal((await TaskRepository.read(join(data.root, "state"), data.taskId)).status, "pending");
  const task = await TaskRepository.open(join(data.root, "state"), data.taskId, new SecretRedactor(), host);
  await task.close(); assert.equal((await stat(taskPath)).size, Buffer.byteLength(taskOriginal));
  const sessionLines = sessionOriginal.split("\n"); const entry = JSON.parse(sessionLines[1]!); entry.message.text += "modified-prefix"; sessionLines[1] = JSON.stringify(entry);
  await writeFile(sessionPath, sessionLines.join("\n"));
  await assert.rejects(SessionRepository.open({ directory: join(data.root, "sessions"), cwd: data.cwd, sessionId: data.sessionId, host }), /journal_checksum_mismatch/);
  await writeFile(sessionPath, sessionOriginal + '{"incomplete":');
  const session = await SessionRepository.open({ directory: join(data.root, "sessions"), cwd: data.cwd, sessionId: data.sessionId, host });
  await session.close(); assert.equal((await stat(sessionPath)).size, Buffer.byteLength(sessionOriginal));
  report.boundaries = { status: "passed", count: data.count, modelRequests: 0, taskPrefixCorruptionRejectedByReadAndOpen: true,
    sessionPrefixCorruptionRejected: true, incompleteTailOnlyRepaired: true, taskAndSessionRestored: true,
    scriptSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex") };
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`Large-log boundaries passed: ${data.count} facts`);
} finally {
  await writeFile(taskPath, taskOriginal); await writeFile(sessionPath, sessionOriginal); await host.close();
}
