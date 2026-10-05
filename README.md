# Personal Code Agent

基于 TypeScript 的编码 Agent。复用 `pi-ai` 接入 MiMo，自行实现 Agent 循环、工具执行、会话管理和 CLI。

默认模型为 `mimo-v2.6-flash`，使用中国区 Token Plan 地址 `https://token-plan-cn.xiaomimimo.com/v1`。

## 启动

仅支持 Linux，需要 Node.js 24 或更高版本、pnpm、Python 3 和 Bash。依赖已在当前工作区安装。

```bash
pnpm dev
```

执行单次任务：

```bash
pnpm dev --prompt "读取项目结构，说明当前实现"
pnpm dev --cwd /path/to/project --prompt "修复失败的测试并验证"
```

构建并运行：

```bash
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
- `shell`：执行构建、搜索和测试；仅使用 Bash；旧 PowerShell 参数被明确拒绝。
- JSONL 会话、恢复上下文、工具调用 intent、输出附件和会话文件锁。
- 持久任务与阶段推进、独立验收、失败反馈修复，支持 `task draft / start / status / resume / pause / cancel / update / adjust-budget / command-status`。
- 持久任务支持可选 `limits.maxModelRequests`，跨阶段、暂停、恢复和需求更新累计模型请求；Linux 使用 flock、subreaper 和经过来源验证的进程组后端。
- 嵌套 `AGENTS.md`、skills 按需加载、受信任扩展 lifecycle、MCP stdio 工具、宿主授权长期记忆和会话分支。
- 持久摘要投影、完整工具组验收让出、有限无进展重规划与传输重试；累计 token/活动时间/费用/工具预算。
- 显式启用 `historyRetrieval` 后，模型按当前会话的来源路径/entryId 分页检索原文和已绑定附件；快照绑定权威检查点，完整验链后复用前缀状态。
- 宿主验收下的目标草拟、独立 Agent 的 DAG 编排、持久后台 owner/回执、RPC 与本地 Web、显式 Docker shell、独立读有界并行。
- 运行中普通输入作为 follow-up 排队，`/steer` 在当前工具轮结束后调整方向。

交互命令：`/help`、`/session`、`/steer <消息>`、`/abort`、`/quit`。Ctrl+C 在运行时取消当前任务，空闲时退出。取消时未发送的 steering 消息会显示出来。

恢复会话与限制工具：

```bash
pnpm dev --session <session-id> --prompt "继续上次工作"
pnpm dev --data-dir /var/lib/codeagent/sessions --prompt "使用独立目录保存会话"
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

