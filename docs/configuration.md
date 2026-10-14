# Thebe 配置指南

[English](configuration.en.md) | 简体中文

## 配置文件位置

Thebe 的用户配置文件默认位于：

```text
~/.thebe/config.json
```

Pi Adapter 使用的 agent 文件默认位于：

```text
~/.thebe/agent/
```

该目录包含 `models.json`、`auth.json` 等由 Pi Adapter 管理的文件。Thebe 的界面和 Agent 设置应写入 `config.json`，不要直接混入 Pi agent 文件。

部署与运维请看 `docs/DEPLOYMENT.md`：容器部署形态、生产环境变量、HTTPS/Tailscale、进程隔离边界、健康检查与优雅退出、升级/回滚、备份/恢复、发布冒烟测试与 CI 发布门禁。

## 在 TUI 中管理配置

- `/config`：使用外部编辑器打开 `config.json`。文件不存在时会安全创建。编辑器退出后，Thebe 恢复 TUI 并重新绘制界面。
- `/config path`：显示 Thebe 配置文件、Pi agent 目录、工作区和文档输出目录的实际路径。
- `/settings`：在 TUI 内修改常用设置。

手动修改后，需要重新启动 Thebe 才能确保所有设置生效。

Serve 也提供 `GET/PATCH /v1/settings/agent`。它返回运行中的有效
Agent 设置以及每个字段的来源（`configured`、`default`、`environment` 或
`derived`）。HTTP 只允许修改 `autoCompact`、`autoSummary` 和
`autoSummaryDelayMs`；摘要延迟会限制在 60 秒到 15 分钟。并发上限、工作区
和输出目录属于启动或授权边界：并发修改返回 `409 restart_required`，路径只读。
权限模式继续使用 `GET/PATCH /v1/settings/permissions`，两类设置都会写入
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
  "permissionMode": "ask",
  "maxSubagentConcurrency": 3,
  "maxSubagentsPerParent": 2,
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

`permissionMode` 可选 `ask`、`read-only` 或 `full-access`。`ask` 会在 `bash`、`write`、`edit` 等 approval-gated tools 执行前询问；`read-only` 拒绝这些工具；`full-access` 会自动允许这些工具，只跳过应用层确认，不提供操作系统级沙箱。运行中也可以使用 `/permissions ask`、`/permissions read-only`、`/permissions full-access` 或设置菜单修改。

`maxSubagentConcurrency` 和 `maxSubagentsPerParent` 分别控制全局 child 并发数和单个父会话的并发数；它们只限制一次性 in-memory subagent，不影响普通会话。数值会被限制在 1–16，单个 profile 的 `maxTurns` 另行限制在 1–50。

`workspacePath` 是 Thebe 的强制工作区授权边界；启动 TUI/服务前必须在配置文件或 `THEBE_WORKSPACE_DIR` 中明确设置，Thebe 不会把进程启动目录自动当成工作区。绝对路径按原值使用；相对路径固定相对于 Thebe 配置目录解析，不随启动位置变化。`read`、`ls`、`find`、`grep` 在配置工作区内不会重复询问，工作区外的读取会要求确认。`AGENT.md`、`AGENTS.md`、`CLAUDE.md` 如果位于工作区内，和其他工作区文件一样可以读取；如果位于工作区外，则按越界读取要求确认。`bash`、`write`、`edit` 仍按权限模式处理。`outputDirectory` 只作为用户明确要求保存生成文档时的默认目录；普通回答直接显示在消息中，不会为了展示答案自动创建文档。

## 自定义目录

可以用环境变量覆盖默认位置：

```bash
export THEBE_CONFIG_DIR=/path/to/thebe-config
export THEBE_AGENT_DIR=/path/to/pi-agent
export THEBE_AGENT_STORE_DIR=/path/to/thebe-session-metadata
export THEBE_WORKSPACE_DIR=/path/to/project
export THEBE_OUTPUT_DIR=/path/to/project/.thebe/outputs
```

