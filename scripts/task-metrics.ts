import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TaskRepository, modelBudgetUsage } from "../src/index.js";

const [directory, taskId] = process.argv.slice(2);
if (!directory || !taskId) throw new Error("usage: node --import tsx scripts/task-metrics.ts <data-directory> <task-id>");
const elapsed: number[] = [];
let state = await TaskRepository.read(directory, taskId);
for (let i = 0; i < 5; i++) { const started = performance.now(); state = await TaskRepository.read(directory, taskId); elapsed.push(performance.now() - started); }
const path = join(directory, "tasks", state.id, "events.jsonl");
const requests = Object.values(state.modelRequests ?? {}); const byPurpose: Record<string, number> = {};
for (const request of requests) byPurpose[request.purpose] = (byPurpose[request.purpose] ?? 0) + 1;
const knownTokens = requests.filter(r => r.usage).reduce((sum, r) => sum + r.usage!.inputTokens + r.usage!.outputTokens, 0);
const usage = modelBudgetUsage(state);
console.log(JSON.stringify({ taskId, status: state.status, execution: state.execution, runs: state.runs, repairs: state.repairs,
  requests: { total: requests.length, byPurpose, unknownUsage: requests.filter(r => !r.usage).length, knownTokens },
  usage: { ...usage, tokens: Number.isFinite(usage.tokens) ? usage.tokens : "unknown_unbounded", durationMs: Number.isFinite(usage.durationMs) ? usage.durationMs : "unknown_unbounded", costUsd: Number.isFinite(usage.costUsd) ? usage.costUsd : "unknown_unbounded", pricingProvided: !!state.spec.limits.pricing },
  log: { bytes: (await stat(path)).size, facts: (await readFile(path, "utf8")).trim().split("\n").length },
  readElapsedMs: { samples: elapsed, min: Math.min(...elapsed), median: [...elapsed].sort((a, b) => a - b)[2], max: Math.max(...elapsed) },
}, null, 2));
