# DSH-inspired Core implementation target

## Objective

Make Thebe Core's existing Source → Eval → Ticket → Goal path a stable,
vendor-neutral integration surface for event sources and reply channels. Source
admission, provenance, durable Ticket execution, and notice delivery belong in
Core. Keep Thebe's Pi runtime, Goal lifecycle, and Ticket Mandate as the
execution and authorization model.

This work records the concepts taken from the local
`learn/dsh-superagent-prototype` source and the implementation boundary for
Thebe Core. It does not copy the DSH runtime or make Core depend on it.

## Current Core facts

- Sources produce durable, deduplicated Triggers; Eval makes a Decision and can
  create a durable Ticket whose Goal performs the work.
- Ticket HTTP and tool controls already cover delegation, reads, replies, notes,
  pause, resume, stop, and retry.
- `Trigger` can carry `actor`, `human`, `addressed`, `admission`, and `channel`
  metadata. A host Source may classify a Trigger as `explicit`, `inferred`, or
  `ignore`; Core persists the result. Explicit requests go to the Main Session,
  inferred events follow Ticket/Eval routing, and ignored events do not reach
  either model.
- A Main Session can bind an explicitly admitted human Trigger to a direct
  Ticket. Core keeps its provenance, subscriptions, and reply channel on the
  Ticket, fences its payload in the Goal prompt, and derives a stable Ticket id
  from the Trigger.
- An Eval Ticket's Mandate is derived from resource scope and enforced by Core's
  tool path. Source identity and channel addresses must never widen it.
- Production GitHub and Feishu Source/Channel adapters live in
  `src/adapters/sources/`. They use only the vendor-neutral `Source` and
  `ChannelAdapter` seams plus the platform REST APIs.
- `TicketTaskView.assignment` exposes the Ticket executor's lifecycle
  (`pending`, `running`, `waiting`, `ended`), its Goal id, and how many isolated
  agent runs it started. The Goal remains the only writer of that state.
- On startup Core restores interrupted Ticket Goals, revalidates their Mandate,
  and resumes only Goals that were `running` or `pausing`. A person's pause,
  stop, answer, or review request is never auto-resumed.
- The Thebe App shows Tickets in the Activity screen: sections for needs-you,
  working, and other; stage badges; provenance and authority; pause/resume/
  stop/retry; notes; and answer/review submission. It joins `/v1/tickets` with
  `/v1/goals` client-side, so the HTTP Ticket schema did not change.

## Core phase scope

1. Let a host inject vendor-neutral `Source` adapters through the Core
   composition root. They use the existing cursor, persistence, health,
   quiesce, and Eval behavior. Each Source can declare event kinds for Eval to
   weigh; the Policy and Ticket Mandate remain the decision and authorization
   gates.
2. Carry actor identity, human/bot classification, and reply-channel addresses
   from a Trigger through assessment, accepted Ticket state, and later Ticket
   inputs. Keep event text fenced as untrusted data.
3. Define a small `ChannelAdapter` seam for Core to send a Ticket notice to a
   stored `ChannelRef`. Check that the channel belongs to the Ticket and that
   the registered adapter accepts the address. Persist each delivery before
   sending, retry failures after restart, and pass the adapter a stable
   idempotency key. Delivery failures do not change Goal state.
4. Keep execution on the existing Goal runner. The Ticket Mandate and Core's
   approval checks provide service-level isolation; this phase does not add a
   second runtime or DSH's repository-specific worktree manager.
5. Add deterministic tests with in-memory Source and Channel adapters. No live
   account, network credential, or third-party package is required.
6. Provide the first production adapters against the same seam: GitHub
   repository events with issue-comment writeback, and Feishu chat messages with
   chat writeback. Their admission rules are deterministic and configured by
   environment, not by the model.
7. Recover interrupted Ticket execution after restart, and surface Tickets in
   the App without adding a second Ticket state store.

## Core adapter contract

- `CreateThebeAgentOptions.sourceAdapters` accepts vendor-neutral `Source`
  implementations. Core polls them with the built-in Sources, persists their
  Triggers and cursors, reports their health, and stops polling while quiesced.
- A Source may declare `assessedKinds`. Core adds those kinds to Eval's
  deterministic admission gate and includes the declaration in the Policy
  version. A declaration permits assessment only; the Policy still decides
  whether to take on the event.
