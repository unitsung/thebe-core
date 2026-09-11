import type { SandboxMode } from "../sandbox/types.ts";

export type ScenarioName =
  | "nas-strict"
  | "homelab-host"
  | "microvm-sandbox"
  | "yolo-guarded";

export interface ScenarioProfile {
  name: ScenarioName;
  description: string;
  /** Layer 0: Small model evaluator policy */
  evaluator: {
    enabled: boolean;
    requireForYolo: boolean;
    requireForMutations: boolean;
    strictZfsRaidProtection: boolean;
  };
  /** Layer 1: Workspace path jail policy */
  workspace: {
    enforceConfinement: boolean;
    allowGlobalEscapes: boolean;
    allowHostInspectionReads: boolean;
    resolveSymlinks: boolean;
  };
  /** Layer 2: Process namespace sandbox policy */
  sandbox: {
    mode: SandboxMode;
    dropCapabilities: boolean;
    readOnlyHost: boolean;
    isolateNetwork: boolean;
  };
  /** Layer 3: Docker control plane & virtualization policy */
  dockerGuard: {
    blockPrivilegedContainers: boolean;
    blockHostRootMounts: boolean;
    blockDockerSocketMount: boolean;
    blockVolumePrune: boolean;
  };
}

export const SCENARIO_PROFILES: Record<ScenarioName, ScenarioProfile> = {
  "nas-strict": {
    name: "nas-strict",
    description: "Maximum protection for NAS data (ZFS pools, RAID arrays, photos, backups, Docker volumes).",
    evaluator: {
      enabled: true,
      requireForYolo: true,
      requireForMutations: true,
      strictZfsRaidProtection: true,
    },
    workspace: {
      enforceConfinement: true,
      allowGlobalEscapes: false,
      allowHostInspectionReads: true,
      resolveSymlinks: true,
    },
    sandbox: {
      mode: "bwrap",
      dropCapabilities: true,
      readOnlyHost: true,
      isolateNetwork: false,
    },
    dockerGuard: {
      blockPrivilegedContainers: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    },
  },
  "homelab-host": {
    name: "homelab-host",
    description: "Balanced security for Homelab server management and host diagnosis (Proxmox, Ubuntu/Debian).",
    evaluator: {
      enabled: true,
      requireForYolo: true,
      requireForMutations: false,
      strictZfsRaidProtection: true,
    },
    workspace: {
      enforceConfinement: true,
      allowGlobalEscapes: true, // allowed with explicit confirmation
      allowHostInspectionReads: true,
      resolveSymlinks: true,
    },
    sandbox: {
      mode: "workspace-jail",
      dropCapabilities: false,
      readOnlyHost: false,
      isolateNetwork: false,
    },
    dockerGuard: {
      blockPrivilegedContainers: false,
      blockHostRootMounts: true,
      blockDockerSocketMount: false,
      blockVolumePrune: true,
    },
  },
  "microvm-sandbox": {
    name: "microvm-sandbox",
    description: "Complete hardware virtualization isolation for running untrusted scripts and tools.",
    evaluator: {
      enabled: true,
      requireForYolo: false,
      requireForMutations: false,
      strictZfsRaidProtection: true,
    },
    workspace: {
      enforceConfinement: true,
      allowGlobalEscapes: false,
      allowHostInspectionReads: false,
      resolveSymlinks: true,
    },
    sandbox: {
      mode: "gondolin",
      dropCapabilities: true,
      readOnlyHost: true,
      isolateNetwork: true,
    },
    dockerGuard: {
      blockPrivilegedContainers: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    },
  },
  "yolo-guarded": {
    name: "yolo-guarded",
    description: "Fast autonomous operations with multi-layer safety floor and automatic screening.",
    evaluator: {
      enabled: true,
      requireForYolo: true,
      requireForMutations: false,
      strictZfsRaidProtection: true,
    },
    workspace: {
      enforceConfinement: true,
      allowGlobalEscapes: false,
      allowHostInspectionReads: true,
      resolveSymlinks: true,
    },
    sandbox: {
      mode: "bwrap",
      dropCapabilities: true,
      readOnlyHost: true,
      isolateNetwork: false,
    },
    dockerGuard: {
      blockPrivilegedContainers: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    },
  },
};

export function getScenarioProfile(
  name: ScenarioName = "nas-strict",
  overrides?: Partial<ScenarioProfile>,
): ScenarioProfile {
  const base = SCENARIO_PROFILES[name] ?? SCENARIO_PROFILES["nas-strict"];
  if (!overrides) {
    return base;
  }
  return {
    ...base,
    ...overrides,
    evaluator: { ...base.evaluator, ...(overrides.evaluator ?? {}) },
    workspace: { ...base.workspace, ...(overrides.workspace ?? {}) },
    sandbox: { ...base.sandbox, ...(overrides.sandbox ?? {}) },
    dockerGuard: { ...base.dockerGuard, ...(overrides.dockerGuard ?? {}) },
  };
}

export function listScenarioProfiles(): ScenarioProfile[] {
  return Object.values(SCENARIO_PROFILES);
}

