# Thebe configuration guide

English | [简体中文](configuration.md)

For deployment and operations (container shape, production variables, TLS,
health checks, upgrade, backup, release gate) see [DEPLOYMENT.md](DEPLOYMENT.md).

## Files and directories

User configuration lives in:

```text
~/.thebe/config.json
```

Notification channel credentials live in:

```text
~/.thebe/notification-config.json
```

Files managed by the Pi runtime adapter (`models.json`, `auth.json`, and so on) live in:

```text
~/.thebe/agent/
```

UI and agent settings belong in `config.json`; do not mix them into the Pi agent
files. Configuration files can contain provider addresses and the agent
directory can contain credentials. Never commit or share them.

Override the defaults with environment variables:

```bash
export THEBE_CONFIG_DIR=/path/to/thebe-config
export THEBE_AGENT_DIR=/path/to/pi-agent
export THEBE_AGENT_STORE_DIR=/path/to/thebe-session-metadata
export THEBE_WORKSPACE_DIR=/path/to/project
export THEBE_OUTPUT_DIR=/path/to/project/.thebe/outputs
```

- `THEBE_CONFIG_DIR`: the config directory; the file is `$THEBE_CONFIG_DIR/config.json`. When only this is set, the Pi agent directory defaults to `$THEBE_CONFIG_DIR/agent`.
- `THEBE_AGENT_DIR`: the Pi agent files only.
- `THEBE_AGENT_STORE_DIR`: session, goal, and subagent metadata. Pi transcripts are not stored here.
- `THEBE_WORKSPACE_DIR`: the workspace for file tools and the TUI when `workspacePath` is not set in the config file. If neither is set, Core refuses to start; it never falls back to the process working directory.
- `THEBE_OUTPUT_DIR`: the default directory for generated documents the user explicitly asks to save. `outputDirectory` in the config file takes precedence.
- `THEBE_SESSION_DIR`: where the Pi runtime keeps session transcripts. Defaults to `~/.thebe/sessions`. The container image keeps it under `HOME` (`/data/home`), so it survives with the `/data` volume.
- `THEBE_MCP_WRITES`: whether an agent connected over `/mcp` may call write tools: `container_restart`, the Navidrome playlist writes, a provider MCP server's write tools, and the preview-and-confirm calls of a configured service API. **On by default.** Set `off` (or `deny`/`false`/`0`/`no`) to make `/mcp` read-only; a client cannot change this for itself. Core does not ask anyone first on this path. Each tool carries `readOnlyHint` and `destructiveHint`, and asking the user is up to the calling agent and its client. A provider MCP server's tool counts as a write unless its permission is `read`, which Core takes from the `readTools` you list for that server in `.thebe/mcp.json` or from a server-level `permission: "read"` — not from the server's own `readOnlyHint`. A restart leaves a normal receipt whose approval source is `mcp_client`, and every write is written to the audit log.
- `THEBE_AUDIT_PATH`: the append-only audit log (JSON lines: method, parameter hash, result, duration; no arguments or output). Defaults to `audit.jsonl` in the agent store directory. `GET /v1/audit` reads it back.
- `THEBE_TOOL_RESULT_COMPACTION` (optional, off by default): set `on` to shorten, before each model call, tool results the model has already answered from (to about 3000 characters in the same turn, about 1200 from earlier turns; images from earlier turns are dropped). Results that arrived after the model's last message stay whole and the session record is unchanged. It lowers input size but rewrites text the provider has already seen, which forfeits prompt-cache hits from that point, so enable it only when input size matters more than cache reuse.

## Managing settings

In the TUI:

- `/config` opens `config.json` in your external editor (created safely if missing).
- `/config path` prints the real paths of the config file, Pi agent directory, workspace, and output directory.
- `/settings` edits common settings.
- `/notifications` edits notification channel credentials. Secret input is masked; `/notifications list` shows only whether fields are set, and `/notifications path` prints the file path.

Restart after editing by hand so every setting takes effect.

The HTTP server also exposes `GET/PATCH /v1/settings/agent`. It returns the
effective settings and where each field came from (`configured`, `default`,
`environment`, or `derived`). HTTP may only change `autoCompact`, `autoSummary`,
and `autoSummaryDelayMs` (clamped to 60 s to 15 min). Concurrency limits, the
workspace, and the output directory are startup or authorization boundaries:
changing concurrency returns `409 restart_required`, and paths are read-only.
The default permission mode uses `GET/PATCH /v1/settings/permissions`; one session's mode uses `GET/PUT /v1/session/{id}/permissions`. Both write to the same
`config.json`. Enabled skill, extension, and prompt resources are also stored
there as identity, version, source, and kind metadata, never as skill bodies or
file contents.

## Settings reference

```json
{
  "externalEditor": "nvim",
  "tuiMode": "regular",
  "theme": "dark",
  "defaultThinkingLevel": "high",
  "autoCompact": true,
  "autoSummary": true,
  "autoSummaryDelayMs": 120000,
  "permissionMode": "manual",
  "maxSubagentConcurrency": 3,
  "maxSubagentsPerParent": 2,
  "watchdog": {
    "intervalMs": 60000,
    "goalFirstMs": 1800000,
    "goalSecondMs": 3600000,
    "workerFirstMs": 600000,
    "workerSecondMs": 600000
  },
  "enabledResources": [
    {
      "kind": "skill",
      "identity": "demo-skill",
      "version": "1.0.0",
      "source": "thebe://skills/demo-skill"
    }
  ],
  "steeringMode": "one-at-a-time",
  "followUpMode": "one-at-a-time",
  "hideThinking": false,
  "quietStartup": false,
  "fullscreenExitOutput": "transcript",
  "fullscreenScrollbar": "auto",
  "workspacePath": "/path/to/project",
  "outputDirectory": "/path/to/project/.thebe/outputs"
}
```

