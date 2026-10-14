# 权限模型：沙箱范围、审批策略、命令规则分开，由一个决策函数裁定

状态：**草案，待用户确认（2026-10-14）。** 本文只提方案，不含代码。依据是 `docs/ARCHITECTURE-AUDIT-2026-10-14.md` 里读到的现状，以及对 Codex、dsh、Hermes 实现的阅读。

## 背景

Core 现在管“能不能执行”的开关有四套，彼此不联动：

1. **审批模式** `ask | read-only | full-access`（`PERMISSION_MODES`）：Agent 全局一个值，经 `/v1/settings/permissions` 改。
2. **会话级 `fullAccess` 预设**（`FULL-ACCESS-DESIGN.md`）：宿主用 `THEBE_FULL_ACCESS` 放行，单个会话打开，同时关掉命令守卫和沙箱，并免审批。
3. **场景预设** `THEBE_SCENARIO`（`nas-strict`、`homelab-host`、`microvm-sandbox`、`yolo-guarded`）：只靠环境变量，整个进程一个，决定命令守卫、工作区约束、沙箱后端、Docker 守卫。
4. **沙箱后端** `THEBE_SANDBOX=off|bwrap|docker|seatbelt|gondolin`：这其实是“用什么机制强制”，不是“允许什么”。

再加上记住的权限、非交互运行的拒绝、`preflight()` 与 `request()` 各算一遍同一个决定。后果（均已在审计里读到或复现）：

- 命令守卫是 46 条字面正则，常见写法（`rm -r -f /`、`sh -c '…'`、`$HOME`）放行。
- 沙箱默认关闭，不可用时退回裸命令只给警告。
- 没有统一回答“这条命令为什么被放行/询问/拒绝”的地方。
- 要新增 `POST /v1/shell/exec` 这类入口时，没有一个地方能让它复用同一套判定。

## 参考实现里相同的做法

- **Codex**：两个正交设置。审批策略 `AskForApproval` = `untrusted | on-request | granular | never`；沙箱策略 `SandboxPolicy` = `read-only | workspace-write | external-sandbox | danger-full-access`，带网络开关。默认是 `read-only` 加 `on-request`。命令规则独立成 `execpolicy`（`allow | prompt | forbidden`，带 `justification`，`match`/`not_match` 示例在加载时校验）。
- **dsh**：`sandbox-policy`（`read-only` 默认、`workspace-write`、`danger-full-access`，每会话可切换并记入会话日志，所有受限能力共用）与 `user-approval`（`ask`/`never`）分开，再由 `permission-presets` 捆成命名预设。受限 bash **没有任何可强制的后端时失败**（`SANDBOX_UNAVAILABLE`），不会悄悄不受限地运行；沙箱拒绝作为结果里的事实返回，模型可对同一条命令重试一次并说明理由，由用户审批后才升级。
- **Hermes**：判定分层。**地板**（`approval_floors`）在任何模式之前执行：绝不放行的 hardline、用户自己的 deny 通配、`sudo -S`；匹配前先把命令规范化并去混淆（`r\m`、`git st""atus`）。之后才是审批模式 `manual | smart | off`；未知模式回退到 `manual` 并报警。有连续拒绝的熔断。

## 决定

### 1. 三个独立的维度，加一条地板

| 维度 | 取值 | 回答的问题 |
|---|---|---|
| **confinement**（沙箱范围） | `read-only` / `workspace-write` / `full-access`，各带 `network: on/off` | 一条命令**最多能碰什么**（文件、网络） |
| **approval**（审批策略） | `ask` / `auto` / `never` | 超出已允许范围的动作**由谁决定** |
| **rules**（命令规则） | `allow` / `prompt` / `forbidden` | 某类命令**固定怎么处理**，与前两项无关 |
| **floor**（地板） | 只有一个“绝不放行”集合，加用户自己的 deny 规则 | 任何模式下都不能做的事 |

