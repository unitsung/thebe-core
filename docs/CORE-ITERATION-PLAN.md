# Thebe Core 迭代开发路线

> Baseline: `dev`
>
> Updated: 2026-09-16
>
> Status: **active implementation plan**
>
> Companion App spec: `unitsung/thebe/docs/AGENT-NATIVE-REFACTOR.md`

本文是 Thebe Core 当前阶段的直接开发路线。目标不是重新设计 Agent Runtime，而是把 `dev` 已经存在的 Session、Goal、Subagent、Skill、MCP、Permission、Capability、Background Task 等能力，整理成稳定、可被 iOS App 消费的 product/runtime contract。

---

## 1. 当前阶段判断

Thebe Core 已经不是“准备做 Agent”的项目。

当前 `ThebeAgent` 已经拥有：

- prompt / steer / follow-up；
- Runtime Session create/list/get/patch/delete/resume/fork/compact/revert；
- normalized events / SSE log；
- permission request resolution 与 remembered permission；
- provider / model / thinking level；
- Skills；
- MCP tools / MCP servers；
- Homelab capabilities；
- Subagent profiles / spawn / list / subscribe / cancel；
- Enabled Resources；
- Goal start/get/subscribe/wait/pause/resume/stop；
- Background Tasks；
- workspace / export / tool stop / bash；
- quiesce / idle reap / auth。

因此现阶段的核心工作不是继续扩大 `ThebeAgent` 接口，而是：

```text
已有 Runtime Object
       ↓
稳定 HTTP Contract
       ↓
稳定 Client Contract
       ↓
App Domain / Activity / Approval / Capability UI
```

一句话：

> **Core vNext 的主线是 productize the runtime，而不是 rebuild the runtime。**

---

## 2. 当前成熟度矩阵

状态约定：

- ✅ 已有并可用
- 🟡 已有内部能力，但 client contract 不完整
- ❌ 缺失

| Capability | Agent Interface | Runtime / Service | HTTP | App 可稳定消费 | 当前判断 |
| --- | --- | --- | --- | --- | --- |
| Session lifecycle | ✅ | ✅ | ✅ | ✅/🟡 | 成熟，继续稳定 schema |
| Prompt / SSE events | ✅ | ✅ | ✅ | ✅ | 成熟 |
| Provider / Model | ✅ | ✅ | ✅ | ✅ | 成熟 |
| Thinking level | ✅ | ✅ | ✅ | 🟡 | App contract 可继续补 |
| Homelab capability list | ✅ | ✅ | ✅ `/v1/capabilities` | 🟡 | 已开始 productization |
| Capability invoke | ✅ `invokeTool` | ✅ | ❌ first-class | ❌ | **P0** |
| Skills | ✅ | ✅ | ❌ | ❌ | **P0/P1** |
| MCP servers/tools | ✅ | ✅ | raw `/mcp` only | ❌ product API | **P1** |
| Subagent profiles | ✅ | ✅ | ❌ | ❌ | **P0/P1** |
| Subagent runs | ✅ | ✅ | ❌ | ❌ | **P0/P1** |
| Goals | ✅ | ✅ | ❌ | ❌ | **P0** |
| Goal events | ✅ | ✅ | ❌ SSE | ❌ | **P0** |
| Permission resolve | ✅ | ✅ | ✅ session-scoped | 🟡 | 已有但 Approval discovery 缺失 |
| Pending approvals list | 🟡 `pendingPermissionIds()` | ✅ | ❌ | ❌ | **P0** |
| Permission mode | ✅ | ✅ | ❌ | ❌ | **P1** |
| Remembered permissions | ✅ metadata | ✅ | PATCH session 可间接修改 | 🟡 | 需要明确产品 API |
| Enabled resources | ✅ | ✅ | ❌ | ❌ | **P1** |
| Background tasks | ✅ | ✅ | ✅ session-scoped | 🟡 | 可先接 Activity |
| Context usage | ✅ | ✅ | ✅ | ✅/🟡 | 成熟 |
| Auto compact | ✅ | ✅ | session command only | 🟡 | 设置 API 可整理 |
| Auto summary | ✅ | ✅ | ❌ | ❌ | **P2** |
| System quiesce / reap | ✅ | ✅ | ✅ | ✅ | admin/system 能力 |
| Audit | ✅ internal | ✅ | ❌ read API | ❌ | **P2** |

