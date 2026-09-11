# Thebe Homelab/NAS 极严格隔离与 MicroVM 沙箱方案深度调研与架构设计

> **版本**：v1.0  
> **定位**：Thebe 专属核心安全与基础设施架构设计规范  
> **核心命题**：为什么 Thebe 绝不能走通用 Coding Agent 的"宿主直跑"路线？针对 NAS 这种数据资产不可替代的极端敏感场景，如何构建从**小模型审查**、**工作区围栏**到 **MicroVM 硬件级虚拟化** 的多层纵深防御体系？

---

## 1. 战略背景：NAS 场景与通用 Coding Agent 的根本分水岭

### 1.1 通用 Coding Agent 的假设缺陷
市面上主流的通用 Coding Agent（如 Claude Code、Cursor、OpenCodeInterpreter 等）主要运行在**开发者本地工作站或临时云端沙盒**中。其底层隐含假设是：
- 执行环境通常托管在 Git 版本控制下；
- 误删或误改代码可以通过 `git checkout` 或 `git reset` 轻松找回；
- 进程权限即便直接暴露在宿主系统，造成的破坏通常局限于单个代码工程目录。

### 1.2 NAS / Homelab 场景的极端敏感性
Thebe 的使用场景是 **私有 Homelab 主机与 NAS 存储集群**（如 TrueNAS、Synology DSM、QNAP QTS、Unraid、Proxmox VE 或 Ubuntu/Debian Homelab 服务器）：
1. **数据资产的不可替代性与高脆弱性**：
   - 存放着用户数十年积累的**家庭照片、生活视频、财务文档、个人档案**；
   - 承载着生产级数据库、冷热备份盘、数十个生产容器的持久卷（`/var/lib/docker/volumes`、`/volume1/docker`）；
   - 底层由复杂的 **ZFS 存储池（zpool）、Btrfs 子卷、mdadm 软 RAID 阵列** 组成。
2. **灾难性破坏的不可逆性**：
   - 在 NAS 上执行一条未受控的 `rm -rf /volume1/data`、`zfs destroy -r pool/dataset`、`docker volume prune -f` 或裸磁盘写入 `dd of=/dev/sda`，**将直接导致数 TB 不可恢复的数据灰飞烟灭**，没有类似 Git 的撤销按钮。
3. **权限悖论与提权隐患**：
   - 基础设施智能体往往需要排查网络和管理容器，常规做法往往直接向 Agent 开放 Docker daemon socket（`/var/run/docker.sock`）或 sudo 权限。
   - **挂载 Docker daemon 等同于获得无限制 root 提权**：Agent 只需要执行 `docker run -v /:/host --privileged alpine chroot /host` 就能轻易突破任何文件系统软限制，完全接管并摧毁整个 NAS 宿主机。

### 1.3 官方 Pi 的安全免责边界
Pi 官方安全文档（`pi.dev/docs/latest/security`）明确指出：
> *"Pi does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the pi process. Extensions are TypeScript modules that run with the same permissions."*  
> *"Project trust is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory."*

**权威推论**：Pi 框架本身**完全不提供任何系统级隔离**。如果 Thebe 仅靠 Pi 默认的工具面运行在宿主机上，等同于将整台 NAS 的生死大权交给了大模型的单次推理性输出。因此，**严格隔离必须由 Thebe 的系统架构与部署层全面接管**。

---

## 2. 官方推荐方案：Gondolin Micro-VM 深度剖析与架构映射

Pi 的原作者开发团队 **Earendil Works** 深刻意识到 Agent 裸跑工具的致命风险，为此专门开源了专为 AI Agent 设计的轻量级微虚拟机沙箱：**Gondolin**（`@earendil-works/gondolin`）。

