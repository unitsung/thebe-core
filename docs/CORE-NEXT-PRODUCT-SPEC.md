# Core durable product contract

Status: in progress — Agent settings, enabled-resource durability, initial Artifact slice, and Capability Run Activity items implemented; broader unified read model remains

Tracking issue: [#4](https://github.com/unitsung/thebe-core/issues/4)

The Agent settings slice is now available through `ThebeAgent.getAgentSettings()` /
`updateAgentSettings()` and `GET/PATCH /v1/settings/agent`. It persists the
mutable values through the existing Thebe config boundary, keeps permission
mode on `/v1/settings/permissions`, and reports concurrency changes as
restart-required. Enabled resource selections now use that same boundary and
survive Agent recreation. Core now stores bounded, redacted operation-receipt
Artifacts with metadata/content HTTP reads. Activity now includes durable
Capability Run items; additional producers, cursorable aggregation, and the
remaining Worker/background-task read model remain future slices.

This spec turns the remaining Core product-contract work into one executable
backlog. The highest seam is `ThebeAgent` and its product HTTP delivery; the
runtime adapters and provider integrations remain behind that seam.

## Problem Statement

Thebe Core already owns sessions, Goals, Workers, capabilities, permissions,
resources, and audit. The remaining gaps are at the boundary where an App must
inspect and trust those objects:

- effective Agent settings can be supplied at startup and changed by internal
  methods, but there is no complete product query/update contract;
- capability run snapshots now survive Core recreation, but other long-lived
  objects still have uneven recovery and observation semantics;
- results are still mostly embedded in runs, transcripts, or Activity records;
  the initial Artifact contract only has an operation-receipt producer;
- Activity is a partial diagnosis/restart/Goal feed rather than a stable read
  model for capability runs, Workers, and background tasks;
- enabled resources and permission mode now persist through the configuration
  boundary, while capability results and broader read-model recovery remain
  incomplete.

As a result, a product client cannot reliably answer: “what is Core configured
to do?”, “what did this run produce?”, “what survived restart?”, and “what work
is active or completed?” without knowing runtime-specific details.

## Solution

Complete the durable product contract in three compatible slices:

1. Expose effective Agent settings through a typed read/update surface with
   validation, safe mutability, and persistence through the existing Thebe
   configuration boundary.
2. Add a Core-owned Artifact model and bounded Artifact store. Runs and
   product actions may reference Artifacts instead of embedding unbounded
   results, while secrets and runtime transcripts remain excluded.
3. Finish the durable read model for long-running work. Preserve each source
   lifecycle, but expose stable status, timestamps, recovery state, and a
   normalized Activity view without creating a second Agent loop or a second
   lifecycle owner.

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
- Start with a small allow-list of Artifact kinds: diagnosis, report,
  resource list, and operation receipt. Do not build an arbitrary filesystem
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
- Replacing raw MCP for integration clients or adding MCP server write
  management without a durable registry seam.
- Skill file editing or arbitrary extension code editing.
- Arbitrary filesystem browsing, uploads, or unrestricted Artifact paths.
- Automatic replay of an unknown or write-capable active run.
- A second Agent loop, a transcript store owned by Thebe, or a replacement for
  the runtime's native session persistence.
- A new global Goal identity or `GET /v1/goals/{id}/runs` unless separately
  decided; current Goal identity remains the parent session id.
- Resource graph, relations, triggers, and scheduled automation.
- Expanding capability categories beyond the current product need.

## Further Notes

Implementation order should be:

1. ✅ Agent settings read model and safe persistence;
2. ✅ enabled-resource and permission-mode durability;
3. 🟡 Artifact model/store and the initial operation-receipt producer;
4. 🟡 capability/Goal/Worker recovery normalization (Worker snapshots recover
   as `interrupted`; active Goal recovery is recorded as a paused history event);
5. unified Activity read model and OpenAPI/client contract hardening.

The current capability-run store is the reference for atomic bounded snapshots,
but its “old active run becomes interrupted” behavior must remain visible in the
product contract rather than being presented as transparent resume.
