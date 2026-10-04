import { mkdir, open, readFile, rename, access } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { TaskState } from "../task-contracts.js";
import type { WindowsHost } from "../platform/windows.js";
import { journalLines, seal } from "./journal.js";
const fileHash = (content: string) => createHash("sha256").update(content).digest("hex");

interface Manifest { schemaVersion: 1; taskId: string; generation: string; taskLog: string; sessionLog: string; sources: { path: string; hash: string }[]; entryMap: Record<string, string> }
export async function migrationPaths(directory: string, taskId: string): Promise<{ taskLog: string; sessionLog?: string }> {
  let manifest: Manifest;
  try { manifest = JSON.parse(await readFile(join(directory, "migration.json"), "utf8")) as Manifest; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { taskLog: join(directory, "events.jsonl") }; throw error; }
  if (manifest.schemaVersion !== 1 || manifest.taskId !== taskId || !/^[a-f0-9-]{36}$/.test(manifest.generation)) throw new Error("migration_manifest_invalid");
  for (const source of manifest.sources) if (fileHash(await readFile(source.path, "utf8")) !== source.hash) throw new Error("migration_source_changed");
  const within = (path: string) => { const rel = relative(directory, path); if (isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../")) throw new Error("migration_path_invalid"); return path; };
  return { taskLog: within(join(directory, manifest.taskLog)), sessionLog: within(join(directory, manifest.sessionLog)) };
}
async function synced(path: string, text: string): Promise<void> { const file = await open(path, "wx", 0o600); try { await file.writeFile(text); await file.sync(); } finally { await file.close(); } }

/** Only the provably unstarted, closed v1 task has enough facts for automatic
 * migration. Active and terminal history remain read-only; no IDs are guessed. */
export async function migrateUnstartedTask(root: string, state: TaskState, host: WindowsHost, registry: string, toolVersions: Record<string, string>, barrier?: (name: string) => Promise<void>): Promise<void> {
  const directory = join(root, "tasks", state.id); const originalTask = join(directory, "events.jsonl"); const originalSession = join(root, "sessions", `${state.sessionId}.jsonl`);
  const taskLease = await host.acquire(join(directory, "execution.lease"));
  let sessionLease;
  try {
    sessionLease = await host.acquire(`${originalSession}.lease`);
    for (const path of [join(directory, "owner.lock"), `${originalSession}.lock`]) if (await access(path).then(() => true, () => false)) throw new Error("migration_handoff_ambiguous：旧所有者锁身份未知");
    const taskSource = await readFile(originalTask, "utf8"); const sessionSource = await readFile(originalSession, "utf8");
    const taskLines = await journalLines(originalTask); const sessionLines = await journalLines(originalSession);
    if (state.schemaVersion !== 1 || state.status !== "pending" || state.runs !== 0 || state.repairs !== 0 || taskLines.length !== 1 || sessionLines.length !== 1 || !taskSource.endsWith("\n") || !sessionSource.endsWith("\n")) throw new Error("migration_handoff_ambiguous：仅无执行事实的完整空任务可安全迁移");
    const old = JSON.parse(taskLines[0]!); const header = JSON.parse(sessionLines[0]!);
    if (old.type !== "task_created" || old.state.id !== state.id || header.type !== "session" || header.schemaVersion !== 1 || header.sessionId !== state.sessionId || header.cwd !== state.spec.workspaceRoot) throw new Error("migration_source_invalid");
    const generation = randomUUID(); const folder = join(directory, "generations", generation); await mkdir(folder, { recursive: true });
    const upgraded: TaskState = { ...state, schemaVersion: 2, leaseRegistry: registry, toolVersions, commands: {}, scopeSource: state.spec.scope ? "explicit" : "legacy_workspace" };
    const first = seal({ ...old, state: upgraded }, "");
    // Both complete logs are synced before the single manifest publication. Any
    // pre-publication crash leaves an ignored generation; v1 sources are untouched.
    await synced(join(folder, "task.jsonl"), JSON.stringify(first) + "\n");
    await synced(join(folder, "session.jsonl"), JSON.stringify({ ...header, schemaVersion: 2 }) + "\n");
    await barrier?.("migration_logs_synced");
    const manifest: Manifest = { schemaVersion: 1, taskId: state.id, generation, taskLog: join("generations", generation, "task.jsonl"), sessionLog: join("generations", generation, "session.jsonl"), sources: [{ path: originalTask, hash: fileHash(taskSource) }, { path: originalSession, hash: fileHash(sessionSource) }], entryMap: { [old.eventId]: first.eventId } };
    const temporary = join(directory, `migration-${generation}.tmp`); await synced(temporary, JSON.stringify(manifest) + "\n"); await rename(temporary, join(directory, "migration.json"));
    await barrier?.("migration_manifest_published");
  } finally { await sessionLease?.close(); await taskLease.close(); }
}
