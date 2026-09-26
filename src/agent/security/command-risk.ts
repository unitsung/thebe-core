import { isAbsolute, relative, resolve } from "node:path";
import {
  inspectDockerCommandSafety,
} from "./docker-command-guard.ts";
import {
  validateDockerApiRequest,
  type DockerProxyPolicy,
} from "./docker-api-guard.ts";

/**
 * Homelab/NAS command risk heuristics.
 *
 * Ported from the pre-refactor `src/policy/safety-evaluator.ts` (recovered from
 * the 2026-09 audit branches): the pattern tables carry the storage-system
 * knowledge — ZFS, Btrfs, EXT4, NTFS, NFS — plus NAS volume deletion, host
 * RAID/block-device writes, container breakouts, and the workspace-escape
 * check. The small-model review that used to live beside it is dev's
 * `src/agent/judgment/`; this module stays pure and heuristic.
 */

export type CommandRiskLevel = "safe" | "caution" | "dangerous" | "critical";

export type StorageSystem = "zfs" | "btrfs" | "ext4" | "ntfs" | "nfs" | "general";

export type CommandRiskCategory =
  | "filesystem"
  | "network"
  | "container"
  | "system"
  | "credential"
  | "storage"
  | "general";

export type CommandRiskAssessment = {
  /** False when policy must decide instead of auto-running: critical (blocked) or dangerous (human). */
  allowed: boolean;
  risk: CommandRiskLevel;
  reason: string;
  warnings: string[];
  requiresConfirmation: boolean;
  category: CommandRiskCategory;
  workspaceEscape?: boolean;
  storageSystem?: StorageSystem;
};

type RiskRule = {
  pattern: RegExp;
  reason: string;
  category: CommandRiskCategory;
  storageSystem?: StorageSystem;
};

export type AssessToolCallOptions = {
  workspacePath?: string;
  /** Explicit opt-in to escape the workspace (old `allowGlobalEscapes`). */
  allowGlobalEscapes?: boolean;
  cache?: CommandRiskCache | null;
  /** Docker control-plane policy for direct Docker API calls; see scenario profiles. */
  dockerGuard?: DockerProxyPolicy;
};


export interface CommandRiskCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export class CommandRiskCache {
  private cache = new Map<string, { assessment: CommandRiskAssessment; expiresAt: number }>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(options?: CommandRiskCacheOptions) {
    this.maxEntries = options?.maxEntries ?? 1000;
    this.ttlMs = options?.ttlMs ?? 1000 * 60 * 10; // 10 minutes default
  }

