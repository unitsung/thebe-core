# Thebe Core 对外 API、会话与 Runtime 能力：完整总结

> 本文汇总本次讨论中提出、对标 OpenCode/Pi 后确认的 API 面与实现要求。它不是“当前仓库已全部实现”的声明；每一项都标注为 **已报告完成**、**应实现/待确认** 或 **明确延后**。  
> 核心架构约束：Thebe 是产品与 runtime 适配层；Pi 负责通用 agent loop、原生 session、branch/compaction、provider/credential 生命周期与内置 coding tools。对外 HTTP、TUI、iOS 都必须收敛到同一 Thebe service 与同一 runtime-session mapping，且不能泄漏 Pi 类型、事件、存储或 DTO。[file:45]

## 1. 最终术语与命名

### 1.1 不再使用 `ask` 作为主抽象

`ask` 暗示“一个问题对应一个答案”，但 Thebe 实际是一条持续 session：可能多轮 tool calls、可中断、可继续输入、可 fork、可 compact。因此主模型应为：

- **session**：持续会话及其 Thebe-owned 元数据容器
- **prompt**：向一个 session 提交一次输入、调度 agent 执行的动作
- **message**：会话中的可读取历史记录
- **log/event**：供 UI 观察实时执行过程的事件流
- **interrupt**：中断正在进行的 agent 执行
- **permission**：对受控工具动作进行一次运行时批准/拒绝

### 1.2 名称映射

| 旧名称/位置 | 目标名称 | 状态 |
|---|---|---|
| `ThebeProduct.ask()` | `ThebeProduct.prompt()` | 已报告完成；`send()` 保留为兼容别名 |
| `ThebeAskResult` | `ThebePromptResult` | 已报告完成 |
| `POST /v1/ask` | `POST /v1/session/:id/prompt` | 已报告完成为 Core 主路径 |
| `ThebeAskFn` / `handleAsk()` | `ThebePromptFn` / `handlePrompt()` | 应与主路径同步，待确认实际重命名是否完全完成 |
| `src/ask/` | `src/agent/`（或等价 agent facade 目录） | 应实现/待确认；目录内不只是问答，还含 fork、compact、export、auth 等能力 |
| `RuntimeSession.prompt()` | 保持 `prompt()` | 不应改；runtime 层此名语义正确 |

### 1.3 iOS 兼容端点

执行总结称 iOS 继续使用 `POST /v1/messages`。该端点只能是**薄兼容适配层**，不得成为第二套会话协议或第二套 handler/business path。

必须确认：

1. 它是否真的被已发布 iOS 客户端使用，而非实现阶段临时加入的另一个命名。
2. 它是否与主路径调用同一个 request normalization、同一个 `ThebeProduct.prompt()`、同一个 session mapping。
3. 它能否完整支持 `files[]`、`mode`、权限事件、SSE/事件恢复与相同的错误码。
4. 如果它是仅兼容旧客户端的简化端点，必须写明版本退出计划；新 iOS 代码应使用与 Core 一致的 session/prompt 协议。

Thebe 的迁移目标要求 HTTP、未来 iOS API、TUI 等入口都进入同一个产品服务层与同一个 runtime-session mapping；任何入口都不能绕过 custom-tool registration、redaction、audit bridge 或 identity/session mapping。[file:45]

## 2. 资源模型与完整 HTTP API

统一前缀采用 `/v1`；以下资源单数 `session` 是为对标 OpenCode 的 server API 风格。若项目既有规范采用复数，必须全局一次性统一，不能在同一 API 同时混用 `session`/`sessions`。

### 2.1 系统与运行状态

| 方法与路径 | 目的 | 状态/备注 |
|---|---|---|
| `GET /v1/health` | 服务存活、版本与基本状态 | 已有/应保留 |
| `GET /v1/event` | 可选的跨 session 全局事件流 | 待决定；适合 dashboard、多 session UI |
| `GET /v1/session/status` | 批量返回 session 执行状态，如 `idle`、`running`、`awaiting_permission`、`interrupted` | 已报告完成 |

### 2.2 Session 生命周期

