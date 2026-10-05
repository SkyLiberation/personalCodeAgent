# 长任务能力优化方案

本方案承接 [用例总结](../e2e/README.md) 和 [六模块 E2E 规格](../e2e/engineering.md)。目标是让复杂工程能在有限资源下持续推进，并让恢复、停止和交付都有独立证据。本文保留问题与取舍；当前设计与用例见 [双向索引](design-evidence.md)，实测见 [当前实现](current.md)，历史检索与快照加速见 [已落地索引](README.md)，[待落地清单](../pending/README.md)当前为空。[批次 A 记录](history/optimization-a.md)仅保留当时范围。

## 先明确要解决的问题

当前优势是持久任务合同、阶段及最终验收、输入对账、未知副作用阻塞、版本化控制命令和成功前证据复核。已有用例证明这些协议，但不能据此推断复杂工程的完成率。

| 优化前问题（本表各项已有实现） | 实际风险 | 改进与验收 |
| --- | --- | --- |
| 持久任务执行后端仅支持 Windows | 云端 Linux 无法运行恢复与长任务完整链路 | LX-01/02/03：内核执行锁、真实父子进程清理、恢复前旧组核查 |
| 只限制 run、repair、turn | 多阶段、恢复、摘要和重规划之间不能限制累计模型请求 | LT-05：请求分派前持久预留，全任务统一账本 |
| 完整历史每次发送 | 工具输出和多次修复不断增长，最终超窗 | LT-03：完整工具组的请求投影、持久摘要和容量门禁 |
| 重复失败只消耗 repairs | 编辑文件或模型说“改好了”被误当作进展 | LT-06：以可信验收进展为依据，有限调整后停止 |
| 用例多数只修单一数值或少量模块 | 协议成立并不代表可完成复杂任务 | LT-11：六模块依赖链、隐藏 seed 变体与实际 CLI |
| 普通 follow_up/steer 只在内存排队 | 请求确认后进程崩溃可能丢失新输入 | IN-01/02：持久 inbox 与接受/消费对账 |
| 模型错误均阻塞等待人工恢复 | 可恢复的限流或服务故障中断长任务 | RT-01/02：分类、有限退避、同一请求预算；不重放未知工具效果 |
| 阶段与验收需要宿主预定义 | 不能从任意业务目标直接自主形成可信交付合同 | GD-01：模型草拟、用户确认、宿主确定性验收；现已实现，见剩余能力记录 |

## E2E-first：实际任务与独立验收

LT-11/03/05/06 共用事件归档与查询 CLI，完整输入、六阶段、隐藏变体与产物见 [第三阶段规格](../e2e/engineering.md)。验收由宿主程序实际运行源码/CLI并检查 JSON 输出负责，模型只负责实施和修复。

先增加以下基础和边界用例，避免把恢复或预算设计成只有正常路径才能工作：

| 用例 | 操作与观测 | 证明什么及边界 |
| --- | --- | --- |
| LX-01 | 两个公开平台客户端争抢相同 lease；改旧元数据；崩溃第一客户端，再取得锁 | 执行权依赖 Linux flock，旧文件/时间戳不允许抢占；不证明网络文件系统语义 |
| LX-02 | SDK 启动真实 Node 父子进程，取消、超时、正常父进程退出及宿主 Node 硬退出；取得后继执行权后检查两个 PID | 托管进程组在释放正常所有权前清理；不涵盖主动 setsid 逃逸的恶意工具 |
| LX-03 | 进程准入先准备启动门闩，持久记录 PID/starttime 再释放；终止 bridge 后由新客户端核查/停止旧组；篡改身份拒绝恢复 | 进程身份可确认才终止，无法确认则 process_state_unknown，绝不根据旧 PID 盲杀 |
| LX-04 | 真实目标启动即写 marker，故意令进程日志 append 失败，检查 marker 不存在 | 未提交进程身份时目标不能开始；不等同断电可靠性测试 |
| LT-05A | 真实 MiMo 多轮修复任务给少量总请求额度；消费额度后暂停/跨进程恢复/更新合同 | 账本不清零、不会多发请求；耗尽仍可独立复验已有交付件 |
| LT-05B | 在模型请求准备分派、已返回但尚未结算两个边界中断，再恢复 | 已预留次数不返还；没有结算记录的 usage 明确 unknown；不假称供应商只计费一次 |
| LT-05C | 最后一个获准请求返回工具批次，批次执行完但业务未通过；恢复 | 完整获准工具组可完成，下一模型请求被拒绝，停止之后不能再启动新工具副作用 |
| LT-03B | 摘要生成后、摘要事实提交前中断；提交后恢复；保留区间含原生 assistant 和完整工具组 | 孤立摘要不能生效；已提交边界持续有效；原始事实不被改写 |
| LT-06B | 连续验收同一缺陷失败，策略调整后取消宿主破坏，再验收剩余阶段 | 只有可信验收通过才解除停滞；模型文字或文件变化不算进展 |
| IN-01/02 | SDK 接收 follow_up/steer 后跨进程退出，在 accepted/consumed 边界恢复 | 已确认输入不丢失，同一 inputId 内容冲突拒绝；不等同任意工具 exactly-once |
| RT-01/02 | 可控网关故障补充契约测试，真实模型继续实际工程；限流后成功与持续失败变体 | 重试有次数/时间边界、都消费请求预算；业务错误和未知工具效果不重试 |