最明显的结构性差距是：

> **TUI 已经能访问比 HTTP 更多的 Agent 能力。iOS 作为正式产品 Client，不应该长期靠 raw MCP / prompt hacks 来绕过 HTTP 缺口。**

---

## 3. 迭代原则

### 3.1 Agent Interface 先于 HTTP

新能力顺序必须是：

```text
Agent-owned interface
→ Agent service implementation
→ HTTP delivery
→ OpenAPI
→ contract tests
→ App client
```

不要：

```text
HTTP route
→ 直接 import Pi / MCP adapter
```

Delivery 永远只依赖 `ThebeAgent`。

### 3.2 HTTP 是产品协议，不是 Runtime dump

不要把所有内部类型原样 JSON 化。

HTTP 面向稳定产品对象：

```text
Session
Capability
Goal
Run
Worker
Approval
Skill
Resource
Background Task
Artifact/Event
```

Pi-specific 类型不能越过 `src/adapters/pi/`。

### 3.3 MCP 是 Integration Protocol，不是 App API

`/mcp` 保留给 MCP client / compatibility / integrations。

iOS App 不应该为了“列技能”“看 workers”“启动 goal”“批准动作”直接发 MCP JSON-RPC。

### 3.4 Core 不取代 Native Provider

Core 负责：

```text
Reasoning
Planning
Orchestration
Execution Policy
Durable Goals
Workers
Permissions
Runtime Events
Capability Discovery
```

App 已经可以直接从 Plex / PVE / OpenList 等读取的数据，不应该强制经过 Core。

### 3.5 所有长运行对象必须可恢复/可观察

目标对象不能只活在一次 HTTP request 中。

至少需要：

```text
stable id
status
createdAt / updatedAt
progress/checkpoint
parent/session relationship
error/result
subscribe/poll surface
```

---

## 4. Core 目标架构

```text
src/agent/
│
├─ runtime/             replaceable reasoning/session runtime interface
├─ sessions/            ordinary user sessions
├─ conversations/       prompt flow
├─ goals/               durable objective orchestration
├─ subagents/           isolated workers/reviewers
├─ capabilities/        stable homelab capability contracts
├─ extensions/
│  ├─ skills
│  └─ mcp
├─ security/
│  ├─ policy
│  ├─ remembered permissions
│  ├─ audit
│  └─ redaction
└─ internal/            private composition/runtime helpers

src/adapters/
├─ pi/                  AgentRuntime implementation
├─ mcp/                 external capability adapter
└─ arcane/              built-in container provider

src/delivery/
├─ http/                stable client contract
├─ tui/                 terminal UI
└─ cli/                 CLI

src/app/                composition root only
```

这套分层已经基本正确，不建议大规模目录重写。

主要迭代集中在：

```text
src/agent product contracts
+
src/delivery/http
+
contract tests
```

---

## 5. P0 — Product Contract Foundation

P0 的目标：

> 让 iOS App 不再把 Core 当 Chat Backend，而可以正式消费 Goal、Capability、Approval 与 Worker。

这是现在最应该立即开始的阶段。

---

## 6. P0.1 — Capability Contract v1

当前已经存在：

```ts
HomelabCapability {
  id
  name
  description
  inputSchema
  category
  permission
  service?
  source
  serverName?
}
```

并且已有：

```text
GET /v1/capabilities
```

第一步不要重写它。

先补稳定字段，使其真正能驱动 App Action UI。

建议 v1 增加可选 metadata：

```ts
type HomelabCapability = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;

  category: HomelabCapabilityCategory;
  permission: HomelabCapabilityPermission;

  service?: string;
  source: "core" | "external";
  serverName?: string;

  // new product metadata
  resourceKinds?: string[];
  execution?: "direct" | "agent" | "goal" | "either";
  background?: boolean;
  destructive?: boolean;
  outputKind?: string;
};
```

不要一次加入几十个 metadata 字段。

第一版只加入 App 真正需要进行 capability discovery 和权限表达的字段。

### Acceptance

`GET /v1/capabilities` 可以回答：

- 这是什么能力？
- 属于什么 category？
- 谁提供？
- 需要什么权限？
- 适用于什么 Resource？
- 能否直接执行 / 是否适合 background？

---

## 7. P0.2 — First-class Capability Invocation

目前 Core 有：

```ts
invokeTool(name, args)
```

