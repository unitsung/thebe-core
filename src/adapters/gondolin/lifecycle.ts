/**
 * Process-scoped lifetime for Gondolin Micro-VMs.
 *
 * A Micro-VM's lifetime is the process, not the session that booted it. Pi's
 * `dispose()` is synchronous, so the session seam cannot await a VM teardown,
 * and Core's own exit path (`drainThebeHttpServer` -> `process.exit`) never
 * disposes live sessions at all. Tracking every VM here is what lets an exit
 * path close them anyway: without it, stopping Core left QEMU processes running
 * with no owner, reparented to launchd and holding memory and disk until they
 * were killed by hand.
 *
 * Entry points reach this through `bootstrapThebe().disposeSandboxVms`; delivery
 * code must not import this adapter directly (see `architecture.test.ts`).
 */

import type { IMicroVMInstance } from "./runner.ts";

const liveVms = new Set<IMicroVMInstance>();
let teardown: Promise<void> | undefined;

/**
 * Tracks `vm` for the process-wide teardown. The returned function releases it;
 * releasing twice is harmless, and a released VM is never closed by
 * `disposeMicroVms`.
 */
export function trackMicroVm(vm: IMicroVMInstance): () => void {
  liveVms.add(vm);
  return () => {
    liveVms.delete(vm);
  };
}

/** How many VMs are tracked right now. Test seam and diagnostics. */
export function liveMicroVmCount(): number {
  return liveVms.size;
}

/**
 * Closes every tracked VM and resolves once they are all closed. Safe to call
 * more than once: concurrent callers share one teardown, and VMs tracked after
 * it finished are picked up by the next call.
 *
 * Never rejects — a VM that fails to close must not stop the others, nor the
 * process, from exiting.
 */
export function disposeMicroVms(): Promise<void> {
  teardown ??= (async () => {
    const vms = [...liveVms];
    liveVms.clear();
    try {
      await Promise.all(vms.map((vm) => vm.close().catch(() => {})));
    } finally {
      teardown = undefined;
    }
  })();
  return teardown;
}
