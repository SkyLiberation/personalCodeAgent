# V-SCALE：长日志耗时与内存测量

状态：2026-10-05 在 Linux 完成现有实现的规模测量与完整性反例，已从待办迁出。[先定义的 E2E 验收](../e2e/large-log.md#large-log-validation)。后续快照加速属于独立的 [SS-01](../implemented/snapshot-acceleration.md)。

<a id="scale"></a>
## 方法与取舍

通过公开 append 接口形成 1000、10000、50000 条带校验链的 Task 事实和相同数量的会话消息；Task 第一条是创建事实，其余为 pending 状态诊断，Session 为 512 字符用户消息。没有模型调用、工程执行或大量验收/附件状态。这是日志扫描与投影负载，不能当作实际工程长期成功率。

投影使用 soft=500000000、hard=1000000000 的估算阈值，保留完整历史以测加载和投影；禁止网关发起模型请求。该配置只用于测量，不代表供应商支持这一上下文，也不测 50000 条下自动摘要的成本；真实摘要另由 [联合用例](../e2e/advanced.md#case-20)验收。

1000 条是同字段、同路径、同当前完整重放实现的规模基线；只增加条数。每种规模/操作使用独立 Node 进程，各测五次并保留全部样本；样本间主动 GC，操作仍完整读取、验证摘要链、重建状态。未清理系统页面缓存，均为暖读；不提供冷启动、网络盘或历史快照优化前后对照。后续加速须在同配置重测。

Linux 6.18.44、Node 24.19.0、Python 3.12.14、Bash 5.2.37，cgroup 4 CPU / 16 GiB；同时有 E2E 运行，结果是该环境下的观测。Task.open 包含获取租约/加载/关闭与写快照，Session 投影包含 open/完整加载/build/close。峰值 RSS 是整个独立测量进程的寿命峰值，包含启动与 GC 前样本，并非一次调用净分配。

源码：[测量脚本](../../scripts/large-log-validation.ts)、[完整性脚本](../../scripts/large-log-boundaries.ts)、[Task](../../src/storage/task.ts)、[Session](../../src/storage/session.ts)、[投影](../../src/harness/context.ts)。原始配置、每次耗时与 RSS、源码 SHA256、人工负载路径见 `.codeagent/large-log-Cpl0Nc/report.json`；运行日志 `.codeagent/linux-only-scale.log` 与 `.codeagent/linux-only-scale-boundaries.log`。

## 实测

| 条数 | Task / Session 日志 MiB | 操作 | 中位耗时 ms | 五次范围 ms | 进程峰值 RSS MiB |
| --- | --- | --- | --- | --- | --- |
| 1000 | 1.32 / 0.84 | task-read | 13.83 | 13.15–19.62 | 79.18 |
| 1000 | 1.32 / 0.84 | task-open | 37.64 | 31.98–46.77 | 88.49 |
| 1000 | 1.32 / 0.84 | session-open-project | 19.21 | 17.02–23.83 | 88.25 |
| 10000 | 13.23 / 8.38 | task-read | 126.22 | 107.81–151.89 | 177.95 |
| 10000 | 13.23 / 8.38 | task-open | 268.06 | 217.79–306.91 | 193.30 |
| 10000 | 13.23 / 8.38 | session-open-project | 159.55 | 126.85–179.69 | 243.22 |
| 50000 | 66.21 / 41.99 | task-read | 539.84 | 519.04–1072.36 | 414.84 |
| 50000 | 66.21 / 41.99 | task-open | 1084.18 | 1061.34–1183.96 | 562.35 |
| 50000 | 66.21 / 41.99 | session-open-project | 734.88 | 685.35–836.55 | 665.12 |

完整性反例在 50000 条数据上执行：Task 前缀修改同时被 read/open 拒绝，Session 前缀修改被 open 拒绝；两种日志只修复明确不完整尾部，原权威日志最终恢复。即使 snapshot.json 存在也不能绕过前缀摘要检查。测量检查结果 passed，模型请求零。

规模增加会同时增加时间和内存；这完成 V-SCALE 对现有实现的观测，未实现 SS-01，也不说明历史成本恒定、全部日志形态或真实大型工程稳定成功。

## 重复运行

```bash
node --import tsx scripts/large-log-validation.ts
node --import tsx scripts/large-log-boundaries.ts /path/to/generated/report.json
```

首条命令输出本次数据路径，保留三个规模全部样本。生成日志和测量隔离于 `.codeagent/large-log-*`，不改实际任务。设计反向引用 [规模验收与证明边界](../e2e/large-log.md#large-log-validation)。
