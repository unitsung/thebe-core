# 权限模型：一个模式设置，沙箱只是实现

状态：**已采纳（2026-10-14），部分实现。** 取代 `FULL-ACCESS-DESIGN.md` 和之前的 ADR 草案（三个维度加四个预设）。

## 背景

之前面向用户的有四套互不联动的开关：审批模式 `ask | read-only | full-access`（全局）、会话级“完全访问预设”（名字重复、含义更大）、场景预设 `THEBE_SCENARIO`（四个）、沙箱后端 `THEBE_SANDBOX`（五个），外加六七个环境变量。用户要的是别的 agent 工具里那样一个熟悉的设置，沙箱不该是让人去挑的东西。

别的工具的做法：Codex 内部是审批策略和沙箱范围两个旋钮，用户看到三档；Claude Code 是一个模式切换（manual〔旧称 default〕、acceptEdits、plan、auto、bypassPermissions）；opencode 是每个工具 allow/ask/deny，并明说权限系统不是沙箱。

## 决定

### 1. 一个设置，四个模式，名字用 Claude Code 的

| 模式 | 不问就执行 | 仍会询问或拒绝 |
| --- | --- | --- |
| `plan` | 工作区内读取 | 其余一律拒绝 |
| `manual` | 工作区内读取 | `bash`、`write`、`edit`、记忆与服务写入每次问 |
| `acceptEdits` | 工作区内 `write`/`edit`（不含 `.git`）；有沙箱隔离时的 `bash` | 命令守卫标出的、工作区外、没有沙箱的 `bash`、`memory`、MCP 与服务写入 |
| `bypassPermissions` | 一切，命令守卫与沙箱关闭 | 无；宿主门控 |

- 按会话保存（`AgentSessionMeta.permissionMode`），宿主默认值来自 `config.json` 的 `permissionMode`（默认 `manual`）。
- 只认这四个名字，不留别名；`config.json` 里的旧值按未设置处理（回到 `manual`），接口收到旧值返回 `400`。`POST /v1/session/{id}/full-access` 保留，等于开关 `bypassPermissions`。
- Claude Code 的 `auto`（由模型审批）没有做：见“不做”。名字不占用。

### 2. `acceptEdits` 的规则取自 Codex，不另造

Codex 的做法（`core/src/exec_policy.rs`、`core/src/safety.rs`）是：在受限沙箱下，没有被判为危险、也没有申请越出沙箱的命令不再询问，**让沙箱来拦**；文件补丁只有在所有路径都落在可写根内、且沙箱存在时才自动通过；工作区里的 `.git` 保持只读。Core 照此做，没有写“安全命令清单”：

- `bash`：有一个真正能强制隔离的沙箱后端时才自动放行；命令守卫没有标成 `dangerous`/`critical`；脚本能被 `tree-sitter-bash` 完整解析（解析不了就问，这比 Codex 更严）；并且 Codex 的危险命令检查（强制 `rm`，穿过 `sudo`、`env`、`trap` 和 `bash -c`/`-lc` 的任意嵌套）没有命中。没有沙箱就照常询问。解析用现成的 `web-tree-sitter` 加 `tree-sitter-bash`（opencode 与 Codex 用的同一个语法），危险命令检查是 Codex `is_dangerous_command.rs` 的移植，测试用例照搬 Codex 的（`src/agent/security/shell-parse.ts`、`dangerous-command.ts`）。
- `write`/`edit`：路径经符号链接解析后在工作区内、不在 `.git` 里，且命令守卫没有标出。
- 其余工具（`memory`、MCP、服务写入）永远不由 `acceptEdits` 放行。

代码：`src/agent/security/accept-edits.ts`（只做这一个判断），接入点是 `permission-control.ts` 的统一判定。

### 3. 判定顺序（`permission-control.ts`，`preflight` 与 `request` 共用同一套模式）

1. 策略拒绝（`critical` 命令）→ 拒绝；`bypassPermissions` 下命令守卫关闭，此步只剩工作区策略。
2. 记住的拒绝 → 拒绝。
3. `bypassPermissions` → 允许。
4. `plan` 且不是读工具 → 拒绝。
5. 策略允许或记住的允许 → 允许。
6. `acceptEdits` 且 `acceptEditsApproves` 为真 → 允许。
7. 非交互运行 → 拒绝；否则询问。