```
┌──────────────────────────────────────────────────────────────┐
│                    Host System (NAS / Homelab)               │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                Thebe Core / Pi Runtime                 │  │
│  │  - Agent LLM 推理 (通过 API 或 本地小模型)              │  │
│  │  - Session 状态管理与事件分发                          │  │
│  │  - 凭证保管与 HTTP Hooks 审查                          │  │
│  └──────────────────────────┬─────────────────────────────┘  │
│                             │ 调度与工具重定向 (gondolin.exec)│
│                             ▼                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │            Gondolin TypeScript Control Plane           │  │
│  │  - 仅映射: /workspace ◄──► Host 指定受限项目目录        │  │
│  │  - 阻断: Host Root /、/etc、/volume1、/mnt (完全不可见)  │  │
│  │  - 网络: 出网域名白名单 + Token 占位符真实值注入        │  │
│  └──────────────────────────┬─────────────────────────────┘  │
└─────────────────────────────┼────────────────────────────────┘
                              │
                              ▼ (QEMU / libkrun 虚拟化通道)
┌──────────────────────────────────────────────────────────────┐
│             Disposable Guest Micro-VM (<1s Boot)             │
│                                                              │
│  - 独立内核空间 (独立 PID 1、独立网络命名空间)               │
│  - 只读根文件系统 (Alpine Linux) + 内存写时复制 (CoW)        │
│  - 唯一可写/可见宿主目录: /workspace                         │
│  - 执行 bash、read、write、edit 工具                         │
│                                                              │
│  💥 即使 Agent 运行 rm -rf / 或 dd of=/dev/sda:              │
│     - 仅损坏虚拟机内部内存盘，退出即焚                       │
│     - NAS 宿主根、ZFS 存储池、家庭数据绝对零损伤             │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 Gondolin 的四大核心防御机制

1. **宿主推理与沙盒执行分离（Host Inference, Guest Execution）**：
   - Thebe 和 Pi 的核心逻辑、大模型 API 访问、认证会话全在宿主机上安全运行；
   - 仅将具有潜在副作用的工具（`bash`、`read`、`write`、`edit`）派发至 Micro-VM 内部执行。
2. **极速启动（Sub-second Boot）**：
   - 基于精简裁剪的 Linux Kernel 与极小 Alpine initramfs，利用 QEMU 或 experimental `libkrun`（基于 KVM / Hypervisor.framework），可在 **500ms ~ 1s** 内完成从开机到接收执行指令，实现真正的"按 Task / 按 Session 即起即销"。
3. **严格的 VFS 虚拟文件系统与挂载单点映射**：
   - 宿主机仅通过 `RealFSProvider` 将经过审查的特定项目目录挂载为虚拟机内的 `/workspace`；
   - 虚拟机内部看不到宿主机的真实挂载点（如 `/volume1`、`/mnt/storage`、`/etc`）；
   - 宿主侧校验路径：
     ```ts
     function toGuestPath(localCwd: string, localPath: string): string {
       const rel = path.relative(localCwd, localPath);
       if (rel === "") return "/workspace";
       if (rel.startsWith("..") || path.isAbsolute(rel)) {
         throw new Error(`path escapes workspace: ${localPath}`);
       }
       return path.posix.join("/workspace", rel.split(path.sep).join("/"));
     }
     ```
4. **可编程网络白名单与凭证防泄露（Placeholder Secret Injection）**：
   - 虚拟机内部不注入真实的 API Token 或私钥，仅暴露形如 `DUMMY_TOKEN` 的占位符；
   - 虚拟机发出的出网 HTTP 请求经过宿主机控制平面的 HTTP Hooks；只有目标域名命中白名单时，宿主机才在出网数据包中动态替换为真实凭证，虚拟机内的代码完全无法窃取或外发 Token。

### 2.2 Gondolin 在 NAS 场景下的局限性分析
虽然 Gondolin 是最具前景的硬件虚拟化方案，但在多样化的 Homelab/NAS 实际硬件中存在特定门槛：
- **硬件虚拟化依赖**：需要 CPU 支持 VT-x/AMD-V 并开启 `/dev/kvm`（或 macOS 的 `Hypervisor.framework`）。部分入门级 ARM NAS（如 Realtek/Rockchip 芯片的部分群晖/威联通机型）或在没有特权的 Docker 容器中部署时，无法获取 `/dev/kvm` 设备。
- **宿主原生容器运维断层**：Gondolin 中的 `bash` 无法直接管理宿主机的 Docker 容器，若需要运维宿主容器，必须建立专门的安全通道。

---

## 3. NAS / Homelab 全景隔离技术矩阵对比

为兼顾高安全性与广泛的 NAS 硬件兼容性，对业界现存的主流沙箱隔离技术进行全方位对比：

| 技术方案 | 隔离边界 | 启动耗时 | 资源占用 | 硬件要求 | NAS 普适性 | 适用场景 |
|---|---|---|---|---|---|---|
| **L3: Gondolin Micro-VM (QEMU/krun)** | 硬件虚拟化（独立 Linux 内核） | 500ms ~ 1s | 中 (~128MB RAM/VM) | 需 KVM (`/dev/kvm`) | 高（x86/ARM64 现代 NAS） | 高危未审查脚本、第三方不可信代码、全自动 YOLO 任务 |
| **L2A: Bubblewrap (`bwrap`)** | Linux Namespaces + Seccomp + Bind Mounts | < 10ms | 极低 (< 5MB RAM) | 普通 Linux 内核（支持 user namespaces） | 极高（几乎所有主流 Linux NAS） | 本地工作区强隔离、无 KVM 支持的 NAS、低延迟交互 |
| **L2B: gVisor (`runsc`)** | 用户态虚拟内核（拦截全部系统调用） | ~50ms | 低 (~20MB RAM) | 需安装 runsc 容器运行时 | 中（需管理员安装运行时） | 容器化部署 Thebe 的默认沙箱容器后端 |
| **L1: Docker Socket Proxy** | REST API 过滤层（Tecnativa） | 0 (直通) | 微秒级 | 无 | 100% | 过滤危险 API，阻断特权容器与宿主根挂载提权 |
| **L0: 小模型安全评估器 + 路径围栏** | 语义层 + 应用层路径比对 | 200~500ms | 零（外部模型或共享进程） | 无 | 100% | 第一道防线：识别意图、阻断存储池破坏、强制降级人审 |

---

## 4. Thebe 四层纵深防御体系设计（Defense-in-Depth）

针对 NAS 极高的数据安全要求，Thebe 确立如下 **四层纵深防御体系**：

```
                    ┌─────────────────────────┐
                    │    Agent 提议工具调用   │
                    │ (bash, container, write)│
                    └────────────┬────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 0: 小模型语义评估器 (Safety Evaluator)                           │