但没有面向 App 的 first-class HTTP endpoint。

新增：

```text
POST /v1/capabilities/{id}/invoke
```

建议 request：

```json
{
  "resource": {
    "kind": "virtual_machine",
    "provider": "proxmox",
    "id": "102"
  },
  "arguments": {},
  "mode": "direct"
}
```

第一阶段 Core 可以忽略自己不认识的 `resource` metadata，只把它作为 audit / context metadata 透传保存；不要因此先建立复杂 Resource DB。

Response 分两种：

```json
{
  "type": "result",
  "result": {}
}
```

或：

```json
{
  "type": "run",
  "runId": "run_123"
}
```

### Important

不要让 endpoint 直接调用 `mcpRegistry.invokeTool()`。

应该：

```text
HTTP
↓
ThebeAgent capability method
↓
Policy / Audit / Registry
↓
Core or MCP capability
```

如果 `invokeTool()` 当前仍然是最接近的 Agent seam，可以先扩展成：

```ts
invokeCapability(id, input, context?)
```

然后让旧 `invokeTool()` 成为 compatibility alias / lower-level method。

---

## 8. P0.3 — Goal HTTP API

`ThebeAgent` 已经有完整 Goal lifecycle：

```text
startGoal
getGoal
subscribeGoal
waitGoal
pauseGoal
resumeGoal
stopGoal
clearGoal
```

这意味着 P0 不需要重新写 Goal Runner。

只需 productize。

建议 API：

```text
POST /v1/goal
GET  /v1/goal
GET  /v1/goal/{sessionId}
POST /v1/goal/{sessionId}/pause
POST /v1/goal/{sessionId}/resume
POST /v1/goal/{sessionId}/stop
GET  /v1/goal/{sessionId}/events
```

也可以使用 `/v1/goals` plural；选一种后固定。

推荐 plural：

```text
POST /v1/goals
GET  /v1/goals
GET  /v1/goals/{id}
```

但当前 Goal identity 是 `thebeSessionId`，所以这里需要先做一个小决策。

### 推荐决策

**短期不要为了 REST 漂亮强行重写 Goal identity。**

P0 可以先：

```text
/v1/session/{id}/goal
```

因为当前 `GoalRun` 明确 attached to one ordinary parent conversation。

例如：

```text
POST /v1/session/{id}/goal
GET  /v1/session/{id}/goal
GET  /v1/session/{id}/goal/log
POST /v1/session/{id}/goal/pause
POST /v1/session/{id}/goal/resume
POST /v1/session/{id}/goal/stop
```

等未来 Goal 可以独立于 Session 后，再引入 global Goal ID。

不要现在为了未来假设进行 storage rewrite。

### Goal SSE

`subscribeGoal()` 已经存在，因此增加：

```text
GET /v1/session/{id}/goal/log
Accept: text/event-stream
```

Event 直接使用 GoalEvent 的稳定 product schema：

```text
goal_started
goal_iteration
goal_reviewed
goal_subagent_update
goal_status
goal_completed
```

### Acceptance

App 可以：

1. 创建 Goal；
2. 关闭 Chat；
3. Activity 页面重新 GET Goal；
4. SSE 看进度；
5. Pause / Resume / Stop；
6. 最终看到 summary / review / worker activity。

---

## 9. P0.4 — Approval Discovery API

当前 HTTP 已有：

```text
POST /v1/session/{id}/permission/{permissionId}
```

即“知道 permission id 后可以处理”。

缺少的是：

> App 怎么发现现在有哪些待审批对象？

当前 `pendingPermissionIds()` 只返回 ID，产品信息不足。

建议新增 Agent-owned 类型：

```ts
type PendingApproval = {
  id: string;
  sessionId: string;
  capability?: string;
  toolName?: string;
  title: string;
  reason?: string;
  input?: unknown;
  resource?: unknown;
  requestedAt: string;
  rememberScopes: PermissionRememberScope[];
};
```

注意：

- tool input 必须经过 redaction；
- 不要把 raw runtime object 直接暴露；
- reason 可以由 capability metadata / runtime permission event 生成；
- v1 不需要复杂 impact scoring。

HTTP：

```text
GET /v1/approvals
GET /v1/approvals/{id}
POST /v1/approvals/{id}/resolve
```

为兼容现有 session route，可以暂时同时保留：

```text
POST /v1/session/{id}/permission/{permissionId}
```

