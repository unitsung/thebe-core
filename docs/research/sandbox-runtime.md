# `@anthropic-ai/sandbox-runtime` 能不能给 Thebe 用

实现状态：2026-10-19 已按文末推荐方案落地，见 `docs/adr/0005-host-os-sandbox.md`。文中「现在」指改之前的代码。

调研日期：2026-10-19。只回答宿主上的 `THEBE_SANDBOX=os`。容器部署仍然不套第二层沙箱。

## 结论

能用，而且应该直接依赖这个库，不要装 Pi 社区扩展。

它就是 Claude Code 的 Seatbelt / bubblewrap 实现，Apache-2.0，进程内库加 `srt` CLI。当前发布版 `0.0.80`（2026-10-16），要求 Node `>=22.12`。Core 要求 Node `>=24`，引擎兼容。npm 最近 30 天约 205 万次下载，几乎都是 Claude Code 带起来的，不是 Pi 生态。仓库 [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime)：5587 stars，499 forks，292 个未关闭 issue，自标 **Beta Research Preview**，API 会变。

不要把 `pi-sandbox` 装进 Thebe。那些扩展是给独立 Pi 进程用的，会自己接管 `bash` / `read` / `write` / `edit`。Thebe 已经在 `open-session.ts` 里换过 bash。

## 社区扩展

