import type { DockerProxyPolicy } from "./docker-api-guard.ts";
import type { SandboxMode } from "./command-sandbox.ts";

/**
 * Deployment scenario presets.
 *
 * Ported from the pre-refactor `src/policy/scenario-profile.ts`, where a session
 * carried a `scenario` that decided its sandbox mode, workspace escapes, and the
 * strictness of the safety layer. In this layout a scenario is a preset over the
 * switches the agent actually has — the command guard, workspace confinement,
 * the bash sandbox, and the Docker API guard — and `THEBE_SCENARIO` selects one.
 * Explicit environment variables always win over the preset.
 */

export type ScenarioName =
  | "nas-strict"
  | "homelab-host"
  | "microvm-sandbox"
  | "yolo-guarded";

export type ScenarioProfile = {
  name: ScenarioName;
  description: string;
  /** Heuristic command screening. Model review is `src/agent/judgment/`. */
  /**
   * Heuristic command screening. Critical findings are always evaluated before
   * remembered permissions, which is the old `strictZfsRaidProtection` intent.
   */
  commandGuard: { enabled: boolean };
  /** Workspace confinement for file tools and mutating commands. */
  workspace: {
    enforceConfinement: boolean;
    allowGlobalEscapes: boolean;
  };
  /** Process isolation for the bash tool. */
  sandbox: {
    mode: SandboxMode;
    dropCapabilities: boolean;
    readOnlyHost: boolean;
    isolateNetwork: boolean;
  };
  /** Docker control-plane policy. */
  dockerGuard: Required<DockerProxyPolicy>;
};

export const SCENARIO_PROFILES: Record<ScenarioName, ScenarioProfile> = {
  "nas-strict": {
    name: "nas-strict",
    description:
      "Maximum protection for NAS data (ZFS pools, RAID arrays, photos, backups, Docker volumes).",
    commandGuard: { enabled: true },
    workspace: { enforceConfinement: true, allowGlobalEscapes: false },
    sandbox: {
      mode: "bwrap",
      dropCapabilities: true,
      readOnlyHost: true,
      isolateNetwork: false,
    },
    dockerGuard: {
      blockPrivileged: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    },
  },
  "homelab-host": {
    name: "homelab-host",
    description:
      "Balanced security for homelab server management and host diagnosis (Proxmox, Ubuntu/Debian).",
    commandGuard: { enabled: true },
    workspace: { enforceConfinement: true, allowGlobalEscapes: true },
    sandbox: {
      mode: "off",
      dropCapabilities: false,
      readOnlyHost: false,
      isolateNetwork: false,
    },
    dockerGuard: {
      blockPrivileged: false,
      blockHostRootMounts: true,
      blockDockerSocketMount: false,
      blockVolumePrune: true,
    },
  },
  "microvm-sandbox": {
    name: "microvm-sandbox",
    description:
      "Complete hardware virtualization isolation for running untrusted scripts and tools.",
    commandGuard: { enabled: true },
    workspace: { enforceConfinement: true, allowGlobalEscapes: false },
    sandbox: {
      mode: "gondolin",
      dropCapabilities: true,
      readOnlyHost: true,
      isolateNetwork: true,
    },
    dockerGuard: {
      blockPrivileged: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    },
  },
  "yolo-guarded": {
    name: "yolo-guarded",
    description:
      "Fast autonomous operations with a multi-layer safety floor and automatic screening.",
    commandGuard: { enabled: true },
    workspace: { enforceConfinement: true, allowGlobalEscapes: false },
    sandbox: {
      mode: "bwrap",
      dropCapabilities: true,
      readOnlyHost: true,
      isolateNetwork: false,
    },
    dockerGuard: {
      blockPrivileged: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    },
  },
};

export type ScenarioSettings = {
  scenario?: ScenarioName;
  commandGuard: boolean;
  workspaceEscapes: boolean;
  sandboxMode: SandboxMode;
  sandboxNetwork: boolean;
  dockerGuard: Required<DockerProxyPolicy>;
};

export type ScenarioProfileOverrides = Partial<{
  name: ScenarioName;
  description: string;
  commandGuard: Partial<ScenarioProfile["commandGuard"]>;
  workspace: Partial<ScenarioProfile["workspace"]>;
  sandbox: Partial<ScenarioProfile["sandbox"]>;
  dockerGuard: Partial<ScenarioProfile["dockerGuard"]>;
}>;

export function getScenarioProfile(
  name: ScenarioName = "nas-strict",
  overrides?: ScenarioProfileOverrides
): ScenarioProfile {
  const base = SCENARIO_PROFILES[name] ?? SCENARIO_PROFILES["nas-strict"];
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    commandGuard: { ...base.commandGuard, ...overrides.commandGuard },
    workspace: { ...base.workspace, ...overrides.workspace },
    sandbox: { ...base.sandbox, ...overrides.sandbox },
    dockerGuard: { ...base.dockerGuard, ...overrides.dockerGuard },
  };
}

export function listScenarioProfiles(): ScenarioProfile[] {
  return Object.values(SCENARIO_PROFILES);
}

/** `THEBE_SCENARIO=<name>`; unknown values mean "no scenario". */
export function scenarioFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ScenarioName | undefined {
  const raw = env.THEBE_SCENARIO?.trim().toLowerCase();
  if (!raw) return undefined;
  return (Object.keys(SCENARIO_PROFILES) as ScenarioName[]).find(
    (name) => name === raw
  );
}

function parseSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (
    value === "off" ||
    value === "bwrap" ||
    value === "docker" ||
    value === "seatbelt" ||
    value === "gondolin"
  ) {
    return value;
  }
  return undefined;
}

/**
 * Effective switches: the scenario preset first, then explicit `THEBE_*`
 * overrides. Without a scenario the defaults keep the pre-scenario behaviour
 * (guard on, sandbox off, network on, escapes confined).
 */
export function resolveScenarioSettings(
  scenario: ScenarioName | undefined = scenarioFromEnv(),
  env: NodeJS.ProcessEnv = process.env
): ScenarioSettings {
  const profile = scenario ? getScenarioProfile(scenario) : undefined;
  const guardOverride = env.THEBE_COMMAND_GUARD?.trim().toLowerCase();
  const networkOverride = env.THEBE_SANDBOX_NETWORK?.trim().toLowerCase();
  const escapesOverride =
    env.THEBE_ALLOW_WORKSPACE_ESCAPES?.trim().toLowerCase();

  return {
    scenario,
    commandGuard:
      guardOverride === "off"
        ? false
        : guardOverride === "on"
          ? true
          : (profile?.commandGuard.enabled ?? true),
    workspaceEscapes:
      escapesOverride === undefined
        ? (profile?.workspace.allowGlobalEscapes ?? false)
        : escapesOverride === "true" || escapesOverride === "1",
    sandboxMode:
      parseSandboxMode(env.THEBE_SANDBOX?.trim().toLowerCase()) ??
      profile?.sandbox.mode ??
      "off",
    sandboxNetwork:
      networkOverride === undefined
        ? !(profile?.sandbox.isolateNetwork ?? false)
        : networkOverride !== "deny",
    dockerGuard: profile?.dockerGuard ?? {
      blockPrivileged: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    },
  };
}