App 新代码使用 `/v1/approvals`。

### Acceptance

Approval 可：

```text
发现
查看
Approve / Deny
Remember scope
关联 session
```

这一步完成后，App 才能真正做 Approval Center。

---

## 10. P0.5 — Subagent HTTP Surface

Core 内部已经非常成熟：

```text
listSubagentProfiles
spawnSubagent
listSubagents
getSubagent
subscribeSubagent(s)
waitSubagent
cancelSubagent
```

HTTP 建议：

```text
GET  /v1/subagent/profile
GET  /v1/subagent
GET  /v1/subagent/{runId}
POST /v1/subagent
POST /v1/subagent/{runId}/cancel
GET  /v1/subagent/{runId}/log
```

或者 plural `/v1/subagents`。

Product response 应保留当前优秀的 `SubagentRun`：

```text
runId
parentSessionId
profileName
task
status
turns/maxTurns
createdAt/startedAt/finishedAt
responseText
activity
result
error
```

App 可以把 Subagent 显示成 Worker，不需要 Core 改名。

### Acceptance

Activity 页面可以在不读取 parent transcript 的情况下显示 Worker progress。

---

## 11. P0.6 — HTTP Route 分模块

不要把新能力继续堆进 `agent-api.ts`。

当前 `agent-api.ts` 很薄，这是好事。

建议新增：

```text
src/delivery/http/routes/
  capability.ts
  goal.ts
  approval.ts
  subagent.ts
```

`agent-api.ts` 只做 dispatch：

```text
capability
session-read
session-command
goal
approval
subagent
provider/model/auth
```

每个 route module：

- 只依赖 `ThebeHttpContext.agent`；
- 解析输入；
- 调用 ThebeAgent；
- 返回稳定 JSON；
- 不包含业务执行逻辑。

---

## 12. P0.7 — OpenAPI 从“路径清单”升级为 Contract

当前 `openapi.ts` 已经很好地集中定义 endpoint，但 request/response schema 还是大量 generic object。

P0 不需要引入复杂生成器。

先对新 product object 建立明确 schema：

```text
Capability
GoalRun
GoalEvent
SubagentRun
PendingApproval
PermissionResolution
Error
```

优先让 iOS 可以根据 OpenAPI 稳定生成/对照 models。

### Rule

不要为了追求完整 OpenAPI 一次 schema 化所有历史 endpoint。

只要求：

> 新增的 Agent product APIs 必须有明确 schema。

旧接口渐进补。

---

## 13. P0.8 — Contract Tests

新增 route 时至少覆盖：

```text
happy path
not found
invalid body
quiesced mutation
permission flow
SSE disconnect
agent unavailable
```

优先扩展当前：

```text
src/delivery/http/final-spec.test.ts
src/delivery/http/handler.test.ts
```

但当单文件继续膨胀时，新 product API 使用 feature-level tests：

```text
routes/capability.test.ts
routes/goal.test.ts
routes/approval.test.ts
routes/subagent.test.ts
```

不要把所有 route regression 永久堆到 `handler.test.ts`。

---

## 14. P0 完成标准

P0 完成时，Core 应支持 App 完成：

```text
List Capabilities
Invoke Capability
Start Goal
Observe Goal
Pause/Resume/Stop Goal
List Workers
Inspect Worker
List Approvals
Resolve Approval
```

到这里，App 可以真正开始 `Activity + Approval + Context Action` 的 vertical slice。

---

# P1 — Capabilities, Skills, Resources, Settings

P1 让 Core 从“能执行”变成“能被产品配置和发现”。

---

## 15. P1.1 — Skills API

已有：

```text
listSkills
getSkill
enableSkill
disableSkill
```

HTTP：

```text
GET   /v1/skills
GET   /v1/skills/{name}
PATCH /v1/skills/{name}
```

PATCH：

```json
{
  "enabled": true
}
```

不要把 Skill 文件编辑能力直接开放给 App v1。

第一版只需要：

- list；
- metadata；
- enable/disable。

---

## 16. P1.2 — MCP Product API

已有 raw `/mcp` 不等于产品 API。

新增：

```text
GET /v1/extensions/mcp/servers
GET /v1/extensions/mcp/tools
```

如需 enable/disable server，再根据现有 registry/config 能力增加：

```text
PATCH /v1/extensions/mcp/servers/{name}
```

