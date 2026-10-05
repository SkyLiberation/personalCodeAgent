import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { AgentSession } from "../harness/session.js";

/** Bounded presentation channel. Durable execution never waits for a slow event consumer. */
export function serveSessionRpc(session: AgentSession, input: Readable, output: Writable): { close(): Promise<void> } {
  const lines = createInterface({ input }); const pending: string[] = []; let blocked = false; let closed = false; let closing: Promise<void> | undefined; let operations = 0;
  function flush() { if (blocked || closed) return; while (pending.length) if (!output.write(pending.shift()!)) { blocked = true; break; } }
  output.on("drain", () => { blocked = false; flush(); });
  const snapshot = () => ({ sessionId: session.id, busy: session.busy, cursor: session.repository.cursor });
  function send(value: unknown, event = false) {
    if (closed) return;
    if (event && pending.length >= 128) {
      // Drop only transient events. Responses and durable state remain queryable.
      if (!pending.some(line => line.includes('"method":"resync"'))) pending.push(JSON.stringify({ jsonrpc: "2.0", method: "resync", params: snapshot() }) + "\n");
      return;
    }
    if (pending.length >= 256) { session.abort(); void close(); return; }
    pending.push(JSON.stringify(value) + "\n"); flush();
  }
  const unsubscribe = session.subscribe(event => send({ jsonrpc: "2.0", method: "event", params: event }, true));
  async function close() {
    if (closed) return; if (closing) return closing;
    closing = Promise.resolve().then(async () => { unsubscribe(); lines.close(); input.pause(); await session.close(); flush(); closed = true; }); return closing;
  }
  lines.on("line", line => {
    void (async () => {
      let id: string | number | null = null; let admitted = false;
      try {
        if (Buffer.byteLength(line) > 1_000_000 || operations >= 32) throw new Error("rpc_capacity_exceeded");
        const request = JSON.parse(line) as { jsonrpc: string; id: string | number; method: string; params?: { prompt?: string; inputId?: string } };
        if (request.jsonrpc !== "2.0" || !["string", "number"].includes(typeof request.id)) throw new Error("rpc_request_invalid"); id = request.id; operations++; admitted = true;
        let result: unknown;
        if (request.method === "status") result = snapshot();
        else if (request.method === "abort") result = { pending: session.abort() };
        else if (request.method === "submit" || request.method === "steer") {
          if (typeof request.params?.prompt !== "string") throw new Error("rpc_prompt_required");
          const receipt = await session.acceptInput(request.params.prompt, request.method === "steer" ? "steer" : "follow_up", { inputId: request.params.inputId ?? String(id) }); result = receipt;
          void session.waitInput(receipt.inputId).then(run => send({ jsonrpc: "2.0", method: "result", params: { inputId: receipt.inputId, run } }), error => send({ jsonrpc: "2.0", method: "result", params: { inputId: receipt.inputId, error: String(error) } }));
        } else if (request.method === "resume") { await session.resumeInputs(); result = snapshot(); }
        else if (request.method === "close") { send({ jsonrpc: "2.0", id, result: { closing: true } }); await close(); return; }
        else throw new Error("rpc_method_unknown");
        send({ jsonrpc: "2.0", id, result });
      } catch (error) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }); }
      finally { if (admitted) operations--; }
    })();
  });
  lines.on("close", () => { if (!closed) void close(); }); output.on("error", () => { void close(); });
  return { close };
}