| 方法与路径 | 请求/响应要点 | 状态 |
|---|---|---|
| `GET /v1/session` | 列出会话；至少返回 `id`、`title`、`createdAt`、`lastActiveAt`、状态、selected context、labels | 已报告完成 |
| `POST /v1/session` | 创建空 session；可选 title、selected homelab context、初始 model | 已报告完成 |
| `GET /v1/session/:id` | 单个会话元数据与当前状态 | 已报告完成 |
| `PATCH /v1/session/:id` | 改 title、labels、selected context、share metadata 等 Thebe-owned metadata | 已报告完成 |
| `DELETE /v1/session/:id` | 删除 Thebe session mapping/metadata；必须明确是否也删除 Pi 原生 session 及导出物 | 已报告完成；删除语义需文档化 |
| `GET /v1/session/:id/children` | 返回由此会话 fork 的子会话树/列表 | 应实现或明确不做；此前清单遗漏于执行总结 |

### 2.3 Prompt：提交用户输入

| 方法与路径 | 目的 | 状态 |
|---|---|---|
| `POST /v1/session/:id/prompt` | 主输入端点；提交输入并开始/排队 agent 运行 | 已报告完成 |
| `POST /v1/messages` | iOS 兼容入口；必须适配到上面同一内部操作 | 已报告完成，但需核对兼容范围 |

`POST /v1/session/:id/prompt` 建议请求体：

```json
{
  "text": "检查这台机器上异常的容器",
  "files": [
    {
      "filename": "grafana.png",
      "mediaType": "image/png",
      "data": "<base64-or-upload-reference>"
    }
  ],
  "mode": "prompt"
}
```

字段：

- `text`：文本输入；可按产品需求允许只发附件。
- `files[]`：通用附件，不仅是图片；可承载 image、text、log、configuration、archive 的受控子集。附件传递/存储与大小上限必须明确。
- `mode`：`prompt | steer | followUp`；默认 `prompt`。

运行语义：

| mode | 对应 Pi 能力 | 适用时机 | 必须定义的错误/状态 |
|---|---|---|---|
| `prompt` | `session.prompt()` | session 空闲时提交正常输入 | 若已有运行，不可让底层异常直接泄漏；返回明确冲突错误，例如 `409 session_running`，或明确自动排队策略 |
| `steer` | `session.steer()` | agent 正在执行时，当前 tool/turn 边界后插入方向修正 | 应返回 queued/accepted，并由事件告知队列变化 |
| `followUp` | `session.followUp()` | 当前 agent 完整结束后再处理的追问 | 应返回 queued/accepted，并由事件告知队列变化 |

Pi SDK 提供 `prompt`、`steer`、`followUp`、`abort`、`compact`、事件订阅等能力；Thebe 的 runtime 抽象应归一化这些能力而不是把 Pi 的具体类型传到客户端。[file:45]

### 2.4 Message：历史记录读取

| 方法与路径 | 目的 | 状态 |
|---|---|---|
| `GET /v1/session/:id/message` | 分页读取消息/工具记录时间线 | 已报告完成 message 能力；须确认列表端点与分页实现 |
| `GET /v1/session/:id/message/:messageId` | 读取单条消息及其 parts/tool calls/附件引用 | 应实现/待确认；此前完整清单有此项，执行总结未提 |

注意：Thebe ProductStore 不得变成第二份 transcript。消息历史应来自 runtime/Pi 原生 session，Thebe 仅保存映射与产品元数据。[file:45]

### 2.5 Event / Log：SSE 流式观察

| 方法与路径 | 目的 | 状态 |
|---|---|---|
| `GET /v1/session/:id/log?follow=true` | 建立 SSE，订阅某个会话的实时 normalized events | 已报告完成 |
| `GET /v1/session/:id/log` | 非 follow 模式读取可恢复的事件窗口/游标（可选） | 应评估；支持 SSE 断线重连 |
| `GET /v1/event` | 全局事件聚合流（可选） | 待决定 |

建议 SSE wire format：

```text
event: text_delta
data: {"text":"正在查询容器…"}

event: tool_start
data: {"toolName":"container.logs","toolCallId":"call_123"}

event: permission_requested
data: {"permissionId":"perm_123","toolName":"bash","input":{...}}

event: tool_end
data: {"toolName":"container.logs","toolCallId":"call_123","isError":false,"text":"…"}

event: session_end
data: {"text":"结论：…"}
```