但不要在没有可靠 persistence seam 前硬加写 API。

App 普通页面把它叫 `Extensions`。

Core 仍然叫 MCP。

---

## 17. P1.3 — Enabled Resources API

已有：

```text
enableResource(resource)
enabledResources()
```

HTTP：

```text
GET /v1/resources/enabled
PUT /v1/resources/enabled/{id}
DELETE /v1/resources/enabled/{id}
```

但要注意当前 `EnabledResource` 的语义来自 Runtime。

P1 目标不是建立完整 Resource database。

它只负责：

> 哪些资源/context 可以进入 Agent。

完整 App `AgentResourceRef` 仍由 App Domain 与 Provider 层拥有。

---

## 18. P1.4 — Permission Mode API

已有：

```text
permissionMode()
setPermissionMode()
```

增加：

```text
GET   /v1/settings/permissions
PATCH /v1/settings/permissions
```

返回：

```json
{
  "mode": "ask"
}
```

不要把 TUI setting names 原样全部做成 HTTP。

只暴露 App 真正需要的 runtime behavior setting。

---

## 19. P1.5 — Agent Settings API

逐步加入：

```text
Auto compact
Auto summary
Auto summary delay
Permission mode
Max subagent concurrency
Max subagents per parent
Workspace path (read-only or guarded)
Output directory
```

建议：

```text
GET   /v1/settings/agent
PATCH /v1/settings/agent
```

但要避免一次 mutable everything。

敏感边界：

- `workspacePath` 是 authorization boundary，不应像 theme 一样随便修改；
- output directory 需要 path validation；
- concurrency 必须 clamp；
- TUI-only 的 theme/fullscreen/quietStartup 不应该出现在此 API。

---

## 20. P1.6 — Capability Categories 扩展

当前 categories：

```text
files
media
downloads
containers
automation
diagnostics
other
```

随着 Thebe App 接 PVE / storage，可以逐渐增加：

```text
compute
storage
network
photos
```

不要现在根据每个 vendor 建 category。

错误：

```text
proxmox
plex
openlist
```

正确：

```text
compute
media
files
```

Provider/service metadata 单独表达来源。

---

# P2 — Activity, Artifacts, Audit, Durable Product Objects

P2 目标：

> Core 不只让 Client 看“事件流”，还可以看可恢复的任务结果与历史。

---

## 21. P2.1 — Unified Run / Activity Read Model

不要急着把 Session、Goal、Subagent、BackgroundTask 重构成同一个 storage model。

先建立 read model：

```ts
type ActivityRecord = {
  id: string;
  kind: "session" | "goal" | "subagent" | "background_task";
  title: string;
  status: string;
  sessionId?: string;
  parentId?: string;
  progress?: number;
  createdAt: string;
  updatedAt?: string;
  finishedAt?: string;
};
```

HTTP：

```text
GET /v1/activity
```

它只是 aggregation read model，不拥有 lifecycle。

生命周期仍然回到各自的 source module。

这能让 App Activity 首屏不需要请求 6 个 endpoint 才展示列表。

---

## 22. P2.2 — Artifact Contract

Agent result 应逐渐支持结构化 Artifact，而不只是：

```text
text + events
```

建议先定义：

```ts
type AgentArtifact = {
  id: string;
  kind: string;
  title: string;
  sessionId?: string;
  runId?: string;
  createdAt: string;
  content: unknown;
};
```

第一批可以非常少：

```text
diagnosis
report
resource_list
operation_receipt
```

不要一开始做通用 arbitrary artifact filesystem。

---

## 23. P2.3 — Operation Receipt

任何真正的 write/destructive capability 最终都应该产出 receipt：

```text
what was requested
what was executed
who/what requested it
approval id
resource/capability
timestamp
result
verification
```

这对 NAS 操作特别重要。

例如：

```text
Start VM 102
Approved by user
Executed 14:31:07
Verified running 14:31:18
```

比只在 transcript 里留一句“done”可靠得多。

---

## 24. P2.4 — Audit Read API

当前 AuditLog 已经 append-only 且不可被模型关闭。

后续可以增加只读：

```text
GET /v1/audit
GET /v1/audit/{id}
```

必须：

- server-side redaction；
- pagination；
- size limit；
- production auth；
- 不允许 HTTP delete/edit。

---

## 25. P2.5 — Auto Summary / Compact Settings

当前内部能力已经有：

