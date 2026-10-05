# E2E 用例总结

维护日期：2026-10-05 UTC。源码基线：`eca2d5c` 加本工作区优化改动。本文解释当前每个 E2E 的实际任务、执行步骤、关键验收和证明范围；新增用例时应同步维护。

返回 [docs 索引](../README.md)。每个详解中的“设计依据与合理性”指向 [已落地设计](../implemented/design-evidence.md)，设计反向引用具体用例。[待办验收规格](pending.md)单独维护：完成验收从待办迁出后纳入下表；状态见 [待落地清单](../pending/README.md)。

完整任务规格见 [扩展能力](capabilities.md)与 [六模块工程](engineering.md)。历史规格保留在 [初版 CLI](history/cli.md)、[订单长任务](history/long-tasks.md)、[恢复与控制](history/recovery.md)、[故障补强](history/hardening.md)，其日期范围不替代当前结果。

## 阅读入口

| 详细文档 | 覆盖范围 | 用例数 |
| --- | --- | ---: |
| [普通 CLI 与订单交付](cli-delivery.md) | 购物车修复、会话恢复、只读、轮次预算、LT-01、LT-02；包含验收者和阶段 context 的说明 | 6 |
| [恢复、控制与需求更新](recovery-control.md) | 五个崩溃边界、回执恢复、HTTP 服务、暂停取消、竞争、订单更新和 Linux-only 来源拒绝 | 14 |
| [故障、存储与补强](fault-hardening.md) | 文件摘要不符、验收不可用、日志写入失败、后端缺失、旧日志与迁移、HT-01 / HT-02 / HT-03 | 9 |
| [请求预算与 Linux 执行](budget-linux.md) | 5 个预算暂停/更新/崩溃/交付变体和 4 个 Linux 锁、进程、身份及启动门禁用例 | 9 |
| [新增长任务与集成](advanced.md) | 摘要/inbox、工程/进展/预算、后台、规划/DAG、资源/MCP/记忆、RPC/Web、容器及并行 | 24 |
| [历史检索与可信快照](history-snapshot.md) | 摘要遗漏后的隔离检索、来源拒绝、快照绑定/回退、真实续交付和失败 writer 关闭 | 4 |
| 合计 | 按当前注册的测试展开参数化变体 | 66 |

每个详细条目使用相同结构：**设计依据与合理性 → 初始任务 → 执行步骤 → 实际检查 → 证明范围与边界**。注册测试名用于定位代码；LT / HT 编号用于对应已有规格。一个测试可能覆盖多个规格编号，一个规格编号也可能由多个测试覆盖。

当前 66 个注册名的回归和重跑见 [当前记录](../implemented/current.md)，本轮 73 项契约通过，新增四项实际验收见 [历史检索与快照](history-snapshot.md)。此前 Linux-only 的 62/62、66/66 见 [迁移验收](linux-only.md)和 [迁移方案](../implemented/linux-only.md)；失败历史继续保留。分组结果不代表同一次串行全套运行，也不代表任意长任务必然完成。

## 为什么有 66 个

数量主要来自中断和故障边界。写入前退出、写入后但结果未保存时退出、验收附件写好但通过事实未提交时退出，需要不同的恢复规则。正常交付通过，不能直接替代这些边界的验证。