- A Source may implement deterministic `admit(trigger)` classification.
  Explicit Triggers bypass Eval and Ticket follow-up fan-out, then reach the
  resident Main Session. Inferred Triggers use existing Ticket/Eval routing.
  Ignored Triggers remain recorded but do not reach either model. Sources
  without `admit` retain their existing behavior.
- `ticket_delegate` may bind a `triggerId` only when the stored Trigger is
  explicitly admitted and human-authored. The Ticket preserves its origin,
  channel, and subscriptions; retries for the same Trigger reuse the Ticket.
- `Source.read(cursor, signal)` receives an `AbortSignal`. Quiesce aborts an
  active read and waits for it to settle. A result returned after cancellation
  is discarded with its cursor unchanged. Once persistence begins, Core
  finishes storing the Triggers and advancing the cursor, then waits for the
  dispatch attempt to settle before quiesce returns. A failed dispatch remains
  queued for the next poll; durable Triggers are also recovered after restart.
- Triggers dispatched during quiesce remain queued for Eval or the resident Main
  Session and resume when Core unquiesces.
- A Source's Trigger, ActorRef, and ChannelRef must use that Source's id. A
  ChannelRef thread must be one of the Trigger's threads. Core rejects an
  invalid batch or admission result before storing it or advancing its cursor.
- `Ticket.origins` records the actor and human classification for the accepted
  Trigger batch. `Ticket.channels` stores its authorized reply destinations;
  `TicketInput` carries the same provenance for later attached Triggers.
- `CreateThebeAgentOptions.channelAdapters` registers adapters by source id.
  Core sends Goal notices only to ChannelRefs already stored on the matching
  Ticket, and only when the adapter accepts the address. A notice is either an
  attention request or the result of a completed Ticket. The stable idempotency
  key is scoped to the Ticket, notice, and destination; adapters use it to
  deduplicate delivery retries.
- Goal notices enter a durable outbox before a channel send. The notice is
  enqueued before the Goal records its terminal state, so a shutdown cannot drop
  it before it is durable. Failed sends retry with backoff after restart. Sent,
  refused, and no-longer-owned destinations leave the queue; delivery failures
  leave Goal state alone. A completed Ticket sends its result once per
  completion; a later retry and completion is a new result.
- Source and channel metadata remains descriptive event data. The Ticket
  Mandate is still derived and enforced by Core's existing resource and
  approval checks.

## Production Source adapters

Both adapters live in `src/adapters/sources/` and are wired by `src/app/bootstrap.ts`.
They are enabled only when their environment is complete; an absent configuration
registers nothing and starts no timer. They poll under the existing Source runner,
so cursor persistence, quiesce, health, Trigger deduplication, and recovery are
shared with the built-in Sources.

### GitHub

`GITHUB_SOURCE_ID` is `github`. The Source reads
`GET /repos/{owner}/{repo}/events` with `If-None-Match` ETags and up to two pages
of 100 events per repository per poll.

- Event kinds: `github.issue.opened`, `github.issue.closed`,
  `github.issue.reopened`, `github.issue.comment`,
  `github.pull_request.opened`, `github.pull_request.closed`,
  `github.pull_request.reopened`, `github.pull_request.review`,
  `github.pull_request.review_comment`.
- A Trigger id derives from the repository and GitHub's immutable event id, so a
  restart cannot store the same event twice. The first read of a repository is a
  baseline and announces nothing.
- Admission is deterministic: bot actors (`type: "Bot"`, logins ending in
  `[bot]`, or `github-actions`) are `ignore`; an issue or PR comment that
  mentions `THEBE_GITHUB_AGENT_LOGIN` is `explicit`; a newly opened issue or PR
  is `inferred`; any other comment is `ignore`.
- Threads are `resource:github:<owner>/<repo>:<issue|pull>:<number>`. The
  ChannelRef address is `{repo, issue, kind}`.
- The Channel adapter writes to
  `POST /repos/{owner}/{repo}/issues/{number}/comments`, refuses repositories
  outside the configured list, and appends a hidden
  `<!-- thebe-notice:<idempotencyKey> -->` marker. A retry pages through the
  issue's comments (up to 20 pages of 100) looking for the marker before posting
  again, so a long thread cannot produce a duplicate notice.
