import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { createTaskController, createExecutionHost, loadConfig, TaskRepository } from "../src/index.js";
import { SessionRepository } from "../src/storage/session.js";
import { RequestContext } from "../src/harness/context.js";
import { SecretRedactor } from "../src/security.js";
import { valueFixture } from "../tests/e2e/value-fixture.js";

const script = fileURLToPath(import.meta.url);
const samples = 5;
const noModel = { async *stream(): AsyncGenerator<never> { throw new Error("scale workload must not call a model"); } };
const policy = { softTokens: 500_000_000, hardTokens: 1_000_000_000, keepRecentTokens: 1_000, reserveOutputTokens: 8192 };
interface Dataset { root: string; taskId: string; sessionId: string; cwd: string; count: number; taskBytes: number; sessionBytes: number }
async function measure(data: Dataset, method: string) {
  const host = await createExecutionHost(); const times: number[] = []; const memory: { before: number; after: number }[] = [];
  try {
    for (let sample = 0; sample < samples; sample++) {
      globalThis.gc?.(); const before = process.memoryUsage().rss; const start = performance.now();
      if (method === "task-read") {
        const state = await TaskRepository.read(join(data.root, "state"), data.taskId);
        assert.equal(state.status, "pending"); assert.match(state.reason!, new RegExp(`synthetic-${data.count - 2}:`));
      } else if (method === "task-open") {
        const repository = await TaskRepository.open(join(data.root, "state"), data.taskId, new SecretRedactor(), host);
        try { assert.equal(repository.view().status, "pending"); } finally { await repository.close(); }
      } else {
        const repository = await SessionRepository.open({ directory: join(data.root, "sessions"), cwd: data.cwd, sessionId: data.sessionId, host });
        try {
          const context = new RequestContext(repository, noModel, policy);
          const messages = await context.build([], new AbortController().signal);
          assert.equal(messages.length, data.count); assert.equal(messages.at(-1)!.role, "user");
        } finally { await repository.close(); }
      }
      times.push(performance.now() - start); memory.push({ before, after: process.memoryUsage().rss });
    }
    const sorted = [...times].sort((a, b) => a - b);
    return { method, samples: times, minMs: sorted[0], medianMs: sorted[2], maxMs: sorted.at(-1), memoryRssBytes: memory,
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024, includesClose: method !== "task-read", gcBetweenSamples: typeof globalThis.gc === "function" };
  } finally { await host.close(); }
}

if (process.argv[2] === "--worker") {
  const data = JSON.parse(await readFile(process.argv[3]!, "utf8")) as Dataset;
  await writeFile(process.argv[5]!, JSON.stringify(await measure(data, process.argv[4]!), null, 2));
} else {
  const root = await mkdtemp(join(process.cwd(), ".codeagent", "large-log-"));
  const report: Record<string, unknown> = { platform: process.platform, node: process.version, timestamp: new Date().toISOString(),
    source: "synthetic facts via public append; no actual engineering/model trajectory", samplesPerMethod: samples,
    baseline: "1000 facts with same fields, storage, script and policy; 10000/50000 grow count only", cache: "page cache warm from generation; no OS cache eviction; independent worker per scale/method", policy,
    metrics: "wall time including checksum validation; task-open includes snapshot close; session-open-project includes full load/projection/close; peak RSS is whole worker lifetime, not an isolated heap delta", datasets: [] };
  const host = await createExecutionHost();
  try {
    for (const count of [1000, 10000, 50000]) {
      const directory = join(root, String(count)); const cwd = join(directory, "workspace"); await mkdir(cwd, { recursive: true });
      const spec = await valueFixture(directory, cwd); const config = loadConfig();
      const controller = await createTaskController({ spec, config, gateway: noModel, dataDirectory: join(directory, "state") });
      const taskId = controller.id;
      try { for (let i = 0; i < count - 1; i++) await controller.repository.append({ type: "task_status", status: "pending", reason: `synthetic-${i}:` + "x".repeat(1024) }); }
      finally { await controller.close(); }
      const session = await SessionRepository.open({ directory: join(directory, "sessions"), cwd, host });
      const sessionId = session.id;
      try { for (let i = 0; i < count; i++) await session.appendMessage({ role: "user", text: `synthetic-${i}:` + "y".repeat(512), timestamp: i }); }
      finally { await session.close(); }
      const data: Dataset = { root: directory, cwd, count, taskId, sessionId,
        taskBytes: (await stat(join(directory, "state/tasks", taskId, "events.jsonl"))).size,
        sessionBytes: (await stat(join(directory, "sessions", `${sessionId}.jsonl`))).size };
      const input = join(directory, "dataset.json"); await writeFile(input, JSON.stringify(data, null, 2));
      const measurements = [];
      for (const method of ["task-read", "task-open", "session-open-project"]) {
        const output = join(directory, `${method}.json`);
        await new Promise<void>((resolve, reject) => {
          const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
          const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", script, "--worker", input, method, output], { env, stdio: ["ignore", "ignore", "pipe"] });
          let diagnostic = ""; child.stderr.on("data", chunk => diagnostic += chunk); child.once("error", reject);
          child.once("close", code => code === 0 ? resolve() : reject(new Error(`benchmark ${count}/${method} exited ${code}: ${diagnostic}`)));
        });
        measurements.push(JSON.parse(await readFile(output, "utf8")));
      }
      (report.datasets as unknown[]).push({ ...data, measurements });
      await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
      console.log(`Measured ${count} facts; report: ${join(root, "report.json")}`);
    }
    report.scriptSha256 = createHash("sha256").update(await readFile(script)).digest("hex"); report.status = "passed";
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(".codeagent/linux-only-large-log-report-path.txt", join(root, "report.json") + "\n");
  } finally { await host.close(); }
}
