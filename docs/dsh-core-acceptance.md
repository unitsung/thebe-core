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
  Core sends Goal attention notices only to ChannelRefs already stored on the
  matching Ticket, and only when the adapter accepts the address. The stable
  idempotency key is scoped to the Ticket, notice, and destination; adapters
  use it to deduplicate delivery retries.
- Goal attention notices enter a durable outbox before a channel send. Failed
  sends retry with backoff after restart. Sent, refused, and no-longer-owned
  destinations leave the queue; delivery failures leave Goal state alone.
- Source and channel metadata remains descriptive event data. The Ticket
  Mandate is still derived and enforced by Core's existing resource and
  approval checks.

## Deferred phases

- GitHub and Feishu integrations are external Source/Channel modules. They will
  use the Core interfaces defined here and are not implemented in this phase.
- The Thebe App changes are deferred until Core meets the acceptance criteria
  below. The later App phase will surface Ticket-backed work using the existing
  Goal/Activity product vocabulary and HTTP routes.

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
| `src/sources/kind.ts`, `src/sources/registry.ts`, and `src/admission.ts`: normalize source facts, then apply actor allowlists and an addressed/unaddressed admission matrix in Core policy. | `src/agent/sources/types.ts` and `src/agent/sources/runner.ts` persist and validate `actor`, `human`, `addressed`, and `admission`; `src/agent/create.ts` routes the classification.  | Partial by design: Source modules decide allowlists, mention parsing, and the admission result. Core checks that an `explicit` result has a human actor, but does not implement DSH's central allowlist or admission matrix. |
| `src/core/tickets.ts`: persist Ticket origin, channels, subscriptions, and follow-up Inputs; bind later Triggers to the owning Ticket.                                                      | `src/agent/tickets/store.ts`, `src/agent/tickets/control.ts`, and `src/agent/tickets/types.ts`, covered by `src/agent/tickets/control.test.ts` and `src/agent/tickets/store.test.ts`. | Covered for the Core target: provenance and authorized destinations survive direct delegation and follow-up attachment.                                                                                                      |
| `src/core/replies.ts` and the `Outbox` port in `src/core/ports.ts`: queue idempotent acknowledgements, answers, results, and attention replies through source Channels.                     | `src/agent/channels/delivery.ts`, `src/agent/channels/outbox.ts`, and `src/agent/channels/delivery.test.ts`.                                                                          | Narrower by design: this phase durably sends Goal attention notices. It does not implement DSH's full source-message reply lifecycle.                                                                                        |
| `src/core/assignments.ts` and `src/infra/environment.ts`: run Ticket Assignments with per-Ticket directories and repository/worktree preparation.                                           | Thebe continues using its existing Goal runner and Ticket Mandate/approval path.                                                                                                      | Not implemented in this phase; no DSH-style worktree manager is added.                                                                                                                                                       |

Phase status: the acceptance criteria below define the completed Core scope.
The central actor policy, full source-channel reply lifecycle, and DSH-style
worktree execution remain separate follow-up decisions if Thebe needs those
behaviors. GitHub, Feishu, and Thebe App integration remain deferred.

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
  retries after restart while Goal and Ticket state stay intact.
- Identity and channel metadata do not increase a Ticket's Mandate, bypass an
  approval, or permit an irreversible action.
- Core source, Eval, Ticket, Goal, HTTP, and package checks pass. No UI files are
  changed in this phase.