- Environment: `THEBE_GITHUB_REPOS` (comma-separated `owner/name`, required),
  `THEBE_GITHUB_TOKEN`, `THEBE_GITHUB_API_URL`,
  `THEBE_GITHUB_AGENT_LOGIN`, `THEBE_GITHUB_ADMIT_UNMENTIONED=1`, and
  `THEBE_GITHUB_ADMIT_OPENED=0` (opened issues/PRs are inferred by default).

### Feishu

`FEISHU_SOURCE_ID` is `feishu`. The Source obtains a tenant access token from
`POST /open-apis/auth/v3/tenant_access_token/internal` and polls
`GET /open-apis/im/v1/messages` for each configured chat.

- Event kind: `feishu.message`.
- The first read of a chat baselines the previous 24 hours; later reads start
  from the newest seen `create_time` with a one-second overlap and deduplicate by
  `message_id`. A chat's mode is read from
  `GET /open-apis/im/v1/chats/{chat_id}` and cached; a failed or malformed lookup
  is retried on a later poll instead of being cached as "unknown".
- Admission is deterministic: non-user senders are `ignore`; a direct (`p2p`)
  chat or a message that mentions the bot is `explicit`; an unaddressed group
  message is `ignore` unless unmentioned admission is enabled, in which case it
  is `inferred`.
- A mention is the configured bot open id in the message's mention ids, or the
  text containing `@<mentionName>`.
- The thread is `resource:feishu:chat:<chatId>`; the ChannelRef address is
  `{chat}`.
- The Channel adapter posts to
  `POST /open-apis/im/v1/messages?receive_id_type=chat_id` and passes the stable
  idempotency key as the message `uuid`.
- Environment: `THEBE_FEISHU_APP_ID`, `THEBE_FEISHU_APP_SECRET`,
  `THEBE_FEISHU_CHATS` (comma-separated chat ids, required),
  `THEBE_FEISHU_API_URL`, `THEBE_FEISHU_BOT_OPEN_ID`, `THEBE_FEISHU_MENTIONS`,
  and `THEBE_FEISHU_ADMIT_UNMENTIONED=1`.

The Feishu adapter has only been exercised against mocked HTTP in automated
tests; no live tenant is part of the test suite. The GitHub adapter's request
shapes are likewise tested against a mock, not a live repository.

## Ticket execution lifecycle and recovery

The Goal runner stays the only executor. A Ticket links to its Goal through
`links.legacyGoalId`; there is no second Ticket state machine.

- `TicketTaskView.assignment` reports `pending`, `running`, `waiting`, or `ended`
  from the Goal's own status, plus the Goal id and isolated agent run count.
- A Ticket Goal runs with the `ticket-worker` profile and its `ticket-reviewer`
  reviewer. It receives the fenced Ticket payload and Mandate, not the parent
  conversation transcript.
- Mandate revalidation runs before resuming work: if the current Policy and
  resource wiring no longer authorize the Ticket's scope, the Goal stays paused
  and the Ticket view shows why.
- On startup `recoverInterruptedTicketGoals` finds Ticket Goals whose persisted
  status is `running` or `pausing`, restores them, revalidates their Mandate, and
  resumes them. `paused`, attention, stopped, failed, and denied Goals are left
  alone.
- Ticket HTTP/tool reads and controls wait for that recovery pass, so a client
  cannot observe a half-restored assignment.

## Thebe App Ticket surface

The App uses existing product vocabulary: a Ticket appears as a task, grouped
into needs-you, working, and other. It reads `GET /v1/tickets`, `GET /v1/tickets/{id}`,
and `GET /v1/goals`, and controls the work through the existing Ticket routes:
`/pause`, `/resume`, `/stop`, `/retry`, `/note`, and `/reply`.

- Stage derivation is presentation-only: attention plus paused maps to answer or
  review; queued/running to working; paused to waiting; succeeded/cancelled/failed
  to ended states.
- The detail view shows the Mandate strength, policy and scope, the originating
  actor's source and admission, inputs, reply channels, the linked run, and its
  controls. Advanced work opens the existing `ThebeGoalDetailView`.
- The list refreshes every five seconds while visible; no new push or streaming
  channel was added.

## DSH behavior outside this target

