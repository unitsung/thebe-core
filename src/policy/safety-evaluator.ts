import path from "node:path";
import { inspectDockerCommandSafety } from "../sandbox/docker-guard.ts";

export type SafetyRiskLevel = "safe" | "caution" | "dangerous" | "critical";

export type StorageSystemType = "zfs" | "btrfs" | "ext4" | "ntfs" | "nfs" | "general";

export type SafetyAssessment = {
  allowed: boolean;
  risk: SafetyRiskLevel;
  reason: string;
  warnings: string[];
  requiresHumanConfirmation: boolean;
  category: "filesystem" | "network" | "container" | "system" | "credential" | "storage" | "general";
  isWorkspaceEscape?: boolean;
  storageSystem?: StorageSystemType;
};

type SafetyRule = {
  pattern: RegExp;
  reason: string;
  category: SafetyAssessment["category"];
  storageSystem?: StorageSystemType;
};

export interface EvaluatorCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

export class EvaluatorCache {
  private cache = new Map<string, { assessment: SafetyAssessment; expiresAt: number }>();
  private maxEntries: number;
  private ttlMs: number;

  constructor(options?: EvaluatorCacheOptions) {
    this.maxEntries = options?.maxEntries ?? 1000;
    this.ttlMs = options?.ttlMs ?? 1000 * 60 * 10; // 10 minutes default
  }

  get(key: string): SafetyAssessment | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.assessment;
  }

  set(key: string, assessment: SafetyAssessment): void {
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

export const defaultEvaluatorCache = new EvaluatorCache();

export interface SafetyEvaluatorOptions {
  workspacePath?: string;
  allowGlobalEscapes?: boolean;
  isYolo?: boolean;
  cache?: EvaluatorCache | null;
}

/**
 * Hard heuristic patterns designed specifically for Homelab and NAS environments.
 * Catches catastrophic or destructive actions before execution.
 */
const CRITICAL_PATTERNS: SafetyRule[] = [
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

const DANGEROUS_PATTERNS: SafetyRule[] = [
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

const CAUTION_PATTERNS: SafetyRule[] = [
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

/**
 * Checks if a target path escapes the specified workspace path.
 */
export function checkWorkspaceEscape(
  targetPath: string,
  workspacePath: string,
): { isEscape: boolean; normalizedTarget: string; normalizedWorkspace: string } {
  const normWorkspace = path.resolve(workspacePath);
  const normTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(normWorkspace, targetPath);

  const rel = path.relative(normWorkspace, normTarget);
  const isEscape = rel.startsWith("..") || path.isAbsolute(rel);
  return {
    isEscape,
    normalizedTarget: normTarget,
    normalizedWorkspace: normWorkspace,
  };
}

/**
 * Evaluates command safety using heuristic pattern analysis.
 */
export function evaluateHeuristicCommandSafety(command: string): SafetyAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      allowed: true,
      risk: "safe",
      reason: "Empty command",
      warnings: [],
      requiresHumanConfirmation: false,
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
        requiresHumanConfirmation: false, // strictly blocked
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
        requiresHumanConfirmation: dockerAssessment.requiresHumanConfirmation,
        category: "container",
      };
    }
  }

  // 3. Check dangerous (requires human confirmation, blocked from automatic YOLO execution)
  for (const item of DANGEROUS_PATTERNS) {
    if (item.pattern.test(trimmed)) {
      return {
        allowed: false,
        risk: "dangerous",
        reason: item.reason,
        warnings: [`High risk: ${item.reason}`],
        requiresHumanConfirmation: true,
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
        requiresHumanConfirmation: false,
        category: item.category,
        storageSystem: item.storageSystem,
      };
    }
  }

  // Detect storage inspection tool for safe inspection commands
  let detectedStorage: StorageSystemType | undefined;
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
    requiresHumanConfirmation: false,
    category: detectedStorage ? "storage" : "general",
    storageSystem: detectedStorage,
  };
}

