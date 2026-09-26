# Thebe 配置指南

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
- `THEBE_OUTPUT_DIR` 设置用户明确要求保存生成文档时的默认目录；配置文件中的 `outputDirectory` 优先级更高。
- 只设置 `THEBE_CONFIG_DIR` 时，Pi agent 目录默认为 `$THEBE_CONFIG_DIR/agent`。

## OpenList STRM 修复 provider

Core 可以在启动时注册一个 provider-owned `strm.repair` 实现。配置完整的
OpenList 地址和 token 后，能力会自动出现在 Core capability catalog；缺少任一
变量时不会暴露该写能力：

```bash
export THEBE_OPENLIST_BASE_URL=https://openlist.example.com
export THEBE_OPENLIST_TOKEN=your-openlist-token
```

`OPENLIST_BASE_URL` 和 `OPENLIST_TOKEN` 也可作为兼容别名。provider 会通过
OpenList 的 `/api/fs/get`、`/api/fs/search` 和 `/api/fs/put` 完成候选查找、STRM
写回与复读验证，候选包括常规媒体文件以及 HLS `.m3u8` / DASH `.mpd` 播放列表；
token 只由 Core adapter 使用，不进入 Agent capability 参数。

## Google / Antigravity（OAuth 登录）

`google-antigravity` 走 Google 账号 OAuth，API 为 Cloud Code Assist
（`https://cloudcode-pa.googleapis.com/v1internal`）。它只支持 OAuth，不接受 API key；
`GET /v1/provider` 里以 `authMethods: ["oauth"]` 出现（Core 自己的 OAuth 条目优先于 Pi 的）。

Pi 在 0.71 移除了内置的 Gemini CLI / Antigravity provider，所以 Core 在**它自己交给
`createAgentSession` 的 `ModelRuntime` 上**用 `registerNativeProvider` 注册了一个
（`src/adapters/google/antigravity-provider.ts`）。因此 Pi 会话里 `provider: "google-antigravity"`
和其它 provider 一样可用：模型可解析、可列出、可对话（工具调用、thinking、用量都在）。

- **模型**：离线种子只有 `gemini-3-pro` / `gemini-3-flash`；真正的清单来自
  `v1internal:fetchAvailableModels`，通过 provider 的 `fetchModels` 覆盖层发布进 Pi 的模型库
  （`GET /v1/model?provider=google-antigravity`、App/TUI 的「自动获取模型」都会触发一次联网刷新，
  结果缓存；`PI_OFFLINE` 时只读缓存）。
- **认证**：provider 的 `apiKey.resolve` 直接读 Core 的凭据文件，所以 Pi 会话、HTTP 接口、
  TUI 设置页、手机 App 共用同一个 Google 会话；`/v1/provider/google-antigravity/oauth/logout`
  一登出，Pi 侧下一次请求即失效（不会在 Pi 的 `auth.json` 里留副本）。
- **传输**：`v1internal:streamGenerateContent?alt=sse` + Cloud Code Assist 信封，
  消息/工具转换复用 pi-ai 的 Gemini 实现（Claude 模型自动改用 `parameters` 字段）。
  `THEBE_ANTIGRAVITY_ENDPOINT` 可把端点指到本机代理/测试服务器（默认 Google）。

Headless 登录流程（TUI 设置页与移动端都用这一套）：

```bash
# 1. 取授权地址（响应里带 url / instructions，pending 为 true）
curl -s -X POST localhost:8787/v1/provider/google-antigravity/oauth/authorize
# 2. 浏览器完成登录后，把授权码或整段回调 URL 回传
curl -s -X POST localhost:8787/v1/provider/google-antigravity/oauth/callback \
  -H 'content-type: application/json' \
  -d '{"code":"http://localhost:51121/oauth-callback?code=..."}'
# 3. 退出登录
curl -s -X POST localhost:8787/v1/provider/google-antigravity/oauth/logout
```

凭据写在 agent 目录的 `antigravity.json`（0600，与 Pi 的 `auth.json` 同级），包含 access/refresh
token、到期时间、Google 账号邮箱与 Cloud 项目 id（`loadCodeAssist` 发现，必要时用 `onboardUser` 自动
开项目）。`POST /v1/provider/{id}/test` 先做令牌 + `fetchAvailableModels` + `generateContent` 探针，
再用拿到的第一个模型跑一次真实 Pi 会话探测。

两点边界：

- 移动端 App 直接用同一个 Google 客户端在设备上登录（Keychain 存凭据），不需要 Core 在场。
- pi-ai 的辅助函数（Gemini 消息/工具转换、事件流、成本计算）在运行时从 Pi 自己的依赖树按 URL 载入，
  所以 Core 仍然只依赖 `@earendil-works/pi-coding-agent` 一个包，也不会打包出第二份 pi-ai。

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