│  - 启发式规则拦截：ZFS/RAID/volume* 批量删除、裸设备写入、PID 1 击杀     │
│  - 专用小模型 (Qwen2.5:3b / Llama3.2:3b / gpt-4o-mini) 语义风险研判    │
│  - 判定结果：                                                          │
│    🛑 Critical  ──► 立即阻断拒绝 (Denied)                              │
│    ⚠️ Dangerous ──► 强制降级人工审批 (permission_requested)            │
│    ✅ Safe      ──► 放行进入下一层                                     │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │ 放行
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 1: 工作区强约束围栏 (Workspace Path Confinement)                 │
│  - 严格校验目标路径是否落在 session.workspacePath 范围之内             │
│  - 任何针对 /etc/、/volume1/、/mnt/、/root 的未授权越界写操作直接拦截  │
│  - 若确实需要全局操作，必须显式传递 allowGlobalEscapes 并触发二次人审  │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 2: 运行时环境隔离引擎 (按宿主能力自适应选择)                      │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ 方案 A (强隔离模式 - 首选): Gondolin Micro-VM                   │   │
│   │  - 宿主与执行机完全物理内存/内核解耦                           │   │
│   │  - 仅将 workspacePath 挂载为虚拟机的 /workspace                 │   │
│   │  - 虚拟机只读根，退出即焚，宿主网络白名单过滤                  │   │
│   └────────────────────────────────────────────────────────────────┘   │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ 方案 B (轻量通用模式 - 无 KVM NAS 备选): Bubblewrap (bwrap)     │   │
│   │  - 基于 Linux 用户命名空间，无需 root 权限                      │   │
│   │  - 系统根只读挂载 (`--ro-bind / /`)，临时文件内存化 (`--tmpfs`) │   │
│   │  - 仅指定 workspacePath 为读写挂载 (`--bind <path> <path>`)    │   │
│   │  - 剥离所有网络或绑定专用 network namespace                    │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Layer 3: 受控 Docker 控制面 (Docker Socket Proxy)                      │
│  - 严禁将宿主机 /var/run/docker.sock 裸暴露给 Agent                    │
│  - 通过代理代理 Docker API：                                           │
│    - 允许：GET /containers/json (查状态)、POST /containers/.../restart│
│    - 拒绝：POST /containers/create (携带 HostConfig.Privileged=true)  │
│    - 拒绝：POST /containers/create (携带 Binds 挂载了宿主 / 或 /volume)│
│    - 拒绝：POST /volumes/prune (防止误删持久卷)                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. 小模型审查机制在 NAS 场景的工程落地与 Prompt 设计

在 YOLO（免人工确认）模式下，虽然操作效率最高，但必须由**专用小模型**担任安全审查员。

### 5.1 为什么必须用小模型？
- **正则无法理解上下文语义**：例如 `find /volume1 -type f -mtime +30 -exec rm {} +` 是清理旧日志还是删除照片？正则很难区分参数意图，而小模型可以瞬间识破危险并指出"正在批量删除 NAS 存储目录下的文件"。
- **低成本与毫秒级延迟**：使用 3B 级别的轻量本地模型（如 `qwen2.5:3b`、`llama3.2:3b`，可通过本地 Ollama 极速推理，耗时仅 100~300ms），不消耗昂贵的商用大模型 token，且断网离线也能提供坚固防护。