| 扩展                                                                 | 体量                                                     | 底下用什么                                                        | 能不能当 Thebe 的沙箱                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Pi 官方例子 `packages/coding-agent/examples/extensions/sandbox`      | 示例，要手拷                                             | 钉死 `@anthropic-ai/sandbox-runtime@0.0.26`                       | 不能。版本落后当前 0.0.80 五十多个发布                                            |
| [carderne/pi-sandbox](https://github.com/carderne/pi-sandbox)        | 284 stars，65 forks；npm `pi-sandbox` 最近 30 天 7105 次 | fork `@carderne/sandbox-runtime`（同期约 1.2 万次下载），不是上游 | Pi 用户里最常见的一个。交互提示可用，但是 fork、要试出来放行规则，不适合嵌进 Core |
| `@oddsjam/pi-sandbox`、`@erichll/pi-sandbox`、`@igormaka/pi-sandbox` | 个位数到十几 stars                                       | 上游库                                                            | 思路对（直接用上游），产品不成熟                                                  |
| `code-yeongyu/pi-sandbox`                                            | 2026-06-12 归档                                          | 自己再做 native / Docker / QEMU / SSH                             | 就是 Thebe 想摆脱的那套矩阵                                                       |

`pi-sandbox` 自己写明：Linux 上 `allowWrite` / `denyWrite` 的 glob 会被 bubblewrap 静默忽略；为了 agent-browser 加的放行会开洞；macOS 和 Linux 初始化都要 `rg`。好用程度是「Pi 里能用，要调配置」，不是「装上就和 Claude Code 一样」。

## 库怎么接

官方库用法（[README](https://github.com/anthropics/sandbox-runtime/blob/main/README.md)）：

```ts
await SandboxManager.initialize(config);
const command = await SandboxManager.wrapWithSandbox(
  "curl https://example.com"
);
```

`wrapWithSandbox` 是异步的，返回一条已经套上 `sandbox-exec` 或 `bwrap` 的命令字符串。

Pi 的 `BashSpawnHook` 类型是同步的：`(context) => BashSpawnContext`，`resolveSpawnContext` 不 await。现在 `sandboxedCommand()` 塞在 `spawnHook` 里，这条路接不上。能接的是已经异步的 `BashOperations.exec`（`open-session.ts` 里的 `guardedBashOperations`）。`fullAccess` 时不包，和现在一样。

`SandboxManager` 是进程单例。一个 Core 进程一套配置，够用。文件规则在 wrap 时写死；网络名单可以之后改。

## 和现在的 `os` 不是同一件事

现在手写的 Seatbelt / bwrap 默认把网络留着（ADR 0004 删了 `THEBE_SANDBOX_NETWORK`）。这个库是默认全拒绝：

- 写：默认全部拒绝，必须 `allowWrite`。
- 读：默认放行，再用 `denyRead` 抠掉 `~/.ssh` 这类路径。
- 网络：空的 `allowedDomains` 就是断网。流量走宿主上的 HTTP / SOCKS 代理。没有「网络原样打开、不经代理」的开关。`enableWeakerNetworkIsolation` 只是 macOS 上给 Go 的 TLS 放行 `trustd`，不是放行所有网。

要和 Claude / Codex 对齐，就要改成域名允许名单，而不是保持现在的「网络开着」。用 ask callback 对所有 host 返回 `true`，流量仍过代理；Linux 上不看 `HTTP_PROXY` 的程序会直接连不上（README 的已知限制）。

它只包你交给它的子进程。Pi 的 `read` / `write` / `edit` 在 Core 进程里，包了 bash 也盖不住。社区扩展所以又做了一层工具拦截。文件工具还是 Thebe 自己的策略。

## 不能装进去的地方

- **容器部署。** 继续 `THEBE_SANDBOX` 不设。库自己的 `enableWeakerNestedSandbox` 是为了在 Docker 里硬跑，文档写明会明显削弱隔离。无特权容器里 bwrap 失败是未关 issue（[#180](https://github.com/anthropics/sandbox-runtime/issues/180)）。
- **Linux 上让沙箱里的进程听端口给宿主访问。** `allowLocalBinding` 只接到 macOS。Linux 是独立 netns，没有回到宿主的桥。issue [#165](https://github.com/anthropics/sandbox-runtime/issues/165) 到 2026-06 仍未解决。起 dev server 再从外面 curl，这条会坏。
- **沙箱里再开用户命名空间。** `0.0.80` 默认禁止。Chromium、rootless podman、再套一层 bwrap 会失败，除非显式 `allowNestedUserNamespaces: true`。
- **把包装进可写目录。** `allowWrite` 盖住 `node_modules` 时，沙箱里的命令可以改掉这个包，下一次就不再是沙箱。Core 若跟工作区装在一起，要避开。编进应用里则不受影响。
- **依赖。** Linux 要 bubblewrap、socat、ripgrep。macOS 的 Seatbelt 直接吃正则，`0.0.80` 的 `checkDependencies` 不要求 ripgrep。只支持 x64 / arm64 的预编译 seccomp helper。Windows 是 alpha，先不管。

## 推荐方案

可维护性最好的是 Claude 的机制加 Codex 的产品面，不抄任何一边的全部配置。

两条安装形态，没有后端菜单：

- 容器：检测到 `/.dockerenv` 或 `/run/.containerenv` 就不启动沙箱。发布形态不用环境变量。
- 宿主：默认用钉死版本的 `@anthropic-ai/sandbox-runtime`。关掉它的唯一开关是已有的完全访问（`bypassPermissions`）。`THEBE_SANDBOX` 只保留 `off` 作为宿主逃生口；`os`、`auto`、`vm`、`bwrap`、`docker`、`seatbelt`、`gondolin` 以及任何其它值都忽略，等同未设置，不再映射。

策略固定成一小份默认值，不做成环境变量：

- 写：工作区和临时目录。
- 读：默认放开，拒绝 `~/.ssh`、`~/.aws`、`~/.gnupg` 和 Core 自己的凭据文件。
- 网络：允许名单，默认空。不再保持「网络总是开着」。

代码只留一个模块：进程启动时 `SandboxManager.initialize`，在已经异步的 `BashOperations.exec` 里 `wrapWithSandbox`。删掉手写的 Seatbelt、bwrap、一次性 Docker，以及 Gondolin 适配器。

不选的方案：继续自己维护 profile（Codex 这么做，但是一套 Rust 沙箱团队）；装 `pi-sandbox`（会抢 Thebe 已经换过的 bash 工具，而且走 fork）。
