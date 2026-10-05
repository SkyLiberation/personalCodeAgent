# 已落地能力、使用入口与实际验证

2026-10-05，云端 Linux。本页记录 [已实现能力的验收规格](../e2e/capabilities.md)对应的源码、入口及实测；历史第一、第二阶段记录保留各自日期的事实。设计选择与逐例证据见 [双向索引](design-evidence.md)。[历史检索](history-retrieval.md)和 [快照读取加速](snapshot-acceleration.md)已完成独立验收，[Linux-only 迁移](linux-only.md)与 [规模验证](large-log-validation.md)已完成，当前 [待落地清单](../pending/README.md)为空。

## 实现与契约

| 已处理的问题 | 当前入口 | 实际行为与边界 |
| --- | --- | --- |
| 六模块工程与隐藏数据 | [event-fixture.ts](../../tests/e2e/event-fixture.ts) | 解析行号、UTC、乱序 revision 去重、聚合、范围、真实 CLI；宿主持有 seed 和预期，不靠模型声明 |
| 完成声明迟迟不结束 | `TaskDefinition.completionPolicy` | 缺省 `natural`；`verification` 在整批工具结果提交后独立验收当前阶段，返回 `yielded`；最终仍复验全部合同、证据及控制命令 |
| 摘要遗漏细节 | `historyRetrieval:true`、[history 工具](../../src/tools/history.ts) | 当前会话按来源路径/entryId 分页检索；附件绑定提交事实，校验大小/摘要；策略、秘密、孤立引用与链接门禁 |
| 状态重复折叠 | [TaskRepository](../../src/storage/task.ts) | 宿主日志检查点绑定快照，完整验链后复用前缀、折叠后缀；不可信缓存回退，权威损坏拒绝；复杂累计账本有实测收益 |
| 上下文无限增长 | [context.ts](../../src/harness/context.ts) | 原始消息不变；真实摘要与首个保留 entry、源 hash 一起提交；完整工具组保留原生 providerData；当前合同机械重注入；请求明确早期标识可从摘要复用，文件现状与验收仍须新证据 |
| 无进展仍一直修 | `progressPolicy`、[控制器](../../src/harness/task-controller.ts) | 新的可信验收能力才清空失败窗口；先预留策略机会、有限真实 replan，带公开接口，有效策略进入新执行提示；无效响应也计次并保留附件；耗尽停在 `no_progress` |
| follow_up / steer 仅在内存 | `AgentSession.acceptInput/resumeInputs/waitInput` | accepted 后回执、consumed 与用户消息同一事实、inputId 冲突拒绝、settled 可重查；v2 内核锁支持跨进程恢复 |
| 模型暂时故障必须人工恢复 | [retry.ts](../../src/model/retry.ts) | 429、指定 5xx 和连接错误有限退避；每个尝试重新预留；次数及等待累计持久；部分文字可展示但失败响应不能执行工具 |
| token / 活动时间 / 费用 / 工具调用预算 | [request-budget.ts](../../src/model/request-budget.ts)、`TaskLimits` | 模型请求先预留；未知 usage 不按零；工具和验收时间也预留、结算；费用必须显式单价，计入缓存输入；不冒充供应商账单 |
| 预算调整 | `adjust_budget` / `task adjust-budget` | commandId 去重、budgetVersion CAS、原因和新 limits 原子提交；旧预留不清零；普通 update 不能改 limits，计价规则不能重新解释旧消耗 |
| Linux 跨来源误杀 | [linux.ts](../../src/platform/linux.ts)、[bridge](../../src/platform/linux-host.py) | v3 日志同时绑定 PID/starttime/bootId/PID namespace；全部来源核对后才清旧组；来源不符、旧原型日志无来源均拒绝 |
| 目标到阶段规划 | [planning.ts](../../src/harness/planning.ts)、`task draft` | 模型仅建议阶段和宿主已有验收 ID；草稿不执行，confirm hash 后创建任务；不能自主捏造可信验收程序 |
| DAG / 多 Agent | [workflow.ts](../../src/harness/workflow.ts) | 宿主组合独立持久控制器，检查环和依赖，并发有界；只有有最终证据的 succeeded 放行下游；图由宿主提供，各节点保留自己的预算和日志 |
| 持久后台等待 | [background.ts](../../src/harness/background.ts) | 独立 owner、有限进程超时、fsync 回执、稳定 operationId 去重；新等待者只查询；owner 无回执退出则核查旧组并记 effect_unknown，不重发命令 |
| 嵌套 AGENTS / skills | [catalog.ts](../../src/resources/catalog.ts) | 指令附作用域/来源/hash，技能只索引、通过 load-skill 按需读；跳过符号链接和私有/依赖目录；改变技能源拒绝读取 |
| 扩展注册与生命周期 | `loadExtensions`、`SessionOptions.extensions` | 显式路径与 trustedHashes，apiVersion=1，register/dispose；重复工具拒绝、加载失败也清理；Node 内扩展是宿主信任的代码 |
| MCP | [mcp.ts](../../src/tools/mcp.ts) | 真实 stdio JSON-RPC 初始化、分页工具发现、schema 校验、调用、取消、超时及断连；副作用缺省 process/never，host 必须明确降低权限 |
| 长期记忆 | [memory.ts](../../src/storage/memory.ts) | 宿主明确 authorized 才写，含来源和校验链、支持检索；不自动把聊天或外部文件记为授权事实 |
| 会话分支 | [branch.ts](../../src/storage/branch.ts) | 在无悬挂工具调用的 cursor 建立独立日志，记录祖先；不改原会话、不复制 intent 或进程所有权；原始完整消息保留 |
| RPC / Web | [RPC](../../src/rpc/server.ts)、[入口](../../src/rpc/cli.ts)、[Web](../../src/rpc/web.ts) | SDK 相同的 durable input；有界显示队列/重同步；Web 仅 loopback、每次 token、Host 检查，无外部发布 |
| 独立读有界并行 | `maxReadConcurrency`、[运行时](../../src/runtime/agent.ts) | 只并行明确 parallelSafe + read + safe 的连续调用；持久结果仍按调用顺序；写/进程串行；整批后才验收 |
| 可解释调用策略 | `toolPolicy`、`confirmTool` | 参数验证后、intent 前持久记录决策；confirm 无明确批准就拒绝；资源内容不能增加工具权限 |
| 容器执行环境 | [container.ts](../../src/environment/container.ts) | 显式 Linux 本地 Docker、预先指定镜像；工作区唯一挂载、同 UID、只读根、network none、cap-drop/no-new-privileges；取消/超时移除容器，恢复按名称/标签核查；无 host shell 降级 |
| 缺少禁止编造的输入 | `requiredInputs` | 宿主列相对路径；缺失在请求前 blocked: required_input，提供真实文件后显式恢复 |
| 截断/溢出故障 | [运行时](../../src/runtime/agent.ts) | 截断调用不执行；纯长度响应每 Run 至多一次缩短恢复；有投影时容量错误至多一次强制压缩恢复；硬容量不足明确阻塞 |