- `THEBE_CONFIG_DIR` 改变 Thebe 配置目录，配置文件将位于 `$THEBE_CONFIG_DIR/config.json`。
- `THEBE_AGENT_DIR` 单独改变 Pi agent 文件目录。
- `THEBE_AGENT_STORE_DIR` 单独改变 Thebe 的会话与 Goal/子代理元数据目录；不存储 Pi transcript。
- `THEBE_WORKSPACE_DIR` 在未设置配置文件 `workspacePath` 时提供 Thebe 文件工具和 TUI 的工作区；两者都未设置时 Thebe 拒绝启动，不会回退到进程启动目录。
- `THEBE_MODEL_RESULT_LIMIT` 可选，默认关闭。设为正整数（最小 `2000`）时，限制单次自定义工具结果进入模型上下文的字符数：JSON 保留靠前条目并标明省略数量，日志和纯文本保留末尾。未设置（或 `off` / `0`）时按工具原样发送，与 Pi agent 行为一致。只影响给模型的文本，capability 与 MCP 调用方仍拿完整结果，Pi 内置工具（`read`、`bash` 等）不受影响。
- `THEBE_TOOL_RESULT_COMPACTION` 可选，默认关闭。设为 `on` 时，每次调用模型前把模型已经据以回答过的工具结果缩短（本轮约 3000 字符，更早的轮次约 1200 字符，更早轮次的图片会被去掉）；模型最后一条消息之后新到的结果保持完整，会话记录不变。它减小输入，但会改写服务商已经见过的文本，从改写处起丢失提示缓存命中，所以只在输入体积比缓存复用更重要时开启。
- `THEBE_OUTPUT_DIR` 设置用户明确要求保存生成文档时的默认目录；配置文件中的 `outputDirectory` 优先级更高。
- 只设置 `THEBE_CONFIG_DIR` 时，Pi agent 目录默认为 `$THEBE_CONFIG_DIR/agent`。

## OpenList STRM 修复 provider

Core 可以在启动时注册一个 provider-owned `strm.repair` 实现。配置完整的
OpenList 地址和 token 后，能力会自动出现在 Core capability catalog；缺少任一
变量时不会暴露该写能力：

```bash
export THEBE_OPENLIST_BASE_URL=https://openlist.example.com
export THEBE_OPENLIST_TOKEN=your-openlist-token
# With qBittorrent (THEBE_QBITTORRENT_URL/USERNAME/PASSWORD), OpenList and an Emby/Jellyfin API key configured,
# Core exposes the acquisition pipeline tools: download.add/list/status/pause/resume, files.list/mkdir/copy/move/offline_download,
# library.scan and library.refresh_item. With THEBE_PROWLARR_URL/THEBE_PROWLARR_API_KEY it also exposes resource.search,
# and pipeline.acquire/advance/status: a deterministic job (download → copy → scan → verify, bounded retries,
# persisted in <agent store>/pipeline-jobs.json). Writes need approval; the system prompt carries the find → download → place → scrape playbook.
```

`download.pause` / `download.resume` 按 `hashes`（1–20 个 info-hash，没有"全部暂停"）暂停或恢复
下载，不删除任务和文件，需要审批。qBittorrent 5 使用 `stop`/`start`，4.x 使用 `pause`/`resume`，
Core 自动识别版本。未知 hash 会被拒绝，不会静默成功（qBittorrent 自身会忽略未知 hash）。下载器若不
支持这两个操作，对应工具不会出现。

`download.delete` 同样按 `hashes` 工作（1–20 个，没有"全部删除"），不可撤销，需要审批。`deleteFiles`
必须明确给出 true 或 false：false 只移除任务并保留已下载文件，true 连同磁盘上的文件一起删除；缺省或
非布尔值会被拒绝，不会默认删除。未知 hash 同样会被拒绝。下载器不支持时该工具不会出现。

