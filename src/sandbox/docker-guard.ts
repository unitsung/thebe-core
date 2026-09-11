export type DockerRiskLevel = "safe" | "caution" | "dangerous" | "critical";

export interface DockerSecurityAssessment {
  allowed: boolean;
  risk: DockerRiskLevel;
  reason: string;
  warnings: string[];
  requiresHumanConfirmation: boolean;
}

/**
 * Inspects a Docker CLI command string for container breakout, privilege escalation,
 * and dangerous volume mounts that could jeopardize NAS / Homelab integrity.
 */
export function inspectDockerCommandSafety(command: string): DockerSecurityAssessment {
  const trimmed = command.trim();
  const warnings: string[] = [];

  // Check if command is docker or podman
  if (!/\b(docker|podman)\b/.test(trimmed)) {
    return {
      allowed: true,
      risk: "safe",
      reason: "Not a Docker command",
      warnings: [],
      requiresHumanConfirmation: false,
    };
  }

  // 1. Critical: Container breakout via privileged mode and host root mount
  if (
    /--privileged\b/.test(trimmed) &&
    /(-v|--volume)\s+(\/|(\/root|\/etc|\/volume\d+|\/mnt\/[a-zA-Z0-9_-]+)):/.test(trimmed)
  ) {
    return {
      allowed: false,
      risk: "critical",
      reason: "Container breakout attempt: --privileged mode combined with host root or NAS volume mount",
      warnings: ["Critical: Root/Volume mount with --privileged gives full host takeover capability"],
      requiresHumanConfirmation: false, // Strictly blocked
    };
  }

  // 2. Critical: Raw host root mount into container
  if (/(-v|--volume)\s+\/:/.test(trimmed)) {
    return {
      allowed: false,
      risk: "critical",
      reason: "Direct host root (/) bind mount into container is strictly prohibited",
      warnings: ["Mounting host root exposes all host files and storage arrays to the container"],
      requiresHumanConfirmation: false,
    };
  }

  // 3. Dangerous: Privileged mode without host root mount
  if (/--privileged\b/.test(trimmed)) {
    return {
      allowed: false,
      risk: "dangerous",
      reason: "Running container with --privileged grants all Linux kernel capabilities and device access",
      warnings: ["High risk: Privileged container can access host devices"],
      requiresHumanConfirmation: true,
    };
  }

  // 4. Dangerous: Docker socket mount inside a container
  if (/(-v|--volume)\s+\/var\/run\/docker\.sock:/.test(trimmed)) {
    return {
      allowed: false,
      risk: "dangerous",
      reason: "Mounting /var/run/docker.sock into a container gives root-equivalent access to the Docker daemon",
      warnings: ["High risk: Docker socket exposure enables arbitrary container deployment and privilege escalation"],
      requiresHumanConfirmation: true,
    };
  }

  // 5. Dangerous: Mass volume pruning
  if (/\b(docker|podman)\s+volume\s+prune\s+(-f|--force)\b/.test(trimmed)) {
    return {
      allowed: false,
      risk: "dangerous",
      reason: "Mass volume pruning destroys persistent data for all stopped containers",
      warnings: ["High risk: Irreversible data deletion from container volumes"],
      requiresHumanConfirmation: true,
    };
  }

  // 6. Dangerous: Host network mode combined with interactive shell
  if (/--net(work)?=host\b/.test(trimmed) && /\b(run|exec)\b/.test(trimmed)) {
    warnings.push("Container uses host network stack, allowing port binding on host interfaces");
  }

  // 7. Caution: Standard container lifecycle operations (restart, stop, rm)
  if (/\b(docker|podman)\s+(restart|stop|rm)\b/.test(trimmed)) {
    return {
      allowed: true,
      risk: "caution",
      reason: "Container lifecycle change",
      warnings,
      requiresHumanConfirmation: false,
    };
  }

  // 8. Safe: Inspection and query commands
  return {
    allowed: true,
    risk: "safe",
    reason: "Standard Docker command",
    warnings,
    requiresHumanConfirmation: false,
  };
}
