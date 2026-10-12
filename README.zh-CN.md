# Thebe Core

[English](README.md)

Thebe Core 是跑在你自己机器上的服务端，用来操作已经在跑的影视库、照片、音乐、文件、下载和容器。名字来自木星的卫星 Thebe（木卫十四），读作 /ˈθiːbi/。

这个仓库只有服务端。Apple 上的 Thebe App 不在这里，源码也不公开。仓库里可以直接使用的是终端、HTTP API 和 MCP。

服务端是一个 Docker 容器，支持 x86_64 和 arm64。NAS、迷你主机、树莓派或云服务器都可以。多架构镜像已发布到 GitHub Container Registry（`ghcr.io/unitsung/thebe-core`）；Core 开源前该包为私有，别人还拉不到——可以从本仓库构建，有访问权限则可直接拉取。

## 能做什么

Agent 运行时使用 pi-coding-agent。在指定的工作区里，它可以读文件、改文件、执行命令，一次任务里可以连做几步。改文件和执行命令默认会先征求确认。

接上服务后还可以：

- 在 Emby、Jellyfin 里按标题、人物或年份检索条目，并读取简介和演职员
- 在 Immich 里按画面内容搜索照片
- 在 Navidrome 里浏览专辑、歌手、歌单和歌词，整理播放队列
- 用 OpenList 浏览和整理文件、发起离线下载；用 qBittorrent 查看和控制下载任务
- 在 OpenList、qBittorrent，以及 Emby 或 Jellyfin 都已配置时，把下载、拷贝、扫描和校验串成入库流程。配上 Prowlarr 后可以先搜索资源
- 通过 Arcane 查看容器状态和日志。启动和重启会先征求确认
- 加载 Skills，或在 `.thebe/mcp.json` 里接入 MCP 服务器
- 按你提供的 OpenAPI 3 或 Swagger 2 文档调用一个 HTTP 服务。开放哪些读接口写在配置里，写操作会先征求确认
- 在会话里搜索网页。搜索默认关闭，打开后结果附来源链接

模型、服务地址和密钥见[配置指南](docs/configuration.md)。

## 快速开始

容器可从本仓库构建，有访问权限也可拉取已发布镜像，见[部署文档](docs/DEPLOYMENT.md)。不使用 Docker 时，从源码运行需要 Node.js 22.19+ 和 pnpm 10+。

```bash
cd deploy
cp .env.example .env     # 设置 THEBE_TOKEN、THEBE_ALLOWED_HOSTS、THEBE_WORKSPACE
docker compose up -d --build
TOKEN=$(sed -n 's/^THEBE_TOKEN=//p' .env)
curl -s -H "X-Thebe-Token: $TOKEN" http://127.0.0.1:8787/v1/health
```

从源码运行（必须指定工作区目录）：

```bash
pnpm install
cp .env.example .env
THEBE_WORKSPACE_DIR=/srv/thebe-workspace pnpm start:build
```

接着按[配置指南](docs/configuration.md)连接模型和你的服务。

## 文档

| 主题 | 位置 |
| --- | --- |
| 模型、服务、MCP、沙箱 | [配置指南](docs/configuration.md) |
| 容器、升级、备份、发布检查 | [部署文档](docs/DEPLOYMENT.md) |
| HTTP 路由 | [Core 产品 HTTP](docs/CORE-PRODUCT-HTTP.md) |
| 路线图 | [ROADMAP.md](ROADMAP.md) |
| 术语与架构 | [CONTEXT.md](CONTEXT.md) |
| 参与贡献与安全 | [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) |

开发检查：`pnpm typecheck`、`pnpm test`、`bash scripts/release-check.sh`。

## 许可证

Apache-2.0