采集任务可以从种子开始，也可以从网盘转存开始：`pipeline.acquire` 传 `kind: "cloud_transfer"` 和
`transferSource` 时，先由 OpenList 的离线下载取回分享/直链，再走同样的 place → scan → verify。Core 会
自己推进本进程内新建的任务（`THEBE_PIPELINE_ADVANCE_MS`，默认 `60000` 毫秒；`0` 关闭），所以手机休眠时
也能跑完。Core 重启后恢复出来的任务不会被自动续跑，需要显式调用 `pipeline.advance`；失败的任务不会自动重试。

`OPENLIST_BASE_URL` 和 `OPENLIST_TOKEN` 也可作为兼容别名。provider 会通过
OpenList 的 `/api/fs/get`、`/api/fs/search` 和 `/api/fs/put` 完成候选查找、STRM
写回与复读验证，候选包括常规媒体文件以及 HLS `.m3u8` / DASH `.mpd` 播放列表；
token 只由 Core adapter 使用，不进入 Agent capability 参数。

## MCP 服务器

外部 MCP 服务器写在 `.thebe/mcp.json`（`mcpServers`，也读全局 `~/.thebe/mcp.json` 和 `.mcp.json`）。模型会话由 Pi 自带的 MCP 扩展
连接这些服务器，Core 不自己维护 MCP 连接；工具名为 `mcp__<server>__<tool>`。

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
- `permission`：`read` 以外的服务器每次调用都要审批；不写则按工具自己的 `readOnlyHint` 判断，没有声明就审批。
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

`navidrome.queue` 返回统一的歌曲条目，包括直接播放或转码后的流地址、封面、
标题、艺术家、专辑和可选歌词。Core 不启动 iOS 播放器；App 消费队列后继续使用
自己的 MPV、Now Playing 和远程控制实现。歌单创建、更新和删除属于写能力，
只能通过 Agent 会话的运行时审批执行，直接调用 MCP 或 capability invoke 返回
403。Navidrome 密码只保留在 Core adapter 内，不会进入工具参数或 capability
metadata。

### 推荐 skill 与模型上下文预算

仓库提供 `.thebe/skills/navidrome-recommend/SKILL.md`，用于个性化推荐、场景选歌
和推荐后的播放/歌单追问。将该目录放到配置工作区的 `.thebe/skills/`，或运行
Core 用户的 `~/.thebe/skills/` 下，再通过 App 的 Skills 设置启用
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
OpenAPI 的 camelCase。`emby.search` / `jellyfin.search` 按标题、人物或年份返回
条目 id；`emby.item` / `jellyfin.item` 读取简介、类型、年份、题材和演职员。
`communityRating` 是媒体服务器自己的评分。

`immich.search` 调用 `POST /api/search/smart`，按画面内容做语义检索。它不是
文件名、日期或城市过滤；那些条件仍走既有的 metadata 列表。机器学习不可用时
错误保持可见，不当成空库。

仓库提供 `.thebe/skills/library-lookup/SKILL.md` 和
`.thebe/skills/photo-find/SKILL.md`。放到工作区 `.thebe/skills/` 或
`~/.thebe/skills/` 后，在 App 的 Skills 设置里启用 `library-lookup` 与
`photo-find`。只放在开发仓库里不会让任意工作区自动启用。App 直连路由内置同一份
说明，并把 Core 工具名改写成本机工具名。

### 运维类 skill

仓库还提供三个围绕 homelab 运维的 skill，放置和启用方式与上面相同：

- `container-triage`：只读排查容器状态和日志（`container.*`），重启不由模型调用，
  仍走诊断审批流程。需要配置容器 provider（Arcane，或经 docker-socket-proxy 的 Docker Engine API）。
- `download-monitor`：用 `download.*`、`pipeline.status` / `pipeline.advance`、
  `files.list` 查看下载与入库任务进度，定位卡住或失败的环节。
