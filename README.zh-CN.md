# Thebe Core

[English](README.md)

Thebe Core 是一个带审批和审计日志的 homelab agent 服务端。它连接你已经在跑的服务（影视库、照片、音乐、文件、下载、容器），让 agent 能安全地操作它们：读操作直接执行，有风险的操作等你批准，每次调用都有记录。

可以跑在 NAS、迷你主机、树莓派或云服务器上。有三种用法：

- **作为 MCP 服务器**，给你已经在用的 agent 使用。任何能发送 HTTP 请求头的 MCP 客户端都可以列出并调用 Core 的工具。
- **作为终端 agent。** Core 内嵌 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 运行时，`thebe` 提供 TUI 和一次性 CLI，可以在你指定的工作区里读文件、改文件、执行命令。
- **通过 HTTP API。** 会话、目标、定时任务、活动流、审批和审计日志，OpenAPI 文档在 `/docs`。

名字来自木星的卫星 Thebe（木卫十四），读作 /ˈθiːbi/。

> **状态：预发布。** 还没有打版本标签。测试套件和容器冒烟测试都能通过，但各服务集成（Emby、Jellyfin、Immich、Navidrome、OpenList、qBittorrent、aria2、Prowlarr、Arcane）目前是用录制的响应和 mock 测的，还没有在每个产品的真实版本上逐一验证。Claude Code、Codex 和 OpenCode 都已在真实会话里列出并调用过 `/mcp` 的工具，官方 MCP TypeScript SDK 也通过了 initialize、列工具、调用工具。在把 Core 暴露到本机以外之前，请先读 [SECURITY.md](SECURITY.md)。

## 能做什么

配置好模型和工作区后，agent 可以读文件、改文件、执行命令，一次任务里可以连做几步。改文件和执行命令默认会先征求确认。较长的工作可以作为目标（goal）、后台 worker 或定时任务运行。

接上服务后还可以：

- 在 Emby、Jellyfin 里按标题、人物或年份检索条目，并读取简介和演职员
- 在 Immich 里按画面内容搜索照片
- 在 Navidrome 里浏览专辑、歌手、歌单和歌词，整理播放队列。可选接入网易云和 SQMusic 的查询，以及需要审批的 SQMusic 下载
- 用 OpenList 浏览和整理文件、发起离线下载；用 qBittorrent 和 aria2 查看和控制下载任务
- 在 OpenList、下载引擎，以及 Emby 或 Jellyfin 都已配置时，把下载、拷贝、扫描和校验串成入库流程。配上 Prowlarr 后可以先搜索资源
- 通过 Arcane，或通过受限的 `docker-socket-proxy` 后面的 Docker Engine API，查看容器状态和日志。启动和重启会先征求确认
- 按你提供的 OpenAPI 3 或 Swagger 2 文档调用任意 HTTP 服务。开放哪些读接口写在配置里，写操作会先征求确认
- 加载 Skills，或在 `.thebe/mcp.json` 里接入其他 MCP 服务器
- 通过你指定的 SearXNG 实例搜索网页（设置 `THEBE_WEB_SEARCH_URL` 之前默认关闭），结果附来源链接

模型、服务地址和密钥见[配置指南](docs/configuration.md)。

## 快速开始

容器是受支持的运行方式，见[部署文档](docs/DEPLOYMENT.md)。支持 x86_64 和 arm64。推送 `v*` 标签时，工作流会构建多架构镜像并推送到 GitHub Container Registry（`ghcr.io/unitsung/thebe-core`）。目前还没有打过标签，所以现在请从本仓库构建镜像。

```bash
cd deploy
cp .env.example .env     # 设置 THEBE_TOKEN、THEBE_ALLOWED_HOSTS、THEBE_WORKSPACE
docker compose up -d --build
TOKEN=$(sed -n 's/^THEBE_TOKEN=//p' .env)
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/health
```

不使用 Docker 时，从源码运行（需要 Node.js 24 LTS，自带 npm；必须指定工作区目录）：

```bash
npm install
cp .env.example .env
THEBE_WORKSPACE_DIR=/srv/thebe-workspace npm run start:build
```

