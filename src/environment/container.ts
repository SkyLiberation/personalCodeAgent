import { randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import type { ExecutionHost, ExecutionLease, ProcessResult } from "../platform/host.js";
import { createExecutionHost } from "../platform/host.js";
import { journalLines, seal, verifySeal } from "../storage/journal.js";
import { throwIfAborted } from "../security.js";

/** Explicit local Docker backend. No host networking/socket mount or host-shell fallback. */
export class ContainerExecutionHost implements ExecutionHost {
  private journal: string | undefined; private checksum = ""; private pending = Promise.resolve();
  private constructor(private readonly base: ExecutionHost, readonly image: string, private readonly workspace: string) {}
  static async create(options: { image: string; workspace: string; host?: ExecutionHost }): Promise<ContainerExecutionHost> {
    if (process.platform !== "linux") throw new Error("container_backend_unavailable: this adapter requires the local Linux Docker socket");
    if (!options.image || options.image.startsWith("-")) throw new Error("container_image_invalid");
    const base = options.host ?? await createExecutionHost(); const cwd = await realpath(options.workspace);
    const instance = new ContainerExecutionHost(base, options.image, cwd);
    try { const info = await instance.docker(["info", "--format", "{{.ServerVersion}}"]); if (info.exitCode !== 0) throw new Error("container_backend_unavailable"); return instance; }
    catch (error) { await base.close(); throw error; }
  }
  private docker(args: string[], signal = new AbortController().signal, timeoutMs = 30_000) {
    return this.base.exec("env", ["-u", "DOCKER_HOST", "-u", "DOCKER_CONTEXT", "-u", "DOCKER_TLS", "-u", "DOCKER_TLS_VERIFY", "-u", "DOCKER_CERT_PATH", "docker", "--host=unix:///var/run/docker.sock", ...args], this.workspace, signal, timeoutMs);
  }
  acquire(path: string): Promise<ExecutionLease> { return this.base.acquire(path); }
  private async remove(name: string): Promise<void> {
    const inspected = await this.docker(["inspect", "--format", '{{index .Config.Labels "codeagent.operation"}}', name]);
    if (inspected.exitCode !== 0) {
      if (/No such (object|container)/i.test(inspected.stderr)) return;
      throw new Error("container_state_unknown: inspect unavailable");
    }
    if (inspected.stdout.trim() !== name) throw new Error("container_state_unknown: identity mismatch");
    const removed = await this.docker(["rm", "--force", name]); if (removed.exitCode !== 0) throw new Error("container_cleanup_failed");
  }
  async restoreProcessGroups(path: string): Promise<void> {
    await this.base.restoreProcessGroups(path);
    this.journal = path + ".containers";
    const lines = await journalLines(this.journal).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return []; throw e; });
    const names: string[] = []; let checksum = "";
    for (const line of lines) { const record = JSON.parse(line) as { backend: string; name: string; workspace: string; image: string };
      checksum = verifySeal(record as unknown as Record<string, unknown>, checksum);
      if (record.backend !== "docker-v1" || record.workspace !== this.workspace || record.image !== this.image || !/^codeagent-[a-f0-9-]+$/.test(record.name)) throw new Error("container_state_unknown: journal incompatible"); names.push(record.name); }
    for (const name of names) await this.remove(name); this.checksum = checksum;
  }
  async exec(executable: string, args: readonly string[], cwd: string, signal: AbortSignal, timeoutMs: number): Promise<ProcessResult> {
    throwIfAborted(signal); if (await realpath(cwd) !== this.workspace) throw new Error("container_workspace_mismatch");
    if (!this.journal) throw new Error("container_journal_required");
    const name = `codeagent-${randomUUID()}`;
    const action = this.pending.then(async () => { const record = seal({ backend: "docker-v1", name, workspace: this.workspace, image: this.image }, this.checksum);
      const file = await open(this.journal!, "a", 0o600); try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); this.checksum = record.checksum; } finally { await file.close(); } });
    this.pending = action; void action.catch(() => undefined); await action;
    try {
      const created = await this.docker(["create", "--name", name, "--label", `codeagent.operation=${name}`, "--user", `${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "256m", "--cpus", "2", "--workdir", "/workspace", "--mount", `type=bind,src=${this.workspace},dst=/workspace`, this.image, executable, ...args], signal);
      if (created.exitCode !== 0) throw new Error(`container_create_failed: ${created.stderr}`);
      const result = await this.docker(["start", "--attach", name], signal, timeoutMs);
      if (!result.timedOut && result.exitCode === 0) {
        const inspected = await this.docker(["inspect", "--format", "{{.State.ExitCode}}", name]);
        if (inspected.exitCode !== 0 || !/^\d+$/.test(inspected.stdout.trim())) throw new Error("container_exit_status_unknown");
        result.exitCode = Number(inspected.stdout.trim());
      }
      return result;
    } finally { await this.remove(name); }
  }
  async close(): Promise<void> { await this.pending.catch(() => undefined); if (this.journal) await this.restoreProcessGroups(this.journal.slice(0, -".containers".length)); await this.base.close(); }
}