- `media-acquire`：`resource.search` 找片源，由用户选定后用 `pipeline.acquire`
  下载入库；后两者需要配置索引器、下载器、文件管理器和媒体服务器。

对应工具未配置时，skill 会照实报告而不是编造结果。

## Arcane 容器 provider 与活动来源

Arcane 提供容器能力（`container.list` / `container.inspect` / `container.logs` /
`container.status_summary` / `container.restart` / `container.start`）；配置完整的地址与 API key 后，Core 还会把 Arcane 的
background activity 注册为 Activity 的后台任务来源（`provider=arcane`）：

```bash
export ARCANE_BASE_URL=http://127.0.0.1:3552
export ARCANE_API_KEY=your-arcane-api-key
export ARCANE_ENVIRONMENT_ID=0   # 可选；0 是 Arcane 的本地环境
```

`THEBE_ARCANE_BASE_URL` / `THEBE_ARCANE_API_KEY` / `THEBE_ARCANE_ENVIRONMENT_ID`
是等价别名。活动来源读取 `/api/environments/{id}/activities`（最近 25 条，倒序），
映射 `id` / `type` / `name` / 状态与起止时间，错误文本先脱敏再截断；App 上的“停止”
调用 `/api/environments/{id}/activities/{activityId}/cancel`，activity 已结束时
Core 返回 409 与 “already finished” 说明（取消需要 Arcane 版本带活动取消能力，
旧版本返回 404）。缺少凭据时既不暴露容器能力，也不注册该活动来源。

### 不依赖 Arcane 的容器（Docker Engine API 经 docker-socket-proxy）

没有 Arcane 时，Core 可以直接经一个**限权的** `docker-socket-proxy` 访问 Docker
Engine API（ADR 0003）。已配置 Arcane 时 Arcane 优先：

```bash
export THEBE_DOCKER_PROXY_URL=http://127.0.0.1:2375   # 代理根地址，必须是 http(s) URL
# export THEBE_DOCKER_API_VERSION=v1.43               # 可选；默认不带版本前缀
```

只连这个代理地址，Core 不打开 `docker.sock`，也不接受请求里传来的主机名，并拒绝
重定向。代理只应开放读取端点与 `POST /containers/*/restart`；不要把它发布到公网，
用 loopback 或 Tailscale 访问。读操作映射成同一组 `container.*`；唯一的写
`container.restart` 仍走审批 → 执行 → 验证 → 回执，绝不挂到模型的工具循环里。
`ResourceRef.provider` 增加 `docker` 取值。日志可能是多路复用流（非 TTY）或纯文本
（TTY/代理），Core 会自动解复用并在无法识别时按文本处理。

## 命令风险守卫（homelab / NAS 启发式）

`bash`、`write`、`edit` 的审批前会先过一遍命令风险守卫（`src/agent/security/command-risk.ts`，
规则表来自重构前的 `src/policy/safety-evaluator.ts`），分四档：

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
- `THEBE_COMMAND_GUARD=off` 完全关闭这层守卫，恢复“一切靠审批”。
- 小模型安全复核不复用这里的启发式：它是 `Judgment Model`（见下节，默认关闭）。

## 命令沙箱（bubblewrap）

`THEBE_SANDBOX=bwrap` 会把 `bash` 工具包进 bubblewrap 命名空间（`src/agent/security/command-sandbox.ts`，
移植自重构前的 `src/sandbox/bwrap.ts` + `runner.ts`）：

- 宿主根只读（`--ro-bind / /`）、`/tmp` 用 tmpfs（退出即丢）、`/dev`、`/proc` 重新挂载；
- **只有工作区可写**（`--bind <workspace> <workspace>` + `--chdir`）；
- `--unshare-all` 隔离 PID/IPC/UTS/user 命名空间，`--cap-drop ALL` 去能力，`--die-with-parent` 防僵尸；
- 网络默认保留，`THEBE_SANDBOX_NETWORK=deny` 加 `--unshare-net` 断网。

