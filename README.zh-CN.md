# Thebe Core

[English](README.md)

Thebe Core 是跑在你自己机器上的服务端，用来操作已经在跑的影视库、照片、音乐、文件、下载和容器。名字来自木星的卫星 Thebe（木卫十四），读作 /ˈθiːbi/。

这个仓库只有服务端，而且它是可选的。Apple 上的 Thebe App 是另一个闭源产品，直接连接你的各个服务，不依赖 Core；Core 补上手机 App 单独做不到的部分：AI agent、后台和定时任务、危险操作的审批，以及可供其他 agent 使用的 MCP 端点。App 的源码不在这里。仓库里可以直接使用的是终端、HTTP API 和 MCP。

> **状态：预发布。** 还没有打版本标签。测试套件和容器冒烟测试都能通过，但各服务集成（Emby、
> Jellyfin、Immich、Navidrome、OpenList、qBittorrent、aria2、Prowlarr、Arcane）目前是用录制的
> 响应和 mock 测的，还没有在每个产品的真实版本上逐一验证。可能有毛边；在把它暴露到本机以外之前，
> 请先读 [SECURITY.md](SECURITY.md)。

服务端是一个 Docker 容器，支持 x86_64 和 arm64。NAS、迷你主机、树莓派或云服务器都可以。推送 `v*` 标签时，工作流会构建多架构镜像并推送到 GitHub Container Registry（`ghcr.io/unitsung/thebe-core`）。目前还没有打过标签，所以现在请从本仓库构建镜像。

## 能做什么

Agent 运行时使用 pi-coding-agent。在指定的工作区里，它可以读文件、改文件、执行命令，一次任务里可以连做几步。改文件和执行命令默认会先征求确认。较长的工作可以作为目标（goal）、后台 worker 或定时任务运行。

接上服务后还可以：

- 在 Emby、Jellyfin 里按标题、人物或年份检索条目，并读取简介和演职员
- 在 Immich 里按画面内容搜索照片
- 在 Navidrome 里浏览专辑、歌手、歌单和歌词，整理播放队列。可选接入网易云和 SQMusic 的查询，以及需要审批的 SQMusic 下载
- 用 OpenList 浏览和整理文件、发起离线下载；用 qBittorrent 和 aria2 查看和控制下载任务
- 在 OpenList、下载引擎，以及 Emby 或 Jellyfin 都已配置时，把下载、拷贝、扫描和校验串成入库流程。配上 Prowlarr 后可以先搜索资源
- 通过 Arcane，或通过受限的 `docker-socket-proxy` 后面的 Docker Engine API，查看容器状态和日志。启动和重启会先征求确认
- 加载 Skills，或在 `.thebe/mcp.json` 里接入 MCP 服务器
- 按你提供的 OpenAPI 3 或 Swagger 2 文档调用一个 HTTP 服务。开放哪些读接口写在配置里，写操作会先征求确认
- 通过你指定的 SearXNG 实例搜索网页（设置 `THEBE_WEB_SEARCH_URL` 之前默认关闭），结果附来源链接

模型、服务地址和密钥见[配置指南](docs/configuration.md)。

## Core 适合什么时候用

只想查看和控制服务、播放媒体、和 App 自带的 agent 对话，单用 App 就够。需要手机自己做不到的事时再加 Core：

| 你想要                                                                        | 是否需要 Core     |
| ----------------------------------------------------------------------------- | ----------------- |
| 手机休眠后仍在跑的下载、媒体库扫描和定时任务                                  | 需要              |
| 在服务器上执行命令、改文件的 agent                                            | 需要              |
| 危险操作的推送与审批                                                          | 需要              |
| 让你自己的 agent（OpenClaw、Hermes、Claude Code、Codex）使用你的 homelab 服务 | 需要，通过 `/mcp` |
| 浏览服务、播放媒体、在 App 里交互式对话                                       | 不需要            |

Core 不打算做通用 agent 平台，也不做聊天网关。如果你已经在用这类工具，请把它指向 Core 的 `/mcp` 端点，不必替换它。目前 `/mcp` 只提供读工具；写操作经 `/mcp` 会被拒绝，只能在 Core 自己的会话里经你审批后执行。

## 快速开始

容器请从本仓库构建，见[部署文档](docs/DEPLOYMENT.md)。不使用 Docker 时，从源码运行需要 Node.js 24 LTS（自带 npm）。

```bash
cd deploy
cp .env.example .env     # 设置 THEBE_TOKEN、THEBE_ALLOWED_HOSTS、THEBE_WORKSPACE
docker compose up -d --build
TOKEN=$(sed -n 's/^THEBE_TOKEN=//p' .env)
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/health
```

从源码运行（必须指定工作区目录）：

```bash
npm install
cp .env.example .env
THEBE_WORKSPACE_DIR=/srv/thebe-workspace npm run start:build
```

接着按[配置指南](docs/configuration.md)连接模型和你的服务。Core 不自带模型：在终端界面里用 `/settings`，或通过 `GET /v1/provider` 登录一个模型服务商。

## 不用 App 怎么用

有三个入口，都走同一套权限和审批规则。

**终端。** `npm run tui` 会构建并启动交互界面。构建之后，`node dist/cli.js`（或包的 `bin`：`thebe`）效果相同；`thebe -p "列出我的容器"` 执行一条提示后退出。`thebe --help` 列出 session 和 MCP 子命令，`thebe doctor` 报告隔离状态。

**HTTP API。** 所有 `/v1` 路由都需要在 `X-Thebe-Token` 请求头里带 token。API 参考在 `/docs`（Swagger UI），原始规范在 `/openapi.json`，这两个不需要 token。想看 Core 能做什么、想试一下，这里最快：

```bash
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/capabilities
```

**MCP。** `POST /mcp` 是无状态的 JSON-RPC 端点（只有 tools），能带 token 请求头的 MCP 客户端都可以用它调用 Core 的能力：

```bash
curl -s -X POST -H "X-Thebe-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8787/mcp
```

写操作经 `/mcp` 会被拒绝，只能在 agent 会话里、经你审批后执行。

## 安全要点

token 拥有全部权限，没有作用域。容器默认只监听回环地址；要更大的访问范围，请放在 TLS 后面（Tailscale 或反向代理），并把主机名写进 `THEBE_ALLOWED_HOSTS`。默认权限模式会在改文件和执行命令前征求确认。工具输出和 MCP 数据都当作不可信数据。完整模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 文档

| 主题                       | 位置                                                           |
| -------------------------- | -------------------------------------------------------------- |
| 模型、服务、MCP、沙箱      | [配置指南](docs/configuration.md)                              |
| 容器、升级、备份、发布检查 | [部署文档](docs/DEPLOYMENT.md)                                 |
| HTTP 路由                  | [Core 产品 HTTP](docs/CORE-PRODUCT-HTTP.md)                    |
| 使用服务自带的 MCP 服务器  | [Provider MCP](docs/PROVIDER-MCP.md)                           |
| 设计决策                   | [docs/adr](docs/adr)                                           |
| 变更记录                   | [CHANGELOG.md](CHANGELOG.md)                                   |
| 路线图                     | [ROADMAP.md](ROADMAP.md)                                       |
| 术语与架构                 | [CONTEXT.md](CONTEXT.md)                                       |
| 参与贡献与安全             | [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) |

开发检查：`npm run typecheck`、`npm run lint`、`npm run format`、`npm test`、`bash scripts/release-check.sh`。

## 许可证

Apache-2.0
