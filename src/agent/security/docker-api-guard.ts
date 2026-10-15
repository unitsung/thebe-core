/**
 * Docker Engine API guard.
 *
 * Ported from the pre-refactor `src/sandbox/docker-proxy.ts`: validates
 * Docker-API-shaped requests (container create, volume/system prune) so a proxy
 * or the command guard can refuse container breakout and NAS data loss before
 * the daemon sees it. `command-risk.ts` uses it for docker-socket calls made
 * through curl, and `host-security.ts` supplies the policy.
 */

export interface DockerApiValidationResult {
  allowed: boolean;
  statusCode?: number;
  reason?: string;
  violation?: string;
}

export interface DockerProxyPolicy {
  blockPrivileged?: boolean;
  blockHostRootMounts?: boolean;
  blockDockerSocketMount?: boolean;
  blockVolumePrune?: boolean;
}

/**
 * Validates Docker Engine REST API requests to prevent container breakout,
 * host takeover, or accidental persistent volume deletion.
 */
export function validateDockerApiRequest(
  method: string,
  pathname: string,
  body?: unknown,
  policy: DockerProxyPolicy = {
    blockPrivileged: true,
    blockHostRootMounts: true,
    blockDockerSocketMount: true,
    blockVolumePrune: true,
  }
): DockerApiValidationResult {
  const normPath = pathname.replace(/^\/v[0-9.]+/, "");

  // 1. Container creation security checks
  if (method === "POST" && normPath === "/containers/create") {
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      const hostConfig = (obj.HostConfig ?? {}) as Record<string, unknown>;

      // Privileged mode check
      if (policy.blockPrivileged && hostConfig.Privileged === true) {
        return {
          allowed: false,
          statusCode: 403,
          reason:
            "Forbidden by Thebe Docker Guard: Privileged container creation is blocked",
          violation: "HostConfig.Privileged=true",
        };
      }

      // Volume / bind mounts check
      const binds = Array.isArray(hostConfig.Binds)
        ? hostConfig.Binds.map(String)
        : [];
      for (const bind of binds) {
        const hostSource = bind.split(":")[0]?.trim();
        if (
          policy.blockHostRootMounts &&
          (hostSource === "/" || hostSource === "/root")
        ) {
          return {
            allowed: false,
            statusCode: 403,
            reason: `Forbidden by Thebe Docker Guard: Direct host root (${hostSource}) bind mount is blocked`,
            violation: `HostConfig.Binds: ${bind}`,
          };
        }
        if (
          policy.blockDockerSocketMount &&
          hostSource &&
          hostSource.includes("docker.sock")
        ) {
          return {
            allowed: false,
            statusCode: 403,
            reason:
              "Forbidden by Thebe Docker Guard: Mounting docker.sock inside container is blocked",
            violation: `HostConfig.Binds: ${bind}`,
          };
        }
      }

      // Capability checks
      const capAdd = Array.isArray(hostConfig.CapAdd)
        ? hostConfig.CapAdd.map(String)
        : [];
      if (
        policy.blockPrivileged &&
        capAdd.some(
          (c) => c.toUpperCase() === "ALL" || c.toUpperCase() === "SYS_ADMIN"
        )
      ) {
        return {
          allowed: false,
          statusCode: 403,
          reason:
            "Forbidden by Thebe Docker Guard: Adding SYS_ADMIN or ALL capabilities is blocked",
          violation: `HostConfig.CapAdd: ${capAdd.join(",")}`,
        };
      }
    }
  }

  // 2. Volume and system prune checks
  if (
    method === "POST" &&
    (normPath === "/volumes/prune" || normPath === "/system/prune")
  ) {
    if (policy.blockVolumePrune) {
      return {
        allowed: false,
        statusCode: 403,
        reason:
          "Forbidden by Thebe Docker Guard: Volume pruning is blocked to prevent NAS data loss",
        violation: normPath,
      };
    }
  }

  return { allowed: true };
}
