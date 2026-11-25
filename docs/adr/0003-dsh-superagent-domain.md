# DSH superagent is the domain; Pi is the runtime

Status: Accepted, 2026-11-18.

Thebe currently uses `Ticket` as a domain object but lets a `Goal` own execution,
report, attention, watchdog state, and API identity. That mixes the work item,
the executor binding, the runtime session, and the user-facing surface. A
review of DSH, Pi, OpenAI, Anthropic, Grok Bot, Dots, OpenManus, OpenHands,
Deep Agents, and 2026 papers found no single mature public specification for a
complete super-agent. The best-quality complete public domain model is the DSH
superagent model; the best-quality public worker isolation is Claude Code's
subagent model; OpenAI's `RunState` and Sandbox Agents provide the strongest
approval and workspace constraints.

We adopt **one domain vocabulary only**: DSH superagent. `Ticket` is the
authorized work item. `Assignment` is the durable binding of a Ticket to one
`Executor` instance. `Report` and `Attention` belong to the domain; the
Executor's runtime state is not the domain state. A Ticket may have several
Assignments over time; a retry ends the current Assignment and creates a new
one. The existing Goal loop becomes the first Executor implementation and is
not a domain object, API resource, or UI concept.

Pi supplies runtime primitives only: `Agent`, `Session`, `Conversation`,
`Run`, `Turn`, `Task`, and `Document`. OpenAI, Anthropic, Claude Code, and the
papers are implementation quality constraints, not additional domain models.
Claude Code's subagent semantics are the quality bar for Executor isolation:
fresh context, explicit tool subset, independent permissions, bounded turns,
background execution where appropriate, optional worktree isolation, and only
the final report returned to the coordinator. OpenAI's paused-run behavior is
the quality bar for approvals: a pending approval is a resumable state, not a
new task.

**Consequences:** this is a breaking domain migration. `/v1/goals` and Goal
screens are migration-only and must be removed rather than kept as a parallel
model. Existing Tickets gain one Assignment from their legacy Goal. The Goal
implementation may remain temporarily behind the Executor boundary, but no new
Goal vocabulary may enter `CONTEXT.md`, HTTP, MCP, or the App. A compatibility
shim, if needed, must name its removal version and must not own state.
Subscription fan-out follows DSH: every live Ticket subscribed to a Trigger's
Threads receives it as context. The first dispatch durably freezes that
recipient set, including an empty set, before writing Inputs. A retry resumes
the same complete set without duplicating Inputs or adding Tickets created
later. Per-recipient completion is also durable, so pruning a Ticket's bounded
Input history cannot redeliver an old Trigger. Ended Tickets do not receive
asynchronous fan-out.

## First workflow and evaluation

Use one existing NAS workflow to validate recovery, approvals, verification,
and reproducible Skill evaluation end to end. Keep one Executor as the
production default and evaluate additional Executors with the same fixtures.
An unresolved external write leaves the Ticket waiting for the person until
Core can verify the outcome or establish that retrying is safe.
[Primary sources and pilot acceptance](../SUPERAGENT-EVIDENCE.md)
