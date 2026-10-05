# 长任务优化实施记录

> 当前执行平台已统一 Linux，Windows 兼容层已移除；本页保留原阶段平台与验收事实。当前验收见 [Linux-only](../../e2e/linux-only.md)。


> 本文件保留批次 A 的 47 个契约与 35 passed / 1 failed / 1 cancelled / 1 skipped 原始记录。B/C/D/E 及扩展能力已继续实施；当前源码、完整使用入口和后续实测见 [当前落地记录](../current.md) 与 [逐用例说明](../../e2e/advanced.md)。下面的 planned 和“尚未实现”均指批次 A 当时，不能当作当前状态。

设计见 [优化方案](../optimization.md)，复杂工程验收见 [第三阶段 E2E 规格](../../e2e/engineering.md)。

## 批次 A 当时的进度

优化设计已完成，批次 A 已落地：Linux 执行后端和全任务模型请求账本。验证已结束：47 个关键契约通过，38 个注册 E2E 按组记录为 35 passed、1 failed（LT-01 超时）、1 cancelled（LT-02 超时）、1 skipped（Windows 专属）。以下为 2026-10-05 UTC 云端 Linux 的实际运行，不引用历史 Windows 报告代替本次结果。

| 内容 | 状态 |
| --- | --- |
| ExecutionHost/Linux 执行锁与进程恢复 | implemented；4 个真实进程用例通过 |
| 全任务模型请求账本 | implemented；5 个预算场景通过，其中 4 个发真实模型请求 |
| 原有持久任务回归 | 22 个恢复/故障/更新用例通过；LT-01/02 超时，详见结果 |
| LT-11 复杂工程基线 | planned |
| LT-12 已满足验收时的结束策略 | planned；由本次 LT-01 超时观察补入规格 |
| LT-03 上下文投影 | planned |
| LT-06 无进展控制 | planned |
| 持久 inbox、有限重试 | planned |
| LX-05 跨内核/容器身份来源门禁 | planned；当前 Linux 只验收同一执行环境 |

## 已落地设计与源码

统一后端见 [host.ts](../../../src/platform/host.ts)、[linux.ts](../../../src/platform/linux.ts) 和 [Linux bridge](../../../src/platform/linux-host.py)。环境、会话、任务存储、控制锁、迁移和验收均使用 ExecutionHost。Windows C# bridge 保留原实现；Linux 使用标准库 flock，目标进程等待启动门闩，Node 提交 PID/starttime 校验链后才能执行。Node 宿主退出先清理托管组；bridge 意外死亡后由后继在执行前核查旧组，身份不明拒绝恢复。

请求账本见 [request-budget.ts](../../../src/model/request-budget.ts)、[任务合同](../../../src/task-contracts.ts)、[任务事实存储](../../../src/storage/task.ts) 和 [控制器](../../../src/harness/task-controller.ts)。所有持久任务请求先预留再分派，结算提交前不允许响应工具执行。预留记录不退还；缺少 usage 或结算的请求明确保留未知用量。账本位于任务 `events.jsonl`，`task status` 和 SDK `state.modelRequests` 可查询。

E2E 报告补强见 [helpers.ts](../../../tests/e2e/helpers.ts) 与 [报告契约](../../../tests/e2e-report.test.ts)：Node 超时可能在异步场景 finally 之前结束测试，现在 after hook 会将未结算场景记录为失败，晚完成回调不能将取消结果改写为通过。

任务 JSON 可在原 limits 中加入：

```json
"limits": { "maxRuns": 12, "maxRepairs": 4, "maxModelRequests": 40 }
```

`maxModelRequests` 是正整数，缺省不设累计请求上限；`maxTurns` 仍限制单个 run。需求更新不能修改 limits，也不会清空账本。最后一个获准响应的完整工具批次可以完成并接受独立验收；总额耗尽后只恢复核查和复验已有文件，不再启动请求或响应工具。

普通执行、summary/replan/retry purpose 在同一准入类下共享额度，关键契约已覆盖。但摘要、重规划与自动重试实际功能未实现，不能把 purpose 测试当成它们已联调。

内置 PiModelGateway 的内部重试为 0；自定义 gateway 必须遵守一次 stream 对应一次供应商尝试，不能在账本之外偷偷重试。否则限额只约束 gateway 调用数。本次真实 MiMo 审计使用内置单次分派路径。

## 实际验证与诊断产物

公开模型配置：`mimo-v2.6-flash`，`https://token-plan-cn.xiaomimimo.com/v1`，thinking=`low`，pi-ai=`1.0.0`；密钥不写入报告。Node=`24.19.0`，Linux 本地文件系统；Python 3 bridge 可用。保留继承的 HTTP(S) 代理及 CA，使用 `NODE_USE_ENV_PROXY=1` 让 Node 24 通过云端代理访问模型。

