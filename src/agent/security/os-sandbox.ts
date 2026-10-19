import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  decideUnmatchedHost,
  networkAllowedDomains,
  networkDeniedDomains,
  setNetworkPolicyListener,
} from "./network-policy.ts";

/**
 * Host bash isolation via pinned `@anthropic-ai/sandbox-runtime` (Claude Code's
 * Seatbelt / bubblewrap). One process, one initialization. Per-command writes
 * are passed to `wrapWithSandbox` because a later `initialize` does not replace
 * the running config.
 *
 * The release container does not call this. `THEBE_SANDBOX=off`, a saved
 * sandbox off, and a session's full access skip the wrap in the Pi adapter;
 * this module always confines. A host that matches neither list asks.
 */

export const OS_SANDBOX_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.thebe",
] as const;

export type OsSandboxDependencyCheck = {
  errors: string[];
  warnings: string[];
};

export type OsSandboxRuntime = {
  initialize(
    config: SandboxRuntimeConfig,
    ask?: typeof decideUnmatchedHost
  ): Promise<void>;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>
  ): Promise<string>;
  updateConfig(config: SandboxRuntimeConfig): void;
  reset(): Promise<void>;
  checkDependencies(): OsSandboxDependencyCheck;
};

const libraryRuntime: OsSandboxRuntime = {
  initialize: (config, ask) => SandboxManager.initialize(config, ask),
  wrapWithSandbox: (command, binShell, customConfig) =>
    SandboxManager.wrapWithSandbox(command, binShell, customConfig),
  updateConfig: (config) => SandboxManager.updateConfig(config),
  reset: () => SandboxManager.reset(),
  checkDependencies: () => SandboxManager.checkDependencies(),
};

let runtime: OsSandboxRuntime = libraryRuntime;
let started = false;
let starting: Promise<void> | undefined;
let lastWorkspace: string | undefined;

setNetworkPolicyListener(() => {
  if (!started || !lastWorkspace) return;
  try {
    runtime.updateConfig(osSandboxPolicy(lastWorkspace));
  } catch {
    // A bad host must not strand the command that was just allowed or denied.
  }
});

/** Test seam. Omit the argument to restore the real library. */
export function setOsSandboxRuntime(next?: OsSandboxRuntime): void {
  runtime = next ?? libraryRuntime;
  started = false;
  starting = undefined;
}

export function osSandboxPolicy(workspacePath: string): SandboxRuntimeConfig {
  return {
    filesystem: {
      denyRead: [...OS_SANDBOX_DENY_READ],
      allowWrite: [resolve(workspacePath), tmpdir()],
      denyWrite: [],
    },
    network: {
      allowedDomains: [...networkAllowedDomains()],
      deniedDomains: [...networkDeniedDomains()],
    },
  };
}

export function osSandboxDependencies(): OsSandboxDependencyCheck {
  return runtime.checkDependencies();
}

export function osSandboxUnavailableReason(
  check: OsSandboxDependencyCheck = osSandboxDependencies()
): string {
  const missing = check.errors.length > 0 ? check.errors.join(", ") : "unknown";
  return (
    `OS sandbox dependencies are missing (${missing}). ` +
    "Commands will be refused until they are installed. " +
    "Set THEBE_SANDBOX=off to run without a sandbox."
  );
}

/** Start the host proxies once. Later wraps carry their own write roots. */
export async function ensureOsSandbox(workspacePath: string): Promise<void> {
  lastWorkspace = workspacePath;
  if (started) return;
  if (!starting) {
    const policy = osSandboxPolicy(workspacePath);
    starting = runtime.initialize(policy, decideUnmatchedHost).then(() => {
      started = true;
    });
  }
  try {
    await starting;
  } catch (error) {
    starting = undefined;
    throw error;
  }
}

/**
 * Wrap one command. A missing dependency refuses it; the command is never
 * returned unchanged from this function.
 */
export async function wrapOsSandboxCommand(
  command: string,
  workspacePath: string
): Promise<string> {
  const check = osSandboxDependencies();
  if (check.errors.length > 0) {
    throw new Error(`Command not run: ${osSandboxUnavailableReason(check)}`);
  }
  await ensureOsSandbox(workspacePath);
  lastWorkspace = workspacePath;
  const policy = osSandboxPolicy(workspacePath);
  return runtime.wrapWithSandbox(command, undefined, {
    filesystem: policy.filesystem,
    network: policy.network,
  });
}

/** Drop the proxy listeners. Safe when the sandbox was never started. */
export async function disposeOsSandbox(): Promise<void> {
  started = false;
  starting = undefined;
  lastWorkspace = undefined;
  await runtime.reset();
}