模型/工具/验收的预留采用可解释保守估计和独立超时；统计不包含暂停时间，退避计入活动额度。未知用量按预留计，已观察 usage 结算。容量估计是 UTF-8 字节与协议开销的保守估计，不称为供应商 tokenizer。可信插件或不可中断文件 I/O 不提供操作系统级瞬时抢占。

## SDK 与 CLI 用法

任务 JSON 的可选字段如下。缺省不改变旧任务自然结束策略。

```json
{
  "historyRetrieval": true,
  "completionPolicy": "verification",
  "contextPolicy": { "softTokens": 40000, "hardTokens": 250000, "keepRecentTokens": 10000, "reserveOutputTokens": 8192 },
  "progressPolicy": { "failureWindow": 2, "maxReplans": 1 },
  "retryPolicy": { "maxRetries": 2, "maxWaitMs": 10000, "delayMs": 500 },
  "limits": {
    "maxRuns": 14, "maxRepairs": 6, "maxModelRequests": 80,
    "maxToolCalls": 200, "maxTokens": 1000000, "maxDurationMs": 1800000,
    "maxCostUsd": 10, "pricing": { "inputUsdPerMillion": 1, "outputUsdPerMillion": 2 }
  }
}
```

时间/费用/工具额度相互独立。最后一次获准请求的完整工具批次仍可执行；具体工具还必须满足工具和活动时间额度。预算停下后 resume 只核查/复验，不用新 Run 绕过不足的余量；显式 adjust_budget 后才能再准入。时间不足以预留验收时不会宣称成功。