- `autoSummaryDelayMs` is in milliseconds; `60000` or `120000` summarizes after the user has been idle for one or two minutes.
- `permissionMode` is the host default for new sessions: `plan`, `manual`, `acceptEdits`, or `bypassPermissions` (see [Permission modes](#permission-modes)). Only these four names are read. You can also change it at runtime with `/permissions` or the settings menu.
- `maxSubagentConcurrency` and `maxSubagentsPerParent` cap global child concurrency and per-parent concurrency for one-shot in-memory subagents (clamped to 1 to 16). A profile's `maxTurns` is a positive integer with no fixed upper bound; it is the turn budget for one child, and reaching it moves the Goal to verification and the next checkpoint instead of failing the whole task. Normal sessions are unaffected. When total concurrency is above 1, Core reserves one slot for a person's request; background Goal workers and reviewers may use only the remaining slots. At 1 there is no separate background capacity.
- `watchdog` values are milliseconds; non-positive values fall back to the defaults. Core scans every 60 seconds. A Goal with no semantic progress gets one read-only status check after 30 minutes and is paused into `person / stalled` after 60. A worker or reviewer with no activity for 10 minutes is cancelled and retried once; another 10 minutes without activity pauses the Goal. Each intervention writes `watchdog.status_check`, `watchdog.retry_worker`, or `watchdog.pause` to the audit log and records the latest state on the Goal's `watchdog` field. `goalSecondMs` cannot be shorter than `goalFirstMs`.
- `workspacePath` is the mandatory workspace authorization boundary. Absolute paths are used as given; relative paths resolve against the Thebe config directory, not the launch directory. `read`, `ls`, `find`, and `grep` inside the workspace do not prompt; reads outside it need confirmation. `AGENT.md`, `AGENTS.md`, and `CLAUDE.md` are treated like any other file: readable inside the workspace, confirmed outside. `bash`, `write`, and `edit` follow the permission mode.
- `outputDirectory` is only the default location when the user explicitly asks to save a generated document. Ordinary answers are shown in the message.

## Event sources and Eval

- `THEBE_SOURCES` is a comma-separated list of Sources Core watches in the background. It is unset by default, so Core starts no Source timer and reads nothing. `THEBE_SOURCE_INTERVAL_MS` sets the poll interval (default 30000, at least 1000).
- `container-health` records `container.went_down`, `container.recovered`, `container.appeared`, `container.removed`, and `container.state_changed` on `resource:container:<name>`. A running container moving from any other health state to `unhealthy` records `container.unhealthy`; moving from `unhealthy` back to `healthy` records `container.recovered`. Health comes from the Docker or Arcane `Health` field when available, with Docker status text as the fallback for older engines.
- `download-completed` requires a configured download provider. It records `download.completed` when a download moves from any non-completed phase into `completed`, on `resource:download:<engine>:<hash>`. If any engine in a multi-engine listing is unreachable, the read fails without advancing the cursor.
- Both Sources establish a baseline on the first read, persist their cursor, and do not replay after a restart. The first read after upgrading a cursor written before health tracking seeds the health baseline without announcing an already-unhealthy container. When Sources are enabled, `GET /v1/health` includes `sources`; each entry has `state` (`starting`, `healthy`, or `failing`), `consecutiveFailures`, and the latest error. A successful read clears the failure count. A requested `download-completed` Source with no download provider stays visible as `failing`.

### GitHub and Feishu event sources

These integrations are enabled only when their environment is complete. They use the same Source runner, cursor persistence, quiesce, health reporting, and Trigger deduplication as the built-in Sources.

```bash
# GitHub: one or more owner/name repositories
export THEBE_GITHUB_REPOS=unitsung/thebe
export THEBE_GITHUB_TOKEN=github_pat_...
export THEBE_GITHUB_AGENT_LOGIN=thebe-agent
# Optional: THEBE_GITHUB_API_URL, THEBE_GITHUB_ADMIT_UNMENTIONED=1, THEBE_GITHUB_ADMIT_OPENED=0

# Feishu: one or more chat ids (oc_...)
export THEBE_FEISHU_APP_ID=cli_...
export THEBE_FEISHU_APP_SECRET=...
export THEBE_FEISHU_CHATS=oc_...
# Optional: THEBE_FEISHU_API_URL, THEBE_FEISHU_BOT_OPEN_ID, THEBE_FEISHU_MENTIONS, THEBE_FEISHU_ADMIT_UNMENTIONED=1
```

- GitHub reads `GET /repos/{owner}/{repo}/events` with ETags and records issue/PR opened, closed, reopened, comment, review, and review-comment events. The first read of a repository is a baseline. Bot actors and unaddressed comments are ignored; a comment mentioning `THEBE_GITHUB_AGENT_LOGIN` is explicit; a newly opened issue or PR is inferred (disable with `THEBE_GITHUB_ADMIT_OPENED=0`, admit unmentioned comments with `THEBE_GITHUB_ADMIT_UNMENTIONED=1`). Replies are posted as issue comments with a hidden idempotency marker.
- Feishu polls `GET /open-apis/im/v1/messages` per chat. The first read baselines the previous 24 hours; later reads use `create_time` and deduplicate by `message_id`. Non-user senders are ignored; a direct chat or a bot mention (`THEBE_FEISHU_BOT_OPEN_ID`, or an `@` name in `THEBE_FEISHU_MENTIONS`) is explicit; unaddressed group messages are ignored unless `THEBE_FEISHU_ADMIT_UNMENTIONED=1`. Replies are sent with the idempotency key as the message `uuid`.
- Admission results are persisted on the Trigger; the Ticket Mandate and Core's approval checks remain the authorization boundary. A Source can never widen a Mandate.
- The adapters have automated mock-API coverage only. Verify credentials and network access on a test Core before pointing them at a production account.
- Eval asks the configured assessment model about eligible Triggers under the Policy. `THEBE_EVAL_MAX_PER_HOUR` caps questions at 60 per hour by default; `0` removes the cap. A provider error, an unusable reply, or the hourly limit records a Decision with `outcome: "unavailable"`, never a "no". Core pushes one notice for an assessment outage and waits for a successful assessment before it announces another.
  Autonomous model work also has a daily budget. Input, output and cache-write tokens count; cache-read is reported separately and does not consume the budget. The owner's own chat is never included. The default is 1,000,000 tokens per UTC day and can be changed with `THEBE_BACKGROUND_TOKEN_BUDGET` or `PUT /v1/usage/budget`; `0` pauses autonomous model work. Warning thresholds default to 50%, 80%, 90% and 100% (configurable via `THEBE_BACKGROUND_TOKEN_BUDGET_THRESHOLDS` or `PUT /v1/usage/budget`); notices trigger once per UTC day when crossing 50%, 80%, 90% and 100%. At the limit Eval still runs the deterministic Gate, but skips the model, records `unavailable` / `daily_budget`, accepts no new Ticket, and sends one notice that day. It resumes at the next UTC midnight. `GET /v1/usage/summary` returns today's usage, estimated USD cost, thresholds, pause state and the last 30 days; after 15 days Core offers a one-time budget of twice the daily p95, and nothing changes unless the owner accepts it.

## Multi-channel notifications

`/v1/notifications/*` sends person-facing events to the owner's configured targets. Device push (`/v1/devices` and the Push Relay) remains a separate, parallel channel.

- Settings live in `{agentStoreDir}/notifications/notifications.json` (0600) and the pending queue in `outbox.json` in the same directory. Adapter-level credentials (bot token, SMTP password, WeCom corp secret and so on) come from `{configDir}/notification-config.json` (0600, edited by TUI `/notifications`) and fall back to the environment when unset. An address that embeds its own token (a DingTalk access token or a webhook URL) stays in the owner-only settings file and is masked on read.
- TUI `/notifications` edits those credentials channel by channel and masks secret input; a running Core reloads the channel automatically; a stopped Core reads the file at next start. `/notifications list` reports only whether fields are set, never their values, and `/notifications path` prints the file path. Environment variables remain a fallback for container and automated deployments.
- The App's Settings → Notification channels → Channel credentials edits the same file through `GET/PUT /v1/notifications/config`. Reads mask secret fields; a save restores untouched secrets server-side and rebuilds adapters immediately.
- `NotificationTarget.channel.source` selects the adapter. Native adapters: `webhook`, `slack`, `discord`, `telegram`, `teams`, `googlechat`, `mattermost`, `ntfy`, `bark`, `feishu-webhook`, `dingtalk`, `wecom`, `smtp`, `pushover`, `gotify`, `matrix`, `nextcloud-talk`, `signal`, `whatsapp`, `line`, `zalo`, `twilio`, `bluebubbles`, `synology-chat`, `twitch`, `irc`, `apprise`. A bound Telegram, Weixin, QQ or iMessage chat can also be a target through the `im` transport. A proactive channel (currently iMessage) sends directly; a reply-only QQ/Weixin target uses the latest inbound reply anchor while its window is open and is discarded as `window_closed` once it has closed. Existing Feishu and GitHub ticket channels also work as owner targets (a non-Ticket notice becomes a plain message/comment).
- `channel.address` is per channel: webhook `{url, secret?}`; Slack, Discord, Teams, Google Chat, Mattermost and Synology Chat `{url}` (Mattermost also accepts `channel?`); Telegram `{chatId, threadId?}`; ntfy `{url?, topic?, token?}`; Bark `{deviceKey, server?}`; Feishu `{url?, secret?}`; DingTalk `{url?, accessToken?, secret?}` (a target may carry the URL); WeCom group robot `{url}` (target or host environment) or application message `{toUser}`; email `{to}`; Pushover `{user}`; Gotify `{token, url?}`; Matrix `{roomId}`; Nextcloud Talk `{roomToken}`; Signal `{recipients}` (comma-separated phone numbers or `group.*` ids); WhatsApp and Twilio `{to}`; BlueBubbles `{chatGuid}`; LINE `{to}`; Zalo Bot `{chatId}`; Twitch `{broadcasterId}`; IRC `{channel}`; Apprise `{token?}`.
- `GET /v1/notifications/channels` returns the catalog the App renders: id, label, description, address fields, capabilities, whether the host registered the adapter, and a `setup` hint when it did not. The App's Settings → Notification channels edits targets through this route and the settings route, can send a test notice, and never stores adapter credentials locally. Device push (APNs through the Push Relay) has its own page.
- Categories: `attention`, `completed`, `failed`, `budget`, `watchdog`, `source_health`, `pipeline`. Priorities: `critical`, `normal`, `low`. A target narrows itself with `categories` and `minPriority`.
- `critical` bypasses quiet hours by default; set `criticalBypassesQuietHours` to `false` to disable that. Normal and low notices enter the queue only when the window ends. `rateLimitPerHour` is a per-target hourly limit (0 means no limit); `critical` is never rate limited, and the rolling window is in memory, so a restart resets it.
- Delivery is durable, at-least-once, and serial per target. Retrying the same `id` never produces a second notice. A request that was sent but timed out (TimeoutError/AbortError) is recorded as `unknown` and is never replayed, including after a Core restart. A connection failure / disconnect (refused, reset, etc.) is a recoverable error and retries with backoff instead of being recorded as `unknown`.
- `GET/PUT /v1/notifications/settings`, `GET /v1/notifications/channels`, `GET /v1/notifications/status`, `POST /v1/notifications/test`, and `POST /v1/notifications/send` require the Core token. Writes return 503 while quiesced. `GET settings` masks `secret`, `token`, `password`, `apiKey`, Bark `deviceKey` and Pushover `user` fields, plus credentials in URL query strings.
- `POST /v1/notifications/send` is the external entry point for devloop and similar hosts. It accepts `{id?, category, priority, title, body, deepLink?, ticketId?, goalId?}`. Without a caller-supplied `id` a fresh id is generated, so pass a stable id when retries must be idempotent. It only enqueues and returns 202; the outbox performs delivery.
- A target with `digest` (`{windowMinutes, categories}`) holds matching `low`/`normal` notices and sends one summary when the window ends; `critical` notices always bypass the window. Digest state is durable (`digests.json`), so a restart keeps an open window and emits one that ended while Core was down. `GET /v1/notifications/status` reports held notices as `digestPending`. A Goal notice also carries the Ticket's recorded `ChannelRef`s as event-specific targets; they are merged with owner targets and deduplicated by channel, and the existing write-back adapter performs the send.

Environment:

```bash
# The generic webhook needs no environment variable; each target supplies url (and optional secret) in address.
export THEBE_TELEGRAM_BOT_TOKEN=123456:ABC...
export THEBE_WECOM_WEBHOOK_URL='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'
# Or WeCom application messages (a target uses {toUser}):
export THEBE_WECOM_CORP_ID=ww...
export THEBE_WECOM_CORP_SECRET=...
export THEBE_WECOM_AGENT_ID=1000002
export THEBE_DINGTALK_WEBHOOK_URL='https://oapi.dingtalk.com/robot/send?access_token=...'
export THEBE_DINGTALK_SECRET=SEC...
export THEBE_SMTP_URL="smtps://smtp.example.com:465"
export THEBE_SMTP_FROM='thebe@example.com'
# Additional native adapters (each optional):
export THEBE_FEISHU_WEBHOOK_URL='https://open.feishu.cn/open-apis/bot/v2/hook/...'
export THEBE_FEISHU_WEBHOOK_SECRET=...
export THEBE_GOTIFY_URL='https://gotify.example.com'
export THEBE_PUSHOVER_TOKEN=...
export THEBE_MATRIX_HOMESERVER_URL='https://matrix.example.com'
export THEBE_MATRIX_ACCESS_TOKEN=...
export THEBE_SIGNAL_URL='http://127.0.0.1:8080'
export THEBE_SIGNAL_NUMBER='15550104'
export THEBE_WHATSAPP_ACCESS_TOKEN=...
export THEBE_WHATSAPP_PHONE_NUMBER_ID=...
# Optional; defaults to v20.0.
export THEBE_WHATSAPP_API_VERSION=v20.0
export THEBE_TWILIO_ACCOUNT_SID=AC...
export THEBE_TWILIO_AUTH_TOKEN=...
export THEBE_TWILIO_FROM='15550104'
export THEBE_BLUEBUBBLES_URL='http://127.0.0.1:1234'
export THEBE_BLUEBUBBLES_PASSWORD=...
export THEBE_APPRISE_URL='http://127.0.0.1:8000'
export THEBE_APPRISE_KEY=apprise-config-key
export THEBE_LINE_CHANNEL_ACCESS_TOKEN=...
export THEBE_ZALO_BOT_TOKEN=...
# Optional, for a proxy or test double; defaults to https://bot-api.zaloplatforms.com.
export THEBE_ZALO_API_URL='https://bot-api.zaloplatforms.com'
export THEBE_NEXTCLOUD_TALK_URL='https://cloud.example.com'
export THEBE_NEXTCLOUD_TALK_BOT_SECRET=...
export THEBE_TWITCH_CLIENT_ID=...
export THEBE_TWITCH_USER_ACCESS_TOKEN=...
export THEBE_TWITCH_SENDER_ID=...
export THEBE_IRC_HOST='irc.example.com'
export THEBE_IRC_PORT=6697
export THEBE_IRC_TLS=true
export THEBE_IRC_NICK=thebe
export THEBE_IRC_PASSWORD=...
```

An adapter without its credential is not registered; a target pointing at it records `adapter_missing` and does not affect other targets. A test send validates the address and credential and never enters the outbox.

## Two-way IM channels (multi-platform seam; Telegram, Weixin, QQ and iMessage built in)

`/v1/im/*` is a two-way chat integration, parallel to the notification transports above: a notification adapter only writes out, while an IM adapter also receives platform messages. Inbound messages may enter the main Session (`thebe-main`) only from an owner-bound direct chat. The binding also pins the owner's platform sender id, so another sender in the same direct chat is recorded but never reaches the model. Groups and guest bindings are recorded but never reach the model, and an inbound message never gets shell/file tools or bypasses an approval.

- State lives in `{agentStoreDir}/im/im.json` (0600): accounts, bindings, cursors tagged with the bot identity, a 7-day dedupe table, and the accepted inbound queue. Credentials are an opaque per-platform field map in `im-secrets.json` (0600); no HTTP response, log, or error message contains them.
- `POST /v1/im/channels` accepts `{platform, label?, credentials: {field: value}}`. A platform factory declares required and optional fields plus its own validation. `platform` is a registered id; the built-in adapters are `telegram` (bot token), `wechat` (Weixin ClawBot through the iLink protocol), `qq` (official Bot AppID/AppSecret) and `imessage`. For iMessage, `backend: "imsg"` uses a local `imsg` executable (default `imsg`, optional `cliPath` and `dbPath`); `backend: "bluebubbles"` uses the server `baseUrl`/password. Telegram still accepts the older `token` shorthand.
- A platform factory may also provide a QR, link or code login. `POST /v1/im/logins` starts one, `GET /v1/im/logins/{id}` polls it, `POST /v1/im/logins/{id}/code` submits a phone PIN when the state is `need_verifycode`, and `DELETE /v1/im/logins/{id}` cancels it. The QR payload or link appears only in the start response and is never persisted or logged; confirmation returns only the new `accountId`, and the resulting credentials go straight into `im-secrets.json`. The built-in Telegram adapter uses a static token, so it reports `login_not_supported`; Weixin uses QR login.
- Routes: `GET /v1/im/platforms` (registered platforms, credential fields and login support), `GET/POST /v1/im/channels`, `DELETE /v1/im/channels/{id}`, `POST /v1/im/channels/{id}/test`, `POST /v1/im/logins`, `GET/DELETE /v1/im/logins/{id}`, `GET /v1/im/status`, `GET /v1/im/conversations`, `POST /v1/im/bind`, `DELETE /v1/im/bind/{id}`, `POST /v1/im/send`, and `POST /v1/im/recall`. Writes return 503 while quiesced.
- Pairing: have the owner message the bot, read `chat.id` from `GET /v1/im/conversations`, then `POST /v1/im/bind` with `chat.kind: "direct"` and `role: "owner"`. A chat that has not been observed returns `chat_not_seen`. `senderId` may be omitted (the last observed sender is pinned); when supplied it must match the observed sender or the request returns `sender_mismatch`. `sessionId` is currently always `thebe-main`; a group can only be bound as a `guest`, a direct chat cannot bind as `guest`, and a group cannot bind as `owner`.
- Inbound messages are persisted before processing. The same `(platform, account, chat, threadId, messageId)` or `updateId` is handled once. Each chat (including its thread) has one serial queue and different chats run in parallel; accepted messages survive a Core restart and completed ones are never replayed.
- While the main Session is busy with another turn, an owner message stays in the queue instead of being dropped. By default a notice is sent after 5 seconds and a timeout reply after 10 minutes; while the main Session is streaming, the message joins the current turn as a `followUp`. `pending` in `GET /v1/im/status` is the queue depth.
- Each adapter reports truthful capabilities: `proactive`, `replyOnly`, `replyWindowMs`, `maxMessagesPerWindow`, `recall`, `media`, `maxTextLength`, `markdown`, `threads` and `typing`. Before a proactive send the gateway checks `proactive` and the adapter's `canSendProactively(chat)`: unsupported returns `proactive_not_supported`, a closed window returns `window_closed`. Reply anchors (`replyTo`, `contextToken`) belong to the current turn only; the durable destination is account + chat + optional thread.
- A reply-only channel keeps its latest inbound reply anchor in memory (the message id and, for Weixin, its short-lived `context_token`). A notification or a channel test may use it only while the capability window is open; the anchor is not written to `im.json` and is dropped on restart or quiesce. Testing a reply-only channel before any inbound message returns `no_reply_anchor`, and after the window closes `reply_window_closed`.
- An owner-bound message may carry up to eight media descriptors. Media-capable adapters download within platform limits, then the gateway enforces 2 MB per item and passes only PNG/JPEG/GIF/WebP or inline text/JSON as `PromptFile`s. Audio, video and other files stay metadata with a model-visible warning; their bytes are never executed. Platform URLs, filenames and bytes are not persisted in `im.json`, and no fetch happens unless the direct owner pin passes. `POST /v1/im/send` accepts bounded base64 `media` objects (`kind`, `mediaType`, `data`, optional `filename`), never caller filesystem paths.
- A cursor is tied to the bot/account identity: when the token or account identity changes, the old cursor is discarded so a new bot is not resumed from another bot's update position.
- The Telegram adapter long-polls `getUpdates` (`allowed_updates: ["message"]`) with `update_id + 1` as its cursor and supports forum/topic `message_thread_id` on inbound and outbound messages. Text stays plain without `parse_mode` and is chunked at 4096 characters with an `(n/m)` marker. Images, audio, video and documents use the matching Bot API upload method; inbound media uses `getFile`. A 429 pauses only that bot token; a 409 (another process polls the same bot) becomes `error` and stops polling instead of reconnecting forever.
- `GET /v1/health` reports `im` only when at least one channel is configured. `health.state` is `stopped`, `starting`, `connected`, `needs_login`, or `error`, optionally with a safe `code`, `since` and `retryAt`. One channel failing never stops Core or another channel; `GET /v1/im/status` shows the latest safe error without credentials.
- `THEBE_TELEGRAM_BOT_TOKEN` automatically creates an environment-owned Telegram channel (it cannot be removed through the API). `THEBE_TELEGRAM_API_BASE` points the adapter at a proxy or a test server, and `THEBE_TELEGRAM_POLL_TIMEOUT` sets the long-poll seconds (1–50, default 50).
- The Weixin adapter uses the official Tencent ClawBot / iLink protocol. Add it with `POST /v1/im/logins` and scan the QR in Weixin. It is reply-only: every send carries the inbound turn's `context_token`, so it can never be selected for a proactive notification. `THEBE_WECHAT_API_BASE` points the adapter at a self-hosted proxy or test double; it defaults to `https://ilinkai.weixin.qq.com`. The protocol layer is derived from Tencent's MIT-licensed Weixin ClawBot protocol layer; Core does not run an external agent runtime.
- The QQ adapter uses the official QQ Bot OpenAPI v2 over its WebSocket gateway. Add it with `AppID` and `AppSecret`; it receives `C2C_MESSAGE_CREATE` and `GROUP_AT_MESSAGE_CREATE`, and sends passive replies carrying the inbound `msg_id` and an increasing `msg_seq`. It is deliberately reply-only. A direct reply window is 60 minutes/4 messages; a group @ window is 5 minutes/5 messages. Text is chunked at 2000 characters. Rich media uploads to the official `/files` endpoint and then sends `msg_type: 7`; one media item per message. `POST /v1/im/recall` uses the official C2C/group message `DELETE` endpoint, with QQ's two-minute, role and ownership limits still enforced. `THEBE_QQ_APP_ID` and `THEBE_QQ_APP_SECRET` seed a channel from the environment; `THEBE_QQ_API_BASE`, `THEBE_QQ_TOKEN_URL` and `THEBE_QQ_GATEWAY_URL` point at a proxy or test double.
- The local iMessage backend runs `imsg watch --json --since-rowid <rowid>` and `imsg send --chat-id <id> ... --json` on the signed-in Mac. Its cursor belongs to `cliPath` and optional `dbPath`, so different databases never share a row id. Inbound attachments must resolve inside `~/Library/Messages/Attachments`; outbound media goes to a 0600 temporary file that is removed when `imsg` exits. It needs Messages automation and Full Disk Access. The BlueBubbles backend still polls its REST API; an offline Mac lets notification sends retry through the outbox. `THEBE_IMESSAGE_BASE_URL`/`THEBE_IMESSAGE_PASSWORD` (or `THEBE_BLUEBUBBLES_URL`/`THEBE_BLUEBUBBLES_PASSWORD`) seed BlueBubbles, `THEBE_IMSG_PATH` supplies the local binary, `THEBE_IMSG_DB_PATH` can select a non-default `chat.db`, and `THEBE_IMESSAGE_BACKEND=imsg|bluebubbles` chooses the default.

The local watcher also passes `--attachments`. Remote media is read as a bounded stream rather than trusting `Content-Length`, and the gateway keeps its total below the HTTP listener's 10 MB body cap.

```bash
# One Telegram two-way channel from the environment; the same bot token can still serve a notification target.
export THEBE_TELEGRAM_BOT_TOKEN=123456:ABC...
# Optional: a self-hosted Bot API proxy or a test double.
export THEBE_TELEGRAM_API_BASE='https://api.telegram.org'
# Optional: a self-hosted Weixin iLink proxy or a test double.
export THEBE_WECHAT_API_BASE='https://ilinkai.weixin.qq.com'
# One QQ two-way channel from the environment.
export THEBE_QQ_APP_ID=102030
export THEBE_QQ_APP_SECRET=...
# One iMessage channel through BlueBubbles; the same server can serve the notification target.
export THEBE_IMESSAGE_BASE_URL='https://bluebubbles.example'
export THEBE_IMESSAGE_PASSWORD=...
```

## Model providers and sign-in

Model providers are managed by the Pi runtime adapter. List and configure them
from the TUI settings or through `GET /v1/provider`; credentials are kept in the
agent directory, never in `config.json`. `POST /v1/provider/{id}/test` checks a
provider with a real probe.

## MCP OAuth gateway

OAuth is optional and stays disabled until `THEBE_OAUTH_ISSUER` names the stable
public origin of the authorization server. It exists so claude.ai and ChatGPT
connectors that understand OAuth can connect to `/mcp` without a manually
entered bearer token.

```dotenv
THEBE_MCP_PORT=8788
THEBE_OAUTH_ISSUER=https://thebe.example.com
THEBE_MCP_RESOURCE_URL=https://thebe.example.com/mcp
THEBE_OAUTH_CLIENTS_FILE=oauth-clients.json
THEBE_OAUTH_PAIRING_TTL_SECONDS=300
```

- `THEBE_OAUTH_ISSUER` must be an absolute origin without a path. HTTPS is
  required except on loopback, and the value must stay unchanged after the
  signing key is created.
- `THEBE_MCP_RESOURCE_URL` is the one resource OAuth may issue tokens for. It
  defaults to the issuer followed by `/mcp`, and its path must be exactly
  `/mcp`.
- `THEBE_OAUTH_CLIENTS_FILE` points to the pre-registered client file. A
  relative path is resolved under the config directory; the default is
  `$THEBE_CONFIG_DIR/oauth-clients.json`. `THEBE_OAUTH_CLIENTS` accepts inline
  JSON with the same shape instead.
- `THEBE_OAUTH_DYNAMIC_REGISTRATION` is off by default. Set it to `true` only
  when a connector cannot use a pre-registered client. If
  `THEBE_OAUTH_REGISTRATION_TOKEN` is also set, `/oauth/register` requires that
  value as its initial access token.
- `THEBE_OAUTH_PAIRING_TTL_SECONDS` defaults to 300 and is limited to 60–900.

The client file contains one entry per connector:

```json
{
  "clients": [
    {
      "clientId": "home-connector",
      "clientName": "Claude connector",
      "clientSecret": "optional-secret",
      "redirectUris": ["https://client.example/callback"],
      "scopes": ["mcp:read", "offline_access"]
    }
  ]
}
```

`client_id`, `client_name`, `client_secret`, and `redirect_uris` are accepted as
snake-case aliases; `scope` may replace `scopes`. Redirect URIs match exactly
and need HTTPS except on loopback. Without a secret the client is public and
uses PKCE. The default client scopes are `mcp:read` and `offline_access`.
Supported scopes are the broad `mcp:read`, `mcp:write`, and
`mcp:irreversible`, plus pre-registered
`mcp:tool:<tool>[:read|write|irreversible]` and
`mcp:service:<service>[:read|write|irreversible]` targets (an omitted level
means read), and `offline_access`. OAuth discovery still advertises the broad
scopes; a client and its authorization request must name a narrow scope
explicitly.

The authorization page requires a one-time pairing code. With the App's
full-access token, issue one from the main API listener:

```bash
curl -fsS -X POST \
  -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/pairing-code
```

Enter `code` in the browser before `expiresAt`. The code works once. A scoped
`/mcp` token cannot call the pairing API. The local TUI can also run `/pair`
(aliases `/oauth` and `/connector`) to issue a one-time code and show its
issuer, resource, and expiry.

The full-access App token can inspect and revoke connector grants on the main
API listener:

```bash
curl -fsS -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/connections

curl -fsS -X DELETE -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/connections/GRANT_ID
```

Listing returns each grant's client, scopes, creation time, optional expiry, and
whether it has a refresh token. Revocation immediately invalidates its access
tokens, refresh tokens, and unredeemed authorization codes; the connector must
complete the authorization flow again. Scoped `/mcp` tokens get
`403 token_scope` on both routes, and the internet-facing MCP gateway does not
expose them.

From the local TUI, use `/connections` (alias `/grants`) to list the same grants
and `/connections revoke <grantId>` to revoke one. Core advertises `mcp-oauth`
in `GET /v1/health` capabilities while this gateway is configured.

The authorization server uses Authorization Code + PKCE, exact redirect URI
matching, Resource Indicators bound to `/mcp`, and PS256 JWT access tokens.
Access tokens last 15 minutes. A request with `offline_access` and
`prompt=consent` receives a rotating 30-day refresh token, and revoking that
refresh token invalidates its access token on the next `/mcp` request. The
issuer, signing keys, provider state, pairing hashes, and client grants live in
the config directory; back them up together. See
[DEPLOYMENT.md](DEPLOYMENT.md#412-oauth-for-claudeai-and-chatgpt-connectors) for
the public listener and reverse-proxy setup.

## Service connections

Each service appears in the capability catalog only when all of its required
variables are set. Credentials stay inside the adapter and never appear in tool
arguments or capability metadata. The `THEBE_`-prefixed names
(for example `THEBE_NAVIDROME_BASE_URL`) are equivalent aliases.

### Arcane (containers and activity)

```bash
export ARCANE_BASE_URL=http://127.0.0.1:3552
export ARCANE_API_KEY=your-arcane-api-key
export ARCANE_ENVIRONMENT_ID=0   # optional; 0 is Arcane's local environment
```

Provides container list, inspect, logs, status summary, restart, and start.
Arcane 1.x/2.x and 3.x are both supported: Core reads the public
`/api/version` endpoint and uses `/api/environments/{id}/...` for 1.x/2.x or
`/api/agents/{id}/...` for 3.x. If a proxy hides `/api/version`, Core probes
the v3-only `/api/agents` route. With a complete address and key, Arcane's
background activities (image pulls, updates, scans) also feed the Activity feed
as background tasks (`provider=arcane`). Core reads the environment's
`activities` list (latest 25, newest first), redacts and truncates error text,
and the app's "stop" calls `activities/{activityId}?action=cancel` on 3.x or
`activities/{activityId}/cancel` on older servers. A finished activity returns
409 "already finished"; Arcane versions without activity cancellation return 404. Without credentials neither the container capabilities nor the activity
source is registered.

### Containers without Arcane (Docker Engine API via docker-socket-proxy)

With no Arcane, Core can reach the Docker Engine API through a **restricted**
`docker-socket-proxy`. Arcane wins when it is configured:

```bash
export THEBE_DOCKER_PROXY_URL=http://127.0.0.1:2375   # proxy root, must be an http(s) URL
# export THEBE_DOCKER_API_VERSION=v1.43               # optional; no version prefix by default
```

Core only talks to that proxy root: it never opens `docker.sock`, never accepts a
host from a request, and refuses redirects. The proxy should expose only the read
endpoints and `POST /containers/*/restart`; reach it over loopback or Tailscale and
publish nothing. The reads map to the same `container_*` surface, and the only
write (`container_restart`) still follows approval → execute → verify → receipt and
is never attached to the model tool loop. `ResourceRef.provider` gains a `docker`
value. Logs may be a multiplexed stream (non-TTY) or plain text (TTY/proxy); Core
demultiplexes the framed form and falls back to text.

### OpenList and the acquisition pipeline

```bash
export THEBE_OPENLIST_BASE_URL=https://openlist.example.com
export THEBE_OPENLIST_TOKEN=your-openlist-token
```

The preferred place for these credentials is the `storage` section below
(`thebe storage add openlist ...`); the environment variables remain as a
fallback. Either source registers the `strm_repair` capability and the file
tools. It uses OpenList's `/api/fs/get`,
`/api/fs/search`, and `/api/fs/put` to find candidates (regular media plus HLS
`.m3u8` and DASH `.mpd` playlists), write the STRM back, and read it again to
verify. The token is used only by the adapter.

OpenList also ships an official MCP server. Enable it in OpenList's own
configuration (`"mcp": { "enable": true }`), restart OpenList, and let Core attach
it:

```bash
export THEBE_OPENLIST_MCP=on
```

Core then adds a deferred `openlist` MCP server at `<THEBE_OPENLIST_BASE_URL>/mcp`
with the user token in `Authorization` verbatim (OpenList rejects a `Bearer`
prefix). The preset lists `openlist.fs.list`, `openlist.fs.get` and
`openlist.fs.link` as read tools, so `/mcp` clients do not treat them as writes.
It is off by default because the native adapters above cover the same reads; an
explicit `openlist` entry in `.thebe/mcp.json` wins over the environment preset.
To attach it by hand instead:

```bash
thebe mcp add openlist --url https://openlist.example.com/mcp --header "Authorization: <token>"
```

With qBittorrent (`THEBE_QBITTORRENT_URL`, `_USERNAME`, `_PASSWORD`), OpenList,
and an Emby or Jellyfin API key configured, Core exposes the acquisition tools:
`download_add/list/status/pause/resume/delete`,
`files_list/mkdir/copy/move/rename/remove/upload/offline_download`,
`library_scan`, and `library_refresh_item`. With `THEBE_PROWLARR_URL` and
`THEBE_PROWLARR_API_KEY` it also exposes `resource_search` and
`pipeline_acquire/advance/status`: a deterministic job (download, copy, scan,
verify) with bounded retries, persisted in `<agent store>/pipeline-jobs.json`.
Writes need approval.

#### File storage backends

File storage lives in `~/.thebe/config.json` (or `$THEBE_CONFIG_DIR/config.json`),
not in a pile of environment variables. The `storage` section is authoritative:

```json
{
  "storage": {
    "default": "media",
    "backends": [
      {
        "id": "openlist",
        "type": "openlist",
        "baseUrl": "https://openlist.example.com",
        "token": "your-openlist-token"
      },
      { "id": "media", "type": "local", "roots": ["/mnt/media"] },
      {
        "id": "nas",
        "type": "webdav",
        "url": "https://dav.example.com/dav",
        "username": "user",
        "password": "secret"
      }
    ]
  }
}
```

Manage it with the CLI; every command writes the file atomically with mode
`0600` and leaves unrelated config keys alone:

```bash
thebe storage list
thebe storage add openlist openlist --url https://openlist.example.com --token <token> --default
thebe storage add local media --roots /mnt/media,/mnt/backup
thebe storage add webdav nas --url https://dav.example.com/dav --username user --password secret
thebe storage test media
thebe storage default media
thebe storage remove openlist
```

`thebe storage test` lists `/` on one backend (or all of them) and reports the
entry count. `storage add` with an existing id replaces that backend; a secret
you omit keeps the stored one, so editing a URL does not require re-entering a
token. `--password` can be used with `--username`; use `--token` for
a WebDAV bearer token instead.

The same settings are available over the product HTTP API for the web UI:

- `GET /v1/settings/storage` returns the backends with secrets redacted
  (`hasToken`/`hasPassword`), plus the config path, source, default and any
  issues.
- `PUT /v1/settings/storage` replaces the list; an omitted secret keeps the
  stored secret for the same id and type. `default: null` picks the first
  backend and omitting `default` keeps the current one.
- `POST /v1/settings/storage/test` with an optional `{ "id": "media" }` tests
  one or all backends.

Changes apply without restarting Core. Every `files_*` tool call re-reads the
configuration, so an open session sees a backend that was added, edited, or
removed while it was running. Acquisition jobs capture the default backend when
the session opens: open a new session after changing the default if you want
existing jobs to use the new one.

When more than one backend is configured, each file tool call takes a
`provider` argument (the backend `id`), and `files_list` reports the configured
ids. When only one exists it is used automatically. A backend that does not
support an operation does not expose that tool.

A `local` backend exposes host directories through the same tools — an NFS or
SMB share the host has already mounted, or any local path. Roots must be
absolute paths. Every path must resolve inside one of these roots; `..` and
symlinks that leave a root are refused or hidden. Listing `/` on this backend
shows the configured roots themselves. The Core container sees only what the
host mounts into it, so mount the share (Docker bind mount / compose `volumes`)
and pass the container path.

A `webdav` backend speaks PROPFIND, MKCOL, COPY, MOVE, DELETE and PUT, sends
`Overwrite: F`, and refuses a destination that already exists. `token` sends a
bearer token; otherwise `username` and `password` send Basic auth.

Native SMB and NFS clients are not built in: mount the share on the host and use
a `local` backend (OpenList's own SMB/WebDAV drivers remain the richer path when
OpenList manages the storage).

`files_remove` requires an explicit `recursive` boolean and refuses a non-empty
folder unless it is `true`. `files_upload` reads only from the workspace or
outputs directory (1 GiB limit) and refuses an existing destination name.

An OpenList backend, whether it comes from the config section or the
environment, also registers `strm_repair`, cloud transfer, and OpenList
background tasks. Those long-lived providers read the OpenList address and
token when Core starts; the `files_*` tools always read the current config.
Restart Core after changing the OpenList address or token to apply it to
acquisition and transfer.

##### Legacy environment variables

`THEBE_OPENLIST_BASE_URL`/`THEBE_OPENLIST_TOKEN`,
`THEBE_FILES_LOCAL_ROOTS`, and
`THEBE_WEBDAV_URL`/`_USERNAME`/`_PASSWORD`/`_TOKEN` still work, but only while
`config.json` has no `storage` section. Once a section exists, the environment
is ignored — that is what makes removing a backend reliable. To keep the
environment setup, materialize it once:

```bash
thebe storage import-env
```

The environment supplies the ids `openlist`, `local`, and `webdav`. The optional
OpenList MCP server enabled with `THEBE_OPENLIST_MCP=on` still reads
`THEBE_OPENLIST_BASE_URL/TOKEN`; you can also add it by hand with
`thebe mcp add openlist --url ... --header "Authorization: <token>"`.

`THEBE_ARIA2_URL` (and `THEBE_ARIA2_SECRET`, aria2's `rpc-secret`, when it has one) adds aria2 as a second
download engine behind the same `download_*` tools. `download_add` sends magnets and `.torrent` links to
qBittorrent and every other link to aria2 unless `engine` names one; `download_list` merges both and names an
engine that did not answer in `unreachable`. Every download carries `engine`, `id`, `phase` (`queued`,
`downloading`, `paused`, `error`, `completed`), `badges` and `capabilities`, the same vocabulary clients
use (`contracts/download-states.json`). aria2's RPC cannot delete files: an unfinished
aria2 download offers `remove_with_files` because removing it makes the owner's own `on-download-stop` script
clean up; a finished one cannot have its files deleted through aria2 and offers only `remove`.

An acquisition job can start from a torrent or from a network-drive transfer:
`pipeline_acquire` with `kind: "cloud_transfer"` and a `transferSource` fetches
the share/direct link through OpenList's offline download, then runs the same
place → scan → verify steps. Core keeps jobs acquired in the running process
moving on its own (every minute),
so an import finishes while the phone is asleep. A job restored after a Core
restart is not auto-resumed — call `pipeline_advance` to continue it — and a
failed job is never retried automatically.

- `download_pause` and `download_resume` take `hashes` (1 to 20 download ids: torrent info-hashes, or aria2 ids when aria2 is configured; there is no "pause all"), keep the task and files, and need approval. qBittorrent 5 uses `stop`/`start` and 4.x uses `pause`/`resume`; Core detects the version. Unknown hashes are rejected rather than silently ignored. If the downloader lacks the operation, the tool does not appear.
- `download_delete` also takes `hashes` (1 to 20), is irreversible, and needs approval. `deleteFiles` must be explicitly `true` or `false`: `false` removes only the task, `true` also deletes files on disk. A missing or non-boolean value is rejected; nothing is deleted by default.

qBittorrent also supplies native download tasks to the Activity feed and, for
completed tasks, bounded `task_output` Artifacts (Web API v4 and v5).

### Navidrome (music)

```bash
export NAVIDROME_BASE_URL=http://127.0.0.1:4533
export NAVIDROME_USERNAME=thebe
export NAVIDROME_PASSWORD=your-password
# optional: retry address if the main one is unreachable; also the base for later playback URLs
export NAVIDROME_FALLBACK_URL=https://music.example.com
```

Needs the URL, username, and password together. Uses the Subsonic API for recent
and most-played albums, artists, playlists, songs, search, artist details,
lyrics, and the playback queue. `navidrome_queue` returns uniform song entries
(direct or transcoded stream URL, cover, title, artist, album, optional lyrics);
Core does not play audio, the client does. Creating, updating, and deleting
playlists are writes and can only run through an agent session's runtime
approval; capability invoke returns 403, and `/mcp` allows them only when the
host has not set `THEBE_MCP_WRITES=off`. The password stays inside
the adapter.

For the model, library, search, and artist tools return compact observations:
all returned candidates keep their order, names, IDs, and album/artist
relations; cover art and audio-encoding fields are dropped. Artist biographies
are capped at 2000 characters with `biographyTruncated:true`. Direct capability
responses keep the full schema, and queue URLs, lyrics, and write receipts are
never trimmed.

### Emby, Jellyfin, and Immich

```bash
export EMBY_BASE_URL=http://127.0.0.1:8096
export EMBY_API_KEY=your-emby-key
export EMBY_USER_ID=your-user-id

export JELLYFIN_BASE_URL=http://127.0.0.1:8096
export JELLYFIN_API_KEY=your-jellyfin-key
export JELLYFIN_USER_ID=your-user-id

export IMMICH_BASE_URL=http://127.0.0.1:2283
export IMMICH_API_KEY=your-immich-key
```

These register read-only capabilities. Emby uses `X-Emby-Token` and the `/emby`
prefix; Jellyfin uses `Authorization: MediaBrowser Token="..."` with no prefix.
`emby_search` and `jellyfin_search` find items by title, person, or year and
return item ids; `emby_item` and `jellyfin_item` read overview, type, year,
genres, and cast. `communityRating` is the media server's own rating.
`immich_search` calls `POST /api/search/smart` for semantic search by image
content; filename, date, and city filters still use the metadata listings. If
machine learning is unavailable the error is surfaced, not treated as an empty
library.

### Web search and music sources

Both are optional and off until configured.

```bash
# Web search: a SearXNG instance with the JSON format enabled
export THEBE_WEB_SEARCH_URL=http://127.0.0.1:8080

# Music sources (read-only lookups, plus approval-gated SQMusic downloads)
export THEBE_NETEASE_API_URL=http://127.0.0.1:3000      # a NeteaseCloudMusicApi service, no login
export THEBE_SQMUSIC_URL=http://127.0.0.1:8081
export THEBE_SQMUSIC_USERNAME=thebe
export THEBE_SQMUSIC_PASSWORD=your-password
```

- `THEBE_WEB_SEARCH_URL` registers `web_search` (up to 5 results of 500 characters, with source links). There is no public default endpoint: without this variable Core offers no `web_search`. A session also keeps its own on/off switch. Results are untrusted text. To search without running SearXNG, point Core at a search MCP server instead (see [MCP servers](#mcp-servers)).
- `THEBE_NETEASE_API_URL` registers `netease_music` (search, lyrics, comments, playlist, toplist).
- `THEBE_SQMUSIC_URL` with `_USERNAME` and `_PASSWORD` (all three) registers `sqmusic_search` and `sqmusic_download`. A download queues one song, or with `kind: "album"` one album (at most 60 songs), and needs approval; it is refused over `/mcp` and direct capability invoke. See [Core product HTTP](CORE-PRODUCT-HTTP.md) for the full contract.
- Built-in `music_research` (MusicBrainz and Wikipedia lookups) needs no configuration.

### Other services (OpenAPI)

`THEBE_CLOUDSAVER_BASE_URL` and `THEBE_CLOUDSAVER_TOKEN` (and the same pair for OpenList) are shortcuts that register those two services as OpenAPI connections without a `THEBE_SERVICE_APIS` entry. The CloudSaver token is sent as a bearer token.

Add one HTTP service by setting its base URL and an OpenAPI 3 or Swagger 2 document:

```bash
export THEBE_SERVICE_APIS='[{"id":"my-service","baseURL":"http://192.168.1.10:8080","openapiPath":"/openapi.json","headersEnv":{"X-API-Key":"MY_SERVICE_API_KEY"}}]'
export MY_SERVICE_API_KEY=...
```

Operations are loaded from the OpenAPI document for discovery and reads, and
writes need approval. Header values are environment references and are never
sent to the model.

- `resourceKinds` (for example `["container"]`) says what kind of thing this service looks after. When Core takes an event on by itself (`auto` mode), the services its executor may write to are found from the event's resource kind, so Arcane, plain Docker (through the restricted proxy) and Portainer are the same configuration, and Core has no code for any one of them. If no connection claims a kind, the kind's own name is the service. The executor writes with the generic `service_write`, which needs no OpenAPI document, only a method and a path.
- `openapiPath` is fetched from `baseURL`. When the service does not serve its
  spec there, use `openapiURL` with an absolute `http(s)` URL instead (the spec is
  fetched without the API's auth headers, which stay on the API host).
- `readOperations` is the operator's read-only allow-list — operation IDs or
  `METHOD /path` entries. Each allow-listed read operation becomes its own tool
  (`service_api.<id>.<operationId>`) with a real input schema, listed on `/mcp`
  and in `/v1/capabilities`, so an MCP client gets named tools instead of one
  generic call. Everything else stays behind `service_discover` /
  `service_write` with runtime approval; operations that require a header
  parameter are never exposed this way (headers are operator-owned).
- Less typing, same trust model: `readMethods` (e.g. `["GET","HEAD"]`) treats
  every operation with those methods as read-only, and
  `trustReadOnlyAnnotations: true` additionally trusts the document's own
  read-only hints. Both are **off unless you set them** — a remote document can
  never mark itself read-only on its own.
- `excludeOperations` (operation IDs or `METHOD /path`) and `excludeTags` hide
  operations from discovery and the named tools, and every request that matches
  one is refused — reads, writes and approved calls alike. Use them for admin or
  destructive endpoints that the model should never reach, whatever it asks.
- `writeOperations` (operation IDs or `METHOD /path`) exposes chosen writes as
  two-phase tools. Calling one performs **no change**: it returns a
  `preview` (`method`, `path`, `body`) and a single-use `confirmToken` that
  expires in five minutes. `service_confirm` with that token executes exactly
  the previewed request. Both the preview and the execution are audited, and the
  client is expected to show the preview before confirming. The model's
  own write path stays `service_write` with runtime approval.
- Run `node scripts/accept-service-api.mjs` to check a configured service end to
  end (it spawns Core, lists the per-operation tools, discovers operations, and
  invokes a read; `--preview` checks the two-phase write).

## MCP servers

External MCP servers go in `.thebe/mcp.json` under `mcpServers` (the global
`~/.thebe/mcp.json` and `.mcp.json` are also read). Model sessions connect to
them through Pi's built-in MCP extension; Core does not keep MCP connections of
its own. Tool names are `mcp__<server>__<tool>`.

```json
{
  "mcpServers": {
    "notes": {
      "command": "notes-mcp",
      "args": ["--stdio"],
      "env": { "API_KEY": "..." },
      "description": "Search and read notes",
      "exposure": "codemode",
      "permission": "confirm",
      "disabled": true
    }
  }
}
```

- `exposure`: `codemode` (default; tools can only be called from `codemode` scripts and take no space in the model's tool list), `deferred` (declared after `tool_search` loads them), `direct`, or `hidden`.
- URL servers accept a `headers` map (string values) sent on every request, so a provider's own MCP that needs a token — for example `"headers": { "X-Api-Key": "..." }` or a service-specific header such as `{"sqmusic":"<JWT>"}` — is attached without Core growing a vendor adapter. Prefer this over hard-coding the service: point Core at the provider's MCP and it gets those tools instead. `headers` are stored in `.thebe/mcp.json` (mode `600`), never logged, and never sent anywhere but the configured URL.
- `permission`: servers other than `read` need approval on every call. If omitted, only the tools named in `readTools` run as reads and every other tool asks first. The server's own `readOnlyHint` is not the operator's confirmation: a compromised server could claim it on a write.
- `readTools` (optional list of tool names as the server declares them): tools you confirm only read. A listed tool no longer asks per call, and over `/mcp` it is not held as a write by `THEBE_MCP_WRITES` or a token's `mcp:write`. A server-level `permission: "read"` covers all of its tools.
- Scripts run in Pi's QuickJS sandbox and reach the outside only through tools. Every MCP call from a script still goes through policy, approval, audit, and redaction. The `models` global in `codemode` is disabled.
- stdio servers inherit only basic variables such as `HOME` and `PATH`, plus their own `env`, never Core's environment.
- Newly added servers are disabled. Enable, disable, or delete them with `/v1/extensions/mcp/servers`; sessions pick up the change on the next reload.
- From the terminal: `thebe mcp add <name> --url <url> --header K=V` (repeat `--header`, `--env`, `--arg`), then `thebe mcp enable <name>`; `thebe mcp list` and `thebe mcp tools` show the inventory, and `thebe mcp remove <name>` deletes a server Thebe wrote.
- Web search without running SearXNG: point Core at a search MCP server. Parallel's keyless endpoint works as `{"mcpServers": {"parallel": {"url": "https://search.parallel.ai/mcp", "description": "Web search and page fetch", "exposure": "deferred"}}}` and gives `mcp__parallel__web_search` and `mcp__parallel__web_fetch` after `tool_search` loads them. Queries and fetched URLs go to Parallel, and its free tier is limited. In a 2026-10-14 check, adding `"permission": "read"` to this entry stopped its tools appearing in `tool_search`, so leave `permission` out; calls ran without an approval prompt in that check.
- Which services ship their own MCP server (Home Assistant, Grafana, Docker, GitHub, Kubernetes today) is recorded in `PROVIDER-MCP.md`; an opt-in live check connects to real servers with `THEBE_MCP_LIVE=1 npx vitest run src/adapters/mcp/live.test.ts`.

## Skills

The repository ships skills under `.thebe/skills/`: `navidrome-recommend`,
`library-lookup`, `photo-find`, `container-triage`, `download-monitor`, and
`media-acquire`. Copy the directory to the workspace's `.thebe/skills/` or to the
Core user's `~/.thebe/skills/`, then enable it in the app's Skills settings or
with `PATCH /v1/skills/<name>` and body `{"enabled":true}`. In a container, put
the skills in the mounted workspace or a persistent `HOME`. Having them only in
the development repository does not enable them anywhere.

At runtime only the name, description, and path of enabled skills are added to
discovery; the body is read on demand. Skills report honestly when the tools
they need are not configured instead of inventing results.

- `container-triage`: read-only container status and log triage (`container_*`); restarts are not called by the model and still go through the diagnosis approval flow. Needs a container provider such as Arcane.
- `download-monitor`: follows download and import progress with `download_*`, `pipeline_status`/`pipeline_advance`, and `files_list`.
- `media-acquire`: `resource_search` finds sources, the user picks one, and `pipeline_acquire` downloads and imports it. Needs an indexer, downloader, file manager, and media server.

## Command risk guard (homelab and NAS heuristics)

Before approval, `bash`, `write`, and `edit` pass through a command risk guard
(`src/agent/security/command-risk.ts`) with four levels:

| Risk        | Behavior                                                                         | Examples                                                                                                                                                                                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical`  | **Denied by policy** (never reaches approval; the model sees `denied by policy`) | `rm -rf /`, bulk deletes of NAS data directories such as `/volume1`, `zfs destroy`, `zpool destroy`, `mkfs.*`, `mke2fs`, `ntfsclone --overwrite`, `ntfswipe`, `exportfs -ua`, `mdadm --stop/--zero-superblock`, `fdisk`/`parted`, `dd of=/dev/sdX`, fork bombs, `kill -9 1`, `docker run -v /:... --privileged`       |
| `dangerous` | Still needs human approval (shown as high risk)                                  | shutdown or reboot, flushing the firewall, `docker rm -f $(ps -aq)`, `docker volume prune -f`, mounting `docker.sock`, `ntfsfix`/`ntfsresize`, force-unmounting shared storage, stopping smbd, nfs-server, sshd, or docker, writing system paths such as `/etc/...`, writing or modifying files outside the workspace |
| `caution`   | Allowed, with a warning recorded                                                 | restarting or stopping containers or system services, `chmod -R`, `chown -R`, scrub, `exportfs -a`                                                                                                                                                                                                                    |
| `safe`      | Runs normally                                                                    | read-only checks such as `docker ps`, `zpool status`                                                                                                                                                                                                                                                                  |

- Docker and Podman commands get a further container guard (`docker-command-guard.ts`): privileged containers with a host-root mount, host-root bind mounts, `--privileged`, `docker.sock` mounts, volume prune.
- Storage systems recognized: ZFS, Btrfs, EXT4 (including xfs and f2fs), NTFS, NFS; the result carries a `storageSystem` field.
- Workspace escapes: writing outside the workspace, or `rm`/`mv`/`cp`/`chmod`/`chown` on paths outside it, is raised to `dangerous`.
- Direct calls to the Docker Engine API (`curl --unix-socket /var/run/docker.sock ... /containers/create`, podman remote) go through `docker-api-guard.ts`: `HostConfig.Privileged=true`, `Binds` with the host root or `docker.sock`, `CapAdd: SYS_ADMIN|ALL`, and `/volumes/prune` or `/system/prune` are always `critical`. If the `/containers/create` body cannot be parsed, it is downgraded to `dangerous` (human review), not allowed.
- The guard is always on. Only `bypassPermissions` (below) lifts it, for one session.

## Permission modes

One setting decides how much a session may do without asking. The names are Claude Code's.

| Mode                | What runs without asking                                                                                       | What is asked or refused                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `plan`              | Reads inside the workspace                                                                                     | Everything that changes something is refused                                                                            |
| `manual`            | Reads inside the workspace                                                                                     | `bash`, `write`, `edit`, memory and write tools of services are asked each time                                         |
| `acceptEdits`       | `write` and `edit` inside the workspace (never `.git`), and `bash` when a sandbox that confines it is in place | Anything the command guard flags, paths outside the workspace, `bash` with no sandbox, `memory`, MCP and service writes |
| `bypassPermissions` | Everything; the command guard and the sandbox are lifted                                                       | Nothing. Turn it on in the TUI or a graphical client; both ask first                                                    |

`acceptEdits` follows Codex's on-request policy with a restricted sandbox: the sandbox, not a list of
"safe" commands, is what makes running a command without asking acceptable, so with no sandbox
running a command is asked about as usual. Even with one, a script that `tree-sitter-bash` cannot read, or
that holds a forced `rm` (found through `sudo`, `env`, `trap` and `bash -c`, as Codex's check does), is asked about. `.git` stays read-only as it does in Codex's
workspace-write sandbox.

- The host default comes from `permissionMode` in `config.json` (default `manual`). A session can set its own with `PUT /v1/session/{id}/permissions` (`{"mode": "plan"}`; `{"mode": null}` returns to the host default), and `GET` on the same path says which mode it runs in.
- A subagent, a scheduled occurrence, a background goal, an `/mcp` caller and a non-interactive turn take the host default, not the session's own mode.
- A remembered denial, redaction and the audit log apply in every mode. `critical` commands are refused in every mode except `bypassPermissions`.
- `POST /v1/session/{id}/full-access` with `{"enabled": true|false}` still works and is `bypassPermissions` on or off.

### `bypassPermissions`

Session-scoped, and it can also be the host default. It lifts the command guard, the OS sandbox and tool approval, and leaves redaction and audit in place.

No environment variable is required. `THEBE_FULL_ACCESS` is ignored, the same as leaving it unset: it does not start the process in bypass. Choosing it with `/permissions` or the settings menu in the TUI, or in a graphical client's Agent settings, asks first. A confirmed host default is saved in `config.json`. Schedules, subagents, background goals and `/mcp` use the host default; they do not inherit bypass that one session turned on for itself.

The model reads untrusted content (web pages, tool output, remote MCP), so in this mode a mistaken command can damage the host: use it only when needed. Full access applies on the next command; a new session is not required.

## Command sandbox

Model `bash` and the Core process are different boundaries. There is no backend menu.

- **Container deployment** (the release shape): `/.dockerenv` or `/run/.containerenv` means no sandbox is started. Leave `THEBE_SANDBOX` unset. Do not nest bubblewrap or a VM inside the container.
- **Host install**: the default is pinned `@anthropic-ai/sandbox-runtime` (the same Seatbelt / bubblewrap Claude Code uses). The TUI settings menu and a graphical client's Agent settings can turn it off, and both ask first; the command guard stays on. That is not bypass, and there is no automatic bypass. `THEBE_SANDBOX=off` and a container force it off, and the switch cannot override that. Full access (`bypassPermissions`, confirmed in the TUI or a graphical client) also lifts the sandbox.

`os`, `auto`, `vm`, `gondolin`, `bwrap`, `docker`, `seatbelt` and any other value are ignored, the same as leaving the variable unset: a host still uses the OS sandbox, and a container still stays off. They are not mapped, and they do not fail startup.

The policy is fixed, not an environment variable:

- Write: the workspace and the temp directory.
- Read: open, except `~/.ssh`, `~/.aws`, `~/.gnupg` and `~/.thebe`.
- Network: an allowlist, empty by default, the same shape as Claude Code. Sandboxed `bash` asks the first time it reaches a host. Allowing once covers that command; remembering the host writes `sandboxAllowedDomains` in `config.json` and later commands are not asked. A remembered denial writes `sandboxDeniedDomains`. Two sandboxed commands at once cannot be told apart, so that connection is denied. `web_search` does not use this list. Bypass does not enter the sandbox, so its network is open.

A missing dependency refuses the command instead of running it bare. Linux needs bubblewrap, socat and ripgrep; macOS uses `sandbox-exec` and does not need ripgrep. `thebe doctor` exits 1 in that case. `GET /v1/system/isolation` reports `sandbox.mode` as `off` or `os` and no longer returns `backends`.

The command guard, the workspace confinement and the Docker API guard (privileged containers, host-root and
`docker.sock` mounts, volume prune) are always on and have no switches.
