import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import * as Value from "typebox/value";
import type { TSchema } from "typebox";
import type { AgentTool } from "../contracts.js";
import { assertLinuxPlatform } from "../platform/host.js";
import { throwIfAborted } from "../security.js";

export class McpClient {
  private serial = 0; private closed = false;
  private protocolVersion = "2025-11-25";
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly timeoutMs: number) {
    createInterface({ input: child.stdout }).on("line", line => {
      try { const message = JSON.parse(line) as { jsonrpc?: string; id?: number; result?: unknown; error?: { message: string } };
        if (message.jsonrpc !== "2.0") throw new Error("mcp_protocol_invalid");
        if (message.id === undefined) return; const operation = this.pending.get(message.id);
        if (!Object.hasOwn(message, "result") && !message.error) throw new Error("mcp_protocol_invalid");
        if (message.error) operation?.reject(new Error(`mcp_error: ${message.error.message}`)); else operation?.resolve(message.result);
      } catch { this.fail(new Error("mcp_protocol_invalid")); } });
    child.stderr.resume(); child.stdin.on("error", error => this.fail(error)); child.on("error", error => this.fail(error)); child.on("close", () => this.fail(new Error("mcp_disconnected")));
  }
  private fail(error: Error) { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  static async connect(options: { command: string; args?: string[]; cwd: string; timeoutMs?: number }): Promise<McpClient> {
    assertLinuxPlatform();
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) throw new Error("mcp_timeout_invalid");
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete env[key];
    const client = new McpClient(spawn(options.command, options.args ?? [], { cwd: options.cwd, env, stdio: "pipe", detached: true }), options.timeoutMs ?? 30_000);
    try { const result = await client.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "personal-code-agent", version: "0.1.0" } }) as { protocolVersion?: string };
      if (!result?.protocolVersion || !["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(result.protocolVersion)) throw new Error("mcp_initialize_invalid"); client.protocolVersion = result.protocolVersion; client.notify("notifications/initialized", {}); return client;
    } catch (error) { await client.close(); throw error; }
  }
  private notify(method: string, params: unknown) { this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n", error => { if (error) this.fail(error); }); }
  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("mcp_closed"); if (signal) throwIfAborted(signal);
    const id = ++this.serial; let timer: NodeJS.Timeout | undefined;
    const abort = () => { this.notify("notifications/cancelled", { requestId: id, reason: "host cancellation" }); this.pending.get(id)?.reject(new Error("mcp_cancelled")); };
    try { return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); timer = setTimeout(() => { this.notify("notifications/cancelled", { requestId: id }); reject(new Error("mcp_timeout")); }, this.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => { if (error) reject(error); });
    }); } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); }
  }
  async tools(prefix: string, policies: Record<string, { effect: AgentTool["effect"]; replay: AgentTool["replay"] }> = {}): Promise<AgentTool[]> {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(prefix)) throw new Error("mcp_prefix_invalid");
    const definitions: { name: string; description?: string; inputSchema: Record<string, unknown> }[] = []; let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const response = await this.request("tools/list", cursor ? { cursor } : {}) as { tools: typeof definitions; nextCursor?: string };
      if (!Array.isArray(response.tools)) throw new Error("mcp_tools_invalid"); definitions.push(...response.tools); cursor = response.nextCursor; if (!cursor) break;
      if (page === 99) throw new Error("mcp_pagination_exceeded");
    }
    return definitions.map(definition => ({ name: `${prefix}-${definition.name}`, version: `mcp-${this.protocolVersion}`, description: definition.description ?? definition.name,
      parameters: definition.inputSchema, effect: policies[definition.name]?.effect ?? "process", replay: policies[definition.name]?.replay ?? "never",
      validate(value) { if (!Value.Check(definition.inputSchema as TSchema, value)) throw new Error("mcp_arguments_invalid"); return value; },
      execute: async (args, context) => { const result = await this.request("tools/call", { name: definition.name, arguments: args }, context.signal) as { content?: { type: string; text?: string }[]; isError?: boolean };
        if (!Array.isArray(result.content)) throw new Error("mcp_result_invalid"); return { text: result.content.map(c => c.text ?? JSON.stringify(c)).join("\n"), isError: result.isError === true }; },
    }));
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.fail(new Error("mcp_closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exit = new Promise<void>(resolve => this.child.once("close", () => resolve()));
    try { process.kill(-this.child.pid!, "SIGKILL"); } catch { this.child.kill("SIGKILL"); }
    await exit;
  }
}
