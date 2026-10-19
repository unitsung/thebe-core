# 宿主沙箱用 Claude 的 Seatbelt / bubblewrap，容器里不再套一层

状态：已采纳（2026-10-19）。取代 ADR 0004 里关于 `THEBE_SANDBOX` 后端菜单的那一段。容器仍是发布边界（ADR 0002）。

## 背景

沙箱曾经是一张菜单：`off | os | vm`，再加上 `bwrap`、`docker`、`seatbelt`、`gondolin`。手写的 Seatbelt、bubblewrap 和一次性 Docker 容器，以及 Gondolin 微虚拟机，各自一套依赖和失败方式。环境变量比产品需要的多。网络默认开着。

Claude Code 把 Seatbelt 和 bubblewrap 收进 `@anthropic-ai/sandbox-runtime`。Codex 的产品面是两态：工作区可写，或者完全访问。Pi 的社区扩展会自己接管 bash，和 Thebe 已经换过的 bash 工具冲突。

## 决定

两条安装形态，没有后端菜单。

- 容器（`/.dockerenv` 或 `/run/.containerenv`）：不启动沙箱。不设置 `THEBE_SANDBOX`。不使用 `enableWeakerNestedSandbox`。
- 宿主：默认是钉死的 `@anthropic-ai/sandbox-runtime` 0.0.80。TUI 和 App 的 Agent 设置可以关掉它（先确认），命令守卫仍在；这不是 bypass。完全访问（`bypassPermissions`，TUI 和 App 先确认；`THEBE_FULL_ACCESS` 忽略）也会拿掉它。`THEBE_SANDBOX=off` 是强制关闭，界面改不了。`os`、`auto`、`vm`、`gondolin`、`bwrap`、`docker`、`seatbelt` 以及任何其它值都忽略，等同未设置，不再映射，也不再因此启动失败。

策略写死，不做成环境变量：

- 写：工作区和临时目录。
- 读：默认放开，拒绝 `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.thebe`。
- 网络：允许名单，默认空。流量走库的代理。没有「网络原样打开」的开关。

实现只留 `src/agent/security/os-sandbox.ts`。进程里 `SandboxManager.initialize` 一次，已经异步的 `BashOperations.exec` 里 `wrapWithSandbox`。Pi 的 `spawnHook` 是同步的，只清理环境变量。依赖缺失时拒绝命令，不裸跑。Linux 需要 bubblewrap、socat 和 ripgrep；macOS 不需要 ripgrep。

## 后果

- `GET /v1/system/isolation` 的 `sandbox.mode` 只有 `off` 和 `os`，不再返回 `backends`。`fallback` 恒为 false。
- 宿主上未设置变量时，bash 默认进沙箱。以前默认是关的。
- 沙箱里的网络默认不通。第一次访问某个域名走和 Claude Code 一样的询问；记住后写入允许名单。同时跑两条沙箱命令时无法归因，这次连接拒绝。起一个给宿主访问的开发服务器，在 Linux 上仍然做不到（库的已知限制）。
- `@earendil-works/gondolin` 不再是依赖。手写的 Seatbelt、bwrap 和一次性 Docker 沙箱删除。
- 容器部署不获得这层沙箱。隔离仍靠 ADR 0002 的容器边界。
