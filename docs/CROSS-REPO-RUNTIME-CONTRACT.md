# Thebe App ↔ Core Runtime Contract

> Baseline: `unitsung/thebe@dev` + `unitsung/thebe-core@dev`
>
> Status: implementation contract
>
> Companion docs:
>
> - `unitsung/thebe/docs/PRODUCT-THESIS.md`
> - `unitsung/thebe/docs/AGENT-NAS-DESIGN-PRINCIPLES.md`
> - `unitsung/thebe/docs/AGENT-NATIVE-REFACTOR.md`
> - `unitsung/thebe-core/docs/CORE-ITERATION-PLAN.md`



## Shipped vertical slices (dev implementation)

The following HTTP product objects are implemented on `dev` and are the current App/Core boundary. They do not replace the rest of this contract.

- **Diagnosis (read-only):** `POST /v1/diagnosis`, `GET /v1/diagnosis/:runId`, `POST /v1/diagnosis/:runId/why`. App sends typed `ResourceRef`. Observations come from container tools after redaction/truncation. Diagnosis never executes writes.
- **Approved restart:** `container.restart` metadata is code (`effect=write`, `risk=disruptive`, `approval=required`). `POST /v1/action` requires on-device `approval.approved`. Core then restarts deterministically and verifies `state==running` (Emby health when applicable). Returns `ActionReceipt`.
- **Minimal Activity:** `GET /v1/activity` / `GET /v1/activity/:id` persist ActionReceipt snapshots under `{agentStoreDir}/activity`. Not a Goal/Run product. Same idempotency key maps to one record. List/display use 0 tokens.
- **Activity v1 groups:** Diagnosis runs persist as `container.diagnose`. `GET /v1/activity?group=needs_approval|running|recent` (and a `group` field on each record). A diagnosis with an unexecuted `container.restart` recommendation is `needs_approval` until a restart receipt with that `diagnosisRunId` exists. Running is empty while diagnosis/restart stay synchronous. 0 tokens.
- **Product Goal HTTP:** `POST/GET /v1/goals`, `GET /v1/goals/{id}`, `POST /v1/goals/{id}/pause|resume|stop`, `GET /v1/goals/{id}/log` (JSON or SSE). Identity is the parent `thebeSessionId` (`id` === `sessionId`); no separate Goal id and no `GET /v1/goals/{id}/runs`. Runtime `pausing` collapses to product `running`. Session-scoped aliases: `/v1/session/{id}/goal*`. Responses are `ProductGoal` / `ProductGoalEvent`, not Pi/MCP internals. Swift Goal Store is out of scope for this slice.

The App must not call raw MCP `tools/call` for these workflows.


---

## 1. Purpose

Thebe is split across two repositories with different responsibilities:

```text
Thebe iOS / SwiftUI
        ↕
Stable Product Contract
        ↕
Thebe Core / TypeScript
```

This document defines the boundary so both repositories can evolve independently without duplicating Agent semantics or forcing deterministic UI through the model/runtime.

The contract must support:

- ordinary native deterministic reads;
- explicit user actions;
- contextual Agent actions;
- durable Goals/Runs;
- approvals;
- verification;
- activity/event rendering;
- capabilities;
- resource identity/context;
- background work.

---

## 2. Non-goal: Core as a proxy for every provider API

The App already has native provider/client code.

Do not make this the default:

```text
SwiftUI
→ Core
→ Plex/PVE/qBittorrent
→ Core
→ SwiftUI
```

for every normal read.

Preferred deterministic read path:

```text
SwiftUI
→ Domain Store
→ Native Provider
→ Service API
```

Core becomes mandatory when the operation requires Core-owned runtime semantics such as:

- reasoning/planning;
- durable Goals;
- cross-service orchestration;
- background execution;
- authoritative approval state;
- Core-owned capability execution;
- runtime event history.

---

## 3. Ownership matrix