```sh
pnpm dev --durable-inbox --prompt "修复并检查工程"
pnpm dev task draft --spec host-template.json --output goal-draft.json
pnpm dev task start --draft goal-draft.json --confirm-hash <reviewed-hash>
pnpm dev task adjust-budget <task-id> --limits limits.json --expected-version 1 --command-id raise-1 --reason "允许有限继续" --wait
node dist/rpc/cli.js --cwd <workspace> --data-dir <sessions>
```

`acceptInput(text, mode, {inputId})` 返回持久回执；用 `waitInput(id)` 等最终 Run，用 `resumeInputs()` 对账未结算输入。普通 CLI 保留 v1 会话兼容；`--durable-inbox` / SDK `durableInbox:true` 创建 v2 内核锁会话，旧 v1 不猜测迁移。`steer` 活动期仍在完整批次后消费。

`TaskServices.tools` 增加工具；`codingTools` 显式替换编码工具集，注册表与实际会话使用同一集合，恢复必须保留版本。联合工程用它把 Agent shell 隔离在容器中，宿主仍运行外部可信验收。

预算从 Task 创建后的事实账本开始；确认前的 draftGoal 是单独一次规划请求，不自动计入尚未创建的 Task。宿主若要限制准备阶段总额度，应给草拟入口提供自己计量的 gateway。DAG 节点各自计量，不声称跨节点共享一份供应商账单。

规划适用于任意工程的宿主可信验收目录，而不局限测试 fixture；没有可信完成规则的自由目标不能自动 succeeded。DAG 是公开 SDK 的宿主编排，未把并发 Agent 塞进单 Agent 循环。后台 manager 可由宿主工具与恢复适配器组合；等待者离开不自动重启或取消任务，取消使用持久 cancel 请求。

## 可组合入口示例

以下路径和验收合同由宿主提供。扩展文件 hash 必须先核实，不能对工作区发现的可执行文件自动授权。

```typescript
import { createExecutionHost, MemoryStore, BackgroundTasks, createAgentSession,
  branchSession, McpClient, serveSessionWeb } from "../../src/index.js";

const host = await createExecutionHost();
const memory = new MemoryStore("/agent-state/memory.jsonl", host);
await memory.remember({ key: "test-command", text: "Use node --test",
  source: "approved-user-preference", authorized: true });
const preferences = await memory.recall("test-command");

const mcp = await McpClient.connect({ command: "node",
  args: ["/trusted-tools/server.mjs"], cwd: "/workspace/project" });
const session = await createAgentSession({ cwd: "/workspace/project", durableInbox: true,
  additionalTools: await mcp.tools("project"),
  maxReadConcurrency: 2 });
const receipt = await session.acceptInput("修复工程并执行检查", "follow_up", { inputId: "user-request-1" });
const result = await session.waitInput(receipt.inputId);
const branch = await branchSession(session.repository, { directory: "/agent-state/branches", host });
await branch.close();
const web = await serveSessionWeb(session); // 仅本机；web.url 含本次访问 token
await web.close(); await session.close(); await mcp.close();

const background = new BackgroundTasks("/agent-state/background", host);
const operation = await background.start({ executable: "node", args: ["--test"],
  cwd: "/workspace/project", timeoutMs: 60000 });
await background.wait(operation.operationId, { commandHash: operation.commandHash,
  signal: new AbortController().signal, timeoutMs: 65000 });
await host.close();
```

生产宿主应在 finally 中关闭上述资源；容器内命令和参数须使用镜像可用程序与挂载目录中的路径。容器选择与 DAG 组合如下，taskSpec / first / second 必须是已定义的可信合同或控制器。

```typescript
import { ContainerExecutionHost, createTaskController, runWorkflow } from "../../src/index.js";
const isolated = await ContainerExecutionHost.create({
  image: "node:24-bookworm-slim", workspace: taskSpec.workspaceRoot });
const controller = await createTaskController({ spec: taskSpec,
  services: { platform: async () => isolated } });
try { await controller.start(); } finally { await controller.close(); }
const tasks = await runWorkflow([
  { id: "first", dependsOn: [], run: signal => first.start(signal) },
  { id: "second", dependsOn: ["first"], run: signal => second.start(signal) },
], { concurrency: 2, signal: new AbortController().signal });
```

