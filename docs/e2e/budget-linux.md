# 请求预算与 Linux 执行用例

返回 [E2E 总结](README.md)。本组新增 9 个注册用例，代码见 [预算测试](../../tests/e2e/request-budget.test.ts) 与 [Linux 平台测试](../../tests/e2e/linux-platform.test.ts)。实际执行批次和报告见 [优化实施记录](../implemented/history/optimization-a.md)。

预算案例先使用 `value()` 小工程隔离协议边界，不代替六模块事件 CLI 的复杂任务基线。模型路径采用真实 MiMo；中断由宿主在公开测试入口的提交边界控制。

<a id="case-01"></a>
## 1. LT-05A：暂停、恢复和需求更新不清零请求额度

**设计依据与合理性：**[D08：累计资源准入与独立额度](../implemented/design-evidence.md#d08)、[D05：持久命令、合同版本与成功竞争](../implemented/design-evidence.md#d05)。暂停、恢复、更新合同仍共用同一请求额度，检验用户控制不能重置累计消耗。

注册测试名：`LT-05A: real request quota survives pause, new process and contract update; exhausted task can only reverify`

- **初始任务：**`value()` 为 0，合同要求 42，总模型请求上限为 1，可信验收器实际导入源码。
- **执行步骤：**独立 worker 发真实 MiMo 请求，在完整响应返回、结算前等待；宿主发布 pause，放行后确认 paused；退出进程，更新为要求 43 的 v2 合同，再由新进程恢复；最后宿主把实际文件修成 43，再次恢复。
- **实际检查：**暂停前已经预留 1 次；需求更新后 specVersion=2，状态预算耗尽，底层网关审计仍只有 1 次分派；宿主修正文件后独立复验成功，审计仍为 1。
- **证明范围与边界：**证明累计请求预算不随 pause、进程恢复和需求更新重置；额度耗尽仍可复验已有交付件。最终 43 是宿主写入，不能宣称 Agent 在无额度时自主修复新需求；也不证明 token/费用预算。

<a id="case-02"></a>
## 2. LT-05B：预留已提交，尚未分派即退出

**设计依据与合理性：**[D08：累计资源准入与独立额度](../implemented/design-evidence.md#d08)。预留已提交而请求未分派时强退，检验恢复保守保留额度而不退款。

注册测试名：`LT-05B: crash at model_request_reserved retains quota and unknown usage across actual process recovery`

- **初始任务：**同一返回 42 的实际工程，总额度为 1。
- **执行步骤：**worker 完成预留 fsync，在调用底层模型前被终止；新进程恢复任务。
- **实际检查：**底层分派审计为 0；原预留仍占 1 次，status=reserved、usage 缺失；恢复为预算耗尽，源码仍返回 0，无新模型请求。
- **证明范围与边界：**证明保守预留不因崩溃而返还；供应商实际调用为 0，但内部额度仍消费。这个变体不发模型，不能独立证明供应商联调。

<a id="case-03"></a>
## 3. LT-05B：真实请求已发，完整结果尚未结算即退出

**设计依据与合理性：**[D08：累计资源准入与独立额度](../implemented/design-evidence.md#d08)。请求实际分派后结算前强退，检验未知 usage 不能被当零或隐去请求。

注册测试名：`LT-05B: crash at model_request_dispatched retains quota and unknown usage across actual process recovery`

- **初始任务：**同上，额度为 1。
- **执行步骤：**底层网关审计后调用真实 MiMo，在观察到首个模型事件时进入 barrier，终止 worker，再由新进程恢复。
- **实际检查：**审计为 1；原预留 usage 未知；恢复不追加请求，状态为预算耗尽，文件仍返回 0。
- **证明范围与边界：**证明真实在途请求不能因会话里缺少完成消息而少计。`model_request_dispatched` barrier 在首个实际事件后触发，名称不表示精确的 TCP 发送瞬间；审计记录网关尝试，不能替代供应商账单。

<a id="case-04"></a>
## 4. LT-05B：完整响应已返回，结算前退出

**设计依据与合理性：**[D08：累计资源准入与独立额度](../implemented/design-evidence.md#d08)。完整响应已到达但结算事实未提交时强退，检验权威消费与响应观测边界。

注册测试名：`LT-05B: crash at model_response_received retains quota and unknown usage across actual process recovery`

- **初始任务：**同上，额度为 1。
- **执行步骤：**真实模型完整响应到达账本网关，但结算事实尚未提交时终止 worker，再恢复。
- **实际检查：**实际网关尝试为 1；恢复读取 reserved、未知 usage，不能启动新的请求；源码仍为 0。
- **证明范围与边界：**证明进程内收到 usage 不等于持久结算，未提交的响应工具不能执行。没有结算事实就保留未知用量，不从内存推断计费。

<a id="case-05"></a>
## 5. LT-05C：最后一个获准请求仍可完成交付

**设计依据与合理性：**[D08：累计资源准入与独立额度](../implemented/design-evidence.md#d08)、[D02：宿主验收驱动阶段与最终交付](../implemented/design-evidence.md#d02)。最后一个获准请求的完整写入可独立交付，检验耗尽判断不遗漏已准入批次。

注册测试名：`LT-05C: final admitted real model response can finish its tool batch and independently verified delivery`

- **初始任务：**`value()` 为 0，任务给出返回 42 的完整实现，并要求第一轮直接使用 write；额度为 1。
- **执行步骤：**SDK 发出真实 MiMo 请求，结算后执行响应工具；下一模型请求准入被拒绝；控制器仍调用独立阶段与最终验收。
- **实际检查：**实际网关调用为 1，文件包含 42，可信验收通过，任务 succeeded。
- **证明范围与边界：**证明额度最后一次准入包含完整响应工具批次，模型无需再写一句完成声明才能交付。两工具组成批完成由必要契约测试补充；不固定真实模型必须调用两次 write。

<a id="case-06"></a>
## 6. LX-01：Linux 执行锁与宿主硬退出

**设计依据与合理性：**[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。过期旁路元数据无法抢占 flock，宿主强退后父子进程先停止再复用 lease，检验所有权。

注册测试名：`LX-01: Linux kernel lease rejects stale takeover; owner crash stops actual parent and child before reuse`

- **初始任务：**真实 worker 持有 flock lease，另一个客户端准备竞争同一文件。
- **执行步骤：**将旁路元数据标为过期，竞争仍失败；worker 启动实际 Node 父子进程；硬终止 worker，等待新客户端取得同一 lease，并恢复进程日志。
- **实际检查：**旧元数据不能抢占；后继取得 lease 时，父子进程均无执行状态；原记录可核查。
- **证明范围与边界：**证明 Node 宿主退出后 bridge 先清理托管组再释放正常所有权。适用本地 Linux 文件系统，不证明共享目录跨机器锁；不覆盖工具主动 setsid 逃逸。

<a id="case-07"></a>
## 7. LX-02：取消、超时和正常父进程结束

**设计依据与合理性：**[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。取消、超时、父进程正常退出三个出口都观测子进程停止，检验托管组清理。

注册测试名：`LX-02: Linux abort, timeout and normal leader exit quiesce real descendants`

- **初始任务：**SDK 运行生成 PID 文件的真实父子进程，子进程持续运行。
- **执行步骤：**依次执行取消、超时、父进程正常 exit 三个出口。
- **实际检查：**取消抛错、超时保留 timedOut、正常退出不标超时；每个出口的父子进程均已停止。
- **证明范围与边界：**证明 exec 返回或取消结束时不遗留普通托管子进程；不以“父进程退出”冒充完整清理。Linux zombie 不执行副作用，观测区分 zombie 与运行进程。

<a id="case-08"></a>
## 8. LX-03：bridge 硬退出及进程身份核查

**设计依据与合理性：**[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。bridge 强退后按 PID/starttime 恢复且身份错误拒绝，检验不把 PID 当唯一身份。

注册测试名：`LX-03: dead Linux bridge is recovered by recorded identity; identity mismatch blocks without killing`

- **初始任务：**真实父子进程已启动，PID/starttime 已持久记录。
- **执行步骤：**从公开 `/proc` 信息定位并硬终止 bridge；后继取得 lease；用校验合法、starttime 错误的记录恢复，随后恢复原记录重试，最后执行新进程。
- **实际检查：**身份错误时 process_state_unknown，存活父进程未被盲杀；原身份确认后父子组停止，新进程才成功执行。
- **证明范围与边界：**证明锁自动释放并不足以直接运行新任务，必须先确认并清理旧效果；无法确认的存活组保持阻塞。不是对真实 PID 复用时间窗口做概率测试，而是确定性验证身份不一致的处理。

<a id="case-09"></a>
## 9. LX-04：进程日志无法提交，目标程序不能开始

**设计依据与合理性：**[D07：先提交再执行与权威日志完整性](../implemented/design-evidence.md#d07)、[D06：内核执行权与进程身份](../implemented/design-evidence.md#d06)。进程日志无法提交时实际 marker 不出现，检验执行前持久记录而非事后补账。

注册测试名：`LX-04: process journal write failure keeps the target behind its startup gate`

- **初始任务：**目标程序一启动就写 marker；进程日志父目录不存在，保证 append 失败。
- **执行步骤：**平台 SDK 准备进程组，尝试提交身份日志，持久化失败后终止准备进程。
- **实际检查：**exec 返回 ENOENT，marker 不存在。
- **证明范围与边界：**证明目标执行在身份日志提交之后；启动准备进程本身不等于业务效果已执行。不模拟断电或证明存储硬件 fsync 的物理可靠性。
