import type { DockerProxyPolicy } from "./docker-api-guard.ts";
import type { SandboxMode } from "./command-sandbox.ts";
import { sandboxAvailability } from "./command-sandbox.ts";

/**
 * What the host decides about command safety. The command guard is always on, files and commands stay
 * confined to the workspace, and the Docker API guard blocks privileged containers, host-root and
 * docker.sock mounts and volume pruning. The one thing a host chooses is the sandbox
 * (`THEBE_SANDBOX`); a session lifts all of it only through `bypassPermissions`.
 */
export type HostSecurity = {
  commandGuard: true;
  workspaceEscapes: false;
  sandboxMode: SandboxMode;
  sandboxNetwork: true;
  dockerGuard: Required<DockerProxyPolicy>;
};

const DOCKER_GUARD: Required<DockerProxyPolicy> = {
  blockPrivileged: true,
  blockHostRootMounts: true,
  blockDockerSocketMount: true,
  blockVolumePrune: true,
};

/**
 * `THEBE_SANDBOX=auto` picks the backend this machine can run: seatbelt on macOS, bubblewrap on
 * Linux. `off` (also what an unset or unknown value means) runs commands directly. A backend can also
 * be named: `bwrap`, `docker`, `seatbelt` or `gondolin`.
 */
export function parseSandboxMode(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
  available: Record<SandboxMode, boolean> = sandboxAvailability()
): SandboxMode {
  const mode = value?.trim().toLowerCase();
  if (mode === "auto") {
    const native: SandboxMode = platform === "darwin" ? "seatbelt" : "bwrap";
    if (available[native]) return native;
    // Nothing native to use: Docker if it is there, else name the native one so the report says it is missing.
    return available.docker ? "docker" : native;
  }
  if (
    mode === "off" ||
    mode === "bwrap" ||
    mode === "docker" ||
    mode === "seatbelt" ||
    mode === "gondolin"
  ) {
    return mode;
  }
  return "off";
}

export function resolveHostSecurity(
  env: NodeJS.ProcessEnv = process.env,
  available?: Record<SandboxMode, boolean>
): HostSecurity {
  return {
    commandGuard: true,
    workspaceEscapes: false,
    sandboxMode: parseSandboxMode(env.THEBE_SANDBOX, process.platform, available),
    sandboxNetwork: true,
    dockerGuard: DOCKER_GUARD,
  };
}
