# 新增长任务、集成与工程用例详解

维护日期：2026-10-05 UTC。返回 [全部 E2E 总结](README.md)，实现和实际报告见 [已落地能力记录](../implemented/current.md)。本页覆盖新增的 24 个注册用例；精确名称由静态清单展开，参数化边界分别计数。

每条区分实际检查与证明范围。模型相关例使用真实 MiMo；进程、容器和来源边界例使用真实进程，不需要伪造模型响应。

<a id="case-01"></a>
## 1. LT-03

**设计依据与合理性：**[D09：完整工具组的持久摘要投影](../implemented/design-evidence.md#d09)。早期随机标签存在真实提交摘要、请求缩小且恢复交付正确，检验摘要持续上下文。

注册名：`LT-03: real committed summary preserves early label through reopen and delivers independently verified files`。源码：[advanced-context-input.test.ts](../../tests/e2e/advanced-context-input.test.ts)。

**初始任务：**早期随机标签不在工作区，目标是写 value()=42 和标签文件。大段宿主诊断迫使真实模型摘要。

**执行步骤：**在包含标签的摘要已提交后发送 pause；关闭控制器，重新打开同一任务再恢复。

**实际检查：**检查实际摘要保留标签、原始诊断仍在日志、执行请求明显缩小且不包含重复前缀；两个独立门禁通过，标签文件等于随机值。

**证明范围与边界：**证明已提交摘要可重用且携带必要早期信息。小工程不代表大工程稳定性；联合工程用例另列。

<a id="case-02"></a>
## 2. IN-01/02

**设计依据与合理性：**[D03：权威会话与持久输入交接](../implemented/design-evidence.md#d03)。accepted 回执后真实杀进程再恢复同输入，检验已接收输入不丢且不重复消费。

注册名：`IN-01/02: inbox_accepted survives process crash and real model resumes one input`。源码：[advanced-context-input.test.ts](../../tests/e2e/advanced-context-input.test.ts)。

**初始任务：**durableInbox v2 会话接收固定 inputId 的 follow_up，程序初始返回 0。

**执行步骤：**独立 Node worker 在 inbox_accepted 提交后通知宿主；宿主 SIGKILL，再启动恢复 worker 调用 resumeInputs。

**实际检查：**真实模型将程序改为 42，恢复 Run completed；同一 inputId 只有一条 inbox_consumed。

**证明范围与边界：**证明回执之后退出不会丢失输入，恢复不重复注入消息；不承诺任意外部操作 exactly-once。

<a id="case-03"></a>
## 3. IN-01/02

**设计依据与合理性：**[D03：权威会话与持久输入交接](../implemented/design-evidence.md#d03)。consumed 与消息提交后真实杀进程，检验消费事实对账和继续执行。

注册名：`IN-01/02: inbox_consumed survives process crash and real model resumes one input`。源码：[advanced-context-input.test.ts](../../tests/e2e/advanced-context-input.test.ts)。

**初始任务：**同上，但中断发生在用户消息与 consumed 已原子提交、执行尚未完成时。

**执行步骤：**真正强退 worker，另一个 Node 进程打开同会话并对账继续。

**实际检查：**真实模型完成文件修改，同一 inputId 消费事实仍只有一次。

**证明范围与边界：**证明 consumed 与消息的提交边界；活动 steer 的整批消费、冲突和结算去重另有关键契约，不能把本例称为跨进程活动 steer 的实测。

<a id="case-04"></a>
## 4. LT-03B

**设计依据与合理性：**[D09：完整工具组的持久摘要投影](../implemented/design-evidence.md#d09)、[D07：先提交再执行与权威日志完整性](../implemented/design-evidence.md#d07)。摘要生成但未提交就退出，恢复不能采用孤立生成结果，检验投影权威边界。

注册名：`LT-03B: actual summary at context_summary_generated obeys cross-process commit boundary`。源码：[advanced-context-input.test.ts](../../tests/e2e/advanced-context-input.test.ts)。

**初始任务：**真实摘要已经生成，但尚未写入 context_compacted。

**执行步骤：**worker 在 context_summary_generated 屏障等待，宿主 SIGKILL；新进程恢复任务。

**实际检查：**中断前没有摘要事实；恢复重新生成必要投影并独立验收成功；原始标签材料完整。

**证明范围与边界：**证明未提交摘要不能取代权威历史。模型生成不等于持久生效。

<a id="case-05"></a>
## 5. LT-03B

**设计依据与合理性：**[D09：完整工具组的持久摘要投影](../implemented/design-evidence.md#d09)、[D07：先提交再执行与权威日志完整性](../implemented/design-evidence.md#d07)。摘要和来源边界提交后退出，恢复不增加摘要且完成随机标签交付，检验可重用性。

注册名：`LT-03B: actual summary at context_compacted obeys cross-process commit boundary`。源码：[advanced-context-input.test.ts](../../tests/e2e/advanced-context-input.test.ts)。

**初始任务：**真实摘要连同首个保留 entry、源 cursor/hash 已提交，并含早期标签。

**执行步骤：**worker 在 context_compacted 屏障强退；另一个进程恢复同任务。

**实际检查：**已提交摘要存在；恢复完成交付，摘要条数不增加，原始标签消息仍在。

**证明范围与边界：**证明提交后的投影边界跨进程重用，而不是每次恢复重新发送旧前缀。

<a id="case-06"></a>
## 6. EX/MCP/MEM

**设计依据与合理性：**[D12：受信任资源、工具协议与宿主记忆](../implemented/design-evidence.md#d12)。真实模型按作用域读 skill、调用真实 MCP、使用授权记忆并交付，检验资源到工具链；错误 schema 不能调用服务。

注册名：`EX/MCP/MEM: real agent loads scoped skill and trusted extension, calls actual MCP and reads authorized memory`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**根目录和 lib/AGENTS.md 有作用域指令；arithmetic skill 只提供索引；宿主授权记忆、固定扩展 hash，并启动真实 stdio MCP 算术服务。

**执行步骤：**Agent 按需 load-skill，调用 calc-add(17,25)，根据真实返回写 value()，调用 delivery-note；关闭会话释放扩展。

**实际检查：**实际导入 value()=42；存在 skill 与 MCP 结果；服务审计、交付登记各一次；dispose 文件存在。

**证明范围与边界：**证明资源发现→按需读→MCP 往返→可信扩展生命周期→实际交付。记忆由宿主授权并注入，不是模型自主长期记忆；不兼容任意上游插件。

<a id="case-07"></a>
## 7. GD/WF

**设计依据与合理性：**[D13：目标草拟与宿主 DAG 门禁](../implemented/design-evidence.md#d13)。真实模型草拟经 hash 确认后执行，依赖只在独立交付通过后启动，检验草稿与可信合同分开。

注册名：`GD/WF: real model drafts confirmed host-gated goal and dependent agent starts only after verified delivery`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**自然语言目标配宿主已有验收器，初始 value()=0，另有依赖任务要求 43。

**执行步骤：**真实模型 draftGoal；确认前检查文件未变，错误 hash 拒绝；确认正确草稿创建控制器；DAG 先执行 42 再放行 43。

**实际检查：**草稿 awaiting_confirmation；错误确认不能执行；两个独立 Task 均有最终验收成功。

**证明范围与边界：**证明目标草拟和执行分离、可信门禁不由模型捏造、依赖按证据放行。复杂 fanout 单独测试。

<a id="case-08"></a>
## 8. BG-01

**设计依据与合理性：**[D14：独立后台 owner 与可查询回执](../implemented/design-evidence.md#d14)。新 manager 查询已持久完成回执，真实超时有结果，检验等待者与 owner 生命周期分离。

注册名：`BG-01: real bounded background process has durable receipt across independent waiters and timeout`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**真实后台进程 300ms 后输出 done；另一进程持续运行，指定 200ms 超时。

**执行步骤：**独立 owner 执行，新的 BackgroundTasks 等待者只凭 operationId/commandHash 读回执。

**实际检查：**第一个回执 completed 且 stdout=done；第二个 failed 且 timedOut；保存回执。

**证明范围与边界：**证明后台 owner 与查询者分离、结果持久及有界运行。此例不发模型请求；崩溃未知结果见 BG-02。

<a id="case-09"></a>
## 9. ENV-01

**设计依据与合理性：**[D15：显式容器执行边界](../implemented/design-evidence.md#d15)。实际容器看不到宿主文件、可写工作区、超时被移除，检验配置进入真实执行边界。

注册名：`ENV-01: real container confines mount, network and cleanup without host-shell fallback`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**Linux 本地 Docker 和显式 node:24-bookworm-slim 镜像；唯一挂载当前工作区。

**执行步骤：**运行真实容器命令写 /workspace/inside.txt，尝试写根目录、检查 Docker socket；再运行超时命令。

**实际检查：**工作区文件 delivered；根写拒绝且 socket 不存在；超时报告；源码固定 network none 和 finally 删除。

**证明范围与边界：**证明实际根文件系统/挂载边界和超时通路；网络策略由配置核查，本例未做主动联网探测。容器需本地 Docker，不能降级主机 shell。

<a id="case-10"></a>
## 10. LX-05

**设计依据与合理性：**[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。真实 Linux 组日志来源标识被替换后恢复拒绝且无误杀，检验 boot/ns 来源门禁。

注册名：`LX-05: foreign boot or PID namespace journal blocks before killing a real unrelated process`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**真实不相关 Linux 进程组，宿主获得 PID/starttime/bootId/namespace。

**执行步骤：**构造校验链有效但 bootId 或 namespace 不同的进程日志，分别尝试 restore。

**实际检查：**两种来源都拒绝 process_state_unknown；原进程仍活着。

**证明范围与边界：**证明来源核查优先于发送清理信号，避免跨内核/namespace 的同号误杀；不是活跃进程跨环境迁移。

<a id="case-11"></a>
## 11. PAR-01

**设计依据与合理性：**[D16：明确只读调用的有界并行](../implemented/design-evidence.md#d16)。实际 HTTP 读存在并发在途并形成正确导入值，检验有界读取与稳定结果交付。

注册名：`PAR-01: real model batches independent HTTP reads with bounded concurrency before writing delivery`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**两个 HTTP 端点分别返回 17、25，各延迟 500ms；声明 read/safe/parallelSafe，maxReadConcurrency=2。

**执行步骤：**真实模型在同一批调用两个 probe，读取实际结果后写程序。

**实际检查：**HTTP 观测最大并发为 2；实际导入 value()=42。

**证明范围与边界：**证明声明安全的读可真正重叠执行；结果排序与写串行由契约补充，不能扩大为任意工具并发。

<a id="case-12"></a>
## 12. ENV-02

**设计依据与合理性：**[D15：显式容器执行边界](../implemented/design-evidence.md#d15)。真实模型在容器执行 Node 断言并输出验收标记，检验模型工具与容器端到端连接。

注册名：`ENV-02: real coding agent verifies its delivery inside the explicit container backend`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**AgentSession 显式使用容器后端，程序 value() 初始 0。

**执行步骤：**真实模型写入代码，再通过 shell 在容器里运行 Node 导入与断言。

**实际检查：**Run completed；实际 shell 结果无错误并含 verified-in-container。

**证明范围与边界：**证明模型工具到容器到实际交付检查的完整链路。文件工具在宿主做受限工作区写入；此例不声称任意 Task 验收器自动获得容器视图。

<a id="case-13"></a>
## 13. BG-02

**设计依据与合理性：**[D14：独立后台 owner 与可查询回执](../implemented/design-evidence.md#d14)、[D04：未知副作用的核查门禁](../implemented/design-evidence.md#d04)。真实杀后台 owner 后 effect_unknown 且一次审计，检验恢复不重发未知命令。

注册名：`BG-02: crashed background owner is reconciled by real process identity without re-dispatch`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**真实后台目标先写一次 PID 审计，然后持续运行。

**执行步骤：**找到真实 owner Node 进程并 SIGKILL；新恢复调用取得执行权，按进程日志静止旧组，查询失败回执。

**实际检查：**recover=effect_unknown；回执 failed；审计只有一条，命令未重发。

**证明范围与边界：**证明崩溃后未知结果保守处理，不能用重启目标来制造 exactly-once。

<a id="case-14"></a>
## 14. LT-11

**设计依据与合理性：**[D02：宿主验收驱动阶段与最终交付](../implemented/design-evidence.md#d02)。六模块隐藏 seed 和新进程 CLI 独立门禁给出较长依赖链的真实交付基线。

注册名：`LT-11: natural-run event engineering baseline uses hidden seed and real CLI`。源码：[advanced-long-tasks.test.ts](../../tests/e2e/advanced-long-tasks.test.ts)。

**初始任务：**六模块 JSONL 工程：parse、normalize、dedup、aggregate、query、cli 均带缺陷；宿主持有随机 seed 输入。

**执行步骤：**默认 natural，真实 MiMo 按六阶段执行，宿主独立运行模块和新进程 CLI 门禁。

**实际检查：**最终 succeeded、六阶段全部通过；validation.json 保存 seed 与事实。

**证明范围与边界：**证明更长依赖链的真实交付基线，涵盖行号、UTC、乱序 revision、Unicode、范围与 CLI；一次成功不等于稳定完成率。

<a id="case-15"></a>
## 15. LT-11/LT-12

**设计依据与合理性：**[D02：宿主验收驱动阶段与最终交付](../implemented/design-evidence.md#d02)。完整工具批次提交后 yielded，最后实际 CLI 通过，检验证据驱动结束；漏交付由负向契约补充。

注册名：`LT-11/LT-12: seeded six-module event CLI passes independent gates with complete-batch yielding`。源码：[advanced-long-tasks.test.ts](../../tests/e2e/advanced-long-tasks.test.ts)。

**初始任务：**同一六模块工程，显式 completionPolicy=verification。

**执行步骤：**模型执行完整工具批次后控制器验收当前阶段；通过则 yielded，推进后续阶段，最后完整复验。候选模块导入和执行隔离在独立进程，提前退出或语法错误由宿主报告为业务验收失败。

**实际检查：**六阶段通过且确有 task_run_completed: yielded；最终真实 CLI 通过。

**证明范围与边界：**证明可在证据满足时结束阶段，节省额外完成声明。整批登记、漏交付门禁和 cancel 优先有独立负向契约；不改 LT-02 的 natural 条件。

<a id="case-16"></a>
## 16. LT-06

**设计依据与合理性：**[D10：可信进展与有限重规划](../implemented/design-evidence.md#d10)。持续覆盖真实修复使门禁反复失败，有限策略后阻塞，检验写文件不能冒充能力进展。

注册名：`LT-06: real repeated regression blocks after finite replan`。源码：[advanced-long-tasks.test.ts](../../tests/e2e/advanced-long-tasks.test.ts)。

**初始任务：**小工程 value() 需返回 42；每次真实 Run 后宿主覆盖回 0，failureWindow=1,maxReplans=1。

**执行步骤：**连续真实验收失败，预留一次策略机会，再发真实结构化 replan；宿主继续覆盖。无效响应同样消费机会并保留附件，不能在恢复后无限重试。

**实际检查：**最终 blocked:no_progress；真实 replan 请求在统一账本，机会只用一次。若规划格式无效，终态明确包含 replan_response_invalid，不能把它写成有效策略后的修复。

**证明范围与边界：**证明文件修改和模型文字不能冒充进展，策略尝试也有额度；这是预期阻塞的通过用例。

<a id="case-17"></a>
## 17. LT-06

**设计依据与合理性：**[D10：可信进展与有限重规划](../implemented/design-evidence.md#d10)。策略后停止覆盖并真实修复成功，与持续失败对照检验重规划能落实而非只输出建议。

注册名：`LT-06: real repeated regression stops after replan and delivers`。源码：[advanced-long-tasks.test.ts](../../tests/e2e/advanced-long-tasks.test.ts)。

**初始任务：**同样的 value() 工程，宿主在策略调整后停止覆盖。

**执行步骤：**真实模型根据验收诊断和新策略再次修改并运行门禁。

**实际检查：**最终 succeeded，真实 replan 记账且次数为一。

**证明范围与边界：**证明有限重规划之后仍能执行有效修复；不能仅看输出“换策略”就认为有效。

<a id="case-18"></a>
## 18. RT-01/02

**设计依据与合理性：**[D11：传输故障的有限重试](../implemented/design-evidence.md#d11)、[D08：累计资源准入与独立额度](../implemented/design-evidence.md#d08)。前两次明确 503 后真实模型交付，共用失败/重试请求账本，检验有限恢复与累计消耗。

注册名：`RT-01/02: classified transport retries are finite and real model continuation shares request budget`。源码：[advanced-long-tasks.test.ts](../../tests/e2e/advanced-long-tasks.test.ts)。

**初始任务：**前两次 provider attempt 人为抛出明确 503，之后接通真实 MiMo；retryPolicy 只允许两次。

**执行步骤：**每次失败独立预留和结算，持久退避后真实模型完成文件。

**实际检查：**两个 failed 请求与完成的 retry 请求共用账本；任务 succeeded。

**证明范围与边界：**证明有限传输重试实际接回模型而不重放工具；持续 429 上限与 400 不重试由关键契约补充。

<a id="case-19"></a>
## 19. BD-01

**设计依据与合理性：**[D08：累计资源准入与独立额度](../implemented/design-evidence.md#d08)。只提高请求额度仍停 max_runs，再提高对应额度完成且旧计数保留，检验额度独立与审计增加。

注册名：`BD-01: real token time cost usage survives audited budget adjustment and recovery`。源码：[advanced-long-tasks.test.ts](../../tests/e2e/advanced-long-tasks.test.ts)。

**初始任务：**value() 工程只准一次执行和一次模型请求、零次修复，并设 token、活动时间、显式单价费用预算；真实交付被故障钩子破坏。

**执行步骤：**耗尽后记录真实 usage；关闭，重复提交同 ID 的 adjust_budget，只提高请求额度。新控制器复验后仍因执行次数上限停下；再用另一个有原因和版本 CAS 的命令提高执行/修复额度，重复提交并恢复完成。

**实际检查：**初次 budget_exhausted；token/time/cost>0；两次重复命令各自同 seq。第一次增加后 max_runs 且没有新增请求；最终 succeeded、budgetVersion=3、旧请求和执行计数仍累计。

**证明范围与边界：**证明不同预算相互独立、正确增加耗尽额度后可继续，以及累计资源观察、命令幂等和跨恢复不清零。执行/修复额度未提高时只复验、不启动模型由关键契约覆盖；费用是明确配置估算而非供应商账单。

<a id="case-20"></a>
## 20. LT-03/LT-05/LT-06

**设计依据与合理性：**[D09：完整工具组的持久摘要投影](../implemented/design-evidence.md#d09)、[D10：可信进展与有限重规划](../implemented/design-evidence.md#d10)、[D15：显式容器执行边界](../implemented/design-evidence.md#d15)。隔离 shell 排除宿主日志来源，摘要标签、至少两次缺陷、有限策略和七项门禁联合检验。

注册名：`LT-03/LT-05/LT-06: six-module CLI retains early summary and repairs regression after bounded replan`。源码：[advanced-long-tasks.test.ts](../../tests/e2e/advanced-long-tasks.test.ts)。

**初始任务：**六模块工程加早期随机标签和重复真实初始验收诊断；标签不存于工作区提示，CLI 另交付 run-label.txt。

**执行步骤：**启用真实压缩、verification 让出；Agent shell 在只挂载工作区的容器执行，宿主日志与诊断不挂载。去重阶段至少两次在验收前被覆盖；一次真实 replan 后停止覆盖，继续聚合/查询/CLI。

**实际检查：**最终七个门禁通过；至少两次去重故障，恰一次 replan；summary 与 replan 共享请求账本；随机标签实际出现在已提交摘要，最终标签文件等于早期值。

**证明范围与边界：**联合验证缩减上下文、依赖回归、有限策略与真实 CLI。摘要质量及完成率依赖配置；失败尝试与正向结果均保留，不能从分项通过推定此例通过。

<a id="case-21"></a>
## 21. WF-02

**设计依据与合理性：**[D13：目标草拟与宿主 DAG 门禁](../implemented/design-evidence.md#d13)、[D02：宿主验收驱动阶段与最终交付](../implemented/design-evidence.md#d02)。三固定 seed、两个并发上游及依赖节点都实际验收，检验 DAG 放行；样本不代表一般稳定性。

注册名：`WF-02: three fixed-config seeded engineering agents use bounded fanout and verified dependencies`。源码：[engineering-stability.test.ts](../../tests/e2e/engineering-stability.test.ts)。

**初始任务：**固定 seed 137/271/809 三个独立六模块工程；固定 off/8192/maxTurns8，completionPolicy=verification。

**执行步骤：**公开 runWorkflow 并发上限 2，前两个各用独立控制器；第三个仅在两个最终验收成功后启动。

**实际检查：**stability-report 保存所有 seed、配置、Task 结果和时间区间；三工程全部门禁通过；最大并发 2，下游起点晚于依赖结束。

**证明范围与边界：**证明工程节点 fanout 与依赖实际执行，同时给出小样本结果。首轮自然结束配置为 1/3，另两项未成功，必须保留；三 seed 不能推导任意项目成功率。

<a id="case-22"></a>
## 22. RPC-01

**设计依据与合理性：**[D17：RPC/Web 共用会话与有界展示](../implemented/design-evidence.md#d17)、[D03：权威会话与持久输入交接](../implemented/design-evidence.md#d03)。真实 RPC 子进程接受重复 ID 和活动 steer，三个输入最终结算且程序按最后需求返回 44，检验入口共用会话。

注册名：`RPC-01: actual subprocess JSONL session accepts durable ID and real model edits the workspace`。源码：[rpc-web.test.ts](../../tests/e2e/rpc-web.test.ts)。

**初始任务：**真实 dist/rpc/cli.js 子进程与 durableInbox，会话工作区 value()=0。

**执行步骤：**通过 JSONL ready/submit 发送稳定 inputId，收 accepted 和最终 result；再发等待型任务，在真实 shell 工具已开始时追加 steer，收到各 inputId 的最终结果，再 status/close。

**实际检查：**accepted 带相同 ID；实际导入 value() 先为 42，活动期新要求替代 43 后最终为 44；三个输入的最终结果均 completed；status 有持久 cursor，close 有响应。

**证明范围与边界：**证明 RPC 与持久 SDK 输入链路；检查实际函数语义而非源码字面量。慢订阅者不阻塞事实及 resync 由补充契约验证，不称此例已做大规模压力测试。

<a id="case-23"></a>
## 23. WEB-01

**设计依据与合理性：**[D17：RPC/Web 共用会话与有界展示](../implemented/design-evidence.md#d17)。真实 HTTP 授权请求、错误 token/Host 拒绝及事件展示，检验 loopback 入口；不外推公网部署。

注册名：`WEB-01: loopback session UI rejects unauthenticated writes and real agent delivers through HTTP`。源码：[rpc-web.test.ts](../../tests/e2e/rpc-web.test.ts)。

**初始任务：**本地 127.0.0.1 Web 会话，每次随机 token。

**执行步骤：**无 token HTTP 写入被拒绝；取得 UI，用授权 HTTP submit 发送输入，真实模型写程序；查询 events。

**实际检查：**403 与 200 出口正确；最终 Run completed，实际导入 value()=42，能看到事件。

**证明范围与边界：**证明实际 HTTP→SDK→模型工具链路和基本访问限制。没有外网发布、多用户认证或跨域部署承诺。

<a id="case-24"></a>
## 24. MCP-02

**设计依据与合理性：**[D12：受信任资源、工具协议与宿主记忆](../implemented/design-evidence.md#d12)。实际 stdio 超时、取消、坏响应、断连均拒绝且观察取消通知，检验协议不能伪造成功。

注册名：`MCP-02: real stdio timeout cancellation malformed response and disconnect refuse success`。源码：[advanced-integrations.test.ts](../../tests/e2e/advanced-integrations.test.ts)。

**初始任务：**真实 Node stdio 服务可初始化，但故意忽略请求、发送错误协议版本或自行退出。

**执行步骤：**通过公开 McpClient 发请求并等待超时；再用 AbortSignal 取消；随后触发坏响应和断连。

**实际检查：**四个请求分别明确拒绝；服务端审计实际收到两条 cancelled 通知。正常 MCP 往返和 schema 门禁由集成用例补充。

**证明范围与边界：**证明不能把超时、取消、坏协议或断连冒充工具成功。这是实际协议 E2E，不需要模型替它判断结果；不验证 HTTP 传输或任意第三方服务器。