| Concern | App | Core | Notes |
| --- | --- | --- | --- |
| Native UI/presentation | **Owner** | No | SwiftUI |
| Fast provider reads | **Owner where native client exists** | Optional | Avoid unnecessary proxying |
| Device-native features | **Owner** | No | Keychain, iOS integrations, presentation |
| View/domain stores | **Owner** | No | Presentation/domain state |
| Model/runtime orchestration | No | **Owner** | No duplicate full Agent loop |
| Goal lifecycle | Consumer | **Owner** | Durable |
| Run lifecycle | Consumer | **Owner** | Durable |
| Worker/subagent lifecycle | Consumer | **Owner** | Expose product schema |
| Model selection/context | UI/config consumer | **Owner** | Runtime concern |
| Skills/MCP runtime | Consumer/admin UI | **Owner** | MCP not product API |
| Policy/permission authority | UI resolution surface | **Owner** | App must not override |
| Approval rendering | **Owner** | State owner | App displays + resolves |
| Cross-service planning | No | **Owner** | Core |
| Verification definitions | Shared contract | **Owner for Core actions** / local for local capability | Must be deterministic |
| Runtime audit | Cache/presentation | **Owner** | Avoid two authoritative audits |
| Resource presentation | **Owner** | Context consumer | Stable ResourceRef shared |

---

## 4. Required product contract types

The HTTP/OpenAPI surface should converge on intentional product types rather than internal runtime dumps.

### 4.1 ResourceRef

A stable identity that both App and Core understand.

```ts
interface ResourceRef {
  id: string
  kind: string
  provider?: string
  instanceId?: string
  displayName?: string
}
```

Examples:

```json
{
  "id": "102",
  "kind": "virtual_machine",
  "provider": "proxmox",
  "instanceId": "home-pve"
}
```

```json
{
  "id": "plex:movie:12345",
  "kind": "media_item",
  "provider": "plex",
  "instanceId": "home-plex"
}
```

The exact field names may be revised, but identity must not depend on a display string or prompt text.

---

### 4.2 AgentFact / Observation

Bounded structured evidence supplied to reasoning.

```ts
interface AgentFact {
  key: string
  value: unknown
  source?: string
  observedAt?: string
  confidence?: number
}
```

This is not intended to serialize every provider response.

The fact/observation layer must preserve enough provenance for debugging and explanation.

---

### 4.3 CapabilityDescriptor

```ts
interface CapabilityDescriptor {
  id: string
  title: string
  description?: string
  inputSchema?: unknown
  resourceKinds?: string[]
  effect: "read" | "write"
  risk?: string
  approval: "never" | "conditional" | "required"
  supportsVerification?: boolean
}
```

Capability risk/approval metadata is runtime policy input, not model prose.

---

### 4.4 CapabilityInvocation

```ts
interface CapabilityInvocation {
  capabilityId: string
  resource?: ResourceRef
  input?: unknown
  idempotencyKey?: string
  requestedBy?: "user" | "agent" | "automation" | "system"
}
```

---

### 4.5 ActionResult

```ts
interface ActionResult<T = unknown> {
  actionId: string
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled"
  result?: T
  error?: ProductError
  verification?: VerificationResult
}
```

---

### 4.6 VerificationResult

```ts
interface VerificationResult {
  status: "verified" | "failed" | "partial" | "not_applicable"
  checks: VerificationCheck[]
}

interface VerificationCheck {
  id: string
  title: string
  passed: boolean
  observed?: unknown
  expected?: unknown
  message?: string
}
```

The model may explain verification results but must not fabricate them.

---

### 4.7 Goal

```ts
interface Goal {
  id: string
  title: string
  status: "queued" | "running" | "waiting_approval" | "paused" | "succeeded" | "failed" | "cancelled"
  resourceRefs?: ResourceRef[]
  currentRunId?: string
  createdAt: string
  updatedAt: string
}
```

Goal is the durable user objective.

---

### 4.8 Run

```ts
interface Run {
  id: string
  goalId?: string
  sessionId?: string
  status: string
  progress?: number
  currentStep?: string
  createdAt: string
  updatedAt: string
  error?: ProductError
}
```

Run is one execution attempt.

---

### 4.9 Worker

Product-facing representation of subagent/background delegated work.

```ts
interface Worker {
  id: string
  runId: string
  title: string
  status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled"
  role?: string
}
```

