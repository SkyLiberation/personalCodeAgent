# Personal Code Agent

基于 TypeScript 的编码 Agent 初版。复用 `pi-ai` 接入 MiMo，自行实现 Agent 循环、工具执行、会话管理和 CLI。

默认模型为 `mimo-v2.6-flash`，使用中国区 Token Plan 地址 `https://token-plan-cn.xiaomimimo.com/v1`。

## 启动

需要 Node.js 24 或更高版本、pnpm。依赖已在当前工作区安装。

```powershell
pnpm dev
```

执行单次任务：

```powershell
pnpm dev --prompt "读取项目结构，说明当前实现"
pnpm dev --cwd D:\path\to\project --prompt "修复失败的测试并验证"
```

构建并运行：

```powershell
pnpm build
pnpm start --prompt "列出根目录文件"
```

密钥从本应用根目录的 `.env` 或环境变量读取。本地 `.env` 已配置，且被 `.gitignore` 排除。复制工程时，可参考 `.env.example` 配置。进程环境变量优先，不会从 `--cwd` 指定的任意目标工程加载 `.env`。

| 配置 | 默认值 / 用途 |
| --- | --- |
| `MIMO_API_KEY` | 必填；Token Plan 密钥 |
| `MIMO_MODEL_ID` | `mimo-v2.6-flash` |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` |
| `MIMO_THINKING` | `low`；支持 `off`、`low`、`medium`、`high` |
| `MIMO_MAX_OUTPUT_TOKENS` | `8192`；单次模型响应额度，包含供应商计入的推理输出 |
| `AGENT_MAX_TURNS` | `20` |
| `AGENT_REQUEST_TIMEOUT_MS` | `120000` |
| `AGENT_TOOL_TIMEOUT_MS` | `60000` |

## 可用能力

- 流式模型输出，自动进行模型 → 工具 → 模型的多轮执行。
- `read`：读取带行号的文本或列出目录。
- `write`：创建或替换文件；`edit`：替换唯一的精确匹配。
- `shell`：执行构建、搜索和测试；Windows 默认 PowerShell，其他平台默认 bash。
- JSONL 会话、恢复上下文、工具调用 intent、输出附件和会话文件锁。
- 持久任务与阶段推进、独立验收、失败反馈修复，支持 `task start / status / resume / pause / cancel / update / command-status`。
- 根目录 `AGENTS.md` 指令加载、最大轮次、工具超时与 Ctrl+C 取消。
- 运行中普通输入作为 follow-up 排队，`/steer` 在当前工具轮结束后调整方向。

交互命令：`/help`、`/session`、`/steer <消息>`、`/abort`、`/quit`。Ctrl+C 在运行时取消当前任务，空闲时退出。取消时未发送的 steering 消息会显示出来。

恢复会话与限制工具：

```powershell
pnpm dev --session <session-id> --prompt "继续上次工作"
pnpm dev --data-dir D:\agent-data\sessions --prompt "使用独立目录保存会话"
pnpm dev --readonly --prompt "检查项目结构"
pnpm dev --no-shell --prompt "读取并修改指定文件"
pnpm dev --max-turns 5 --prompt "完成一个小任务"
pnpm dev --json --prompt "读取 README.md"
```

`--json` 在 stdout 输出事件 JSONL。诊断信息写到 stderr。非交互输入也可以通过 stdin 提交。

会话默认保存在本应用的 `.codeagent/sessions`，也可通过 `--data-dir` 指定目录，按 session ID 命名；恢复时必须使用相同工作区和会话目录。工具输出较长时保存为 `<session-id>-artifacts` 中的附件。结束时输出 `completed`、`failed`、`aborted` 或 `budget_exhausted`；`completed` 表示循环自然结束，具体测试是否通过应查看实际工具结果。

## SDK

```typescript
import { createAgentSession } from "./src/index.js";

