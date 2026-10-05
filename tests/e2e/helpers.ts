import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { loadConfig } from "../../src/config.js";
import type { AgentEvent, RunStatus } from "../../src/contracts.js";
import { SecretRedactor, errorText } from "../../src/security.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const config = loadConfig();
const redactor = new SecretRedactor([config.apiKey]);
const artifactDirectory = join(projectRoot, ".codeagent", "e2e");
await mkdir(artifactDirectory, { recursive: true });
export const suiteDirectory = await mkdtemp(join(artifactDirectory, "run-"));

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliResult extends ProcessResult {
  events: AgentEvent[];
  text: string;
  status?: RunStatus;
}

interface RunRecord {
  sessionId: string;
  exitCode?: number;
  status?: RunStatus;
  turns?: number;
  error?: string;
}

interface ScenarioReport {
  name: string;
  status: "running" | "passed" | "failed";
  runs: RunRecord[];
  durationMs?: number;
  error?: string;
}

const reports: ScenarioReport[] = [];

// This spawns the built CLI, not an injected Gateway or an in-process AgentSession.
export async function runProcess(args: string[], options: {
  cwd: string;
  signal: AbortSignal;
  stdin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
  options.signal.throwIfAborted();
  const env = { ...(options.env ?? process.env) };
  // Nested `node --test` must start a runner, not inherit the parent's worker role.
  // NODE_TEST_CONTEXT=child-v8 otherwise makes it return zero without running tests.
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd, env,
      detached: true, stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let terminated: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    const terminate = (error: Error) => {
      if (terminated) return;
      terminated = error;
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { child.kill("SIGKILL"); }
    };
    const abort = () => terminate(new Error("E2E process aborted"));
    const timer = setTimeout(() => terminate(new Error("E2E process timed out")), options.timeoutMs ?? 180_000);
    timer.unref();
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
    };
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") terminate(error);
    });
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      cleanup();
      const result = { exitCode: code ?? -1, stdout: redactor.text(stdout), stderr: redactor.text(stderr) };
      if (terminated) reject(Object.assign(terminated, result));
      else resolve(result);
    });
    child.stdin.end(options.stdin ?? "");
  });
}

export async function scenario(context: TestContext, name: string, run: (fixture: {
  root: string;
  cwd: string;
  sessionDirectory: string;
  cli(options: { prompt?: string; stdin?: string; sessionId?: string; flags?: string[] }): Promise<CliResult>;
}) => Promise<void>): Promise<void> {
  const root = join(suiteDirectory, name);
  const cwd = join(root, "workspace");
  const sessionDirectory = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  const report: ScenarioReport = { name, status: "running", runs: [] };
  reports.push(report);
  const startedAt = Date.now();
  context.diagnostic(`Artifacts: ${root}`);
  const saveReport = async () => {
    report.durationMs = Date.now() - startedAt;
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2) + "\n");
  };
  context.after(async () => {
    // node:test can end a timed-out test before its async body reaches finally.
    // The suite report must not retain a misleading "running" result.
    if (report.status === "running") {
      report.status = "failed";
      report.error = context.signal.aborted ? "E2E scenario aborted before completion" : "E2E scenario did not settle";
      await saveReport();
    }
  });
  try {
    await run({
      root, cwd, sessionDirectory,
      cli: async (options) => {
        const sessionId = options.sessionId ?? randomUUID();
        const args = [join(projectRoot, "dist", "cli.js"), "--json", "--cwd", cwd,
          "--data-dir", sessionDirectory, "--session", sessionId, "--max-turns", "8", ...(options.flags ?? [])];
        if (options.prompt !== undefined) args.push("--prompt", options.prompt);
        const index = report.runs.length + 1;
        const record: RunRecord = { sessionId };
        report.runs.push(record);
        await writeFile(join(root, `cli-${index}.input.json`), JSON.stringify({
          args: args.slice(1), ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
        }, null, 2) + "\n");
        try {
          const result = await runProcess(args, {
            cwd: projectRoot, signal: context.signal, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
            env: { ...process.env, MIMO_API_KEY: config.apiKey, MIMO_MODEL_ID: config.modelId,
              MIMO_BASE_URL: config.baseUrl, MIMO_THINKING: config.thinking },
          });
          await writeFile(join(root, `cli-${index}.events.jsonl`), result.stdout);
          await writeFile(join(root, `cli-${index}.stderr.log`), result.stderr);
          record.exitCode = result.exitCode;
          // Invalid JSONL fails the case: machine-readable stdout is a public CLI contract.
          const events = result.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as AgentEvent);
          const settled = events.findLast((event) => event.type === "run_settled");
          const turn = events.findLast((event) => event.type === "turn_completed");
          if (settled?.type === "run_settled") record.status = settled.status;
          if (turn?.type === "turn_completed") record.turns = turn.turn;
          await saveReport();
          return { ...result, events,
            text: events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""),
            ...(record.status ? { status: record.status } : {}),
          };
        } catch (error) {
          record.error = redactor.text(errorText(error));
          if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
            await writeFile(join(root, `cli-${index}.events.jsonl`), redactor.text(String(error.stdout)));
            await writeFile(join(root, `cli-${index}.stderr.log`), redactor.text(String(error.stderr)));
          }
          throw error;
        }
      },
    });
    context.signal.throwIfAborted();
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = redactor.text(errorText(error));
    throw new Error(report.error, { cause: error });
  } finally {
    await saveReport();
  }
}

export async function saveSuiteReport(): Promise<void> {
  await writeFile(join(suiteDirectory, "report.json"), JSON.stringify({
    modelId: config.modelId, baseUrl: config.baseUrl, scenarios: reports,
  }, null, 2) + "\n");
  console.log(`E2E report: ${join(suiteDirectory, "report.json")}`);
}