| 测试文件 | 展开后的数量 | 主要问题 | 详细说明 |
| --- | ---: | --- | --- |
| [cli.test.ts](../../tests/e2e/cli.test.ts) | 4 | 普通 CLI 的修复、历史、权限与轮次限制 | [CLI 与交付](cli-delivery.md) |
| [long-tasks.test.ts](../../tests/e2e/long-tasks.test.ts) | 2 | 多阶段交付与验收失败后实际修复 | [CLI 与交付](cli-delivery.md) |
| [task-recovery.test.ts](../../tests/e2e/task-recovery.test.ts) | 12 | 恢复、控制、并发和第二种工程结构 | [恢复与控制](recovery-control.md) |
| [task-update.test.ts](../../tests/e2e/task-update.test.ts) | 1 | 订单工程暂停后切换新版合同 | [恢复与控制](recovery-control.md) |
| [platform.test.ts](../../tests/e2e/platform.test.ts) | 1 | Linux 大小写工作区身份与旧 Windows 进程记录拒绝 | [恢复与控制](recovery-control.md) |
| [task-faults.test.ts](../../tests/e2e/task-faults.test.ts) | 5 | 文件、验收、持久化和后端错误 | [故障与补强](fault-hardening.md) |
| [storage-compat.test.ts](../../tests/e2e/storage-compat.test.ts) | 1 | 尾部修复、损坏拒绝、旧格式和原子迁移 | [故障与补强](fault-hardening.md) |
| [task-hardening.test.ts](../../tests/e2e/task-hardening.test.ts) | 3 | 成功前文件变化、文件缺失、回执缺失 | [故障与补强](fault-hardening.md) |
| [request-budget.test.ts](../../tests/e2e/request-budget.test.ts) | 5 | 请求预留、暂停更新、三个中断边界、最后获准工具批次 | [预算与 Linux](budget-linux.md) |
| [linux-platform.test.ts](../../tests/e2e/linux-platform.test.ts) | 4 | flock、父子进程、bridge 崩溃身份恢复、日志失败启动门禁 | [预算与 Linux](budget-linux.md) |
| [advanced-context-input.test.ts](../../tests/e2e/advanced-context-input.test.ts) | 5 | 新增能力与公开入口 | [新增详解](advanced.md) |
| [advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts) | 9 | 新增能力与公开入口 | [新增详解](advanced.md) |
| [advanced-long-tasks.test.ts](../../tests/e2e/advanced-long-tasks.test.ts) | 7 | 新增能力与公开入口 | [新增详解](advanced.md) |
| [engineering-stability.test.ts](../../tests/e2e/engineering-stability.test.ts) | 1 | 新增能力与公开入口 | [新增详解](advanced.md) |
| [rpc-web.test.ts](../../tests/e2e/rpc-web.test.ts) | 2 | 新增能力与公开入口 | [新增详解](advanced.md) |
| [history-snapshot.test.ts](../../tests/e2e/history-snapshot.test.ts) | 4 | 压缩后受控找回、附件门禁、快照语义与实际续交付 | [历史检索与快照](history-snapshot.md) |

计数约定：

- `task-recovery.test.ts` 的五个崩溃边界分别计数，活动工具的 pause / cancel 也分别计数。
- `task-faults.test.ts` 的 task / session 日志写入失败分别计数；补强中的文件 / 回执缺失分别计数。
- `storage-compat.test.ts` 内含多种顺序执行的变体，但只注册一个测试，计为 1。
- 购物车工作区中的三个业务测试由 Agent 和宿主调用，不属于主套件额外注册的 E2E。
- 66 是注册场景数，不表示 62 种独立能力，也不表示每个场景都发出模型请求。持久化和后端失败用例专门要求请求数为零；平台用例不需要模型。当前全部用例仅在 Linux 执行，平台跳过条件已移除；门禁用例要求零模型请求，不能把注册数当模型调用数。

## 谁验收，什么算成功

E2E 测试宿主创建工作区和验收合同。订单、报价与小接口任务的验收脚本由宿主提前提供，通过 `TaskDefinition.verifiers` 配置。任务控制器调用真实验收进程，读取 `checks / passed / failures` 报告及退出码，记录证据，失败时给模型提供诊断。

普通 CLI 的 `completed` 表示当前 Agent 执行片段自然结束。持久任务的 `succeeded` 还需要当前合同的最终验收证据。两者不是相同的成功标准。部分 E2E 还在控制器结束后独立执行程序、检查文件或实际副作用，避免只依赖状态声明。

任务验收器实现见 [verifier.ts](../../src/harness/verifier.ts)，详细角色、上下文与 LT-01 / LT-02 的区别见 [交付用例](cli-delivery.md)。验收脚本放在工作区外、检查可信文件摘要，属于职责和完整性约束；shell 使用宿主权限，目录布局不构成操作系统隔离。

## 当前证明范围

历史检索新增当前会话来源绑定的原文/附件入口，快照新增完整验链下的前缀重建加速；它们由专门交付与拒绝例验证，不用摘要保留或缓存删除恢复替代。

