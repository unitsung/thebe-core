# 会话、自动总结与安全确认

## 会话记录存放位置

Thebe 默认把两类文件放在 `~/.thebe/sessions/`：

| 文件 | 所有者 | 内容 |
|---|---|---|
| `*.jsonl` | Pi runtime | 原始对话消息、工具调用、分支、模型和 thinking 变更、context compaction 摘要 |
| `<thebeSessionId>.json` | Thebe ProductStore | Thebe 与 Pi session ID 映射、标题、时间、标签、权限决定、自动任务摘要 |

实际路径可以通过以下方式查看：

- `/session`：显示当前 Pi session 文件、session ID、消息数和 token 使用量。
- `/history`：显示最近 10 条当前会话消息；`/messages` 和 `/message` 仍作为兼容别名。
- `/history all`：显示当前会话保存的全部消息。
- `/export`：把当前会话导出为 JSONL 和 HTML。
- `/resume`：搜索并打开已有会话；它只负责切换会话，不查看当前会话消息。

`THEBE_SESSION_DIR` 可覆盖 Pi transcript 目录，`THEBE_PRODUCT_STORE_DIR` 可覆盖 Thebe metadata 目录。默认情况下两者都是 `~/.thebe/sessions`，但文件名和职责不同。

## 自动总结与 context compaction

这是两个不同功能：

| 功能 | 触发条件 | 用途 | 保存位置 |
|---|---|---|---|
| Pi auto-compaction | context 接近模型窗口上限 | 压缩送给模型的历史上下文，让会话可以继续 | Pi session JSONL 中的 `compaction` entry |
| Thebe auto-summary | 一轮任务完成后用户持续空闲 | 生成便于人阅读的任务结果摘要 | Thebe metadata 的 `lastSummary`、`lastSummaryAt` |

Thebe 自动总结默认等待 120 秒，允许范围为 60 秒至 15 分钟。新输入、流式输出或正在运行的任务会重置或推迟计时。生成时会创建一个无 builtin tools、无 custom tools、禁用 auto-compaction 的内存 session；它只读取最多约 60,000 字符的近期 transcript，不会作为另一段对话持久化。

自动总结完成后，TUI 底部只显示一行浅色摘要，不写入输出 transcript，也不遮挡输出区。需要查看完整内容时使用 `/summary`。配置入口为 `/settings`；手动配置字段为 `autoSummary` 和 `autoSummaryDelayMs`。

## 会话删除

使用 `/delete` 删除当前会话，或用 `/delete <session id 或完整标题>` 指定会话。TUI 默认选中 Cancel，必须再次选择删除才能执行。

删除会同时清理当前内存 handle、自动总结 timer、Pi runtime transcript 和 Thebe metadata。运行中或正在等待权限确认的会话不能删除。

Pi transcript 会优先通过系统 `trash` 命令移入回收站；系统没有 `trash` 命令时会永久删除。Thebe metadata 当前直接删除，因此不要把 `/delete` 当成可保证恢复的归档功能。

## 工具安全与确认提示

当前需要确认的 Pi builtin tools 为 `bash`、`write` 和 `edit`。确认框默认选中 Deny，并提供 Deny、Allow once、仅允许完全相同请求、允许当前会话中该工具的所有请求、Allow this conversation 五种选择。

“仅允许完全相同请求”按工具名与参数 hash 精确记录在当前 session metadata 中；“允许所有请求”是当前 session 内的工具级决定；“Allow this conversation”使用 `*` 记录，允许该对话内所有 approval-gated tools。三者都不会跨 session 永久放行，且精确规则/工具规则优先于对话规则。高风险工具的工具级 Allow 会明确标注 high risk。未确认请求在 10 分钟后自动拒绝；非交互请求自动拒绝。权限 gate 加载失败时 session 创建失败，不能静默降级成无确认执行。

还可以使用 `/permissions` 或 `/settings` 切换审批模式：`ask`（默认，每次需要确认）、`read-only`（拒绝 approval-gated tools）和 `full-access`（自动允许 approval-gated tools）。`full-access` 只表示跳过 Thebe 的应用层确认，不创建操作系统沙箱；Pi 进程仍拥有它本身的系统权限。精确或工具级的显式 deny 仍然优先于 `full-access`。

其他安全边界：

- Thebe 对工具参数和事件摘要执行敏感信息脱敏。
- custom tool 输出用明确的数据标签包裹，降低把容器日志等不可信内容误当指令的风险。
- subagent 会移除 session 删除、递归 subagent、quiesce 等控制面工具。
- Pi 本身不是沙箱。确认提示只是应用层控制，不能代替容器、专用系统用户或 micro-VM 隔离。
- `defaultProjectTrust: always` 只控制项目资源加载，不限制工具权限；不应把它误认为执行沙箱。

## Subagent 实现状态

`/subagent spawn <profile> <task>` 创建的是一次性、内存中的 child runtime session。child 只收到 profile 指令和这一次显式 task，不继承父会话的 transcript、工具列表、标签、工作上下文或 active 状态；`inheritContext` 只为兼容旧 profile 保留，产品层不会读取它。

命令提交后立即返回 run ID，任务在后台队列执行。用 `/subagent list` 查看 queued/running/completed/failed/cancelled、turn 进度和任务，用 `/subagent cancel <runId>` 取消，用 `/subagent profiles` 查看可用 profile。完成后 Thebe 只保留 run 的结果和状态记录，不保留 child transcript；child session 会在成功、失败或取消后立即 dispose，因此不会出现在 `/resume`、`/messages all` 或普通 session 列表中。

每个 profile 的 `maxTurns` 会被限制在 1–50，默认 5；系统默认最多同时运行 3 个 child，同一父会话最多 2 个。child 的 `edit`/`write` 会被移除，`bash` 仍需通过父会话的确认机制；并发隔离指 runtime session、队列和状态隔离，不等同于操作系统级沙箱。

内置 profiles 包括 `diagnostics`、`log-analyzer` 和 `network-prober`，项目与全局 profile 可以覆盖同名内置配置。subagent 不能获得 `run_subagent`、`delete_session`、`interrupt`、`quiesce` 等保留控制工具。权限请求只显示在父会话中，取消 child 会自动拒绝它尚未处理的权限请求。
