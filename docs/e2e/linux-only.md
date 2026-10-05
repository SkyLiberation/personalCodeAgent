# Linux 唯一执行平台迁移验收

状态：2026-10-05 迁移时源码验收通过：66/66 契约、62/62 E2E 分组通过，0 失败/取消/跳过。完整报告 `.codeagent/linux-only-validation.json`；[已落地方案与源码](../implemented/linux-only.md)。

<a id="lx-06"></a>
## LX-06：Linux 工作区身份与旧 Windows 进程记录拒绝

**任务与初始环境：**Linux、Node 24、Python 3、Bash；公开 SDK 创建两个名称只差大小写的真实目录，各有待修复的 value 工程。独立控制器必须能同时取得两个工作区的执行权。同一目录的第二控制器必须被拒绝。

**步骤与检查：**关闭第一个任务后，在其 process-groups.jsonl 写入带完整校验链的旧 Windows Job Object 记录，PID 指向一个独立的真实哨兵进程；用公开 openTaskController 恢复。恢复必须报 process_state_unknown，哨兵仍存活、原文件未改、模型请求数为零、原进程记录未转换或改写。移除注入记录后能正常取得 Linux 执行权。

**证明范围：**Linux 大小写敏感目录保持独立；旧平台记录被显式拒绝，不能凭 PID 猜测迁移活跃进程或偷偷降级。此门禁要求零模型请求；模型交付由当前 CLI、恢复、暂停/取消、MCP、容器、长任务等真实模型回归验证。

**设计依据与合理性：**[Linux-only 方案](../implemented/linux-only.md)统一平台与 Bash 入口，身份来源先完整校验再恢复；拒绝旧身份能防止误清理无关 Linux 进程。

## 全量回归与规模验收

迁移时 62 个注册 E2E 中，以 LX-06 替换 Windows 专属测试，移除 Linux 测试的平台跳过条件。所有关键契约、TypeScript 检查及构建通过后运行当前源码的真实模型 E2E，保留配置、源码摘要、所有失败/重跑报告，逐注册名核查覆盖。Linux 锁竞争、硬退出、取消、超时、来源拒绝必须检查真实父子进程。

规模验证按 [V-SCALE](large-log.md#large-log-validation)先定义的多规模、重复样本、耗时/峰值内存与公开读/恢复/投影入口执行；生成事实只作为测量负载，不能冒充真实模型长期完成率。

本轮 A/B/C/D 各组分别 16/19/22/5 passed；门禁与真实模型路径都执行，未将注册数等同模型调用数。LX-06 最终证据 `.codeagent/e2e/run-Xogdpm/report.json`。Windows 专属例已删除并替换，历史阶段结果保留其原事实；迁移不转换旧 Windows 活跃进程。

后续历史检索与快照能力新增三个用例，当前注册数与最近源码回归见 [总览](README.md)；本页的 62/66 及源码摘要仍是迁移当时的事实。
