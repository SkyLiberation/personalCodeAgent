import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { loadConfig, type AgentConfig } from "./config.js";
import { createTaskController, openTaskController, defaultTaskDirectory } from "./harness/task-controller.js";
import { TaskRepository } from "./storage/task.js";
import { sendTaskCommand, readTaskCommandResult } from "./storage/task-commands.js";
import { validateTaskDefinition, type TaskDefinition, type TaskCommand } from "./task-contracts.js";
async function readSpec(file: string): Promise<TaskDefinition> {
  const path = resolve(file); const source: unknown = JSON.parse(await readFile(path, "utf8"));
  if (source && typeof source === "object" && "workspaceRoot" in source && typeof source.workspaceRoot === "string") source.workspaceRoot = resolve(dirname(path), source.workspaceRoot);
  return validateTaskDefinition(source);
}
export async function taskCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    spec: { type: "string" }, "data-dir": { type: "string" }, "max-turns": { type: "string" }, "command-id": { type: "string" }, "expected-version": { type: "string" },
    wait: { type: "boolean" }, "wait-timeout-ms": { type: "string" }, json: { type: "boolean" }, readonly: { type: "boolean" }, "no-shell": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log("task start --spec <JSON>\ntask status|resume <id>\ntask pause|cancel <id> --command-id <id> [--wait]\ntask update <id> --spec <JSON> --expected-version <n> --command-id <id> [--wait]\ntask command-status <id> <command-id>\nAll commands accept --data-dir <root>."); return; }
  const directory = resolve(values["data-dir"] ?? defaultTaskDirectory); const [action, id, commandId] = positionals;
  if (action === "status") { if (!id) throw new Error("需要任务 ID"); console.log(JSON.stringify(await TaskRepository.read(directory, id), null, 2)); return; }
  if (action === "command-status") { if (!id || !commandId) throw new Error("需要任务和命令 ID"); console.log(JSON.stringify(await readTaskCommandResult({ taskId: id, dataDirectory: directory, commandId }) ?? null)); return; }
  if (["pause", "cancel", "update"].includes(action ?? "")) {
    if (!id || !values["command-id"]) throw new Error("需要任务 ID 和 --command-id");
    let command: TaskCommand;
    if (action === "update") { if (!values.spec || !values["expected-version"]) throw new Error("update 需要 --spec 和 --expected-version"); command = { id: values["command-id"], type: "update", spec: await readSpec(values.spec), expectedVersion: Number(values["expected-version"]) }; }
    else command = { id: values["command-id"], type: action as "pause" | "cancel" };
    let result = await sendTaskCommand({ taskId: id, dataDirectory: directory, command });
    // No credentials or model request are needed by this short-lived control worker.
    if (result.status === "queued") {
      const state = await TaskRepository.read(directory, id);
      const config: AgentConfig = { ...state.execution, thinking: state.execution.thinking as AgentConfig["thinking"], apiKey: "" };
      try { const worker = await openTaskController({ taskId: id, dataDirectory: directory, config, controlOnly: true }); try { await worker.processCommands(); } finally { await worker.close(); } }
      catch (error) { if (!String(error).includes("busy")) throw error; }
    }
    const timeout = Number(values["wait-timeout-ms"] ?? 30_000); if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("wait timeout 不合法");
    const deadline = Date.now() + timeout;
    do { result = await readTaskCommandResult({ taskId: id, dataDirectory: directory, commandId: command.id }) ?? result;
      if (["applied", "rejected"].includes(result.status) || !values.wait || Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 100));
    } while (true);
    console.log(JSON.stringify(result)); if (result.status === "rejected" || values.wait && result.status !== "applied") process.exitCode = 1; return;
  }
  if (action !== "start" && action !== "resume") throw new Error("未知 task 命令，参见 task --help");
  const config = loadConfig();
  if (values["max-turns"]) { const n = Number(values["max-turns"]); if (!Number.isSafeInteger(n) || n < 1) throw new Error("--max-turns 必须为正整数"); config.maxTurns = n; }
  if (action === "start" && !values.spec || action === "resume" && !id) throw new Error("start 需要 --spec；resume 需要任务 ID");
  const common = { config, dataDirectory: directory, noShell: values["no-shell"] ?? false, readonly: values.readonly ?? false };
  const controller = action === "start" ? await createTaskController({ ...common, spec: await readSpec(values.spec!) }) : await openTaskController({ ...common, taskId: id! });
  const cancel = () => { void sendTaskCommand({ taskId: controller.id, dataDirectory: directory, command: { id: randomUUID(), type: "cancel" } }).catch(error => { console.error(`取消未持久化：${String(error)}`); process.exitCode = 1; void controller.close(); }); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  controller.subscribe(event => { if (values.json) process.stdout.write(JSON.stringify(event) + "\n"); else if (event.type !== "agent_event") process.stderr.write(`[${event.type}] ${event.taskId}\n`); });
  try { const result = await (action === "start" ? controller.start() : controller.resume()); if (!values.json) console.log(JSON.stringify({ taskId: result.id, status: result.status, reason: result.reason })); if (!["succeeded", "paused"].includes(result.status)) process.exitCode = result.status === "cancelled" ? 130 : 1; }
  finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); await controller.close(); }
}