  get(key: string): CommandRiskAssessment | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.assessment;
  }

  set(key: string, assessment: CommandRiskAssessment): void {
    if (this.cache.size >= this.maxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, {
      assessment,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export const defaultCommandRiskCache = new CommandRiskCache();

const CRITICAL_PATTERNS: RiskRule[] = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)*(\/|\/\*|\/etc|\/var|\/usr|\/boot|\/dev|\/sys|\/proc|\/bin|\/sbin|\/home|\/root|~)(\s|$|\/)/,
    reason: "Catastrophic file deletion targeting root, system, or home directory",
    category: "filesystem",
  },
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+)*(\/volume\d+|\/mnt\/[a-zA-Z0-9_-]+|\/shares?|\/data)(\s|$|\/|\/\*)/,
    reason: "Catastrophic mass deletion of NAS storage dataset, pool, or shared volume",
    category: "storage",
    storageSystem: "general",
  },
  // --- ZFS Critical ---
  {
    pattern: /\b(zfs\s+(destroy|rollback\s+-r)|zpool\s+(destroy|split|labelclear))\b/,
    reason: "Destruction of ZFS filesystem dataset, storage pool, or vdev on-disk label",
    category: "storage",
    storageSystem: "zfs",
  },
  {
    pattern: /\bzpool\s+export\s+.*-f\b/,
    reason: "Forceful unexport of active ZFS storage pool",
    category: "storage",
    storageSystem: "zfs",
  },
  // --- Btrfs Critical ---
  {
    pattern: /\b(btrfs\s+(subvolume\s+delete|device\s+(delete|remove))|mkfs\.btrfs)\b/,
    reason: "Destruction of Btrfs storage subvolume, device removal, or filesystem creation",
    category: "storage",
    storageSystem: "btrfs",
  },
  {
    pattern: /\bbtrfs\s+check\s+.*--repair\b/,
    reason: "Running 'btrfs check --repair' is extremely dangerous and prone to catastrophic Btrfs metadata corruption",
    category: "storage",
    storageSystem: "btrfs",
  },
  // --- NTFS Critical ---
  {
    pattern: /\b(mkfs\.ntfs|mkntfs)\b/,
    reason: "NTFS volume format/creation destroys existing partition data",
    category: "storage",
    storageSystem: "ntfs",
  },
  {
    pattern: /\bntfsclone\s+.*(--overwrite|-O)\b/,
    reason: "Raw overwriting of NTFS partition via ntfsclone",
    category: "storage",
    storageSystem: "ntfs",
  },
  {
    pattern: /\bntfswipe\b/,
    reason: "Wiping NTFS partition structures or data",
    category: "storage",
    storageSystem: "ntfs",
  },
  // --- EXT4 / EXT3 / EXT2 Critical ---
  {
    pattern: /\b(mkfs(\.(ext[234]|xfs|f2fs|vfat))?|mke2fs)\b/,
    reason: "Filesystem formatting or creation (ext4/xfs/f2fs)",
    category: "storage",
    storageSystem: "ext4",
  },
  {
    pattern: /\bdebugfs\s+.*-w\b/,
    reason: "Raw block/inode write debug on ext filesystem",
    category: "storage",
    storageSystem: "ext4",
  },
  {
    pattern: /\bresize2fs\s+.*-M\b/,
    reason: "Shrinking ext filesystem to minimal size without verification",
    category: "storage",
    storageSystem: "ext4",
  },
  // --- NFS Critical ---
  {
    pattern: /\bexportfs\s+.*(-u\s+-a|-ua|-au)\b/,
    reason: "Abrupt unexport of ALL NFS shares disconnects all network clients and causes client hangs",
    category: "storage",
    storageSystem: "nfs",
  },
  {
    pattern: /(^|[;&|\s])(rm\s+.*|truncate\s+.*|>\s*)\/etc\/exports(\.d(\/.*)?)?\b/,
    reason: "Destructive removal or truncation of NFS exports configuration",
    category: "storage",
    storageSystem: "nfs",
  },
  // --- Host RAID & Physical Disk Critical ---
  {
    pattern: /\bmdadm\s+.*(--stop|--zero-superblock)\b/,
    reason: "Host RAID array disruption or superblock destruction",
    category: "storage",
    storageSystem: "general",
  },
  {
    pattern: /\b(fdisk|parted|gdisk)\b/,
    reason: "Disk partition table manipulation",
    category: "storage",
    storageSystem: "general",
  },
  {
    pattern: /\bdd\s+.*of=\/dev\/(sd[a-z]|nvme\d+n\d+|vd[a-z]|hd[a-z]|loop\d+)\b/,
    reason: "Raw write to disk block device",
    category: "storage",
    storageSystem: "general",
  },
  {
    pattern: />\s*\/dev\/(sd[a-z]|nvme\d+n\d+|vd[a-z]|hd[a-z])\b/,
    reason: "Direct redirection into physical storage device",
    category: "storage",
    storageSystem: "general",
  },
  // --- System / Container Critical ---
  {
    pattern: /:\(\)\{\s*:\|:&\s*\};:/,
    reason: "Fork bomb script detected",
    category: "system",
  },
  {
    pattern: /\bkill\s+(-9|-KILL)\s+1\b/,
    reason: "Attempt to kill system init / PID 1",
    category: "system",
  },
  {
    pattern: /\bdocker\s+run\s+.*(-v|--volume)\s+\/:.*--privileged\b/,
    reason: "Docker container escape attempting to mount host root in privileged mode",
    category: "container",
  },
];

