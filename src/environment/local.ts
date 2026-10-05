import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { abortError, throwIfAborted } from "../security.js";
import { assertLinuxPlatform, type ExecutionHost } from "../platform/host.js";

const mutationQueues = new Map<string, Promise<void>>();

async function serialize<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((done) => { release = done; });
  const queued = previous.then(() => next);
  mutationQueues.set(path, queued);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (mutationQueues.get(path) === queued) mutationQueues.delete(path);
  }
}

export function isPrivatePath(path: string): boolean {
  return path.split(/[\\/]/).some((part) =>
    part.toLowerCase() === ".codeagent" ||
    (part.toLowerCase().startsWith(".env") && part.toLowerCase() !== ".env.example"));
}

export class LocalEnvironment {
  readonly shell = "bash" as const;

  private constructor(readonly cwd: string, private readonly timeoutMs: number, private readonly host?: ExecutionHost, private writablePaths?: readonly string[]) {}

  static async create(cwd: string, timeoutMs = 60_000, host?: ExecutionHost, writablePaths?: readonly string[]): Promise<LocalEnvironment> {
    assertLinuxPlatform();
    const root = await realpath(resolve(cwd));
    if (!(await stat(root)).isDirectory()) throw new Error("工作区必须是目录");
    return new LocalEnvironment(root, timeoutMs, host, writablePaths);
  }

  private inside(path: string): void {
    const rel = relative(this.cwd, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("文件工具只能访问当前工作区内的路径");
    }
    if (isPrivatePath(rel)) throw new Error("文件工具禁止访问本地密钥或 Agent 私有数据");
  }

  async path(input: string): Promise<string> {
    const target = resolve(this.cwd, input);
    this.inside(target);
    // Resolve the nearest existing ancestor, including directory symlinks.
    let ancestor = target;
    const suffix: string[] = [];
    for (;;) {
      try {
        const canonical = await realpath(ancestor);
        this.inside(canonical);
        const resolved = join(canonical, ...suffix.reverse());
        this.inside(resolved);
        return resolved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        suffix.push(basename(ancestor));
        ancestor = parent;
      }
    }
  }

  async read(input: string, offset: number, limit: number, signal: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const path = await this.path(input);
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = (await readdir(path, { withFileTypes: true }))
        .filter((entry) => !isPrivatePath(entry.name) && ![".git", "node_modules"].includes(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      return entries.slice(offset - 1, offset - 1 + limit)
        .map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).join("\n") || "[空目录]";
    }
    if (info.size > 2_000_000) throw new Error("文件超过 2 MB，首版文件工具不支持读取该文件");
    const content = await readFile(path, { encoding: "utf8", signal });
    if (content.includes("\0")) throw new Error("首版仅支持读取文本文件");
    const lines = content.split(/\r?\n/);
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const result = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");
    return `${result}\n[共 ${lines.length} 行，显示 ${selected.length} 行]`;
  }

  private async atomicWrite(path: string, content: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.agent-${randomUUID()}.tmp`);
    try {
      const mode = await stat(path).then((info) => info.mode).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return 0o666;
      });
      const file = await open(temporary, "wx", mode);
      try { await file.writeFile(content, { encoding: "utf8", signal }); await file.sync(); } finally { await file.close(); }
      throwIfAborted(signal);
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

  async write(input: string, content: string, signal: AbortSignal): Promise<void> {
    const path = await this.path(input);
    await this.checkWritable(path);
    await serialize(path, () => this.atomicWrite(path, content, signal));
  }

  async edit(input: string, oldText: string, newText: string, signal: AbortSignal): Promise<void> {
    const path = await this.path(input);
    await this.checkWritable(path);
    await serialize(path, async () => {
      const info = await stat(path);
      if (info.size > 2_000_000) throw new Error("文件超过 2 MB，首版不支持修改该文件");
      const original = await readFile(path, { encoding: "utf8", signal });
      const first = original.indexOf(oldText);
      if (first < 0) throw new Error("oldText 未找到，请重新读取文件并使用精确文本");
      if (original.indexOf(oldText, first + 1) >= 0) throw new Error("oldText 匹配多处，请提供更完整的唯一上下文");
      await this.atomicWrite(path, original.slice(0, first) + newText + original.slice(first + oldText.length), signal);
    });
  }

  private async checkWritable(path: string): Promise<void> {
    if (!this.writablePaths) return;
    for (const input of this.writablePaths) {
      const root = await this.path(input); const rel = relative(root, path);
      if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) return;
    }
    throw new Error("task_scope_denied：文件不在合同的 writablePaths 内");
  }

  setWritablePaths(paths: readonly string[]): void { this.writablePaths = paths; }

  async run(command: string, shell: "bash", signal: AbortSignal): Promise<{
    output: string; exitCode: number; timedOut: boolean;
  }> {
    throwIfAborted(signal);
    if (shell !== "bash") throw new Error("unsupported_shell: Bash required");
    return this.exec("bash", ["--noprofile", "--norc", "-c", command], signal);
  }

  async exec(executable: string, args: readonly string[], signal: AbortSignal): Promise<{
    output: string; stdout: string; stderr: string; exitCode: number; timedOut: boolean;
  }> {
    throwIfAborted(signal);
    if (this.host) return this.host.exec(executable, args, this.cwd, signal, this.timeoutMs);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(env)) {
      if (/^(MIMO_API_KEY|XIAOMI.*API_KEY)$/i.test(key)) delete env[key];
    }
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn(executable, args, {
        cwd: this.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;
      let killing = false;
      const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
      const collect = (text: string) => {
        const room = 1_000_000 - output.length;
        if (text.length > room) truncated = true;
        if (room > 0) output += text.slice(0, room);
      };
      child.stdout.on("data", (data: Buffer) => {
        const text = decoders[0]!.write(data); stdout += text.slice(0, Math.max(0, 1_000_000 - stdout.length)); collect(text);
      });
      child.stderr.on("data", (data: Buffer) => {
        const text = decoders[1]!.write(data); stderr += text.slice(0, Math.max(0, 1_000_000 - stderr.length)); collect(text);
      });
      const kill = () => {
        if (killing || !child.pid) return;
        killing = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, this.timeoutMs);
      timer.unref();
      signal.addEventListener("abort", kill, { once: true });
      if (signal.aborted) kill();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
      };
      child.on("error", (error) => { cleanup(); rejectRun(error); });
      child.on("close", (code) => {
        cleanup();
        const lastOut = decoders[0]!.end(), lastError = decoders[1]!.end();
        stdout += lastOut; stderr += lastError; collect(lastOut); collect(lastError);
        if (signal.aborted) { rejectRun(abortError()); return; }
        resolveRun({
          output: output + (truncated ? "\n[进程输出超过 1,000,000 字符，后续输出已丢弃]" : ""),
          stdout, stderr,
          exitCode: code ?? -1, timedOut,
        });
      });
    });
  }
}
