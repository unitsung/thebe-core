import { describe, expect, it } from "vitest";
import {
  CommandRiskCache,
  assessCommand,
  assessCommandCached,
  assessToolCall,
  commandGuardEnabled,
  commandGuardPreflight,
} from "./command-risk.ts";

describe("command-risk (homelab & NAS heuristics)", () => {
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
      const res = assessCommand(cmd);
      expect(res.allowed).toBe(false);
      expect(res.risk).toBe("critical");
      expect(res.requiresConfirmation).toBe(false);
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
      const res = assessCommand(cmd);
      expect(res.allowed).toBe(false);
      expect(res.risk).toBe("dangerous");
      expect(res.requiresConfirmation).toBe(true);
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
      const res = assessCommand(cmd);
      expect(res.allowed).toBe(true);
      expect(res.risk).toBe("safe");
      expect(res.requiresConfirmation).toBe(false);
    }
  });

  it("evaluates write tool targeting system files as dangerous", async () => {
    const res = await assessToolCall("write", {
      path: "/etc/sudoers",
      content: "test",
    });
    expect(res.allowed).toBe(false);
    expect(res.risk).toBe("dangerous");
    expect(res.requiresConfirmation).toBe(true);
  });

  it("enforces workspace confinement on write/edit tools", async () => {
    const workspace = "/volume1/docker/nginx-service";

    // 1. Inside workspace -> safe
    const inside = await assessToolCall(
      "write",
      { path: "/volume1/docker/nginx-service/nginx.conf", content: "server {}" },
      { workspacePath: workspace },
    );
    expect(inside.allowed).toBe(true);
    expect(inside.workspaceEscape).toBeFalsy();

    // 2. Outside workspace -> dangerous workspace escape
    const outside = await assessToolCall(
      "write",
      { path: "/volume1/photos/family.jpg", content: "malicious" },
      { workspacePath: workspace },
    );
    expect(outside.allowed).toBe(false);
    expect(outside.risk).toBe("dangerous");
    expect(outside.workspaceEscape).toBe(true);
    expect(outside.reason).toContain("Workspace Escape Detected");
  });

  it("enforces workspace confinement on mutating bash commands", async () => {
    const workspace = "/volume1/docker/myapp";

    // Modifying outside workspace
    const escape = await assessToolCall(
      "bash",
      { command: "rm -f /volume1/shared_documents/report.pdf" },
      { workspacePath: workspace },
    );
    expect(escape.allowed).toBe(false);
    expect(escape.workspaceEscape).toBe(true);
    expect(escape.reason).toContain("Workspace Escape Detected");
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
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresConfirmation).toBe(true);
        expect(res.storageSystem).toBe("zfs");
      }

      // Caution
      const cautionZfs = "zpool scrub tank";
      const cautionRes = assessCommand(cautionZfs);
      expect(cautionRes.allowed).toBe(true);
      expect(cautionRes.risk).toBe("caution");
      expect(cautionRes.category).toBe("storage");

      // Safe
      const safeZfs = ["zpool status", "zpool list", "zfs list", "zfs get all tank"];
      for (const cmd of safeZfs) {
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresConfirmation).toBe(true);
        expect(res.storageSystem).toBe("btrfs");
      }

      // Caution
      const cautionRes = assessCommand("btrfs scrub start /mnt/data");
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
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresConfirmation).toBe(true);
        expect(res.storageSystem).toBe("ext4");
      }

      // Safe: read-only dump / label inspection
      const safeExt4 = ["dumpe2fs /dev/sda1", "tune2fs -l /dev/sda1", "e2label /dev/sda1"];
      for (const cmd of safeExt4) {
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresConfirmation).toBe(true);
        expect(res.storageSystem).toBe("ntfs");
      }

      // Safe
      const safeNtfs = ["ntfsinfo /dev/sdb1", "ntfscluster /dev/sdb1", "ntfsls /dev/sdb1"];
      for (const cmd of safeNtfs) {
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
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
        const res = assessCommand(cmd);
        expect(res.allowed).toBe(false);
        expect(res.risk).toBe("dangerous");
        expect(res.requiresConfirmation).toBe(true);
      }

      // Caution: synchronizing export table
      const cautionRes = assessCommand("exportfs -a");
      expect(cautionRes.allowed).toBe(true);
      expect(cautionRes.risk).toBe("caution");
      expect(cautionRes.storageSystem).toBe("nfs");

      // Safe: querying shares
      const safeNfs = ["showmount -e 192.168.1.10", "showmount -a", "nfsstat -s", "exportfs -v"];
      for (const cmd of safeNfs) {
        const res = assessCommand(cmd);
        expect(res.allowed).toBe(true);
        expect(res.risk).toBe("safe");
        expect(res.storageSystem).toBe("nfs");
      }
    });

  describe("Docker Engine API calls over the socket (curl bypass)", () => {
    const socket = "curl --unix-socket /var/run/docker.sock";

    it("blocks volume pruning issued directly against the Docker API", () => {
      const res = assessCommand(`${socket} -X POST http://localhost/v1.41/volumes/prune`);
      expect(res.risk).toBe("critical");
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("Volume pruning");
    });

    it("blocks privileged container creation with host root and socket mounts", () => {
      const privileged = assessCommand(
        `${socket} -X POST http://localhost/v1.41/containers/create -d '{"HostConfig":{"Privileged":true}}'`,
      );
      expect(privileged.risk).toBe("critical");

      const hostRoot = assessCommand(
        `${socket} -X POST http://localhost/v1.41/containers/create -d '{"HostConfig":{"Binds":["/:/host"]}}'`,
      );
      expect(hostRoot.risk).toBe("critical");

      const socketMount = assessCommand(
        `${socket} -X POST http://localhost/v1.41/containers/create -d '{"HostConfig":{"Binds":["/var/run/docker.sock:/var/run/docker.sock"]}}'`,
      );
      expect(socketMount.risk).toBe("critical");
    });

    it("asks for review when the create body cannot be inspected", () => {
      const res = assessCommand(
        `${socket} -X POST http://localhost/v1.41/containers/create -d "$BODY"`,
      );
      expect(res.risk).toBe("dangerous");
      expect(res.requiresConfirmation).toBe(true);
    });

    it("allows read-only Docker API queries and hardened creates", () => {
      const list = assessCommand(`${socket} http://localhost/v1.41/containers/json`);
      expect(list.risk).toBe("safe");

      const hardened = assessCommand(
        `${socket} -X POST http://localhost/v1.41/containers/create -d '{"HostConfig":{"Binds":["/volume1/app:/app"]}}'`,
      );
      expect(hardened.risk).toBe("safe");
    });

    it("honours the scenario docker policy", () => {
      const command = `${socket} -X POST http://localhost/v1.41/containers/create -d '{"HostConfig":{"Privileged":true}}'`;
      const homelab = assessCommand(command, {
        dockerGuard: {
          blockPrivileged: false,
          blockHostRootMounts: true,
          blockDockerSocketMount: false,
          blockVolumePrune: true,
        },
      });
      expect(homelab.risk).toBe("safe");
    });

    it("leaves unrelated curl commands untouched", () => {
      const res = assessCommand("curl -s https://example.com/containers/create");
      expect(res.risk).toBe("safe");
    });
  });
});
});