```text
setAutoCompactionEnabled
setAutoSummaryEnabled
setAutoSummaryDelayMs
```

这时再统一纳入 `/v1/settings/agent`，并给 App Settings 使用。

---

# P3 — Resource Graph / Automation / Product Orchestration

P3 才开始建立更强的 Homelab product intelligence。

---

## 26. P3.1 — Resource Reference Contract

Core 不需要拥有 App 的完整 Library DB，但跨服务执行需要稳定 reference：

```ts
type ResourceRef = {
  kind: string;
  provider: string;
  id: string;
  name?: string;
  attributes?: Record<string, unknown>;
};
```

应用场景：

- capability audit；
- approval；
- Goal context；
- artifacts；
- operation receipt。

---

## 27. P3.2 — Resource Relation

轻量关系：

```ts
type ResourceRelation = {
  source: ResourceRef;
  relation:
    | "runsOn"
    | "dependsOn"
    | "storedOn"
    | "servedBy"
    | "belongsTo"
    | "downloadsTo"
    | "importsInto"
    | "generatedFrom";
  target: ResourceRef;
};
```

不要直接引入 graph database。

第一阶段可以 runtime/in-memory/context based。

---

## 28. P3.3 — Automation / Trigger

Goal 表示一次 durable objective。

Automation 表示：

```text
Trigger
→ Condition
→ Capability / Goal
```

例如：

```text
Plex unreachable > 2 min
↓
run media diagnose goal
↓
if restart required
request approval
```

这一层不要提前塞进 Goal Runner。

建议未来独立：

```text
src/agent/automation/
```

---

## 29. P3.4 — Scheduled Goal

Automation 基础稳定后，再支持：

```text
schedule → start goal
```

而不是把 cron 直接写进 Goal 类型。

---

# 30. 推荐 PR 顺序

以下顺序可以直接执行。

## Core PR 1 — Capability Invocation Contract

范围：

```text
HomelabCapability metadata v1
ThebeAgent.invokeCapability
POST /v1/capabilities/{id}/invoke
OpenAPI schema
route tests
```

不要同时实现 Goal / Approval。

### Done when

- capability list 和 invoke 均不要求 App 使用 MCP JSON-RPC；
- policy/audit path 没被绕过；
- unknown capability 返回稳定 error code；
- destructive/confirm capability 不会无审批执行。

---

## Core PR 2 — Goal HTTP Surface

范围：

```text
POST/GET session goal
pause/resume/stop
Goal SSE
OpenAPI
route tests
```

复用现有 Goal Service / Runner。

### Done when

一个 Goal 可以在 curl/Postman 中：

```text
start
observe
pause
resume
finish
```

而不依赖 TUI。

---

## Core PR 3 — Approval Center Contract

范围：

```text
PendingApproval type
GET /v1/approvals
POST /v1/approvals/{id}/resolve
redaction
remember scope
OpenAPI/tests
```

### Done when

App 不需要从 transcript/event history 猜“现在是否有待审批”。

---

## Core PR 4 — Subagent / Worker HTTP

范围：

```text
profiles
runs
run detail
cancel
SSE activity
```

### Done when

App 可以做 Worker list/detail。

---

## Core PR 5 — Skills / Extensions API

范围：

```text
GET/PATCH skills
GET MCP servers
GET MCP tools
```

先 read/discovery；只有 persistence seam 稳定时才做 MCP server mutation。

---

## Core PR 6 — Resources & Agent Settings

范围：

```text
enabled resources
permission mode
auto summary/compact
safe concurrency settings
```

避免 TUI-only config 泄漏到 App product API。

---

## Core PR 7 — Activity Read Model

聚合：

```text
Goals
Subagents
Background Tasks
Sessions(optional)
```

提供 App Activity 首屏。

---

## Core PR 8 — Artifact / Operation Receipt

先为两个 vertical slice 服务：

```text
PVE diagnosis/action
Media acquisition pipeline
```

不要一开始设计几十种 artifact。

---

# 31. App 与 Core 并行开发顺序

推荐不要“Core 全做完，再做 App”。

应该 vertical slice 并行。

### Slice 1 — Capability

```text
Core
GET capabilities
POST invoke

App
CapabilityAPI
CapabilityStore
AgentActionMenu
```

跑通一个 read capability。

### Slice 2 — Goal

```text
Core
Goal HTTP + SSE

App
GoalAPI
ActivityStore
Goal Card
```