### 5.2 专为 Homelab / NAS 定制的审查 Prompt 规范
在 `src/policy/safety-evaluator.ts` 中落地的提示词模板：

```text
### System Role:
You are the Safety Review Evaluator for Thebe, a specialized Homelab & NAS Infrastructure Agent.
Your primary duty is safeguarding irreplaceable NAS data (ZFS pools, RAID arrays, user photos, backups, Docker persistent volumes) and host stability against destructive actions.

### Context:
- Tool: bash
- Workspace Path: /volume1/docker/nginx-proxy
- YOLO Mode: Active (Auto-approval enabled unless flagged)
- Target Action/Command: rm -rf /volume1/data/backups

### Evaluation Guidelines:
1. CRITICAL: Unconditionally reject (e.g. raw disk writes, ZFS pool destroy, mass deletion of /volume*, /mnt/*, fork bombs, kernel panic, root deletion).
2. DANGEROUS: Require human confirmation (e.g. host shutdown/reboot, firewall flushing, host network disruption, writing outside workspace without permission, mass container removal, altering NAS share services).
3. CAUTION: Safe to run with warning in YOLO mode (e.g. restarting a single service, stopping a non-critical test container).
4. SAFE: Standard inspection, log viewing, status checks (e.g. uptime, docker ps, free, ping, df, reading compose files).

### Output Format:
Output strictly a JSON object with this format (no markdown fences):
{"safe": boolean, "risk": "safe"|"caution"|"dangerous"|"critical", "reason": "brief explanation"}
```

---

## 6. 分阶段落地与实施规划路线图

### 阶段一：应用与调度层强防护【当前已落地完成】
- [x] **小模型评估器抽象与 Ollama/OpenAI API 接入工厂**（`createSmallModelEvaluator`）。
- [x] **NAS 关键存储指令硬拦截**（覆盖 ZFS destroy、zpool split、mdadm stop、btrfs subvolume delete、`/volume*`、`/mnt/*` 批量擦除）。
- [x] **工作区越界检查器（Workspace Confinement Guard）**：
  - `write` 与 `edit` 工具强校验目标路径；
  - `bash` 针对越界文件操作强制拦截，标记 `isWorkspaceEscape: true`，强制降级为请求人工审批。
- [x] **会话元数据增加 `workspacePath` 与 `allowGlobalEscapes`**：
  - 支持 `POST /v1/session` 与 `PATCH /v1/session/:id` 动态配置。

### 阶段二：Bubblewrap (`bwrap`) 零依赖沙箱集成【近期规划】
针对 Linux NAS 宿主机（无需 KVM）：
- 当配置 `sandbox: "bwrap"` 时，Thebe 调用 `bwrap` 执行 `bash`：
  ```bash
  bwrap \
    --ro-bind / / \
    --tmpfs /tmp \
    --dev /dev \
    --proc /proc \
    --bind /volume1/docker/app /workspace \
    --chdir /workspace \
    --unshare-all \
    --share-net \
    --cap-drop ALL \
    /bin/sh -c "<command>"
  ```
- 效果：即使 Agent 是 root 用户，其对系统根目录、NAS 共享存储的写入也会被内核强行返回 `Read-only file system`，实现零逃逸。

### 阶段三：Gondolin Micro-VM 插件式接入【高级演进】
针对支持 KVM 的高性能 NAS / 主机：
- 提供 `@earendil-works/gondolin` 驱动适配器，提供 `GondolinToolRunner`；
- 启动会话时自动拉起秒级微虚拟机，通过 VFS 将 `workspacePath` 映射到 `/workspace`；
- 集成 HTTP Hooks 域名白名单与凭证占位符，实现网络层与硬件虚拟化物理级安全隔离。

---

## 7. 结论

**Thebe 绝不是一个放任 Agent 在宿主机上随意执行的通用 IDE 编码器，而是专为 NAS 与 Homelab 敏感资产守护打造的高安全性基础设施智能体。**

通过本次架构升级：
1. **小模型安全审查（Safety Evaluator）** 成为实时审视命令危害与意图的"智能哨兵"；
2. **工作区围栏（Workspace Confinement）** 确保一切操作默认收敛在指定的项目路径内，杜绝越界碰触不可替代的 NAS 核心数据；
3. **Gondolin Micro-VM / Bubblewrap 调研规划** 为未来彻底解耦执行态与宿主态提供了清晰可靠的工业级演进蓝图。
