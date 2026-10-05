# 恢复、控制与需求更新用例

返回 [E2E 用例总结](README.md)。本页详细说明 14 个注册用例：恢复文件中的 12 个、订单更新 1 个、Windows 平台 1 个。本次整理未重新执行。

源码入口：[task-recovery.test.ts](../../tests/e2e/task-recovery.test.ts)、[task-update.test.ts](../../tests/e2e/task-update.test.ts)、[platform.test.ts](../../tests/e2e/platform.test.ts)。规格见 [第二阶段 E2E](history/recovery.md)。

## 共用任务与故障方式

多数边界用例使用 [valueFixture](../../tests/e2e/value-fixture.ts)：初始 `value()` 返回 0，合同要求返回 42。小任务便于把观察集中在恢复协议；它的成功不能代表复杂工程完成能力。

[phase2-worker](../../tests/e2e/phase2-worker.ts) 从公开 SDK 启动真实模型。故障屏障在特定提交边界发出 IPC 信号，宿主收到后终止执行进程并确认退出，再启动新进程恢复。屏障控制真实时机，不依赖固定延迟猜测崩溃位置，也不伪造模型回复。

Run 是一次 Agent 执行片段，可含多个模型请求。以下 Run 数保留、增加的断言证明既有执行片段额度语义；累计模型请求预算另由已实施的 [LT-05 请求预算用例](budget-linux.md)验证，设计见 [D08](../implemented/design-evidence.md#d08)。

<a id="case-01"></a>
## 1. 报价服务：暂停后代码回归，跨进程修复并交付 HTTP

**设计依据与合理性：**[D02：宿主验收驱动阶段与最终交付](../implemented/design-evidence.md#d02)、[D05：持久命令、合同版本与成功竞争](../implemented/design-evidence.md#d05)。报价 HTTP 工程阶段通过后暂停，代码回归，再由新进程重验、修复并交付真实 HTTP 响应，检验不同工程的持久控制与当前验收。

注册测试名：`LT-10 / LT-07B / LT-08A: pause at verified amount, change workspace, new process resumes real HTTP delivery`

- **初始任务：**[quoteFixture](../../tests/e2e/quote-service-fixture.ts) 使用 `app/` 和 `lib/`，没有 `src/`。报价函数抛 TODO，HTTP 服务未实现。合同要求读取持久配置、计算整数分报价，并通过实际 HTTP 请求验收。
- **执行步骤：**真实模型完成金额阶段并验收后，在屏障投递 pause；释放屏障，确认暂停后关闭进程；宿主把报价函数改成金额全为 0；新进程恢复同一任务，继续修复和 HTTP 交付。
- **实际检查：**投递时收据为 `queued`，不能冒充暂停完成；结束后状态为 `paused` 且收据 `applied`。恢复后同 task / session、合同版本 1，Run 数增加，最终证据通过。验收器真实启动服务两次，分别检查 200 响应为 `3980 / 398 / 3582` 分，数量 0 返回 400，重启仍采用配置。
- **证明范围与边界：**证明暂停与跨进程续跑、旧通过代码回归后的重验修复，以及控制器能服务另一种工程结构。HTTP 结果由验收器检查，外层测试检查其通过证据；阶段仍由宿主定义，不证明任意项目自主规划或线上服务长期稳定。

<a id="case-02"></a>
## 2. 非幂等登记：未知副作用先阻塞，回执恢复后继续

**设计依据与合理性：**[D04：未知副作用的核查门禁](../implemented/design-evidence.md#d04)。回执未知时阻止新动作，证据恢复后继续，检验未确认效果的恢复门禁。

注册测试名：`LT-04A/B: effect receipt recovery blocks unknown, never repeats delivery`

- **初始任务：**实现 `value() = 42`，并调用一次 `record-delivery`。工具每执行一次就真实追加一条审计记录并保存回执；没有工具内部去重，声明不可重放。
- **执行步骤：**在登记副作用与回执完成、工具结果尚未提交时终止进程；宿主让查询适配器返回 unknown；另一进程 resume；宿主再恢复回执可查询条件并显式 resume。
- **实际检查：**未知期间状态为 `blocked: effect_unknown`，Run 数保持；实际模型请求审计内容不增加，恢复日志没有工具启动，登记仍仅一条。条件恢复后任务成功，登记始终只有一次，task 身份及累计 Run 保留。
- **证明范围与边界：**证明日志缺少结果时不会把操作当作未执行；证据不足时停止，可信回执恢复后补齐协议并继续。保证依赖该工具的查询适配器，不证明任意 shell、远程服务或无回执操作都有通用的“恰好一次”语义。

## 五个崩溃边界的共同检查

下面五个分别注册测试，虽然都使用同一个小接口任务。共同步骤是到达屏障 → 终止进程 → 读取已提交状态 → 新进程 resume。共同断言为：最终成功，task / session 身份保持，Run 数不回退；原计划 input ID 在会话事实中只出现一次，并匹配原 run ID 和内容摘要。

<a id="case-03"></a>
## 3. Run 已计划，输入尚未接收时崩溃

**设计依据与合理性：**[D03：权威会话与持久输入交接](../implemented/design-evidence.md#d03)。任务已计划而会话未接收时退出，恢复保留原 input/run 身份，检验交接补写。

注册测试名：`LT-04C/D/F: real crash at run_planned`

- **初始任务：**`value()` 从 0 改为 42。
- **执行步骤：**在任务日志已经提交 Run 身份、输入 ID、提示摘要及额度，但会话还没有接收该输入时退出；新进程恢复。
- **实际检查：**上述共同检查成立，特别是原 input / run 身份与内容摘要保留且只接收一次。
- **证明范围与边界：**证明跨文件交接未完成时可以补接原输入，已预留 Run 不回退。此时尚未发出该 Run 的模型请求，不证明请求发出后 usage 缺失的预算处理。

<a id="case-04"></a>
## 4. 会话已接收输入，任务应用记录尚未提交时崩溃

**设计依据与合理性：**[D03：权威会话与持久输入交接](../implemented/design-evidence.md#d03)。会话已接收而任务未引用时退出，稳定 ID 对账避免重复输入。

注册测试名：`LT-04C/D/F: real crash at input_accepted`

- **初始任务：**同一小接口任务。
- **执行步骤：**输入已写入会话，任务还没有提交对应 `task_input_applied` 时终止；恢复进程按稳定 ID 对账。
- **实际检查：**共同检查成立；已经存在的原输入仍只有一条，恢复没有更换身份重复追加。
- **证明范围与边界：**证明“会话已写、任务未引用”的不一致可以安全对账。它检验输入持久化与去重，不检验模型是否必须依赖某段早期历史才能完成。

<a id="case-05"></a>
## 5. 会话 Run 已结算，任务 Run 结果尚未提交时崩溃

**设计依据与合理性：**[D03：权威会话与持久输入交接](../implemented/design-evidence.md#d03)。会话已结算而任务未记录结果时退出，检验两份日志对账后重新验收交付。

注册测试名：`LT-04C/D/F: real crash at session_run_settled`

- **初始任务：**同一小接口任务，真实模型已执行该片段。
- **执行步骤：**会话保存执行片段的结算事实，任务还没有提交对应 Run 结果时终止；新进程恢复并重新验收当前文件。
- **实际检查：**共同检查成立，最终交付成功，原输入不重复，Run 数不回退。
- **证明范围与边界：**证明任务可以与会话已提交的执行事实对账后完成交付。不能用这条 Run 断言推导准确的累计模型请求、token 或费用账本。

<a id="case-06"></a>
## 6. 验收附件已写，通过事件尚未提交时崩溃

**设计依据与合理性：**[D07：先提交再执行与权威日志完整性](../implemented/design-evidence.md#d07)。附件已写但事实未提交的强退，检验孤立文件不能授权阶段成功，恢复必须重验。

注册测试名：`LT-04C/D/F: real crash at verification_artifact_written`

- **初始任务：**同一小接口任务，真实验收已产生结果附件。
- **执行步骤：**附件同步后、任务 `verification_completed` 尚未提交时退出；宿主记录未被事实日志引用的附件 ID 和验收运行审计，再恢复。
- **实际检查：**共同检查成立；确实存在孤立附件；最终证据不引用这些孤立 ID；验收审计增加，说明恢复实际重新运行了验收。
- **证明范围与边界：**证明落盘附件不能自行授权成功，恢复必须取得新的已提交证据。不是断电或网络文件系统耐久性的验证。

<a id="case-07"></a>
## 7. 默认 write 已完成，工具结果尚未提交时崩溃

**设计依据与合理性：**[D04：未知副作用的核查门禁](../implemented/design-evidence.md#d04)。默认 write 的当前内容与 intent 摘要匹配，只按后置条件补结果，保留效果证明的边界。

注册测试名：`LT-04C/D/F: real crash at tool_effect_completed:write`

- **初始任务：**合同要求用默认 write 工具实现 `value() = 42`，intent 保存预期内容摘要。
- **执行步骤：**真实写入完成、工具结果尚未提交时终止进程；保持文件不变，启动恢复进程。
- **实际检查：**共同检查成立；会话中存在 `tool_recovery`，分类为 `observed_postcondition`，最终实际验收通过。
- **证明范围与边界：**证明默认文件工具能通过当前内容核对单文件后置条件，补齐恢复协议。内容匹配只代表当前状态符合预期，不是原操作全部效果的可信回执。文件不匹配与缺失分别见 [故障与补强](fault-hardening.md)。

<a id="case-08"></a>
## 8. 成功提交前更新合同：新版需求优先，命令只应用一次

**设计依据与合理性：**[D05：持久命令、合同版本与成功竞争](../implemented/design-evidence.md#d05)。更新在成功临界区抢先生效，并检查 ID 冲突与新版本证据，检验命令幂等和 CAS。

注册测试名：`LT-07A / LT-08D: durable update wins final-success race; dedup and CAS preserve usage`

- **初始任务：**小接口合同要求返回 42，当前最终验收已经通过，但成功尚未提交。
- **执行步骤：**在 `before_success` 屏障发布完整 v2 合同，要求返回 43，使用新的验收文件；同一命令重复投递；同 command ID 携带不同 expectedVersion 再投递；最后释放屏障。任务成功后另投递 cancel。
- **实际检查：**同 ID 不同内容被 `command_id_conflict` 拒绝；最终成功为版本 2、Run 数至少 2、全部最终证据绑定 v2；成功后 cancel 返回 `terminal_task` 拒绝。
- **证明范围与边界：**证明已发布更新能阻止旧合同成功，同一命令不会重复增加版本，终态后的命令可明确拒绝。完整合同由宿主提供；不是自然语言需求自动解析或请求预算验证。订单更新用例进一步检查暂停状态、Run 数保持和不同 ID 的过期版本冲突。

<a id="case-09"></a>
## 9. 两个独立恢复进程竞争同一任务

**设计依据与合理性：**[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。两个真实恢复进程争同一执行权，检验只有持权者能恢复和修改工程。

注册测试名：`LT-08C: two independent resume processes admit exactly one writer`

- **初始任务：**小接口任务在 Run 计划屏障退出，留下需要恢复的任务状态。
- **执行步骤：**启动两个独立 resume 进程；取得执行权的进程在屏障等待；宿主检查准入结果后释放胜者继续执行。
- **实际检查：**只有一个进程报告取得任务执行权，另一个以 `busy` 失败；胜者最终成功。
- **证明范围与边界：**证明这个同任务竞争场景中执行权互斥。该测试没有单独审计失败进程的模型请求数量，也没有在本场景构造“不同任务、不同状态目录共用同一工作区”的竞争；不能仅凭规格中列出该变体就扩大本条证据。

<a id="case-10"></a>
## 10. 最终验收通过后、成功提交前取消

**设计依据与合理性：**[D05：持久命令、合同版本与成功竞争](../implemented/design-evidence.md#d05)。最终门禁已通过仍在提交前取消，检验已发布用户控制优先于旧成功。

注册测试名：`LT-08D: cancel published after final verification prevents durable success`

- **初始任务：**小接口任务已完成实际验收，停在 `before_success`。
- **执行步骤：**宿主先持久发布 cancel，再释放成功提交屏障。
- **实际检查：**任务为 `cancelled`，没有最终成功证据引用，历史中仍能看到通过的验收证据。
- **证明范围与边界：**证明实际验收通过不会覆盖先发布的取消请求，成功提交遵守控制顺序。这个用例没有活动工具，工具父子进程的取消另由下面的场景检查。

<a id="case-11"></a>
## 11. 活动父子进程工具期间暂停

**设计依据与合理性：**[D05：持久命令、合同版本与成功竞争](../implemented/design-evidence.md#d05)、[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。活动工具期间投递暂停，工具获宿主释放并静止后才 applied，检验投递与安全边界生效分开；不证明立即中断任意工具。

注册测试名：`LT-08A/B: pause applies to a real active parent-child tool`

- **初始任务：**真实模型先调用 `hold-work`，启动前台父子进程并保持活动，然后实现小接口。宿主通过 PID / 心跳文件确认真实进程已经启动。
- **执行步骤：**另一真实任务 CLI 投递 pause；工具仍活动时检查收据；宿主释放等待工具；执行者到达安全边界后暂停并退出；新进程恢复。
- **实际检查：**工具活动期间收据仅为 queued / received；暂停状态和 applied 收据出现时，父子进程均已停止；恢复后任务成功，累计 Run 数增加。
- **证明范围与边界：**证明 pause 的投递与生效分开，允许当前工具完成后在安全边界暂停，并可跨进程续跑。宿主为该工具提供释放条件，不能据此认为 pause 会立即打断任意正在运行的工具。

<a id="case-12"></a>
## 12. 活动父子进程工具期间取消

**设计依据与合理性：**[D05：持久命令、合同版本与成功竞争](../implemented/design-evidence.md#d05)、[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。取消活动父子进程并重启仍不自动续跑，检验取消持久性与进程出口。

注册测试名：`LT-08A/B: cancel applies to a real active parent-child tool`

- **初始任务：**与暂停场景相同，真实父子进程已启动并处于等待。
- **执行步骤：**另一真实 CLI 投递 cancel；等待任务结束和 applied 收据；关闭执行进程，再从新进程尝试恢复。
- **实际检查：**状态为 cancelled，父子进程都已停止，命令收据 applied；重启恢复仍是 cancelled，Run 数没有增加。
- **证明范围与边界：**证明取消落实到真实前台进程组，持久取消不会因重启自动续跑。取消不回滚已经发生的文件或外部副作用，也不覆盖任意远程服务的取消能力。

<a id="case-13"></a>
## 13. 订单 M2 后暂停，更新为 20% 折扣再交付

**设计依据与合理性：**[D05：持久命令、合同版本与成功竞争](../implemented/design-evidence.md#d05)。订单暂停后从 10% 改为 20% 折扣，实际新版 CLI 产物和额度保留检验合同更新。

注册测试名：`LT-07A: pause orders after M2, CLI update to 2000bps, new process delivers version 2`

源码：[task-update.test.ts](../../tests/e2e/task-update.test.ts)。

- **初始任务：**[订单工程](cli-delivery.md)先使用 1000 bps 折扣；真实模型完成 M2 并通过验收。达到屏障前的模型连接错误允许有限显式恢复，不能把未达到屏障算通过。
- **执行步骤：**通过任务 CLI 暂停并退出；宿主提交要求 2000 bps 的完整 v2 合同及新验收文件。同 command ID / 内容重复提交两次；用另一个 ID 和过期版本提交一次；新进程显式恢复完成交付。
- **实际检查：**重复更新均返回 applied，但版本只增到 2；更新后仍 paused，Run 数与暂停时相同；另一个命令返回 `version_conflict`。最终独立 CLI 验收成功，实际 JSON 为 A `4980 / 996 / 3984` 分、B `30 / 6 / 24` 分，最终证据全部绑定版本 2。
- **证明范围与边界：**证明暂停更新不偷偷开跑、不重置既有 Run 数，命令去重和版本检查生效，最终产物按新版合同交付。新版需求与验收由宿主明确构造；任务并不要求模型自己推断新的验收标准。

<a id="case-14"></a>
## 14. LX-06：Linux 大小写身份与旧平台进程记录拒绝

**设计依据与合理性：**[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)、[迁移方案](../implemented/linux-only.md)。大小写目录必须独立；旧平台身份拒绝转换，不能误杀 Linux 哨兵。

注册测试名：`LX-06: Linux workspace identity is case sensitive; legacy Windows process facts block without killing or conversion`

源码：[platform.test.ts](../../tests/e2e/platform.test.ts)。详见 [LX-06 任务与验收](linux-only.md#lx-06)。

- **初始任务：**Linux 真实工作区 Project/project 各有 value 模块，公开 SDK 创建两个控制器；同一目录的第二控制器竞争同一执行权。
- **执行步骤：**关闭第一个任务，写入指向真实无关进程的旧 Windows Job Object 记录；公开恢复，检查拒绝后再移除注入记录并重新打开。
- **实际检查：**两目录可独立持有锁，同目录返回 busy；旧记录使恢复报 process_state_unknown；哨兵存活、原模块未改、模型请求零、日志未转换；清除注入后 Linux 恢复入口重新打开成功。
- **证明范围与边界：**验证 Linux 唯一平台的执行权身份和来源拒绝。此门禁必须零模型请求，业务交付另由真实模型回归；不提供旧 Windows 活跃进程迁移。原 Windows 专属用例的历史证据保留在阶段报告。
