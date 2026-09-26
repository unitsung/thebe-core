import {
  GondolinMicroVMRunner,
  type IMicroVMInstance,
} from "./runner.ts";

/**
 * Bash backend that runs every command inside a disposable Micro-VM.
 *
 * `THEBE_SANDBOX=gondolin` selects this instead of local execution, which is the
 * strongest option in the scenario table (`microvm-sandbox`). The VM starts
 * lazily on the first command and is destroyed with the session; when the
 * gondolin package or QEMU/KVM is missing, initialization fails once and the
 * caller reports the reason instead of silently running unsandboxed.
 *
 * The returned shape is Pi's `BashOperations` (exec + streaming callback) without
 * importing Pi types, so this adapter stays independent of the runtime package.
 */

export type SandboxedExecOptions = {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
};

export type SandboxedBashOperations = {
  exec: (
    command: string,
    cwd: string,
    options: SandboxedExecOptions,
  ) => Promise<{ exitCode: number | null }>;
};

export type GondolinBashOperationsOptions = {
  workspacePath: string;
  allowedHosts?: string[];
  secrets?: Record<string, { hosts: string[]; value?: string }>;
  image?: string;
  /** Test seam: build the VM directly instead of importing gondolin. */
  vmProvider?: () => Promise<IMicroVMInstance>;
};

export function createGondolinBashOperations(
  options: GondolinBashOperationsOptions,
): SandboxedBashOperations & { dispose: () => Promise<void> } {
  const runner = new GondolinMicroVMRunner({
    workspacePath: options.workspacePath,
    allowedHosts: options.allowedHosts,
    secrets: options.secrets,
    image: options.image,
  });
  let ready: Promise<void> | undefined;

  return {
    async exec(
      command: string,
      _cwd: string,
      execOptions: SandboxedExecOptions,
    ): Promise<{ exitCode: number | null }> {
      ready ??= options.vmProvider
        ? runner.init(options.vmProvider)
        : runner.init();
      await ready;
      const result = await runner.exec(command, execOptions.signal);
      if (result.stdout) execOptions.onData(Buffer.from(result.stdout));
      if (result.stderr) execOptions.onData(Buffer.from(result.stderr));
      return { exitCode: result.exitCode };
    },
    async dispose(): Promise<void> {
      await runner.destroy();
      ready = undefined;
    },
  };
}
