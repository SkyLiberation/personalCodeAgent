# 已落地设计与实现

这里保存已有源码和证据的能力。历史检索和快照已通过独立交付、拒绝及性能验收；[待落地清单](../pending/README.md)当前为空。

| 文档 | 作用 |
| --- | --- |
| [设计与 E2E 对应](design-evidence.md) | 当前设计选择、为什么合理、源码及逐用例反向引用 |
| [当前实现和实测](current.md) | 公开入口、SDK/CLI 使用、既有报告、失败修正及支持边界 |
| [架构研究与分层](architecture.md) | 固定版本研究和模块职责；历史接口草案以当前源码为准 |
| [长任务设计](long-tasks.md) | 合同、阶段、验收、恢复、预算与上下文；摘要后原文检索和检查点缓存都有独立设计及验收 |
| [Linux-only 迁移](linux-only.md) | 删除 Windows 兼容层、Linux/Bash 唯一执行及当前源码全量回归 |
| [长日志测量](large-log-validation.md) | 1000/10000/50000 条的重复测量、内存、来源和完整性反例 |
| [历史检索](history-retrieval.md) | 当前会话来源与附件绑定、分页、秘密和权限门禁及真实交付 |
| [快照加速](snapshot-acceleration.md) | 权威检查点、前缀复用、回退、累计额度与同日志性能对照 |
| [优化设计](optimization.md) | A–E 与扩展的取舍及对应验收；原问题表保留设计动机 |

实际任务从 [E2E 总览](../e2e/README.md)进入。每个详解都有设计依据；每个设计条目都有反向用例引用。本轮 73 项契约通过，新增 HR-01/HR-02/SS-01/SS-02 实际验收通过；66 个注册名的全回归和失败重跑见 [当前记录](current.md)。[Linux 迁移报告](linux-only.md)的 62/66 是此前源码记录。

## 历史阶段记录

| 记录 | 当时范围 |
| --- | --- |
| [初版](history/initial.md) | 循环、CLI、基础会话和编码工具 |
| [长任务第一阶段](history/phase1.md) | 宿主合同、阶段交付与失败反馈 |
| [恢复设计](history/recovery-design.md) / [恢复实现](history/recovery.md) | v2、对账、版本控制、执行权与保守迁移 |
| [补强](history/hardening.md) | 成功临界区、文件缺失及回执不可用 |
| [优化批次 A](history/optimization-a.md) | Linux 与模型请求账本、当时的未完成项和失败 |

历史记录不是当前待办。已完成待办应在达到 [迁出条件](../README.md#待办完成后立即迁移)的同一次更新中移入本区，补齐证据再加入本索引。