默认关闭；开启但宿主没有 `bwrap`（例如 macOS、普通容器）时会退回不加沙箱执行，并记录 warning。
推荐组合（NAS 严格模式）：`THEBE_SANDBOX=bwrap` + `THEBE_SANDBOX_NETWORK=deny` + 保持 `THEBE_COMMAND_GUARD` 默认开启。

### 其它后端（docker / seatbelt）

同一层还提供两种宿主无关/开发机可用的后端（`wrapCommandForSandbox` 按 `THEBE_SANDBOX` 分派）：

- `THEBE_SANDBOX=docker`：一次性容器执行——`--rm --read-only --tmpfs /tmp`、
  `--cap-drop ALL --security-opt no-new-privileges`、默认 `--network none`、只把工作区
  `-v ws:ws:rw` 挂进去，镜像用 `THEBE_SANDBOX_IMAGE`（默认 `alpine:3`）。
  适合有 Docker 守护进程的 NAS/宿主；没有守护进程时退回本地执行并记录 warning。
- `THEBE_SANDBOX=seatbelt`：macOS 开发机用 `sandbox-exec` + 生成的 profile（路径按 `realpath`
  规范化，兼容 `/var/folders` → `/private/var/folders`）；写只允许工作区与 `TMPDIR`，
  默认拒绝网络。有真实进程级测试（越界写入被拒 + 断网被拒），`npm test` 覆盖。
- `sandboxAvailability()` 可以自检当前宿主能跑哪些后端（`off/bwrap/docker/seatbelt/gondolin`）。

### 微虚拟机沙箱（gondolin，已实测可用）

`THEBE_SANDBOX=gondolin` 走硬件虚拟化隔离：`src/adapters/gondolin/runner.ts` 用一个一次性的
Gondolin micro-VM（QEMU 后端）执行 bash，宿主工作区通过 `RealFSProvider` 挂到 guest 的
`/workspace`（命令默认在该目录执行，越出工作区的路径会直接抛错），HTTP 出口由
`createHttpHooks` 中介（`THEBE_SANDBOX_NETWORK=deny` → 空白名单＝断网）。
`bash-operations.ts` 把它接成 `bash` 工具的执行后端，VM 随会话创建/销毁，`dispose()` 回收。

安装（已验证的步骤）：

```bash
# 1) 包本体（Core 已把它列为 optionalDependency，可跳过）
npm install @earendil-works/gondolin@0.13.0
# 2) VM 后端：QEMU（macOS）
brew install qemu                     # Linux: sudo apt install qemu-system-arm
# 3) 首次启动自动下载 guest 镜像（约 200MB），缓存在 ~/.cache/gondolin/images/
THEBE_SANDBOX=gondolin THEBE_SANDBOX_NETWORK=deny thebe
```

- `GONDOLIN_DEFAULT_IMAGE` 选择 guest 镜像（默认 `alpine-base:latest`），`GondolinRunnerOptions.image`
  会写进该环境变量；`timeoutMs` 映射为启动超时。
- 缺包或缺 QEMU 时初始化报明确错误（含修复命令），**不会**静默退回本地执行。
- 实测：`THEBE_GONDOLIN_IT=1 npx vitest run src/adapters/gondolin` 会真的起 VM 跑命令
  （guest `uname` 返回 Alpine 内核、宿主机 `/workspace` 文件可读写、guest 看不到宿主根目录）；
  `pi-session.test.ts` 也在 `THEBE_SANDBOX=gondolin` 下验证了 bash 工具确实走 VM。

## 部署情景（Scenario Profile）

`src/agent/security/scenario-profile.ts`（移植自重构前的 `src/policy/scenario-profile.ts`）把多层开关打包成情景：

