import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, access, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { abortError, throwIfAborted } from "../security.js";
import { journalLines, seal, verifySeal } from "../storage/journal.js";

export interface ExecutionLease { close(): Promise<void> }
export interface ProcessResult { stdout: string; stderr: string; output: string; exitCode: number; timedOut: boolean }

export class WindowsHost {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private exited = false;
  private processJournal: string | undefined;
  private processChecksum = "";
  private processQueue: Promise<void> = Promise.resolve();
  private readonly ownerId = randomUUID();
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", line => {
      try { const response = JSON.parse(line) as { id: string; result?: unknown; error?: string }; const request = this.pending.get(response.id); this.pending.delete(response.id); if (response.error) request?.reject(new Error(response.error)); else request?.resolve(response.result); }
      catch { this.fail(new Error("Windows bridge protocol failure")); }
    });
    child.on("error", error => this.fail(error));
    child.on("close", () => { this.exited = true; this.fail(new Error("Windows bridge stopped")); });
    child.stderr.resume();
  }
  private fail(error: Error): void { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  static async create(options: { compiler?: string; cacheDirectory?: string } = {}): Promise<WindowsHost> {
    if (process.platform !== "win32") throw new Error("Windows ownership/process backend unavailable");
    const source = fileURLToPath(new URL("../../src/platform/windows-host.cs", import.meta.url));
    const digest = createHash("sha256").update(await readFile(source)).digest("hex");
    const cache = join(options.cacheDirectory ?? join(tmpdir(), "personal-code-agent-platform"), digest);
    await mkdir(cache, { recursive: true });
    const executable = join(cache, "host.exe");
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(env)) if (/^(MIMO_API_KEY|XIAOMI.*API_KEY)$/i.test(key)) delete env[key];
    if (!await access(executable).then(() => true, () => false)) {
      const candidate = join(cache, `host-${randomUUID()}.exe`);
      await promisify(execFile)(options.compiler ?? join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", "/reference:System.Web.Extensions.dll", `/out:${candidate}`, source], { windowsHide: true, env });
      await rename(candidate, executable).catch(async error => { if (!await access(executable).then(() => true, () => false)) throw error; });
    }
    return new WindowsHost(spawn(executable, [], { windowsHide: true, stdio: "pipe", env }));
  }
  private request(action: string, payload: Record<string, unknown> = {}, id = randomUUID()): Promise<unknown> {
    if (this.closed || this.exited) return Promise.reject(new Error("Windows host closed"));
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child.stdin.write(JSON.stringify({ ...payload, action, id }) + "\n", error => { if (error) { this.pending.delete(id); reject(error); } }); });
  }
  async acquire(path: string): Promise<ExecutionLease> {
    const id = randomUUID(); await this.request("acquire", { path }, id);
    let released = false;
    return { close: async () => { if (!released) { released = true; await this.request("release", { lease: id }); } } };
  }
  async restoreProcessGroups(path: string): Promise<void> {
    let lines: string[];
    try { lines = await journalLines(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; lines = []; }
    let previous = "";
    for (const line of lines.filter(line => line.trim())) {
      const record = JSON.parse(line) as { schemaVersion: number; jobName: string };
      if (record.schemaVersion !== 1 || !/^Local\\codeagent-[a-f0-9-]+$/.test(record.jobName)) throw new Error("process_state_unknown：进程组日志不合法");
      previous = verifySeal(record as unknown as Record<string, unknown>, previous);
      await this.request("quiesce", { jobName: record.jobName });
    }
    if (lines.length) await journalLines(path, true);
    this.processJournal = path; this.processChecksum = previous;
  }
  private async prepareProcess(jobName: string): Promise<void> {
    if (!this.processJournal) return;
    const path = this.processJournal;
    const action = this.processQueue.then(async () => {
      const record = seal({ schemaVersion: 1, jobName, ownerId: this.ownerId }, this.processChecksum);
      const file = await open(path, "a", 0o600); try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); this.processChecksum = record.checksum; } finally { await file.close(); }
    }); this.processQueue = action; void action.catch(() => undefined); await action;
  }
  async exec(executable: string, args: readonly string[], cwd: string, signal: AbortSignal, timeoutMs: number): Promise<ProcessResult> {
    throwIfAborted(signal);
    if (!isAbsolute(executable)) {
      const candidates = (process.env.PATH ?? "").split(";").filter(Boolean).map(directory => join(directory, executable));
      let resolved: string | undefined;
      for (const candidate of candidates) { if (await access(candidate).then(() => true, () => false)) { resolved = candidate; break; } }
      if (!resolved) throw new Error(`executable_not_found：${executable}`);
      executable = resolved;
    }
    const id = randomUUID(); const jobName = `Local\\codeagent-${id}`; await this.prepareProcess(jobName); throwIfAborted(signal); let timedOut = false;
    const stop = () => { void this.request("abort", { operation: id }).catch(() => undefined); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const result = await this.request("run", { executable, args, cwd, jobName }, id) as Omit<ProcessResult, "output" | "timedOut">;
      if (signal.aborted) throw abortError();
      return { ...result, output: result.stdout + result.stderr, timedOut };
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.exited) return;
    const exit = new Promise<void>(resolve => this.child.once("close", () => resolve()));
    this.child.stdin.end(); await exit;
  }
}
