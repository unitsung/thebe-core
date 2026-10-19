import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeMicroVms,
  liveMicroVmCount,
  trackMicroVm,
} from "./lifecycle.ts";
import { GondolinMicroVMRunner, type IMicroVMInstance } from "./runner.ts";

function createVm(close: () => Promise<void> = async () => {}) {
  return {
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    close: vi.fn(close),
  } as unknown as IMicroVMInstance;
}

/**
 * Micro-VM hypervisors as seen from outside this process. Gondolin names its
 * per-VM QEMU overlay `gondolin-disk-*.qcow2`; requiring the hypervisor binary
 * too keeps a process that merely mentions the pattern out of the count.
 */
function microVmHypervisors(): Array<{ ppid: number }> {
  try {
    return execFileSync("ps", ["-o", "pid=,ppid=,command=", "-ax"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => /gondolin-disk-/.test(line) && /qemu|krun/.test(line))
      .map((line) => ({ ppid: Number(line.trim().split(/\s+/)[1]) }));
  } catch {
    return [];
  }
}

/** Hypervisors whose owner is this process: the VM this test booted. */
function ownedMicroVms(): number {
  return microVmHypervisors().filter((vm) => vm.ppid === process.pid).length;
}

/**
 * Hypervisors whose owner already exited (reparented to launchd). Test files run
 * in parallel workers, so this is the only process-wide count that stays honest:
 * another worker's VM still has a live parent.
 */
function orphanedMicroVms(): number {
  return microVmHypervisors().filter((vm) => vm.ppid === 1).length;
}

/**
 * Waits out a hypervisor that is still dying. Gondolin's own teardown SIGTERMs,
 * then SIGKILLs after a grace period and caps the wait, so `close()` can resolve
 * while the process is still on its way out — that is not a leak.
 */
async function waitForMicroVmsToDie(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ownedMicroVms() === 0 && orphanedMicroVms() === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Gondolin Micro-VM lifetime", () => {
  beforeEach(async () => {
    await disposeMicroVms();
  });

  it("closes a VM whose session never disposed, so stopping Core cannot orphan it", async () => {
    const vm = createVm();
    const runner = new GondolinMicroVMRunner({
      workspacePath: "/volume1/docker/app",
    });
    await runner.init(async () => vm);
    expect(liveMicroVmCount()).toBe(1);

    // The session was still open when Core stopped, so no session-level dispose ran.
    await disposeMicroVms();

    expect(vm.close).toHaveBeenCalledTimes(1);
    expect(liveMicroVmCount()).toBe(0);
  });

  it("forgets a VM that retired itself, so it is not closed twice", async () => {
    const vm = createVm();
    const runner = new GondolinMicroVMRunner({
      workspacePath: "/volume1/docker/app",
    });
    await runner.init(async () => vm);
    await runner.destroy();
    expect(liveMicroVmCount()).toBe(0);

    await disposeMicroVms();

    expect(vm.close).toHaveBeenCalledTimes(1);
  });

  it("closes the other VMs when one of them fails to close", async () => {
    const failing = createVm(async () => {
      throw new Error("already gone");
    });
    const healthy = createVm();
    trackMicroVm(failing);
    trackMicroVm(healthy);

    await expect(disposeMicroVms()).resolves.toBeUndefined();

    expect(healthy.close).toHaveBeenCalledTimes(1);
    expect(liveMicroVmCount()).toBe(0);
  });
});

/**
 * Real Micro-VM boot, opt-in like the runner's: needs a VM backend and the guest
 * image (`~/.cache/gondolin`). `THEBE_GONDOLIN_IT=1 npx vitest run
 * src/adapters/gondolin`.
 */
const gondolinIt = process.env.THEBE_GONDOLIN_IT === "1" ? it : it.skip;

describe("Gondolin Micro-VM lifetime (real backend)", () => {
  gondolinIt(
    "closes a live VM when Core stops with its session still open",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "thebe-gondolin-life-"));
      const runner = new GondolinMicroVMRunner({
        workspacePath: workspace,
        allowedHosts: [],
        timeoutMs: 180_000,
      });

      try {
        await runner.init();
        await runner.exec("true");
        expect(ownedMicroVms()).toBeGreaterThan(0);

        // Core stops here and the session never disposed: this is the teardown the
        // HTTP shutdown path awaits as `bootstrapThebe().disposeSandboxVms`.
        await disposeMicroVms();
        await waitForMicroVmsToDie();

        // The hypervisor is gone, and nothing was left running with no owner.
        expect(ownedMicroVms()).toBe(0);
        expect(orphanedMicroVms()).toBe(0);
        expect(liveMicroVmCount()).toBe(0);
      } finally {
        await runner.destroy();
        rmSync(workspace, { recursive: true, force: true });
      }
    },
    600_000
  );
});
