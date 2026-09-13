# 会话、自动总结与安全确认

## 会话记录存放位置

Thebe 默认把两类文件放在 `~/.thebe/sessions/`：

| 文件 | 所有者 | 内容 |
|---|---|---|
| `*.jsonl` | Pi runtime | 原始对话消息、工具调用、分支、模型和 thinking 变更、context compaction 摘要 |
| `<thebeSessionId>.json` | Thebe AgentStore | Thebe 与 Pi session ID 映射、标题、时间、标签、权限决定、自动任务摘要，以及有界的 Goal/子代理控制面结果 |

实际路径可以通过以下方式查看：

- 打开 TUI 时不会自动创建会话；没有指定 `--session` 或 `--continue` 时，首次发送消息（或执行明确需要会话的命令）才会创建会话。
- `/session`：显示当前 Pi session 文件、session ID、消息数和 token 使用量。
- `/history`：显示最近 10 条当前会话消息；`/messages` 和 `/message` 仍作为兼容别名。
- `/history all`：显示当前会话保存的全部消息。
- `/export`：把当前会话导出为 JSONL 和 HTML。
- `/resume`：搜索并打开已有会话；同时重新绑定 Goal/Tasks 状态，恢复已完成 Goal 的结论和已保存的子代理结果。完整对话消息仍由 Pi runtime transcript 提供。

`THEBE_SESSION_DIR` 可覆盖 Pi transcript 目录，`THEBE_AGENT_STORE_DIR` 可覆盖 Thebe metadata 目录。默认情况下两者都是 `~/.thebe/sessions`，但文件名和职责不同。

## 自动总结与 context compaction

这是两个不同功能：

| 功能 | 触发条件 | 用途 | 保存位置 |
|---|---|---|---|
| Pi auto-compaction | context 接近模型窗口上限 | 压缩送给模型的历史上下文，让会话可以继续 | Pi session JSONL 中的 `compaction` entry |
| Thebe auto-summary | 一轮任务完成后用户持续空闲 | 生成便于人阅读的任务结果摘要 | Thebe metadata 的 `lastSummary`、`lastSummaryAt` |

Thebe 自动总结默认等待 120 秒，允许范围为 60 秒至 15 分钟。新输入、流式输出或正在运行的任务会重置或推迟计时。生成时会创建一个无 builtin tools、无 custom tools、禁用 auto-compaction 的内存 session；它只读取最多约 60,000 字符的近期 transcript，不会作为另一段对话持久化。

自动总结完成后，TUI 底部只显示一行浅色摘要，不写入输出 transcript，也不遮挡输出区。需要查看完整内容时使用 `/summary`。配置入口为 `/settings`；手动配置字段为 `autoSummary` 和 `autoSummaryDelayMs`。

## Goal mode

`/goal <objective>` 会在当前会话中启动一个后台的、分检查点推进的长期目标。每个检查点都会创建一个只收到显式任务的 `goal-worker` child；worker 完成后再创建一个全新上下文、不提供 `edit`/`write` 的 `goal-reviewer` child。只有 reviewer 返回 `VERDICT: pass` 并提供有效 `EVIDENCE` 时才会判定完成，worker 自己的“已完成”文字不能直接结束 Goal。Goal 的状态、最终 reviewer report 和有界的子代理回放记录会保存到对应的 Thebe session metadata，因此重新启动 Product 后 `/resume` 仍能打开结果；保存的是控制面结果，不是 Pi transcript 的副本。

使用 `/goal` 或 `/goal status` 查看当前状态；`/goal pause`、`/goal resume`、`/goal stop`（也支持 `cancel`）管理运行；`/goal clear` 清理已结束的状态。Goal 启动后在后台运行，不自动打开全屏面板，父会话仍可正常输入和流式输出；若父 agent 正在输出，完成结论会排队到当前回复结束后再显示。Goal 完成、失败或取消后，worker/reviewer 的内存 runtime 会立即 dispose，最后一份 reviewer/worker report 作为 `finalReport` 保存，并在父 transcript 追加普通 Markdown 结论块（目标、结果、验证、剩余事项和报告），不再只显示一句 `Goal completed`。快捷键 `Ctrl+G` 切换统一 Tasks pane，`Ctrl+Shift+G` 直接打开当前或最近的 child transcript。Tasks pane 列出 worker、reviewer 和普通 subagent，提供明确选中态、turn 进度、最新 activity、任务预览以及 `Enter/click open` 提示；底部常驻一行可点击的 Tasks 状态，所以入口不会随 transcript 滚走。Goal child 通过 Product 的 subagent manager 创建，权限确认、审计、并发上限和一次性 dispose 仍然生效；child 不继承父 transcript。Goal worker 是唯一允许在正常审批下请求 `edit`/`write` 的内置 child 角色，仍不提供操作系统级沙箱。

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

命令提交后立即返回 run ID，任务在后台队列执行。用 `/subagent list` 或 `Ctrl+G` 查看 queued/running/completed/failed/cancelled、turn 进度和任务，用 `/subagent cancel <runId>` 取消，用 `/subagent profiles` 查看可用 profile。child runtime session 会在成功、失败或取消后立即 dispose，因此不会出现在 `/resume`、`/messages all` 或普通 session 列表中；控制面会保留有上限的 task prompt、activity trace、流式 response 和最终 result，并在终态写入父 session metadata，使完成后的 child 在恢复会话后仍可回放检查，而不是保留一个可继续对话的 child session。

每个 profile 的 `maxTurns` 会被限制在 1–50，默认 5；系统默认最多同时运行 3 个 child，同一父会话最多 2 个。普通 profile 的 `edit`/`write` 会被移除，`bash` 仍需通过父会话的确认机制；Goal worker 可请求写工具但仍必须经过相同确认机制。详情页的工具事件使用 `Tool · <name> · started/running/completed/failed`、`Input`、`Progress`、`Output` 标签，长工具输出默认只展示短片段并标记截断，避免输出区被原始 JSON 或文件全文淹没。并发隔离指 runtime session、队列和状态隔离，不等同于操作系统级沙箱。

内置 profiles 包括 `diagnostics`、`log-analyzer`、`network-prober`、`goal-worker` 和 `goal-reviewer`，项目与全局 profile 可以覆盖同名内置配置。subagent 不能获得 `run_subagent`、`delete_session`、`interrupt`、`quiesce` 等保留控制工具。权限请求使用父会话的确认菜单，但不再把完整参数 JSON 写进 transcript；取消 child 会自动拒绝它尚未处理的权限请求。详情页以 `Task prompt`、`Progress`、`Child response` 三段展示保留内容，支持方向键、`j/k`、PageUp/PageDown、Home/End 和鼠标滚轮；按 `Esc`/`q` 或点击右上角 `[x]` 返回 Tasks pane/父会话。
