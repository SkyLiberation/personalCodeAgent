import { createExecutionHost } from "../../src/platform/host.js";
const host = await createExecutionHost();
try {
  const lease = await host.acquire(process.argv[2]!);
  if (process.argv[3]) await host.restoreProcessGroups(process.argv[3]);
  process.send?.({ type: "owned" });
  process.on("message", async (message: { type: string; file?: string }) => {
    if (message.type === "run") {
      const result = host.exec(process.execPath, ["-e", `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(message.file)},JSON.stringify({parent:process.pid,child:c.pid}));setInterval(()=>{},1000)`], process.cwd(), new AbortController().signal, 30_000);
      void result.catch(error => process.send?.({ type: "run_error", error: String(error) }));
    }
    if (message.type === "close") { await lease.close(); await host.close(); process.exit(0); }
  });
} catch (error) { process.send?.({ type: "error", error: String(error) }); await host.close(); process.exit(1); }
