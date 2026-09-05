# Thebe Core

Host 上常驻的 Agent。loop 由 Pi 提供，本仓库不自写 agent loop。v0.3 先验证四个只读容器工具。

## Language

**Thebe Core**:
本仓库，以及跑在 Host 上的那个 Agent。包名与仓库名是 `thebe-core`。
_Avoid_: thebe-agent-core, Thebe Agent Core, core_v0, 把它降成不含 Agent 的面板代理

**Pi**:
Earendil Works 的 Agent 运行时。本仓库以库的方式依赖 `@earendil-works/pi-agent-core`，进程和入口是我们的。
_Avoid_: 用 "pi" 指代 Host 或树莓派（spec 原文里的 "pi" 一律读成 Host）；把官方 `pi` CLI 当成本产品入口

**Host**:
Thebe Core 运行的那台常驻机器。v0.3 不监听端口。
_Avoid_: pi, Raspberry Pi（除非确实在说那块硬件）

**Tool Layer**:
v0.3 对外能力面，且只有 `container.list` / `container.inspect` / `container.logs` / `container.status_summary`。不注册 Pi 内置的 read / bash / edit / write，也没有文件系统工具。
_Avoid_: 在接口、配置或开关里再声明一份「允许什么」

**ContainerInfoProvider**:
容器只读观测的唯一能力声明。Tool Layer 和 PolicyEngine 只认这个接口。
_Avoid_: 让工具代码 import 任何面板 SDK 或 HTTP 客户端

**Arcane**:
当前唯一的容器面板。Thebe Core 不直连 docker.sock。v0.3 只维护 ArcaneAdapter，不做多面板、不接 Dockge。

**PolicyEngine**:
对 Tool Layer 的方法白名单、预算计数和脱敏规则。白名单与四个方法名相同。`container.logs` 默认每日 1000 次，其余先不设上限。

**AuditLog**:
不可变、只追加的本地日志。v0.3 为明文 JSONL；加密是后一刀。记录时间戳、方法名、参数哈希、返回字节数、预算消耗、是否脱敏。

**Ask**:
v0.3 的 CLI 入口：一次提问，走 Pi loop 和四个容器工具。不是 status / logs / abort / doctor 套件。
