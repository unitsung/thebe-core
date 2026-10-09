# Core durable product contract

Updated: 2026-10-06.

Documentation reconciliation: 2026-10-08. Artifact kinds below reflect the current
source/OpenAPI contract; this edit adds no deployment or real-provider acceptance evidence.

Status: current workspace closes the remaining code gaps with qBittorrent native tasks and bounded `task_output` Artifacts. Settings, Artifacts, recovery, and the Activity feed are consumed by the iOS client. Provider acceptance and deployment are separate verification steps; OpenList, Arcane and qBittorrent tasks are re-read from their providers.

Tracking issue: [#4](https://github.com/unitsung/thebe-core/issues/4)

The Agent settings slice is now available through `ThebeAgent.getAgentSettings()` /
`updateAgentSettings()` and `GET/PATCH /v1/settings/agent`. It persists the
mutable values through the existing Thebe config boundary, keeps permission
mode on `/v1/settings/permissions`, and reports concurrency changes as
restart-required. Enabled resource selections now use that same boundary and
survive Agent recreation. Core now stores bounded, redacted operation-receipt,
Diagnosis, enabled-resource snapshot, direct or background Capability result,
terminal Goal report, and terminal Worker report Artifacts with
metadata/content HTTP reads. Activity now includes durable read-only Diagnosis,
Capability Run, Worker, and Core-owned Background Task items; cursorable
aggregation and source/status/time filters are now available. Pi detached Bash
jobs are registered at the adapter seam and their bounded snapshots survive
runtime recreation; OpenList provider-native task discovery/control and Arcane
provider activity discovery/control now join the Activity source seam, while
further provider-native task sources remain future producers.

This spec turns the remaining Core product-contract work into one executable
backlog. The highest seam is `ThebeAgent` and its product HTTP delivery; the
runtime adapters and provider integrations remain behind that seam.

## Problem Statement

Thebe Core already owns sessions, Goals, Workers, capabilities, permissions,
resources, and audit. The remaining gaps are provider task sources that are not on the
background-task seam yet:

- Agent settings, enabled resources, and permission mode are shipped.
  `ThebeCoreClient` reads and updates them.
- Capability runs, Goals, Workers, and Core-owned detached Bash tasks keep
  durable snapshots. An older active snapshot is `interrupted` and is not
  replayed. OpenList and Arcane tasks are listed from the provider on every
  read, so a Core restart does not drop them and they do not carry a Core
  `recovery` field.
- Artifact kinds are `diagnosis`, `report`, `resource_list`,
  `operation_receipt`, and `task_output`. Direct and background capability results, including
  provider capabilities such as Navidrome, are stored as redacted `report`
  Artifacts. Completed provider task output can be persisted as a bounded,
  redacted `task_output` Artifact linked to the task; this is not a general
  file-export or upload contract. Persistence failure does not hide the task.
- Activity already unions approvals, receipts, diagnoses, Goals, capability
  runs, Workers, and background tasks, with cursor pagination and
  source/status/time filters. The iOS client consumes that feed. Another
  provider-native task producer would extend the same feed.
- Emby, Jellyfin, Immich, and Navidrome remain library adapters. They are not
  background-task providers. The contract does not name the next task source.

For a provider that is not on that seam, a product client still cannot answer
“what work is active?” without a provider-specific call. Shipped sources do
not have that gap.

## Solution

Complete the remaining durable product-contract work in three compatible tracks:

1. Keep the shipped settings, Artifact, recovery, and OpenAPI contracts aligned
   with `ThebeCoreClient`. The current App already covers those surfaces.
2. Add further provider-native background-task producers, and an Artifact kind
   for a task's own output, without moving lifecycle ownership out of their
   source adapters. Capability results stay `report` Artifacts.
3. When a new producer is added, expose it through the existing Activity read
   model. OpenList and Arcane already do this by live provider reads. Do not
   create a second Agent loop or a second lifecycle owner.

The existing `/v1/settings/permissions`, `/v1/permissions`, `/v1/activity`,
Goal routes, Worker routes, capability routes, and raw `/mcp` compatibility
surface remain compatible. New product routes must delegate to ThebeAgent and
must not call Pi, MCP, or providers directly.

## User Stories

1. As an App client, I want to read the effective Agent settings, so that the
   settings screen reflects what the running Core actually uses.
2. As an App client, I want to distinguish configured values from safe
   defaults, so that a missing config value is not presented as an accidental
   runtime mutation.
3. As an operator, I want to enable or disable automatic summaries, so that I
   can control background model work without editing a host file.
4. As an operator, I want to configure the automatic-summary delay, so that
   summaries fit the way I use Core.
5. As an operator, I want automatic-summary delay values to be clamped to a
   documented safe range, so that an HTTP client cannot create a busy loop or a
   timer that never fires.
6. As an operator, I want to read and safely update the default auto-compact
   behavior, so that new sessions use an intentional context policy.
7. As an operator, I want to see subagent concurrency limits, so that I can
   understand why work is queued.
8. As an operator, I want concurrency changes either to apply to future work or
   to report that a restart is required, so that Core never claims a setting
   changed while an old manager still enforces the old value.
9. As an operator, I want workspace and output directories exposed as guarded
   read-only settings, so that the UI can explain the authorization boundary
   without being allowed to move it casually.
10. As an operator, I want safe Agent settings to survive a Core restart, so
    that configuration does not silently revert to startup defaults.
11. As an operator, I want invalid settings to return stable validation errors,
    so that clients can correct input without parsing runtime exceptions.
12. As an App client, I want to list Artifacts by session, run, kind, or time,
    so that I can build a result history without reading transcripts.
13. As an App client, I want to inspect one Artifact's metadata, so that I can
    render its title, kind, owner, timestamps, and relationships deterministically.
14. As an App client, I want to retrieve Artifact content through a bounded
    product endpoint, so that the UI never needs to access Core's filesystem.
15. As an operator, I want Artifact content types and sizes to be explicit, so
    that the client can choose a safe renderer and avoid unbounded downloads.
16. As an operator, I want secrets redacted before Artifact persistence, so
    that a provider response cannot turn the Artifact store into a credential
    leak.
17. As an operator, I want Artifact writes to be atomic and recoverable, so
    that a process interruption cannot leave a misleading half-written result.
18. As an operator, I want Artifact retention to be bounded, so that repeated
    background work cannot grow the Core store without limit.
19. As an App client, I want a completed capability run to retain its stable
    result or Artifact references after Core recreation, so that a result does
    not disappear when the service restarts.
20. As an App client, I want an interrupted active run to be explicitly marked
    interrupted, so that the UI never shows a stale “running” object forever.
21. As an operator, I want Core to avoid automatically replaying arbitrary
    active capabilities after restart, so that a write-capable integration is
    not executed twice without an idempotency decision.
22. As an App client, I want run recovery semantics to be visible in the
    response, so that “restored”, “interrupted”, and “resumed” are not guessed
    from timestamps.
23. As an App client, I want capability runs, Goals, Workers, and background
    tasks to expose stable status and timestamps, so that one activity surface
    can render them consistently.
24. As an App client, I want a normalized Activity read model to combine source
    objects without changing their lifecycle owners, so that Core does not
    duplicate Goal, Worker, or capability state machines.
25. As an App client, I want Activity results to be ordered and cursorable, so
    that a reconnect does not require downloading an unbounded history.
26. As an App client, I want Activity entries to link back to the source run,
    session, resource, and Artifact, so that detail screens can follow the
    relationship without parsing display text.
27. As an App client, I want Activity reads to use zero model tokens, so that
    showing history is deterministic and inexpensive.
28. As an App client, I want capability-run and Worker status changes to have a
    normalized event shape, so that each screen does not implement a separate
    runtime-event decoder.
29. As an operator, I want enabled resources to survive Core recreation, so
    that an explicitly enabled skill or extension is not silently disabled.
30. As an operator, I want permission mode persistence to be explicit, so that
    a restart cannot unexpectedly change Core from `ask` to another mode.
31. As an operator, I want pending interactive permissions to remain ephemeral
    and deny safely on restart, so that a stale approval cannot be replayed
    after its originating process is gone.
32. As an App client, I want the existing separate permission and Activity
    approval semantics documented in the response, so that a runtime tool
    confirmation is not confused with a diagnose-restart Approval.
33. As an App client, I want OpenAPI schemas for settings, Artifacts, runs, and
    Activity entries, so that the client contract does not depend on internal
    runtime types.
34. As an operator, I want all new product surfaces to pass through the Agent
    policy, redaction, audit, and quiesce rules, so that adding a read model
    does not create a bypass around Core's safety boundary.

## Implementation Decisions

- Use the existing `ThebeAgent` interface as the highest integration seam.
  Delivery parses and maps HTTP input; Agent services own policy, lifecycle,
  persistence, and recovery decisions.
- Add a typed Agent settings product object and a corresponding read/update
  service. Keep permission mode as its existing separate setting surface, but
  expose its persistence status in the overall settings contract.
- Persist user configuration through the existing Thebe configuration
  boundary, not inside AgentStore. AgentStore remains metadata-only and must
  not gain transcripts, branches, compaction records, or OAuth credentials.
- Treat workspace path and output directory as read-only or guarded values.
  HTTP settings must not become an arbitrary filesystem relocation API.
- Keep runtime-only UI settings such as theme, fullscreen mode, and startup
  noise out of the Agent settings contract.
- Introduce `AgentArtifact` as a product object with stable id, kind, title,
  optional session/run/resource references, timestamps, content type, bounded
  size, and content or a Core-owned content reference.
- Store Artifact metadata and content separately from AgentStore, using atomic
  writes, safe identifiers, bounded retention, and server-side redaction.
  Artifact retrieval must never expose an arbitrary host path.
- Keep the explicit Artifact kinds: `diagnosis`, `report`, `resource_list`,
  `operation_receipt`, and `task_output`. Do not build an arbitrary filesystem
  browser or upload system.
- Allow capability runs and other product objects to reference Artifact ids.
  Keep small bounded result payloads inline when useful, but do not make an
  unbounded run result the long-term storage contract.
- Preserve the current capability-run recovery rule: terminal snapshots are
  restored; queued/running snapshots from an older Core instance become
  explicitly interrupted unless a capability later declares an idempotent,
  resumable execution policy.
- Do not automatically replay arbitrary capability calls after restart.
  Resumability must be an explicit capability contract with idempotency and
  checkpoint semantics.
- Extend durable snapshots for Goal, Worker, and background-task read models
  without merging their source state machines. Recovered active work must have
  an explicit interrupted/paused policy.
- Add a normalized Activity read model over source objects. It is an
  aggregation/read seam, not a second lifecycle owner and not a transcript
  dump.
- Keep runtime pending permissions at `/v1/permissions` and diagnose-restart
  approvals in Activity. Do not introduce a competing `/v1/approvals` route in
  this spec unless the product contract is deliberately changed in a separate
  decision.
- Persist enabled-resource selections through an Agent-owned resource store or
  configuration adapter, and make permission-mode persistence explicit. The
  pending request map itself remains ephemeral and fail-closed on restart.
- Add product HTTP routes only after the Agent methods exist. Every new route
  gets OpenAPI schemas, stable error codes, quiesce behavior for mutations,
  authentication behavior, and agent-unavailable behavior.
- Do not make App clients call raw MCP JSON-RPC, provider adapters, or runtime
  objects for any of these workflows.

## Testing Decisions

- Tests assert externally visible Agent and HTTP behavior rather than private
  maps, timer handles, or file naming details.
- Settings tests cover effective values, defaults, allowed mutations, bounds,
  read-only fields, persistence across a new Agent instance, and stable
  invalid-body errors.
- Artifact tests cover metadata/content retrieval, kind validation, redaction
  before disk, content-size limits, atomic recovery, retention, path-safe ids,
  and missing/corrupt records.
- Run-recovery tests cover terminal capability restoration, explicit
  interruption of active snapshots, no automatic replay, and Artifact links.
- Goal and Worker tests cover restored terminal state, recovered active state,
  event/history behavior after restart, and global list behavior without first
  opening a parent session.
- Activity tests cover deterministic ordering, cursor boundaries, source
  links, zero-token reads, and filtering by source/status/time.
- Contract tests cover happy paths, not-found, invalid bodies, unauthorized
  access, quiesced mutation, agent unavailable, and OpenAPI schema validity.
- Follow existing ActivityStore, AgentStore, capability-run, Goal HTTP,
  Worker HTTP, and OpenAPI parser tests as the nearest test patterns.
- Run architecture tests and the full Core test/build suite before marking any
  slice complete.

## Out of Scope

- iOS/App DTOs, SwiftUI screens, native provider clients, and App-side caching.
- Replacing raw MCP for integration clients. Product-level MCP server
  enable/disable and removal of Thebe-registered servers are exposed through the
  durable Agent/config seam; editing an existing server's connection remains out
  of scope.
- Skill file editing or arbitrary extension code editing.
- Arbitrary filesystem browsing, uploads, or unrestricted Artifact paths.
- Automatic replay of an unknown or write-capable active run.
- A second Agent loop, a transcript store owned by Thebe, or a replacement for
  the runtime's native session persistence.
- A new global Goal identity or `GET /v1/goals/{id}/runs` unless separately
  decided; current Goal identity remains the parent session id.
- Resource graph, relations, and general triggers. Fixed-interval and one-shot
  Goal schedules were subsequently authorized and implemented on 2026-10-06;
  see CORE-PRODUCT-HTTP.md for the current schedule contract.

## Further Notes

Implementation status and remaining order:

1. ✅ Agent settings read model and safe persistence;
2. ✅ enabled-resource and permission-mode durability;
3. ✅ Artifact model/store with operation-receipt, Diagnosis, enabled-resource
   snapshot, direct/background Capability result (including provider
   capabilities, stored as `report`), terminal Goal report, and terminal Worker
   report producers; ✅ OpenList provider task discovery/control and Arcane
   provider activity discovery/control; ✅ current workspace adds qBittorrent
   native download tasks and the `task_output` Artifact kind for terminal
   provider-owned output;
4. ✅ capability/Goal/Worker recovery for the current sources. OpenList and
   Arcane tasks are re-read from the provider, so they have no Core `recovery`
   field and do not need a snapshot restore;
5. ✅ Activity read model, OpenAPI schemas, and the iOS client for the current
   sources: capability runs, Workers, Core-owned detached Bash tasks, OpenList
   and Arcane provider tasks, cursor pagination, and source/status/time
   filters. A new producer is an extension of this feed, not a missing client.

The current capability-run store is the reference for atomic bounded snapshots,
but its “old active run becomes interrupted” behavior must remain visible in the
product contract rather than being presented as transparent resume.
