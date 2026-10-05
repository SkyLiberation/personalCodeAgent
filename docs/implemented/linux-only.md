# Linux 唯一平台迁移方案

状态：2026-10-05 已落地并完成迁移时源码 Linux 验收；先定义的用例在 [Linux-only E2E](../e2e/linux-only.md)。用户明确要求删除 Windows 兼容层；V-WIN 由这一迁移验收替代，不再要求 Windows 运行。

## 选择与原因

参考本工程已核实的 [pi、DeepSeek Harness、Hermes 固定源码与比较](optimization.md)：沿用 append-only 事实、宿主独立验收与有限恢复，平台执行与模型循环分离。上游会话机制不提供本工程跨系统进程身份转换的保证。统一 Linux 后维持原先 Linux 的 flock、subreaper、启动门禁、boot/PID namespace/starttime 校验；不将 Windows Job Object 身份改造成 Linux PID。

删除 WindowsHost、C# bridge、PowerShell 工具 schema、taskkill 与 Windows spawn 标志；公共 ExecutionHost 自己定义租约和进程结果，只创建 LinuxHost。SDK 普通会话、MCP 与任务在不支持的平台启动前拒绝。shell 仅接受 Bash，旧 PowerShell 参数不能静默当成 Bash 执行。工作区租约按规范化 Linux 路径精确区分大小写。

[LX-06](../e2e/linux-only.md#lx-06)验证公开入口的大小写身份、旧平台来源拒绝与无误清理；[Linux 后端四例](../e2e/budget-linux.md#case-06)验证真实执行权、父子进程静止、bridge 崩溃与启动日志门禁；全部当前 E2E 回归覆盖真实模型链路。旧阶段报告保留历史 Windows 事实，但当前使用说明和待办必须指向新政策。

完成结果：TypeScript 检查、构建、66 项关键契约及全部 62 个 E2E 分组通过；V-WIN 的验收要求由 Linux 唯一平台迁移替代，未宣称 Windows 测试通过。旧平台待办已删除。日志格式 v1/v2 的安全恢复规则仍独立存在；平台迁移不转换旧系统的活跃进程。


## 迁移源码与真实验收

公开工厂 [host.ts](../../src/platform/host.ts) 自己定义通用接口并只构造 [LinuxHost](../../src/platform/linux.ts)，使用 [Python bridge](../../src/platform/linux-host.py)。[LocalEnvironment](../../src/environment/local.ts)、[coding-tools](../../src/tools/coding-tools.ts)、[MCP](../../src/tools/mcp.ts) 统一 Linux/Bash；[工作区执行权](../../src/harness/task-controller.ts) 按精确规范化路径生成租约键。package.json 声明 os=linux；非 Linux 执行入口拒绝启动。WindowsHost、C# bridge、PowerShell 参数、taskkill 和 Windows spawn 选项已删除，没有别名或降级后端。

TypeScript 检查与构建通过，66/66 关键契约通过。迁移时 62 个注册 E2E 的四组均独立完成：A 16、B 19、C 22、D 5，全部 passed、0 failed/cancelled/skipped；LX-06 使用独立验收脚本目录后又定向通过。配置为 Node 24.19.0、MiMo v2.6-flash、pi-ai 1.0.0、thinking off、输出 8192；每例原有轮次、合同、隐藏 seed 与故障门槛保留。不是同一次串行全套，也不代表重复运行完成率。

完整逐注册名、源码/报告 SHA256、公共配置、分组日志与遗留诊断在 `.codeagent/linux-only-validation.json`。主日志 `.codeagent/linux-only-e2e-a.log` 至 `linux-only-e2e-d.log`；契约 `.codeagent/linux-only-contracts.log`，编译 `.codeagent/linux-only-typecheck-final.log` / `.codeagent/linux-only-build.log`。全部实际产物和事件保留在 `.codeagent/e2e/run-*`。新工具脚本曾有一次方法名编译错误、一次 metrics 缺 task-id 调用，均修正并保留原诊断；本轮实际 E2E 无失败。

迁移用例 `.codeagent/e2e/run-Xogdpm/report.json`；六模块自然结束/批次让出/摘要与重规划联合任务 `.codeagent/e2e/run-9VChYC/report.json`；三个固定 seed 137/271/809 的独立验收、并发上限和依赖启动 `.codeagent/e2e/run-px8tBT/report.json`。联合任务还检查真实摘要包含早期标签、连续注入回归后恰好一次重规划，以及容器内的实际交付。

[长日志验证](large-log-validation.md#scale)同时完成 1000/10000/50000 条、每种操作五次的测量和 50000 条完整性反例。后续 [历史检索](history-retrieval.md)和 [快照加速](snapshot-acceleration.md)已完成独立验收；新源码回归总账 `.codeagent/hrss-validation.json` 与本次迁移报告分别保留。

## 运行与支持边界

仅 Linux，需要 Node 24、Bash、Python 3，以及 flock/subreaper/可读 `/proc`；可选容器执行要求本地 Docker。运行 `pnpm check`、`pnpm test`、`pnpm test:e2e`；真实模型测试需要配置模型密钥，云端代理保留 CA 并启用 NODE_USE_ENV_PROXY=1。

LX-06 证明旧 Windows 进程日志明确拒绝且不误清理无关 Linux 进程；不自动转换旧平台活跃任务。历史报告保留其原平台事实；现有会话日志 v1/v2 格式规则与平台兼容层独立。设计反向引用 [迁移验收与证明边界](../e2e/linux-only.md#lx-06)、[D06 对应的真实进程用例](design-evidence.md#d06)。
