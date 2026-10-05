# 工程文档

维护日期：2026-10-05。按文档职责和实际完成状态阅读；历史检索、快照加速、Linux 平台迁移与规模验证已落地；当前承诺范围内无待落地项。

| 区域 | 放什么 | 阅读入口 |
| --- | --- | --- |
| `e2e/` | 真实任务、初始问题、步骤、产物、验收、证明范围；每例引用对应设计 | [66 个已注册用例](e2e/README.md)、[待办验收规格](e2e/pending.md) |
| `pending/` | 尚未完成的设计或验证；明确当前缺口与迁出条件 | [待落地清单](pending/README.md) |
| `implemented/` | 已实现的设计、源码入口、使用方式、实际报告及边界 | [已落地索引](implemented/README.md)、[设计与 E2E 对应](implemented/design-evidence.md)、[实现与实测](implemented/current.md) |

`e2e/history/` 和 `implemented/history/` 保留原阶段规格及报告。历史日期的 planned、失败和平台结果保留原事实，当前待办统一以 `pending/README.md` 为准。

## 从设计到验收

阅读顺序是 **具体 E2E → 设计为什么这样选 → 实现 → 实际报告**。E2E 详解的“设计依据与合理性”链接到设计；设计页反向引用用例及其证明边界。测试通过只说明所列行为得到验证，不等于任意工程或所有故障都已覆盖。

历史检索与快照新增四个场景，当前共 66 个注册 E2E；关键契约 73 项通过。最近源码的分组回归和重跑统一见 [当前记录](implemented/current.md)、`.codeagent/hrss-validation.json`。已完成 [历史检索](implemented/history-retrieval.md)、[快照加速](implemented/snapshot-acceleration.md)、[Linux-only](implemented/linux-only.md)和 [规模验证](implemented/large-log-validation.md)。旧报告及失败历史保留原事实，注册数不等于模型分派数。

## 待办完成后立即迁移

1. 先在 `e2e/` 写明实际任务、入口、产物和正反验收，再在 `pending/` 维护设计；状态写清“未实现”“部分实现”“实现已有但未验证”。
2. 实现后执行对应验收，保存配置、报告、失败修正、源码版本和平台范围。模型相关能力必须有真实模型验证；失败或未执行时继续留在待落地区。
3. 同一次完成更新中，把待办设计文件移到 `implemented/`，补齐源码、用法、实际结果、设计理由及 E2E 反向引用，并更新已落地索引。
4. 从待落地清单删除该项，清理完成文件和过时状态；修复所有指向旧位置的引用。E2E 文档保留在 `e2e/`，标明真实注册名与结果入口。
5. 功能已实现但某平台或规模验证仍缺失时，将剩余验证单独留在待办，不能把整个能力继续标成未实现，也不能提前删掉验证缺口。失败记录归入实现记录或历史区，不改写成通过。

检查入口：`node --import tsx scripts/check-doc-links.ts`。目录规则与完成门槛同时写在 [文档维护规范](AGENTS.md)；工程的 E2E-first 要求见 [根规范](../AGENTS.md)。
