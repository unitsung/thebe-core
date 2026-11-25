# Thebe 配置指南

[English](configuration.en.md) | 简体中文

## 配置文件位置

Thebe 的用户配置文件默认位于：

```text
~/.thebe/config.json
```

通知通道凭据默认位于：

```text
~/.thebe/notification-config.json
```

默认的 DeepSeek Harness（DSH）运行时为每个 Core Session 使用独立的 DSH home，位于：

```text
~/.thebe/agent/dsh-sessions/<runtime-session-id>/
```

设置 `THEBE_RUNTIME=pi` 时，Pi 兼容 Adapter 使用的 agent 文件位于：

```text
~/.thebe/agent/
```

该目录可包含 `models.json`、`auth.json` 等由 Pi Adapter 管理的文件。Thebe 的界面和 Agent 设置应写入 `config.json`，不要直接混入运行时目录。

部署与运维请看 `docs/DEPLOYMENT.md`：容器部署形态、生产环境变量、HTTPS/Tailscale、进程隔离边界、健康检查与优雅退出、升级/回滚、备份/恢复、发布冒烟测试与 CI 发布门禁。

## 在 TUI 中管理配置

- `/config`：使用外部编辑器打开 `config.json`。文件不存在时会安全创建。编辑器退出后，Thebe 恢复 TUI 并重新绘制界面。
- `/config path`：显示 Thebe 配置文件、运行时数据目录、工作区和文档输出目录的实际路径。
- `/settings`：在 TUI 内修改常用设置。
- `/notifications`：在 TUI 内配置通知通道凭据；输入密钥时字符会隐藏，`/notifications list` 只显示是否配置，`/notifications path` 显示文件路径。

手动修改后，需要重新启动 Thebe 才能确保所有设置生效。

Serve 也提供 `GET/PATCH /v1/settings/agent`。它返回运行中的有效
Agent 设置以及每个字段的来源（`configured`、`default`、`environment` 或
`derived`）。HTTP 只允许修改 `autoCompact`、`autoSummary` 和
`autoSummaryDelayMs`；摘要延迟会限制在 60 秒到 15 分钟。并发上限、工作区
和输出目录属于启动或授权边界：并发修改返回 `409 restart_required`，路径只读。
默认权限模式使用 `GET/PATCH /v1/settings/permissions`，单个会话的模式使用 `GET/PUT /v1/session/{id}/permissions`，设置都会写入
同一个 `config.json`。已启用的 skill、extension 和 prompt 资源也会写入该配置；
重启后 Core 会恢复这些资源的 identity、version、source 和 kind 元数据，不会把
skill 正文或任意文件内容写入配置。

## 外部编辑器

编辑器选择遵循 Pi 的规则，优先级从高到低为：

1. `config.json` 中的 `externalEditor`
2. `$VISUAL`
3. `$EDITOR`
4. 平台默认编辑器：Windows 使用 Notepad，其他平台使用 nano

示例：

```json
{
  "externalEditor": "nvim"
}
```

也可以通过环境变量指定：

```bash
export VISUAL=nvim
export EDITOR=vim
```

## 支持的配置项

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

`autoSummaryDelayMs` 的单位是毫秒。建议设置为 `60000` 或 `120000`，表示用户停止操作 1 或 2 分钟后生成自动摘要。

`permissionMode` 是新会话的默认权限模式：`plan`、`manual`、`acceptEdits` 或 `bypassPermissions`（见下文“权限模式”）。只认这四个名字。运行中也可以使用 `/permissions` 或设置菜单修改。

`maxSubagentConcurrency` 和 `maxSubagentsPerParent` 分别控制全局 child 并发数和单个父会话的并发数；它们只限制一次性 in-memory subagent，不影响普通会话。数值会被限制在 1–16。单个 profile 的 `maxTurns` 是正整数，Core 不设固定上限；它只是单次 child 的 turn 预算，达到后由 Goal 继续验证并进入下一 checkpoint，而不是把整项任务判死。总并发大于 1 时，Core 固定保留 1 个槽位给人工请求，后台 Goal worker/reviewer 最多使用其余槽位；总并发为 1 时没有单独的后台容量。

`watchdog` 的五个字段都以毫秒计，非正数会回退到默认值。默认每 60 秒扫描一次；Goal 30 分钟没有语义进展时先做一次只读状态检查，60 分钟仍无进展则暂停并进入 `person / stalled`。worker 或 reviewer 10 分钟没有活动时取消并重试一次，之后再过 10 分钟仍无活动就暂停。每次介入都写入 `watchdog.status_check`、`watchdog.retry_worker` 或 `watchdog.pause` 审计记录，并把最后状态放在 Goal 的 `watchdog` 字段中。`goalSecondMs` 不会小于 `goalFirstMs`。

`workspacePath` 是 Thebe 的强制工作区授权边界；启动 TUI/服务前必须在配置文件或 `THEBE_WORKSPACE_DIR` 中明确设置，Thebe 不会把进程启动目录自动当成工作区。绝对路径按原值使用；相对路径固定相对于 Thebe 配置目录解析，不随启动位置变化。`read`、`ls`、`find`、`grep` 在配置工作区内不会重复询问，工作区外的读取会要求确认。`AGENT.md`、`AGENTS.md`、`CLAUDE.md` 如果位于工作区内，和其他工作区文件一样可以读取；如果位于工作区外，则按越界读取要求确认。`bash`、`write`、`edit` 仍按权限模式处理。`outputDirectory` 只作为用户明确要求保存生成文档时的默认目录；普通回答直接显示在消息中，不会为了展示答案自动创建文档。

## 自定义目录

可以用环境变量覆盖默认位置：

```bash
export THEBE_CONFIG_DIR=/path/to/thebe-config
export THEBE_AGENT_DIR=/path/to/pi-agent
export THEBE_RUNTIME=dsh
export DEEPSEEK_API_KEY=...
export THEBE_AGENT_STORE_DIR=/path/to/thebe-session-metadata
export THEBE_WORKSPACE_DIR=/path/to/project
export THEBE_OUTPUT_DIR=/path/to/project/.thebe/outputs
```