The App should not require Pi/subagent internal types to render Workers.

---

### 4.10 Approval

```ts
interface Approval {
  id: string
  runId?: string
  actionId?: string
  capabilityId: string
  resource?: ResourceRef
  status: "pending" | "approved" | "denied" | "expired" | "cancelled"
  reason: string
  risk?: string
  createdAt: string
  resolvedAt?: string
}
```

Approval must be discoverable after the original request is gone.

---

### 4.11 ActivityEvent

```ts
interface ActivityEvent {
  id: string
  runId?: string
  goalId?: string
  type: string
  phase?: "observe" | "reason" | "plan" | "approval" | "execute" | "verify" | "result"
  title: string
  detail?: string
  resource?: ResourceRef
  timestamp: string
  payload?: unknown
}
```

`payload` must remain optional and should not force the App to understand runtime internals.

---

### 4.12 ProductError

```ts
interface ProductError {
  code: string
  message: string
  retryable?: boolean
  resource?: ResourceRef
  details?: unknown
}
```

Avoid exposing arbitrary stack traces as the only error contract.

---

## 5. HTTP API priorities

The active Core plan already identifies missing product APIs. Prioritize these before expanding UI concepts.

### P0 — Capability invocation

```text
GET  /v1/capabilities
POST /v1/capabilities/{id}/invoke
GET  /v1/actions/{actionId}
```

Exact route names can change, but capability execution must become first-class instead of relying on prompt/raw MCP workarounds.

### P0 — Approvals

```text
GET  /v1/approvals?status=pending
GET  /v1/approvals/{id}
POST /v1/approvals/{id}/resolve
```

Existing session-scoped permission resolution can remain internally compatible during migration.

### P0 — Goals/Runs

Shipped (identity is `thebeSessionId`; session-scoped aliases under `/v1/session/{id}/goal*`):

```text
POST /v1/goals
GET  /v1/goals
GET  /v1/goals/{id}
POST /v1/goals/{id}/pause
POST /v1/goals/{id}/resume
POST /v1/goals/{id}/stop
GET  /v1/goals/{id}/log
```

Not shipped in this slice (do not add a second Goal id to paper over them):

```text
GET  /v1/goals/{id}/runs
GET  /v1/runs/{id}
```

### P0/P1 — Activity stream

Provide either Run/Goal-scoped SSE or a normalized account/runtime activity stream.

The key requirement is stable `ActivityEvent`, not the exact URL.

### P1 — Workers

Product API for subagent lifecycle/status.

### P1 — Resource exposure

Allow the App/admin to control which resources or resource categories the Agent may observe/use.

### P1 — Skills / extension inventory

Expose product-level skill metadata without requiring the App to speak raw MCP.

---

## 6. Deterministic data path contract

The Core contract must not force deterministic provider state into Core.

Example VM page:

```text
App VM Store
→ native PVE client
→ VM state
→ SwiftUI
```

If user taps a direct action that the App currently executes safely and locally, migration to a Core capability may happen incrementally.

However once an action participates in Agent/automation/background execution, it should converge on a capability contract so all execution surfaces share policy and verification semantics.

---

## 7. Contextual Agent action contract

SwiftUI must not construct semantic behavior by concatenating prompts.

Bad:

```swift
openThebe(prefill: "Please diagnose VM 102 and check Plex...")
```

Preferred conceptual request:

```json
{
  "action": "infrastructure.vm.diagnose",
  "resource": {
    "kind": "virtual_machine",
    "provider": "proxmox",
    "id": "102"
  }
}
```

Core can then create/reuse a Session or Goal with typed context.

---

## 8. Approval lifecycle contract

Target lifecycle:

```text
Run selects write capability
→ Core policy evaluates
→ Approval created
→ Run pauses durably
→ pending Approval appears in App
→ user approves/denies
→ App sends resolution
→ Core resumes/stops execution
→ ActivityEvent emitted
```

The App must not simulate "approval" while allowing Core execution to continue in parallel.

---

## 9. Verification lifecycle contract

Capability definitions should declare whether/how verification occurs.

Examples:

