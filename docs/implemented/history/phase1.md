# 长任务第一阶段实现

> 当前执行平台已统一 Linux，Windows 兼容层已移除；本页保留原阶段平台与验收事实。当前验收见 [Linux-only](../../e2e/linux-only.md)。


> 历史阶段记录：下文的实现范围、限制和验收数对应其记录日期，不是当前待办清单。2026-10-05 后续实现见 [当前落地记录](../current.md) 与 [逐用例说明](../../e2e/advanced.md)；历史失败与平台报告仍保留。

日期：2026-10-04。范围：落实 [长任务方案](../long-tasks.md) 的第一阶段，以及 [LT-01 / LT-02](../../e2e/history/long-tasks.md)。两个真实模型 E2E 已通过，原有 4 个 E2E 回归通过；运行记录见本文件末尾。

## 1. 已实现的能力

新增 `TaskController` 驱动现有 `AgentSession`，依次执行宿主定义的阶段。每次模型 Run 自然结束，或在完整工具批次后达到局部轮次上限，由宿主独立执行阶段验收；合同说明和实际失败诊断进入下一次真实模型请求，证据附件由宿主持有。通过阶段验收后继续下一阶段，全部阶段完成后再运行完整最终验收。

模型 `completed` 不直接映射为任务成功。只有最终验收确实执行、所有合同通过、可信文件完整、输入及输出摘要仍有效时，才能提交任务 `succeeded`。没有有效报告、零项检查、可信验收文件变化或验收期间源码变化都会阻止成功。

| 模块 | 实现职责 |
| --- | --- |
| [任务契约](../../../src/task-contracts.ts) | 阶段、验收合同、任务状态、证据与事件；校验最终验收覆盖阶段合同 |
| [任务控制器](../../../src/harness/task-controller.ts) | 有界推进、验收反馈、阶段证据、最终成功判定与 SDK 生命周期 |
| [验收器](../../../src/harness/verifier.ts) | 结构化子进程执行、报告校验、可信文件摘要、源码与产物指纹 |
| [任务存储](../../../src/storage/task.ts) | 串行 JSONL、fsync、单写者创建锁、日志派生状态、证据附件和快照缓存 |
| [任务 CLI](../../../src/task-cli.ts) | `task start` / `task status`，JSONL 事件与任务退出码 |
| [执行环境](../../../src/environment/local.ts) | 新增直接执行 `command + args`，沿用超时、进程树停止、UTF-8 和密钥清理 |

保持现有聊天 CLI 与 SDK 用法。任务 Run 使用预先提交的稳定 run ID 关联会话日志；验收记录携带会话游标，方便追查实际模型和工具交互。

## 2. 任务定义与验收合同

任务定义的字段为 `workspaceRoot、outcome、constraints、milestones、verifiers、finalVerificationIds、limits`；准确类型见 [TaskDefinition](../../../src/task-contracts.ts)。第一版按 `milestones` 的数组顺序推进，不实现任意 DAG 调度。

每个验收器声明：

- `id / description`：合同标识和实际能力说明。
- `command / args`：可执行程序的绝对路径与参数数组，不拼接 shell 字符串。
- `inputs`：需要绑定证据的工作区相对路径，可指定目录，按内容计算摘要。
- `trustedFiles`：不能由 Agent 改变的验收脚本、输入副本或项目约束，使用绝对路径，在任务接收时冻结摘要。
- `outputs`：必须存在并记录摘要的交付文件，相对工作区。
- `timeoutMs`：独立验收进程的超时。

验收程序最后一个非空 stdout 行必须是 JSON：

```json
{"checks":3,"passed":3,"failures":[]}
```

`checks` 必须为正整数；只有退出码 0、通过数量等于检查数量、失败列表为空，并通过文件完整性检查才算通过。验收失败应返回已执行的报告、具体失败信息和非零退出码。无法启动、超时或报告格式无效归为 `verification_unavailable`，任务停为 `blocked`。这个协议验证验收程序确实返回了有效报告，验收规则的可信程度仍由宿主持有的脚本决定。

