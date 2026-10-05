#!/usr/bin/env node
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { createAgentSession } from "./harness/session.js";
import { errorText, SecretRedactor } from "./security.js";
import { taskCli } from "./task-cli.js";

const help = `TypeScript Code Agent (MiMo)

pnpm dev --prompt "检查项目并修复问题"
pnpm dev --cwd D:\\path\\to\\project
pnpm dev --session <id> --prompt "继续上次任务"
pnpm dev task start --spec <task.json> --json
pnpm dev task status <task-id>

参数：
  -p, --prompt <text>   执行一次任务
  --cwd <directory>    工具工作区，默认当前目录
  --session <id>       恢复一个已有会话
  --data-dir <path>    会话存储目录，默认 .codeagent/sessions
  --durable-inbox       持久输入队列与内核会话锁（新 v2 会话）
  --readonly           仅允许读取工具
  --no-shell           禁用命令执行
  --max-turns <number> 最大模型轮次，默认 20
  --json               将事件以 JSONL 写到 stdout
  -h, --help           显示帮助

交互命令：/session /steer <调整消息> /abort /quit /help
运行中普通输入作为 follow-up 排队；/steer 在当前工具轮结束后生效。
Ctrl+C 取消当前任务，空闲时退出。`;

async function main(): Promise<void> {
  if (process.argv[2] === "task") { await taskCli(process.argv.slice(3)); return; }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      prompt: { type: "string", short: "p" }, cwd: { type: "string" }, session: { type: "string" },
      "data-dir": { type: "string" },
      "durable-inbox": { type: "boolean" },
      readonly: { type: "boolean" }, "no-shell": { type: "boolean" }, "max-turns": { type: "string" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(help); return; }
  const config = loadConfig();
  if (values["max-turns"]) {
    const maxTurns = Number(values["max-turns"]);
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error("--max-turns 必须是正整数");
    config.maxTurns = maxTurns;
  }
  const session = await createAgentSession({
    config, ...(values.cwd ? { cwd: values.cwd } : {}), ...(values.session ? { sessionId: values.session } : {}),
    ...(values["data-dir"] ? { dataDirectory: values["data-dir"] } : {}),
    readonly: values.readonly ?? false, noShell: values["no-shell"] ?? false,
    durableInbox: values["durable-inbox"] ?? false,
  });
  const note = (text: string) => process.stderr.write(text + "\n");
  if (!values.json) note(`MiMo ${config.modelId}\n会话：${session.id}\n工作区：${session.repository.cwd}`);
  for (const warning of session.repository.warnings) note(warning);
  session.subscribe((event) => {
    if (values.json) { process.stdout.write(JSON.stringify(event) + "\n"); return; }
    if (event.type === "text_delta") process.stdout.write(event.delta);
    if (event.type === "tool_started") note(`\n[${event.call.name}]`);
    if (event.type === "tool_completed") {
      if (event.result.isError) note(`[工具错误] ${event.result.text.slice(0, 1200)}`);
      else if (event.toolName !== "read") note(event.result.text.slice(0, 600));
    }
    if (event.type === "run_settled") {
      process.stdout.write("\n");
      note(`[${event.status}]${event.error ? " " + event.error : ""}`);
    }
  });
  const abort = () => {
    const pending = session.abort();
    note("正在取消当前任务…");
    if (pending.length) note("未发送的调整消息：\n" + pending.join("\n"));
  };
  const terminate = () => { void session.close().then(() => { process.exitCode = 130; }); };
  process.once("SIGTERM", terminate);
  try {
    let prompt = values.prompt ?? positionals.join(" ");
    if (!prompt && !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      prompt = Buffer.concat(chunks).toString("utf8").trim();
    }
    if (prompt) {
      process.on("SIGINT", abort);
      try {
        const result = await session.submit(prompt);
        if (result.status !== "completed") process.exitCode = result.status === "aborted" ? 130 : 1;
      } finally { process.off("SIGINT", abort); }
    } else if (process.stdin.isTTY) {
      note("输入任务；/help 查看命令。");
      const reader = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
      let readerClosed = false;
      reader.once("close", () => { readerClosed = true; });
      const handleLine = async (line: string) => {
        const input = line.trim();
        if (!input) return;
        if (input === "/quit" || input === "/exit") { await session.close(); reader.close(); return; }
        if (input === "/help") { note(help); return; }
        if (input === "/session") { note(`会话：${session.id}\n日志：${session.repository.path}`); return; }
        if (input === "/abort") { abort(); return; }
        if (input.startsWith("/steer ")) {
          const result = await session.steer(input.slice(7));
          if (result === "queued") note("调整消息已排队，将在当前工具轮结束后生效。");
          return;
        }
        const wasBusy = session.busy;
        const task = session.submit(input, "follow_up");
        if (wasBusy) note("追加任务已排队。");
        await task;
      };
      reader.on("line", (line) => {
        void handleLine(line).catch((error) => note(errorText(error))).finally(() => {
          if (!session.busy && !readerClosed) reader.prompt();
        });
      });
      reader.on("SIGINT", () => { if (session.busy) abort(); else reader.close(); });
      reader.prompt();
      await new Promise<void>((resolve) => reader.once("close", resolve));
    } else {
      throw new Error("请输入任务，或使用 --prompt");
    }
  } finally {
    process.off("SIGTERM", terminate);
    await session.close();
  }
}

main().catch((error) => {
  const redactor = new SecretRedactor([process.env.MIMO_API_KEY ?? ""]);
  process.stderr.write(redactor.text(errorText(error)) + "\n");
  process.exitCode = 1;
});
