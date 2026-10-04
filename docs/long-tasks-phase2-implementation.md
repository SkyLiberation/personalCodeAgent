# 长任务第二阶段实现与验证记录

日期：2026-10-04。状态：**已实现并完成分组验收**。36 个关键契约测试和 26 个 E2E 用例通过。验收依据为 [E2E 规格](long-tasks-phase2-e2e.md)，设计依据为 [第二阶段方案](long-tasks-phase2.md)。通过记录只证明下列实际执行的能力。

## 1. 已提供的入口

```powershell
pnpm dev task start --spec task.json --data-dir D:\agent-state --json
pnpm dev task pause <task-id> --command-id pause-001 --data-dir D:\agent-state --wait
pnpm dev task update <task-id> --spec task-v2.json --expected-version 1 --command-id update-001 --data-dir D:\agent-state --wait
pnpm dev task resume <task-id> --data-dir D:\agent-state --json
pnpm dev task cancel <task-id> --command-id cancel-001 --data-dir D:\agent-state --wait
pnpm dev task command-status <task-id> <command-id> --data-dir D:\agent-state
pnpm dev task status <task-id> --data-dir D:\agent-state
```

`status`、控制投递、控制查询和无活动执行者时的控制处理不需要模型密钥，不启动模型。`--wait-timeout-ms` 默认 30000；超时只报告当前收据，不撤回命令。相同 command ID / 内容返回既有结果；内容冲突拒绝，update 另外检查合同版本。已经 succeeded / cancelled / failed 的任务不重新执行，耗尽任务不能通过恢复刷新额度。

```typescript
import { openTaskController, sendTaskCommand } from "../src/index.js";

await sendTaskCommand({
  taskId, dataDirectory,
  command: { id: "pause-001", type: "pause" },
});
const controller = await openTaskController({ taskId, dataDirectory, config, services });
try {
  const result = await controller.resume();
} finally {
  await controller.close();
}
```

open 获取执行权并检查配置，恢复由 resume 显式启动。密钥使用当前进程配置，历史状态只保存公开模型参数。宿主自定义工具需要再次注册相同版本；其结果查询通过 `services.recovery` 注入，不能由模型自行声明原副作用是否发生。

## 2. 模块与关键行为

| 模块 | 已实现行为 |
| --- | --- |
| [任务控制器](../src/harness/task-controller.ts) | 显式恢复、累积额度、当前工作区重验、持久控制准入、全合同更新、成功提交门禁 |
| [任务存储](../src/storage/task.ts) / [日志](../src/storage/journal.ts) | schema 2、顺序与前序摘要校验、fsync、事实折叠；snapshot 不作为权威依据；只备份并修复明确的不完整尾部 |
| [会话存储](../src/storage/session.ts) | input ID + 内容摘要去重；工具 intent 绑定 operation / assistant entry / run / call / 工具版本 |
| [旧格式迁移](../src/storage/migration.ts) | 仅迁移有充分未启动证据的 v1 空任务；双日志同步、源文件摘要、代际与映射、单 manifest 发布；孤立代际不生效 |
| [工具恢复](../src/harness/recovery.ts) | 未启动、已提交、匹配回执、当前文件后置条件、当前只读查询、未知效果阻塞；恢复事实先于补交协议结果 |
| [命令存储](../src/storage/task-commands.ts) | 临时文件同步、硬链接无覆盖发布、序号和内容摘要；投递与 applied 区分；命令发布与成功共用短锁 |
| [Windows 后端](../src/platform/windows.ts) / [桥接源代码](../src/platform/windows-host.cs) | LockFileEx 执行权、Job Object、挂起创建后纳管再恢复；具名进程组记录与恢复前静止核查 |
| [环境](../src/environment/local.ts) / [验收器](../src/harness/verifier.ts) | 原子文件写入、可写范围校验、托管 shell / 验收进程、实际报告和输入 / 产物摘要 |