E2E 的订单合同明确固定 CSV 表头 `order_id,sku,quantity,unit_price`，以及公开函数与 JSON 格式；验证带引号 SKU、转义引号、中文、CRLF、非法数量 / 单价、整数分折扣和真实 CLI 导出。验收脚本在工作区外，输入数据与 AGENTS.md 同样受摘要保护。目录位置不等于操作系统隔离。

## 3. 运行方式

创建符合 `TaskDefinition` 的 JSON 文件后运行：

```powershell
pnpm dev task start --spec D:/path/to/task.json --data-dir .codeagent/task-state --json
pnpm dev task status <task-id> --data-dir .codeagent/task-state
```

`task start` 支持 `--max-turns`，它限制每个 Run 的模型轮次。最终退出码由 Task 状态决定：`succeeded` 为 0，当前进程取消为 130，其余未完成状态为 1。`task status` 只读已提交日志，不要求模型密钥，也不执行模型或工具。

任务模式 `--data-dir` 表示状态根目录，其下有 `tasks/` 和 `sessions/`；原聊天模式的 `--data-dir` 仍表示会话目录。默认任务根目录是本应用的 `.codeagent`。

SDK：

```typescript
import { createTaskController, type TaskDefinition } from "./src/index.js";

const controller = await createTaskController({
  spec: taskDefinition satisfies TaskDefinition,
  dataDirectory: "D:/agent-state",
});
controller.subscribe(event => console.log(event));
try {
  const result = await controller.start();
  console.log(result.status, result.finalEvidenceIds);
} finally {
  await controller.close();
}
```

`testHooks.beforeVerification` 仅为 E2E 故障屏障，不注册为模型工具。普通业务入口不需要它。任务入口当前需要编码与进程能力，提供 `--readonly / --no-shell` 会直接拒绝创建，避免验收绕过权限。

## 4. 持久化与控制边界

`tasks/<id>/events.jsonl` 是权威事实，`snapshot.json` 是关闭时保存的可重建缓存。验收附件先落盘并同步，随后提交引用；只有日志中已引用的证据参与成功判定。任务定义、验收清单摘要和公开模型配置一起保存，API Key 不进入任务状态、事件或报告。

第一阶段支持 `limits.maxRuns` 与 `limits.maxRepairs`，以及现有每个 Run 的 `maxTurns`。这些边界使验收失败不能无限启动新的 Run；它们尚不等于设计中的全局模型请求 / token / 活动时间 BudgetGuard。

当前取消通过活动 SDK 的 AbortSignal 或 CLI 的 Ctrl+C 触发，关闭模型与子进程后写入取消结果；**尚未实现跨进程 `task cancel / pause / resume`、持久 commands inbox、安全锁接管、需求版本更新、未知副作用查询、上下文压缩和无进展检测**。创建过程不会接管或替换已有任务。强制退出后，可读取状态及证据，但本阶段没有自动续跑入口。文件工具保持原有边界，shell 和验收进程仍以主机权限运行。

## 5. 参考取舍与验证记录