- `THEBE_RUNTIME` 默认 `dsh`，通过官方 DeepSeek Harness SDK profile 运行。设为 `pi` 使用内嵌 Pi 兼容运行时。其它值会使启动失败。
- `DEEPSEEK_API_KEY` 是默认 `deepseek-official` DSH provider 使用的 API key。
- `THEBE_DSH_PROVIDER` / `THEBE_DSH_MODEL` 设置 DSH provider 和初始模型，默认分别为 `deepseek-official` 与 `deepseek-flash`。
- `THEBE_DSH_MODELS` 是逗号分隔的 DSH 模型列表；未设置 `THEBE_DSH_MODEL` 时第一项为默认值。
- `THEBE_DSH_HOME` 可覆盖每个 Session 的 DSH home 根目录，默认 `$THEBE_AGENT_DIR/dsh-sessions`。
- 运行时选择是进程级的。已有 Session 的 transcript 和协议不会原地迁移；在逐 Session 运行时路由完成前，持久 Session 要继续使用创建它的运行时。
- `THEBE_CONFIG_DIR` 改变 Thebe 配置目录，配置文件将位于 `$THEBE_CONFIG_DIR/config.json`。
- `THEBE_AGENT_DIR` 改变运行时数据目录。Pi 在这里保存 agent 文件，DSH 在各 Session home 下保存状态。
- `THEBE_AGENT_STORE_DIR` 单独改变 Thebe 的会话与 Goal/子代理元数据目录；不存储 Pi transcript。
- `THEBE_WORKSPACE_DIR` 在未设置配置文件 `workspacePath` 时提供 Thebe 文件工具和 TUI 的工作区；两者都未设置时 Thebe 拒绝启动，不会回退到进程启动目录。
- `THEBE_TOOL_RESULT_COMPACTION` 可选，默认关闭。设为 `on` 时，每次调用模型前把模型已经据以回答过的工具结果缩短（本轮约 3000 字符，更早的轮次约 1200 字符，更早轮次的图片会被去掉）；模型最后一条消息之后新到的结果保持完整，会话记录不变。它减小输入，但会改写服务商已经见过的文本，从改写处起丢失提示缓存命中，所以只在输入体积比缓存复用更重要时开启。
- `THEBE_OUTPUT_DIR` 设置用户明确要求保存生成文档时的默认目录；配置文件中的 `outputDirectory` 优先级更高。
- 只设置 `THEBE_CONFIG_DIR` 时，运行时数据目录默认为 `$THEBE_CONFIG_DIR/agent`。
- `THEBE_SESSION_DIR` 设置 Pi 兼容运行时保存会话 transcript 的目录，默认 `~/.thebe/sessions`。容器镜像里它位于 `HOME`（`/data/home`）之下，随 `/data` 卷保留。
- Eval 的 `auto` 不是环境变量，是策略里的接单模式：默认 `observe`，只记录「本来会做什么」，不动手；选了 `auto` 才行动。规则就是授权，没有名单：规则判断「值得」，Core 就生成一张工单（Ticket），交给执行器（能用 Core 的全部家庭运维工具，不带 shell 和文件编辑，怎么做自己规划；它的 reviewer 只拿不改东西的工具）。工单的范围（Mandate）从事件涉及的资源推出，不是模型说了算。写操作逐次判断：落在范围内的服务上、且不是不可逆（`DELETE`、`deleteFiles` 之类，用网关同一个分类器）就直接执行，否则立刻被拒、工单转给你，不会挂起等审批。能改策略的只有 App 和你自己的令牌，`/mcp` 令牌够不到。
- `auto` 有三道保险，用来防止无人值守时失控，不是调优参数，数字也没有实测依据：同一条线程 1 小时内最多接单 3 次（第 4 次只在「观察」页记「本来会接单」，原因 `thread_limit`）；Eval 每小时最多问模型 60 次，超过后每个事件仍记一条 Decision，原因 `assessment_limit`，`THEBE_EVAL_MAX_PER_HOUR` 可改，`0` 不限；重启后只评估 24 小时内的事件。模型不可用、回复无法解析或达到小时上限时，Decision 记为 `unavailable`；同一次故障只推送一次，直到之后有一次成功的 Assessment 才重新允许提示。
- 后台模型工作还有每日预算：输入、输出和 cache-write 计入，cache-read 单独展示但不扣预算；用户自己的聊天不计入。默认每天 1,000,000 tokens，可用 `THEBE_BACKGROUND_TOKEN_BUDGET` 或 `PUT /v1/usage/budget` 调整，`0` 会暂停后台模型工作。告警阈值默认为 50%、80%、90%、100%（`THEBE_BACKGROUND_TOKEN_BUDGET_THRESHOLDS` 可配，支持小数或百分数），达到 50%、80%、90% 时推送预警提醒，达到 100% 耗尽时自动暂停并推送一次，每个阈值每天去重一次；次日 UTC 零点恢复。`GET /v1/usage/summary` 返回当天用量、估算美元成本、阈值状态、暂停状态和最近 30 天；满 15 天后会给出一次「日 p95 的两倍」建议，接受前不会改预算。
- `THEBE_SOURCES` 是 Core 在后台观察的来源（Source）清单，逗号分隔；**默认不设，即什么都不观察、不起任何定时器。** 按 `THEBE_SOURCE_INTERVAL_MS`（默认 30000，不小于 1000）轮询。`container-health` 在容器状态变化时记 `container.went_down`、`container.recovered`、`container.appeared`、`container.removed` 或 `container.state_changed`；运行中的容器从非 `unhealthy` 变为 `unhealthy` 时记 `container.unhealthy`，从 `unhealthy` 变回 `healthy` 时记 `container.recovered`。线程为 `resource:container:<容器名>`。健康状态优先读 Docker Arcane API 的 `Health` 字段，旧引擎则从 `Status` 文本读取。`download-completed` 需要先配置下载引擎；它从非 `completed` 进入 `completed` 时记 `download.completed`，线程为 `resource:download:<engine>:<hash>`。两种 Source 的第一次读取都只建立基线，读取位置会保存，重启不重放；已有旧游标首次升级时只建立健康状态基线，不会把当时已经存在的 `unhealthy` 当新事件；多引擎下载列表只要有一个引擎不可达，本次读取就不推进游标。`GET /v1/health` 会在启用 Source 时返回 `sources`，每个 Source 带 `state`（`starting`、`healthy`、`failing`）、`consecutiveFailures` 和最近的错误；成功读取后连续失败数清零。请求了 `download-completed` 却没有下载 provider 时也会显示为 `failing`，不会静默消失。
- GitHub 与飞书来源（Source）使用同一套轮询、游标持久化、静默、健康检查和 Trigger 去重机制；只有环境变量齐全时才启用，缺一项就不注册、不启定时器。

  ```bash
  # GitHub：一个或多个 owner/name 仓库
  export THEBE_GITHUB_REPOS=unitsung/thebe
  export THEBE_GITHUB_TOKEN=github_pat_...
  export THEBE_GITHUB_AGENT_LOGIN=thebe-agent
  # 可选：THEBE_GITHUB_API_URL、THEBE_GITHUB_ADMIT_UNMENTIONED=1、THEBE_GITHUB_ADMIT_OPENED=0

  # 飞书：一个或多个 chat id（oc_...）
  export THEBE_FEISHU_APP_ID=cli_...
  export THEBE_FEISHU_APP_SECRET=...
  export THEBE_FEISHU_CHATS=oc_...
  # 可选：THEBE_FEISHU_API_URL、THEBE_FEISHU_BOT_OPEN_ID、THEBE_FEISHU_MENTIONS、THEBE_FEISHU_ADMIT_UNMENTIONED=1
  ```

  - GitHub 读取 `GET /repos/{owner}/{repo}/events`（带 ETag），记录 issue/PR 的打开、关闭、重开、评论、review 和 review 评论。每个仓库第一次读取只建立基线。机器人事件和没有 @ 的评论不接单；提到 `THEBE_GITHUB_AGENT_LOGIN` 的评论是明确请求；新打开的 issue/PR 默认按推断处理（`THEBE_GITHUB_ADMIT_OPENED=0` 关闭，`THEBE_GITHUB_ADMIT_UNMENTIONED=1` 接未 @ 评论）。回复以 issue 评论发出，并带隐藏的幂等标记。
  - 飞书按对话轮询 `GET /open-apis/im/v1/messages`。第一次读取以过去 24 小时为基线，之后按 `create_time` 增量读取并用 `message_id` 去重。非用户发送者不接单；单聊或 @ 机器人（`THEBE_FEISHU_BOT_OPEN_ID`，或 `THEBE_FEISHU_MENTIONS` 中的显示名）是明确请求；群里没有 @ 的消息默认不接单，`THEBE_FEISHU_ADMIT_UNMENTIONED=1` 时按推断处理。回复以消息 `uuid` 作为幂等键发回对话。
  - 准入结果随 Trigger 持久化；工单范围（Mandate）和 Core 的审批检查仍是授权边界，来源身份不能扩大范围。
  - 两个适配器目前只有模拟 API 的自动化测试；接入生产账号前，先在测试 Core 上验证凭据和网络。

- `THEBE_MCP_WRITES` 决定经 `/mcp` 连接的 agent 能否调用写工具：`container_restart`、Navidrome 歌单写操作、服务商 MCP 的写工具，以及已配置服务 API 的预览加确认调用。**默认开启。** 设为 `off`（或 `deny`/`false`/`0`/`no`）可让 `/mcp` 变成只读，客户端无法自己改这一项。这条路径上 Core 不会先问任何人。每个工具都带 `readOnlyHint` 和 `destructiveHint`，要不要问用户由调用方 agent 和它的客户端决定。服务商 MCP 的工具只要权限不是 `read` 就算写操作；`read` 只来自你在 `.thebe/mcp.json` 里为该服务器列出的 `readTools`，或服务器级的 `permission: "read"`，服务器自己声明的 `readOnlyHint` 不算。重启会留下普通回执，其审批来源为 `mcp_client`，每次写操作都记入审计日志。
- `THEBE_AUDIT_PATH` 设置只追加的审计日志（JSON 行：方法、参数哈希、结果、耗时；不含参数和输出内容）。默认是 agent store 目录下的 `audit.jsonl`，可由 `GET /v1/audit` 读取。

## OpenList STRM 修复 provider

Core 可以在启动时注册一个 provider-owned `strm_repair` 实现。OpenList 凭据的推荐
位置是下文的 `storage` 段（`thebe storage add openlist ...`）；下面的环境变量仍是
兼容回退。配置完整的 OpenList 地址和 token 后，能力会自动出现在 Core capability
catalog；缺少任一凭据时不会暴露该写能力：

```bash
export THEBE_OPENLIST_BASE_URL=https://openlist.example.com
export THEBE_OPENLIST_TOKEN=your-openlist-token
# With qBittorrent (THEBE_QBITTORRENT_URL/USERNAME/PASSWORD), OpenList and an Emby/Jellyfin API key configured,
# Core exposes the acquisition pipeline tools: download_add/list/status/pause/resume,
# files_list/mkdir/copy/move/rename/remove/upload/offline_download,
# library_scan and library_refresh_item. With THEBE_PROWLARR_URL/THEBE_PROWLARR_API_KEY it also exposes resource_search,
# and pipeline_acquire/advance/status: a deterministic job (download → copy → scan → verify, bounded retries,
# persisted in <agent store>/pipeline-jobs.json). Writes need approval; the system prompt carries the find → download → place → scrape playbook.
# With THEBE_ARIA2_URL (and THEBE_ARIA2_SECRET) aria2 is a second download engine behind the same download_* tools:
# magnets and .torrent links go to qBittorrent, other links to aria2, unless download_add names an engine.
```

`download_pause` / `download_resume` 按 `hashes`（1–20 个下载 id：种子 info-hash，配了 aria2 时也可以是 aria2 的 id；没有"全部暂停"）暂停或恢复
下载，不删除任务和文件，需要审批。qBittorrent 5 使用 `stop`/`start`，4.x 使用 `pause`/`resume`，
Core 自动识别版本。未知 hash 会被拒绝，不会静默成功（qBittorrent 自身会忽略未知 hash）。下载器若不
支持这两个操作，对应工具不会出现。

