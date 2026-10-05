# 当前待办的验收规格

当前没有尚待落地的已承诺验收项，状态见 [唯一待办清单](../pending/README.md)。完成的验收保留在以下位置；新增待办必须先写具体任务、步骤、产物、正反验收和证明范围，再进入设计与实现。

| 已完成验收 | 详细用例 | 对应设计与报告 |
| --- | --- | --- |
| HR-01 / HR-02 | [摘要后检索与来源门禁](history-snapshot.md#hr-01) | [历史检索](../implemented/history-retrieval.md) |
| SS-01 / SS-02 | [可信快照续交付](history-snapshot.md#ss-01)、[失败 writer 关闭](history-snapshot.md#ss-02)、[性能对照](history-snapshot.md#performance) | [快照加速](../implemented/snapshot-acceleration.md) |
| V-WIN 的替代要求 | [Linux-only](linux-only.md) | [平台迁移](../implemented/linux-only.md) |
| V-SCALE | [长日志规模](large-log.md) | [规模报告](../implemented/large-log-validation.md) |

HR/SS 现有四个注册场景已纳入 [E2E 总览](README.md)，规模测量脚本没有作为额外模型测试计数。
