# HR-01 / HR-02：受控历史与附件检索

状态：2026-10-05 已落地。先定义的 [HR-01 隔离交付](../e2e/history-snapshot.md#hr-01)和 [HR-02 来源门禁](../e2e/history-snapshot.md#hr-02)均执行通过；本文件从 pending 迁入，完成项已从 [待办清单](../pending/README.md)删除。对应 [D18](design-evidence.md#d18)。

## 问题、参考与选择

摘要可能省略重要细节，工具大输出又会截断。保存原始日志保证资料仍在，但工作区 read 不应获得整个私有状态目录的权限。因此增加宿主只读 history 工具，通过当前会话的已提交事实解析来源和绑定附件。LT-03 证明摘要记住信息，HR-01 补充证明摘要没有信息时仍能受控找回。

参考已核实的 [固定版本比较](optimization.md#参考实现和取舍)：pi Coding Agent 1.0.2（`b2b5c42`）原始 entry 与 compaction 投影分离；DeepSeek Harness 0.2.1-alpha.1（`5badb15`）追加事实、派生消息及 flush；[Hermes 会话存储文档](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/website/docs/developer-guide/session-storage.md)（`7653424`）完整历史、压缩代际与来源隔离。本工程采用来源化读取和原事实保留，继续使用 JSONL；不引入跨会话 FTS/SQLite，也不把 pi-ai 1.0.0 当作已集成整个 Coding Agent。

## 公开入口与返回契约

SDK `createAgentSession({ historyRetrieval:true, ... })` 或任务合同 `historyRetrieval:true` 显式注册工具，缺省关闭。Task CLI 使用同一合同字段。任务更新不能改变该执行权限，恢复核对工具版本；工具走现有 schema、toolPolicy/confirmTool、只读权限、完整工具批次和 Task 累计额度。

```typescript
const session = await createAgentSession({ cwd, config, historyRetrieval: true });
const sources = await session.repository.history({ path: "lib/result.json" }, signal);
const entry = (sources.entries as { entryId: string }[])[0]!;
const page = await session.repository.history({
  entryId: entry.entryId, attachment: true, offset: 0, limit: 4096
}, signal);
```

模型调用工具使用相同 JSON 参数，没有任意 sessionId、宿主路径或附件 ID 入口。

| 查询 | 作用与限制 |
| --- | --- |
| `path / start / count` | 工作区相对路径精确匹配已提交工具调用的 `arguments.path`，返回对应结果 entryId、工具名、256 字符预览及附件元数据；每页最多 5 条。路径只用于来源查找，不读取当前工作区文件 |
| `entryId / offset / limit` | 读取当前会话已提交的 message/input/inbox_consumed 文本；assistant 另返回工具参数，不返回 opaque providerData；每页最多 4096 个 JS 字符 |
| 同 entry 的 `attachment:true` | 只读该结果事实已绑定的完整附件，返回 totalChars 和 nextOffset；offset 相对过滤后的内容，不能当作字节偏移 |

返回 sessionId、当前 cursor、来源 entryId 和 `authority:"historical-data"`。旧资料不能授予权限，不能证明当前文件现状或验收通过。只匹配顶层 `arguments.path`，不是全文搜索或目录索引；分支只复制消息，未继承原会话附件授权。

## 附件来源与拒绝边界

真实工具输出超过 30,000 字符时，附件过滤秘密、写入并 fsync，然后将 id/bytes/SHA256 绑定到提交的 tool-result 事实；元数据不放进原生模型消息。仅当前仓库新签发的附件可绑定，孤立文件和旧文字中的“附件 ID”没有读取授权；重开后已提交绑定仍有效。

拒绝其他会话 entry、绝对/越界/私有路径、混合查询和未知字段。附件目录拒绝符号链接或非规范来源；最终文件以 O_NOFOLLOW 打开，仅接受有界普通文件，最大 8 MiB，字节数与 SHA256 必须匹配提交引用。分页前对完整内容再次过滤当前配置秘密，防止分页边界泄露原秘密；不是通用个人信息识别器。宿主状态目录仍是可信存储边界，不承诺抵御有权并发改写整个宿主目录的攻击者。

源码：[history 工具](../../src/tools/history.ts)、[查询类型](../../src/storage/history.ts)、[来源/附件仓库](../../src/storage/session.ts)、[有界读取](../../src/storage/guarded-file.ts)、[结果提交](../../src/runtime/agent.ts)、[SDK](../../src/harness/session.ts)、[任务注册与更新](../../src/harness/task-controller.ts)。

## 实际验收

`.codeagent/e2e/run-prUWzq/report.json`：HR-01 约 163.7 秒，真实 MiMo v2.6-flash、thinking off，12 个累计请求、原诊断调用 1 次、成功 history 结果 3 条。M1 归档后暂停并关闭；M2 重开产生真实摘要，在只挂载工作区的容器内查来源 entry，分页读取附件尾部随机 recoveryCode，独立验收实际 JSON。检索前摘要没有随机码，模型不能再次调用原诊断或从 shell 读取状态目录。

同报告 HR-02 约 0.11 秒，公开 SDK/仓库检查真实另一会话、孤立附件、文件/目录链接、修改内容、查询与秘密边界；明确 0 个模型分派。[关键契约](../../tests/history-snapshot.test.ts)补充重开读取、策略拒绝和分页。用例步骤及设计理由见上方两项 E2E；配置、源码摘要和失败历史统一记录于 `.codeagent/hrss-validation.json`。
