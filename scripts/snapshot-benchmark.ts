import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createExecutionHost, createTaskController, loadConfig, TaskRepository, type TaskReplayStats } from "../src/index.js";
import { SecretRedactor } from "../src/security.js";
import { valueFixture } from "../tests/e2e/value-fixture.js";

const script = fileURLToPath(import.meta.url);
const noModel = { async *stream(): AsyncGenerator<never> { throw new Error("synthetic benchmark cannot dispatch models"); } };
interface Dataset { root: string; id: string; kind: "status" | "quota"; count: number; logBytes: number; snapshotBytes: number; logSha256: string }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function measure(data: Dataset, method: string, snapshot: boolean) {
  const host = await createExecutionHost(); const samples: { ms: number; rssBefore: number; rssAfter: number; replay: TaskReplayStats }[] = [];
  const directory = join(data.root, "state/tasks", data.id); const logPath = join(directory, "events.jsonl"); const cachePath = join(directory, "snapshot.json");
  const originalLog = await readFile(logPath); const originalCache = await readFile(cachePath);
  try {
    for (let index = 0; index < 5; index++) {
      globalThis.gc?.(); const before = process.memoryUsage().rss; let replay!: TaskReplayStats; const start = performance.now();
      const options = { useSnapshot: snapshot, observeReplay: (value: TaskReplayStats) => { replay = value; } };
      let state;
      if (method === "read") state = await TaskRepository.read(join(data.root, "state"), data.id, options);
      else {
        const repository = await TaskRepository.open(join(data.root, "state"), data.id, new SecretRedactor(), host, options);
        const elapsed = performance.now() - start;
        state = repository.view();
        samples.push({ ms: elapsed, rssBefore: before, rssAfter: process.memoryUsage().rss, replay });
        await repository.close();
        // Close commits a new checkpoint. Restore outside timing so every sample uses identical bytes.
        await writeFile(logPath, originalLog); await writeFile(cachePath, originalCache);
      }
      if (method === "read") samples.push({ ms: performance.now() - start, rssBefore: before, rssAfter: process.memoryUsage().rss, replay });
      assert.equal(state.status, "pending");
      if (data.kind === "quota") assert.equal(Object.keys(state.modelRequests ?? {}).length, data.count);
      else assert.match(state.reason!, new RegExp(`status-${data.count - 1}:`));
      assert.equal(replay.source, snapshot ? "snapshot" : "full-log");
      assert.equal(replay.foldedRecords, snapshot ? 0 : data.count + 1);
    }
    assert.equal(hash(await readFile(logPath)), data.logSha256);
    const sorted = samples.map(s => s.ms).sort((a, b) => a - b);
    return { method, useSnapshot: snapshot, samples, minMs: sorted[0], medianMs: sorted[2], maxMs: sorted[4], processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      includesClose: false, gcBetweenSamples: typeof globalThis.gc === "function" };
  } finally { await host.close(); }
}

if (process.argv[2] === "--worker") {
  const dataset = JSON.parse(await readFile(process.argv[3]!, "utf8")) as Dataset;
  await writeFile(process.argv[6]!, JSON.stringify(await measure(dataset, process.argv[4]!, process.argv[5] === "snapshot"), null, 2));
} else {
  const root = await mkdtemp(join(process.cwd(), ".codeagent", "snapshot-scale-"));
  const report: Record<string, unknown> = { timestamp: new Date().toISOString(), platform: process.platform, node: process.version,
    workload: "synthetic committed status facts and request reservations; zero model dispatch; not business completion statistics",
    comparison: "same exact journal and snapshot bytes; full checksum chain in both modes; five samples in separate worker per method/mode; warm page cache",
    metrics: "wall time includes full parsing/checksum; open includes lease and tail check, excludes close; RSS is whole worker lifetime; concurrent E2E load",
    datasets: [], sourceHashes: {} };
  for (const path of ["src/storage/task.ts", "src/storage/journal.ts", "src/storage/guarded-file.ts", "scripts/snapshot-benchmark.ts"]) (report.sourceHashes as Record<string, string>)[path] = hash(await readFile(path));
  for (const [kind, count] of [["status", 1000], ["status", 10000], ["status", 50000], ["quota", 1000], ["quota", 5000]] as const) {
    const directory = join(root, `${kind}-${count}`); const cwd = join(directory, "workspace"); await mkdir(cwd, { recursive: true });
    const spec = await valueFixture(directory, cwd); spec.limits.maxModelRequests = 10000;
    const controller = await createTaskController({ spec, config: loadConfig(), gateway: noModel, dataDirectory: join(directory, "state") }); const id = controller.id;
    try {
      for (let index = 0; index < count; index++) {
        if (kind === "status") await controller.repository.append({ type: "task_status", status: "pending", reason: `status-${index}:` + "x".repeat(1024) });
        else await controller.repository.append({ type: "model_request_reserved", request: { id: `synthetic-${index}`, purpose: "execution", status: "reserved" } });
      }
    } finally { await controller.close(); }
    const logPath = join(directory, "state/tasks", id, "events.jsonl"); const cachePath = join(directory, "state/tasks", id, "snapshot.json");
    const data: Dataset = { root: directory, id, kind, count, logBytes: (await stat(logPath)).size, snapshotBytes: (await stat(cachePath)).size, logSha256: hash(await readFile(logPath)) };
    const input = join(directory, "dataset.json"); await writeFile(input, JSON.stringify(data, null, 2)); const measurements = [];
    for (const method of ["read", "open"]) for (const mode of ["full", "snapshot"]) {
      const output = join(directory, `${method}-${mode}.json`);
      await new Promise<void>((resolve, reject) => {
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", script, "--worker", input, method, mode, output], { env, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = ""; child.stderr.on("data", chunk => stderr += chunk); child.once("error", reject);
        child.once("close", code => code === 0 ? resolve() : reject(new Error(`${kind}/${count}/${method}/${mode} exit ${code}: ${stderr}`)));
      });
      measurements.push(JSON.parse(await readFile(output, "utf8")));
    }
    (report.datasets as unknown[]).push({ ...data, measurements });
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2)); console.log(`Measured ${kind}/${count}: ${join(root, "report.json")}`);
  }
  report.status = "passed"; await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(".codeagent/hrss-benchmark-path.txt", join(root, "report.json") + "\n");
}
