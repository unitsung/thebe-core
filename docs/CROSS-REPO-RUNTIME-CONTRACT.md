# Cross-repo runtime contract (product objects)

Status: implementation contract for Vertical Slice 01 (diagnosis) and Slice 02 (approved restart). Real `dev` code is the source of truth for how objects are produced; this file is the client-visible boundary.

The iOS App must not call raw MCP `tools/call` for product workflows. Core may reuse `container.*` tools internally.

## ResourceRef

Stable typed handle. Identity is `kind` + `id` + `provider` (+ instance/environment). Display names are labels only and must never be concatenated into a prompt as identity.

```json
{
  "kind": "container",
  "id": "ctr-emby",
  "name": "emby",
  "provider": "arcane",
  "instanceId": "uuid",
  "environmentId": "0",
  "image": "emby/embyserver:4.8"
}
```

`provider` is `arcane` | `portainer` | `unknown`. Media servers are Emby-first as a reference scene; the object stays provider-neutral.

## Diagnosis (read-only)

`POST /v1/diagnosis`

Request: `{ "resource": ResourceRef, "question"?: string }`

Response:

| Field | Meaning |
| --- | --- |
| `runId` | Diagnosis run identifier |
| `actionId` | `container.diagnose` |
| `resource` | Echo of the typed ref |
| `observations` | Tool/provider facts only (`source`, `observedAt`, resource provenance) |
| `diagnosis` | Interpretation. `tokenUsed` records whether a model turn ran |
| `recommendations` | Suggestions. Write items set `requiresApproval: true` and are not executed |
| `technicalDetails` | Cropped evidence + tool transcript. Not an agent state dump |

`GET /v1/diagnosis/:runId` reads the in-memory run. `POST /v1/diagnosis/:runId/why` asks for reasoning over the same observations.

Diagnosis recommendations may include `actionId: "container.restart"` with `requiresApproval: true`. Diagnosis never executes the write.

## Approved restart (container.restart)

Capability metadata is **code**, not model output (`CONTAINER_CAPABILITY_METADATA` / `GET /v1/capabilities`):

| Field | Value |
| --- | --- |
| `id` | `container.restart` |
| `effect` | `write` |
| `risk` | `disruptive` |
| `approval` | `required` |
| `permission` | `confirm` |

`POST /v1/action`

```json
{
  "actionId": "container.restart",
  "resource": { "kind": "container", "id": "ctr-emby", "provider": "arcane" },
  "diagnosisRunId": "optional",
  "idempotencyKey": "restart:ctr-emby:run-id",
  "approval": { "approved": true, "approvedAt": "2026-09-17T00:00:00Z", "client": "ios" }
}
```

Missing `approval.approved: true` → HTTP 403, `action.status=rejected`, restart is not called.

Response is an `ActionReceipt`: `approval`, `action` (ActionResult), `verification` (VerificationResult), `receiptId`, `idempotencyKey`. Duplicate `idempotencyKey` for the same resource returns the same receipt.

Verification is programmatic: `container.state == running`. If the resource looks like Emby and a probe is available, also check Emby public info. The model may only explain `VerificationResult`; it cannot decide approval, execution, or pass/fail.

`GET /v1/action/:receiptId` reads the receipt. The App must not call `/mcp` or Pi internals for this path.

## Minimal Activity (ActionReceipt persistence)

This is **not** a Goal/Run/Activity product. It is a durable snapshot of one `container.restart` ActionReceipt so the user can leave Diagnosis and still see what happened.

`GET /v1/activity` → `{ "activities": ActivityRecord[] }` (newest first)  
`GET /v1/activity/:id` → one record

| Field | Meaning |
| --- | --- |
| `id` | Stable; equals `receiptId` |
| `kind` / `actionId` | `container.restart` |
| `resource` | Typed ResourceRef |
| `status` | `succeeded` / `failed` / `rejected` / `provider_unavailable` / `verification_failed` |
| `summary` | User-facing action summary |
| `createdAt` / `updatedAt` | ISO timestamps |
| `approval` / `action` / `verification` | Snapshots from the receipt |
| `receiptId` / `idempotencyKey` | References |

Persisted under `{agentStoreDir}/activity/*.json` (atomic write). Corrupt files are skipped. Retention is bounded. The same idempotency key does not create a second record. Listing and display use **0 tokens**.

## Token boundary

- Container Detail native CPU / memory / status / logs: **0 tokens**. Direct provider HTTP in the App.
- Observation collection: **0 tokens**. Core tool layer (redact, truncate, sample, extract facts) before any model.
- High-confidence deterministic diagnosis (exited/dead/unhealthy/paused): **0 tokens**.
- Ambiguous cases and Ask why: **model used**, facts still come only from observations.
- Approved restart execute + deterministic verification: **0 tokens**.
- Optional explanation of VerificationResult: **model used**, facts only.

## Anti-patterns

- App concatenating `displayName` into a chat prompt
- App posting to `/mcp` for diagnosis
- Sending full Docker inspect or full logs to the model
- Returning agent internal state, transcripts, or Pi types to the App
- Inventing observations when the provider is down
