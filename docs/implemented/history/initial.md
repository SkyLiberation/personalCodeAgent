# 初版实现记录

> 当前执行平台已统一 Linux，Windows 兼容层已移除；本页保留原阶段平台与验收事实。当前验收见 [Linux-only](../../e2e/linux-only.md)。


> 历史阶段记录：下文的实现范围、限制和验收数对应其记录日期，不是当前待办清单。2026-10-05 后续实现见 [当前落地记录](../current.md) 与 [逐用例说明](../../e2e/advanced.md)；历史失败与平台报告仍保留。

日期：2026-10-03。本文记录已实现功能及其与 [架构草案](../architecture.md) 的差异。

## 实现结构

| 模块 | 文件 | 实际职责 |
| --- | --- | --- |
| 契约 | `src/contracts.ts` | 自有消息、事件、工具、结果与 ModelGateway 接口 |
| 模型接入 | `src/model/pi-gateway.ts` | 使用 `@earendil-works/pi-ai@1.0.0` 的 MiMo Provider；适配统一接口 |
| 执行循环 | `src/runtime/agent.ts` | 多轮模型与工具、截断调用阻止、预算、取消、steering 边界 |
| 工具 | `src/tools/` | TypeBox schema 验证、策略、串行执行、输出附件 |
| 执行环境 | `src/environment/local.ts` | 工作区路径、链接检查、原子写入、精确编辑、进程树取消 |
| 会话 | `src/harness/session.ts` | 单活动 run、follow-up 队列、恢复、中断结果、最终 settled |
| 持久化 | `src/storage/session.ts` | 单写者 JSONL、parent 链、尾部修复、锁、fsync 与附件 |
| 指令 | `src/resources/instructions.ts` | 读取工作区根目录 AGENTS.md、装配系统指令 |
| 宿主 | `src/cli.ts`、`src/index.ts` | 交互 / 单次 / JSONL CLI 与 SDK 导出 |

## 参考与取舍

pi 的参考快照仍为 `a276dabe57911253350bffb93cb7d7aff6a73261`。本次实际依赖使用 npm 发布包 `@earendil-works/pi-ai@1.0.0`，通过 pnpm 锁文件固定依赖解析结果。

| 比较项 | 参考实现 | 本工程初版 |
| --- | --- | --- |
| 模型协议 | pi 的 Models / Provider 与统一流 | 复用 pi-ai，自有 Gateway 负责消息转换 |
| 执行循环与会话 | pi 的 Agent / AgentSession 分层 | 自有 AgentRuntime / AgentSession；保持模块分层 |
| 工具调用关联与失败结果 | pi 的 call ID / toolResult；Hermes 的调用引用与 terminal hook | 统一保留 call ID；参数非法、策略拒绝与失败均反馈配对结果 |
| 工具输出预算 | pi 截断输出；Hermes 单独管理工具结果预算 | 固定字符上限与输出附件；尚不按模型上下文动态调整 |
| 并发 | pi 当前默认并行；Hermes 有批次 worker 上限 | 首版串行，优先验证副作用和顺序 |
| 恢复 | pi 会话投影；pi-durable 的任务与重放策略 | 保留日志 / intent，补充中断结果；不实现 durable task scheduler |

初版实现时对 Hermes 仅做了工具执行模块的局部比较。2026-10-04 的 [长任务处理方案](../long-tasks.md) 已确认 DeepSeek Harness 官方仓库，并补充三种 Agent 的长任务相关比较。后续已落地任务与验收闭环，见 [长任务第一阶段实现](phase1.md)；本文保留 2026-10-03 初版的范围与验证记录。

来源：

- [pi Agent 循环](https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/agent/src/agent-loop.ts)。
- [pi SDK 装配](https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/coding-agent/src/core/sdk.ts)。
- [pi MiMo 模型与兼容标记](https://pi.dev/models/xiaomi-token-plan-cn/mimo-v2-6-flash)。
- [MiMo Token Plan 官方接入说明](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access)。
- [Hermes 工具执行器，快照 e67255e](https://github.com/NousResearch/hermes-agent/blob/e67255e7e4baec0d01c08a1e81e31223528522d4/agent/tool_executor.py)。

## 已处理的关键细节

MiMo 的多轮工具调用需要保留推理上下文。自有 assistant 消息通过 `providerData` 保存完整 pi-ai assistant message，包括 thinking blocks 和 Provider 元数据。运行时不解析这些字段，恢复时由适配器转换回原始消息，避免只保存文本与工具调用而丢失 reasoning_content。

完整 assistant 消息先提交，再记录并执行工具 intent，结果提交后发出工具完成事件。流式文字是临时展示事件。模型被截断时不会执行其工具调用；原始历史中的未完成调用会在恢复时获得中断结果。

Windows 执行环境使用 PowerShell，并设置 UTF-8 输出和显式传播最后一个原生命令的退出码。否则 PowerShell 的通用失败退出码可能掩盖真实命令退出码。取消 / 超时使用 taskkill 终止进程树；其他平台终止进程组。

配置密钥仅保存于本地 `.env` 或进程环境中。日志、工具输出、事件和附件脱敏；流式脱敏保留跨 chunk 的密钥前缀，避免只做单 chunk 替换导致泄露。文件工具不允许读取密钥文件。

## 初版当日限制（后续状态见完整落地记录）

- JSONL 目前为线性 parent 链，没有实现分支选择和上下文压缩。
- 仅加载工作区根目录 AGENTS.md，未实现嵌套指令和 skills / extensions 发现。
- 仅限制最大模型轮次；成本与总运行时长预算尚未实现。MiMo Token Plan 的目录 cost 数值不用于计费估算。
- 请求 / 工具超时与取消已支持；模型与副作用工具不自动重试。
- 未实现持久化输入队列、后台任务、多 Agent 或 MCP。
- 文件工具有路径边界；shell 和进程内代码使用宿主权限。
- 订阅者异常与执行隔离，但没有完整的事件队列背压 / 快照协议。
- 原始 Provider 数据绑定当前 pi-ai 消息格式，跨版本迁移需明确适配。

## 验证方式

自动化测试覆盖多轮工具反馈、参数失败、权限策略、截断、预算、取消、steering / follow-up、会话锁、尾部修复、中断恢复、路径和链接边界、PowerShell UTF-8 / 退出码 / 超时以及密钥脱敏。

真实 MiMo smoke 首次验证用 4 个模型 turn 完成读取 → 修复加法错误 → shell 运行测试。独立复跑测试通过，测试文件未被修改，日志不含配置密钥。`pnpm smoke` 可在新临时项目重现该流程。

新增 `pnpm test:e2e` 从构建后的 CLI 启动真实 MiMo 端到端用例，覆盖 TypeScript 购物车修复、stdin 与跨进程会话恢复、只读库存审查和轮次预算。CLI 的 `--data-dir` 暴露已有 SDK 会话目录选项，支持测试和日常运行的存储隔离。具体断言和验证边界见 [E2E 测试说明](../../e2e/history/cli.md)。
