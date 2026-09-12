# Coding Agent Behavior Comparison: Codex, OpenCode, and Pi

Research date: 2026-09-12

## Scope and evidence standard

This document compares conversation persistence, context compaction and summaries, summary visibility, confirmations and permissions, and subagents. It uses primary sources only:

- Codex: official OpenAI documentation.
- OpenCode: official documentation and source/specifications in the official repository.
- Pi: documentation and source/examples in the official repository.

Facts and recommendations are deliberately separated. OpenCode pages under `/v2/` and files on its `dev` branch describe v2 or current development behavior and may not match every installed stable release.

## Executive comparison — verified facts

| Area | Codex CLI/app | OpenCode | Pi coding agent |
| --- | --- | --- | --- |
| Conversation persistence | Saved tasks can be resumed; transcripts live under `$CODEX_HOME/sessions`, with a separate archive directory. App Server exposes thread, turn, and item reads. | Sessions can be listed, resumed, exported, and deleted. The current source persists session/message/part records in database tables. | Sessions are append-only JSONL trees, grouped by working directory under `~/.pi/agent/sessions/` by default. |
| Compaction trigger | Manual `/compact` is documented. App Server exposes asynchronous thread compaction. The reviewed public docs do not specify the automatic threshold algorithm. | Automatic compaction is enabled by default and is based on estimated context usage; `/compact` or `/summarize` triggers it manually. | Automatic compaction is based on context-window pressure; `/compact` triggers it manually. |
| Raw history after compaction | `/compact` replaces earlier turns in the active conversation with a concise summary. The public docs reviewed do not document its underlying retention format. | The v2 design retains the full durable transcript and replaces only the model-facing representation with a checkpoint plus recent context. | Full entries remain in the JSONL session; the model receives the compaction summary plus the retained recent tail. |
| Summary visibility | `/compact` is visible as a user action. No official user-facing summary-detail inspector was found in the reviewed docs. | The TUI exposes compaction, while `/details` is documented for tool execution details. The v2 specification treats the checkpoint as an internal/model-facing projection. | A compaction is collapsed to one line by default and can be expanded with the tool-details shortcut to view the Markdown summary. |
| Permissions | OS sandbox and approval policy are separate controls. Workspace write, network, MCP, app, and other approval categories are configurable. | Ordered `allow`, `ask`, and `deny` rules apply to tools/resources. Ask choices include one-time permission, session-scoped pattern permission, and rejection. | Core Pi intentionally has no permission popups. Project trust gates project-local resources; extensions can implement command/path confirmation or sandboxing. |
| Subagents | Built-in subagents run in separate threads, are visible in the clients, and report results back to the parent. | Primary agents can launch child-session subagents; agent type, model, permissions, depth, and step limits are configurable. | No built-in subagent system. The official example extension launches separate Pi processes and supports single, parallel, and chained tasks. |

## Codex CLI and app — verified facts

### Conversation persistence

