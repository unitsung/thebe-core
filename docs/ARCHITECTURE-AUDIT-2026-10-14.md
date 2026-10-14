# Core 架构审计与重做计划（2026-10-14）

起因：用户指出 Core 是用较弱的模型写的，摘要、审批、沙箱、守卫都像“随手写的”，要求对照 Codex、deepseek-harness（dsh）、Hermes、Pi 的做法重新审视。同一天用户还要求直连路由经 Core 开放 bash；本文也回答 bash 现在能不能做。

这份文档只写**读到的证据**和**拟定的方案**。没动代码。没读到的地方写“未核实”。

## 1. 先说结论

- **模块边界没有问题。** 269 个源文件、122 个测试文件；`src/agent` 没有 import `adapters` 或 `delivery`，`adapters` 也没有 import `delivery`；`as any` 只有 1 处、`@ts-ignore` 0 处、TODO/FIXME 0 处、`as unknown as` 22 处。AGENTS.md 写的分层确实被遵守。所以“整体架构烂掉”这个判断，**在边界和类型卫生上找不到证据**。
- **问题集中在“安全”和“上下文”两块，而且是深度不够，不是方向错。** 它们是按“先有一个能用的”写的：守卫是 46 条正则，沙箱是拼命令字符串且默认关闭、不可用时退回裸命令，审批有五套并存的机制，自己的“摘要”只是空闲后的一次性转写。
- **我只读了边界、体量和这几块，没有逐个子系统读完**，不能说其余部分没问题。第 6 节列了还没看的。

## 2. 现状与参考的对照

### 2.1 命令守卫

**Core（`src/agent/security/command-risk.ts`，757 行）：** 46 条正则模式表，对整条命令字符串匹配，分 safe/caution/dangerous/critical；critical 无条件拒绝，dangerous 要人确认；另有工作区逃逸检测。不解析 shell 语法，所以 `a && b`、`$(...)`、管道、引号里的内容都是靠正则碰运气。

**参考：**

- **Codex**：`codex-execpolicy` 是单独的策略引擎，规则是 `prefix_rule(pattern, decision=allow|prompt|forbidden, justification, match, not_match)`，`match`/`not_match` 是**加载时校验的示例**（规则自带单元测试）；可执行文件还能用 `host_executable` 限定允许的绝对路径。另有 `shell-command` crate（`bash.rs`、`parse_command.rs`、`command_safety/`）负责解析命令，`core/src/safety.rs` 把结果归为 AutoApprove / AskUser / Reject。
- **Hermes**：`tools/approval_detection.py` 把 **hardline（绝不放行）和 dangerous（要问）分开**；`approval_floors.py` 是进审批前的硬地板：用户自己的 deny 规则、永久允许名单、sudo 读密码拦截；还有“拒绝熔断”（连续被拒后提醒模型）和用小模型做的 smart 审批。

**差距：** Core 没有“规则 + 示例自检”，没有 shell 解析，没有 allow/prompt/forbid 三态的可配置规则，hardline 与 dangerous 没有分层。

### 2.2 沙箱

**Core（`command-sandbox.ts`）：** bwrap / docker / seatbelt / gondolin 四种，但 bwrap/docker/seatbelt 是**把命令包成一条字符串**（`buildBwrapCommandString` 等）；默认 `off`；所选模式在本机不可用时**退回裸命令，只给一个 warning**（失败开放）。

**参考：**

- **dsh**：沙箱是单独的 `sandbox-policy`（模式 `read-only`（默认）/`workspace-write`/`danger-full-access`，每个会话可单独切换，切换写进会话日志），所有受限能力（bash、文件、终端）共用同一个策略，**不会各自漂移**；bash 的结果里带 `sandbox: { mode, denied }`，拒绝是**结果里的事实**，不会悄悄重试，模型可以带上升级请求重试同一条命令。
- **Codex**：沙箱是独立 crate（`linux-sandbox`、`sandboxing`、`windows-sandbox-rs`、`network-proxy`），审批策略与沙箱策略是**两个正交的维度**。

