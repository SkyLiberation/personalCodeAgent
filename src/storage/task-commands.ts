import { mkdir, open, readFile, readdir, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WindowsHost } from "../platform/windows.js";
import type { TaskCommand, CommandResult } from "../task-contracts.js";
import { validateTaskDefinition } from "../task-contracts.js";
import { digest } from "./journal.js";
import { TaskRepository, taskPath } from "./task.js";
export interface CommandEnvelope { command: TaskCommand; taskId: string; contentHash: string; seq: number }
export const terminalTask = (status: string): boolean => ["succeeded", "cancelled", "failed"].includes(status);
export async function controlLock<T>(directory: string, host: WindowsHost, action: () => Promise<T>): Promise<T> {
  let lease; const deadline = Date.now() + 10_000;
  for (;;) { try { lease = await host.acquire(join(directory, "control.lease")); break; } catch (error) { if (!String(error).includes("busy") || Date.now() >= deadline) throw error; await new Promise(r => setTimeout(r, 20)); } }
  try { return await action(); } finally { await lease.close(); }
}
export async function pendingCommands(directory: string): Promise<CommandEnvelope[]> {
  const folder = join(directory, "commands");
  const files = await readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
  const values: CommandEnvelope[] = [];
  for (const file of files.filter(name => name.endsWith(".json"))) {
    const value = JSON.parse(await readFile(join(folder, file), "utf8")) as CommandEnvelope;
    if (value.contentHash !== digest(value.command) || !Number.isSafeInteger(value.seq) || value.seq < 1) throw new Error("command_corrupt");
    values.push(value);
  }
  return values.sort((a, b) => a.seq - b.seq);
}
export async function sendTaskCommand(options: { taskId: string; dataDirectory: string; command: TaskCommand }): Promise<CommandResult> {
  const { command } = options;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(command.id) || !["pause", "cancel", "update"].includes(command.type)) throw new Error("command ID/type 不合法");
  if (command.type === "update") { command.spec = validateTaskDefinition(command.spec); if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) throw new Error("expectedVersion 不合法"); }
  const host = await WindowsHost.create(); const directory = taskPath(options.dataDirectory, options.taskId);
  try { return await controlLock(directory, host, async () => {
    const state = await TaskRepository.read(options.dataDirectory, options.taskId); const contentHash = digest(command);
    const previous = (await pendingCommands(directory)).find(item => item.command.id === command.id);
    if (previous) { if (previous.contentHash !== contentHash) throw new Error("command_id_conflict"); return state.commands?.[command.id] ?? { id: command.id, contentHash, seq: previous.seq, status: terminalTask(state.status) ? "rejected" : "queued", ...(terminalTask(state.status) ? { reason: "terminal_task" } : {}) }; }
    const folder = join(directory, "commands"); await mkdir(folder, { recursive: true });
    const existing = await pendingCommands(directory); const seq = (existing.at(-1)?.seq ?? 0) + 1;
    const envelope: CommandEnvelope = { taskId: options.taskId, command, contentHash, seq };
    const temporary = join(folder, `${randomUUID()}.tmp`); const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, join(folder, `${command.id}.json`)); } finally { await unlink(temporary); }
    return { id: command.id, contentHash, seq, status: terminalTask(state.status) ? "rejected" : "queued", ...(terminalTask(state.status) ? { reason: "terminal_task" } : {}) };
  }); } finally { await host.close(); }
}
export async function readTaskCommandResult(options: { taskId: string; dataDirectory: string; commandId: string }): Promise<CommandResult | undefined> {
  const state = await TaskRepository.read(options.dataDirectory, options.taskId);
  if (state.commands?.[options.commandId]) return state.commands[options.commandId];
  const value = (await pendingCommands(taskPath(options.dataDirectory, options.taskId))).find(item => item.command.id === options.commandId);
  return value ? { id: value.command.id, contentHash: value.contentHash, seq: value.seq, status: terminalTask(state.status) ? "rejected" : "queued", ...(terminalTask(state.status) ? { reason: "terminal_task" } : {}) } : undefined;
}