### Slice 3 — Approval

```text
Core
Approval discovery/resolve

App
ApprovalAPI
ApprovalStore
Approval Center
```

### Slice 4 — Worker

```text
Core
Subagent HTTP/SSE

App
Worker UI
```

这样每一步都有可见产品结果。

---

# 32. 第一个真正应该实现的 E2E

建议第一个完整闭环不是“媒体全链路”，而是更小的 Infrastructure slice：

```text
App VM Detail
↓
Agent Context Action: Diagnose
↓
Core creates/uses session
↓
Goal or agent run
↓
Worker/tool activity
↓
Structured diagnosis
↓
Proposed write action
↓
Approval
↓
Execute
↓
Verify
↓
Operation receipt
```

原因：

- PVE native client 已经成熟；
- Resource identity 清晰；
- read / write / approval / verify 都能覆盖；
- 不依赖 Emby/Immich 等尚未存在的 native provider；
- 可以一次验证 Agent-native contract 是否真正成立。

第二条再做媒体：

```text
Movie
↓
Find Source
↓
CloudSaver
↓
Save
↓
Activity
↓
STRM
↓
Library
```

---

# 33. 现在不要做的事情

### 不要换 Runtime

当前 Pi AgentRuntime replacement seam 已经存在。

除非明确发现 Runtime capability 阻塞，不要现在换框架。

### 不要重写 Goal Runner

Goal lifecycle 和 verification 已经存在。

当前缺的是 HTTP exposure 与产品 read model。

### 不要复制 TUI 功能到 HTTP

只暴露 App 需要的 product runtime capabilities。

### 不要给每个 NAS 服务写 Core Adapter

Service-specific deterministic data 继续主要由 App native providers 或 external MCP/integration plugin 提供。

### 不要把 `/mcp` 当 App backend

App product contract 使用 `/v1/*`。

### 不要先做复杂 Resource Graph DB

先稳定 ResourceRef 与 Relation type。

### 不要先写 scheduler/automation engine

Goal / Approval / Capability 都还没有完整 product HTTP contract 时，Automation 会建立在不稳定底座上。

### 不要过早统一所有任务 storage

Goal、Subagent、BackgroundTask 生命周期不同。

先统一 read model，而不是统一 implementation。

---

# 34. Error Contract

随着 App 开始正式消费 Core，应逐渐稳定错误 code。

建议至少：

```text
AGENT_UNAVAILABLE
SESSION_NOT_FOUND
SESSION_BUSY
CAPABILITY_NOT_FOUND
CAPABILITY_UNAVAILABLE
APPROVAL_REQUIRED
APPROVAL_NOT_FOUND
GOAL_NOT_FOUND
GOAL_NOT_PAUSABLE
SUBAGENT_NOT_FOUND
INVALID_ARGUMENT
QUIESCED
UNAUTHORIZED
```

HTTP status + code 分离。

App 不要解析英文 error message 决定 UI。

---

# 35. Idempotency

对 write capability，P1/P2 需要开始考虑：

```text
Idempotency-Key
```

尤其：

- VM start/stop；
- container restart；
- cloud save；
- download submit；
- media request。

第一阶段如果 provider 本身能安全重复，可暂不做 global storage，但 contract 应预留。

---

# 36. Security Invariants

以下现有规则必须保留：

1. Pi implementation type 不离开 `src/adapters/pi`。
2. Tool / MCP output 视为 untrusted data。
3. Redaction 在进入 model history 与写 audit 前执行。
4. Audit 不能由 routine/model 关闭。
5. Workspace path 是 authorization boundary。
6. Production 需要 token；plaintext credential endpoints 应放在 HTTPS/Tailscale 后面。
7. Subagent 不继承 parent transcript 和 control-plane tools。
8. Goal worker 必须继续走 Agent/Subagent module，不能另建绕过 permission/audit 的执行 loop。

任何新 HTTP route 都不得绕过这些 invariant。

---

# 37. Performance / Reliability Baseline

新增 SSE 时统一考虑：

```text
client disconnect cleanup
listener unsubscribe
bounded retained events
heartbeat / idle behavior
abort semantics
server quiesce
```

不要让 Goal/Subagent SSE 引入新的永久 listener leak。

HTTP read model 应避免：

```text
N sessions × reopen runtime transcript
```

列表只使用 metadata / retained control-plane state。

