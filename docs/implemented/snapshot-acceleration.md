# SS-01：绑定权威日志的快照加速

状态：2026-10-05 已落地。先定义的 [SS-01 真实续交付](../e2e/history-snapshot.md#ss-01)、[SS-02 写入确认失败](../e2e/history-snapshot.md#ss-02)与 [同配置性能对照](../e2e/history-snapshot.md#performance)均通过；已从 [待办清单](../pending/README.md)迁出。对应 [D19](design-evidence.md#d19)。

## 问题、参考与选择

原 read/open 每次完整折叠事实，snapshot.json 只写不读；累计请求、证据和状态重建有重复开销。直接相信缓存自带 checksum 不够：缓存可自称成功、删除预算记录并重算摘要。因此宿主先把所生成状态的摘要提交权威日志，再接受与该检查点匹配的缓存。

参考 [固定来源比较](optimization.md#参考实现和取舍)：pi 与 DeepSeek 的追加事实/派生视图及持久提交边界、Hermes 的历史代际/来源分离。本工程保持 JSONL 检查点，不搬入其他框架或数据库；上游投影思路本身不能证明本工程缓存可信，具体绑定由下面的日志与拒绝用例验证。

## 写入、恢复与不变量

1. 关闭先等待 writer；若任何 append 未确认成功，停止新增检查点和缓存写入，释放句柄/执行权，避免用落后的内存 seq 覆盖已写入日志。健康 v2 宿主关闭仓库时，先提交并 fsync 私有 `state_checkpoint`：prefixSeq、prefixChecksum、reducerVersion、stateHash，进入同一校验链。公共 TaskFact/append 和模型工具不能创建检查点。
2. 再 fsync 临时快照并原子替换 snapshot.json，保存 snapshotVersion、reducerVersion、检查点 seq/checksum、stateHash 与状态。中断只留下检查点或旧缓存时仍可完整重放。
3. read/open 仍验证全部日志的任务 ID、顺序、事件 ID、类型与 checksum 链。缓存的任务/schema/reducer、水位与状态摘要都须匹配日志中的宿主检查点，才能复用前缀状态，后缀继续折叠。
4. 无缓存、坏 JSON、合法 JSON 但嵌套过深导致摘要计算失败、旧无绑定缓存、过期 reducer、错误水位、伪造成功/清零额度回退完整重放。落后但仍绑定有效检查点的缓存可复用；权威前缀损坏仍拒绝，只有不完整尾部按原规则备份和修复。

成功证据、合同版本、累计 Run/repair/request/token/活动额度来自同一权威前缀和后缀。v1 不生成或使用检查点，安全查询/迁移规则保持原契约。修改业务 fold 语义必须递增 REDUCER_VERSION，让旧缓存完整重放；已写入 [工程规范](../../AGENTS.md)。

## 公开诊断与边界

源码：[TaskRepository](../../src/storage/task.ts)、[校验链](../../src/storage/journal.ts)、[有界缓存读取](../../src/storage/guarded-file.ts)。默认 read/open 启用缓存，宿主可对照或观测：

```typescript
const state = await TaskRepository.read(dataDirectory, taskId, {
  useSnapshot: true,
  observeReplay: stats => console.log(stats)
});
const baseline = await TaskRepository.read(dataDirectory, taskId, { useSnapshot: false });
```

open 第五参数接受同一选项。observeReplay 返回 source、totalRecords、reusedRecords、foldedRecords，属于宿主诊断。缓存不参与模型或产品的成功判断。缓存读取拒绝最终文件符号链接、非普通文件和超过 64 MiB 的文件，并回退日志。

优化减少业务折叠，仍完整读取、解析与验链，不是常量 I/O。权限保护的宿主日志是信任根，现有未加密 checksum 不抵御有权重写整个日志和校验链的宿主。收益取决于状态重建复杂度，简单状态覆盖可以没有净收益。

## 真实续交付与反例

`.codeagent/e2e/run-prUWzq/report.json` 的 SS-01 约 34.5 秒：真实模型实现 value=42，宿主验收后暂停/关闭；旧绑定快照复用 30 条前缀，在 32 条完整记录中折叠 1 条业务后缀，与禁用缓存结果一致。坏 JSON、伪造成功/清零请求及错误 reducer 回退；前缀损坏拒绝，半条尾记录安全修复。

之后正常提交合同更新 value=43 并恢复真实模型交付，宿主独立导入实际文件检查值；specVersion=2，累计 Run 从 1 到 2、请求从 4 到 8。[关键契约](../../tests/history-snapshot.test.ts)补充无绑定缓存、越界水位、公共伪造检查点拒绝。LT-04E 也已重跑通过，但它只证明丢缓存可恢复，不替代命中与加速验收。

## 同日志性能对照

脚本 [snapshot-benchmark.ts](../../scripts/snapshot-benchmark.ts)，报告 `.codeagent/snapshot-scale-AI3Z5n/report.json`，保存五次样本、范围、峰值 RSS、日志/源码 hash 和命中/折叠数。Node 24.19.0、Linux，同一精确日志/缓存；每方法/模式独立 worker，样本间 GC、暖页缓存、有并发 E2E 负载。read 包含全链解析；open 包含 lease/尾部检查、不计 close，close 后在计时外还原原始字节。不是与不同源码的旧 V-SCALE 直接比较。

| 人工事实 | 数量 | read 完整→快照中位 ms | open 完整→快照中位 ms | read 峰值 RSS 完整→快照 MiB |
| --- | ---: | ---: | ---: | ---: |
| 状态覆盖 | 1,000 | 14.18 → 14.07 | 20.11 → 20.35 | 82.12 → 83.34 |
| 状态覆盖 | 10,000 | 123.16 → 110.65 | 154.81 → 149.51 | 206.92 → 202.52 |
| 状态覆盖 | 50,000 | 558.14 → 546.96 | 694.21 → 696.87 | 529.52 → 515.32 |
| 累计请求预留 | 1,000 | 41.16 → 9.56 | 14.45 → 11.08 | 85.02 → 79.85 |
| 累计请求预留 | 5,000 | 1146.06 → 41.99 | 1163.14 → 49.62 | 201.47 → 99.39 |

命中模式均复用 count+2 条记录，业务折叠 0；完整模式折叠 count+1 条事实。5,000 请求账本 read 约 27.3 倍、open 约 23.4 倍，体现累计映射重建/准入校验的节省；50,000 条简单状态例三轮没有稳定净收益，不能承诺所有长日志统一加速或降低内存。人工预留没有网络分派，不是 5,000 次真实模型轨迹，也不是工程成功率。

旧 [V-SCALE](large-log-validation.md#scale)保留原源码和报告。本轮全局验证与失败历史见 `.codeagent/hrss-validation.json`；[E2E 说明](../e2e/history-snapshot.md)反向解释每步如何支持绑定设计。

补充过深坏缓存回退后，73 项契约再次通过；SS-01 真实续交付再次通过，约 40.9 秒，`.codeagent/e2e/run-Ff6LEd/report.json`，Run/请求与前缀指标同上。上表是最终源码同配置重新测量；首次对照 `.codeagent/snapshot-scale-ShN2Kk/report.json` 的全部样本和源码摘要也保留，没有用新值覆盖旧报告。

最后追加 SS-02 真正的 postwrite/fsync 故障验收，约 0.085 秒通过；正常 SS-01 同次约 26.8 秒通过：`.codeagent/e2e/run-O8AASP/report.json`。同步故障后分派 0、日志在关闭后不变、未知请求仍占用 1；恢复读取不制造成功。最终 73 契约也再次通过。

最终 writer 关闭修正后的源码基准为上表 AI3Z5n。第二轮 `.codeagent/snapshot-scale-mFUCnR/report.json` 也保留；三轮均见累计账本明显受益，而简单状态 50k 的 read 增减方向不同、open 无稳定收益，不应据单轮小差值宣称统一改善。
