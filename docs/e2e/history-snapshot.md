# 历史检索与可信快照用例详解

状态：2026-10-05 四个注册场景执行通过；先定义具体任务和门槛，再设计实现。真实结果 `.codeagent/e2e/run-prUWzq/report.json`，SS-02 和 SS-01 最终补验 `.codeagent/e2e/run-O8AASP/report.json`。源码 [history-snapshot.test.ts](../../tests/e2e/history-snapshot.test.ts)。设计：[HR-01](../implemented/history-retrieval.md)、[SS-01](../implemented/snapshot-acceleration.md)。

<a id="hr-01"></a>
## HR-01：摘要后从已提交附件找回隐藏诊断

注册名：`HR-01: real task retrieves committed attachment after compaction and reopen inside isolated shell`。对应 [D18](../implemented/design-evidence.md#d18)。

公开任务 SDK 先通过 M1 调用真实诊断工具，输出含工作区关联路径及长诊断；随机 recoveryCode 位于超过工具输出截断水位的尾部，只存在宿主的真实附件。M1 验收后暂停并关闭；M2 在隔离 Docker shell 下重新打开，真实模型产生摘要，按工作区路径查询来源 entry ID，再分页读取绑定的附件，交付 lib/recovered.json。容器只挂载工作区，状态目录、原诊断脚本和附件不挂载。

M1 的宿主工具策略拒绝 history，恢复后拒绝再次调用原诊断工具，保证检索发生在摘要之后。独立宿主比对交付 recoveryCode；检查真实 history 调用及来源、分页、真实摘要记录和附件绑定，检索前的执行/摘要请求没有随机值；原日志与附件仍在。测试宿主验收文件，模型的完成声明不能代替成功。

**证明范围与设计理由：**只有受控历史入口可提供这一随机值，避免用摘要记忆或 shell 偷读替代检索。[HR-01](../implemented/history-retrieval.md)把当前会话、已提交引用、完整性与输出边界放在宿主，历史内容没有权限/验收权威。

<a id="hr-02"></a>
## HR-02：来源与附件门禁

注册名：`HR-02: public history rejects foreign orphan modified and symlinked sources without model dispatch`。对应 [D18](../implemented/design-evidence.md#d18)。

公开当前会话仓库和 history 工具查询真实文件：另一会话 entry、任意宿主绝对路径/越界路径、孤立附件、附件文件或目录符号链接、已绑定附件内容修改、超过分页上限、未知 session 字段都必须拒绝；不发起模型请求，不返回秘密。正确的工作区路径、来源 entry 及分页仍可读，重新打开仍保留绑定。

**证明范围与设计理由：**反例检验权限和来源边界；不是让 read 工具读取整个状态目录。[HR-01](../implemented/history-retrieval.md)的摘要后正向任务和本门禁共同验收。配置秘密在保存及分页前过滤，分页不拆开原始秘密。

<a id="ss-01"></a>
## SS-01：可信前缀复用、回退与真实续交付

注册名：`SS-01: bound snapshot suffix and fallback preserve quota; real model resumes updated delivery`。对应 [D19](../implemented/design-evidence.md#d19)。

公开 SDK 用真实模型完成 value=42 阶段验收后暂停，关闭写快照。对同一日志比较默认快照与禁用快照的公开读取；观测快照命中及折叠数量。保留旧但仍绑定的快照，再追加后缀，结果须与全量重放一致。E2E 的无缓存、坏 JSON、伪造成功/预算并重算缓存 hash、错误 reducer 版本均回退；[契约补充](../../tests/history-snapshot.test.ts)检查旧无绑定缓存与越界水位；前缀日志篡改仍拒绝，只有不完整尾部可修复。

提交新需求 value=43，从正常恢复入口继续真实模型交付；独立文件验收、合同版本、请求/Run/额度累计必须一致，快照不能制造成功或重置消耗。

**证明范围与设计理由：**[SS-01](../implemented/snapshot-acceleration.md)在权威日志内提交宿主状态摘要检查点，快照仅复用匹配前缀，后缀照常折叠；每次仍验证全链。命中观测和同配置时间/内存对照检验实际节省，反例防止快照绕过完整性。

<a id="performance"></a>
## 性能对照

同一份人工长日志，默认快照与 useSnapshot=false 各重复五次，记录全部样本、中位/范围、峰值 RSS、总记录/实际折叠数、配置和来源 hash。覆盖长状态日志与累计请求账本；人工预留不是实际模型请求，不当作工程成功率。保持完整校验，不声称 I/O 恒定。对应 [SS-01](../implemented/snapshot-acceleration.md)，历史 [V-SCALE](../implemented/large-log-validation.md)保留为旧实现观测。

<a id="ss-02"></a>
## SS-02：写入完成但同步失败，关闭不能追加过期检查点

注册名：`SS-02: postwrite sync failure prevents model dispatch and stale checkpoint on close`。追加前先定义此验收，实际已通过。

**初始任务和步骤：**公开任务 SDK 正常 start，真实请求预留已经 writeFile 到日志后，由宿主让该文件第一次 fsync 失败。真实模型适配器的分派计数必须为零，start 抛出持久化错误。解除同步故障后正常 close，任务权威日志必须保持故障发生后的原字节，不能按旧内存水位追加重复序号的检查点。公开读取须能验证日志并保留一条未知用量的请求预留，不能制造成功或返还占用。

**设计理由：**失败的写入确认意味着宿主内存状态可能落后于已出现的完整日志；缓存优化不能在失败 writer 后继续生成新的权威记录。对应 [D19](../implemented/design-evidence.md#d19)及 [快照关闭规则](../implemented/snapshot-acceleration.md#写入恢复与不变量)。此例控制真实文件同步边界，不伪造模型完成响应。

**实际结果：**约 0.085 秒，`.codeagent/e2e/run-O8AASP/snapshot-failed-writer/evidence.json`：模型分派 0、关闭后权威日志字节不变、保留请求预留 1。故障注入的是真实文件已完成 writeFile 后的 fsync，不是把整个写入操作都取消。

## 本轮观测与证据

HR-01 163.7 秒，诊断 1 次、成功 history 结果 3 条、模型累计请求 12，真实 JSON 独立验收通过；HR-02 0.11 秒且模型分派 0；SS-01 34.5 秒，32 条记录复用前缀 30 条、折叠业务后缀 1 条，合同更新后 Run 1→2、请求 4→8。每例工作区、日志和 evidence.json 均在上述 run 目录。

性能脚本 [snapshot-benchmark.ts](../../scripts/snapshot-benchmark.ts)完成 1k/10k/50k 状态与 1k/5k 累计预留，默认/禁用缓存各五次 read/open，报告 `.codeagent/snapshot-scale-AI3Z5n/report.json`。5k 账本 read 中位 1146.06→41.99 ms；50k 简单状态 read 558.14→546.96 ms，没有统一加速承诺。完整样本、内存、来源及限制见 [性能说明](../implemented/snapshot-acceleration.md#同日志性能对照)。旧格式夹具第一次回归失败及修复后真实重跑保留，见 `.codeagent/hrss-validation.json`。

后续坏缓存深度回退的最终源码 SS-01 补验约 40.9 秒通过：`.codeagent/e2e/run-Ff6LEd/report.json`，请求/Run/前缀指标相同；契约和上述五规模基准也重跑通过。首次基准 `.codeagent/snapshot-scale-ShN2Kk/report.json` 保留原样本与源码；全回归和增量补验分开记录。