必须支持/映射的 normalized event：

| 事件 | UI 含义 |
|---|---|
| `text_delta` | 追加 assistant 文本 |
| `thinking_delta` | 可选展示 reasoning/working state；必须考虑是否对客户端暴露 |
| `tool_start` | 建立工具调用卡片 |
| `tool_update` | 展示执行进度/日志 |
| `tool_end` | 工具结束，标识 error/success |
| `turn_end` | 一个内部 agent turn 完成；**不能据此关闭 SSE** |
| `session_end` | 本次 prompt/run 完成；UI 解锁输入 |
| `error` | 失败收尾 |
| `interrupted` | 用户/控制面主动中断；与 error 区分 | 
| `queue_update` | steer/followUp 队列更新 | 
| `permission_requested` | 等待用户许可 | 
| `compaction_start` / `compaction_end` | 运行时正在/结束上下文压缩 |

执行总结报告 `interrupted`、`queue_update` 与 `permission_requested` 已完成。需要检查 SSE 不会在 `turn_end` 提前结束，而是等待 `session_end`/`error`/`interrupted`。Thebe 必须对 Pi 事件做归一化，客户端不得接收 raw Pi events。[file:45]

**断线恢复是尚未确认的关键点。**纯 SSE 增量在断线时会丢失；应至少选择一种策略：

1. 事件携带单调 `eventId`，SSE 通过 `Last-Event-ID`/`after` 补发；
2. 断线后通过 `GET /message` 刷新最终消息与 tool history；
3. 既有可恢复 event log，又有 message 刷新兜底。

### 2.6 Interrupt 与运行控制

| 方法与路径 | 目的 | 状态 |
|---|---|---|
| `POST /v1/session/:id/interrupt` | 中断当前 prompt/run；最终 SSE 发出 `interrupted` 或等价结束事件 | 已报告完成 |
| `POST /v1/session/:id/compact` | 手动触发 runtime/Pi 原生 compaction | 已报告为 P1 配套完成 |
| `POST /v1/session/:id/fork` | 创建分叉会话 | 已报告按消息 fork；需核对参数与语义 |
| `POST /v1/session/:id/revert` | 回退到指定消息/entry 边界 | 已报告 P1 有 revert；需核对具体 route/body |
| `POST /v1/session/:id/unrevert` | 恢复被回退的分支状态 | 应实现/待确认；执行总结未明确 |

Fork 推荐请求体：

```json
{ "messageId": "msg_abc" }
```

- 省略 `messageId`：从当前最新 leaf 分叉。
- 指定 `messageId`：从指定 message/entry 的边界分叉。
- 验收：fork 后子会话继续活动不得修改 parent；Thebe 保存的是 session mapping，不应复制/拥有 Pi branch graph。[file:45]

Revert 的真实语义需要显式定义：它是仅改变对话/entry graph，还是会撤销 agent 已写入 filesystem/container 的外部副作用？后者通常无法可靠自动完成，不能在 UI 上承诺“回滚了所有操作”。若只回退会话历史，应明确标注。

### 2.7 权限与工具批准

| 方法与路径 | 请求要点 | 状态 |
|---|---|---|
| `POST /v1/session/:id/permission/:permissionId` | `{ "response": "allow" | "deny", "remember": true | false }` | 已报告有审批；`remember` 语义需确认 |

最小流程：

1. runtime 发现受控内置工具，例如 `bash`、`write`、`edit`。
2. SSE 发出 `permission_requested`，携带 `permissionId`、`toolName`、可安全展示的参数/摘要、风险分类。
3. UI 展示 Allow / Deny，以及可选 Remember。
4. UI 调 permission endpoint；runtime 继续或拒绝该一次 tool call。
5. SSE 发出最终 tool outcome；拒绝必须被归一化为 denied/blocked，而不是伪装成 provider error。

需要明确：

- `remember` 的作用域（本 session、用户+环境、全局 policy）与 TTL；默认不应扩大权限。
- 并发 prompt/多个 pending permission 的唯一关联方式。
- 请求过期、重复批准、session 已 interrupt 的 idempotency 响应。
- `bash` 参数和写入路径在事件/audit 中的脱敏规则。