| 检查 | 实际结果 | 产物/说明 |
| --- | --- | --- |
| TypeScript 检查与构建 | passed | `pnpm --config.verify-deps-before-run=false check/build`；该 flag 避免本环境 pnpm 11 自动重装依赖，不改变源码或关闭 TLS |
| 关键契约 | 47/47 passed | 原有 40 个、6 个预算契约、1 个真实子进程超时报告契约 |
| 新增 Linux/预算初次分组 | 8/8 passed | 3 个 Linux + 5 个预算；预算报告 `.codeagent/e2e/run-2B8ZPo/report.json` |
| 最终 Linux 四例 | 4/4 passed | `.codeagent/e2e/linux-platform-1AWqUG`、`linux-platform-rlu6Lm`、`linux-platform-xs9TjA`、`linux-platform-gaWdv2` 的 `evidence.json`；原批次继续保留 |
| 历史阶段回归修正后的真实预算组 | 5/5 passed | `.codeagent/e2e/run-oM0dDm/report.json`；仍分别保留原始 8 例批次 |
| 普通 CLI 原有四例 | 4/4 passed | `.codeagent/e2e/run-M0QDdi/report.json` |
| 当前注册与总结覆盖 | 38/38 一一对应 | 四份详解分别 6+14+9+9；静态注册核对，不执行测试回调 |
| 原有恢复与控制 | 12/12 passed | `.codeagent/e2e/run-LTakhu/report.json` |
| 原有存储兼容 | 1/1 passed | `.codeagent/e2e/run-e9oWUJ/report.json` |
| 原有故障 | 5/5 passed | `.codeagent/e2e/run-xT6cl4/report.json` |
| 原有补强 | 3/3 passed | `.codeagent/e2e/run-v7jUd7/report.json` |
| 原有订单需求更新 | 1/1 passed | `.codeagent/e2e/run-fO9pgx/report.json`，约 350 秒 |
| LT-01 | failed：550 秒超时 | 原失败及恢复诊断见下文 |
| LT-02 | cancelled：600 秒超时 | `.codeagent/optimization-regression-lt02.log`；本次未触发 M3 回归注入，不能宣称已验证修复 |
| Windows 专属执行权 | skipped：当前 Linux | 本次没有 Windows 实测 |
| 报告补强后的真实成功路径 | passed | `.codeagent/e2e/run-nXDRPs/report.json`，只重跑 LT-05C，未用它重写原 5 例批次 |

这是分组覆盖 38 个注册场景，35 个通过；不是完整套件同次通过。汇总在 `.codeagent/long-task-optimization-validation.json`，逐项保留实际报告、fail/cancel/skip 和后续计划。实际文件、会话事实、任务事实、请求审计与验收附件保存在上述场景目录；目录被 Git 忽略，克隆仓库不会自动取得这些报告。

执行中发现并修正的事项：

- 首轮真实模型预算组有 4 例因 `Connection error` 失败，1 个请求分派前中断变体通过。失败报告 `.codeagent/e2e/run-bWxoWD/report.json` 保留。启用环境代理后真实模型用例通过，未用模拟回复替换。
- 初版 bridge 崩溃测试假设存在 `/proc/<pid>/task/<pid>/children`，此云端内核没有该接口；改为读取标准 `/proc/<pid>/stat` 的父子关系后通过。保留失败场景目录 `linux-platform-jqKWZd`、`linux-platform-drUxjO`。
- 复查发现：请求预算耗尽后再遇到历史阶段回归，原路径可能将 reason 改为 max_repairs，使后续宿主修好文件也无法复验。先扩充必要契约复现失败，再将请求预算判定放在修复计数之前；保留预算专属状态，复验不消耗修复次数。
- Linux zombie 收割复查发现 Popen leader 若被通用 waitpid 抢先收割，可能将 SIGKILL 错报为 exitCode=0；改为让 Popen 自己收割 leader，补充超时必须非零退出的关键断言，并重跑四个真实 Linux 用例通过。
- 原有 LT-01 在 550 秒截止时 timeout。保留 `.codeagent/e2e/run-p6TB2u/LT-01-order-delivery/result.json` 的失败；随后同一任务恢复，三个最终合同均通过，模型请求仍为 18，见该目录 `timeout-recovery-diagnostic.json`。它证明恢复可复验实际交付，不能改写原测试为通过，也不能宣称新预算解决模型延迟。原长任务批次的 LT-02 未生成完整结果，另按组运行并记录。
- 单独重跑 LT-02 到 600 秒时被 Node 取消，尚未自然结束 M3，因此没有故障注入和修复验收。旧报告 `.codeagent/e2e/run-c97PfO/report.json` 仍显示 running，真实终态以 Node 日志和本次汇总为准。这个报告缺陷已用一个最小子进程契约复现并修复；旧文件不改写为新结果。
- 修改及新增的 11 份文档通过本地链接与围栏检查；38 个注册测试逐一有且仅有一个详细条目。历史文档中的被忽略报告仍不在此云端克隆中。
- 仓库全量文档链接检查遇到历史 Windows 的被忽略产物缺失，不能伪造这些文件让检查通过。本次新增/修改的文档链接与用例对应单独核对；历史报告缺失仍明确标记。

## 范围与后续

本次先完成批次 A。LT-11 六模块复杂工程、LT-03 持久摘要/投影、LT-06 无进展控制及持久 inbox/有限重试仍按 [优化方案](../optimization.md) 的 B/C/D/E 批次推进。

预算验收目前使用小接口隔离协议；不宣称复杂工程完成率、累计 token/时间/费用预算或模型自主阶段规划。Linux bridge 不隔离主动 setsid 逃逸的工具；普通会话仍是 v1 会话锁和内存队列。Linux 进程日志目前保存 PID/starttime，尚未持久绑定 bootId/PID namespace；恢复仅在同一执行环境范围验收，跨内核重启/容器移交不在支持范围，LX-05 来源门禁待实施。跨操作系统迁移活动任务与本次 Windows 后端运行也未验证。
