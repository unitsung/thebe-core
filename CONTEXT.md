# Thebe Core

Homelab 上常驻的 Agent。Agent loop 由 Pi 提供，本仓库只写 Homelab 自己的能力。

## Language

**Thebe Core**:
本仓库与其上运行的那个 Agent。包名与仓库名是 `thebe-core`。
_Avoid_: thebe-agent-core, Thebe Agent Core, core_v0

**Pi**:
Earendil Works 的 Agent 运行时（`@earendil-works/pi-agent-core` 及相关包）。Thebe Core 在其上构建，不自写 agent loop。
_Avoid_: 用 "pi" 指代树莓派或任何宿主机

**Host**:
Thebe Core 运行的那台常驻机器。
_Avoid_: pi, Raspberry Pi（除非确实在说那块硬件）

**ContainerInfoProvider**:
容器只读观测的唯一能力声明。工具层只依赖此接口，不感知底层面板。

**Arcane**:
当前唯一的容器面板。Thebe Core 不直连 docker.sock。
