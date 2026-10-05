import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentSession } from "../harness/session.js";

/** Loopback UI for the same session contract, with a per-instance CSRF token. */
export async function serveSessionWeb(session: AgentSession, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const token = randomUUID(); const events: unknown[] = []; let sequence = 0;
  const unsubscribe = session.subscribe(event => { events.push({ sequence: ++sequence, event }); if (events.length > 128) events.shift(); });
  async function body(request: IncomingMessage) { let text = ""; for await (const data of request) { text += String(data); if (Buffer.byteLength(text) > 128_000) throw new Error("web_input_too_large"); } return JSON.parse(text) as { prompt: string; inputId?: string }; }
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}`) { response.writeHead(403).end(); return; }
        if (url.searchParams.get("token") !== token) { response.writeHead(403).end(); return; }
        response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
        if (request.method === "GET" && url.pathname === "/") {
          response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<!doctype html><meta charset="utf-8"><title>Code Agent</title><h1>Code Agent</h1><form><textarea id="prompt" required></textarea><button>发送任务</button></form><button id="abort">取消</button><pre id="events"></pre><script>
const token=${JSON.stringify(token)},api=(path,options)=>fetch(path+(path.includes('?')?'&':'?')+'token='+token,options),log=document.querySelector('#events');let cursor=0;
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await api('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:document.querySelector('#prompt').value,inputId:crypto.randomUUID()})});log.textContent+=await r.text()+'\\n'};
document.querySelector('#abort').onclick=()=>api('/abort',{method:'POST'});
setInterval(async()=>{const r=await api('/events?cursor='+cursor);const v=await r.json();for(const x of v.events){cursor=x.sequence;log.textContent+=JSON.stringify(x.event)+'\\n'}},1000);
</script>`); return;
        }
        let result: unknown;
        if (request.method === "GET" && url.pathname === "/status") result = { sessionId: session.id, busy: session.busy, cursor: session.repository.cursor };
        else if (request.method === "GET" && url.pathname === "/events") result = { events: events.filter(e => (e as { sequence: number }).sequence > Number(url.searchParams.get("cursor") ?? 0)), sequence };
        else if (request.method === "POST" && ["/submit", "/steer"].includes(url.pathname)) { const input = await body(request); result = await session.acceptInput(input.prompt, url.pathname === "/steer" ? "steer" : "follow_up", { inputId: input.inputId ?? randomUUID() }); }
        else if (request.method === "POST" && url.pathname === "/abort") result = { pending: session.abort() };
        else { response.writeHead(404).end(); return; }
        response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(result));
      } catch (error) { response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}/?token=${token}`, close: async () => { unsubscribe(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
