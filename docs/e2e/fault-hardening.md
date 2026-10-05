# 故障、存储与补强用例

返回 [E2E 用例总结](README.md)。本页详细说明 9 个注册用例：故障 5 个、存储兼容 1 个、补强 3 个。本次整理未重新执行。

源码入口：[task-faults.test.ts](../../tests/e2e/task-faults.test.ts)、[storage-compat.test.ts](../../tests/e2e/storage-compat.test.ts)、[task-hardening.test.ts](../../tests/e2e/task-hardening.test.ts)。小任务和故障屏障的共用说明见 [恢复与控制](recovery-control.md)。

<a id="case-01"></a>
## 1. 已完成 write 的文件摘要不匹配

**设计依据与合理性：**[D04：未知副作用的核查门禁](../implemented/design-evidence.md#d04)。改变已写文件使摘要失配，恢复阻塞直到观测内容复原，检验效果证据不能猜测。

注册测试名：`LT-04F: current file digest mismatch blocks further model work until observable state is restored`

- **初始任务：**实现 `value() = 42`。真实 write 已完成，intent 中有预期摘要，工具结果还未提交。
- **执行步骤：**在写入副作用屏障退出执行进程；宿主保存已完成内容，再把文件改为返回 -1；新进程 resume；宿主恢复原内容后再次 resume。
- **实际检查：**内容不匹配时为 `blocked: effect_unknown`，Run 数与故障前相同；恢复原内容后任务成功。
- **证明范围与边界：**证明默认文件工具不会把任意当前内容解释为预期写入已确认。这里直接比较的是 Run 数，未单独审计实际请求 / 工具启动；更强的观测见 HT-02。匹配摘要也只确认单文件当前后置条件。

<a id="case-02"></a>
## 2. 验收程序不存在，修复合同后直接重验

**设计依据与合理性：**[D02：宿主验收驱动阶段与最终交付](../implemented/design-evidence.md#d02)。代码已完成但验收程序缺失仍不成功，合同修复后直接复验，区分不可用与业务失败。

注册测试名：`LT-09: missing verifier blocks actual completed code; explicit contract repair resumes without quota reset`

- **初始任务：**小接口任务的验收 command 指向不存在的可执行文件，同时宿主保留正确合同副本。
- **执行步骤：**真实模型实现接口后，控制器尝试验收；缺失程序导致不可用；关闭执行者，以 update 发布正确验收合同，再从新控制器 resume。
- **实际检查：**第一次为 `blocked: verification_unavailable`，没有最终成功引用；修复后版本 2 成功，Run 数与阻塞时相同。
- **证明范围与边界：**证明验收基础设施不可用不能被当作业务通过；恢复验收条件后可以重验已有产物，无需新 Agent Run。这里不是业务缺陷修复，也没有单独统计实际模型请求数；同 Run 数不替代请求账本。

<a id="case-03"></a>
## 3. 任务日志写入失败，首个模型请求前停止

**设计依据与合理性：**[D07：先提交再执行与权威日志完整性](../implemented/design-evidence.md#d07)。真实任务日志句柄闭合后零模型分派，检验必要持久提交失败不能放行外部动作。

注册测试名：`LT-09: actual closed task descriptor prevents first model request and leaves stop uncommitted`

- **初始任务：**小接口任务，网关包装真实 PiModelGateway，并直接计数 stream 分派；不提供模拟模型响应。
- **执行步骤：**`run_planned` 已提交后，故障钩子关闭真实任务日志文件句柄，使后续必要持久写入失败；调用 start 并从磁盘重新读取任务状态。
- **实际检查：**start 抛出 closed / EBADF / persistence_error；实际模型请求数为 0；磁盘任务仍为此前的 running，没有最终成功引用；保存请求数和故障证据。
- **证明范围与边界：**证明必要持久化失败时外部模型动作不被放行，系统不伪造“停止状态已落盘”。磁盘仍显示 running 是未能提交停止事实的结果，调用者必须处理返回错误；本用例不覆盖所有持久化故障边界。

<a id="case-04"></a>
## 4. 会话日志写入失败，首个模型请求前停止

**设计依据与合理性：**[D07：先提交再执行与权威日志完整性](../implemented/design-evidence.md#d07)。真实会话日志句柄闭合后零模型分派，检验输入交接另一侧的同一准入不变量。

注册测试名：`LT-09: actual closed session descriptor prevents first model request and leaves stop uncommitted`

- **初始任务：**与任务日志失败场景相同，使用真实网关分派计数。
- **执行步骤：**到 `input_accepted` 时关闭真实会话日志句柄，后续会话必要写入失败；执行 start，再读取已提交任务日志。
- **实际检查：**start 抛出持久化相关错误；真实模型请求为 0；磁盘任务仍为 running，没有成功引用。
- **证明范围与边界：**证明会话日志不可写也不能绕过准入门禁。它与任务日志失败是两个独立文件、两个提交时机，因此分别计数；请求已发出后中断、usage 缺失或恢复中的写入失败仍需其他用例。

<a id="case-05"></a>
## 5. 平台运行时缺失

**设计依据与合理性：**[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。缺失实际平台运行时而零请求、源码未改，检验后端不可用时没有较弱执行权降级。

注册测试名：`LT-08C: missing platform runtime refuses execution without a weaker lock fallback`

- **初始任务：**小接口仍返回 0；Windows host 使用不存在的编译器和专用空缓存目录，Linux host 使用不存在的 Python 解释器。
- **执行步骤：**通过公开 SDK 创建任务控制器，网关包装真实分派计数，捕获后端创建错误。
- **实际检查：**错误包含 ENOENT；模型请求为 0；原源码仍为返回 0。
- **证明范围与边界：**证明当前平台后端准备失败时拒绝执行，没有退化为较弱锁继续修改文件。Windows 验证编译器缺失，Linux 验证解释器缺失，两种实际初始化路径有独立条件；不能用一个平台的结果宣称另一平台也已运行。

<a id="case-06"></a>
## 6. 日志尾部、损坏、旧格式与迁移

**设计依据与合理性：**[D07：先提交再执行与权威日志完整性](../implemented/design-evidence.md#d07)。缓存删除、半条尾部、中间损坏及旧格式分别检验日志权威和保守迁移；不证明快照加速。

注册测试名：`LT-04E: real CLI repairs only incomplete tail, rejects corruption/future schema and preserves legacy logs`

源码：[storage-compat.test.ts](../../tests/e2e/storage-compat.test.ts)。这是一个注册用例，内含以下顺序执行的变体。

- **初始任务：**创建未启动的小接口任务，使用真实任务 CLI 查询和恢复；后续旧格式样本由真实已验收记录转换或未启动任务构造。
- **执行步骤：**删除 snapshot 缓存并追加半条日志，真实 resume；把中间事实改坏再 resume；改成未来 schema 再 resume；转换为已结束 v1 日志后 status / resume；构造没有可靠交接信息的活动 v1 日志后 resume；另建未启动 v1 任务与会话，在两份新迁移日志同步、manifest 尚未发布时强退，再恢复。
- **实际检查：**缺缓存和明确半条尾部可备份修复并实际成功；中间损坏及未来 schema 拒绝执行且原文保持；已结束 v1 可查询但不能按新版直接续跑；证据不足的活动 v1 返回 `migration_handoff_ambiguous`，不改原文；迁移发布前崩溃后仍读 v1，最终发布的 manifest 引用两份新日志和两个源文件，原始 v1 任务 / 会话内容保留，最终 v2 实际成功。
- **证明范围与边界：**证明缓存不是权威事实，修复只允许明确的不完整尾部，旧日志和迁移代际不会被不安全采用。旧格式是测试宿主构造的兼容样本，不是另一次真实旧版本模型运行；不证明所有历史版本或任意损坏都能自动恢复。多个内部变体仍只计一个注册测试。

<a id="case-07"></a>
## 7. HT-01：最终验收后、成功提交前源码变化

**设计依据与合理性：**[D02：宿主验收驱动阶段与最终交付](../implemented/design-evidence.md#d02)。第一次验收后到成功提交之间改源码，直接观测无成功及复验恢复，检验最终新鲜度。

注册测试名：`HT-01: source changed before success blocks stale evidence; restored source resumes without model work`

源码：[task-hardening.test.ts](../../tests/e2e/task-hardening.test.ts)。

- **初始任务：**真实模型实现 `value() = 42`，独立验收通过。网关直接计数真实模型 stream 分派。
- **执行步骤：**在 `before_success` 屏障把源码改成返回 -1；控制器结束后宿主独立运行验收；宿主手动恢复原来正确的源码，重新打开同一任务 resume 并独立复验。
- **实际检查：**源码变化后为 `blocked: verification_inputs_changed`，没有最终成功引用，独立验收确实失败；恢复文件后成功，实际模型请求数保持，独立验收通过。
- **证明范围与边界：**证明成功提交前需要再次核查当前证据，文件已经合格时可以只重验。与 LT-02 的差别是故障时机：LT-02 在 M3 验收之前注入业务回归并要求模型修复，本例在最终验收之后改坏源码，先阻止提交，再由宿主恢复文件。最后核查之后其他非协作进程仍可能改文件，成功不承诺工作区永久不变。

<a id="case-08"></a>
## 8. HT-02：恢复未结算 write 时目标文件缺失

**设计依据与合理性：**[D04：未知副作用的核查门禁](../implemented/design-evidence.md#d04)。未结算 write 的目标文件缺失时直接计数零新请求和操作，检验效果未知不能续修。

注册测试名：`HT-02/03: missing-file stays blocked until restored, with no new model request or repeated effect`

源码：[task-hardening.test.ts](../../tests/e2e/task-hardening.test.ts)。

- **初始任务：**真实模型 write 已把 `value()` 改为 42，结果未提交，模型分派审计已启用。
- **执行步骤：**副作用完成屏障终止进程；宿主把目标文件移走作为备份；另一进程 resume；再恢复原文件并显式 resume 同一任务。
- **实际检查：**文件缺失时为可恢复的 `blocked: effect_unknown`，没有最终成功引用；实际模型请求审计不增加，恢复日志没有新的工具启动；文件恢复后实际任务成功，模型请求审计仍保持。
- **证明范围与边界：**证明文件无法核查时保留未知状态并停止动作；条件恢复后能核对已有写入、重验，无需模型重做任务。相比摘要不符用例，这里直接观测请求和工具启动；不能推广为多文件事务或任意 shell 的副作用恢复。

<a id="case-09"></a>
## 9. HT-03：恢复未结算登记时回执查询抛错

**设计依据与合理性：**[D04：未知副作用的核查门禁](../implemented/design-evidence.md#d04)。实际 ENOENT 回执查询不能当未执行，恢复回执后审计仍一次，检验外部查询失败分类。

注册测试名：`HT-02/03: missing-receipt stays blocked until restored, with no new model request or repeated effect`

源码：[task-hardening.test.ts](../../tests/e2e/task-hardening.test.ts)。

- **初始任务：**真实模型执行 `record-delivery`，登记与回执已落盘，工具结果尚未提交；该工具每调用一次就追加登记，没有内部去重。
- **执行步骤：**在副作用屏障终止进程；宿主移走回执文件，使适配器读取时真正抛 ENOENT；新进程恢复；之后放回回执再显式 resume。
- **实际检查：**查询抛错后为可恢复的 `blocked: effect_unknown`，没有最终成功引用；实际模型请求不增加，恢复期间没有工具启动；回执恢复后任务成功，审计登记始终只有一次。
- **证明范围与边界：**证明查询适配器抛基础设施错误时也不会误判为操作未发生、盲目重放或永久 failed。与 LT-04A/B 主用例不同，那里适配器正常返回 unknown，这里真正抛出读取错误。恢复后可继续剩余模型工作，不要求恢复全过程请求数保持；只要求未知期间停止和原非幂等登记不重复。

## 与已有规格和结果的关系

[补强规格](history/hardening.md)定义 HT 三例及既有证据补强；[补强实现](../implemented/history/hardening.md)保存修复前失败、修复后分组结果和单次完整 29 / 29 记录。[第二阶段实现](../implemented/history/recovery.md)保存故障、兼容和平台的历史分组结果。上述步骤解释当前代码中的可执行检查，不将未拿到的历史日志或本次未执行的测试标记为新通过结果。