`download_delete` 同样按 `hashes` 工作（1–20 个，没有"全部删除"），不可撤销，需要审批。`deleteFiles`
必须明确给出 true 或 false：false 只移除任务并保留已下载文件，true 连同磁盘上的文件一起删除；缺省或
非布尔值会被拒绝，不会默认删除。未知 hash 同样会被拒绝。下载器不支持时该工具不会出现。

采集任务可以从种子开始，也可以从网盘转存开始：`pipeline_acquire` 传 `kind: "cloud_transfer"` 和
`transferSource` 时，先由 OpenList 的离线下载取回分享/直链，再走同样的 place → scan → verify。Core 会
自己推进本进程内新建的任务（每分钟一次），所以手机休眠时
也能跑完。Core 重启后恢复出来的任务不会被自动续跑，需要显式调用 `pipeline_advance`；失败的任务不会自动重试。

### 文件存储后端

文件存储配置放在 `~/.thebe/config.json`（或 `$THEBE_CONFIG_DIR/config.json`），
不再依赖一组环境变量。`storage` 段是唯一事实来源：

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

用 CLI 管理；每条命令都原子写入该文件（权限 `0600`），并保留其他配置键：

```bash
thebe storage list
thebe storage add openlist openlist --url https://openlist.example.com --token <token> --default
thebe storage add local media --roots /mnt/media,/mnt/backup
thebe storage add webdav nas --url https://dav.example.com/dav --username user --password secret
thebe storage test media
thebe storage default media
thebe storage remove openlist
```

`thebe storage test` 会列出指定后端（或全部后端）的 `/` 并报告条目数。用已存在的
id 执行 `storage add` 会替换该后端；省略某个密钥则保留已存的值，所以改地址不需要
重新输入 token。WebDAV 可以 `--username` + `--password` 使用 Basic
认证，也可以只用 `--token` 使用 Bearer。

同一套配置通过产品 HTTP API 提供给 Web UI：

- `GET /v1/settings/storage` 返回后端列表、配置路径、来源、默认后端和问题列表；
  密钥会脱敏为 `hasToken`/`hasPassword`。
- `PUT /v1/settings/storage` 替换整个列表；省略密钥时沿用同 id、同类型后端已存的
  密钥。`default: null` 选择第一个后端，省略 `default` 则保留当前默认值。
- `POST /v1/settings/storage/test` 可带 `{ "id": "media" }`，测试单个或全部后端。

配置修改无需重启 Core。每次 `files_*` 工具调用都会重新读取配置，所以运行中的会话
能立即看到新增、修改或删除的后端。采集任务在会话打开时确定默认后端：修改默认值后
请开新会话，已有任务才会使用新的默认后端。

配置多个后端时，每次文件工具调用都要带 `provider` 参数（即后端 `id`），
`files_list` 会返回当前配置的 id；只配置一个时自动使用它。某个后端不支持的操作
不会出现对应工具。

`local` 后端把宿主机目录接入同一套文件工具，适合宿主机已经挂载好的 NFS/SMB 共享
或任意本地路径。根目录必须是绝对路径。传给工具的路径必须解析到这些根目录之内；
`..` 和逃出根目录的符号链接会被拒绝或隐藏。在该后端列出 `/` 时返回的是配置的根
目录本身。Core 容器只能看到宿主机挂载进来的目录，所以要先挂载共享（Docker bind
mount / compose `volumes`），再传容器内路径。

`webdav` 后端使用 PROPFIND、MKCOL、COPY、MOVE、DELETE 和 PUT，发送
`Overwrite: F`，目标已存在时拒绝覆盖。`token` 发送 bearer token；否则
`username` + `password` 发送 Basic 认证。

Core 不内置 SMB/NFS 客户端：在宿主机挂载共享后使用 `local` 后端（如果存储本身由
OpenList 管理，OpenList 自带的 SMB/WebDAV 驱动仍是功能更全的路径）。

`files_remove` 必须明确给出 `recursive` 布尔值，非空目录只有传 `true` 才会删除。
`files_upload` 只读取工作区或输出目录（上限 1 GiB），并拒绝覆盖已存在的目标名。

一个 OpenList 后端（无论来自配置还是环境变量）除了文件工具，还会注册
`strm_repair`、网盘转存和 OpenList 后台任务。这些长生命周期 provider 在 Core
启动时读取 OpenList 地址与 token；`files_*` 工具则始终读取当前配置。修改 OpenList
后端的地址或 token 后，要让采集/转存相关功能生效需重启 Core。

##### 兼容的环境变量

`THEBE_OPENLIST_BASE_URL`/`THEBE_OPENLIST_TOKEN`、`THEBE_FILES_LOCAL_ROOTS`，以及
`THEBE_WEBDAV_URL`/`_USERNAME`/`_PASSWORD`/`_TOKEN` 仍然可用，但只在
`config.json` 没有 `storage` 段时生效。一旦存在该段，环境变量会被忽略——这样删除
后端才是可靠的。想保留现有的环境变量配置，执行一次导入：

```bash
thebe storage import-env
```

环境变量对应的 id 是 `openlist`、`local` 和 `webdav`。`THEBE_OPENLIST_MCP=on`
开启的 OpenList MCP preset 仍读取环境变量；也可以手动执行
`thebe mcp add openlist --url ... --header "Authorization: <token>"`。

`OPENLIST_BASE_URL` 和 `OPENLIST_TOKEN` 也可作为兼容别名。provider 会通过
OpenList 的 `/api/fs/get`、`/api/fs/search` 和 `/api/fs/put` 完成候选查找、STRM
写回与复读验证，候选包括常规媒体文件以及 HLS `.m3u8` / DASH `.mpd` 播放列表；
token 只由 Core adapter 使用，不进入 Agent capability 参数。

OpenList 还自带官方 MCP server。先在 OpenList 自己的配置里开启
`"mcp": { "enable": true }` 并重启，再让 Core 挂载：

```bash
export THEBE_OPENLIST_MCP=on
```

Core 会在 `<THEBE_OPENLIST_BASE_URL>/mcp` 添加一个 deferred 的 `openlist` MCP
server，并把用户 token 原样放进 `Authorization`（OpenList 不接受 `Bearer`
前缀）。预设把 `openlist.fs.list`、`openlist.fs.get` 和 `openlist.fs.link` 声明为
只读工具，因此 `/mcp` 客户端不会把它们当成写操作。该预设默认关闭，因为上面的
原生 adapter 已覆盖同样的读取；`.thebe/mcp.json` 里显式定义的 `openlist`
条目优先于环境变量预设。也可以手动添加：

```bash
thebe mcp add openlist --url https://openlist.example.com/mcp --header "Authorization: <token>"
```

## MCP OAuth 网关

OAuth 默认关闭，只有 `THEBE_OAUTH_ISSUER` 指向授权服务器稳定的公网 origin
时才启用。它用于让支持 OAuth 的 claude.ai / ChatGPT connector 连接 `/mcp`，
不必手工填入 bearer token。

```dotenv
THEBE_MCP_PORT=8788
THEBE_OAUTH_ISSUER=https://thebe.example.com
THEBE_MCP_RESOURCE_URL=https://thebe.example.com/mcp
THEBE_OAUTH_CLIENTS_FILE=oauth-clients.json
THEBE_OAUTH_PAIRING_TTL_SECONDS=300
```

- `THEBE_OAUTH_ISSUER` 必须是带 scheme 的纯 origin，不能带路径。除 loopback
  外必须使用 HTTPS；签名密钥生成后不能再改这个值。
- `THEBE_MCP_RESOURCE_URL` 是 OAuth 唯一允许签发的资源，默认是 issuer 加
  `/mcp`，路径必须正好是 `/mcp`。
- `THEBE_OAUTH_CLIENTS_FILE` 指向预登记 client 文件；相对路径从配置目录解析，
  默认 `$THEBE_CONFIG_DIR/oauth-clients.json`。也可用 `THEBE_OAUTH_CLIENTS`
  直接放同格式的 JSON。
- `THEBE_OAUTH_DYNAMIC_REGISTRATION` 默认关闭。只有 connector 无法使用预登记
  client 时才设为 `true`；若同时设置 `THEBE_OAUTH_REGISTRATION_TOKEN`，
  `/oauth/register` 要求该值作为 initial access token。
- `THEBE_OAUTH_PAIRING_TTL_SECONDS` 默认 300 秒，范围 60–900。

client 文件示例：

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

字段也接受 `client_id`、`client_name`、`client_secret`、`redirect_uris`，并可用
`scope` 代替 `scopes`。redirect URI 必须精确匹配，除 loopback 外必须使用
HTTPS；不设 secret 的 client 是 public client，必须使用 PKCE。默认 scope 是
`mcp:read` 和 `offline_access`；支持 broad 的 `mcp:read`、`mcp:write`、
`mcp:irreversible`，以及预登记 client 可请求的
`mcp:tool:<tool>[:read|write|irreversible]`、
`mcp:service:<service>[:read|write|irreversible]`（省略级别即 read）；另有
`offline_access`。OAuth discovery 仍广播 broad scope，细粒度 scope 必须由 client
配置和授权请求明确列出。