本次 LT-01 实测超时、恢复后直接验收通过，还暴露了等待 run 自然结束才验收的延迟。补充并已实施 LT-12：合同允许“满足门禁即可结束”，真实模型修改工程后，在完整工具组提交边界运行独立验收；全部门禁通过后不再请求模型补写完成声明。负向变体保留未完成 CLI、失败检查和同批次尚未执行的交付登记，要求不得提前成功；pause/update/cancel 仍优先处理。验收观测实际 CLI、完整副作用、最后一个模型请求与通过事件之后零新分派。

LT-12 不以文件存在或模型文字作为完成条件。应先扩充可执行用例，再设计可选的验收完成策略；默认自然结束语义及 LT-02 的原证明条件不能悄悄改写。当前已实现可选 completionPolicy=verification；自然结束仍是缺省，正反验证见 [当前落地记录](current.md)。

真实模型路径保留任务事实、会话事实、请求编号、usage、验收附件及实际文件；不保留密钥。确定性故障注入只控制中断/失败边界，不替代真实模型输出。

## 参考实现和取舍

已阅读官方源码/文档，未运行参考项目。本工程使用的 `pi-ai` 仍为 1.0.0；下表的 Coding Agent / durable 能力不会因为引入 pi-ai 自动获得。

| 固定来源 | 确認到的机制 | 本工程采纳与取舍 |
| --- | --- | --- |
| [pi Coding Agent 1.0.2 compaction](https://github.com/earendil-works/pi/blob/b2b5c42f6138b73ec4b2f49ec0ca468800f88586/packages/coding-agent/docs/compaction.md)；提交 `b2b5c42f6138b73ec4b2f49ec0ca468800f88586` | 完成工具批次后投影；摘要+firstKeptEntryId；原始历史保留；有限 overflow/length 恢复 | 采纳历史/请求分离、工具组成组和提交边界；不搬入整个会话分支框架 |
| [pi-durable](https://github.com/earendil-works/pi/blob/b2b5c42f6138b73ec4b2f49ec0ca468800f88586/packages/durable/README.md)，同提交，实验包 | 执行前提交、稳定 requestId、持久 inbox、摘要与用量记录 | 沿用现有事实存储；增加请求准入账本。用量统计不等于硬额度，需单独实现预留 |
| [DeepSeek Harness Session](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/core/session/README.md)，0.2.1-alpha.1；提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc` | append-only 事实派生消息、上下文替换、flush、持久 inbox；预算由扩展负责 | 采纳投影和 flush 准入；保留本工程控制器与独立验收；执行已统一 Linux |
| [Hermes Goals](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/website/docs/user-guide/features/goals.md) / [上下文管理](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/website/docs/developer-guide/context-compression-and-caching.md)；提交 `765342435609cc82cbeb3d664dcec24126da58ee`，manifest 0.0.0 占位 | 持久目标、确定性质量门禁、可配置压缩、有限恢复；goal resume 可重置续接计数 | 采纳质量门禁和有限恢复；本工程全任务预算不随 resume 重置，不用模型 judge 替代确定性验收 |

## 设计一：执行后端契约与 Linux 恢复

对应设计理由与反向 E2E：[D06](design-evidence.md#d06)。

引入 `ExecutionHost`：`acquire`、`restoreProcessGroups`、`exec`、`close`。当前执行统一 Linux，删除 Windows/C# 兼容层；Linux 使用 Python 3 标准库 bridge 的 `flock`、session/process group 和 `/proc` 身份，不新增 npm 原生依赖。其他平台明确 unavailable。

Linux bridge 持有 lease 的文件描述符；宿主 Node 的控制管道关闭后，先终止并收割已托管进程组，再释放描述符。bridge 意外死亡时 flock 自动释放，因此新任务必须在持有工作区锁后完成旧进程日志核查，才能请求模型或执行工具。

进程采用两步启动：准备进程组并等待门闩 → Node 提交校验链日志（PID、Linux starttime）→ bridge 释放门闩，开始执行目标程序。记录未提交时目标程序不能开始。恢复时：旧组已经消失则完成；leader 身份仍匹配则终止整组并确认退出；组仍在但身份无法确认则 blocked。避免 PID 复用误杀。不承诺隔离主动逃逸进程组的工具、不支持共享网络目录跨机器 flock、不等同容器沙箱。

工作区执行锁在 Linux 使用区分大小写的真实路径；Windows 保留原有大小写归一化。任务 lease、会话 lease、控制命令 lease 共用后端接口。

本批 Linux 验收范围是同一内核启动和 PID 命名空间中的进程恢复。跨内核重启/容器移交另需 LX-05：先定义日志含 bootId/namespace 的实际任务，模拟身份来源变化，要求拒绝恢复且不杀当前无关进程、不发模型请求。再引入来源身份和新版进程日志；缺少来源的旧原型日志不猜测迁移。LX-05 已实施并实测：日志 v3 保存 bootId 和 PID namespace，来源变化时恢复拒绝且无误杀；缺少来源的旧原型日志明确拒绝。该来源门禁不等于跨执行环境自动续跑。

## 设计二：全任务模型请求账本

对应设计理由与反向 E2E：[D08](design-evidence.md#d08)。

在 `TaskDefinition.limits` 增加可选 `maxModelRequests`。缺省保持旧任务策略；启用时，普通执行、摘要、重规划和未来自动重试必须经过同一个账本网关。各类调用仅标记 purpose，不建立互相独立的额度。

请求事实：

1. `model_request_reserved`：稳定 requestId、purpose、runId（若有）。检查额度后 append+fsync；失败禁止调用底层模型。
2. 分派真实模型。预留本身即消费次数，不能因取消、超时、进程退出、没有 usage 或明确未发出而退还。允许保守多计，禁止恢复后少计。
3. `model_request_settled`：完整响应结束/失败，记录成功、失败或中断以及已观察 usage。结算也必须持久化；失败停止，不能继续工具。

state 从事实派生 reserved/settled/unknown。`unknown` 指已预留但没有可靠用量，不意味着零 token。任务/需求更新均保留账本；更新不能重置或改写既有执行 limits。

额度边界：最后一次准入的模型响应及其完整工具批次允许完成，随后独立验收。如果验收通过可以成功；若仍需模型，下一次准入被拒绝，状态为 `budget_exhausted: model_request_budget_exhausted`。耗尽后 resume 只允许恢复核查和独立复验已有文件，不准新增请求或工具。cancel/pause 仍可中断已准入批次。

与 `maxTurns` 的单次 run 耗尽分开处理；请求总额耗尽不能被当成普通失败继续消耗修复循环。请求次数是首个硬预算；累计 token、活动时间、显式价格费用与工具次数现已实现保守预留和持久结算，未知用量不计零；实际用法见 [完整落地记录](current.md)。

网关契约要求一次 stream 对应一次供应商尝试；内置 PiModelGateway 已设 maxRetries=0。自定义 gateway 若内部自行重试而不经过账本，只能保证网关调用数，不能保证真实 HTTP 请求数；未来重试必须逐次重新准入。

## 设计三：原始历史与请求投影分离

对应设计理由与反向 E2E：[D09](design-evidence.md#d09)。

`SessionRepository.messages()` 继续返回真实持久历史供恢复核查。增加请求上下文构建器，输入当前合同、已提交摘要、保留边界、完整最近工具组和工具描述。仅在完整批次的安全边界触发；不修改保留 assistant 的 providerData。

软阈值使用可解释的估算，保留输出容量；估算不冒充供应商 tokenizer。硬容量先检查必需内容，无法容纳则 `blocked: context_capacity_exceeded`，不能静默丢弃目标或未完成工具组。

摘要流程：选完整组的切点 → 通过同一账本发真实摘要请求 → 校验非空、无工具调用的完整摘要 → 提交 `context_compacted`（summary、sourceCursor/hash、firstKeptEntryId、策略版本）→ 下次请求采用投影。生成后未提交摘要不起作用；重复压缩从旧边界继续并融合旧摘要；原始事实保留。

当前合同（目标、约束、范围、当前阶段、最新验收反馈）机械重注入，避免靠模型摘要维护安全合同。LT-03 必须分别观察合同保留与早期信息摘要；随机 label 如果仍在合同中，只证明前者。摘要不能承载可信验收事实，成功判定仍读取任务账本和新鲜证据。

## 设计四：以验收判定进展和有限策略调整

对应设计理由与反向 E2E：[D10](design-evidence.md#d10)。

新增可选 `progressPolicy`：无有效进展的失败窗口、最多策略调整次数。进展仅来自当前合同版本下新通过的验收能力；源码 hash 改变、工具调用增多、模型宣称成功不能清空窗口。

每轮失败提交进展事实：当前阶段、失败验收 ID、归一化诊断摘要、已通过能力、连续未进展次数、已尝试策略。相同问题和不同失败都消费未进展窗口；诊断相同用于提供证据，不是绕过边界的条件。需求更新开始新版本的进展窗口，但全任务请求及修复预算保持。

达到窗口后，在尚有额度时允许一次真实策略分析请求，要求输出可落实的修复路径和检查；输出不授权越界，下一执行仍经过原控制器及工具策略。再次达到窗口仍未有有效验收进展则 `blocked: no_progress`。新增进展提交后才重置窗口。缺少禁止编造的外部输入单独归为 required_input，不伪装成停滞。

## 设计五：持久输入、有限重试与目标草拟

对应设计理由与反向 E2E：[D03](design-evidence.md#d03)、[D11](design-evidence.md#d11)、[D13](design-evidence.md#d13)。

持久输入采用 inputId+contentHash：accepted 提交后才能回执，consumed 在完整工具组边界对账。follow_up/steer 的投递方式可不同，但均从日志恢复；不能仅从内存 splice 后视为已处理。对重复 inputId 返回既有结果，内容不同拒绝。

重试只适用于明确可重试的网关错误，例如 429、部分 5xx 和连接异常；上限次数与总等待时间持久化，每次尝试都占请求额度。不得通过重试重新执行 replay=never 的工具；未知效果仍走回执或 postcondition 核查。上下文溢出至多进行有限压缩恢复，不以“再试一次”无限循环。

目标草拟后置：模型可建议阶段与验收，但宿主必须提供可信验收程序；对修改需求、外部操作的用户确认按实际授权处理。复杂固定基线已通过；本次依用户全量落地请求实现宿主门禁下的草拟、DAG、多 Agent 与后台工具，不把自由目标声明当可信合同。

## 实施顺序和完成门槛

| 批次 | 落地内容 | 完成门槛 |
| --- | --- | --- |
| A，已实施 | ExecutionHost/Linux、全任务请求账本 | 原有小工程与真实 Linux 边界；旧失败记录保留 |
| B，已实施 | 完整批次后的独立验收让出 | 六模块 LT-12 通过，负向整批/漏交付/cancel 契约通过；LT-02 保持自然结束 |
| C，已实施 | 原始日志与持久摘要投影 | 早期标签、实际请求縮小、提交前后真实进程退出验证 |
| D，已实施 | 可信进展、有限真实策略 | 持续回归阻塞及停止覆盖后成功；综合工程独立验收 |
| E，已实施 | inbox、有限 retry、来源身份 | accepted/consumed 真实进程恢复、503 后真实模型、boot/ns 拒绝 |
| 扩展，已实施 | token/活动时间/费用/工具预算、规划、DAG、资源/MCP、记忆/分支、RPC/Web、后台、容器与读并行 | [全量规格](../e2e/capabilities.md)、[实现和实际结果](current.md)、[逐例证明](../e2e/advanced.md) |

每批完成都更新 [实施记录](history/optimization-a.md) 与 [E2E 总结](../e2e/README.md)，明确 implemented / passed / failed / not_run。本方案各批已落地；一次模型失败、窗口配置与未测平台仍逐项记录，不把实现和单次通过推导为普遍稳定性。
