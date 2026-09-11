import { describe, expect, it, vi } from "vitest";
import {
  evaluateHeuristicCommandSafety,
  evaluateToolSafety,
  checkWorkspaceEscape,
  createSmallModelEvaluator,
  buildSafetyPrompt,
  EvaluatorCache,
} from "./safety-evaluator.ts";

describe("safety-evaluator (Homelab & NAS YOLO mode safety guardrails)", () => {
  it("detects critical commands and strictly blocks them", () => {
    const dangerousCommands = [
      "rm -rf /",
      "rm -rf /*",
      "rm -rf /etc/nginx",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda bs=1M",
      ":(){ :|:& };:",
      "kill -9 1",
      "> /dev/sda",
      // NAS-specific critical commands
      "zfs destroy tank/photos",
      "zpool destroy tank",
      "mdadm --stop /dev/md0",
      "btrfs subvolume delete /mnt/data/subvol",
      "rm -rf /volume1/shared_data",
      "rm -rf /mnt/user/backups",
      "docker run -v /:/host --privileged alpine sh",
    ];

    for (const cmd of dangerousCommands) {
      const res = evaluateHeuristicCommandSafety(cmd);
      expect(res.allowed).toBe(false);
      expect(res.risk).toBe("critical");
      expect(res.requiresHumanConfirmation).toBe(false);
    }
  });

  it("detects dangerous commands and forces human confirmation in YOLO mode", () => {
    const dangerousCommands = [
      "reboot",
      "shutdown -h now",
      "iptables -F",
      "ufw disable",
      "ip link set eth0 down",
      "docker rm -f $(docker ps -aq)",
      "docker volume prune -f",
      "cat /etc/shadow",
      // NAS-specific dangerous commands
      "systemctl stop smbd",
      "systemctl stop nfs-kernel-server",
      "zpool offline tank sda",
      "chmod 777 /etc/sudoers",
    ];

    for (const cmd of dangerousCommands) {
      const res = evaluateHeuristicCommandSafety(cmd);
      expect(res.allowed).toBe(false);
      expect(res.risk).toBe("dangerous");
      expect(res.requiresHumanConfirmation).toBe(true);
    }
  });

  it("allows safe commands in YOLO mode without confirmation", () => {
    const safeCommands = [
      "docker ps",
      "docker logs nginx",
      "ls -la /var/log",
      "uptime",
      "free -m",
      "df -h",
      "cat /etc/hosts",
      "curl https://api.ipify.org",
      "systemctl status docker",
    ];

    for (const cmd of safeCommands) {
      const res = evaluateHeuristicCommandSafety(cmd);
      expect(res.allowed).toBe(true);
      expect(res.risk).toBe("safe");
      expect(res.requiresHumanConfirmation).toBe(false);
    }
  });

  it("evaluates write tool targeting system files as dangerous", async () => {
    const res = await evaluateToolSafety("write", {
      path: "/etc/sudoers",
      content: "test",
    });
    expect(res.allowed).toBe(false);
    expect(res.risk).toBe("dangerous");
    expect(res.requiresHumanConfirmation).toBe(true);
  });

  it("enforces workspace confinement on write/edit tools", async () => {
    const workspace = "/volume1/docker/nginx-service";

    // 1. Inside workspace -> safe
    const inside = await evaluateToolSafety(
      "write",
      { path: "/volume1/docker/nginx-service/nginx.conf", content: "server {}" },
      undefined,
      { workspacePath: workspace },
    );
    expect(inside.allowed).toBe(true);
    expect(inside.isWorkspaceEscape).toBeFalsy();

    // 2. Outside workspace -> dangerous workspace escape
    const outside = await evaluateToolSafety(
      "write",
      { path: "/volume1/photos/family.jpg", content: "malicious" },
      undefined,
      { workspacePath: workspace },
    );
    expect(outside.allowed).toBe(false);
    expect(outside.risk).toBe("dangerous");
    expect(outside.isWorkspaceEscape).toBe(true);
    expect(outside.reason).toContain("Workspace Escape Detected");
  });

  it("enforces workspace confinement on mutating bash commands", async () => {
    const workspace = "/volume1/docker/myapp";

    // Modifying outside workspace
    const escape = await evaluateToolSafety(
      "bash",
      { command: "rm -f /volume1/shared_documents/report.pdf" },
      undefined,
      { workspacePath: workspace },
    );
    expect(escape.allowed).toBe(false);
    expect(escape.isWorkspaceEscape).toBe(true);
    expect(escape.reason).toContain("Workspace Escape Detected");
  });

  it("invokes evaluator model for model-based safety review", async () => {
    const mockModel = vi.fn().mockResolvedValue(
      JSON.stringify({
        safe: false,
        risk: "dangerous",
        reason: "Detected custom script altering network routing tables",
      }),
    );

    const res = await evaluateToolSafety(
      "bash",
      { command: "route add -net 10.0.0.0 netmask 255.0.0.0 gw 192.168.1.1" },
      mockModel,
    );

    expect(mockModel).toHaveBeenCalled();
    expect(res.allowed).toBe(false);
    expect(res.risk).toBe("dangerous");
    expect(res.reason).toContain("routing tables");
    expect(res.requiresHumanConfirmation).toBe(true);
  });

  it("creates and invokes small model evaluator with OpenAI-compatible endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                safe: false,
                risk: "dangerous",
                reason: "Suspicious manipulation of kernel parameters via sysctl",
              }),
            },
          },
        ],
      }),
    });

    const smallModelEvaluator = createSmallModelEvaluator(
      {
        endpoint: "http://127.0.0.1:11434/v1",
        model: "qwen2.5:3b",
        timeoutMs: 2000,
      },
      mockFetch as any,
    );

    const prompt = buildSafetyPrompt("sysctl -w net.ipv4.ip_forward=0", {
      toolName: "bash",
      workspacePath: "/opt/homelab",
      isYolo: true,
    });

    const resultText = await smallModelEvaluator(prompt);
    const parsed = JSON.parse(resultText);
    expect(parsed.safe).toBe(false);
    expect(parsed.risk).toBe("dangerous");
    expect(parsed.reason).toContain("sysctl");
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("caches model evaluation results and avoids duplicate model calls", async () => {
    const mockModel = vi.fn().mockResolvedValue(
      JSON.stringify({
        safe: true,
        risk: "safe",
        reason: "Inspecting network configuration safely",
      }),
    );

    const testCache = new EvaluatorCache({ ttlMs: 60000 });

    const first = await evaluateToolSafety(
      "bash",
      { command: "ip addr show eth0" },
      mockModel,
      { cache: testCache },
    );
    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(first.allowed).toBe(true);

    const second = await evaluateToolSafety(
      "bash",
      { command: "ip addr show eth0" },
      mockModel,
      { cache: testCache },
    );
    // Should be returned from cache without invoking mockModel again
    expect(mockModel).toHaveBeenCalledTimes(1);
    expect(second.allowed).toBe(true);
    expect(second.reason).toBe(first.reason);
  });

  describe("Storage Systems Safety Review (ZFS, Btrfs, EXT4, NTFS, NFS)", () => {
    it("evaluates ZFS commands across critical, dangerous, caution, and safe tiers", () => {
      // Critical: strictly blocked
      const criticalZfs = [
        "zpool destroy tank",
        "zpool split tank backup_pool",
        "zfs destroy -r tank/photos",
        "zfs rollback -r tank/photos@backup",
        "zpool labelclear /dev/sda",
        "zpool export -f tank",
      ];
      for (const cmd of criticalZfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("critical");
        expect(res.category).toBe("storage");
        expect(res.storageSystem).toBe("zfs");
      }

      // Dangerous: require human confirmation
      const dangerousZfs = [
        "zpool offline tank sda",
        "zpool detach tank sda",
        "zpool remove tank sda",
        "zpool replace tank sda sdb",
        "zfs rollback tank/photos@snap1",
        "zfs unmount -f tank/photos",
        "zfs set quota=100G tank/user",
      ];
      for (const cmd of dangerousZfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresHumanConfirmation).toBe(true);
        expect(res.storageSystem).toBe("zfs");
      }

      // Caution
      const cautionZfs = "zpool scrub tank";
      const cautionRes = evaluateHeuristicCommandSafety(cautionZfs);
      expect(cautionRes.allowed).toBe(true);
      expect(cautionRes.risk).toBe("caution");
      expect(cautionRes.category).toBe("storage");

      // Safe
      const safeZfs = ["zpool status", "zpool list", "zfs list", "zfs get all tank"];
      for (const cmd of safeZfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(true);
        expect(res.risk).toBe("safe");
        expect(res.storageSystem).toBe("zfs");
      }
    });

    it("evaluates Btrfs commands across critical, dangerous, caution, and safe tiers", () => {
      // Critical: strictly blocked
      const criticalBtrfs = [
        "btrfs subvolume delete /mnt/data/photos",
        "btrfs device remove /dev/sdb /mnt/data",
        "btrfs device delete /dev/sdb /mnt/data",
        "btrfs check --repair /dev/sda1",
      ];
      for (const cmd of criticalBtrfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("critical");
        expect(res.category).toBe("storage");
        expect(res.storageSystem).toBe("btrfs");
      }

      // Dangerous: require human confirmation
      const dangerousBtrfs = [
        "btrfs balance start /mnt/data",
        "btrfs balance cancel /mnt/data",
        "btrfs subvolume set-default 257 /mnt/data",
        "btrfs filesystem defrag -r /mnt/data",
        "btrfs rescue zero-log /dev/sda1",
        "btrfs device add /dev/sdc /mnt/data",
      ];
      for (const cmd of dangerousBtrfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresHumanConfirmation).toBe(true);
        expect(res.storageSystem).toBe("btrfs");
      }

      // Caution
      const cautionRes = evaluateHeuristicCommandSafety("btrfs scrub start /mnt/data");
      expect(cautionRes.allowed).toBe(true);
      expect(cautionRes.risk).toBe("caution");

      // Safe
      const safeBtrfs = [
        "btrfs subvolume list /mnt/data",
        "btrfs filesystem show",
        "btrfs filesystem df /mnt/data",
        "btrfs device stats /mnt/data",
      ];
      for (const cmd of safeBtrfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(true);
        expect(res.risk).toBe("safe");
        expect(res.storageSystem).toBe("btrfs");
      }
    });

    it("evaluates EXT4 commands across critical, dangerous, and safe tiers", () => {
      // Critical: format / raw debugfs / minimal shrink
      const criticalExt4 = [
        "mkfs.ext4 /dev/sda1",
        "mke2fs -F /dev/sda1",
        "debugfs -w /dev/sda1",
        "resize2fs -M /dev/sda1",
      ];
      for (const cmd of criticalExt4) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("critical");
        expect(res.category).toBe("storage");
        expect(res.storageSystem).toBe("ext4");
      }

      // Dangerous: superblock alterations / resizing / unattended forced repair
      const dangerousExt4 = [
        "tune2fs -O has_journal /dev/sda1",
        "resize2fs /dev/sda1 50G",
        "e2fsck -y -f /dev/sda1",
        "fsck.ext4 -y /dev/sda1",
      ];
      for (const cmd of dangerousExt4) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresHumanConfirmation).toBe(true);
        expect(res.storageSystem).toBe("ext4");
      }

      // Safe: read-only dump / label inspection
      const safeExt4 = ["dumpe2fs /dev/sda1", "tune2fs -l /dev/sda1", "e2label /dev/sda1"];
      for (const cmd of safeExt4) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(true);
        expect(res.risk).toBe("safe");
        expect(res.storageSystem).toBe("ext4");
      }
    });

    it("evaluates NTFS commands across critical, dangerous, and safe tiers", () => {
      // Critical: format / overwrite clone / wipe
      const criticalNtfs = [
        "mkfs.ntfs -F /dev/sdb1",
        "mkntfs -f /dev/sdb1",
        "ntfsclone --overwrite /dev/sdb1 backup.img",
        "ntfswipe /dev/sdb1",
      ];
      for (const cmd of criticalNtfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("critical");
        expect(res.category).toBe("storage");
        expect(res.storageSystem).toBe("ntfs");
      }

      // Dangerous: ntfsfix / ntfsresize / force mount
      const dangerousNtfs = [
        "ntfsfix /dev/sdb1",
        "ntfsresize -f /dev/sdb1",
        "mount -t ntfs-3g -o force /dev/sdb1 /mnt/usb",
      ];
      for (const cmd of dangerousNtfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresHumanConfirmation).toBe(true);
        expect(res.storageSystem).toBe("ntfs");
      }

      // Safe
      const safeNtfs = ["ntfsinfo /dev/sdb1", "ntfscluster /dev/sdb1", "ntfsls /dev/sdb1"];
      for (const cmd of safeNtfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(true);
        expect(res.risk).toBe("safe");
        expect(res.storageSystem).toBe("ntfs");
      }
    });

    it("evaluates NFS commands across critical, dangerous, caution, and safe tiers", () => {
      // Critical: unexport all shares or destroy exports configuration
      const criticalNfs = [
        "exportfs -u -a",
        "exportfs -ua",
        "exportfs -au",
        "rm -f /etc/exports",
        "> /etc/exports",
      ];
      for (const cmd of criticalNfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("critical");
        expect(res.category).toBe("storage");
        expect(res.storageSystem).toBe("nfs");
      }

      // Dangerous: unexport specific share, re-export, force unmount, stopping nfs/rpcbind
      const dangerousNfs = [
        "exportfs -u 192.168.1.50:/volume1/data",
        "exportfs -ra",
        "umount -f /mnt/nfs_backup",
        "systemctl stop nfs-kernel-server",
        "systemctl stop rpcbind",
      ];
      for (const cmd of dangerousNfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresHumanConfirmation).toBe(true);
      }

      // Caution: synchronizing export table
      const cautionRes = evaluateHeuristicCommandSafety("exportfs -a");
      expect(cautionRes.allowed).toBe(true);
      expect(cautionRes.risk).toBe("caution");
      expect(cautionRes.storageSystem).toBe("nfs");

      // Safe: querying shares
      const safeNfs = ["showmount -e 192.168.1.10", "showmount -a", "nfsstat -s", "exportfs -v"];
      for (const cmd of safeNfs) {
        const res = evaluateHeuristicCommandSafety(cmd);
        expect(res.allowed).toBe(true);
        expect(res.risk).toBe("safe");
        expect(res.storageSystem).toBe("nfs");
      }
    });

    it("parses storageSystem from model evaluator output", async () => {
      const mockModel = vi.fn().mockResolvedValue(
        JSON.stringify({
          safe: false,
          risk: "dangerous",
          reason: "Complex script modifying ZFS storage pool configuration",
          storageSystem: "zfs",
        }),
      );

      const res = await evaluateToolSafety(
        "bash",
        { command: "python3 /root/reconfigure_storage_pools.py" },
        mockModel,
      );

      expect(res.allowed).toBe(false);
      expect(res.risk).toBe("dangerous");
      expect(res.category).toBe("storage");
      expect(res.storageSystem).toBe("zfs");
    });
  });
});

