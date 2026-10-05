# 已落地设计与 E2E 证据对应

本页是当前设计与验收的双向索引。每个 E2E 详解链接到这里并解释为何其检查能支持设计；这里反向引用具体用例。合理性由问题、选择、实际观测和反例共同说明，通过范围以用例正文为准。

源码入口和最近实测见 [当前实现](current.md)，完整步骤见 [E2E 总览](../e2e/README.md)。[历史检索](history-retrieval.md)与 [快照加速](snapshot-acceleration.md)已独立通过真实交付、拒绝边界和性能对照；当前 [待办清单](../pending/README.md)为空。固定 pi、DeepSeek Harness、Hermes 参考及取舍见 [优化设计](optimization.md)。

| 设计编号 | 已实现选择 | 对应问题 |
| --- | --- | --- |
| [D01](#d01) | 编码工具、作用域指令与调用策略 | 自然语言要求不能单独保证权限和文件完整性；独立复跑业务测试、核对测试源码及工作区副作用，才能确认实际修复和只读行为 |
| [D02](#d02) | 宿主验收驱动阶段与最终交付 | 已通过依赖会回归，模型也可能早报完成或迟迟不结束；实际业务门禁和成功临界区核查让交付取决于当前文件 |
| [D03](#d03) | 权威会话与持久输入交接 | 进程会在两个文件提交之间退出，内存队列和随机换 ID 会丢输入或重复注入 |
| [D04](#d04) | 未知副作用的核查门禁 | 操作可能已完成而进程尚未保存结果，盲目重试会重复登记 |
| [D05](#d05) | 持久命令、合同版本与成功竞争 | 等待回执超时不等于命令撤销，重复投递也不能重复改需求 |
| [D06](#d06) | 内核执行权与进程身份 | 文件中的过期时间不证明执行者已死，PID 也可能复用 |
| [D07](#d07) | 先提交再执行与权威日志完整性 | 实际写入失败时停止事实本身也可能无法提交，因此需要分派计数而非相信磁盘终态 |
| [D08](#d08) | 累计资源准入与独立额度 | 只限制单 Run 会允许恢复或换阶段绕过总额度 |
| [D09](#d09) | 完整工具组的持久摘要投影 | 压缩不能破坏调用/结果协议或丢掉当前目标 |
| [D10](#d10) | 可信进展与有限重规划 | 反复改文件或写诊断不能证明任务推进 |
| [D11](#d11) | 传输故障的有限重试 | 传输失败可恢复，但业务错误和未知效果不能靠整段重放修复 |
| [D12](#d12) | 受信任资源、工具协议与宿主记忆 | 发现文件或服务器提供描述不能自动授予执行权限 |
| [D13](#d13) | 目标草拟与宿主 DAG 门禁 | 模型分解不能创造可信完成规则，也不能让未交付上游触发下游 |
| [D14](#d14) | 独立后台 owner 与可查询回执 | 等待者退出不说明命令未执行，自动重启会重复副作用 |
| [D15](#d15) | 显式容器执行边界 | 文件路径白名单无法限制有主机权限的 shell |
| [D16](#d16) | 明确只读调用的有界并行 | 任意工具并行会改变副作用顺序 |
| [D17](#d17) | RPC/Web 共用会话与有界展示 | 交互入口不能变成第二套任务语义，慢展示也不能阻塞权威提交 |
| [D18](#d18) | 当前会话来源绑定的历史检索 | 摘要遗漏细节时需要找回原文，又不能开放私有状态目录 |
| [D19](#d19) | 权威检查点绑定派生快照 | 缓存可被改写，不能自行授权成功或清零累计预算 |

<a id="d01"></a>
## D01：编码工具、作用域指令与调用策略

**设计选择：**用工具 schema、工作区路径边界和宿主调用策略约束实际操作，项目指令附来源与范围。读改测由真实工具完成。

**合理性：**自然语言要求不能单独保证权限和文件完整性；独立复跑业务测试、核对测试源码及工作区副作用，才能确认实际修复和只读行为。

**设计与实现：**[架构的资源与执行环境](architecture.md#75-资源与执行环境)；[编码工具](../../src/tools/coding-tools.ts)、[执行器](../../src/tools/executor.ts)、[资源](../../src/resources/catalog.ts)。

**反向 E2E 引用：**[cli-delivery #1 购物车修复](../e2e/cli-delivery.md#case-01)、[cli-delivery #3 只读库存审查](../e2e/cli-delivery.md#case-03)。

<a id="d02"></a>
## D02：宿主验收驱动阶段与最终交付

**设计选择：**宿主提供可信验收器，阶段通过和最终成功引用实际证据及文件指纹；提交成功前重查当前文件和控制命令。默认 natural，显式 verification 在完整工具批次后让出。

**合理性：**已通过依赖会回归，模型也可能早报完成或迟迟不结束；实际业务门禁和成功临界区核查让交付取决于当前文件。整批完成约束防止遗漏同批交付登记。

**设计与实现：**[验收如何判定](long-tasks.md#53-验收如何判定)、[推进流程](long-tasks.md#6-任务推进流程)；[任务控制器](../../src/harness/task-controller.ts)、[验收器](../../src/harness/verifier.ts)。

**反向 E2E 引用：**[advanced #14 LT-11](../e2e/advanced.md#case-14)、[advanced #15 LT-11/LT-12](../e2e/advanced.md#case-15)、[advanced #21 WF-02](../e2e/advanced.md#case-21)、[budget-linux #5 LT-05C：最后一个获准请求仍可完成交付](../e2e/budget-linux.md#case-05)、[cli-delivery #5 LT-01：正常三阶段订单交付](../e2e/cli-delivery.md#case-05)、[cli-delivery #6 LT-02：后续交付时依赖回归，反馈后继续修复](../e2e/cli-delivery.md#case-06)、[fault-hardening #2 验收程序不存在，修复合同后直接重验](../e2e/fault-hardening.md#case-02)、[fault-hardening #7 HT-01：最终验收后、成功提交前源码变化](../e2e/fault-hardening.md#case-07)、[recovery-control #1 报价服务：暂停后代码回归，跨进程修复并交付 HTTP](../e2e/recovery-control.md#case-01)。

<a id="d03"></a>
## D03：权威会话与持久输入交接

**设计选择：**输入身份和内容摘要固定，accepted 先提交再回执，consumed 与用户消息原子保存，settled 可查询；跨任务与会话按稳定 run/input ID 对账。

**合理性：**进程会在两个文件提交之间退出，内存队列和随机换 ID 会丢输入或重复注入。对账保留原身份，跨进程随机编号与真实交付检查使恢复可观察。

**设计与实现：**[输入交接](history/recovery-design.md#43-输入交接)；[会话](../../src/harness/session.ts)、[会话日志](../../src/storage/session.ts)。

**反向 E2E 引用：**[advanced #2 IN-01/02](../e2e/advanced.md#case-02)、[advanced #3 IN-01/02](../e2e/advanced.md#case-03)、[advanced #22 RPC-01](../e2e/advanced.md#case-22)、[cli-delivery #2 普通会话跨进程恢复](../e2e/cli-delivery.md#case-02)、[recovery-control #3 Run 已计划，输入尚未接收时崩溃](../e2e/recovery-control.md#case-03)、[recovery-control #4 会话已接收输入，任务应用记录尚未提交时崩溃](../e2e/recovery-control.md#case-04)、[recovery-control #5 会话 Run 已结算，任务 Run 结果尚未提交时崩溃](../e2e/recovery-control.md#case-05)。

<a id="d04"></a>
## D04：未知副作用的核查门禁

**设计选择：**工具 intent 和结果分开持久化；仅凭日志缺少结果不能判定未执行。可查询的可信回执补结果，文件内容只证明当前后置条件，无法确认时阻塞且不重放副作用。

**合理性：**操作可能已完成而进程尚未保存结果，盲目重试会重复登记。观察真实审计次数、当前文件和恢复后零新增分派，检验已知/未知效果各自应允许的行为。

**设计与实现：**[提交边界与恢复动作](long-tasks.md#81-提交边界与恢复动作)；[恢复核查](../../src/harness/recovery.ts)、[工具 intent](../../src/tools/executor.ts)。

**反向 E2E 引用：**[advanced #13 BG-02](../e2e/advanced.md#case-13)、[fault-hardening #1 已完成 write 的文件摘要不匹配](../e2e/fault-hardening.md#case-01)、[fault-hardening #8 HT-02：恢复未结算 write 时目标文件缺失](../e2e/fault-hardening.md#case-08)、[fault-hardening #9 HT-03：恢复未结算登记时回执查询抛错](../e2e/fault-hardening.md#case-09)、[recovery-control #2 非幂等登记：未知副作用先阻塞，回执恢复后继续](../e2e/recovery-control.md#case-02)、[recovery-control #7 默认 write 已完成，工具结果尚未提交时崩溃](../e2e/recovery-control.md#case-07)。

<a id="d05"></a>
## D05：持久命令、合同版本与成功竞争

**设计选择：**命令先持久投递，command ID 去重、内容冲突拒绝、expectedVersion CAS；pause 等安全边界，cancel 可中断托管进程，update 在安全边界及成功临界区处理。合同更新使旧证据失效，累计消耗保留。

**合理性：**等待回执超时不等于命令撤销，重复投递也不能重复改需求。用已发布命令与成功竞争、活动进程停止和不同折扣产物检查用户控制是否真正生效。

**设计与实现：**[命令与合同版本](history/recovery-design.md#6-控制命令与合同版本)；[命令投递](../../src/storage/task-commands.ts)、[控制器](../../src/harness/task-controller.ts)。

**反向 E2E 引用：**[budget-linux #1 LT-05A：暂停、恢复和需求更新不清零请求额度](../e2e/budget-linux.md#case-01)、[recovery-control #1 报价服务：暂停后代码回归，跨进程修复并交付 HTTP](../e2e/recovery-control.md#case-01)、[recovery-control #8 成功提交前更新合同：新版需求优先，命令只应用一次](../e2e/recovery-control.md#case-08)、[recovery-control #10 最终验收通过后、成功提交前取消](../e2e/recovery-control.md#case-10)、[recovery-control #11 活动父子进程工具期间暂停](../e2e/recovery-control.md#case-11)、[recovery-control #12 活动父子进程工具期间取消](../e2e/recovery-control.md#case-12)、[recovery-control #13 订单 M2 后暂停，更新为 20% 折扣再交付](../e2e/recovery-control.md#case-13)。

<a id="d06"></a>
## D06：内核执行权与进程身份

**设计选择：**工作区、Task、Session 获得同一后端内核 lease；恢复前核查并静止旧托管组。执行平台统一 Linux，记录 bootId/PID namespace/PID/starttime；先验证全部来源再清理，旧 Windows 身份拒绝转换。

**合理性：**文件中的过期时间不证明执行者已死，PID 也可能复用。真实竞争与父子进程出口检验所有权和残留执行；来源错误必须在误杀前拒绝。

**设计与实现：**[执行权与进程托管](history/recovery-design.md#7-执行权与进程托管)；[统一后端](../../src/platform/host.ts)、[Linux](../../src/platform/linux.ts)、[Linux-only 迁移方案](linux-only.md)。

**反向 E2E 引用：**[advanced #10 LX-05](../e2e/advanced.md#case-10)、[budget-linux #6 LX-01：Linux 执行锁与宿主硬退出](../e2e/budget-linux.md#case-06)、[budget-linux #7 LX-02：取消、超时和正常父进程结束](../e2e/budget-linux.md#case-07)、[budget-linux #8 LX-03：bridge 硬退出及进程身份核查](../e2e/budget-linux.md#case-08)、[budget-linux #9 LX-04：进程日志无法提交，目标程序不能开始](../e2e/budget-linux.md#case-09)、[fault-hardening #5 平台运行时缺失](../e2e/fault-hardening.md#case-05)、[recovery-control #9 两个独立恢复进程竞争同一任务](../e2e/recovery-control.md#case-09)、[recovery-control #11 活动父子进程工具期间暂停](../e2e/recovery-control.md#case-11)、[recovery-control #12 活动父子进程工具期间取消](../e2e/recovery-control.md#case-12)、[recovery-control #14 LX-06：Linux 大小写身份和旧平台拒绝](../e2e/recovery-control.md#case-14)。

**迁移验收：**[LX-06 与全量 Linux 回归](../e2e/linux-only.md)。当前只支持 Linux，Windows 专属测试已替换，历史结果保留原平台范围。

<a id="d07"></a>
## D07：先提交再执行与权威日志完整性

**设计选择：**必要事实 fsync 成功后才启动外部动作；只修复不完整尾部，中间损坏/未来 schema 拒绝；孤立附件和派生缓存不能自行授权成功，旧活动记录缺证据时不猜测迁移。

**合理性：**实际写入失败时停止事实本身也可能无法提交，因此需要分派计数而非相信磁盘终态。日志、附件和缓存的不同权威性由强退、闭合句柄及损坏变体检验。

**设计与实现：**[错误与证据规则](history/recovery-design.md#8-错误与证据规则)；[任务日志](../../src/storage/task.ts)、[迁移](../../src/storage/migration.ts)、[校验链](../../src/storage/journal.ts)。

**反向 E2E 引用：**[advanced #4 LT-03B](../e2e/advanced.md#case-04)、[advanced #5 LT-03B](../e2e/advanced.md#case-05)、[budget-linux #9 LX-04：进程日志无法提交，目标程序不能开始](../e2e/budget-linux.md#case-09)、[fault-hardening #3 任务日志写入失败，首个模型请求前停止](../e2e/fault-hardening.md#case-03)、[fault-hardening #4 会话日志写入失败，首个模型请求前停止](../e2e/fault-hardening.md#case-04)、[fault-hardening #6 日志尾部、损坏、旧格式与迁移](../e2e/fault-hardening.md#case-06)、[recovery-control #6 验收附件已写，通过事件尚未提交时崩溃](../e2e/recovery-control.md#case-06)。

**补充设计：**[D19](#d19)通过权威检查点绑定缓存，参与前缀折叠加速，仍完整验链；旧缓存容错用例不单独证明加速。

<a id="d08"></a>
## D08：累计资源准入与独立额度

**设计选择：**所有执行、摘要、策略和重试请求先持久预留再结算；未知用量保留占用。runs/repairs/requests/token/活动时间/工具/费用独立计量，审计预算增加用 ID 去重与 CAS，恢复不清零。

**合理性：**只限制单 Run 会允许恢复或换阶段绕过总额度。请求发出与结算间崩溃检验保守占用；只增加请求额度仍受 maxRuns 限制，最后获准批次和宿主复验也各有边界。

**设计与实现：**[全任务预算](long-tasks.md#91-全任务预算)；[预算网关](../../src/model/request-budget.ts)、[任务事实](../../src/storage/task.ts)。

**反向 E2E 引用：**[advanced #18 RT-01/02](../e2e/advanced.md#case-18)、[advanced #19 BD-01](../e2e/advanced.md#case-19)、[budget-linux #1 LT-05A：暂停、恢复和需求更新不清零请求额度](../e2e/budget-linux.md#case-01)、[budget-linux #2 LT-05B：预留已提交，尚未分派即退出](../e2e/budget-linux.md#case-02)、[budget-linux #3 LT-05B：真实请求已发，完整结果尚未结算即退出](../e2e/budget-linux.md#case-03)、[budget-linux #4 LT-05B：完整响应已返回，结算前退出](../e2e/budget-linux.md#case-04)、[budget-linux #5 LT-05C：最后一个获准请求仍可完成交付](../e2e/budget-linux.md#case-05)、[cli-delivery #4 单次执行片段轮次预算](../e2e/cli-delivery.md#case-04)。

<a id="d09"></a>
## D09：完整工具组的持久摘要投影

**设计选择：**原始历史保持完整，请求使用来源可校验的摘要和最近完整工具组；保留原生 providerData、当前合同与权限。摘要及来源边界一起提交，生成但未提交的摘要不可采用。

**合理性：**压缩不能破坏调用/结果协议或丢掉当前目标。随机早期标签、真实请求缩减和摘要提交前后强退检验持续上下文；隔离 shell 排除偷读宿主日志这一替代来源。

**设计与实现：**[何时与如何压缩](long-tasks.md#72-何时与如何压缩)；[请求上下文](../../src/harness/context.ts)、[会话事实](../../src/storage/session.ts)。

**反向 E2E 引用：**[advanced #1 LT-03](../e2e/advanced.md#case-01)、[advanced #4 LT-03B](../e2e/advanced.md#case-04)、[advanced #5 LT-03B](../e2e/advanced.md#case-05)、[advanced #20 LT-03/LT-05/LT-06](../e2e/advanced.md#case-20)。

**补充设计：**[D18](#d18)独立证明摘要遗漏后的工具检索；本组继续证明摘要保留和重用。

<a id="d10"></a>
## D10：可信进展与有限重规划

**设计选择：**只有新的宿主验收 ID 通过才重置失败窗口；达到窗口预留有限策略机会，真实建议进入后续执行提示，无效建议同样计次。再次无进展时明确 no_progress。

**合理性：**反复改文件或写诊断不能证明任务推进。持续覆盖缺陷与策略后停止覆盖两个变体，分别检验停止机制和建议落实后的真实修复。

**设计与实现：**[什么算进展](long-tasks.md#92-什么算进展)；[进展和策略控制](../../src/harness/task-controller.ts)、[进展事实](../../src/storage/task.ts)。

**反向 E2E 引用：**[advanced #16 LT-06](../e2e/advanced.md#case-16)、[advanced #17 LT-06](../e2e/advanced.md#case-17)、[advanced #20 LT-03/LT-05/LT-06](../e2e/advanced.md#case-20)。

<a id="d11"></a>
## D11：传输故障的有限重试

**设计选择：**只重试明确 429、指定 5xx 与连接错误；持久累计次数与等待，每次请求独立记账，失败或截断响应不执行工具，适配器关闭隐藏重试。

**合理性：**传输失败可恢复，但业务错误和未知效果不能靠整段重放修复。先两次明确 503 再接通真实模型，检验故障后接续及共用账本；持续 429 和 400 由契约补充。

**设计与实现：**[优化中的持久输入和重试](optimization.md#设计五持久输入有限重试与目标草拟)；[有限重试](../../src/model/retry.ts)、[适配器](../../src/model/pi-gateway.ts)。

**反向 E2E 引用：**[advanced #18 RT-01/02](../e2e/advanced.md#case-18)。

<a id="d12"></a>
## D12：受信任资源、工具协议与宿主记忆

**设计选择：**嵌套指令按来源/作用域，skill 按需读取，Node 扩展须显式 hash 授权并注册/释放；MCP 校验协议及输入，副作用缺省 process/never；记忆仅保存宿主明确授权内容。

**合理性：**发现文件或服务器提供描述不能自动授予执行权限。真实服务往返、错误输入零调用、超时/取消/坏协议/断连拒绝，以及真实模型交付共同检查加载与调用链。

**设计与实现：**[资源和调用权限决策](architecture.md#10-架构问题的落地决策2026-10-05)；[资源](../../src/resources/catalog.ts)、[MCP](../../src/tools/mcp.ts)、[记忆](../../src/storage/memory.ts)、[分支](../../src/storage/branch.ts)。

**反向 E2E 引用：**[advanced #6 EX/MCP/MEM](../e2e/advanced.md#case-06)、[advanced #24 MCP-02](../e2e/advanced.md#case-24)。

**补充契约：**[分支和授权边界契约](../../tests/advanced-contracts.test.ts)另核查完整 cursor 分支、悬挂效果拒绝及工具策略。分支复制消息，不复制进程/intent，不自动回滚工作区。

<a id="d13"></a>
## D13：目标草拟与宿主 DAG 门禁

**设计选择：**模型只草拟宿主已有验收 ID 的阶段，确认 hash 后才创建任务；DAG 在 Harness 组合独立控制器，检测环、限制并发，依赖只有带最终证据的成功才放行。

**合理性：**模型分解不能创造可信完成规则，也不能让未交付上游触发下游。真实确认与依赖交付检验流程；固定三 seed 只提供该配置样本，不推导普遍完成率。

**设计与实现：**[规划和工作流决策](architecture.md#10-架构问题的落地决策2026-10-05)；[草拟与确认](../../src/harness/planning.ts)、[DAG](../../src/harness/workflow.ts)。

**反向 E2E 引用：**[advanced #7 GD/WF](../e2e/advanced.md#case-07)、[advanced #21 WF-02](../e2e/advanced.md#case-21)。

<a id="d14"></a>
## D14：独立后台 owner 与可查询回执

**设计选择：**后台命令由独立 owner 执行，stable operationId 与内容摘要去重，完成回执先同步；新等待者只查询。owner 崩溃且无可靠结果时静止旧组，记 effect_unknown，不重发。

**合理性：**等待者退出不说明命令未执行，自动重启会重复副作用。重新建立 manager 等待、超时和真实杀 owner 后审计次数检查生命周期与恢复边界。

**设计与实现：**[后台与跨进程落地决策](architecture.md#10-架构问题的落地决策2026-10-05)；[后台管理](../../src/harness/background.ts)、[owner](../../src/harness/background-worker.ts)。

**反向 E2E 引用：**[advanced #8 BG-01](../e2e/advanced.md#case-08)、[advanced #13 BG-02](../e2e/advanced.md#case-13)。

<a id="d15"></a>
## D15：显式容器执行边界

**设计选择：**宿主显式选择本地 Docker 和镜像，工作区唯一挂载、同 UID、根只读、network none、drop capabilities；取消/超时删除对应容器，恢复核查名称/标签，无 host shell 降级。

**合理性：**文件路径白名单无法限制有主机权限的 shell。实际不可见宿主文件、写入工作区、超时清理与模型在容器验收，检验隔离选择是否真正进入执行链路。

**设计与实现：**[权限与执行环境](long-tasks.md#10-与权限和执行环境的关系)；[容器后端](../../src/environment/container.ts)、[环境](../../src/environment/local.ts)。

**反向 E2E 引用：**[advanced #9 ENV-01](../e2e/advanced.md#case-09)、[advanced #12 ENV-02](../e2e/advanced.md#case-12)、[advanced #20 LT-03/LT-05/LT-06](../e2e/advanced.md#case-20)。

<a id="d16"></a>
## D16：明确只读调用的有界并行

**设计选择：**仅并行连续的 parallelSafe/read/safe 工具，结果按调用顺序提交；写和进程保持串行，完整批次结束后才验收。

**合理性：**任意工具并行会改变副作用顺序。真实独立 HTTP 读取观察同时在途，后续实际文件导入证明并发取得的数据仍按稳定协议用于交付；写入屏障由契约补充。

**设计与实现：**[并发与恢复](architecture.md#73-并发重试与崩溃恢复)；[执行循环](../../src/runtime/agent.ts)、[工具执行](../../src/tools/executor.ts)。

**反向 E2E 引用：**[advanced #11 PAR-01](../e2e/advanced.md#case-11)。

<a id="d17"></a>
## D17：RPC/Web 共用会话与有界展示

**设计选择：**JSONL RPC 和 loopback Web 使用同一 durable Session/input ID；活动 steer 在完整批次后处理，各输入有最终结算。显示队列有界并可 resync；Web 每次 token 与 Host 检查。

**合理性：**交互入口不能变成第二套任务语义，慢展示也不能阻塞权威提交。真实子进程、活动修改后的文件、每输入回执及实际 HTTP 拒绝检查入口行为。

**设计与实现：**[事件与结束](architecture.md#74-取消与最终结束)；[RPC](../../src/rpc/server.ts)、[Web](../../src/rpc/web.ts)。

**反向 E2E 引用：**[advanced #22 RPC-01](../e2e/advanced.md#case-22)、[advanced #23 WEB-01](../e2e/advanced.md#case-23)。

**补充契约：**慢展示队列不阻塞提交及 resync 由 [关键契约](../../tests/advanced-contracts.test.ts)补充；Web 不承担公网多用户部署。

<a id="d18"></a>
## D18：来源绑定的只读历史检索

**设计选择：**显式启用当前会话的 history 工具，按工作区相对路径找来源、按 entryId 分页读原文/绑定附件；绑定在 tool-result 提交，读取核对大小与摘要。查询有范围、秘密过滤、链接/孤立附件拒绝，走原工具策略和额度。

**合理性：**保存日志不足以让模型拿回摘要遗漏的细节，开放宿主目录又会放大权限。随机码不在摘要或容器挂载中，真实检索与独立文件比对检验这条入口是否必要且有效；拒绝变体检验来源授权。

**设计与实现：**[历史检索契约、参考与实测](history-retrieval.md)、[仓库](../../src/storage/session.ts)、[工具](../../src/tools/history.ts)。

**反向 E2E 引用：**[HR-01 隔离续交付](../e2e/history-snapshot.md#hr-01)、[HR-02 来源门禁](../e2e/history-snapshot.md#hr-02)。

<a id="d19"></a>
## D19：权威检查点绑定快照

**设计选择：**宿主先将 reducer/状态摘要检查点 fsync 到日志，再原子写缓存；完整验链后只复用匹配前缀，后缀折叠；不可信缓存全量回退，权威损坏拒绝；失败 writer 关闭不再按旧内存水位追加检查点。

**合理性：**缓存自带 hash 可以被一起重算，需日志中宿主检查点约束。伪造成功/预算反例和真实 42→43 交付验证语义；同日志五次对照证明在累计账本上节省折叠，简单状态日志无统一加速承诺。

**设计与实现：**[绑定与性能实测](snapshot-acceleration.md)、[TaskRepository](../../src/storage/task.ts)、[基准脚本](../../scripts/snapshot-benchmark.ts)。

**反向 E2E 引用：**[SS-01 恢复与拒绝](../e2e/history-snapshot.md#ss-01)、[SS-02 同步失败关闭](../e2e/history-snapshot.md#ss-02)、[SS-01 性能对照](../e2e/history-snapshot.md#performance)。