普通会话的 `host` 由调用者关闭；`durableInbox:true` 默认自行创建并关闭宿主。MCP 的默认 effect=process/replay=never；只读工具须由宿主核实后用 policies 标记 read/safe。确认策略使用 `toolPolicy` / `confirmTool`，没有批准不能执行；它不替宿主发起额外用户审批。

## 历史检索与快照本轮记录

2026-10-05：TypeScript 检查、构建与 73 项关键契约通过。HR-01/HR-02/SS-01/SS-02 四项实际验收全部通过，报告 `.codeagent/e2e/run-prUWzq/report.json`。模型 MiMo v2.6-flash、pi-ai 1.0.0、thinking off；真实 HR 任务用隔离 Docker shell，只挂载工作区。最终补充“合法 JSON 但嵌套过深”的坏缓存回退后，再跑 73 项契约、SS-01 真实续交付和同配置基准，均通过；补验 `.codeagent/e2e/run-Ff6LEd/report.json`。后续还补齐失败 writer 关闭门禁，SS-01/SS-02 最新补验 `.codeagent/e2e/run-O8AASP/report.json`，保护不使用旧内存水位追加检查点；初始分组与补验源码摘要分别保留。当前 66 个注册名的分组与失败重跑统一记录于 `.codeagent/hrss-validation.json`。

历史检索原诊断调用 1 次、成功 history 结果 3 条、累计请求 12；摘要和挂载文件没有随机 recoveryCode，通过绑定附件找回并独立验收 JSON。来源门禁要求模型分派 0。快照复用 30 条前缀并折叠 1 条后缀，伪造缓存回退/日志损坏拒绝；正常合同 42→43 续交付，Run 1→2、请求 4→8。详见 [实际用例](../e2e/history-snapshot.md)。