**差距：** 失败开放；没有“拒绝是结果事实”；没有每会话切换并记录；网络隔离只有开关。

### 2.3 审批

**Core：** 至少五套机制并存，彼此不共享决策记录：

1. Pi 的 `tool_call` 钩子加会话权限请求（`mcp-extension.ts` 里的 `permission.preflight/request`）；
2. `POST /v1/action` 的设备端审批加回执（`action/service.ts`，目前只支持容器重启）；
3. `service_api` 的两阶段预览加一次性确认令牌（`control/service.ts`）；
4. 能力 HTTP 入口统一返回 403 `RUNTIME_APPROVAL_REQUIRED`；
5. 会话 `fullAccess` 预设和“记住的权限”（`remembered-permissions.ts`、`full-access.ts`）。

**参考：** dsh 的 `user-approval` 只有一个“一次性决定”接口（`ask` 或 `never`，沙箱、bash 都走它，回答方可组合），`permission-presets` 把“沙箱模式 + 审批策略”捆成命名预设（`workspace-write` + `ask`、`danger-full-access` + `never`），用户只看到一个 Permissions 选择器。Hermes 的审批拆成 detection / floors / prompt / gateway wait / smart 几个文件，状态集中在一处。

**差距：** 没有统一的策略层；预设只有 `fullAccess` 一个开关。

### 2.4 摘要与压缩

**Core：** 自己的 `auto-summary.ts`（192 行）只是**空闲一段时间后**，取最近最多 6 万字符的转写，让模型写一份会话摘要，不进入对话。真正的“上下文压缩”交给 Pi（`autoCompact` 开关），Core 不控制阈值、保留量、工具结果修剪。

**参考：**

- **dsh** `compaction-basic`：阈值比例（默认 0.8）、保留比例（0.16）、可按模型单独配；压缩前先由 `tool-result-pruner` 把超大工具结果裁成“头 4096 + 中间省略标记 + 尾 1024”字符；上下文溢出报错后自动恢复；`/compact` 手动触发。
- **Codex** `core/src/compact.rs`（916 行）加 remote、token-budget 等变体，压缩也走 pre/post hooks，并有 `ContextCompaction` 回合条目。
- **Hermes** `context_compressor.py`：小的辅助模型总结中段、**头尾保护**、迭代式摘要、先修剪工具输出。

**差距：** Core 把“会话回顾”和“上下文压缩”混成一个词；压缩参数不可控；没有溢出恢复；工具结果修剪只有一个可选的 `THEBE_MODEL_RESULT_LIMIT`。

### 2.5 其他读到的结构问题

- `src/agent/internal/context.ts`（995 行）、`src/agent/control/service.ts`（930 行）是两个大杂烩；`invokeCapability` 里按能力 id 硬编码分支（`STRM_REPAIR`、`CONTAINER_RESTART`、`NAVIDROME_WRITE_TOOL_NAMES`…），新增能力要改这里。
- `src/delivery/http/openapi.ts` 2470 行手写，和路由实现靠人工保持一致。
- 权限放在会话**标签**里（`thebe.webSearch`）：标签是自由文本，不是权限模型。今天我自己也沿用了这个做法，应当改掉。
- 好的部分：Pi 在 `AgentRuntime` 接口后面，不泄漏到 `agent` 层；审计日志是追加式；`redactToolOutput` 统一脱敏；测试多。

## 3. 重做计划（拟定，未开始）

按依赖顺序，每一步独立可交付、独立测试：