迁移目标要求 Thebe 归一化来自 Pi built-in tools 和 Thebe custom tools 的成功、失败、取消、denied/blocked 事件，并保证 Thebe custom-tool 输出在进入 Pi history、client events、audit 与 export 之前完成敏感值脱敏。[file:45]

### 2.8 模型、Provider 与认证

#### 读取与选择

| 方法与路径 | 目的 | 状态 |
|---|---|---|
| `GET /v1/provider` | 列出 provider catalogue、连接/认证状态、默认信息 | 已报告完成 |
| `GET /v1/model` | 列出可选择模型；可用 `?provider=` 过滤 | 已报告完成 |
| `POST /v1/session/:id/model` | 切换当前 session 的 provider/model | 已报告完成 |
| `POST /v1/session/:id/thinking` 或等价 session patch | 设置 reasoning/thinking level | **缺漏/待确认**：执行总结提到 Runtime 有 `setThinkingLevel`，但没有列出 HTTP API |

模型 DTO 必须是 Thebe-owned normalized DTO，例如：

```ts
type ThebeModel = {
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsThinking?: boolean;
  available: boolean;
};

type ThebeProvider = {
  id: string;
  displayName: string;
  authMethods: Array<"apiKey" | "oauth">;
  authStatus: "connected" | "missing" | "error";
};
```

不要直接返回 Pi 的 model/provider types；迁移验收明确要求 provider/model selection 只能通过 Thebe-owned normalized provider/model DTO 对客户端暴露。[file:45]

#### Provider 认证 API（执行总结未覆盖，必须确认）

| 方法与路径 | 目的 | 状态 |
|---|---|---|
| `GET /v1/provider/auth` | 列出 provider 支持的认证方式与状态 | 待实现/待确认 |
| `PUT /v1/auth/:providerId` | 写入 API key/凭证引用；严禁回显 secret | 待实现/待确认 |
| `POST /v1/provider/:providerId/oauth/authorize` | 启动 OAuth 授权 | 待实现/待确认 |
| `POST /v1/provider/:providerId/oauth/callback` | 接收/完成 OAuth callback | 待实现/待确认 |
| `DELETE /v1/auth/:providerId` 或 logout endpoint | 删除/注销凭证 | 待实现/待确认 |

Thebe 应使用 Pi 的 provider catalogue 与 credential/OAuth 模型，不得自己实现 OAuth token refresh 或持久化 refresh token；ProductStore 不得保存 Pi OAuth data。[file:45]

### 2.9 导出、Diff、Share

| 方法与路径 | 目的 | 状态 |
|---|---|---|
| `GET /v1/session/:id/export?format=jsonl|html` | 使用 Pi 原生 JSONL/HTML export | 应实现/待确认；此前 runtime 已有 export 能力，但执行总结未列 |
| `GET /v1/session/:id/diff` | 返回会话导致的工作区文件 diff | 明确 501，P2 延后 |
| `POST /v1/session/:id/share` | 创建分享元数据/链接 | P3，未实现可接受 |
| `DELETE /v1/session/:id/share` | 撤销分享 | P3，未实现可接受 |

迁移目标明确要求 JSONL/HTML 使用 Pi-native export，而非 Thebe 自己复制一份 transcript/export；还要求 canary secret 不能出现在 Thebe events、audit 或 Pi-native export。[file:45]

### 2.10 保留 MCP 面

| 方法与路径 | 目的 | 状态 |
|---|---|---|
| `POST /mcp` | 若仍是刻意产品接口，保留 MCP tool listing/call surface | 应保留/待确认；必须走同一 Thebe custom-tool registration、policy、redaction 与 audit 规则 |

## 3. Runtime 抽象必须具备的能力

Thebe domain/HTTP/TUI 只能依赖 Thebe-owned runtime interfaces。只有 `PiCodingAgentRuntime` 私有实现可 import `earendil-works/pi-coding-agent` 类型。[file:45]

### 3.1 输入与 session