- `ask`：不在允许范围内的动作逐次询问（现在的默认行为）。
- `auto`：在 confinement 内执行的命令直接运行，只有超出范围（升级）才询问。**必须配一个确实能强制 confinement 的后端**才可选。
- `never`：从不询问；需要询问的一律拒绝，把拒绝作为结果返回给模型（Codex 的 `never` 语义；与 dsh 的 `never` 不同——dsh 的是“拒绝所有需要审批的请求”，不会放行沙箱内的命令，两者要分清）。
- `full-access` 这个 confinement 值就是今天的“全权限”：只能由宿主 `THEBE_FULL_ACCESS` 放行，保持 `FULL-ACCESS-DESIGN.md` 的 8 条不变量（默认关、宿主门控、会话级、不继承、审计不关、可见、范围窄）。

### 2. 命名预设（给用户看的就是这几个）

| 预设 | confinement | approval | 说明 |
|---|---|---|---|
| `inspect` | `read-only`，网络关 | `ask` | 默认。读可以，写和联网都要问。 |
| `workspace` | `workspace-write`，网络开 | `ask` | 工作区内可改，其余要问。 |
| `workspace-auto` | `workspace-write`，网络开 | `auto` | 工作区内不再逐次问，只在越界时问。需要可强制的沙箱后端。 |
| `unrestricted` | `full-access` | `never` | 现在的 `fullAccess` 预设，宿主门控。 |

预设只是两个值的捆绑；用户也可以分别设 confinement 和 approval，客户端遇到不在表里的组合显示为 `custom`（dsh 同样处理）。

### 3. 一个决策函数

所有会产生副作用的请求（Pi 工具调用、`POST /v1/shell/exec`、MCP 写调用）都走同一个函数，返回 `allow | ask | deny`，并带**原因**：

```
decide(request, session) → { outcome, reason, rule?, facts }
1. 地板：hardline 与用户 deny 通配。对规范化、去混淆后的命令各变体匹配。命中即 deny，不受模式影响。
2. 记住的拒绝（按参数哈希；现有 remembered-permissions 保留）。
3. 命令规则：forbidden → deny；prompt → ask；allow → allow。
4. 已知安全的只读命令（短白名单）→ allow。
5. confinement：文件工具按路径判；shell 命令交给沙箱强制，不在这里猜。
6. approval：记住的允许 → allow；否则按 ask / auto / never 处理。
```

`permission-control` 里 `preflight()` 与 `request()` 合并为它的两个调用点。原因写进审计，也返回给客户端（Codex 记录“为什么”的做法）。

### 4. 命令规则和解析

- 先把命令解析成词（拆开 `&&`、`;`、管道、`$(…)`、`sh -c '…'`、`eval`），对每一段判定，取最严的结果；解析不了就按 `prompt`，不放行。参考 Codex `shell-command`、Hermes 的规范化。
- 规则格式取 Codex 的前缀规则（`pattern`、`decision`、`justification`、`match`、`not_match`），`match`/`not_match` 示例在加载时校验，等于规则自带单元测试。
- 现有 46 条正则保留，但降为 **hardline 层**（地板的一部分），不再是主要机制。`docs/audit-probes/command-guard.mts` 里的绕过清单变成这一层的表驱动测试：每条命令一个期望结果。

### 5. 沙箱：失败关闭，结果带事实

- 运行 shell 前先问“有没有后端能强制当前 confinement”。**没有就拒绝执行**，返回 `SANDBOX_UNAVAILABLE` 与原因；`full-access` 例外（本来就不受限）。
- 结果带 `sandbox: { confinement, backend, enforced, denied }`，`denied: true` 表示沙箱拦了某个文件或网络操作。
- 模型看到 `denied` 后可以对**同一条命令**提出一次升级请求（更宽的 confinement 加一句理由），走审批；批准前不执行。
- 沙箱内整个宿主可读的问题：`read-only`/`workspace-write` 下把 Core 自己的配置和令牌目录从可读范围里排除（bwrap 用 `--tmpfs` 覆盖，seatbelt 加 `deny file-read*` 子路径）。
- `THEBE_SANDBOX` 保留，语义改为“选哪个后端”，不再决定要不要沙箱；要不要由 confinement 决定。`isolation` 报告改为回答“当前预设能否被强制”。

