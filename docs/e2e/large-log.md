# 长日志规模验收

<a id="large-log-validation"></a>
## V-SCALE：长日志规模测量

**实际任务与入口：**在当前 `TaskRepository.read/open` 与会话投影入口，使用明确说明来源和生成方法的不同规模日志，重复测量读取、恢复、投影、峰值内存；快照优化实施后保存同配置对照。

**验收：**保留事实条数、字节数、配置、耗时分布和错误边界，不把人工负载当任意工程成功率；不只报告最佳样本。本轮增加 1000、10000、50000 条事实及前缀损坏/尾部修复检查，结果见下方。

**设计理由与状态：**完整日志校验和投影均随历史增长，需要规模测量确认成本；[已完成测量与设计](../implemented/large-log-validation.md#scale)。本项验证现有与后续性能，SS-01 另验证快照功能。

实际入口是 [large-log-validation.ts](../../scripts/large-log-validation.ts) 和 [large-log-boundaries.ts](../../scripts/large-log-boundaries.ts)，本轮执行通过；它们是性能/完整性检查，不注册为真实模型 E2E。任务状态重复事实与用户消息为人工生成负载，不证明大型工程交付成功率。

**证明范围：**公开 TaskRepository.read/open 和 SessionRepository.open/RequestContext.build 在所列规模能完成全量校验与投影；50000 条时修改前缀被拒绝，不完整尾部可以安全修复。快照参与加速仍由 [SS-01](../implemented/snapshot-acceleration.md)单独验收。

**设计依据与合理性：**[V-SCALE 测量设计与结果](../implemented/large-log-validation.md#scale)用同字段规模基线、五次完整样本和独立进程峰值衡量已有成本，明确冷缓存、真实工程、多工具状态与后续快照对照的边界。