同精确日志五次性能对照 `.codeagent/snapshot-scale-AI3Z5n/report.json`：5k 累计请求账本 read 中位 1146.06→41.99 ms、open 1163.14→49.62 ms；50k 简单状态日志没有稳定净收益。仍完整解析/验链，不能声称常量 I/O 或所有日志统一改善；人工预留不是实际模型请求。完整配置、范围与内存见 [快照报告](snapshot-acceleration.md#同日志性能对照)。

首轮根契约 65/66，旧单行 v1 夹具读法已修复；更新后含新增契约 73/73。初始 E2E 的 LT-04E 夹具把 v2 检查点留在 v1 序列导致拒绝，保留 `.codeagent/e2e/run-jmd4CU/report.json`；改为真实 v1 形状并重排 seq 后真实 CLI 重跑通过，`.codeagent/e2e/run-Ka9z3Y/report.json`。TypeBox schema 类型声明和测试类型问题的编译诊断也保留，不能把失败记录改写成首次全通过。

## 此前实际验证记录

此前 Linux-only 迁移源码 TypeScript 检查和构建通过，66/66 关键契约通过；62/62 注册 E2E 分四组通过，0 failed/cancelled/skipped。精确注册名、公共配置、源码与报告摘要在 `.codeagent/linux-only-validation.json`；[迁移设计与当前报告](linux-only.md)。模型 MiMo v2.6-flash、pi-ai 1.0.0、off/8192，云端保留 HTTP(S) 代理、CA 与 NODE_USE_ENV_PROXY=1；容器执行 network none。迁移前的 61 passed / 1 Windows skipped 与历史失败在 `.codeagent/remaining-capabilities-validation.json` 保留，下面表格是迁移前报告，不能混为同次运行。

| 验收 | 已保存的实际结果与报告 |
| --- | --- |
| LT-11 自然结束六模块 | passed，约 228 秒；`.codeagent/e2e/run-7GOZMH/report.json` |
| LT-11/LT-12 六模块批次让出 | passed，约 356 秒；`.codeagent/e2e/run-6EWBU3/report.json` |
| LT-06 正反变体、RT-01/02 | 原 3 passed；`.codeagent/e2e/run-0tZOSq/report.json`；文本段策略最新正反均 passed：`.codeagent/e2e/run-o178Zv/report.json` |
| LT-03 早期标签与 reopen | passed；`.codeagent/e2e/run-sqzpHA/report.json` |
| IN accepted/consumed 真正进程崩溃 | 最新 2 passed；`.codeagent/e2e/run-cWPocY/report.json`；首次 `.codeagent/e2e/run-LJUg55/report.json` 的摘要失败保留 |
| LT-03B 摘要提交前/后真正进程崩溃 | 2 passed；`.codeagent/e2e/run-zy3akh/report.json` |
| EX/MCP/MEM、GD/WF、BG、LX-05 | 4 passed；`.codeagent/e2e/run-K44hjj/report.json` 同时保留首次容器失败；EX/MCP/MEM 最新含错误参数门禁的复验：`.codeagent/e2e/run-gIq39e/report.json` |
| MCP 真实协议反例及集成复验 | 2 passed；`.codeagent/e2e/run-3YDyyv/report.json`，超时/取消/坏协议/断连明确拒绝 |
| 容器边界修正后 | passed；`.codeagent/e2e/run-04PdlZ/report.json` |
| 容器内真实模型交付、后台 owner 崩溃 | 2 passed；`.codeagent/e2e/run-tt5f3Z/report.json` 同时保留首轮并行用例断言问题 |
| 独立 HTTP 读真实模型并行 | passed；`.codeagent/e2e/run-TapTq5/report.json` |
| RPC 子进程 / Web HTTP | 2 passed；最新含活动期 steer 最终通知与实际函数求值：`.codeagent/e2e/run-yoEwgR/report.json` |
| 累计预算及审计增加 | 最新 passed；`.codeagent/e2e/run-CZlabL/report.json`；只增加请求额度仍停在 max_runs，增加对应额度后完成；旧轮次 `.codeagent/e2e/run-4sodAz/report.json` 保留 |
| 六模块上下文/进展联合 | 隔离 shell 最终变体 passed，约 608 秒；`.codeagent/e2e/run-N8siiZ/report.json` 的 event-context-progress-joint 场景：真实已提交摘要含标签、工作区实际交付标签、七项最终宿主验收通过、一次受限重规划。该报告另含旧策略格式正向用例失败，其最新复验在 run-o178Zv 通过；不把整个报告称为全通过。非隔离轮次 run-BjOxKL / run-pHcDjF 只作补充观测，全部失败保留 |
| 固定配置三 seed / 并发依赖测量 | 第二次 3/3 passed、最大并发 2；`.codeagent/e2e/run-oSvf17/report.json`；第一次 1/3 保留于 `.codeagent/e2e/run-DYP7PF/report.json` |
| 原有 38 个场景回归 | 原分组日志 34 passed / LT-02 failed / Windows skipped；补跑 cancel 与 update 2 passed。LT-02 最新自然结束、故障与真实修复均 passed，约 309 秒；`.codeagent/e2e/run-x2Mfxw/report.json`，旧失败保留 |

诊断中修正的问题：摘要用例第一次在尚未压缩标签所在段时暂停；第二次的标签验收器没有把缺失交付文件编码为 failed 而直接抛出，导致 unavailable；现在边界和检查都明确。容器第一次使用 root 且丢弃全部 capability，无法写当前 UID 的挂载，改为同 UID。并行用例把正确的 `17+25` 当失败，改为实际导入 `value()` 求值。联合正向用例首轮 failureWindow=1 过早停止，改为 2 并要求去重缺陷至少两次真实失败。又发现候选进程能提前退出可信 reporter，已把候选执行放到子进程；无效 replan 现在也预留机会并保留原始附件。策略建议中的真实引号使模型 JSON 格式失败，现改用 Diagnosis/Changes/Checks 文本段，由宿主编码；同一行或下一行的段内容均支持，不要求模型承担字符串转义。RPC 首次活动验证等待了错误的 tool_started 字段，改为 call.name；这是测试等待条件的修正。隔离组合第一次重复注入默认工具而被注册表拒绝，已增加显式 codingTools 替换入口。失败报告不改写为通过。

## 明确保留的支持边界

不自动迁移有执行历史且缺少效果/进程身份的 v1 任务；Linux v2 原型进程日志缺少 boot/ns 也不猜测迁移。这是已实现的拒绝策略，避免伪造旧效果证据，不是把未完成迁移称为完成。

当前统一 Linux，Windows 后端、PowerShell 和 taskkill 兼容路径已删除；[迁移验收](../e2e/linux-only.md)记录当前源码结果，旧 Windows 阶段报告保留历史平台范围。来源门禁拒绝跨执行环境身份不匹配，并不承诺迁移活跃进程。远程任意副作用、主动逃逸本地进程组、不受信任的 Node 插件不扩大为自动安全恢复；需隔离时显式选择容器。

三 seed 测量只报告该固定配置和样本，不推导任意复杂工程稳定完成率。图自身由宿主保管，节点的事实/预算/交付独立持久；外部多用户部署、远程队列或商业计费系统不属于本文的实现承诺。

## 量化观测

实际账本与重复读取测量保存在 `.codeagent/remaining-capabilities-metrics.json`；通用读取入口是 [task-metrics.ts](../../scripts/task-metrics.ts)。迁移前只量到本机 79–718 条任务事实、约 44–401 KB 的日志，五次暖读中位数约 1.4–8.8 ms，不外推大规模性能或网络盘行为。

小标签任务的最大真实摘要请求为 27,228 bytes，随后两次执行请求为 6,493–8,005 bytes；已通过联合任务中最大摘要请求 150,201 bytes，21 次执行请求 7,226–37,809 bytes。两者是摘要输入与实际执行请求的字节比较，不是 tokenizer 或相同轨迹的成本对照。小标签例另直接检查摘要含标签；非隔离联合样本只用于请求体观测，不作为标签仅来自摘要的充分证据。最终隔离变体单独要求摘要含标签且交付独立验收通过。

自然基线观察到 29 次请求 / 296,087 个 usage token；首轮完整批次让出为 14 次 / 130,544。它们使用不同 thinking、seed 和运行轨迹，不能据此声称固定比例优化。早期非隔离联合样本为 27 次（5 summary、21 execution、1 replan），186,638 个 usage token。最终隔离联合样本为 53 次（11 summary、41 execution、1 replan），343,852 个 usage token；摘要和策略共同计入账本。其最大摘要请求 149,218 bytes，实际执行请求 7,942–38,339 bytes，标签同时存在于提交摘要和交付文件。

三 seed 当前通过样本请求数为 17 / 12 / 19，token 为 97,804 / 63,280 / 99,905。第一次调试执行 137 成功、271 因越界写的准备错误未能继续、809 因依赖失败未启动；修正准备错误反馈后，同配置三节点全部通过。两轮分属不同源码，不能把第二轮 3/3 隐去第一轮或当作普遍稳定成功率。

预算实测使用显式示例单价 input=$1/M、output=$2/M：最新 BD-01 调整前 1,168 token / 7,452 ms / $0.001225，恢复完成后累计 6,630 token / 22,907 ms / $0.006945。包含缓存输入和工具/验收活动；这是配置单价下的准入估算，不是 Token Plan 的实际账单。执行及修复额度耗尽也记录预算版本：未增加时 resume 仅复验，增加后允许有限继续，历史计数不清零。

本轮 [V-SCALE](large-log-validation.md#scale)已完成 1000/10000/50000 条生成日志的三种公开操作测量，以及 50000 条时前缀损坏拒绝与尾部修复；不是实际模型工程成功率。五次样本、内存和配置完整保留，旧报告是优化前全量折叠基线；[SS-01](snapshot-acceleration.md#同日志性能对照)另用同一当前日志比较默认缓存与完整重放，避免跨源码比例比较。

当前 Linux 真实六模块自然结束、完整批次让出及摘要/重规划/容器联合场景均通过：`.codeagent/e2e/run-9VChYC/report.json`；固定 seed 137/271/809 依赖编排 3/3 passed：`.codeagent/e2e/run-px8tBT/report.json`。当前全面覆盖与历史结果分开保存。

本轮分组 A 16/16、B 19/19、C 22/22、D 4/5；D 中 LT-04E 修正 v1 夹具后单独重跑 1/1。新增 HR/SS 初始 3/3，最终补验 SS-01/SS-02 2/2（SS-02 是新增注册名），66 个注册名最终全部通过，0 cancelled/skipped。完整序列与一次旧夹具失败保留在 `.codeagent/hrss-validation.json`。最新三 seed 报告 `.codeagent/e2e/run-w54Sal/report.json` 3/3，通过依赖后才启动下游，并发最大 2；联合工程 `.codeagent/e2e/run-Y26vVT/report.json` 通过。