Core 不自带模型：在终端界面里用 `/settings`，或通过 `GET /v1/provider` 登录一个模型服务商，然后按[配置指南](docs/configuration.md)连接你的服务。

## 怎么用

**接入你自己的 agent（MCP）。** `POST /mcp` 是无状态的 JSON-RPC 端点（只有 tools），暴露 Core 的能力。在 `X-Thebe-Token` 请求头里带 token：

```bash
curl -s -X POST -H "X-Thebe-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8787/mcp
```

在 agent 的 MCP 配置里指向这个地址并带上同样的请求头。默认 `/mcp` 只提供读工具。设置 `THEBE_MCP_WRITES=on` 后，调用方 agent 也能用写工具（重启容器、改歌单、服务商 MCP 的写工具）。这条路径上 Core 不会先问任何人。每个工具都带 `readOnlyHint` 和 `destructiveHint`，要不要问用户由调用方 agent 和它的客户端决定。每次写操作都记入审计日志。

**在终端里。** `npm run tui` 会构建并启动交互界面。构建之后，`node dist/cli.js`（或包的 `bin`：`thebe`）效果相同；`thebe -p "列出我的容器"` 执行一条提示后退出。`thebe --help` 列出 session 和 MCP 子命令，`thebe doctor` 报告隔离状态。

**通过 HTTP。** 所有 `/v1` 路由都需要 token。API 参考在 `/docs`（Swagger UI），原始规范在 `/openapi.json`，这两个不需要 token。

```bash
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/capabilities
```

## 安全要点

token 拥有全部权限，没有作用域。容器默认只监听回环地址；要更大的访问范围，请放在 TLS 后面（Tailscale 或反向代理），并把主机名写进 `THEBE_ALLOWED_HOSTS`。默认权限模式会在改文件和执行命令前征求确认；shell 命令会先做风险分级，在宿主机上运行于系统沙箱里；工具输出和 MCP 数据都当作不可信数据；密钥会被脱敏；每次调用都写入只追加的审计日志（agent store 目录下的 `audit.jsonl`）。完整模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 使用须知

Core 操作的是你自己运行的服务和你自己的账号，它不提供、托管、索引或推荐任何内容。部分可选集成会连接下载器、索引器（Prowlarr）、网盘和第三方音乐服务（SQMusic，以及你自己部署的非官方网易云 API 服务），它们只是对你已有工具的便利封装。

你需要对让 Core 用它们做的事负责：确认你有权下载、复制或保存相关内容，并遵守你所在地的法律和所连接服务的条款。维护者不认可、也不为侵权使用承担责任；本软件按现状提供，不附带任何担保，授权见 [Apache-2.0 许可证](LICENSE)。下载等写操作默认需要你的批准，每次调用都会记录在审计日志里，方便你查看实际执行了什么。

## 文档

| 主题                       | 位置                                                           |
| -------------------------- | -------------------------------------------------------------- |
| 模型、服务、MCP、沙箱      | [配置指南](docs/configuration.md)                              |
| 容器、升级、备份、发布检查 | [部署文档](docs/DEPLOYMENT.md)                                 |
| HTTP 路由                  | [Core 产品 HTTP](docs/CORE-PRODUCT-HTTP.md)                    |
| 使用服务自带的 MCP 服务器  | [Provider MCP](docs/PROVIDER-MCP.md)                           |
| 变更记录                   | [CHANGELOG.md](CHANGELOG.md)                                   |
| 路线图                     | [ROADMAP.md](ROADMAP.md)                                       |
| 术语与架构                 | [CONTEXT.md](CONTEXT.md)                                       |
| 参与贡献与安全             | [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) |

开发检查：`npm run typecheck`、`npm run lint`、`npm run format`、`npm test`、`bash scripts/release-check.sh`。

## 许可证

Apache-2.0。代码按 Apache-2.0 授权；Thebe 名称和标志不在该许可范围内，也不意味着你可以用同样的名字发布产品。

贡献需要在提交里带 `Signed-off-by`，见 [CONTRIBUTING.md](CONTRIBUTING.md)。