1. **权限模型（先写 ADR，再写代码）。** 沙箱模式（`read-only` / `workspace-write` / `danger-full-access`）和审批策略（`ask` / `never` / 之后的 `auto`）做成两个正交设置，加命名预设；每会话可切换并记入会话日志；`fullAccess` 变成其中一个预设。参考 dsh `permission-presets` 与 Codex 的 approval × sandbox。
2. **命令守卫。** 先引入 shell 解析（拆复合命令、管道、`$(...)`），再引入 Codex 风格的 `prefix_rule`（allow / prompt / forbidden，带 `justification`、`match`/`not_match` 自检）。现有 46 条正则降级为 **hardline**（Hermes 的分法），不再当主要机制。
3. **沙箱改为失败关闭。** 所选模式不可用就**拒绝执行并说明**，不再退回裸命令；结果里带 `sandbox: { mode, denied }`；拒绝是事实，模型可带升级请求重试（dsh）。
4. **审批合一。** 一个审批服务、一种决策记录；会话内、设备端、两阶段令牌只是三种“回答方”。审计里每个决定都有同一种记录。
5. **上下文。** 分开“压缩”和“会话回顾”两个概念；压缩参数（阈值、保留比例、按模型）、压缩前的工具结果修剪、溢出恢复；先确认 Pi 能暴露多少，不够再在 Core 一侧补。
6. **拆大文件。** `invokeCapability` 改为能力注册表（每个能力自带“如何调用、是否要审批”），`context.ts` 按职责拆。

每一步要先读对应参考的**实现**（不只是 README）再动手；上面的对照只覆盖了我读到的部分。

## 4. 直连路由开放 bash 的前置条件

用户要求直连路由经 Core 开放 bash。我已经读完 Core 里能复用的零件（`assessCommand`、`wrapCommandForSandbox`、`sanitizeBashEnv`、审计、`/v1/action` 的设备端审批模式），**但没有写任何实现**，原因是它们正是上面第 2 节认定不牢靠的部分：

- 守卫是正则；沙箱默认关且失败开放；审批机制又会多出第六套。
- 在这样的基础上开一个能从网络调用的“执行命令”入口，等于把弱点暴露给持有 Core 令牌的任何客户端。

**两个可选路径，需要你定：**

- **A（推荐）**：先做第 3 节的 1–3（权限模型、守卫、沙箱失败关闭）的最小切片，再在它们之上开 `POST /v1/shell/exec`：App 逐次审批，Core 先做规则判定，危险的直接拒绝，结果带沙箱事实，全部入审计。
- **B（过渡）**：现在就做 `shell/exec`，但**默认关闭**（需 `THEBE_SHELL_EXEC=on`），只在沙箱可用时才执行（失败关闭），critical 命令拒绝，dangerous 一律拒绝（直连路由不提供二次确认），App 每次审批并显示完整命令。等第 3 节完成后再放宽。

## 5. 参考位置

| 内容 | 位置 |
|---|---|
| Codex 命令策略 | `~/Documents/Code/learn/codex/codex-rs/execpolicy/README.md` |
| Codex 命令解析与安全 | `codex-rs/shell-command/src/{bash.rs,parse_command.rs,command_safety/}`，`codex-rs/core/src/safety.rs` |
| Codex 沙箱 | `codex-rs/{linux-sandbox,sandboxing,windows-sandbox-rs,network-proxy}` |
| Codex 压缩 | `codex-rs/core/src/compact*.rs` |
| dsh 沙箱策略、受限 bash | `~/Documents/Code/learn/deepseek-harness/packages/sandbox/sandbox-policy`、`packages/shell/bash-sandbox` |
| dsh 审批与预设 | `packages/interaction/{user-approval,permission-presets}` |
| dsh 压缩 | `packages/compaction/{compaction-basic,compaction-tool-result-pruner,command-compact}` |
| Hermes 审批 | `~/Documents/Code/learn/hermes-agent/tools/approval*.py` |
| Hermes 压缩 | `agent/context_compressor*.py`、`agent/conversation_compression*.py` |
| Core 对应代码 | `src/agent/security/{command-risk,command-sandbox,remembered-permissions,full-access}.ts`，`src/agent/internal/{auto-summary,context}.ts`，`src/agent/control/service.ts`，`src/agent/action/service.ts` |

## 6. 还没看的（审计覆盖范围的缺口）

目标/子代理（`goals/service.ts` 623 行、`subagent`）、诊断（`diagnosis/service.ts` 562 行）、流水线（`pipeline/job-runner.ts`）、谷歌 antigravity 适配器（约 1800 行）、会话存储与恢复、调度。这些我没有读，不能给结论。
