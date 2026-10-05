import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { createTaskController, openTaskController, PiModelGateway, loadConfig, type TaskServices, type TaskController } from "../../src/index.js";
import type { ModelGateway } from "../../src/contracts.js";
const [mode, root, argument, barrier = ""] = process.argv.slice(2) as [string,string,string,string];
const config = loadConfig();
async function durable(path: string, content: string, flag: "a" | "wx") {
  const file = await open(path, flag, 0o600); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}
const auditModel = await readFile(join(root, "audit-model-enabled"), "utf8").then(() => true, () => false);
const pi = auditModel ? new PiModelGateway(config) : undefined;
const gateway: ModelGateway | undefined = pi ? { async *stream(request, signal) {
  await durable(join(root, "model-requests.jsonl"), JSON.stringify({ pid: process.pid, timestamp: Date.now(), purpose: request.purpose ?? "execution" }) + "\n", "a");
  yield* pi.stream(request, signal);
} } : undefined;
const services: TaskServices = {
  tools: [{ name: "record-delivery", description: "Record the required unique delivery audit marker. Call once when requested.", parameters: { type: "object", properties: {}, additionalProperties: false }, effect: "write", replay: "never", version: "1", validate: value => value, execute: async (_args, context) => {
    const receipt = { operationId: context.operationId, callId: context.callId, text: "交付登记已保存", isError: false };
    await durable(join(root, "audit.jsonl"), JSON.stringify(receipt) + "\n", "a");
    await durable(join(root, `receipt-${context.operationId}.json`), JSON.stringify(receipt), "wx");
    return { text: receipt.text, isError: false };
  } }],
  recovery: { "record-delivery": async intent => {
    if (await readFile(join(root, "unknown"), "utf8").then(() => true, () => false)) return { kind: "unknown" };
    const receipt = JSON.parse(await readFile(join(root, `receipt-${intent.operationId}.json`), "utf8"));
    return { kind: "receipt", operationId: receipt.operationId, callId: receipt.callId, result: { text: receipt.text, isError: false }, receipt };
  } },
};
const receiptEnabled = await readFile(join(root, "receipt-enabled"), "utf8").then(() => true, () => false);
const holdEnabled = await readFile(join(root, "hold-enabled"), "utf8").then(() => true, () => false);
if (holdEnabled) services.tools = [{ name: "hold-work", description: "Run the required foreground parent and child until the host releases or cancels it. Call once at the beginning.", parameters: { type: "object", properties: {}, additionalProperties: false }, version: "1", effect: "process", replay: "never", validate: value => value, execute: async (_args, context) => {
  const result = await context.exec!(process.execPath, ["-e", `const fs=require('node:fs');const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(join(root, "heartbeat.json"))},JSON.stringify({parent:process.pid,child:child.pid}));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, "release"))})){clearInterval(timer);process.exit(0);}},50);`]);
  return { text: result.output + "前台等待已完成。", isError: result.exitCode !== 0 };
} }];
const taskServices = receiptEnabled || holdEnabled ? services : {};
let controller: TaskController; let materialAdded = false;
const hooks = { barrier: async (name: string) => {
  if (mode === "start" && name === "input_accepted" && !materialAdded) {
    materialAdded = true; const material = await readFile(join(root, "context-material.txt"), "utf8").catch(() => undefined); if (material) await controller.appendContextMaterial(material);
  }
  if (name === barrier) {
    const label = await readFile(join(root, "context-barrier-label.txt"), "utf8").catch(() => undefined);
    if (name === "context_compacted" && label && !controller.contextSummary?.includes(label)) return;
    process.send?.({ type: "barrier", name }); await new Promise<void>(resolve => process.once("message", () => resolve()));
  }
} };
try {
  controller = mode === "start"
    ? await createTaskController({ spec: JSON.parse(await readFile(argument, "utf8")), config, dataDirectory: join(root, "state"), services: taskServices, testHooks: hooks, ...(gateway ? { gateway } : {}) })
    : await openTaskController({ taskId: argument, config, dataDirectory: join(root, "state"), services: taskServices, testHooks: hooks, ...(gateway ? { gateway } : {}) });
  process.send?.({ type: "task", id: controller.id });
  controller.subscribe(event => process.stdout.write(JSON.stringify(event) + "\n"));
  try { const result = await (mode === "start" ? controller.start() : controller.resume()); process.send?.({ type: "result", state: result }); }
  finally { await controller.close(); }
} catch (error) { console.error(String(error)); process.exitCode=1; }
