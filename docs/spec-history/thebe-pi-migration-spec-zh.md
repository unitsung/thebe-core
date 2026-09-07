# Thebe 迁移至 Pi Coding Agent Runtime — 参考规格文档（中文版）

> 已不再作为现行规格。所有权边界与决策见 `../architecture.md`、`../adr/0001-pi-coding-agent-runtime.md` 与 `../migration-note.md`。

> 本文档基于 `thebe-pi-coding-agent-migration-goal.md` 整理，作为后续开发的长期参考基准，防止范围漂移。

## 产品定位与不可变原则

| 原则 | 内容 |
|---|---|
| 产品定位 | Thebe 是构建在可替换 coding-agent runtime 之上的家庭实验室产品，不是 agent 框架本身 |
| 首个 runtime | `@earendil-works/pi-coding-agent`，必须通过其官方 SDK 嵌入，禁止 shell 调用 Pi CLI 或做成 CLI 包装层 |
| 隔离原则 | 任何 Pi 专有类型、session 对象、事件形状、存储细节或内部 hook 类型，不得泄漏进 Thebe 的 domain、HTTP、TUI 或 iOS 相关代码 |
| 可替换性 | 未来可加入第二个 runtime（如 Claude Code、OpenCode）而不必改动 domain adapter、自定义工具、HTTP handler 或客户端事件类型 |

## 架构分层与归属边界

Thebe 产品层包含 HTTP/iOS API、本地终端入口、用户与设备身份、家庭实验室上下文选择、产品审计事件流、事件报告/分享元数据，以及家庭实验室领域适配器（ContainerInfoProvider、ArcaneAdapter 等）。这一层之下是 `AgentRuntime` 抽象，其首个实现 `PiCodingAgentRuntime` 封装 Pi SDK 提供的 session 管理、原生持久化、分支与压缩、JSONL/HTML 导出、provider 目录与 OAuth、内置编码工具及 Pi 事件模型。

### 职责归属表

| 职责 | 归属方 |
|---|---|
| Agent 循环、工具调用循环 | Pi Coding Agent |
| 通用 session 记录、分支/叶子图、压缩历史 | Pi Coding Agent |
| 通用 JSONL/HTML 导出 | Pi Coding Agent |
| provider 目录、API key 与 OAuth 生命周期 | Pi Coding Agent |
| 内置 bash/read/write/edit/grep/find/ls 工具 | Pi Coding Agent |
| Thebe session 到 Pi runtime session 的映射 | Thebe |
| HTTP/iOS API、本地入口、客户端事件协议 | Thebe |
| 家庭实验室语义、宿主/环境/服务上下文选择 | Thebe |
| Arcane 集成、分页与 WebSocket 日志 | Thebe |
| `container.*` 自定义工具 | Thebe |
| 审计关联、产品元数据、报告与分享 | Thebe |
| 自定义工具输出的敏感信息脱敏 | Thebe |

## 必须实现的七项

1. **运行时边界**：用 `AgentRuntime`/`RuntimeSession`/规范化事件接口取代旧的 `AgentAdapter`，Thebe 代码只导入 Thebe 自有接口，客户端只收到规范化 `RuntimeEvent`。
2. **PiCodingAgentRuntime 实现**：围绕 `createAgentSession(...)` 完成创建、恢复、列出、fork、压缩、导出，使用 Pi 原生 provider/凭证体系，并把 Pi 生命周期/工具/模型/会话事件映射为 Thebe 规范化事件，同时保留 Pi 支持的取消/中止语义。
3. **混合工具面**：同一个 session 内同时启用 Pi 内置工具（ls/find/grep/read/edit/write/bash）与 Thebe 自定义 `container.*` 工具，且不得删除 ContainerInfoProvider、ArcaneAdapter 及其契约测试；网络搜索若需要，只能作为显式注册的自定义工具或受信任扩展，禁止引入扩展市场或自动发现。
4. **移除重复所有权**：删除 Thebe 自建的 transcript、分支/fork 持久化、压缩实现、本地导出实现、`convertToLlm` 补丁及 Pi-hook 专用策略代码；保留与 runtime 无关的产品代码（session 映射、身份元数据、审计、脱敏、家庭实验室适配器）。
5. **持久化重构**：ProductStore 只存 Thebe 自有元数据（如 `thebeSessionId`、`runtimeId`、`runtimeSessionId`、上下文选择、标签、分享元数据），禁止存储 Pi transcript、分支拓扑、压缩记录或 OAuth refresh token。
6. **保留现有入口**：HTTP、未来 iOS API、本地终端/TUI 入口以及可能保留的 `/mcp` 接口都必须走同一套 Thebe 服务层与 runtime 映射，任何入口不得绕过自定义工具注册、脱敏或身份映射。
7. **审慎处理 skills/prompts/扩展**：Thebe 显式控制哪些目录/来源对 Pi runtime 可见，禁止任何项目级或用户级扩展因"存在于磁盘"而被自动加载，且每个启用的扩展/skill 的身份、版本、来源都要记录进审计元数据。