```text
vm.start
→ VM state becomes running

container.restart
→ container running + health check

library.rescan
→ scan accepted/completed where provider supports it

strm.repair
→ path resolves + target accessible + media item revalidated
```

Verification results belong in `ActionResult` / Activity, not only in natural-language Agent output.

---

## 10. Activity semantics

Activity is the product surface that makes Agent execution trustworthy.

A typical timeline:

```text
14:32  Playback issue investigation started
14:32  Plex reachable
14:32  Active stream is transcoding
14:33  Transcoder memory pressure detected
14:33  Restart transcode worker proposed
14:33  Approval requested
14:34  User approved
14:34  Worker restarted
14:35  Plex health verified
14:35  Playback path verified
14:35  Resolved
```

The App should build this from normalized events/results, not by parsing model prose.

---

## 11. Compatibility and migration

Do not break the current Chat/Core path in one change.

Recommended migration:

### Phase 1

Add product schemas and endpoints while keeping existing session/prompt/SSE APIs.

### Phase 2

Add Swift domain clients:

```text
CoreTransport
CapabilityAPI
ApprovalAPI
GoalAPI
ActivityAPI
ResourceAPI
```

These may initially share one underlying transport implementation.

### Phase 3

Move contextual actions from prompt construction to typed calls.

### Phase 4

Move durable work/permission UI into Activity/Approval surfaces.

### Phase 5

Classify/deprecate redundant local Agent runtime code after behavior parity is proven.

---

## 12. Testing contract

Every first-class API must have:

- Core service tests;
- HTTP handler/contract tests;
- OpenAPI schema coverage where applicable;
- failure/authorization tests;
- App decoding tests;
- at least one cross-repo fixture or golden payload for critical product types.

Critical compatibility types:

```text
ResourceRef
CapabilityDescriptor
ActionResult
Approval
Goal
Run
ActivityEvent
VerificationResult
ProductError
```

---

## 13. Codex task decomposition rule

Do not ask Codex to implement a cross-repo feature as one vague task.

Split each vertical feature in dependency order.

Example — Approvals:

```text
CORE-1  Define Approval product model
CORE-2  Map permission runtime → Approval
CORE-3  Add list/get/resolve HTTP API + tests
CORE-4  Update OpenAPI
APP-1   Add Approval DTO/domain model
APP-2   Add ApprovalAPI
APP-3   Add Approval Store
APP-4   Add pending approval UI
APP-5   Link Activity → Approval
E2E-1   Validate pause → resolve → resume lifecycle
```

Each task must state:

```text
repo
branch = dev
dependency
files/areas
contract impacted
acceptance criteria
what must not be changed
```

---

## 14. Architecture invariants

The following invariants should be treated as review blockers unless intentionally changed in an ADR:

1. Ordinary deterministic reads do not require an LLM.
2. Core runtime internals do not leak directly into Swift product models.
3. iOS does not use raw MCP as its normal product API.
4. Risk/approval is not decided only by model prose.
5. Verification is deterministic wherever a provider/API check exists.
6. Long-running work is represented by durable runtime objects.
7. Agent contextual actions use typed resource identity, not only prompt text.
8. App and Core do not maintain two independent authoritative permission/audit systems.
9. A model/provider swap must not require redesigning product-level action semantics.
10. Native provider clients are not rewritten merely to make architecture look more centralized.

---

## 15. Definition of done for the cross-repo foundation

The foundation is considered established when the following end-to-end scenario works without prompt hacks:

```text
1. User opens a native resource detail page.
2. App reads current state directly/deterministically.
3. User invokes a typed contextual Agent action.
4. Core creates a Run/Goal or action with ResourceRef context.
5. Core gathers typed facts and reasons.
6. A write capability requires approval.
7. App receives/displays a durable Approval.
8. User approves.
9. Core executes the capability.
10. Deterministic verification runs.
11. App receives normalized Activity events and final ActionResult.
12. Resource UI refreshes from authoritative provider state.
```

Once this vertical slice is stable, broader Goal/Worker/Resource Graph work can build on a proven contract instead of parallel ad-hoc integrations.