```ts
type PromptFile = {
  filename?: string;
  mediaType: string;
  data: string; // 或受控 upload reference；不得无限制直接接收
};

type PromptInput = {
  text: string;
  files?: PromptFile[];
};

interface RuntimeSession {
  readonly runtimeSessionId: string;
  prompt(input: string | PromptInput): Promise<void>;
  steer(input: string | PromptInput): Promise<void>;
  followUp(input: string | PromptInput): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: NormalizedEvent) => void): () => void;
  messages(): RuntimeMessage[];
  compact(): Promise<void>;
  exportSession(): Promise<RuntimeExport>;
  setModel(model: ThebeModelRef): Promise<void>;
  setThinkingLevel(level: ThebeThinkingLevel): Promise<void>;
}
```

### 3.2 Runtime / provider catalogue

```ts
interface AgentRuntime {
  createSession(...): Promise<RuntimeSession>;
  resumeSession(...): Promise<RuntimeSession>;
  listSessions(...): Promise<RuntimeSessionSummary[]>;
  forkSession(input: { runtimeSessionId: string; atEntryId?: string; ... }): Promise<RuntimeSession>;
  listProviders(): Promise<ThebeProvider[]>;
  listModels(providerId?: string): Promise<ThebeModel[]>;
  auth(): RuntimeAuth;
}
```

### 3.3 仍需明确的 runtime 语义

- 在活动 run 上调用普通 `prompt()` 时的并发规则。
- steer 与 followUp 的队列持久化、取消、重启恢复与事件状态。
- session-level model/thinking switch 是否允许 run 中切换；如果不允许应返回明确 409。
- runtime session 的 dispose、删除和资源释放语义。
- Pi 原生 branch/revert/compaction 与 Thebe session mapping 之间的错误恢复策略。

## 4. ProductStore、元数据、审计与数据所有权

### 4.1 ProductStore 应保存

最小 Thebe-owned record：

```ts
type ThebeSessionRecord = {
  thebeSessionId: string;
  runtimeId: string;
  runtimeSessionId: string;
  ownerUserId?: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  title?: string;
  selectedHomelabContext?: {
    environmentId?: string;
    hostId?: string;
    serviceIds?: string[];
  };
  labels?: Record<string, string>;
  shareMetadata?: Record<string, unknown>;
};
```

执行总结报告 `title`、`createdAt`、`lastActiveAt` 和 `delete()` 已补齐。还需确认是否有 `updatedAt`、owner/device/context，以及 delete 的级联规则。

### 4.2 ProductStore 不得保存

- Pi transcript/messages
- Pi branch graph/topology
- Pi compaction history/state
- Pi OAuth refresh token / credential data
- 为方便 UI 另存的一整套 raw event log

这些约束来自 migration goal：Pi 拥有通用 session/transcript/branch/compaction/export/provider lifecycle；Thebe 拥有 product session identity mapping、产品元数据、homelab context、audit correlation、reports/shares 与 domain adapters。[file:45]

### 4.3 Audit 与 redaction

需要确保：

- audit 关联 `thebeSessionId`、`runtimeSessionId`、caller/user/device、selected context、工具事件类型、耗时、结果与安全摘要。
- Thebe custom-tool（如 `container.logs`）的输出在到达 Pi history、HTTP/SSE、TUI、audit、export 前先 redaction。
- 内置 Pi tools 与 custom tools 的 permission、denied、cancelled、error 都有一致的 normalized outcome。
- 使用 canary secret 测试，证明密钥不出现在 events、audit、Pi-native JSONL/HTML export。[file:45]

## 5. UI 端到端交互合同

### 5.1 正常会话

1. UI 请求 `GET /v1/session`，渲染会话列表。
2. UI 创建或打开 `POST/GET /v1/session/:id`。
3. UI 请求 `GET /v1/session/:id/message`，得到历史时间线。
4. UI 建立 `GET /v1/session/:id/log?follow=true` SSE。
5. UI 调用 `POST /v1/session/:id/prompt`。
6. UI 按 `text_delta` 追加文本；按 tool events 渲染执行卡片。
7. 收到 `session_end`、`error` 或 `interrupted` 后结束本次 run，刷新 message history 兜底。

### 5.2 运行中追加输入