子代理、定时任务、后台目标、`/mcp` 调用方和非交互轮次取宿主默认值，不取会话自己的模式。

### 4. `bypassPermissions` 的不变量（承接 `FULL-ACCESS-DESIGN.md`）

默认关；只有宿主 `THEBE_FULL_ACCESS=on` 才能用，HTTP/App 客户端不能给自己开（`403 full_access_not_allowed`）；只对被设置的会话生效，不继承给子代理、定时任务、后台目标、`/mcp`、非交互轮次；审计照写；`GET /v1/session/{id}/permissions` 随时可见当前模式；只关命令守卫、沙箱和审批，不动脱敏和审计。

### 5. 沙箱：一个变量，请求了却没有就拒绝

`THEBE_SANDBOX=off|auto|bwrap|docker|seatbelt|gondolin`（默认 `off`）。`auto` 选这台机器能跑的后端。要了沙箱却没有这个后端时，**命令被拒绝**，不再悄悄不带沙箱地执行（`sandboxedCommand`）。网络在所有后端保持开启。

### 6. 环境变量精简

删除：`THEBE_SCENARIO` 及四个场景预设、`THEBE_COMMAND_GUARD`、`THEBE_ALLOW_WORKSPACE_ESCAPES`、`THEBE_SANDBOX_NETWORK`、`THEBE_SANDBOX_IMAGE`、`THEBE_SESSION_IDLE_TIMEOUT_MS`、`THEBE_MODEL_RESULT_LIMIT`、`THEBE_PIPELINE_ADVANCE_MS`。命令守卫、工作区约束和 Docker API 守卫始终开启，取原来的默认值；其余取原来的默认值。`scenario-profile.ts` 改为 `host-security.ts`，只剩沙箱选择。隔离报告里的 `scenario` 字段随之去掉。

## 不做（以及原因）

- **模型审批（Claude Code 的 `auto`、Hermes 的 `smart`、dsh 的 auto-review）**：每次调用多一次模型请求；审批模型会读到同样不可信的内容，被注入后同样会被骗；失败必须按拒绝处理；dsh 为此写了完整的风险分级与授权来源政策，仍标为实验性。以后可以作为 `acceptEdits` 里“本来要问你”那一小部分的可选附加项，默认关。Core 现有的 `judgment` 是调外部 jev 服务回答是非题，不适用。
- **Codex 的 `execpolicy`（Starlark 前缀规则，用户自己写 allow/prompt/forbidden）**：未做；没有现成的 JS 实现。`acceptEdits` 现在只用 Codex 内置的那一小段危险判断，加沙箱。
- **替换已有的 `command-risk.ts`**：它是自写的正则表，审计里已指出能被 `rm -r -f /`、`sh -c '…'` 之类绕过，仍留在命令守卫里（`critical` 直接拒绝、`dangerous` 询问），因为它的 NAS 专用规则（ZFS、`mdadm`、`docker.sock`）Codex 没有。`acceptEdits` 不再单靠它：真正让命令可以不问就执行的是沙箱。2026-10-15 起命令守卫先把脚本按 shell 解析（`parsed-command-risk.ts`），再交给这些正则：引号拆字（`r''m`）、拆开的参数（`rm -r -f`）、嵌套的 `sh -c`/`eval`、`$HOME` 与 `cd / && rm -rf *`、`find … -delete`、`curl … | sh`、读取密钥文件，都按实际执行的命令判定；解析器未加载或脚本解析不了时只用正则。它只会抬高判定，不会把任何命令判为安全。
- **沙箱内排除 Core 自己的配置和令牌目录**：可能影响依赖该目录的工具，未做。
- **网络开关**：随 `THEBE_SANDBOX_NETWORK` 一起去掉；需要隔离网络请用 `gondolin` 之外的容器级网络策略。

## 后果

- App 的“权限”从三个值变成四个，取值换成新名字；旧值经别名仍被 Core 接受，但旧版 App 读 `GET /v1/settings/permissions` 会看到新名字。
- 以前设了 `THEBE_SANDBOX=bwrap` 却没装 bwrap 的主机，命令从“照跑”变成“拒绝”，这是有意的。
- 以前依赖 `THEBE_SCENARIO`、`THEBE_COMMAND_GUARD=off`、`THEBE_SANDBOX_NETWORK=deny` 的部署，这些变量不再生效（默认值即原来的默认）。