按 [设计稿固定的源码版本](../long-tasks.md#12-固定参考来源) 再次核对 pi-durable 的提交边界、DeepSeek 的日志派生方式，以及 Hermes 的目标合同与 quality gate。第一阶段采用普通 TypeScript 控制器和 JSONL 事实，不引入额外调度 / 插件框架；独立程序证据决定代码任务是否完成。

第一次真实执行保留在 `.codeagent/e2e/run-OGKOCn/`：LT-01 / LT-02 均未通过，因为固定的 4096 输出 token 被模型推理耗尽，未产生可执行代码。已将上限改为 `MIMO_MAX_OUTPUT_TOKENS`，默认 8192，并在适配器校验模型目录允许的上限；同时把 CSV 表头合同写明确。截断响应仍停止执行，不据此伪报任务成功。

第二次执行的 LT-01 已通过，保存在 `.codeagent/e2e/run-1c0qc4/`。LT-02 捕获回归并启动了修复，但模型尝试读取工作区外的证据后反复猜测参数，响应再次截断。已调整 Harness 反馈：提供实际复现命令和失败条件，说明历史通过只代表旧快照，并要求重新检查当前依赖；证据路径继续对宿主保留，不当成文件工具的读取目标。验收规则保持不变。

最终验证：`pnpm check`、`pnpm build` 和 `pnpm test` 的 **29 个单元测试**均通过。真实 E2E 结果分两次命令执行保存，不能视为同一次完整套件运行：

| 实际执行 | 结果 | 报告 |
| --- | --- | --- |
| `pnpm test:e2e` 中的原有 4 个用例 | 购物车修复、跨进程会话、只读审查、轮次额度均通过；同次 LT-02 失败记录保留 | 原有 4 项报告（历史产物未随仓库提供：`../.codeagent/e2e/run-37Bcj4/report.json`）；当次长任务报告（历史产物未随仓库提供：`../.codeagent/e2e/run-1c0qc4/report.json`） |
| `pnpm exec tsx --test --test-concurrency=1 tests/e2e/long-tasks.test.ts` | 修复反馈后 LT-01 / LT-02 均通过，实际耗时约 323 / 486 秒 | 长任务最终报告（历史产物未随仓库提供：`../.codeagent/e2e/run-Y0rHwn/report.json`） |

长任务实际使用 `mimo-v2.6-flash`、中国区 Token Plan 地址、`thinking=low`、每个 Run 最多 10 轮、每次响应最多 8192 输出 token；任务最多 12 个 Run、4 次修复。配置及实际证据写在各用例的 `task-state.json` 和任务日志中。

- **LT-01**：任务 `0ef459a5-5bda-4b41-a24f-def6ada73c0c`，3 个 Run、0 次修复，M1 / M2 / M3 均通过。M1 曾到达局部轮次上限，但独立验收通过，控制器继续后续阶段，最终完成任务。见 任务状态（历史产物未随仓库提供：`../.codeagent/e2e/run-Y0rHwn/LT-01-order-delivery/task-state.json`） 和 实际 JSON 产物（历史产物未随仓库提供：`../.codeagent/e2e/run-Y0rHwn/LT-01-order-delivery/workspace/out/summary.json`）。
- **LT-02**：任务 `5ec936f3-1fca-4248-9b50-aa2f6b6f785e`，4 个 Run、1 次修复。在 M3 模型自然完成后，把计算模块替换成不计算折扣的错误实现；日志 seq 21 记录 CLI 验收失败，seq 24 启动真实修复 Run，seq 40 才提交任务成功。见 故障记录（历史产物未随仓库提供：`../.codeagent/e2e/run-Y0rHwn/LT-02-verification-repair/fault.json`）、任务事件（历史产物未随仓库提供：`../.codeagent/e2e/run-Y0rHwn/LT-02-verification-repair/task.events.jsonl`） 和 最终任务状态（历史产物未随仓库提供：`../.codeagent/e2e/run-Y0rHwn/LT-02-verification-repair/task-state.json`）。

两个用例的最终证据均为 parse **2/2**、calculate **1/1**、cli **2/2**，且各自绑定同一份最终源码与输入指纹；测试宿主随后再次独立运行 CLI 验收，结果均为 **2/2**。实际产物中 A 的小计 / 折扣 / 合计为 `4980 / 498 / 4482`，B 为 `30 / 3 / 27`。可信验收脚本保持原样。本次最终长任务产物及 docs 的 54 个文本文件检查未发现配置密钥。

以上验证覆盖第一阶段任务与验收闭环。LT-03 至 LT-09 保持待实现 / 待执行，不能据此宣称跨进程长任务恢复、上下文压缩或全局模型预算已经可用。