## 迁移顺序（必须按序执行，禁止跳步）

1. 新增 Thebe 自有的 `AgentRuntime`/`RuntimeSession`/规范化事件接口。
2. 在旧 Harness 实现旁新增 `PiCodingAgentRuntime`，暂不删除旧代码。
3. 打通一条端到端路径：HTTP Ask → Thebe 服务 → Pi runtime session → 规范化事件流 → 审计桥接。
4. 把 Pi 内置文件系统/bash 工具与 Thebe `container.*` 工具接入同一 session。
5. 把 TUI 迁移到同一服务/runtime 路径。
6. 把 session 的列出/恢复/fork/导出迁移到 Pi 原生能力。
7. 迁移 API-key provider 选择与一个 OAuth provider 流程到 Pi 原生能力。
8. 全部验收标准通过后，才删除重复的旧实现。
9. 删除过时的 active spec 文档，替换为一份架构文档 + 一份 ADR。

## 验收标准（共 27 项，分七组）

| 分组 | 核心验证点 |
|---|---|
| A. 运行时边界（1–4） | 非 Pi 实现代码零 Pi 类型导入；可用 fake runtime 替换真实实现跑通测试 |
| B. Pi 原生会话能力（5–9） | session 可跨进程重启存活、可 list/resume、fork 不影响父会话、压缩后可续聊、JSONL/HTML 导出内容正确 |
| C. Provider 与凭证（10–13） | 一个 API-key provider 与一个 OAuth provider 均通过 Pi 原生流程可用，Thebe 不再有自建 OAuth 刷新逻辑 |
| D. 混合工具面（14–17） | 同一对话内混用 Pi 内置工具与 Thebe 自定义工具；Arcane 相关测试不弱化；脱敏对成功/失败/取消/拒绝事件均生效，且有 canary secret 测试证明 |
| E. 产品层与审计（18–21） | HTTP 与 TUI 共用同一服务与映射；ProductStore 不含重复的 Pi 数据；审计记录包含完整可追溯字段但不重复全量 session 内容 |
| F. 迁移清理（22–26） | 无生产代码在 `PiCodingAgentRuntime` 之外直接构造裸 `Agent`/`AgentHarness`；旧实现被真正删除而非留作死代码；`package.json` 锁定 Pi 版本并提交 lockfile |
| G. 端到端证明（27） | 一次自动化测试 + 一次人工观察，完整走完创建会话→用内置工具探查→用自定义工具查容器→编辑文件→跑 bash 命令→fork→触发压缩→双格式导出→重启恢复→验证 canary secret 不泄漏的全链路 |

## 明确的停止条件与范围外事项

当 27 项验收标准全部通过时，必须立即停止编码，这是文档给出的显式停止条件。以下内容明确排除在本次迁移范围之外，不允许在本轮顺带实现：

- 第二个 runtime 实现（Claude Code、OpenCode、DeepSeek Harness 等）
- runtime 市场或第三方扩展安装器、自动远程包下载
- 完整 iOS UI 实现
- 新的授权/审批产品
- 无约束的自主定时修复能力
- 多 runtime 会话迁移/导入
- 通用工作流引擎
- 重写 Arcane 或新增 Portainer/Dockge 适配器
- 扩展全部可能的家庭实验室集成

这些都是本次迁移评审通过之后的独立目标，不应提前实现。

## 最终交付物（完成标志）

宣布迁移完成前必须产出：`docs/architecture.md` 描述新的所有权边界、一份记录该决策的 ADR、一份列出被移除/退役模块及其替代方案的迁移说明、一个可执行验收测试套件的测试命令或 CI 工作流，以及针对验收标准第 27 条端到端证明的一次人工验证记录。

## 附：初步排查的问题（落地前需澄清）

- "私有实现文件"的目录边界未定义，实际落地时容易被相邻文件间接引用类型而破坏隔离约束。
- 验收标准第 8 条要求触发 near-context-limit 场景以验证压缩，但文档未说明如何在测试环境中可控地制造上下文压力。
- OAuth 迁移的过渡期兼容策略未明确：迁移到 Pi 原生 OAuth 前，Thebe 现有 OAuth 存储如何与新实现共存。
- `/mcp` 接口保留与否是条件性描述（"if it remains a deliberate product interface"），需要在迁移启动前做出明确决策。
- 脱敏必须在输出到达 Pi session history 之前完成，但 `RuntimeSession.prompt` 接口未显式定义该拦截点的位置。
- 若删除旧实现后某条验收标准出现回归，文档未规定回滚流程。