授权页需要一次性配对码。用 App 的完整权限 token 从主 API 端口生成：

```bash
curl -fsS -X POST \
  -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/pairing-code
```

在 `expiresAt` 之前把响应里的 `code` 输入浏览器；每个码只能用一次。只有
`/mcp` scope 的 token 不能调用 pairing API。本地 TUI 也可以运行 `/pair`
（别名 `/oauth`、`/connector`）直接生成一次性码，并显示 issuer、resource 和过期时间。

App 的完整权限 token 可以在主 API 端口查看和吊销 connector grant：

```bash
curl -fsS -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/connections

curl -fsS -X DELETE -H "X-Thebe-Token: $THEBE_TOKEN" \
  http://127.0.0.1:8787/v1/oauth/connections/GRANT_ID
```

列表包含每个 grant 的 client、scope、创建时间、可选过期时间，以及是否持有
refresh token。吊销会立即使相关 access token、refresh token 和尚未兑换的
authorization code 失效，connector 必须重新走授权流程。只有 `/mcp` scope 的
token 调用这两个路由都会得到 `403 token_scope`；公网 MCP 网关不暴露它们。

本地 TUI 可用 `/connections`（别名 `/grants`）查看同一批 grant，并用
`/connections revoke <grantId>` 吊销其中一个。OAuth 网关启用时，
`GET /v1/health` 的 `capabilities` 会包含 `mcp-oauth`。