export type EvaluatorModelFn = (prompt: string) => Promise<string>;

export interface SmallModelEvaluatorConfig {
  /** Endpoint URL (e.g., http://127.0.0.1:11434/v1 for Ollama, or OpenAI-compatible endpoint) */
  endpoint?: string;
  /** Optional API Key */
  apiKey?: string;
  /** Small model identifier, e.g. "qwen2.5:3b", "llama3.2:3b", "gpt-4o-mini" */
  model: string;
  /** Timeout in ms before falling back to heuristics (default 3000ms) */
  timeoutMs?: number;
}

/**
 * Creates a Small Model Evaluator for semantic safety review.
 */
export function createSmallModelEvaluator(
  config: SmallModelEvaluatorConfig,
  fetchFn: typeof fetch = globalThis.fetch,
): EvaluatorModelFn {
  return async (prompt: string): Promise<string> => {
    const endpoint = (config.endpoint || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
    const url = `${endpoint}/chat/completions`;
    const controller = new AbortController();
    const timeout = config.timeoutMs ?? 3000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (config.apiKey) {
        headers["authorization"] = `Bearer ${config.apiKey}`;
      }

      const res = await fetchFn(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: "system",
              content:
                "You are the Safety Evaluator for Thebe, a Homelab/NAS Infrastructure Agent. Your job is protecting NAS data and host stability. Output strict JSON only.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0,
        }),
      });

      if (!res.ok) {
        throw new Error(`Evaluator model HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as any;
      return (
        data.choices?.[0]?.message?.content ??
        data.choices?.[0]?.text ??
        "{}"
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Formulates the safety review prompt tailored for Homelab & NAS environments.
 */
export function buildSafetyPrompt(
  command: string,
  context?: {
    toolName: string;
    workspacePath?: string;
    isYolo?: boolean;
  },
): string {
  return [
    "### System Role:",
    "You are the Safety Review Evaluator for Thebe, a specialized Homelab & NAS Infrastructure Agent.",
    "Your primary duty is safeguarding irreplaceable NAS data across major storage systems (ZFS pools, Btrfs subvolumes, EXT4 partitions, NTFS external disks, NFS exports, user photos, backups, Docker persistent volumes) and host stability against destructive actions.",
    "",
    "### Context:",
    `- Tool: ${context?.toolName ?? "bash"}`,
    `- Workspace Path: ${context?.workspacePath ?? "N/A (Global)"}`,
    `- YOLO Mode: ${context?.isYolo ? "Active (Auto-approval enabled unless flagged)" : "Manual"}`,
    `- Target Action/Command: ${command}`,
    "",
    "### Storage System Guidelines (ZFS, Btrfs, EXT4, NTFS, NFS):",
    "1. CRITICAL: Unconditionally reject with risk='critical':",
    "   - ZFS: 'zpool destroy/split/labelclear', 'zfs destroy -r', recursive rollback, forced export.",
    "   - Btrfs: 'btrfs subvolume delete', 'btrfs device delete/remove', 'btrfs check --repair' (causes metadata collapse), 'mkfs.btrfs'.",
    "   - EXT4: 'mkfs.ext*', 'mke2fs -F', 'debugfs -w' (raw write), blind shrink 'resize2fs -M'.",
    "   - NTFS: 'mkfs.ntfs', 'mkntfs', 'ntfsclone --overwrite', 'ntfswipe'.",
    "   - NFS: 'exportfs -u -a' / 'exportfs -ua' (dropping all client mounts), destructive edits to '/etc/exports'.",
    "   - General: raw disk writes ('dd ... of=/dev/sd*'), mass deletion ('rm -rf /volume*', '/mnt/*'), fork bombs, killing PID 1.",
    "2. DANGEROUS: Require human confirmation with risk='dangerous':",
    "   - ZFS: 'zpool offline/detach/remove/replace', single snapshot rollbacks, 'zfs unmount -f'.",
    "   - Btrfs: 'btrfs balance start/cancel', 'btrfs subvolume set-default', defragmentation, rescue modes.",
    "   - EXT4: 'tune2fs -O' (altering live superblock), partition resizing 'resize2fs', unattended 'e2fsck -y'.",
    "   - NTFS: 'ntfsfix', 'ntfsresize', forced mounting with '-o force'.",
    "   - NFS: 'exportfs -u <share>', 'exportfs -r', force unmounting active network mounts ('umount -f /mnt/...'), stopping nfs/rpcbind.",
    "   - Host: shutdown, reboot, firewall flush ('iptables -F', 'ufw disable'), network down ('ip link set down'), writing outside workspace without permission.",
    "3. CAUTION: Safe to run with warning in YOLO mode with risk='caution':",
    "   - Starting disk scrub ('zpool scrub', 'btrfs scrub start'), service restarts, single non-critical container restarts.",
    "4. SAFE: Standard inspection, read-only status checks with risk='safe':",
    "   - Storage: 'zpool status/list', 'zfs list/get', 'btrfs filesystem show/df', 'dumpe2fs', 'ntfsinfo', 'exportfs -v', 'showmount -e', 'df -h'.",
    "   - System: 'uptime', 'docker ps', 'free', 'ping', reading compose files.",
    "",
    "### Output Format:",
    'Output strictly a JSON object with this format (no markdown fences):',
    '{"safe": boolean, "risk": "safe"|"caution"|"dangerous"|"critical", "reason": "brief explanation", "storageSystem": "zfs"|"btrfs"|"ext4"|"ntfs"|"nfs"|"general"}',
  ].join("\n");
}

/**
 * Performs evaluation on a tool call (heuristic first, workspace check, then model evaluation if ambiguous or requested).
 */
export async function evaluateToolSafety(
  toolName: string,
  input: unknown,
  evaluatorModel?: EvaluatorModelFn,
  options?: SafetyEvaluatorOptions,
): Promise<SafetyAssessment> {
  let cmd = "";
  if (toolName === "bash" || toolName === "sh") {
    if (typeof input === "string") {
      cmd = input;
    } else if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      cmd = String(obj.command ?? obj.cmd ?? "");
    }
  } else if (toolName.startsWith("container.")) {
    if (toolName === "container.restart" || toolName === "container.stop") {
      return {
        allowed: true,
        risk: "caution",
        reason: `Container lifecycle operation: ${toolName}`,
        warnings: [`Operation on container: ${toolName}`],
        requiresHumanConfirmation: false,
        category: "container",
      };
    }
    return {
      allowed: true,
      risk: "safe",
      reason: `Read/inspect container tool: ${toolName}`,
      warnings: [],
      requiresHumanConfirmation: false,
      category: "container",
    };
  } else {
    // For non-bash tools: check write/edit on system files and workspace confinement
    if (toolName === "write" || toolName === "edit") {
      const targetPath = typeof input === "object" && input !== null
        ? String((input as Record<string, unknown>).path ?? "")
        : "";

      // 1. Critical/dangerous system targets
      if (
        targetPath.startsWith("/etc/") ||
        targetPath.startsWith("/boot/") ||
        targetPath.startsWith("/sys/") ||
        targetPath.startsWith("/dev/") ||
        targetPath.startsWith("/proc/")
      ) {
        return {
          allowed: false,
          risk: "dangerous",
          reason: `Attempt to write to sensitive system path: ${targetPath}`,
          warnings: [`Write targeted at ${targetPath}`],
          requiresHumanConfirmation: true,
          category: "filesystem",
        };
      }

      // 2. Check workspace confinement if defined
      if (options?.workspacePath && targetPath) {
        const check = checkWorkspaceEscape(targetPath, options.workspacePath);
        if (check.isEscape && !options.allowGlobalEscapes) {
          return {
            allowed: false,
            risk: "dangerous",
            reason: `[Workspace Escape Detected] Operation target '${targetPath}' is outside authorized workspace '${options.workspacePath}'`,
            warnings: [`Path outside workspace: ${targetPath}`],
            requiresHumanConfirmation: true,
            category: "filesystem",
            isWorkspaceEscape: true,
          };
        }
      }
    }

    return {
      allowed: true,
      risk: "safe",
      reason: `Standard tool call: ${toolName}`,
      warnings: [],
      requiresHumanConfirmation: false,
      category: "general",
    };
  }

  // 1. Run fast heuristic evaluation
  const heuristic = evaluateHeuristicCommandSafety(cmd);
  if (heuristic.risk === "critical" || heuristic.risk === "dangerous") {
    if (options?.workspacePath) {
      const words = cmd.split(/\s+/).filter((p) => p.startsWith("/") || p.startsWith("../"));
      for (const p of words) {
        if (checkWorkspaceEscape(p, options.workspacePath).isEscape) {
          heuristic.isWorkspaceEscape = true;
          break;
        }
      }
    }
    return heuristic;
  }

  // 2. Check workspace confinement for bash if workspacePath is enforced
  if (options?.workspacePath && !options.allowGlobalEscapes) {
    // Detect mutating commands operating on paths outside workspace
    const isMutatingCmd = /\b(rm|mv|cp|touch|truncate|chmod|chown)\s+([^\n;|&]+)/.exec(cmd);
    if (isMutatingCmd) {
      const targetArg = isMutatingCmd[2]?.trim() ?? "";
      // Check absolute paths or escaping relative paths
      const paths = targetArg.split(/\s+/).filter((p) => p.startsWith("/") || p.startsWith("../"));
      for (const p of paths) {
        const check = checkWorkspaceEscape(p, options.workspacePath);
        if (check.isEscape) {
          return {
            allowed: false,
            risk: "dangerous",
            reason: `[Workspace Escape Detected] Command operates on path '${p}' outside authorized workspace '${options.workspacePath}'`,
            warnings: [`Workspace escape detected on: ${p}`],
            requiresHumanConfirmation: true,
            category: "filesystem",
            isWorkspaceEscape: true,
          };
        }
      }
    }
  }

  // 3. If evaluator model provided and command is non-trivial, run model-based review
  if (evaluatorModel && cmd.length > 5) {
    const cache = options?.cache === null ? null : (options?.cache ?? defaultEvaluatorCache);
    const cacheKey = `${toolName}:${options?.workspacePath ?? ""}:${cmd.trim()}`;
    if (cache) {
      const cached = cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    try {
      const prompt = buildSafetyPrompt(cmd, {
        toolName,
        workspacePath: options?.workspacePath,
        isYolo: options?.isYolo ?? true,
      });

      const responseText = await evaluatorModel(prompt);
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          safe?: boolean;
          risk?: SafetyRiskLevel;
          reason?: string;
          storageSystem?: StorageSystemType;
        };
        const risk: SafetyRiskLevel = parsed.risk ?? (parsed.safe ? "safe" : "dangerous");
        const allowed = Boolean(parsed.safe ?? (risk === "safe" || risk === "caution"));
        const reason = parsed.reason ?? "Model review completed";
        const assessment: SafetyAssessment = {
          allowed,
          risk,
          reason,
          warnings: allowed ? [] : [reason],
          requiresHumanConfirmation: !allowed,
          category: heuristic.category === "storage" ? "storage" : (parsed.storageSystem ? "storage" : heuristic.category),
          storageSystem: parsed.storageSystem ?? heuristic.storageSystem,
        };
        if (cache) {
          cache.set(cacheKey, assessment);
        }
        return assessment;
      }
    } catch {
      // On model failure, fall back to heuristic result
    }
  }

  return heuristic;
}