需要摘要后找回原文时，SDK 或 TaskDefinition 设 `historyRetrieval:true`，默认不注册 history 工具；查询范围是当前会话。状态 read/open 默认使用可信快照，无效缓存完整重放；同日志对照及适用范围见 [快照实测](docs/implemented/snapshot-acceleration.md#同日志性能对照)。

在 TypeScript 工程中使用上述导入；构建产物的入口是 `dist/index.js`。宿主可通过 `gateway` 和 `tools` 注入替代实现。运行中追加任务使用 `submit(text, "follow_up")`，调整当前任务使用 `steer(text)`。

## 验证

```bash
pnpm check
pnpm test
pnpm build
```

真实模型联调：

```bash
pnpm smoke
```

`smoke` 使用已配置的模型和密钥，会消耗 API 配额。它在系统临时目录创建包含错误实现的测试项目，让 Agent 读取、修复并运行测试，再由程序独立验证测试通过、测试文件未被修改和日志不含配置密钥。临时项目保留，便于检查真实产出。

完整 CLI 端到端测试：

```bash
pnpm test:e2e
```

命令先构建，再串行执行全部交付、恢复、故障、预算、上下文、工程和集成用例。当前共 66 个注册场景，仅在 Linux 执行，不保留 Windows 兼容或平台跳过。各用例干什么、实际检查什么、能证明什么，见 [E2E 用例总结](docs/e2e/README.md)。模型相关执行使用真实 MiMo，会消耗 API 配额，独立于 `pnpm test`。工作区、事件日志和报告保存在 `.codeagent/e2e/run-*`；本次 Linux 平台证据在 `.codeagent/e2e/linux-platform-*`。原 26 个 E2E 的分组通过记录见 [第二阶段验收](docs/implemented/history/recovery.md)，历史单次 29 个结果见 [补强实现记录](docs/implemented/history/hardening.md)。

云端通过继承的 HTTP(S) 代理访问模型时，Node 24 可用 `NODE_USE_ENV_PROXY=1` 启动测试/CLI，并保留环境配置的 CA 信任。Linux 持久任务还要求 Python 3 和 `/proc`，后端不可用时拒绝执行。精确配置与本次结果见 [完整落地记录](docs/implemented/current.md)。

## 使用边界

文件工具限制在工作区内，拒绝越界路径、指向工作区外的链接、`.env*` 密钥文件和 `.codeagent` 私有数据；`.env.example` 可以读取。Shell 使用宿主权限和工作区 cwd，不提供操作系统沙箱。配置密钥不会传入 shell 环境，工具结果、事件和日志会脱敏。

工具默认串行；明确声明 parallelSafe/read/safe 的独立读可配置 maxReadConcurrency 有界并行。同一路径的文件修改有进程内队列。普通聊天入口仍使用 v1 会话锁，异常退出留下 `.jsonl.lock` 时需确认旧进程停止后处理。持久任务入口仅在 Linux 使用 flock/进程组与身份日志，锁文件永久保留；强退后先确认旧进程组静止，再显式恢复，不能通过删锁文件夺权。

普通聊天恢复会补充工具中断结果；持久任务恢复先查询回执或核对文件后置条件，未知副作用会阻塞模型继续执行。上述扩展现已实现，公开入口与实际验收见 [完整落地记录](docs/implemented/current.md)。普通聊天兼容 v1；新持久输入可用 `--durable-inbox`，SDK 通过 inputId 查询/对账，已结算输入不重新执行。

架构、实现取舍与参考来源见 [架构设计](docs/implemented/architecture.md) 和 [初版历史记录](docs/implemented/history/initial.md)；当前设计理由与逐例验证见 [设计与 E2E 对应](docs/implemented/design-evidence.md)。

长任务支持阶段 / 最终独立验收、失败反馈、持久证据和显式跨进程恢复。`task resume` 会先核查旧效果并重验当前文件；`task pause / cancel / update` 使用持久命令，`task command-status` 可查询应用结果。LT-01 / LT-02 与第二阶段真实 E2E 已通过；全部优化与扩展实现见 [当前落地记录](docs/implemented/current.md)。

长任务第二阶段已提供工具回执 / 文件后置条件核查、完整合同版本更新和原生执行权 / 进程托管。旧格式仅自动迁移具有完整未启动证据的空任务，有执行历史且证据不足的 v1 任务保持只读。运行说明、平台条件和实际证据见 [第二阶段实现记录](docs/implemented/history/recovery.md)。

本轮补强在成功提交前再次核查证据；未确认写入的目标文件或回执暂时无法读取时保持可恢复阻塞，不重放副作用。本次已落地 Linux 后端、累计资源预算与其余扩展，当前结果见 [完整落地记录](docs/implemented/current.md)。更长依赖链工程、上下文缩减和无进展控制已实施，验收定义见 [第三阶段 E2E 规格](docs/e2e/engineering.md)。

当前已落地能力、配置示例、66 个用例的说明和实际报告见 [docs 文档索引](docs/README.md) 与 [实现记录](docs/implemented/current.md)。历史检索与可信快照已落地，见 [历史检索](docs/implemented/history-retrieval.md)和 [快照加速](docs/implemented/snapshot-acceleration.md)；[待落地清单](docs/pending/README.md)当前为空。容器测试需本地 Docker 和预拉取 `node:24-bookworm-slim`；普通本地 shell 仍使用宿主权限。历史通过、首次失败和重跑结果分别保留。

当前平台政策与迁移验收见 [Linux-only](docs/e2e/linux-only.md)。旧 Windows 进程记录不会转换为 Linux 活跃进程身份。