- `codex resume`, `codex exec resume`, and `/resume` continue saved tasks. `/resume` reloads the saved transcript with the original history intact. `/fork` creates a new task from an earlier point. `/archive` preserves the transcript, while `/delete` permanently removes the current task and descendants. See [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
- A Codex task keeps its transcript and recorded working directory. Durable project guidance belongs in repository documentation such as `AGENTS.md`, rather than relying on one task's conversation. See [Projects and chats](https://learn.chatgpt.com/docs/projects).
- Local session transcripts are stored under `$CODEX_HOME/sessions` (normally `~/.codex/sessions`), and archived sessions under `$CODEX_HOME/archived_sessions`. OpenAI warns that transcripts may contain sensitive information. See [Codex troubleshooting](https://learn.chatgpt.com/docs/reference/troubleshooting).
- App Server can list threads, read a stored thread with or without turns, and paginate turns or items without resuming the task. Archiving moves the persisted rollout to the archive location; deleting removes the persisted task and descendants. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).

### Compaction and summary visibility

- `/compact` summarizes the visible chat to free context space. The documented interaction is explicit: Codex offers compaction, the user confirms it, and prior turns are replaced in the active context by a concise summary intended to retain critical details. See [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli).
- App Server exposes `thread/compact/start`. Compaction runs asynchronously and reports progress through normal turn/item notifications. See [Codex App Server](https://learn.chatgpt.com/docs/app-server).
- Codex memories are a distinct feature, not the same thing as context compaction. Memories are optional, local, cross-task background artifacts generated after a task has been idle long enough; the official page does not promise an exact idle duration. See [Codex memories](https://learn.chatgpt.com/docs/customization/memories).

The reviewed official documentation does **not** establish the exact automatic compaction threshold, the internal compaction-summary schema, or a dedicated CLI/app control for expanding a compacted summary. These should not be inferred from unrelated API compaction behavior.

### Confirmations, permissions, and security

- Local Codex combines two independent layers: the sandbox defines what the process can technically access, while the approval policy defines when user confirmation is required. CLI/IDE defaults limit writes to the workspace and disable network access unless enabled. See [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).
- The common automatic mode uses workspace-write sandboxing with on-request approval: in-workspace work proceeds automatically, while network access or work outside the workspace can require approval. Read-only mode is available through `/permissions`. See [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).
- Configuration supports `on-request`, `never`, and `granular` approval policies. Granular approval categories include sandbox escalation, rules, MCP elicitations, permission requests, and skills. An optional reviewer subagent can review approval requests without changing the sandbox itself. See [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
- Codex cloud tasks run in isolated managed containers. Setup can use network access, but the agent phase is offline by default and setup secrets are removed before that phase. See [Agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).

### Subagents

- Current Codex releases enable multi-agent workflows by default. A subagent works in a separate thread, and its activity/result summary is surfaced in the app, CLI, and IDE. The CLI `/agent` command switches among or inspects active agent threads. See [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- Codex supports spawning, steering, waiting for, and closing subagents. Subagents inherit the parent model and reasoning settings unless a role configuration overrides them. See [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- The official guidance warns that parallel write-heavy work can conflict; parallel agents are most reliable for independent or read-heavy tasks unless writes are isolated. See [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## OpenCode — verified facts

### Conversation persistence

- `/sessions` (also `/resume` and `/continue`) lists and switches sessions. `/export` writes the current conversation as Markdown. The CLI also supports session listing/deletion and export by session ID, including a sanitization option. See [OpenCode TUI](https://opencode.ai/docs/tui/) and [OpenCode CLI](https://opencode.ai/docs/cli/).
- Current official source defines durable session, message, and part records in database tables; import logic inserts those records rather than relying only on the active model context. See [OpenCode session source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/session.ts) and [OpenCode import source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/import.ts).

### Compaction and summary visibility

- `/compact`, with alias `/summarize`, manually compacts the current session. `/details` is separately documented as the toggle for tool execution details. `/thinking` changes whether reasoning blocks are displayed; it does not change reasoning effort, which is selected through model variants. See [OpenCode TUI](https://opencode.ai/docs/tui/).
- Automatic compaction is enabled by default and can be disabled in configuration. The v2 documentation describes a preflight context estimate and automatic triggering near the model's context limit, plus a single retry after an overflow. See [OpenCode configuration](https://opencode.ai/docs/config/) and [OpenCode v2 compaction](https://opencode.ai/v2/docs/compaction).
- In the v2 design, older messages remain in durable storage. The active model context is projected as a generated checkpoint plus recent messages. Compaction is lossy, and failed or interrupted compaction leaves the prior boundary active. See [OpenCode v2 compaction](https://opencode.ai/v2/docs/compaction) and the [OpenCode v2 session specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md).
- The v2 specification describes a structured rolling summary/checkpoint and updates it on repeated compactions. The current compaction source uses sections such as objective, important details, work state, next move, and relevant files. See the [OpenCode v2 session specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md) and [OpenCode compaction source](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts).

The reviewed official TUI documentation does **not** describe a dedicated user control for expanding compaction summaries. `/details` is documented for tools, so it should not be presented as a verified compaction-summary inspector.

### Confirmations and permissions

- Permission rules use `allow`, `ask`, or `deny`, with glob-like patterns and ordered matching where the last matching rule wins. Rules can target tools such as shell, edits, reads, tasks, and skills, as well as specific command/path patterns. See [OpenCode permissions](https://opencode.ai/docs/permissions/).
- When a rule asks, the user can allow once, allow a suggested pattern for the current session, or reject. OpenCode includes special controls for external-directory access and repeated identical tool calls (“doom loop”). Sensitive environment files are denied by default. See [OpenCode permissions](https://opencode.ai/docs/permissions/).
- `--auto` approves actions that would otherwise ask, but an explicit deny rule remains denied. Per-agent rules merge with global rules, with agent-specific rules taking precedence. See [OpenCode permissions](https://opencode.ai/docs/permissions/).

### Subagents

- OpenCode distinguishes primary agents, subagents, and agents usable as either. A subagent receives a fresh child-session context and may run in the foreground or background. See [OpenCode agents](https://opencode.ai/v2/docs/agents).
- Agent configuration can assign a model, permissions, maximum steps, and subagent depth. Child agents have their own configured permissions, while the parent's task/subagent permission controls which agents it may launch. See [OpenCode agents](https://opencode.ai/v2/docs/agents) and [OpenCode configuration](https://opencode.ai/docs/config/).
- Custom commands can opt into a subtask so their work occurs in a child context rather than polluting the primary conversation. See [OpenCode commands](https://opencode.ai/docs/commands/).

## Pi coding agent — verified facts

### Conversation persistence

- Pi stores sessions as append-only JSONL trees using entry IDs and parent IDs. Auto-saved sessions are grouped by working directory under `~/.pi/agent/sessions/` by default. See the [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).
- `pi -c`, `pi -r`, `--session`, and `--no-session` control continuation and persistence. `/session`, `/tree`, `/fork`, and `/clone` navigate or branch history. `/export` writes HTML or JSONL, and `/import` imports a session. See the [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).
- Because the session is a tree, changing branches does not destroy the abandoned branch; `/tree` can return to it. Full entries remain in the JSONL file after compaction. See the [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) and [Pi compaction documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).

### Compaction and summary visibility

- Pi checks context pressure against the model context window and a reserve-token allowance; `/compact [instructions]` triggers compaction manually. Its documented defaults reserve 16,384 tokens and retain roughly 20,000 recent tokens, though users can configure both. See [Pi compaction documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).
- Compaction writes a new entry containing the summary and the first retained entry ID. Model context is reconstructed from that summary plus the recent retained entries; the original entries remain durable. It selects safe boundaries and does not start retained context at an orphaned tool result. See [Pi compaction documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).
- Pi's summary format tracks goal, constraints, progress, decisions, next steps, critical context, and files read/modified. Repeated compactions fold the prior summary into the next one. Extensions can cancel compaction or supply a replacement summary and custom details. See [Pi compaction documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).
- In the interactive TUI, a compaction summary is collapsed by default to a single status line that includes the pre-compaction token count. The same expansion shortcut used for tool details reveals the rendered Markdown summary. See [Pi compaction summary component](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts).

### Confirmations, permissions, and project trust

- Pi deliberately does not ship core permission popups. Its README recommends process/container isolation or extensions where stricter controls are needed. See the [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).
- Pi does gate project-local settings, extensions, skills, and other executable/custom resources behind a project-trust decision. Trust decisions are stored in `~/.pi/agent/trust.json`; noninteractive operation cannot display a prompt and follows the configured/default trust behavior. See the [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).
- The official examples show extensions intercepting tool calls to confirm dangerous shell commands, protect paths, guard dirty repositories, or add sandboxing. The permission-gate example fails closed when interactive confirmation is unavailable. See [Pi extension examples](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md) and [Pi permission-gate example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts).

### Subagents

- Pi explicitly lists built-in subagents among the features intentionally left to extensions. Therefore, Pi's subagent behavior must not be described as a core guarantee. See the [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md).
- The official example extension launches a separate Pi process for each subagent, giving it isolated context. It supports one task, parallel task arrays, and sequential chains; the example limits total parallel tasks and concurrency and asks before loading project-defined agents by default. See the [Pi subagent example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts).

## Recommendations for Thebe — not claims about current behavior

### 1. Separate transcript, compaction, and idle summary

Use three explicit concepts and storage records:

1. **Durable transcript:** append-only user, assistant, tool, permission, and lifecycle events. It is the source of truth for resume, export, audit, and branching.
2. **Context checkpoint:** a lossy model-facing summary plus a retained recent tail, created manually or when token pressure requires it. It must never delete the durable transcript.
3. **Idle task recap:** an optional one-sentence user-facing status generated after 1–2 minutes without user or agent activity. It must not silently replace context, mark a task complete, or be labelled “compaction.”

This separation follows the durable-history/checkpoint pattern documented by OpenCode v2 and Pi, while recognizing that Codex memories are also distinct from compaction. No reviewed primary source supports using a fixed 30-second or 1–2-minute idle timer as the trigger for context compaction.

Suggested lifecycle:

```text
turn completes
  -> durable events flushed
  -> if context pressure is high: create context checkpoint
  -> if both user and agent stay idle for configured delay: create/refresh one-line recap
  -> new activity cancels the pending idle recap timer
```

For an initial default, use 120 seconds of complete inactivity, make it configurable, and avoid generating a recap for greetings, aborted turns, or tasks with no material work.

### 2. Make summaries inspectable without occupying the output area

Adopt Pi's concrete display pattern:

- Render one dim, single-line event in the transcript, for example `Compacted context · 42k → 11k tokens · Ctrl+O for details`.
- Keep it collapsed by default and do not render an `Auto-summary` heading or a multi-paragraph summary inline.
- Expanding it should reveal the summary, trigger (`manual`, `token pressure`, or `overflow recovery`), timestamp, approximate before/after tokens, retained-tail boundary, and summary version.
- Use a separate one-line idle recap such as `Last activity: implemented config loading; awaiting verification.` It should disappear or become historical when new work starts.
- Keep “show thinking,” “show tool details,” and “show summary details” as distinct state, even if one shortcut expands all event details.

### 3. Use structured rolling checkpoints

The checkpoint schema should include:

- objective and user intent;
- constraints and permissions already granted;
- completed, in-progress, and blocked work;
- decisions and their rationale;
- files read/modified and relevant symbols;
- commands/tests run and outcomes;
- open questions and next action.

Checkpoint creation should occur at a safe conversation boundary, never between a tool call and its result. On failure or interruption, preserve the prior valid checkpoint and retry at most once after a genuine context-overflow error to avoid replaying side effects.

### 4. Publish and centralize conversation controls

Document the exact global and project configuration paths and the exact session/archive locations in the TUI help and `docs/`. Provide a compact, real command set such as:

- `/sessions`, `/resume`, `/fork`, `/archive`, `/delete`;
- `/compact` and `/compact details`;
- `/export` with a sanitization option;
- `/permissions`;
- `/agents`.

Only show commands that are implemented and usable in the current build. Hide test/demo commands outside development builds, and write menu descriptions as outcomes rather than argument syntax; argument hints can appear after selection.

### 5. Separate sandbox capability from approval policy

Use Codex's two-layer model and OpenCode's rule ergonomics:

- A sandbox or OS/container boundary limits actual capability.
- Ordered policy rules decide `allow`, `ask`, or `deny` for actions and resource patterns.
- Confirmation choices should be `Allow once`, `Allow matching actions for this session`, and `Reject`.
- Explicit deny must override automatic approval. Noninteractive execution must fail closed for actions requiring confirmation.
- Network, writes outside the workspace, destructive shell operations, sensitive files, MCP calls, skill loading, and subagent spawning should be separate policy categories.
- Project-local skills, extensions, MCP definitions, and executable hooks should not load before the workspace is trusted.

Approvals and denials should be durable audit events but must not be copied into a checkpoint as if they were blanket future authorization. Export should support redacting secrets and sensitive tool outputs.

### 6. Treat subagents as real isolated executions

A menu item alone is not a subagent implementation. A production implementation should have:

- a distinct child session/thread or process and isolated model context;
- explicit parent-to-child task input and a structured result summary returned to the parent;
- visible status, transcript inspection, cancellation, wait, and error propagation;
- configurable model, tool set, and independent permission policy;
- a parent launch allowlist, depth limit, step/token budget, and concurrency cap;
- project-trust checks for project-defined agents;
- isolated worktrees or serialized writes for concurrent coding agents.

Add a PTY integration test that proves a child actually starts, uses a separate context/session identifier, performs work, returns a result, can be cancelled, and leaves an inspectable transcript. A unit test that only checks menu text or a mocked “subagent” response is insufficient evidence.

## Facts not established by the reviewed primary sources

- The exact private algorithm and token thresholds used by Codex CLI/app for automatic compaction.
- A documented Codex CLI/app control that expands and displays the full compaction summary.
- A documented stable OpenCode TUI control dedicated to expanding compaction summaries; `/details` is for tools.
- That every stable OpenCode installation already implements every v2 design/specification detail cited above.
- Core permission prompts or core subagents in Pi; both are extension territory by design.
- An industry-standard fixed idle delay for automatic user-facing recaps. The proposed 120-second default is a Thebe product recommendation, not a verified convention.
