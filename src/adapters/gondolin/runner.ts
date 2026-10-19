/**
 * Gondolin Micro-VM runner (isolation layer 3).
 *
 * Ported from the pre-refactor `src/sandbox/gondolin-runner.ts` and aligned with
 * `@earendil-works/gondolin` 0.13: a disposable hardware-virtualized VM for
 * untrusted scripts, with the host workspace mounted (through `RealFSProvider`)
 * at `/workspace` and the same escape check as the file jail. HTTP egress is
 * mediated by `createHttpHooks`, so `allowedHosts` doubles as the network policy.
 *
 * The VM provider is injectable, so the class stays testable without QEMU;
 * `bash-operations.ts` wires it to the bash tool behind `THEBE_SANDBOX=gondolin`.
 * Guest images are fetched on first boot and cached under `~/.cache/gondolin`.
 */

import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { trackMicroVm } from "./lifecycle.ts";

const GUEST_WORKSPACE = "/workspace";
const SESSION_LABEL = "thebe-sandbox";

export interface GondolinExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface GondolinRunnerOptions {
  workspacePath: string;
  /** Guest HTTP allowlist; `[]` denies all egress, undefined allows every host. */
  allowedHosts?: string[];
  secrets?: Record<string, { hosts: string[]; value?: string }>;
  /** Guest image selector (`GONDOLIN_DEFAULT_IMAGE`), default `alpine-base:latest`. */
  image?: string;
  timeoutMs?: number;
}

/** Minimal structural view of the gondolin API the runner relies on. */
type GondolinModule = {
  VM: { create(options?: Record<string, unknown>): Promise<IMicroVMInstance> };
  RealFSProvider: new (rootPath: string) => unknown;
  createHttpHooks: (options?: Record<string, unknown>) => {
    httpHooks: unknown;
    env: unknown;
  };
};

/**
 * Maps a local host path into the Micro-VM /workspace path.
 * Throws if the path escapes the workspace root.
 */
export function toGuestWorkspacePath(
  localWorkspace: string,
  targetPath: string
): string {
  const normWorkspace = resolve(localWorkspace);
  const normTarget = isAbsolute(targetPath)
    ? resolve(targetPath)
    : resolve(normWorkspace, targetPath);

  const rel = relative(normWorkspace, normTarget);
  if (rel === "") {
    return "/workspace";
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes Micro-VM workspace jail: ${targetPath}`);
  }
  return posix.join("/workspace", rel.split(sep).join(posix.sep));
}

/**
 * Interface representing an active Micro-VM instance.
 */
export interface IMicroVMInstance {
  exec(
    command: string | string[],
    options?: { cwd?: string; signal?: AbortSignal }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
}

/**
 * Gondolin Micro-VM Runner managing isolated task execution.
 *
 * Booted VMs are registered with `./lifecycle.ts`, so the process exit path can
 * close one whose session never disposed. `destroy()` retires the runner: a VM
 * that is still booting when it runs closes itself rather than being adopted.
 */
export class GondolinMicroVMRunner {
  private activeVm?: IMicroVMInstance;
  private booting?: Promise<void>;
  private untrack?: () => void;
  /** Set by `destroy()`; a boot that lands after it closes its own VM. */
  private disposed = false;
  private readonly options: GondolinRunnerOptions;

  constructor(options: GondolinRunnerOptions) {
    this.options = {
      ...options,
      allowedHosts: options.allowedHosts ?? [],
      timeoutMs: options.timeoutMs ?? 60_000,
    };
  }

  /**
   * Initializes the Micro-VM: the injected provider for tests, otherwise the
   * real `@earendil-works/gondolin` package. Failures are surfaced with the fix
   * instead of silently running commands on the host.
   */
  async init(
    customVmProvider?: () => Promise<IMicroVMInstance>
  ): Promise<void> {
    if (this.activeVm || this.disposed) {
      return;
    }
    // One boot at a time: a second command waits for the VM instead of racing a
    // second one. A failed boot is not cached — a missing backend is fixable, so
    // the next command gets to retry.
    if (!this.booting) {
      const booting = this.boot(customVmProvider);
      this.booting = booting;
      booting.catch(() => {
        if (this.booting === booting) {
          this.booting = undefined;
        }
      });
    }
    await this.booting;
  }

  /**
   * Boots the VM and adopts it, unless `destroy()` happened meanwhile. Then the
   * boot's owner is already gone and adopting it would let it outlive the
   * process as an orphaned hypervisor child.
   */
  private async boot(
    customVmProvider?: () => Promise<IMicroVMInstance>
  ): Promise<void> {
    const vm = customVmProvider
      ? await customVmProvider()
      : await this.createVm();
    if (this.disposed) {
      await vm.close().catch(() => {});
      return;
    }
    this.activeVm = vm;
    this.untrack = trackMicroVm(vm);
  }

  /** Creates the real VM, turning any failure into the install-or-fix hint. */
  private async createVm(): Promise<IMicroVMInstance> {
    try {
      const gondolin =
        (await import("@earendil-works/gondolin")) as unknown as GondolinModule;
      const { httpHooks, env } = gondolin.createHttpHooks({
        ...(this.options.allowedHosts
          ? { allowedHosts: this.options.allowedHosts }
          : {}),
        ...(this.options.secrets ? { secrets: this.options.secrets } : {}),
      });
      if (this.options.image) {
        process.env.GONDOLIN_DEFAULT_IMAGE = this.options.image;
      }
      return await gondolin.VM.create({
        httpHooks,
        env,
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new gondolin.RealFSProvider(
              resolve(this.options.workspacePath)
            ),
          },
        },
        ...(this.options.timeoutMs
          ? { startTimeoutMs: this.options.timeoutMs }
          : {}),
        sessionLabel: SESSION_LABEL,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        "Gondolin Micro-VM is unavailable. Install it with " +
          "`npm install @earendil-works/gondolin@0.13.0` and provide a VM backend " +
          "(bundled krun runner, or QEMU: `brew install qemu` on macOS, " +
          "`apt install qemu-system-arm` on Linux). " +
          `Underlying error: ${detail}`
      );
    }
  }

  /**
   * Executes a command safely inside the Micro-VM.
   */
  async exec(
    command: string,
    signal?: AbortSignal
  ): Promise<GondolinExecResult> {
    if (!this.activeVm) {
      throw new Error("Micro-VM is not initialized. Call init() first.");
    }

    const startMs = Date.now();
    // Run from the mounted workspace so shell commands behave like the jailed
    // backends (`bwrap --chdir`).
    const res = await this.activeVm.exec(command, {
      cwd: GUEST_WORKSPACE,
      ...(signal ? { signal } : {}),
    });
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Tears down and destroys the disposable Micro-VM, and retires this runner so
   * nothing boots again under it.
   */
  async destroy(): Promise<void> {
    this.disposed = true;
    const vm = this.activeVm;
    const untrack = this.untrack;
    this.activeVm = undefined;
    this.untrack = undefined;
    untrack?.();
    if (vm) {
      await vm.close().catch(() => {});
    }
  }
}