恢复顺序为执行权 → 旧进程组静止 → 控制与输入 / Run 对账 → 工具结果核查 → 当前合同验收 → 必要的新模型 Run。未知 shell / 自定义写操作不会因一条中断提示而继续执行。仅凭现有文件的摘要只能证明明确单文件工具的当前后置条件，不能据此推断任意命令的全部效果。

新 Run 的稳定 ID 和输入在模型请求前提交。task 与 session 之间不使用跨文件事务；恢复按 input ID 对账，已预留 Run 不退回。模型 API 错误进入可显式恢复的 blocked；必要持久化失败则停止动作并报告未提交，不能伪造已保存的停止事实。

pause 接收后允许当前完整工具批次结算，下一模型请求之前应用。cancel 接收同步后触发取消，等待托管进程组停止再给出 applied。inactive pause 若遇到未确认效果也必须先核查，不能只改状态文件声称安全暂停。文件 / 外部效果不会随取消回滚。

`scope.writablePaths` 来自合同，write / edit 检查规范化路径。兼容第一阶段未声明范围的合同采用整个工作区并记录 `scopeSource=legacy_workspace`，不会从自然语言猜测范围；新合同应显式声明。shell 仍使用主机权限，范围声明与 Job Object 均不构成沙箱。

## 3. 平台实现与设计调整

方案最初拟采用 N-API C++ 桥。本机没有 C++ 工具链，具备 Windows .NET Framework C# 编译器，因此改为 TypeScript 管理的私有 C# 桥接进程，通过 P/Invoke 调用同一组 Win32 API。

桥持有不可继承的内核锁 / Job 控制句柄。工具采用 CreateProcess suspended → AssignProcessToJobObject → ResumeThread；桥的 stdin 关闭时先停止所有 Job，再释放锁，桥异常退出由 `KILL_ON_JOB_CLOSE` 收尾。具名进程组在启动前记录并同步，恢复取得执行权后查询旧组并等待 active=0。没有按锁年龄、裸 PID 或删除锁文件夺权的降级路径。

桥代码按内容摘要编译到系统临时目录 `personal-code-agent-platform/<sha256>/host.exe`，源码随本工程保留。编译器、桥和工具子进程环境均不继承 MiMo 密钥。首批实际验证平台是本机 Windows / 本地文件系统；其他平台缺少后端时拒绝任务执行，普通聊天入口原有行为保持。

此实现覆盖前台协作进程生命周期。外部服务、脱离普通继承的调度、远程副作用仍要查询回执，否则作为未知效果处理。没有承诺主机文件 / 网络隔离、断电恢复或网络文件系统语义。

## 4. 实际验收

先编写平台和恢复 E2E，观察缺少接口导致失败，再实现。所有模型任务使用真实 `mimo-v2.6-flash`；故障在 IPC 屏障发生，未伪造模型响应。用例检查工作区文件、实际父子进程、审计标记、真实 HTTP 与独立验收。

| 能力 | 当前验证 |
| --- | --- |
| LT-04A/B 回执恢复与未知阻塞 | passed，审计登记始终只有一次 |
| LT-04C 三个输入 / 结算提交点强退 | passed，输入去重、原身份与预留 Run 保留 |
| LT-04D 孤立验收附件 | passed，恢复重新验收，孤立附件不授权成功 |
| LT-04F 默认 write 完成后强退及摘要不匹配 | passed，观察后置条件；摘要不符先阻塞 |
| LT-07B / LT-10 报价服务 | passed，暂停后宿主改坏 lib，跨进程修复，真实 HTTP / 非法输入 / 重启通过 |
| LT-08A/B 活动父子进程 | passed，pause 先待批次结束，cancel 停进程组，重启取消任务不续跑 |
| LT-08B/C 平台与执行权 | passed，强退清理真实父子进程、过期元数据不夺权、两个恢复进程只准入一个、同工作区不同状态目录互斥 |
| LT-08D 更新 / 取消与成功竞争 | passed，先发布的控制先处理，成功后投递可查询地拒绝 |
| LT-09 验收不可用 / 真实日志写入失败 | passed，缺失验收 blocked；闭合句柄导致写失败，无后续模型请求，不虚报 durable stop |
| LT-04E 兼容与故障矩阵 | passed，真实 CLI 验证尾部备份修复、缓存缺失、中间损坏、未来 schema、旧日志保留；迁移发布前强退不采用孤立代际 |
| LT-07A 订单 2000 bps 更新 | passed，M2 后暂停、CLI 更新 / 去重 / CAS、跨进程交付 v2；A 4980/996/3984，B 30/6/24 |
| 原有 4 个 CLI / LT-01 / LT-02 | 6 / 6 回归通过 |

