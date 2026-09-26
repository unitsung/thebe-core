/**
 * Gondolin Micro-VM runner (isolation layer 3).
 *
 * Ported from the pre-refactor `src/sandbox/gondolin-runner.ts`: a disposable
 * hardware-virtualized VM for untrusted scripts, with the workspace mounted at
 * `/workspace` and the same escape check as the jail. The VM provider is
 * injectable, so the class is testable without QEMU/KVM; `bash-operations.ts`
 * wires it to the bash tool behind `THEBE_SANDBOX=gondolin`.
 */

import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export interface GondolinExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface GondolinRunnerOptions {
  workspacePath: string;
  allowedHosts?: string[];
  secrets?: Record<string, { hosts: string[]; value?: string }>;
  image?: string;
  timeoutMs?: number;
}

/**
 * Maps a local host path into the Micro-VM /workspace path.
 * Throws if the path escapes the workspace root.
 */
export function toGuestWorkspacePath(localWorkspace: string, targetPath: string): string {
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
  exec(command: string | string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  close(): Promise<void>;
}

/**
 * Gondolin Micro-VM Runner managing isolated task execution.
 */
export class GondolinMicroVMRunner {
  private activeVm?: IMicroVMInstance;
  private readonly options: GondolinRunnerOptions;

  constructor(options: GondolinRunnerOptions) {
    this.options = {
      ...options,
      allowedHosts: options.allowedHosts ?? [],
      timeoutMs: options.timeoutMs ?? 60_000,
    };
  }

  /**
   * Initializes the Micro-VM.
   * If real @earendil-works/gondolin is present, creates real VM; otherwise uses provider or mock.
   */
  async init(customVmProvider?: () => Promise<IMicroVMInstance>): Promise<void> {
    if (this.activeVm) {
      return;
    }

    if (customVmProvider) {
      this.activeVm = await customVmProvider();
      return;
    }

    try {
      // Dynamic import to allow running on systems without native gondolin installed
      const gondolin = await import("@earendil-works/gondolin" as string);
      const { VM, createHttpHooks } = gondolin as any;

      const { httpHooks, env } = createHttpHooks({
        allowedHosts: this.options.allowedHosts,
        secrets: this.options.secrets,
      });

      this.activeVm = await VM.create({
        httpHooks,
        env,
        image: this.options.image,
      });
    } catch {
      throw new Error(
        "Gondolin Micro-VM runtime is not installed. Run 'pnpm add @earendil-works/gondolin' and ensure QEMU/KVM is available.",
      );
    }
  }

  /**
   * Executes a command safely inside the Micro-VM.
   */
  async exec(command: string): Promise<GondolinExecResult> {
    if (!this.activeVm) {
      throw new Error("Micro-VM is not initialized. Call init() first.");
    }

    const startMs = Date.now();
    const res = await this.activeVm.exec(command);
    return {
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Tears down and destroys the disposable Micro-VM.
   */
  async destroy(): Promise<void> {
    if (this.activeVm) {
      await this.activeVm.close().catch(() => {});
      this.activeVm = undefined;
    }
  }
}