### 6. 作用域与持久化

- 预设**按会话**保存（会话元数据里一个字段），新会话取宿主默认；切换写进会话日志，立即对下一次调用生效。
- 宿主默认由配置给出（取代全局 `PermissionMode` 和进程级 `THEBE_SCENARIO`）。`THEBE_SCENARIO` 保留为设宿主默认预设和后端的一个简写，并在文档里标为兼容项。
- 子代理、调度、后台目标、`/mcp` 调用：**不继承**会话的放宽，各取自己的预设（延续现有不变量）。子代理档案里的工具表只是上限，confinement 取父会话和档案中更窄的那个。
- 现有字段的兼容：`PermissionMode` 的 `ask` → `workspace` 加 `ask`；`read-only` → `inspect`；`full-access` → `workspace-auto`（不是 `unrestricted`，保持原来“工具免审批但守卫和沙箱仍在”的含义）；会话 `fullAccess: true` → `unrestricted`。注意：`workspace-auto` 要求有可强制的沙箱后端，没有后端的主机上旧的 `full-access` 模式没有等价物，升级时要给出明确提示，而不是悄悄放宽。保留 `/v1/settings/permissions` 与 `/v1/session/{id}/full-access` 作为别名，新增 `GET/PUT /v1/session/{id}/permissions`。

## 不做什么

- 不做模型审批（Hermes 的 smart、dsh 的 Auto review），第一阶段不引入第二个模型。
- 不做网络代理和域名白名单，网络只有开/关。
- 不做 Windows 沙箱。
- 不改审计日志格式，只多记“决策原因”和沙箱事实。

## 后果

- **对 App 的影响**：设置里的“权限”从三个值变成预设选择器，会话里要显示当前预设和沙箱事实；旧接口别名保证旧版 App 继续可用。
- **bash 入口**：`POST /v1/shell/exec` 直接建在 `decide()` 和失败关闭的沙箱上，不再另造判定。
- **行为变化**：以前沙箱请求了但不可用时命令照跑，之后会被拒绝。这是有意的，升级说明要写清；`THEBE_SANDBOX=off` 加 `unrestricted` 之外没有别的办法回到旧行为。
- **风险**：解析 shell 是最大的新增复杂度；解析失败一律询问，不放行，所以最坏结果是多问几次。规则格式一旦对外就要保持兼容。

## 分步实施（每步独立可交付）

1. 类型与预设表、会话字段、兼容映射、`decide()` 的骨架（先复现现有行为，加测试锁定）。
2. 命令解析与规则，hardline 层改为表驱动，绕过清单全部变成期望结果。
3. 沙箱失败关闭、结果事实、配置目录排除、`isolation` 报告更新。
4. 审批合一：`preflight`/`request` 合并，决策原因进审计与客户端。
5. 新增 `POST /v1/shell/exec` 与 `GET/PUT /v1/session/{id}/permissions`。
6. App 侧：预设选择器、会话里显示沙箱事实、直连路由的 bash 工具。

## 需要用户确认

1. 三个维度加四个预设的划分是否同意；预设名要不要换。
2. `auto` 第一阶段是否一起做，还是先只做 `ask` 和 `never`。
3. 沙箱不可用时“拒绝执行”这条是否接受（它会让现在没装 bwrap 却设了 `THEBE_SANDBOX=bwrap` 的部署从“照跑”变成“拒绝”）。
4. 第 3 节里 `full-access` 旧模式映射到 `workspace-auto` 是否合适。
5. 沙箱内是否要排除 Core 配置目录的可读性（可能影响依赖该目录的工具）。
