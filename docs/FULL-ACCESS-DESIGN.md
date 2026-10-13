# Full-access preset — design bounds

Status: implemented on `dev` (Core half). This states what the preset is, what
it must not become, and how it is accepted. The App half (persistent indicator
and per-session switch) consumes the routes below.

## What it is

One named preset that combines the existing `full-access` permission mode with the
command guard and the sandbox disabled — the explicit "I trust this session"
switch. It is not a mode any client may grant itself remotely.

The foundation already ships: permission mode `ask` / `read-only` /
`full-access` at `/v1/settings/permissions`. This preset is session-scoped: it
lifts `THEBE_COMMAND_GUARD` and the sandbox for one conversation and bypasses
tool approval for that conversation, without changing the global permission
mode. Schedules, background goals, subagents, and `/mcp` callers are unaffected.

## Host gate

`THEBE_FULL_ACCESS=on` (also `allow`/`true`/`1`/`yes`) makes the preset
selectable; it never turns it on. `GET /v1/settings/full-access` reports
`{ "allowed": boolean }`. Without it, `POST /v1/session/{id}/full-access`
returns `403 full_access_not_allowed`. The gate is host configuration only.

## HTTP

- `GET /v1/settings/full-access` → `{ allowed }`.
- `POST /v1/session/{id}/full-access` with `{ "enabled": boolean }` →
  `{ thebeSessionId, fullAccess }`. `403` when the host has not allowed it.
- The session metadata (`GET /v1/session/{id}`) carries `fullAccess` while the
  preset is active, so the App can show a persistent indicator.

## Invariants (hold in the implementation)

1. **Default off.** The preset is never the startup default.
2. **Host-gated.** Only configuration on the machine running Core can allow it; a
   remote HTTP/App client cannot grant it to itself.
3. **Session-scoped.** Enabling it affects one session; a new session returns to
   the default.
4. **Not inherited.** `/mcp` callers, scheduled occurrences, background goals,
   subagents, and non-interactive turns do not inherit it — only an interactive
   turn on a conversation that was explicitly enabled.
5. **Audit stays on.** Records are still written, including while the preset is on.
6. **Visible.** The session metadata carries `fullAccess` for the whole time the
   preset is active in that conversation.
7. **Narrow.** It disables exactly the command guard and sandbox for the enabled
   session; the workspace boundary, redaction, and audit are unchanged.
8. **Off means off.** Without the preset, behavior is exactly today's.

## What it must not become

- A remote-controlled switch (the App or `/mcp` cannot enable it).
- A global/default policy that silences the guard for every session.
- A bypass for approvals it was not scoped to — write approvals for other
  sessions and for non-interactive work remain the permission mode's concern.
- Inherited by automation: a schedule or background goal running unguarded is a
  bug, not a feature.

## Risks

- The guard and sandbox exist precisely for NAS-destructive commands
  (`docs/thebe_nas_isolation_and_microvm_research.md`); disabling them is
  acceptable only for a user who has accepted that a mistaken command can damage
  the host.
- If the preset leaks into automation, an unattended run can execute unguarded.

## Acceptance

- Off by default: a fresh Core and a fresh session behave as today.
- Cannot enable remotely: a Core whose host config does not allow the preset
  rejects an HTTP/App attempt with `403 full_access_not_allowed`.
- Per-session and non-inheritance: enabling in one session does not affect a new
  session, a scheduled occurrence, a background goal, a subagent, or an `/mcp`
  caller; a non-interactive turn on the enabled session still requires approval.
- Audit: a destructive-classified command run under the preset still produces an
  audit record.
- Visibility: the session metadata carries `fullAccess` only while the preset is
  active.

These are covered by `src/agent/security/full-access.test.ts`,
`src/agent/service.test.ts`, `src/delivery/http/settings.test.ts`, and the
seatbelt integration check in
`src/adapters/pi/session/pi-session.test.ts`.

## Relationship to other settings

- `full-access` permission mode: this preset produces a session-scoped
  equivalent for the conversation it is enabled on; it does not add a second mode
  name to `/v1/settings/permissions`.
- `THEBE_COMMAND_GUARD`, `THEBE_SANDBOX`, `THEBE_SCENARIO`: this preset is an
  explicit, session-scoped override of those host-level defaults. The guard is
  skipped in the permission preflight; the sandbox mode is read per command, so
  enabling it mid-conversation takes effect on the next command. The Gondolin
  micro-VM backend is chosen when the session opens, so with that backend the
  preset only takes effect for a session opened after enabling it.

## Open questions (resolved at implementation)

- Host-config key: `THEBE_FULL_ACCESS`; a boolean allow, not an allow-list.
- Independent lifting: the guard and the sandbox are lifted together; there is no
  separate switch.