汇总证据保存于 `.codeagent/phase2-validation-report.json`，记录分组运行、26 个通过用例的原始报告路径和密钥审计。主要报告如下：

| 报告 | 通过记录 |
| --- | --- |
| `.codeagent/e2e/run-scysNq/report.json` | 11 个恢复 / 控制 / 报价服务用例；505.9 秒 |
| `.codeagent/e2e/run-qIDSOp/report.json` | 订单需求更新；373.2 秒 |
| `.codeagent/e2e/run-ENCNCc/report.json` | 旧格式 / 损坏 / 原子迁移 CLI；43.8 秒 |
| `.codeagent/e2e/run-rcxj3Z/report.json` | 摘要不匹配、验收缺失及初始持久失败验证；新版区分 task / session 故障另见下行 |
| `.codeagent/e2e/run-2oh2v5/report.json` | task / session 两种真实写入句柄故障；两个用例无模型请求 |
| `.codeagent/e2e/run-NBypnT/report.json` | 后端编译器缺失，拒绝执行且不降级 |
| `.codeagent/e2e/run-AW7aAk/report.json` | 实际最终验收通过后发布 cancel，成功被阻止；23.5 秒 |
| `.codeagent/e2e/run-TbHoAz/report.json` | 原有 4 个 CLI 回归 |
| `.codeagent/e2e/run-Ad2F43/report.json` | LT-01 508.4 秒；LT-02 445.2 秒，实际失败验收后模型修复 |
| `.codeagent/platform-cqvnQq/evidence.json` | 内核锁和强退后的真实父子进程清理 |

这是分组执行得到的 26 个不同用例通过记录，没有宣称在一次 `pnpm test:e2e` 中全部完成。模型错误、错误验收夹具、构建中的测试驱动错误和中断运行均保留原报告。修复后只重跑相关组；通过依据来自实际产物与程序验收。可运行 `scripts/phase2-report.ts` 重新汇总并扫描产物中的配置密钥。

## 5. 保守兼容与待完成边界

schema 1 的已结束历史仍可读取。有完整未启动证据的空任务可以迁移：pending、runs / repairs 均为零、任务仅有创建事实、会话仅有完整 v1 头，并且不存在旧所有者锁。迁移将两个新日志同步后原子发布 manifest，记录源文件 SHA-256、代际与事件映射，原文件不变。manifest 发布前强退留下的候选代际被忽略。

已经执行或遗留所有者身份不明的 v1 任务返回 `migration_handoff_ambiguous`，保留原日志。旧格式缺少稳定输入关联、工具版本和旧进程组身份，不以相似文本、锁年龄或裸 PID 构造证据。**当前未提供有执行历史的 v1 自动迁移**，安全续接仍需充分的旧执行证据。

尾部修复、摘要损坏拒绝、未来格式拒绝、旧格式保留、输入内容冲突、同工作区竞争、后端缺失与合同 CAS 已有实际验证。迁移仅覆盖上述可证明安全的空任务，不能据此扩大为任意旧任务续接或断电恢复。

本阶段仍未实现 LT-03 上下文投影 / 压缩、LT-05 全局 token / 时间账本、LT-06 无进展重规划、完整 LT-09 故障矩阵、任意 DAG 或模型自主阶段规划。参考 pi、DeepSeek Harness、Hermes 的固定版本及取舍见 [设计来源](long-tasks-phase2.md#9-参考来源与取舍)；Windows 桥、恢复证据及控制提交协议属于本工程实现。