- Core provides the deterministic admission seam; actor allowlists, mention
  parsing, and source-specific admission settings belong to Source modules.
- Core keeps execution in its existing Goal runner. It does not add DSH's
  repository-specific worktree preparation or a second executor. The Ticket
  Mandate, runtime permissions, and approval checks remain the authorization
  boundary.

## Independent comparison with the local DSH source

The reference checked was `../../learn/dsh-superagent-prototype` from this
repository. The comparison below records what this phase implements and what
remains different; passing this phase's checks does not mean feature parity with
the whole DSH prototype.

| DSH behavior and source                                                                                                                                                                     | Thebe Core evidence                                                                                                                                                                   | Result in this phase                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/engine.ts`, `src/core/intake.ts`, and `src/core/evals.ts`: deduplicate incoming Triggers, route them through thread ownership and policy gates, and persist Decisions.            | `src/agent/sources/runner.ts`, `src/agent/create.ts`, `src/agent/eval/`, plus `src/agent/agent.test.ts` and `src/agent/sources/sources.test.ts`.                                      | Covered through the existing Eval/Ticket path and the new Source adapter seam.                                                                                                                                               |
| `src/sources/kind.ts`, `src/sources/registry.ts`, and `src/admission.ts`: normalize source facts, then apply actor allowlists and an addressed/unaddressed admission matrix in Core policy. | `src/agent/sources/types.ts` and `src/agent/sources/runner.ts` persist and validate `actor`, `human`, `addressed`, and `admission`; `src/adapters/sources/github.ts` and `feishu.ts` implement the admission matrix; `src/agent/create.ts` routes the classification. | Covered for the two production Sources: bot/self events are ignored, mentions or direct chats are explicit, newly opened issues/PRs are inferred. Admission stays per Source rather than a central Core allowlist. |
| `src/core/tickets.ts`: persist Ticket origin, channels, subscriptions, and follow-up Inputs; bind later Triggers to the owning Ticket.                                                      | `src/agent/tickets/store.ts`, `src/agent/tickets/control.ts`, and `src/agent/tickets/types.ts`, covered by `src/agent/tickets/control.test.ts` and `src/agent/tickets/store.test.ts`. | Covered for the Core target: provenance and authorized destinations survive direct delegation and follow-up attachment.                                                                                                      |
| `src/core/replies.ts` and the `Outbox` port in `src/core/ports.ts`: queue idempotent acknowledgements, answers, results, and attention replies through source Channels.                     | `src/agent/channels/delivery.ts`, `src/agent/channels/outbox.ts`, and `src/agent/channels/delivery.test.ts`.                                                                          | Narrower than DSH: this phase durably sends Goal attention notices and a result when a Ticket completes. It does not implement DSH's acknowledgement or answer reply lifecycle.                                             |
| `src/core/assignments.ts` and `src/infra/environment.ts`: run Ticket Assignments with per-Ticket directories and repository/worktree preparation.                                           | Thebe continues using its existing Goal runner and Ticket Mandate/approval path. `src/agent/tickets/recovery.ts` resumes interrupted Ticket Goals after restart.                      | Not implemented: no DSH-style worktree manager or per-Ticket filesystem. Isolation is the Goal's subagent profile, one-shot runtime, Mandate scope, and approval checks.                                                       |

Phase status: the acceptance criteria below define the completed Core and App
scope. The central actor policy, DSH's acknowledgement/answer replies beyond
attention and result notices, and DSH-style worktree execution remain separate
follow-up decisions if Thebe needs those behaviors.

## Verification map

| Capability | Targeted automated coverage |
| --- | --- |
| GitHub collection, admission, deduplication, writeback idempotency | `src/adapters/sources/github.test.ts` |
| Feishu collection, chat mode, admission, token caching, writeback | `src/adapters/sources/feishu.test.ts` |
| GitHub Source → Eval → inferred Ticket → isolated Ticket worker/reviewer → blocked or completed notice written back as an issue comment with the idempotency marker | `src/adapters/sources/github-flow.test.ts` |
| Durable result notice for a completed Ticket, with one send per completion and a stable idempotency key | `src/agent/channels/delivery.test.ts` |
| Feishu Source → Eval → inferred Ticket → isolated Ticket worker/reviewer → blocked notice written back to the chat with the idempotency `uuid` | `src/adapters/sources/feishu-flow.test.ts` |
| Explicit GitHub mention or Feishu direct message → direct Ticket (no Eval) → isolated `ticket-worker` → durable blocked notice → idempotent retry without a duplicate | `src/agent/tickets/direct-source-e2e.test.ts` |
| Feishu chat-mode lookup retry after a transient failure; GitHub marker search across comment pages | `src/adapters/sources/feishu.test.ts`, `src/adapters/sources/github.test.ts` |
| Ticket store loading under concurrent startup reads | `src/agent/tickets/store.test.ts` |
| Interrupted Ticket Goal recovery only for `running`/`pausing`, only after Mandate revalidation, and every HTTP or MCP Ticket read/control waiting for that pass | `src/agent/tickets/recovery.test.ts`, `src/agent/tickets/control.test.ts` |
| Assignment view, controls and Ticket task shape | `src/agent/tickets/control.test.ts`, `src/delivery/http/tickets.test.ts` |
| App Ticket decoding, stage derivation, section ordering | `ui/Tests/Tickets/ThebeTicketModelTests.swift` |
| App list/reload, control, note, reply request shapes and failure states | `ui/Tests/Tickets/ThebeTicketControllerTests.swift` |
| App rendered row/badge/chip, list and detail screens, light and dark | `ui/Tests/Snapshots/ThebeTicketSnapshotTests.swift` |

## Acceptance criteria

- A host can inject a Source without editing Core's composition logic; its
  Triggers are persisted once, recovered after restart, represented in Source
  health, and stop polling while Core is quiesced.
- A host Source can classify a Trigger as explicit, inferred, or ignored.
  Explicit requests reach the Main Session without Eval; inferred events use
  existing Ticket/Eval routing; ignored events do not start model work. A bound
  explicit Trigger creates one durable direct Ticket with provenance and reply
  destinations intact.
- A host Source's declared event kind reaches Eval and is assessed under the
  current Policy. Undeclared custom kinds remain behind the deterministic
  admission gate; built-in assessed kinds keep their existing behavior.
- Quiesce waits for active Source reads and Trigger dispatch attempts.
  Cancellation during a read does not advance its cursor; committed batches
  reach Eval before quiesce returns when dispatch succeeds. Failed dispatches
  remain queued and resume after unquiesce.
- Actor, human, admission, addressing, and channel metadata survive the Trigger
  → Eval → Ticket path, direct explicit delegation, and Ticket follow-up
  fan-out, including persistence and recovery.
- A channel delivery can target only a `ChannelRef` persisted on that Ticket;
  it carries a stable idempotency key. A failed delivery remains queued and
  retries after restart while Goal and Ticket state stay intact. A completed
  Ticket sends its result to those channels once; a re-completion after retry is
  a new result.
- Identity and channel metadata do not increase a Ticket's Mandate, bypass an
  approval, or permit an irreversible action.
- With `THEBE_GITHUB_REPOS` set, a GitHub event produces one deduplicated
  Trigger with a stable id; the first read is a baseline; bot and unaddressed
  events are ignored; a configured mention is explicit; a newly opened issue or
  PR is inferred. A notice is written back to the issue thread at most once per
  idempotency key.
- With `THEBE_FEISHU_APP_ID`, `THEBE_FEISHU_APP_SECRET`, and
  `THEBE_FEISHU_CHATS` set, a Feishu message produces one deduplicated Trigger
  per `message_id`; the first read baselines the last 24 hours; a direct chat or
  bot mention is explicit; unaddressed group messages are ignored by default. A
  notice is written back to the chat with the idempotency key as `uuid`.
- An interrupted Ticket Goal (`running` or `pausing`) is restored, revalidated
  against the current Mandate, and resumed after restart. A Goal paused for a
  person, waiting on attention, stopped, or denied stays that way.
- Ticket reads and controls expose `assignment` state and cannot observe a
  half-restored assignment during startup recovery.
- The App lists Tickets by needs-you, working, and other; shows provenance,
  authority, inputs, channels, and the linked run; and can pause, resume, stop,
  retry, send a note, and answer or review the Goal's open attention.
- Core source, Eval, Ticket, Goal, HTTP, and package checks pass. App model,
  join, control, and request-shape tests pass; the rendered Ticket screens are
  checked on the iOS simulator.
