import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { ExecutionLease, ProcessResult } from "./host.js";
import { abortError, throwIfAborted } from "../security.js";
import { journalLines, seal, verifySeal } from "../storage/journal.js";

interface Identity { pid: number; starttime: string; bootId: string; pidNamespace: string }
export class LinuxHost {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private closed = false;
  private exited = false;
  private processJournal: string | undefined;
  private processChecksum = "";
  private processQueue: Promise<void> = Promise.resolve();
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", line => {
      try {
        const response = JSON.parse(line) as { id: string; result?: unknown; error?: string };
        const request = this.pending.get(response.id); this.pending.delete(response.id);
        if (response.error) request?.reject(new Error(response.error)); else request?.resolve(response.result);
      } catch { this.fail(new Error("Linux bridge protocol failure")); }
    });
    child.on("error", error => this.fail(error));
    child.on("close", () => { this.exited = true; this.fail(new Error("Linux bridge stopped")); });
    child.stderr.resume();
  }
  private fail(error: Error): void { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  static async create(options: { python?: string } = {}): Promise<LinuxHost> {
    if (process.platform !== "linux") throw new Error("Linux ownership/process backend unavailable");
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(env)) if (/^(MIMO_API_KEY|XIAOMI.*API_KEY)$/i.test(key)) delete env[key];
    const source = fileURLToPath(new URL("../../src/platform/linux-host.py", import.meta.url));
    const host = new LinuxHost(spawn(options.python ?? "python3", ["-u", source], { stdio: "pipe", env }));
    try {
      await new Promise<unknown>((resolve, reject) => host.pending.set("ready", { resolve, reject }));
      return host;
    } catch (error) { await host.close(); throw error; }
  }
  private request(action: string, payload: Record<string, unknown> = {}, id = randomUUID()): Promise<unknown> {
    if (this.closed || this.exited) return Promise.reject(new Error("Linux host closed"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ ...payload, action, id }) + "\n", error => {
        if (error) { this.pending.delete(id); reject(error); }
      });
    });
  }
  async acquire(path: string): Promise<ExecutionLease> {
    const id = randomUUID(); await this.request("acquire", { path }, id);
    let released = false;
    return { close: async () => { if (!released) { released = true; await this.request("release", { lease: id }); } } };
  }
  async restoreProcessGroups(path: string): Promise<void> {
    const lines = await journalLines(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    let previous = "";
    const identities: Identity[] = [];
    for (const line of lines) {
      const record = JSON.parse(line) as Identity & { schemaVersion: number; backend: string };
      if (record.schemaVersion !== 3 || record.backend !== "linux" || !Number.isSafeInteger(record.pid) || record.pid < 2 || !/^\d+$/.test(record.starttime) || !record.bootId || !record.pidNamespace) throw new Error("process_state_unknown：进程组来源缺失或日志不合法");
      previous = verifySeal(record as unknown as Record<string, unknown>, previous);
      identities.push({ pid: record.pid, starttime: record.starttime, bootId: record.bootId, pidNamespace: record.pidNamespace });
    }
    // Validate the whole journal before causing any recovery effect.
    for (const identity of identities) await this.request("validate_source", { ...identity });
    for (const identity of identities) await this.request("quiesce", { ...identity });
    if (lines.length) await journalLines(path, true);
    this.processJournal = path; this.processChecksum = previous;
  }
  private async prepareProcess(identity: Identity): Promise<void> {
    if (!this.processJournal) return;
    const path = this.processJournal;
    const action = this.processQueue.then(async () => {
      const record = seal({ schemaVersion: 3, backend: "linux", ...identity }, this.processChecksum);
      const file = await open(path, "a", 0o600);
      try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); this.processChecksum = record.checksum; }
      finally { await file.close(); }
    }); this.processQueue = action; void action.catch(() => undefined); await action;
  }
  async exec(executable: string, args: readonly string[], cwd: string, signal: AbortSignal, timeoutMs: number): Promise<ProcessResult> {
    throwIfAborted(signal);
    const operation = randomUUID();
    const identity = await this.request("prepare", { executable, args, cwd }, operation) as Identity;
    let timedOut = false;
    const stop = () => { void this.request("abort", { operation }).catch(() => undefined); };
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.prepareProcess(identity); throwIfAborted(signal);
      timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      signal.addEventListener("abort", stop, { once: true });
      const result = await this.request("start", { operation }, operation) as Omit<ProcessResult, "output" | "timedOut">;
      if (signal.aborted) throw abortError();
      return { ...result, output: result.stdout + result.stderr, timedOut };
    } catch (error) { await this.request("abort", { operation }).catch(() => undefined); throw error; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", stop); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.exited) return;
    const exit = new Promise<void>(resolve => this.child.once("close", () => resolve()));
    this.child.stdin.end(); await exit;
  }
}