const session = await createAgentSession({ cwd: process.cwd() });
session.subscribe((event) => {
  if (event.type === "text_delta") process.stdout.write(event.delta);
});

try {
  const result = await session.submit("读取项目并说明实现");
  console.log(result.status);
} finally {
  await session.close();
}
```

在 TypeScript 工程中使用上述导入；构建产物的入口是 `dist/index.js`。宿主可通过 `gateway` 和 `tools` 注入替代实现。运行中追加任务使用 `submit(text, "follow_up")`，调整当前任务使用 `steer(text)`。

## 验证

```powershell
pnpm check
pnpm test
pnpm build
```

真实模型联调：

```powershell
pnpm smoke
```

`smoke` 使用已配置的模型和密钥，会消耗 API 配额。它在系统临时目录创建包含错误实现的测试项目，让 Agent 读取、修复并运行测试，再由程序独立验证测试通过、测试文件未被修改和日志不含配置密钥。临时项目保留，便于检查真实产出。

完整 CLI 端到端测试：

```powershell
pnpm test:e2e
```

命令先构建，再串行执行原有 CLI、LT-01 / LT-02、恢复 / 控制 / 故障 / 迁移、报价 HTTP 和 HT-01 / HT-02 / HT-03 用例。模型相关执行使用真实 MiMo，会消耗 API 配额，独立于 `pnpm test`。工作区、事件日志和报告保存在 `.codeagent/e2e/run-*`；平台证据另保存在 `.codeagent/platform-*`。原 26 个 E2E 的分组通过记录见 [第二阶段验收](docs/long-tasks-phase2-implementation.md)，本轮结果见 [补强实现记录](docs/long-tasks-hardening-implementation.md)。

## 初版边界

文件工具限制在工作区内，拒绝越界路径、指向工作区外的链接、`.env*` 密钥文件和 `.codeagent` 私有数据；`.env.example` 可以读取。Shell 使用宿主权限和工作区 cwd，不提供操作系统沙箱。配置密钥不会传入 shell 环境，工具结果、事件和日志会脱敏。

工具默认串行。同一路径的文件修改有进程内队列。普通聊天入口仍使用 v1 会话锁，异常退出留下 `.jsonl.lock` 时需确认旧进程停止后处理。持久任务入口使用 Windows 内核执行权和 Job Object，锁文件永久保留；强退后先确认旧进程组静止，再显式恢复，不能通过删锁文件夺权。

普通聊天恢复会补充工具中断结果；持久任务恢复先查询回执或核对文件后置条件，未知副作用会阻塞模型继续执行。当前尚未实现自动压缩、对话分支、长期记忆、MCP、扩展加载和多 Agent；普通聊天输入队列保存在内存中。

架构、实现取舍与参考来源见 [docs/architecture.md](docs/architecture.md) 和 [docs/implementation.md](docs/implementation.md)。

长任务支持阶段 / 最终独立验收、失败反馈、持久证据和显式跨进程恢复。`task resume` 会先核查旧效果并重验当前文件；`task pause / cancel / update` 使用持久命令，`task command-status` 可查询应用结果。LT-01 / LT-02 与第二阶段真实 E2E 已通过；上下文压缩和全局模型预算等后续能力仍按 [处理方案](docs/long-tasks.md) 推进。

长任务第二阶段已提供工具回执 / 文件后置条件核查、完整合同版本更新和 Windows 执行权 / 进程托管。旧格式仅自动迁移具有完整未启动证据的空任务，有执行历史且证据不足的 v1 任务保持只读。运行说明、平台条件和实际证据见 [第二阶段实现记录](docs/long-tasks-phase2-implementation.md)。

本轮补强在成功提交前再次核查证据；未确认写入的目标文件或回执暂时无法读取时保持可恢复阻塞，不重放副作用。更长依赖链工程、上下文缩减、累计请求预算和无进展控制的验收定义见 [第三阶段 E2E 规格](docs/long-tasks-phase3-e2e.md)，这些下一阶段功能仍未实现。
