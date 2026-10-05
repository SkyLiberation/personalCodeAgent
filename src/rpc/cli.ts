import { createAgentSession } from "../harness/session.js";
import { serveSessionRpc } from "./server.js";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { cwd: { type: "string" }, session: { type: "string" }, "data-dir": { type: "string" } } });
const session = await createAgentSession({ durableInbox: true, ...(values.cwd ? { cwd: values.cwd } : {}), ...(values.session ? { sessionId: values.session } : {}), ...(values["data-dir"] ? { dataDirectory: values["data-dir"] } : {}) });
serveSessionRpc(session, process.stdin, process.stdout);
process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready", params: { sessionId: session.id } }) + "\n");