- 用户希望改变方向：调用 `mode: "steer"`。
- 用户只是提出下一题：调用 `mode: "followUp"`。
- UI 收到 `queue_update`，显示“已插队/已排队”。
- 不允许普通 `prompt` 因 session busy 静默失败或直接暴露 Pi 异常。

### 5.3 权限交互

- UI 监听 `permission_requested`。
- 展示工具、摘要、目标路径/命令（经脱敏）和风险说明。
- UI 调 `POST /permission/:permissionId`。
- 最终状态必须经 SSE 和/或 message history 可见。

### 5.4 断线重连

- SSE 重连后以 event cursor 补齐，或立即 refresh message history。
- 必须避免同一 text/tool 事件被 UI 重复渲染；event/message 要有 stable ids。
- 如果 runtime 重启，UI 能依据 Thebe-to-runtime session mapping resume 同一 session。[file:45]

## 6. 本轮执行总结已经覆盖的内容

根据执行 AI 的报告，以下被称为已完成：

- `ThebeProduct.prompt()` 为主入口，`send()` 为兼容别名。
- `ThebePromptResult`。
- Core 主 route：`POST /v1/session/:id/prompt`。
- iOS route：`POST /v1/messages`。
- `GET/POST /v1/session`、`GET/PATCH/DELETE /v1/session/:id`、`GET /v1/session/status`。
- `prompt` 支持 text、`files[]`、`mode: prompt|steer|followUp`。
- message、`log?follow=true` SSE、interrupt。
- bash/write/edit 的 `permission_requested` 与 permission approval endpoint。
- `prompt(string | PromptInput)` 多模态入口。
- `interrupted`、`queue_update`、`permission_requested` events。
- Runtime：steer、followUp、setModel、setThinkingLevel、按消息 fork、revert。
- `GET /v1/model`、`GET /v1/provider`、`POST /v1/session/:id/model`。
- ProductStore：title、createdAt、lastActiveAt、delete()。
- `GET /v1/session/:id/diff` 仍是 501，明确属于 P2。

## 7. 执行总结未覆盖、需要立即核对的缺漏

以下不是“可有可无的小项”，而是此前完整设计中明确出现、但执行总结没有说明的接口/行为。应逐项查代码/测试，而不是仅依据 `pnpm test` 与 `typecheck` 通过。

### P0 / 近 P0：协议完整性

- [ ] `/v1/messages` 是否只是主 `session/:id/prompt` 的薄适配器，且完整支持 session id、files、mode、统一 error、permissions 与 SSE；还是另一条简化实现？
- [ ] SSE 是否只在 `session_end` / `error` / `interrupted` 结束，而非 `turn_end`？
- [ ] SSE 断线后如何恢复：`Last-Event-ID`、cursor、历史补发，还是 `GET /message` 兜底？
- [ ] 普通 `mode: prompt` 在 active run 时是否返回明确 409/排队结果，而非底层 Pi throw？
- [ ] `permission` endpoint 是否支持 `remember`？其作用域、TTL、拒绝、过期、重复提交、interrupt 后提交分别如何处理？
- [ ] permission 与 tool events 是否对 **Pi built-in 和 Thebe custom tools** 都一致归一化？
- [ ] `GET /v1/session/:id/message/:messageId` 是否存在？列表是否分页、带 stable ids、包含 attachments/tool parts？

### P1：Provider/model/认证

- [ ] 是否有 `GET /v1/provider/auth`？
- [ ] 是否有 API-key 设置 endpoint，例如 `PUT /v1/auth/:providerId`，且不会在 response/log/audit 回显 secret？
- [ ] 是否真正实现 OAuth authorize/callback/logout，还是只有 runtime 抽象已有方法？
- [ ] `/v1/provider` 与 `/v1/model` 是否返回 Thebe-owned normalized DTO，完全不泄漏 Pi type？
- [ ] `setThinkingLevel()` 已在 runtime 添加，但 HTTP/UI 入口在哪里？若没有，需要增加 endpoint 或 `PATCH /session/:id` 的明确字段。
- [ ] model switch 在运行中、无效 model、未认证 provider 时，返回什么明确状态码与错误码？

### P1：会话树、撤销、导出