授权服务器使用 Authorization Code + PKCE、精确 redirect URI 匹配、绑定
`/mcp` 的 Resource Indicators，以及 PS256 JWT access token。access token
有效 15 分钟；带 `offline_access` 和 `prompt=consent` 时签发 30 天轮换的
refresh token，吊销 refresh token 后，相关 access token 在下一次 `/mcp`
请求时立即失效。issuer、签名密钥、授权服务状态、配对码哈希和 grant 都保存在
配置目录，备份时应一起保存。公网监听与反向代理配置见
[DEPLOYMENT.md](DEPLOYMENT.md#412-oauth-for-claudeai-and-chatgpt-connectors)。

## MCP 服务器

外部 MCP 服务器写在 `.thebe/mcp.json`（`mcpServers`，也读全局 `~/.thebe/mcp.json` 和 `.mcp.json`）。Pi 会话由 Pi 自带的 MCP 扩展连接这些服务器。
当前 DSH Adapter 会挂载 Core 自己的 `/mcp`，但还没有把这份逐服务器清单转换成 DSH profile 行。Pi 侧工具名为 `mcp__<server>__<tool>`。

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

- `exposure`：`codemode`（默认，工具只能在 `codemode` 脚本里调用，不占模型的工具声明）、`deferred`（`tool_search` 加载后才声明）、`direct`、`hidden`。
- URL 服务器可带 `headers`（字符串键值），每个请求都会发送，用来接入需要令牌的服务商自带 MCP，例如 `"headers": { "X-Api-Key": "..." }` 或服务专用头 `{"sqmusic":"<JWT>"}`，Core 不用为它新增厂商适配器。有自带 MCP 的服务优先这样接：把 Core 指向它的 MCP，工具就有了。`headers` 保存在 `.thebe/mcp.json`（权限 `600`），不写日志，也只发给配置的 URL。
- `permission`：`read` 以外的服务器每次调用都要审批；不写时，只有 `readTools` 列出的工具按读处理，其余一律审批。服务器自己的 `readOnlyHint` 不作为依据：失陷的服务器可以对写工具谎称只读。
- `readTools`（可选，工具名数组，用服务器自己的原名）：你确认这些工具只读。列出的工具在会话里不再逐个审批，经 `/mcp` 调用时也不被 `THEBE_MCP_WRITES` 或 token 的 `mcp:write` 当作写操作。服务器级 `permission: "read"` 相当于把全部工具都列进来。
- `irreversible`（可选，工具名 → 布尔）：经 `/mcp` 调用时，哪些工具的调用无法撤销。默认只看服务器自己的 `destructiveHint`；你的标注优先：`true` 要求 token 带 `mcp:irreversible`，`false` 把服务器标了 destructive 的工具当普通写。例：`"irreversible": { "delete_movie": true, "clear_cache": false }`。
- 脚本在 Pi 的 QuickJS 沙箱里运行，只能通过工具访问外部；脚本里的每次 MCP 调用同样经过策略、审批、审计和脱敏。`codemode` 的 `models` 全局已关闭。
- stdio 服务器只继承 `HOME`、`PATH` 等基本变量加自己的 `env`，不继承 Core 的环境变量。
- 新添加的服务器默认禁用；启用、禁用、删除走 `/v1/extensions/mcp/servers`，会话在下次 reload 时生效。
- 终端也可以：`thebe mcp add <name> --url <url> --header K=V`（`--header`/`--env`/`--arg` 可重复），再 `thebe mcp enable <name>`；`thebe mcp list`、`thebe mcp tools` 看清单，`thebe mcp remove <name>` 删除 Thebe 自己写入的服务器。
- 不想自建 SearXNG 时，联网搜索接一个搜索 MCP 即可。Parallel 的免密钥端点可这样配：`{"mcpServers": {"parallel": {"url": "https://search.parallel.ai/mcp", "description": "Web search and page fetch", "exposure": "deferred"}}}`，经 `tool_search` 加载后得到 `mcp__parallel__web_search` 和 `mcp__parallel__web_fetch`。搜索词和要读取的网址会发给 Parallel，免费额度有限。2026-10-14 的实测里，给这一项加上 `"permission": "read"` 后工具不再出现在 `tool_search` 里，所以不要加 `permission`；该检查中调用没有弹出审批。
- 哪些服务自带 MCP（目前是 Home Assistant、Grafana、Docker、GitHub、Kubernetes）见 `PROVIDER-MCP.md`；可选的真实连接检查：`THEBE_MCP_LIVE=1 npx vitest run src/adapters/mcp/live.test.ts`。

## Navidrome 音乐 provider

配置完整的 Navidrome 地址、用户名和密码后，Core 会通过 Subsonic API
注册音乐库能力：

```bash
export NAVIDROME_BASE_URL=http://127.0.0.1:4533
export NAVIDROME_USERNAME=thebe
export NAVIDROME_PASSWORD=your-password
# 可选：主地址不可达时用于请求重试，并作为后续播放 URL 的基地址
export NAVIDROME_FALLBACK_URL=https://music.example.com
```

`THEBE_NAVIDROME_BASE_URL`、`THEBE_NAVIDROME_USERNAME`、
`THEBE_NAVIDROME_PASSWORD` 和 `THEBE_NAVIDROME_FALLBACK_URL` 是等价别名。
缺少任一必填变量时不会暴露 Navidrome 能力。可用能力包括最近添加、最近播放、
专辑、歌手、歌单、歌曲、搜索、歌手详情、歌词和播放队列。

`navidrome_queue` 返回统一的歌曲条目，包括直接播放或转码后的流地址、封面、
标题、艺术家、专辑和可选歌词。Core 不负责播放；客户端消费队列后用
自己的播放器、Now Playing 和远程控制实现。歌单创建、更新和删除属于写能力，
只能通过 Agent 会话的运行时审批执行，capability invoke 返回 403；经 `/mcp` 调用时，
只要主机没有设置 `THEBE_MCP_WRITES=off` 就允许。Navidrome 密码只保留在 Core adapter 内，不会进入工具参数或 capability
metadata。

### 推荐 skill 与模型上下文预算

仓库提供 `.thebe/skills/navidrome-recommend/SKILL.md`，用于个性化推荐、场景选歌
和推荐后的播放/歌单追问。将该目录放到配置工作区的 `.thebe/skills/`，或运行
Core 用户的 `~/.thebe/skills/` 下，再通过客户端的 Skills 设置启用
`navidrome-recommend`（HTTP：`PATCH /v1/skills/navidrome-recommend`，正文
`{"enabled":true}`）。容器部署需把 skill 放在挂载的工作区或持久化 HOME 中；
仅将它放在开发仓库里不会使任意工作区或现有部署自动启用。

运行时仅把启用 skill 的名称、描述和路径加入发现信息，正文按需读取。
推荐流程不常驻系统提示词；描述负责触发选歌流程。

Core 会话的 Navidrome 音乐库、搜索和歌手工具返回精简观察：保留所有返回候选
的顺序、名称、ID、专辑/歌手关系及相关音乐信息，移除封面和音频编码等冗余字段。
歌手简介最多 2000 字符，超过时返回 `biographyTruncated:true`。
直接 capability 响应保持完整 schema，队列 URL、歌词和写操作回执保持完整。
这不会截断用户输入，也不会固定缩短会话轮数；历史仍由 runtime 管理和压缩。

## Emby、Jellyfin 与 Immich

配置完整后，Core 注册对应的只读能力。凭据只留在 adapter 内，不进入工具参数。
缺少必填变量时不暴露该服务的检索能力。库列表、最近添加和会话仍按原目录公布。

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

`THEBE_EMBY_*`、`THEBE_JELLYFIN_*` 和 `THEBE_IMMICH_*` 是等价别名。Emby 使用
`X-Emby-Token` 和 `/emby` 前缀。Jellyfin 使用 `Authorization: MediaBrowser Token="…"`，
没有 `/emby` 前缀。检索走用户条目接口：Emby 查询参数用 PascalCase，Jellyfin 用
OpenAPI 的 camelCase。`emby_search` / `jellyfin_search` 按标题、人物或年份返回
条目 id；`emby_item` / `jellyfin_item` 读取简介、类型、年份、题材和演职员。
`communityRating` 是媒体服务器自己的评分。

`immich_search` 调用 `POST /api/search/smart`，按画面内容做语义检索。它不是
文件名、日期或城市过滤；那些条件仍走既有的 metadata 列表。机器学习不可用时
错误保持可见，不当成空库。

仓库提供 `.thebe/skills/library-lookup/SKILL.md` 和
`.thebe/skills/photo-find/SKILL.md`。放到工作区 `.thebe/skills/` 或
`~/.thebe/skills/` 后，在客户端的 Skills 设置里启用 `library-lookup` 与
`photo-find`。只放在开发仓库里不会让任意工作区自动启用。

### 运维类 skill

仓库还提供三个围绕 homelab 运维的 skill，放置和启用方式与上面相同：

- `container-triage`：只读排查容器状态和日志（`container_*`），重启不由模型调用，
  仍走诊断审批流程。需要配置容器 provider（Arcane，或经 docker-socket-proxy 的 Docker Engine API）。
- `download-monitor`：用 `download_*`、`pipeline_status` / `pipeline_advance`、
  `files_list` 查看下载与入库任务进度，定位卡住或失败的环节。
- `media-acquire`：`resource_search` 找片源，由用户选定后用 `pipeline_acquire`
  下载入库；后两者需要配置索引器、下载器、文件管理器和媒体服务器。

对应工具未配置时，skill 会照实报告而不是编造结果。

## 网页搜索与音乐来源

都是可选项，配置前默认关闭。

```bash
# 网页搜索：开启 JSON 输出的 SearXNG 实例
export THEBE_WEB_SEARCH_URL=http://127.0.0.1:8080

# 音乐来源（只读查询；SQMusic 下载需审批）
export THEBE_NETEASE_API_URL=http://127.0.0.1:3000      # NeteaseCloudMusicApi 服务，无需登录
export THEBE_SQMUSIC_URL=http://127.0.0.1:8081
export THEBE_SQMUSIC_USERNAME=thebe
export THEBE_SQMUSIC_PASSWORD=your-password
```

- `THEBE_WEB_SEARCH_URL` 注册 `web_search`（最多 5 条结果，每条 500 字符，附来源链接）。没有公共默认端点：不设置该变量时 Core 不提供 `web_search`。会话可以通过标签 `thebe.webSearch=false` 单独关闭。搜索结果是不可信文本。不想自己跑 SearXNG 时，可以改接搜索类 MCP 服务器（见上文“MCP 服务器”）。
- `THEBE_NETEASE_API_URL` 注册 `netease_music`（搜索、歌词、评论、歌单、榜单）。
- `THEBE_SQMUSIC_URL`、`_USERNAME`、`_PASSWORD` 三项都配置才注册 `sqmusic_search` 和 `sqmusic_download`。下载一次排队一首歌，传 `kind: "album"` 时排队整张专辑（最多 60 首），需要审批；经 `/mcp` 或直接调用 capability 会被 403 拒绝。完整契约见 [Core 产品 HTTP](CORE-PRODUCT-HTTP.md)。
- 内置的 `music_research`（MusicBrainz 和 Wikipedia 查询）无需配置。

## 其他 HTTP 服务（OpenAPI）

按你提供的 OpenAPI 3 或 Swagger 2 文档接入一个 HTTP 服务：

```bash
export THEBE_SERVICE_APIS='[{"id":"my-service","baseURL":"http://192.168.1.10:8080","openapiPath":"/openapi.json","headersEnv":{"X-API-Key":"MY_SERVICE_API_KEY"}}]'
export MY_SERVICE_API_KEY=...
```

发现和读取操作从 OpenAPI 文档加载，写操作需要审批。请求头的值是环境变量名，不会发给模型。

- `resourceKinds`（如 `["container"]`）声明这个服务管哪类资源。Core 自己发现事件后接单（`auto` 模式）时，执行器可以写的服务范围由事件的资源类型反查得到，所以 Arcane、原生 Docker（经受限代理）、Portainer 都是同一份配置，Core 里没有任何一个服务的专用代码。没有连接声明某个类型时，用类型名本身当服务名。执行器的写操作是通用的 `service_write`；不需要 OpenAPI 文档，只要按方法和路径发请求。
- `openapiPath` 相对 `baseURL` 获取。服务不在那里提供文档时，用 `openapiURL` 给出绝对的 `http(s)` 地址（获取文档时不带 API 的认证头，认证头只发给 API 主机）。
- `readOperations` 是运维人员指定的只读白名单（operationId 或 `METHOD /path`）。白名单内的每个读操作会成为独立工具 `service_api.<id>.<operationId>`，有真实的入参 schema，出现在 `/mcp` 和 `/v1/capabilities` 里。其余操作仍走 `service_discover` / `service_write`，写需要运行时审批。需要请求头参数的操作不会这样暴露（请求头由运维人员持有）。
- `readMethods`（如 `["GET","HEAD"]`）把这些方法的操作都当作只读；`trustReadOnlyAnnotations: true` 额外信任文档自带的只读标注。两者默认都**关闭**——远端文档不能自己声明自己只读。
- `irreversibleOperations` / `reversibleOperations`（operationId 或 `METHOD /path`）：你对某个操作能否撤销的标注，经 `/mcp` 调用时优先于 HTTP 方法规则（默认 `DELETE` 和带 `deleteFiles`、`purge` 一类参数的算不可逆）。前者要求 token 带 `mcp:irreversible`，后者放行只删记录的 `DELETE`；两处都列同一操作时按不可逆处理。
- `excludeOperations`（operationId 或 `METHOD /path`）和 `excludeTags` 把操作从发现和命名工具里隐藏，匹配的请求一律拒绝，读、写、已批准的调用都不例外。用于管理类或破坏性接口。
- `writeOperations` 把选定的写操作暴露为两阶段工具：调用本身**不做任何改动**，只返回 `preview`（`method`、`path`、`body`）和一次性 `confirmToken`（5 分钟过期）；`service_confirm` 携带该 token 才会执行刚才预览的那个请求。预览和执行都会审计。模型自己的写路径仍是 `service_write` 加运行时审批。
- `THEBE_OPENLIST_BASE_URL` / `THEBE_OPENLIST_TOKEN` 和 `THEBE_CLOUDSAVER_BASE_URL` / `THEBE_CLOUDSAVER_TOKEN` 是这两个服务的快捷配置，无需写 `THEBE_SERVICE_APIS`。CloudSaver 的 token 以 Bearer 形式发送。
- `node scripts/accept-service-api.mjs` 可以端到端检查已配置的服务（启动 Core、列出逐操作工具、发现操作、调用一个读操作；`--preview` 检查两阶段写）。

## Arcane 容器 provider 与活动来源

Arcane 提供容器能力（`container_list` / `container_inspect` / `container_logs` /
`container_status_summary` / `container_restart` / `container.start`）；配置完整的地址与 API key 后，Core 还会把 Arcane 的
background activity 注册为 Activity 的后台任务来源（`provider=arcane`）：

```bash
export ARCANE_BASE_URL=http://127.0.0.1:3552
export ARCANE_API_KEY=your-arcane-api-key
export ARCANE_ENVIRONMENT_ID=0   # 可选；0 是 Arcane 的本地环境
```

`THEBE_ARCANE_BASE_URL` / `THEBE_ARCANE_API_KEY` / `THEBE_ARCANE_ENVIRONMENT_ID`
是等价别名。Core 同时支持 Arcane 1.x/2.x 与 3.x：读取公开的 `/api/version`，
1.x/2.x 使用 `/api/environments/{id}/...`，3.x 使用 `/api/agents/{id}/...`；
如果代理隐藏了版本接口，则探测 3.x 才有的 `/api/agents`。活动来源读取对应环境的
`activities` 列表（最近 25 条，倒序），映射 `id` / `type` / `name` / 状态与起止时间，
错误文本先脱敏再截断；客户端里的“停止”在 3.x 调用
`activities/{activityId}?action=cancel`，旧版本调用
`activities/{activityId}/cancel`。activity 已结束时 Core 返回 409 与
“already finished” 说明（取消需要 Arcane 版本带活动取消能力，旧版本返回 404）。
缺少凭据时既不暴露容器能力，也不注册该活动来源。

### 不依赖 Arcane 的容器（Docker Engine API 经 docker-socket-proxy）

没有 Arcane 时，Core 可以直接经一个**限权的** `docker-socket-proxy` 访问 Docker
Engine API。已配置 Arcane 时 Arcane 优先：

```bash
export THEBE_DOCKER_PROXY_URL=http://127.0.0.1:2375   # 代理根地址，必须是 http(s) URL
# export THEBE_DOCKER_API_VERSION=v1.43               # 可选；默认不带版本前缀
```

只连这个代理地址，Core 不打开 `docker.sock`，也不接受请求里传来的主机名，并拒绝
重定向。代理只应开放读取端点与 `POST /containers/*/restart`；不要把它发布到公网，
用 loopback 或 Tailscale 访问。读操作映射成同一组 `container_*`；唯一的写
`container_restart` 仍走审批 → 执行 → 验证 → 回执，绝不挂到模型的工具循环里。
`ResourceRef.provider` 增加 `docker` 取值。日志可能是多路复用流（非 TTY）或纯文本
（TTY/代理），Core 会自动解复用并在无法识别时按文本处理。

## 命令风险守卫（homelab / NAS 启发式）

`bash`、`write`、`edit` 的审批前会先过一遍命令风险守卫（`src/agent/security/command-risk.ts`），分四档：

| 风险        | 行为                                                          | 例子                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `critical`  | **策略直接拒绝**（不会进入审批，模型收到 `denied by policy`） | `rm -rf /`、`/volume1` 等 NAS 数据目录批量删除、`zfs destroy`、`zpool destroy`、`mkfs.*`/`mke2fs`、`ntfsclone --overwrite`、`ntfswipe`、`exportfs -ua`、`mdadm --stop/--zero-superblock`、`fdisk`/`parted`、`dd of=/dev/sdX`、fork bomb、`kill -9 1`、`docker run -v /:... --privileged` |
| `dangerous` | 仍需人工审批（审批界面显示高风险）                            | 关机/重启、防火墙清空、`docker rm -f $(ps -aq)`、`docker volume prune -f`、挂载 docker.sock、`ntfsfix`/`ntfsresize`、强制卸载共享存储、停掉 smbd/nfs-server/sshd/docker 服务、写 `/etc/…` 等系统路径、越出工作区写文件或改文件                                                           |
| `caution`   | 允许，记录警号                                                | 重启/停止容器或系统服务、`chmod -R`/`chown -R`、scrub、`exportfs -a`                                                                                                                                                                                                                     |
| `safe`      | 正常执行                                                      | 只读检查类命令（`docker ps`、`zpool status` 等）                                                                                                                                                                                                                                         |

- Docker/Podman 命令另有一层容器守卫（`src/agent/security/docker-command-guard.ts`）：特权容器 + 宿主根挂载、宿主根 bind mount、`--privileged`、docker.sock 挂载、volume prune。
- 存储系统识别：ZFS / Btrfs / EXT4（含 xfs/f2fs）/ NTFS / NFS，判定结果会带在 `storageSystem` 上。
- 工作区越界：写工作区外路径、或 `rm/mv/cp/chmod/chown` 等改动工作区外路径，都会升级为 `dangerous`。
- 直接打 Docker Engine API 的调用（`curl --unix-socket /var/run/docker.sock ... /containers/create`、podman remote）走 `docker-api-guard.ts`：`HostConfig.Privileged=true`、`Binds` 里的宿主根 / `docker.sock`、`CapAdd: SYS_ADMIN|ALL`、`/volumes/prune` 与 `/system/prune` 一律 `critical`（策略拒绝）；`/containers/create` 的 body 解析不出来时降级为 `dangerous`（转人工）而不是放行。
- 这层守卫始终开启；只有 `bypassPermissions`（见下）能为单个会话关掉它。

## 多通道通知

`/v1/notifications/*` 把需要人知道的事件送到 owner 配置的目标；设备 Push（`/v1/devices` 与 Push Relay）仍是并行的另一条通道。

- 设置保存在 `{agentStoreDir}/notifications/notifications.json`（0600），待发送队列保存在同目录的 `outbox.json`。适配器级凭据（bot token、SMTP 密码、企微 corp secret 等）优先来自 `{configDir}/notification-config.json`（0600，TUI `/notifications` 编辑）；未配置时回退到环境变量。地址自身携带的 token（钉钉 access token、webhook URL）保存在 0600 设置文件，读取时会被遮住。
- TUI 的 `/notifications` 逐个通道编辑这些凭据，密钥输入会遮挡；保存后运行中的 Core 会自动重载；未运行的 Core 在下次启动时读取。`/notifications list` 只显示字段是否已配置，不打印密钥；`/notifications path` 显示文件路径。环境变量仍保留给容器和自动化部署作为回退。
- App 的“通知通道 → 通道凭据”通过 `GET/PUT /v1/notifications/config` 编辑同一份文件；读取时密钥字段返回遮罩值，保存时 Core 恢复未修改的密钥。保存后适配器立即重建，不需要重启。
- `NotificationTarget.channel.source` 选择适配器。原生适配器：`webhook`、`slack`、`discord`、`telegram`、`teams`、`googlechat`、`mattermost`、`ntfy`、`bark`、`feishu-webhook`、`dingtalk`、`wecom`、`smtp`、`pushover`、`gotify`、`matrix`、`nextcloud-talk`、`signal`、`whatsapp`、`line`、`zalo`、`twilio`、`bluebubbles`、`synology-chat`、`twitch`、`irc`、`apprise`。已绑定的 Telegram、微信、QQ 或 iMessage 会话也可以作为 `im` transport 的通知目标。声明主动发送能力的通道（目前是 iMessage）直接发送；QQ/微信这类仅回复通道会在窗口内使用最近一条入站消息作为回复锚点，窗口关闭后记为 `window_closed`。现有飞书/GitHub Ticket channel 也可作为 owner target（非 Ticket 通知会作为普通消息/评论发送）。
- `channel.address` 按通道填写：webhook `{url, secret?}`；Slack/Discord/Teams/Google Chat/Mattermost/Synology Chat `{url}`（Mattermost 还接受 `channel?` 覆盖频道）；Telegram `{chatId, threadId?}`；ntfy `{url?, topic?, token?}`；Bark `{deviceKey, server?}`；飞书 `{url?, secret?}`；钉钉 `{url?, accessToken?, secret?}`（URL 可放在目标里）；企业微信群机器人 `{url}`（目标自带或 Core 环境变量）或应用消息 `{toUser}`；邮件 `{to}`；Pushover `{user}`；Gotify `{token, url?}`；Matrix `{roomId}`；Nextcloud Talk `{roomToken}`；Signal `{recipients}`（逗号分隔的电话号码或 `group.*` id）；WhatsApp/Twilio `{to}`；BlueBubbles `{chatGuid}`；LINE `{to}`；Zalo Bot `{chatId}`；Twitch `{broadcasterId}`；IRC `{channel}`；Apprise `{token?}`。
- `GET /v1/notifications/channels` 返回 App 渲染用的通道目录：id、名称、说明、地址字段、capabilities、主机是否已注册该适配器，以及未注册时的 `setup` 提示。App 的“设置 → 通知通道”通过该接口和 settings 接口编辑目标，并可发送测试通知；适配器凭据不落到 App 本地。设备 Push（APNs，经 Push Relay）仍在独立页面。
- 类别：`attention`、`completed`、`failed`、`budget`、`watchdog`、`source_health`、`pipeline`。优先级：`critical`、`normal`、`low`。目标用 `categories` 和 `minPriority` 收窄自己。
- `critical` 默认穿透静默时段；把 `criticalBypassesQuietHours` 设为 `false` 可关闭。普通和低优先级通知在静默窗口结束后才进入队列。`rateLimitPerHour` 是每目标每小时上限（0 表示不限），`critical` 不受限；滚动窗口只在内存中，重启会清零。
- 投递是持久、至少一次、按目标串行的：同一 `id` 重试不会产生第二条；请求已发出但超时（TimeoutError/AbortError）记为 `unknown`，Core 重启后不会重放。连接失败/断连（refused、reset 等）属于可恢复错误，会按退避重试而非记为 `unknown`。
- `GET/PUT /v1/notifications/settings`、`GET /v1/notifications/channels`、`GET /v1/notifications/status`、`POST /v1/notifications/test`、`POST /v1/notifications/send` 都受 Core token 保护；写操作在 quiesce 时返回 503。`GET settings` 会遮住 `secret`、`token`、`password`、`apiKey`、Bark `deviceKey`、Pushover `user` 类字段和 URL 查询串里的凭据。
- `POST /v1/notifications/send` 是 devloop 等外部发送方的入口，接受 `{id?, category, priority, title, body, deepLink?, ticketId?, goalId?}`；省略 `id` 时每次请求生成新 id，需要幂等时请自带稳定 id。它只入队并返回 202，实际投递由 outbox 完成。
- 带 `digest`（`{windowMinutes, categories}`）的目标会把匹配的 `low`/`normal` 通知累积到窗口结束，只发一条摘要；`critical` 永远立即发送。摘要状态持久化在 `digests.json`，重启会保留窗口，并补发 Core 停机期间已结束的窗口。`GET /v1/notifications/status` 用 `digestPending` 报告尚未发出的条数。Goal 通知还会携带 Ticket 记录的 `ChannelRef` 作为事件级 target；它们与 owner targets 合并并按 channel 去重，最终仍由现有 ChannelAdapter 写回。

环境变量：

```bash
# 通用 webhook 不需要环境变量；每个目标在 address 里给 url（可选 secret 做 HMAC-SHA256）
export THEBE_TELEGRAM_BOT_TOKEN=123456:ABC...
export THEBE_WECOM_WEBHOOK_URL='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'
# 或企业微信应用消息（target 使用 {toUser}）
export THEBE_WECOM_CORP_ID=ww...
export THEBE_WECOM_CORP_SECRET=...
export THEBE_WECOM_AGENT_ID=1000002
export THEBE_DINGTALK_WEBHOOK_URL='https://oapi.dingtalk.com/robot/send?access_token=...'
export THEBE_DINGTALK_SECRET=SEC...
export THEBE_SMTP_URL='smtps://smtp.example.com:465'
export THEBE_SMTP_FROM='thebe@example.com'
# 其他原生适配器（均可选）：
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
# 可选，默认 v20.0。
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
# 可选，测试或自建代理；默认 https://bot-api.zaloplatforms.com。
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

没有配置对应凭据的适配器不会注册；指向它的目标会记录 `adapter_missing`，不影响其他目标。测试发送只验证地址和凭据，不进入 outbox。

## IM 双向通道（多平台接缝；内置 Telegram、微信 ClawBot、QQ 和 iMessage）

`/v1/im/*` 是双向聊天接入，和上面的通知出口是两条并列的路径：通知只写出站，IM 适配器还能接收平台消息。入站消息只允许进入 owner 私聊绑定的主 Session（`thebe-main`）；绑定同时固定 owner 的平台 sender id，同一私聊里的其他 sender 会被记录但不会进入模型。群聊和 guest 绑定只记录、不进入模型，也不会获得 shell/文件工具或跳过审批。

- 状态保存在 `{agentStoreDir}/im/im.json`（0600）：账号、绑定、带 bot 身份标记的游标、7 天去重表和未处理入站队列。凭据是一组平台自定义字段，单独保存在同目录的 `im-secrets.json`（0600），任何 HTTP 响应都不返回；日志和错误信息也不包含凭据。
- `POST /v1/im/channels` 接受 `{platform, label?, credentials: {字段: 值}}`。每个平台的 factory 声明必填字段、可选字段和校验规则；`platform` 是注册 id，内置适配器是 `telegram`（Bot Token）、`wechat`（微信 ClawBot / iLink）、`qq`（官方 Bot AppID/AppSecret）和 `imessage`。iMessage 的 `backend: "imsg"` 使用本机已安装的 `imsg`，默认二进制名也是 `imsg`，可用 `cliPath` 和 `dbPath` 指定；`backend: "bluebubbles"` 保留服务器 `baseUrl`/password。Telegram 仍接受旧的 `token` 简写。
- 平台工厂可选提供扫码/链接/验证码登录。`POST /v1/im/logins` 开始一次登录，`GET /v1/im/logins/{id}` 轮询，`POST /v1/im/logins/{id}/code` 在 `need_verifycode` 状态提交手机 PIN，`DELETE /v1/im/logins/{id}` 取消。二维码/链接只在开始响应里返回一次，不写入状态文件或日志；确认后只返回新建的 `accountId`，凭据直接写入 `im-secrets.json`。内置 Telegram 使用 token，不支持登录流程，会返回 `login_not_supported`；微信使用扫码登录。
- 路由：`GET /v1/im/platforms`（已注册平台、凭据字段和是否支持登录）、`GET/POST /v1/im/channels`、`DELETE /v1/im/channels/{id}`、`POST /v1/im/channels/{id}/test`、`POST /v1/im/logins`、`GET/DELETE /v1/im/logins/{id}`、`GET /v1/im/status`、`GET /v1/im/conversations`、`POST /v1/im/bind`、`DELETE /v1/im/bind/{id}`、`POST /v1/im/send`、`POST /v1/im/recall`。写操作在 quiesce 时返回 503。
- 绑定：先让 owner 给 bot 发一条消息，从 `/v1/im/conversations` 拿到 `chat.id`，再 `POST /v1/im/bind`，`chat.kind` 为 `direct`、`role` 为 `owner`。未观察过的 chat 返回 `chat_not_seen`；`senderId` 可省略（固定最后观察到的 sender），显式给出时必须与观察值一致，否则返回 `sender_mismatch`。`sessionId` 目前只能是 `thebe-main`；群聊只能绑为 `guest`，私聊不能绑为 `guest`，群聊也不能绑为 `owner`。
- 入站先持久化再处理；同一 `(platform, account, chat, threadId, messageId)` 或 `updateId` 只处理一次。每个 chat（含 thread）一条串行队列，不同 chat 并行；Core 重启后未处理的入站会继续，已完成的消息不会重放。
- 主 Session 正在处理另一轮时，owner 消息留在队列里而不是丢弃：默认 5 秒后回一条“排队中”，10 分钟后回一条超时提示并结束该条消息；如果主 Session 正在流式输出，消息会以 `followUp` 加入当前轮。`GET /v1/im/status` 的 `pending` 是队列深度。
- 每个适配器会如实报告 capabilities：`proactive`、`replyOnly`、`replyWindowMs`、`maxMessagesPerWindow`、`recall`、`media`、`maxTextLength`、`markdown`、`threads`、`typing`。主动发送前 gateway 会检查 `proactive` 和适配器的 `canSendProactively(chat)`；不支持时返回 `proactive_not_supported`，窗口关闭时返回 `window_closed`。回复锚点（`replyTo`、`contextToken`）只属于当轮，持久目标只有 account + chat + 可选 thread。
- 仅回复通道会在内存中保留最近一条入站回复锚点（消息 id；微信还包括短期 `context_token`）。通知和通道测试只在 capability 窗口内可以使用它；锚点不写入 `im.json`，Core 重启或 quiesce 后丢弃。没有任何入站消息时测试仅回复通道返回 `no_reply_anchor`，窗口关闭后返回 `reply_window_closed`。
- owner 入站可带最多 8 个媒体描述。支持媒体的适配器按平台限额下载；gateway 再限制单文件 2 MB、总计 7 MB，只把 PNG/JPEG/GIF/WebP 和内联文本/JSON 作为 `PromptFile` 交给主 Session，音频、视频和其他文件只向模型说明收到过哪种类型，不执行、不读取其内容。媒体描述和平台 URL/路径只在 owner-only 的待处理队列中保留到该消息处理完成，字节不会写入 `im.json`；绑定或 owner 校验失败时不会触发下载。`POST /v1/im/send` 的 `media` 只接受有界 base64（`kind`、`mediaType`、`data`、可选 `filename`），不接受调用方的本地路径。
- 游标与 bot/账号身份绑定：token 或账号身份变化时旧游标作废，避免把新 bot 从旧 `update_id` 开始轮询。
- Telegram 适配器用 `getUpdates` 长轮询（`allowed_updates: ["message"]`），游标是 `update_id + 1`；支持论坛/话题的 `message_thread_id`。文本不设置 `parse_mode`，按 4096 字符分块并带 `(n/m)` 标记；图片、音频、视频和普通文件通过对应 Bot API 上传，入站媒体通过 `getFile` 下载。429 只暂停该 bot token，409（另一个进程在轮询同一个 bot）进入 `error` 并停止轮询，不会无限重连。
- `GET /v1/health` 只在至少配置了一个通道时报告 `im`。`health.state` 为 `stopped` / `starting` / `connected` / `needs_login` / `error`，可带安全的 `code`、`since`、`retryAt`。一个通道失败不会影响 Core 启动或其他通道；`GET /v1/im/status` 显示每个通道的最新错误（不含凭据）。
- `THEBE_TELEGRAM_BOT_TOKEN` 会自动创建一个 environment 类型的 Telegram 通道（不能通过 API 删除）。`THEBE_TELEGRAM_API_BASE` 可用于自建代理或测试，`THEBE_TELEGRAM_POLL_TIMEOUT` 设置长轮询秒数（1–50，默认 50）。
- 微信适配器使用腾讯官方 ClawBot / iLink 协议：通过 `POST /v1/im/logins` 扫码登录，登录凭据只写入 Core。它是回复型通道，每条发送都带当轮入站的 `context_token`，不会被通知路由器选为主动推送。`THEBE_WECHAT_API_BASE` 可指向自建代理或测试服务，默认 `https://ilinkai.weixin.qq.com`。协议层移植自腾讯 MIT 许可的 Weixin ClawBot 协议层；Core 不运行外部 Agent 运行时。
- QQ 适配器使用官方 QQ Bot OpenAPI v2 的 WebSocket 网关。填写 `AppID`、`AppSecret` 后接收 `C2C_MESSAGE_CREATE` 和 `GROUP_AT_MESSAGE_CREATE`，并用入站的 `msg_id` 加递增的 `msg_seq` 发送被动回复。它刻意只做回复：QQ 的主动推送有限频，且用户可关闭。单聊回复窗口为 60 分钟/4 条，群内 @ 为 5 分钟/5 条；文本按 2000 字符分块。富媒体先上传到官方 `/files`，再用 `msg_type: 7` 发送；单条消息只允许一个媒体。`POST /v1/im/recall` 调用官方 `DELETE /v2/users|groups/.../messages/{message_id}`，平台仍执行 2 分钟、角色和归属限制。`THEBE_QQ_APP_ID`/`THEBE_QQ_APP_SECRET` 可从环境变量预置通道；`THEBE_QQ_API_BASE`、`THEBE_QQ_TOKEN_URL`、`THEBE_QQ_GATEWAY_URL` 可指向代理或测试服务。
- 本地 iMessage 后端在登录 Messages 的 Mac 上执行 `imsg watch --json --since-rowid <rowid>` 和 `imsg send --chat-id <id> ... --json`。游标属于 `cliPath` 和可选 `dbPath`，不同数据库不会互相续传。入站附件只允许来自 `~/Library/Messages/Attachments`；出站媒体写入 0600 临时文件，`imsg` 退出后立即删除。它需要 Messages 自动化和 Full Disk Access。BlueBubbles 后端仍轮询 REST API；Mac 离线时发送交给 outbox 重试。`THEBE_IMESSAGE_BASE_URL`/`THEBE_IMESSAGE_PASSWORD`（或已有的 `THEBE_BLUEBUBBLES_URL`/`THEBE_BLUEBUBBLES_PASSWORD`）预置 BlueBubbles；`THEBE_IMSG_PATH` 提供本机 `imsg` 默认路径，`THEBE_IMSG_DB_PATH` 可指定非默认 `chat.db`，`THEBE_IMESSAGE_BACKEND=imsg|bluebubbles` 选择默认后端。

本地 watcher 同时传 `--attachments`。`imsg` 子进程只继承清理后的基础环境，不继承 Core token、模型密钥或其它凭据。媒体下载按有界流读取，不信任远端 `Content-Length`；gateway 的总量上限保持在 HTTP 10 MB body 限制之内。

```bash
# 只用环境变量接一个 Telegram 双向通道；同一个 bot token 也可以继续作为通知 target
export THEBE_TELEGRAM_BOT_TOKEN=123456:ABC...
# 可选：自建 Bot API 代理，或测试用假服务
export THEBE_TELEGRAM_API_BASE='https://api.telegram.org'
# 可选：自建微信 iLink 代理或测试服务
export THEBE_WECHAT_API_BASE='https://ilinkai.weixin.qq.com'
# 从环境变量接一个 QQ 双向通道
export THEBE_QQ_APP_ID=102030
export THEBE_QQ_APP_SECRET=...
# 从环境变量接一个 iMessage（BlueBubbles）通道；同一个服务器也可作为通知 target
export THEBE_IMESSAGE_BASE_URL='https://bluebubbles.example'
export THEBE_IMESSAGE_PASSWORD=...
```

## 权限模式

一个设置决定会话不问就能做多少。名字沿用 Claude Code。

| 模式                | 不问就执行                                                          | 仍会询问或拒绝                                                                |
| ------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `plan`              | 工作区内的读取                                                      | 一切会改动东西的操作都拒绝                                                    |
| `default`           | 工作区内的读取                                                      | `bash`、`write`、`edit`、记忆写入和各服务的写工具，每次都问                   |
| `acceptEdits`       | 工作区内的 `write`/`edit`（不含 `.git`），以及有沙箱隔离时的 `bash` | 命令守卫标出的、工作区外的路径、没有沙箱时的 `bash`、`memory`、MCP 与服务写入 |
| `bypassPermissions` | 一切；命令守卫和沙箱都关闭                                          | 无。在 TUI 或图形客户端里打开，并先确认                                       |

`acceptEdits` 照 Codex 的“按需询问 + 受限沙箱”：能让命令不问就执行的是沙箱，而不是一张“安全命令”清单，
所以没有沙箱时命令照常询问。有沙箱时，`tree-sitter-bash` 读不懂的脚本、或含有强制 `rm`（照 Codex 的检查，穿过 `sudo`、`env`、`trap`、`bash -c` 也能找到）的脚本，同样会询问。`.git` 与 Codex 的工作区可写沙箱一样保持只读。

- 宿主默认值来自 `config.json` 的 `permissionMode`（默认 `manual`）。单个会话用 `PUT /v1/session/{id}/permissions`（`{"mode": "plan"}`；`{"mode": null}` 回到宿主默认值）设自己的模式，同一路径的 `GET` 返回它当前所处的模式。
- 子代理、定时任务、后台目标、`/mcp` 调用方和非交互轮次取宿主默认值，不取会话自己设的模式。
- 记住的拒绝、脱敏和审计在所有模式下都生效。除 `bypassPermissions` 外，`critical` 命令在所有模式下都被拒绝。
- `POST /v1/session/{id}/full-access` 带 `{"enabled": true|false}` 仍可用，等于开关 `bypassPermissions`。

### `bypassPermissions`

按会话生效，也可以写成宿主默认。为一个会话同时关闭命令守卫、操作系统沙箱和工具审批，脱敏与审计照旧。

不需要环境变量。`THEBE_FULL_ACCESS` 忽略，等同未设置：它不会让进程以 bypass 启动。在 TUI 的 `/permissions` 或设置菜单里选它，或在图形客户端的 Agent 设置里选它，都会先确认。确认后的宿主默认会保存到 `config.json`，定时任务、子代理、后台目标和 `/mcp` 用的是宿主默认，不继承某个会话自己开的 bypass。

模型会读到不可信内容（网页、工具输出、外部 MCP），该模式下一条误判的命令可能损坏宿主数据，只在需要时开启。完全访问在下一条命令生效，不必新开会话。

## 命令沙箱

模型工具和 Core 进程不是同一层边界。沙箱由 `THEBE_RUNTIME` 选择。

- **容器部署**（发布形态）：检测到 `/.dockerenv` 或 `/run/.containerenv` 就不启动嵌套的宿主沙箱。不要设置 `THEBE_SANDBOX`，也不要在容器里再套 bubblewrap 或虚拟机。DSH 仍通过 Core permission handler 逐次询问。
- **Pi 兼容宿主运行时**：`THEBE_RUNTIME=pi` 使用钉死的 `@anthropic-ai/sandbox-runtime`（Seatbelt / bubblewrap）。TUI 设置和图形客户端可关闭宿主默认沙箱，关闭前会确认；`THEBE_SANDBOX=off` 和容器部署会强制关闭。完全访问同样会拿掉沙箱。
- **默认 DSH 宿主运行时**：DeepSeek Harness 自己提供文件沙箱，通常为 `workspace-write`，Core 把 DSH 的审批请求交给 Core permission handler。DSH 当前的 sandbox 词汇只覆盖文件效果；Core 的宿主网络 allowlist 和 Seatbelt/bubblewrap wrapper 只覆盖 Pi，不覆盖 DSH 原生工具。DSH 宿主网络隔离仍是待补齐边界。
- DSH 审批请求只带工具名，不带参数。Core 能等待人的批准，但参数级 `CommandRisk` 规则无法检查 DSH 原生 shell 命令。应保留 `manual` 并依赖 DSH 文件沙箱；带参数的审批已列为 SDK parity 缺口。

`os`、`auto`、`vm`、`gondolin`、`bwrap`、`docker`、`seatbelt` 以及任何其它值都当作没设置：宿主仍用 OS 沙箱，容器里仍关闭。不再映射，也不再因此启动失败。

策略写死，不是环境变量：

- 写：工作区和临时目录。
- 读：默认放开，拒绝 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.thebe`。
- 网络：允许名单，默认空，跟 Claude Code 一样。沙箱里的 `bash` 第一次访问某个域名会问你。允许一次只对这条命令有效；记住之后写入 `config.json` 的 `sandboxAllowedDomains`，以后不再问。拒绝并记住写入 `sandboxDeniedDomains`。同时有两条沙箱命令时无法判断是哪一条，这次访问直接拒绝。`web_search` 不走这份名单。bypass 不进沙箱，网络全开。

Pi 沙箱依赖没装齐时命令会被拒绝，不会退回去直接执行。Linux 需要 bubblewrap、socat 和 ripgrep；macOS 用系统的 `sandbox-exec`，钉死的 runtime 不需要 ripgrep。`thebe doctor` 在这种情况下退出码为 1。`GET /v1/system/isolation` 的 `sandbox.mode` 为 `off`、`os` 或 `dsh`。`dsh` 由 runtime 自身管理，Core 不探测其内部后端，并会在报告中明确提示网络覆盖缺口。

命令守卫、工作区约束和 Docker API 守卫（特权容器、宿主根与 `docker.sock` 挂载、volume prune）始终开启，没有开关。