现有用例集中证明：宿主预定义阶段下的真实交付、验收失败修复、有限场景的副作用核查、跨进程恢复、持久控制、合同更新及协作执行者互斥。新增用例还证明全任务请求次数预算的提交边界，以及 Linux 托管进程的恢复与拒绝边界。

订单用例覆盖三阶段 CLI；报价用例覆盖真实 HTTP 与重启；许多故障用例仅要求 `value()` 返回 42，用小任务稳定触发协议边界。小任务的恢复通过，不能直接推导大型工程完成能力。

上下文缩减、真实摘要提交前后恢复、无进展正反用例、六模块基线、完成门禁、持久 inbox、重试和累计资源预算已经实现并有针对性真实验证。规划只从宿主可信验收器草拟合同；DAG、后台、资源/MCP、显式记忆、会话分支、RPC/Web 与容器入口已实现。复杂工程联合用例与三 seed 的最终状态逐项保存在 [当前落地记录](../implemented/current.md)，不得把首次失败隐藏或将注册数当通过数。任意副作用自动恢复、跨操作系统活跃进程迁移与任意项目稳定完成率仍不作保证。

## 执行条件与历史结果

完整入口为 `pnpm test:e2e`，先构建再串行执行 `tests/e2e/*.test.ts`。模型相关路径使用真实 MiMo；故障钩子控制真实文件、进程和提交边界，不伪造模型成功回复。

持久任务使用 Linux 唯一 ExecutionHost，需要 Python 3、Bash、flock、subreaper 和 `/proc`。`platform.test.ts` 的 Windows 专属例已替换为 LX-06，全部平台测试在 Linux 执行。完整 29 个原有用例的历史验证平台为 Windows / 本地文件系统。

[补强实现记录](../implemented/history/hardening.md)记载一次完整套件 **29 / 29 通过，0 失败 / 取消 / 跳过**；[第二阶段实现记录](../implemented/history/recovery.md)记载此前 26 个用例的分组验收。前者是历史单次结果，后者是历史分组结果，均不能代替多次运行稳定性数据。

先前批次 A 云端分组覆盖 38 个注册场景：35 passed、1 failed（LT-01 超时）、1 cancelled（LT-02 超时）、1 skipped（Windows 专属）；新增预算/Linux 的 9 个全部通过。不是同次全套通过。精确批次、失败修正与报告见 [优化实施记录](../implemented/history/optimization-a.md)。历史 Windows 报告未随 Git 克隆包含，不能将其标记为本次实测。实际运行报告、工作区及日志保存在被 Git 忽略的 `.codeagent/e2e/run-*`；本次平台证据保存在 `.codeagent/e2e/linux-platform-*`，历史 Windows 路径为 `.codeagent/platform-*`。

当前 66 个注册名可执行 `node --import tsx scripts/e2e-inventory.ts` 静态展开；它只核对用例清单，不执行模型或代替验收。新增 24 个的全部步骤与关键断言见 [新增详解](advanced.md)，当前分组实测和失败重跑见 [落地记录](../implemented/current.md)。

## 维护约定

新增或修改测试时，同步更新对应详细条目的任务、故障时机、实际断言与证明边界；参数化变体发生变化时，更新上面的文件计数和合计。避免仅根据测试名称或规格目标扩大已验证能力。

同步更新用例的设计链接及设计页的反向引用，说明选择为何适合该问题。待办只有达到 [完成及迁移规则](../README.md#待办完成后立即迁移)才能移入已落地区；用例留在本区，原失败证据保留。

真实模型请求数、Run 数和工具启动数分别记录；未直接观测请求数的用例不把 Run 数保持写成“请求数为零”的独立证据。需求版本、最终证据和源码状态分别说明，不能用历史通过状态代替当前验收。

新的通过结果应在相应实现记录中保留日期、平台、模型公开配置、原始报告路径以及 failed / skipped / not_run。规格、测试存在、实际执行结果和统计稳定性分开维护。涉及新能力时，继续遵循 [AGENTS.md](../../AGENTS.md) 的 E2E-first 要求。

本轮初始 65 场景分组为 64 passed / 1 failed（旧格式夹具）；修正后该例重跑通过，再新增 SS-02 验收通过，最终 66 个注册名均有通过证据。全组、定向重跑、源码与配置分别保存，不能把原失败改成首次全通过。