- [ ] `POST /v1/session/:id/fork` 的 body 是否支持 `messageId`/entry boundary？不传时是否从最新 leaf fork？
- [ ] `GET /v1/session/:id/children` 是否实现；若未实现，UI 如何表示 fork tree？
- [ ] `revert` 的 route、body、目标 entry/message 与 `unrevert` 是否完整实现？
- [ ] 文档是否明确 revert **不会自动回滚已发生的外部 bash/write/container 副作用**？
- [ ] `GET /v1/session/:id/export?format=jsonl|html` 是否已暴露，并确认使用 Pi-native export？
- [ ] `DELETE /session/:id` 是否删除 runtime session？如果不是，是否标识为 archive/unlink，且能否恢复？

### P2 / 产品决策

- [ ] `diff` 保持 501 是否返回结构化 `501 feature_not_implemented`，且文档描述范围（工作区 diff vs tool action diff）？
- [ ] 是否需要 `POST/DELETE /session/:id/share`？若不做，应明确产品不支持公开分享而非遗留空白。
- [ ] 是否需要全局 `GET /v1/event` 供 dashboard，而不是每次只能订阅单 session？

## 8. 推荐验收测试清单

除现有 83 个单测与 typecheck 外，建议至少补/核对下列集成测试：

1. 创建 session → SSE 订阅 → prompt → text/tool events → `session_end`。
2. 长工具运行中 `steer` 与 `followUp` 分别入队，并产生 `queue_update`；普通 prompt 得到预期 busy 语义。
3. interrupt 中断运行，得到 `interrupted`，不会被标为 provider error。
4. bash/write/edit 触发 permission；allow、deny、remember、重复 approval、过期 approval 都有确定结果。
5. 带 PNG 与文本/log 文件的 `PromptInput.files[]` 能正确进入 runtime；不支持媒体类型/超限文件返回明确 4xx。
6. SSE 中途断线、重连后通过 cursor 或 message refresh 不丢失/重复最终内容。
7. provider list/model list 不含 Pi raw types；未认证模型不被错误标记为可用。
8. API-key 与 OAuth 一条真实 provider 流程可用，secret 不进入 response、logs、audit、ProductStore。
9. 切换 model/thinking level 后 session 使用预期设置；运行中切换返回定义明确的冲突结果。
10. 从特定 message fork，fork 后继续对话不修改 parent；children 可查询或分叉关系可验证。
11. compact 后 session 可继续；export 的 JSONL、HTML 是 Pi-native 且包含预期对话/tool activity。
12. process restart 后 resume session；ProductStore 只含 metadata/runtime refs，不含 transcript、branch graph、compaction、OAuth data。
13. custom tool 输出含 canary secret 时，Pi history、SSE、audit、JSONL/HTML export 均不包含该 secret。
14. HTTP、TUI、iOS compatibility path 都进入同一 Thebe service/runtime mapping；没有绕过 policy/redaction/audit。

## 9. 结论与实施优先级

### 已报告完成、值得优先 code review 的核心

- Session CRUD、prompt、SSE、interrupt、permissions、files、多模型/provider 的主干。
- `/v1/messages` 与 `/v1/session/:id/prompt` 是否只有一个共享实现路径。
- normalized events 与 Pi type isolation。

### 最容易被“测试通过”掩盖的缺漏

1. OAuth/API-key 的完整 HTTP 流程。
2. SSE 重连与 event/message 一致性。
3. active run 下 `prompt`/`steer`/`followUp` 的明确冲突与排队语义。
4. permission `remember`、过期、拒绝、并发关联与 custom/built-in tool 一致性。
5. per-message read、children、unrevert、Pi-native export。
6. `setThinkingLevel` 已有 runtime 方法但缺少对外 API。
7. iOS `/v1/messages` 造成协议分叉或功能降级。

目标不是让 Thebe 把 Pi 再实现一遍；目标是以 Thebe-owned normalized interfaces，把 Pi 的 native session/provider/branch/compaction/export 能力完整、安全、可观察地提供给 HTTP、TUI 与 iOS。Thebe 仅拥有产品元数据、homelab context、custom tools、redaction、audit 与客户协议。[file:45]