---

# 38. Testing Strategy

每个阶段：

```text
feature unit tests
↓
HTTP route tests
↓
pnpm typecheck
↓
pnpm test
↓
pnpm build
```

新 Agent product API 优先 fake runtime / fake agent 测试，不把 Pi network/model dependency 带进 HTTP contract test。

Goal / Subagent 的 resume/cancel 测试必须包含状态转换，而不只测试 response 200。

Approval 测试至少包含：

```text
redacted input
allow
deny
remember once/resource/service/capability/goal（按实现支持）
stale approval
```

---

# 39. Definition of Done — Core vNext Foundation

当以下条件成立，可以认为 Core 已准备好支撑新的 Thebe App：

- [ ] Capability 有稳定 list + invoke HTTP contract
- [ ] Goal 可以通过 HTTP 创建、读取、订阅、暂停、恢复、停止
- [ ] Pending Approval 可以独立查询并 resolve
- [ ] Subagent/Worker 可以 list/detail/subscribe/cancel
- [ ] Skills 可以 list + enable/disable
- [ ] MCP servers/tools 有 product discovery API
- [ ] Enabled Resources 有安全的 read/update API
- [ ] Permission Mode 有 App-facing settings API
- [ ] 新 endpoints 有明确 OpenAPI schema
- [ ] 新 endpoints 有 error code contract
- [ ] iOS 不需要 raw MCP 才能实现 Activity / Approval / Context Action
- [ ] TUI 仍然继续工作，不依赖 HTTP
- [ ] Pi runtime 没有泄漏到 delivery/product types
- [ ] policy / approval / redaction / audit path 没有被新接口绕过

---

# 40. 可以立即开始的第一批任务

从现在开始，可以直接创建下面 4 个开发任务，不需要继续做大范围研究。

## Task 1 — Capability Invocation

修改候选：

```text
src/agent/interface.ts
src/agent/extensions/mcp.ts
src/agent/* capability service
src/delivery/http/routes/capability.ts
src/delivery/http/routes/agent-api.ts
src/delivery/http/openapi.ts
HTTP tests
```

目标：

```text
GET  /v1/capabilities
POST /v1/capabilities/{id}/invoke
```

## Task 2 — Goal HTTP

修改候选：

```text
src/delivery/http/routes/goal.ts
src/delivery/http/router.ts / agent-api.ts
src/delivery/http/protocol/sse.ts
src/delivery/http/openapi.ts
HTTP tests
```

核心 Goal 代码原则上不重写。

## Task 3 — Approval Discovery

修改候选：

```text
src/agent/internal/permission-control.ts
src/agent/interface.ts
src/delivery/http/routes/approval.ts
src/delivery/http/openapi.ts
HTTP tests
```

目标：让 App 不再依赖 event transcript 才知道有审批。

## Task 4 — Subagent HTTP

修改候选：

```text
src/delivery/http/routes/subagent.ts
src/delivery/http/openapi.ts
HTTP tests
```

尽量复用现有 `SubagentRun` / subscribe API。

---

# 41. 推荐今天就从哪里开始

如果只选一个任务：

> **先做 Core PR 1 — Capability Invocation Contract。**

原因：

1. `/v1/capabilities` 已经存在，改动上下文最小；
2. 它直接对应 App `CapabilityRegistry`；
3. 可以验证 product metadata、permission、error contract；
4. 不需要先改 Goal persistence；
5. 做完后立刻可以在 App PVE/Plex 页面尝试第一个 typed `AgentAction`。

第一版不要追求完整 Resource system。

先实现：

```text
list capability
↓
select by id
↓
validate args
↓
policy
↓
invoke
↓
audit
↓
result/error
```

这就是当前最小、价值最高的开工点。

---

# 42. 最终原则

Core 接下来的路线不是继续把自己做成“更大的 agent framework”。

它应该越来越像：

```text
Agent Runtime
+
Capability Plane
+
Durable Execution Control Plane
+
Permission / Audit Boundary
```

对 App 来说，稳定看到的是：

```text
Capabilities describe what can be done.
Goals describe what is being pursued.
Workers describe delegated execution.
Approvals describe decisions waiting for the user.
Events describe what is happening now.
Artifacts/Receipts describe what was produced or changed.
```

这套 contract 稳定后，Thebe App 才能真正做到 Agent Everywhere，而不是 Chat Everywhere。