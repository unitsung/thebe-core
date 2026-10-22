import { existsSync } from "node:fs";
import type { DockerProxyPolicy } from "./docker-api-guard.ts";

/**
 * What the host decides about command safety. The command guard is always on,
 * files and commands stay confined to the workspace, and the Docker API guard
 * blocks privileged containers, host-root and docker.sock mounts and volume
 * pruning. The sandbox is not a menu: a container runs without one, a host
 * uses the OS sandbox unless Agent settings turn it off. `THEBE_SANDBOX=off`
 * and a container force it off. A session lifts all of it only through
 * `bypassPermissions`.
 */
export type SandboxMode = "off" | "os";

export type SandboxForce = {
  source: "environment" | "derived";
  message: string;
};

/** User preference from Agent settings. `undefined` keeps the host default (on). */
let configuredSandbox: boolean | undefined;

export function setConfiguredSandboxEnabled(
  enabled: boolean | undefined
): void {
  configuredSandbox = enabled;
}

export function configuredSandboxEnabled(): boolean | undefined {
  return configuredSandbox;
}

export type HostSecurity = {
  commandGuard: true;
  workspaceEscapes: false;
  sandboxMode: SandboxMode;
  dockerGuard: Required<DockerProxyPolicy>;
};

const DOCKER_GUARD: Required<DockerProxyPolicy> = {
  blockPrivileged: true,
  blockHostRootMounts: true,
  blockDockerSocketMount: true,
  blockVolumePrune: true,
};

/** True when this process is already inside a container (the release boundary). */
export function coreRunsInContainer(
  exists: (path: string) => boolean = existsSync
): boolean {
  return exists("/.dockerenv") || exists("/run/.containerenv");
}

/**
 * Why the OS sandbox cannot be turned on from the TUI or a client.
 * `THEBE_SANDBOX=off` wins over the saved preference. A container never nests one.
 */
export function sandboxForcedOff(
  env: NodeJS.ProcessEnv = process.env,
  options: { inContainer?: boolean } = {}
): SandboxForce | undefined {
  if (env.THEBE_SANDBOX?.trim().toLowerCase() === "off") {
    return {
      source: "environment",
      message:
        "THEBE_SANDBOX=off keeps the OS sandbox off. Unset it to change this in the TUI or a client.",
    };
  }
  if (options.inContainer ?? coreRunsInContainer()) {
    return {
      source: "derived",
      message:
        "This Core is running in a container, so the OS sandbox stays off.",
    };
  }
  return undefined;
}

/**
 * Unset, blank, and every value other than `off` follow the install shape:
 * `os` on a host, `off` in a container. A saved `sandboxEnabled: false` turns
 * a host off without an environment variable. Old backend names are ignored.
 */
export function resolveHostSecurity(
  env: NodeJS.ProcessEnv = process.env,
  options: { inContainer?: boolean } = {}
): HostSecurity {
  const inContainer = options.inContainer ?? coreRunsInContainer();
  return {
    commandGuard: true,
    workspaceEscapes: false,
    sandboxMode: sandboxModeFromEnv(env.THEBE_SANDBOX, inContainer),
    dockerGuard: DOCKER_GUARD,
  };
}

function sandboxModeFromEnv(
  value: string | undefined,
  inContainer: boolean
): SandboxMode {
  const mode = value?.trim().toLowerCase();
  if (mode === "off" || inContainer) return "off";
  if (configuredSandbox === false) return "off";
  return "os";
}