| 情景              | 命令守卫 | 工作区越界 | 沙箱              | Docker 守卫                   |
| ----------------- | -------- | ---------- | ----------------- | ----------------------------- |
| `nas-strict`      | 开       | 禁止       | `bwrap`           | 全开（含 volume prune）       |
| `homelab-host`    | 开       | 允许       | 关                | 只挡宿主根挂载 + volume prune |
| `microvm-sandbox` | 开       | 禁止       | `gondolin` + 断网 | 全开                          |
| `yolo-guarded`    | 开       | 禁止       | `bwrap`           | 全开                          |

```bash
export THEBE_SCENARIO=nas-strict   # 等价于照抄上表
```

- 显式 `THEBE_*` 永远覆盖情景取值（`THEBE_SANDBOX=off` 可以只推翻沙箱这一项）；
- 不设 `THEBE_SCENARIO` 时保留原有默认（守卫开、沙箱关、联网、禁止越界）；
- `THEBE_ALLOW_WORKSPACE_ESCAPES=true` 单独放开工作区越界（`homelab-host` 情景的取值）；
- 情景只是预设，不是第二套安全引擎：判定仍由命令守卫 / 沙箱 / Docker 守卫各自完成。

## 全放开预设（默认关闭）

全放开预设是一个**由 Core 所在机器的配置门控、按会话生效**的开关：对某一个会话同时关闭命令守卫、关闭沙箱、并跳过工具审批，但工作区边界、脱敏与审计照旧。它不是 `/v1/settings/permissions` 里的 `full-access` 权限模式（那个只跳过应用层确认、且是全局的，也不是操作系统沙箱）。

```bash
export THEBE_FULL_ACCESS=on   # 允许本机启用该预设；默认关闭
```

只有设置了它的宿主才能启用；HTTP/App 客户端不能自己给自己开。`GET /v1/settings/full-access` 返回 `{ "allowed": … }`；`POST /v1/session/{id}/full-access` 带 `{ "enabled": true|false }` 只切换一个会话（宿主未允许时返回 403 `full_access_not_allowed`）。会话元数据在生效期间带 `fullAccess`，供客户端显示标识。

范围与边界：

- 只对启用的那个会话生效。新会话、子代理、定时任务、后台目标、`/mcp` 调用方、非交互轮次都不继承。
- 命令守卫在权限预检里跳过，沙箱模式在每次命令时读取，因此会话中途启用也在下一条命令生效；Gondolin 微虚拟机后端在会话打开时选定，用该后端时需在启用后新开会话。
- 显式记住的拒绝和工作区边界仍然生效，审计记录照常写入。
- 模型会读到不可信内容（网页、工具输出、外部 MCP）。该模式下一条误判的命令可能损坏宿主数据，只在需要时短时开启。

## Judgment Model（默认关闭）

Judgment Model 不是聊天模型服务商，也不绑死在诊断上。默认所有 Site 走各自的传统路径。

```bash
export THEBE_JUDGMENT_MODEL=off
```

要启用第一款 Adapter（Jev）时：

```bash
export THEBE_JUDGMENT_MODEL=jev
export THEBE_TYPESAFE_API_KEY=...
# optional: which Sites may call it. Default all catalog Sites.
# export THEBE_JUDGMENT_SITES=all
# export THEBE_JUDGMENT_SITES=home.attention,intent.capability
# export THEBE_JUDGMENT_SITES=none
export THEBE_TYPESAFE_BASE_URL=https://api.typesafe.ai/v1/systemone
export THEBE_JEV_MODEL=jev-latest
```

未设置、值不是 `jev`、缺少 API key、Site 未启用、或调用失败时，该 Site 回退传统路径。打开后会把该 Site 的 `state` 发到 TypeSafe。这一刀没有 App Settings 开关。

配置文件可能包含 provider 地址等运行信息；Pi agent 目录还可能包含认证数据。不要将这些文件提交到 Git 或公开分享。