const DANGEROUS_PATTERNS: RiskRule[] = [
  {
    pattern: /\b(shutdown|reboot|poweroff|init\s+[06]|systemctl\s+(poweroff|reboot|halt))\b/,
    reason: "Host reboot, shutdown, or poweroff",
    category: "system",
  },
  {
    pattern: /\b(iptables\s+(-[FXZ]|--flush)|nft\s+flush|ufw\s+(disable|reset))\b/,
    reason: "Host firewall flush or disable could expose homelab or disconnect network",
    category: "network",
  },
  {
    pattern: /\b(ip\s+link\s+set\s+.*down|ifconfig\s+.*down)\b/,
    reason: "Bringing down primary network interface",
    category: "network",
  },
  {
    pattern: /\b(docker|podman)\s+rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(\$\((docker|podman)\s+ps|`\s*(docker|podman)\s+ps|.*-a\b)/,
    reason: "Mass destructive deletion of all containers",
    category: "container",
  },
  {
    pattern: /\b(docker|podman)\s+volume\s+prune\s+(-f|--force)\b/,
    reason: "Mass destruction of container persistent data volumes",
    category: "container",
  },
  {
    pattern: /\b(cat|grep|tail|head)\s+.*\/etc\/shadow\b/,
    reason: "Attempted inspection of system password hashes",
    category: "credential",
  },
  {
    pattern: /\b(chmod|chown|echo|sed|tee)\s+.*\/etc\/sudoers\b/,
    reason: "Modification of host sudoers privilege configuration",
    category: "credential",
  },
  // --- ZFS Dangerous ---
  {
    pattern: /\bzpool\s+(offline|detach|remove|replace|clear)\b/,
    reason: "Offlining, detaching, removing, or replacing ZFS storage pool device",
    category: "storage",
    storageSystem: "zfs",
  },
  {
    pattern: /\bzfs\s+(rollback\b|unmount\b|set\s+(quota|reservation)=)/,
    reason: "ZFS snapshot rollback, dataset unmount, or quota alteration",
    category: "storage",
    storageSystem: "zfs",
  },
  // --- Btrfs Dangerous ---
  {
    pattern: /\bbtrfs\s+(balance\s+(start|cancel)|subvolume\s+set-default|filesystem\s+defrag|rescue)\b/,
    reason: "Btrfs balance rechunking, default subvolume alteration, defragmentation, or rescue operation",
    category: "storage",
    storageSystem: "btrfs",
  },
  {
    pattern: /\bbtrfs\s+device\s+(add|replace)\b/,
    reason: "Btrfs storage device addition or live disk replacement",
    category: "storage",
    storageSystem: "btrfs",
  },
  // --- EXT4 Dangerous ---
  {
    pattern: /\btune2fs\s+.*(-[OojE]|--feature)\b/,
    reason: "Altering EXT4 superblock flags, features, or journal on active filesystem",
    category: "storage",
    storageSystem: "ext4",
  },
  {
    pattern: /\bresize2fs\b/,
    reason: "Resizing EXT4 filesystem partition",
    category: "storage",
    storageSystem: "ext4",
  },
  {
    pattern: /\b(e2fsck|fsck\.ext[234])\s+.*(-y|-p)\b/,
    reason: "Unattended forced repair of EXT4 filesystem may drop corrupted inodes",
    category: "storage",
    storageSystem: "ext4",
  },
  // --- NTFS Dangerous ---
  {
    pattern: /\b(ntfsfix|ntfsresize)\b/,
    reason: "Running ntfsfix repairs or resizing NTFS volume without backup",
    category: "storage",
    storageSystem: "ntfs",
  },
  {
    pattern: /\bmount\s+.*(-t\s+ntfs(-3g)?\s+.*-o\s+.*force|-o\s+.*force.*-t\s+ntfs(-3g)?)\b/,
    reason: "Forced mounting of NTFS volume with corrupted journal or dirty bit",
    category: "storage",
    storageSystem: "ntfs",
  },
  // --- NFS Dangerous ---
  {
    pattern: /\bexportfs\s+.*(-u\s+[^\s]+|-r|-ra)\b/,
    reason: "Unexporting specific NFS share or re-exporting active network shares",
    category: "storage",
    storageSystem: "nfs",
  },
  {
    pattern: /\bumount\s+.*(-f|-l)\s+(\/mnt\/|\/volume|\/export|\/shares?)\b/,
    reason: "Forceful or lazy unmounting of active shared storage mount",
    category: "storage",
    storageSystem: "nfs",
  },
  {
    pattern: /\b(systemctl\s+(stop|disable)|service\s+.*\s+stop)\s+(smbd|nfs-kernel-server|nfs-server|rpcbind|nfs-idmapd|sshd|docker|containerd)\b/,
    reason: "Stopping essential host/NAS network, storage, or virtualization service",
    category: "system",
  },
];

const CAUTION_PATTERNS: RiskRule[] = [
  {
    pattern: /\b(docker|podman)\s+(stop|restart)\b/,
    reason: "Stopping or restarting containerized service",
    category: "container",
  },
  {
    pattern: /\b(systemctl\s+(stop|restart)|service\s+.*\s+(stop|restart))\b/,
    reason: "Restarting or stopping system services",
    category: "system",
  },
  {
    pattern: /\b(chmod\s+-R|chown\s+-R)\b/,
    reason: "Recursive permission or ownership alteration",
    category: "filesystem",
  },
  {
    pattern: /\b(btrfs\s+scrub\s+start|zpool\s+scrub\s+[^\s]+)\b/,
    reason: "Initiating filesystem scrub causes sustained disk IO load",
    category: "storage",
  },
  {
    pattern: /\bexportfs\s+(-a|--all)\b/,
    reason: "Synchronizing or refreshing all NFS export tables",
    category: "storage",
    storageSystem: "nfs",
  },
];

/** Docker Engine API paths the guard understands, as seen in curl/podman calls. */
const DOCKER_API_PATH =
  /\/v?[0-9.]*\/(containers\/create|containers\/prune|volumes\/prune|images\/prune|build\/prune|system\/prune)/i;
const DOCKER_API_MARKER = /\bdocker\.sock\b|DOCKER_HOST=|\/v1\.[0-9]+\//;

function extractDockerApiBody(command: string): unknown | undefined {
  const match = /(?:-d|--data|--data-binary|--data-raw)\s+(['"])([\s\S]*?)\1/.exec(
    command,
  );
  if (!match?.[2]) return undefined;
  try {
    return JSON.parse(match[2]);
  } catch {
    return undefined;
  }
}

/**
 * Screens Docker Engine API calls issued directly over the socket (curl, podman
 * remote), which never contain the `docker <verb>` shape the CLI rules catch.
 * Returns `undefined` when the command is not such a call or the guard allows it.
 */
function assessDockerApiCall(
  command: string,
  policy?: DockerProxyPolicy,
): CommandRiskAssessment | undefined {
  if (!DOCKER_API_MARKER.test(command)) return undefined;
  const pathMatch = DOCKER_API_PATH.exec(command);
  if (!pathMatch) return undefined;

  const pathname = `/${(pathMatch[1] ?? "").toLowerCase()}`;
  const methodMatch = /(?:-X|--request)\s+([A-Za-z]+)/.exec(command);
  const method = methodMatch?.[1]
    ? methodMatch[1].toUpperCase()
    : /(?:^|\s)(?:-d|--data|--data-binary|--data-raw)\s/.test(command)
      ? "POST"
      : "GET";
  const body = extractDockerApiBody(command);

  if (pathname === "/containers/create" && method === "POST" && body === undefined) {
    return {
      allowed: false,
      risk: "dangerous",
      reason:
        "Docker API container creation whose body could not be inspected must be reviewed",
      warnings: [
        "Docker API: /containers/create with an unparsed body bypasses static container hardening checks",
      ],
      requiresConfirmation: true,
      category: "container",
    };
  }

  const verdict = validateDockerApiRequest(method, pathname, body, policy);
  if (verdict.allowed) return undefined;

  return {
    allowed: false,
    risk: "critical",
    reason: verdict.reason ?? `Docker API ${method} ${pathname} is blocked`,
    warnings: [
      `Critical risk: ${verdict.reason ?? "Docker API call blocked by policy"}`,
      ...(verdict.violation ? [`violation: ${verdict.violation}`] : []),
    ],
    requiresConfirmation: false,
    category: "container",
  };
}

/** Whether a target path escapes the workspace root (ported `checkWorkspaceEscape`). */
export function detectWorkspaceEscape(
  targetPath: string,
  workspacePath: string,
): { isEscape: boolean; normalizedTarget: string; normalizedWorkspace: string } {
  const normWorkspace = resolve(workspacePath);
  const normTarget = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(normWorkspace, targetPath);

  const rel = relative(normWorkspace, normTarget);
  const isEscape = rel.startsWith("..") || isAbsolute(rel);
  return {
    isEscape,
    normalizedTarget: normTarget,
    normalizedWorkspace: normWorkspace,
  };
}

export function assessCommand(
  command: string,
  options: { dockerGuard?: DockerProxyPolicy } = {},
): CommandRiskAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      allowed: true,
      risk: "safe",
      reason: "Empty command",
      warnings: [],
      requiresConfirmation: false,
      category: "general",
    };
  }

  // 1. Check critical (unconditionally blocked)
  for (const item of CRITICAL_PATTERNS) {
    if (item.pattern.test(trimmed)) {
      return {
        allowed: false,
        risk: "critical",
        reason: item.reason,
        warnings: [`Critical risk: ${item.reason}`],
        requiresConfirmation: false, // strictly blocked
        category: item.category,
        storageSystem: item.storageSystem,
      };
    }
  }

  // 2. Check dedicated Docker container safety
  if (/\b(docker|podman)\b/.test(trimmed)) {
    const dockerAssessment = inspectDockerCommandSafety(trimmed);
    if (dockerAssessment.risk === "critical" || dockerAssessment.risk === "dangerous") {
      return {
        allowed: dockerAssessment.allowed,
        risk: dockerAssessment.risk,
        reason: dockerAssessment.reason,
        warnings: dockerAssessment.warnings,
        requiresConfirmation: dockerAssessment.requiresConfirmation,
        category: "container",
      };
    }
  }

  // 2b. Docker Engine API calls made directly (curl/podman socket), where the CLI
  // rules above never see the `docker` subcommand. `docker-api-guard.ts` decides.
  const apiAssessment = assessDockerApiCall(trimmed, options.dockerGuard);
  if (apiAssessment) return apiAssessment;

  // 3. Check dangerous (requires human confirmation, blocked from automatic YOLO execution)
  for (const item of DANGEROUS_PATTERNS) {
    if (item.pattern.test(trimmed)) {
      return {
        allowed: false,
        risk: "dangerous",
        reason: item.reason,
        warnings: [`High risk: ${item.reason}`],
        requiresConfirmation: true,
        category: item.category,
        storageSystem: item.storageSystem,
      };
    }
  }

  // 4. Check caution (allowed in YOLO with warning)
  for (const item of CAUTION_PATTERNS) {
    if (item.pattern.test(trimmed)) {
      return {
        allowed: true,
        risk: "caution",
        reason: item.reason,
        warnings: [`Caution: ${item.reason}`],
        requiresConfirmation: false,
        category: item.category,
        storageSystem: item.storageSystem,
      };
    }
  }

  // Detect storage inspection tool for safe inspection commands
  let detectedStorage: StorageSystem | undefined;
  if (/\b(zfs|zpool)\b/.test(trimmed)) detectedStorage = "zfs";
  else if (/\bbtrfs\b/.test(trimmed)) detectedStorage = "btrfs";
  else if (/\b(ext[234]|tune2fs|dumpe2fs|resize2fs|e2fsck|e2label)\b/.test(trimmed)) detectedStorage = "ext4";
  else if (/\b(ntfs|ntfs-3g|ntfsinfo|ntfsls|ntfscluster)\b/.test(trimmed)) detectedStorage = "ntfs";
  else if (/\b(nfs|exportfs|showmount|nfsstat)\b/.test(trimmed)) detectedStorage = "nfs";

  return {
    allowed: true,
    risk: "safe",
    reason: "Command passed safety heuristics",
    warnings: [],
    requiresConfirmation: false,
    category: detectedStorage ? "storage" : "general",
    storageSystem: detectedStorage,
  };
}

/** `assessCommand` with the shared cache; repeated approvals reuse the verdict. */
export function assessCommandCached(
  command: string,
  cache: CommandRiskCache | null = defaultCommandRiskCache,
  options: { dockerGuard?: DockerProxyPolicy } = {},
): CommandRiskAssessment {
  // The Docker API policy changes verdicts, so it bypasses the shared cache.
  if (!cache || options.dockerGuard) return assessCommand(command, options);
  const cached = cache.get(command);
  if (cached) return cached;
  const assessment = assessCommand(command);
  cache.set(command, assessment);
  return assessment;
}

/**
 * Risk for one tool call. Bash commands go through the heuristic table; `write`
 * and `edit` check system paths and workspace confinement; container tools get
 * their fixed lifecycle rating.
 */
export function assessToolCall(
  toolName: string,
  input: unknown,
  options: AssessToolCallOptions = {},
): CommandRiskAssessment {
  if (toolName === "bash" || toolName === "sh") {
    const command =
      typeof input === "string"
        ? input
        : input && typeof input === "object"
          ? String((input as Record<string, unknown>).command ?? "")
          : "";
    const assessment = assessCommandCached(command, options.cache, {
      dockerGuard: options.dockerGuard,
    });
    if (
      options.workspacePath &&
      (assessment.risk === "critical" || assessment.risk === "dangerous")
    ) {
      assessment.workspaceEscape = commandTouchesOutsideWorkspace(
        command,
        options.workspacePath,
      );
    }
    if (
      options.workspacePath &&
      !options.allowGlobalEscapes &&
      assessment.risk !== "critical" &&
      assessment.risk !== "dangerous"
    ) {
      const escaping = mutatingCommandEscape(command, options.workspacePath);
      if (escaping) return escaping;
    }
    return assessment;
  }

  if (toolName.startsWith("container.")) {
    if (toolName === "container.restart" || toolName === "container.stop") {
      return {
        allowed: true,
        risk: "caution",
        reason: `Container lifecycle operation: ${toolName}`,
        warnings: [`Operation on container: ${toolName}`],
        requiresConfirmation: false,
        category: "container",
      };
    }
    return {
      allowed: true,
      risk: "safe",
      reason: `Read/inspect container tool: ${toolName}`,
      warnings: [],
      requiresConfirmation: false,
      category: "container",
    };
  }

  if (toolName === "write" || toolName === "edit") {
    const target =
      input && typeof input === "object"
        ? String((input as Record<string, unknown>).path ?? "")
        : "";
    const systemPath = SENSITIVE_WRITE_PREFIXES.find(
      (prefix) => target.startsWith(prefix),
    );
    if (systemPath) {
      return {
        allowed: false,
        risk: "dangerous",
        reason: `Attempt to write to sensitive system path: ${target}`,
        warnings: [`Write targeted at ${target}`],
        requiresConfirmation: true,
        category: "filesystem",
      };
    }
    if (options.workspacePath && target && !options.allowGlobalEscapes) {
      const check = detectWorkspaceEscape(target, options.workspacePath);
      if (check.isEscape) {
        return {
          allowed: false,
          risk: "dangerous",
          reason: `[Workspace Escape Detected] Operation target '${target}' is outside authorized workspace '${options.workspacePath}'`,
          warnings: [`Path outside workspace: ${target}`],
          requiresConfirmation: true,
          category: "filesystem",
          workspaceEscape: true,
        };
      }
    }
  }

  return {
    allowed: true,
    risk: "safe",
    reason: `Standard tool call: ${toolName}`,
    warnings: [],
    requiresConfirmation: false,
    category: "general",
  };
}

const SENSITIVE_WRITE_PREFIXES = ["/etc/", "/boot/", "/sys/", "/dev/", "/proc/"];

function commandTouchesOutsideWorkspace(
  command: string,
  workspacePath: string,
): boolean | undefined {
  const paths = command
    .split(/\s+/)
    .filter((part) => part.startsWith("/") || part.startsWith("../"));
  const escape = paths.some((path) => detectWorkspaceEscape(path, workspacePath).isEscape);
  return escape ? true : undefined;
}

function mutatingCommandEscape(
  command: string,
  workspacePath: string,
): CommandRiskAssessment | undefined {
  const match = /\b(rm|mv|cp|touch|truncate|chmod|chown)\s+([^\n;|&]+)/.exec(command);
  if (!match) return undefined;
  const paths = (match[2] ?? "")
    .split(/\s+/)
    .filter((part) => part.startsWith("/") || part.startsWith("../"));
  for (const path of paths) {
    if (!detectWorkspaceEscape(path, workspacePath).isEscape) continue;
    return {
      allowed: false,
      risk: "dangerous",
      reason: `[Workspace Escape Detected] Command operates on path '${path}' outside authorized workspace '${workspacePath}'`,
      warnings: [`Workspace escape detected on: ${path}`],
      requiresConfirmation: true,
      category: "filesystem",
      workspaceEscape: true,
    };
  }
  return undefined;
}

/**
 * Approval preflight for a tool call: `deny` blocks critical commands, `ask`
 * raises confirmation for dangerous ones, `undefined` leaves the decision to
 * the workspace policy.
 */
export function commandGuardPreflight(
  toolName: string,
  input: unknown,
  options: AssessToolCallOptions = {},
): "deny" | "ask" | undefined {
  if (toolName !== "bash" && toolName !== "sh" && toolName !== "write" && toolName !== "edit") {
    return undefined;
  }
  const assessment = assessToolCall(toolName, input, options);
  if (assessment.risk === "critical") return "deny";
  if (assessment.risk === "dangerous") return "ask";
  return undefined;
}

/** Whether the guard runs (`THEBE_COMMAND_GUARD=off` disables it). */
export function commandGuardEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.THEBE_COMMAND_GUARD?.trim().toLowerCase() !== "off";
}
