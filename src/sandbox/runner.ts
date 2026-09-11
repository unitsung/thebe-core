import { execSync } from "node:child_process";
import type { SandboxConfig, WrappedCommandResult } from "./types.ts";
import { buildBwrapCommandString } from "./bwrap.ts";

let cachedBwrapAvailable: boolean | undefined;

/**
 * Checks whether the bwrap binary is available on the system.
 */
export function isBwrapAvailable(): boolean {
  if (cachedBwrapAvailable !== undefined) {
    return cachedBwrapAvailable;
  }
  try {
    execSync("which bwrap", { stdio: "ignore" });
    cachedBwrapAvailable = true;
  } catch {
    cachedBwrapAvailable = false;
  }
  return cachedBwrapAvailable;
}

/** Reset cache for testing purposes */
export function _resetBwrapCache(): void {
  cachedBwrapAvailable = undefined;
}

/**
 * Wraps a bash command according to the configured sandbox mode.
 */
export function wrapBashCommand(
  command: string,
  config?: Partial<SandboxConfig>,
  checkBwrap: () => boolean = isBwrapAvailable,
): WrappedCommandResult {
  const mode = config?.mode ?? "none";
  const workspacePath = config?.workspacePath;

  if (mode === "none" || !workspacePath) {
    return {
      command,
      mode: "none",
      appliedSandbox: false,
    };
  }

  const fullConfig: SandboxConfig = {
    mode,
    workspacePath,
    allowNetwork: config.allowNetwork ?? true,
    readOnlyHost: config.readOnlyHost ?? true,
    dropCapabilities: config.dropCapabilities ?? true,
    tmpfsSize: config.tmpfsSize,
  };

  if (mode === "bwrap") {
    const hasBwrap = checkBwrap();
    if (hasBwrap) {
      return {
        command: buildBwrapCommandString(command, fullConfig),
        cwd: fullConfig.workspacePath,
        mode: "bwrap",
        appliedSandbox: true,
      };
    }
    // Fallback if bwrap is not present on host
    return {
      command,
      cwd: fullConfig.workspacePath,
      mode: "workspace-jail",
      appliedSandbox: false,
      warning: "bwrap binary not found on host; falling back to workspace-jail mode",
    };
  }

  if (mode === "workspace-jail") {
    return {
      command,
      cwd: fullConfig.workspacePath,
      mode: "workspace-jail",
      appliedSandbox: true,
    };
  }

  if (mode === "gondolin") {
    return {
      command,
      cwd: "/workspace",
      mode: "gondolin",
      appliedSandbox: true,
    };
  }

  return {
    command,
    mode: "none",
    appliedSandbox: false,
  };
}
