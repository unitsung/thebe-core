# Full-access preset — design bounds

Status: design only; not implemented. This reconstructs the prerequisite for the
App-side plan's E1 (`../ui/docs/DEVELOPMENT-PLAN.md`). It states what the preset
is, what it must not become, and how it is accepted. It does not prescribe an
implementation.

## What it is

One named preset that combines the existing `full-access` permission mode with the
command guard and the sandbox disabled — the explicit "I trust this session"
switch. It is not a mode any client may grant itself remotely.

The foundation already ships: permission mode `ask` / `read-only` /
`full-access` at `/v1/settings/permissions`. What does not ship is the preset that
also lifts `THEBE_COMMAND_GUARD` and the sandbox for the enabled session.

## Invariants (must hold)

1. **Default off.** The preset is never the startup default.
2. **Host-gated.** Only configuration on the machine running Core can allow it; a
   remote HTTP/App client cannot grant it to itself.
3. **Session-scoped.** Enabling it affects one session; a new session returns to
   the default.
4. **Not inherited.** `/mcp` callers, scheduled occurrences, and background goals
   do not inherit it — only a conversation the user started in the App.
5. **Audit stays on.** Records are still written, including while the preset is on.
6. **Visible.** The App shows a persistent indicator for the whole time the preset
   is active in that conversation.
7. **Narrow.** It disables exactly the command guard and sandbox for the enabled
   session; the workspace boundary, redaction, and audit are unchanged.
8. **Off means off.** Without the preset, behavior is exactly today's.

## What it must not become

- A remote-controlled switch (the App or `/mcp` cannot enable it).
- A global/default policy that silences the guard for every session.
- A bypass for approvals it was not scoped to — write approvals are the
  permission mode's concern, not this preset's.
- Inherited by automation: a schedule or background goal running unguarded is a
  bug, not a feature.

## Risks

- The guard and sandbox exist precisely for NAS-destructive commands
  (`docs/thebe_nas_isolation_and_microvm_research.md`); disabling them is
  acceptable only for a user who has accepted that a mistaken command can damage
  the host.
- If the preset leaks into automation, an unattended run can execute unguarded.

## Acceptance (observable when implemented; none of this is verified yet)

- Off by default: a fresh Core and a fresh session behave as today.
- Cannot enable remotely: a Core whose config does not allow the preset rejects an
  HTTP/App attempt; only a host-config-allowed Core accepts it.
- Per-session and non-inheritance: enabling in one session does not affect a new
  session, a scheduled occurrence, a background goal, or an `/mcp` caller.
- Audit: a destructive-classified command run under the preset still produces an
  audit record.
- Visibility: the App shows the indicator only while the preset is active.

## Relationship to other settings

- `full-access` permission mode: this preset includes it; do not add a second mode
  name to `/v1/settings/permissions`.
- `THEBE_COMMAND_GUARD`, `THEBE_SANDBOX`, `THEBE_SCENARIO`: this preset is an
  explicit, session-scoped override of those host-level defaults. Exact precedence
  is an implementation decision.

## Open questions (decide at implementation)

- Exact host-config key, and whether it is a boolean allow or an allow-list.
- Whether the sandbox and the command guard can be lifted independently.
