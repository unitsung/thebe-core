import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Command sandboxing for the bash tool.
 *
 * Ported from the pre-refactor `src/sandbox/bwrap.ts` + `runner.ts`: bubblewrap
 * gives the agent a read-only host, an ephemeral `/tmp`, no capabilities, and a
 * single writable workspace — the isolation the NAS/homelab deployment needs.
 * `THEBE_SANDBOX=bwrap` enables it; the wrapper degrades to a plain command
 * with a warning when `bwrap` is missing, so macOS and containers keep working.
 */

export type SandboxMode = "off" | "bwrap";

export type SandboxConfig = {
  mode: SandboxMode;
  workspacePath: string;
  allowNetwork?: boolean;
  dropCapabilities?: boolean;
};

export type WrappedCommand = {
  command: string;
  cwd?: string;
  mode: SandboxMode;
  applied: boolean;
  warning?: string;
};

/**
 * bubblewrap arguments for a jailed shell command.
 *
 * - `--ro-bind / /` keeps the host read-only, `--bind <workspace>` is the only
 *   writable path, `--tmpfs /tmp` throws scratch data away.
 * - `--unshare-all` + `--cap-drop ALL` remove PID/IPC/UTS/user namespaces and
 *   root capabilities; `--die-with-parent` prevents orphans.
 * - Network is off unless `allowNetwork` says otherwise.
 */
export function buildBwrapArgs(
  command: string,
  config: SandboxConfig,
): string[] {
  const workspace = resolve(config.workspacePath);
  const args: string[] = ["--unshare-all", "--die-with-parent"];
  args.push(config.allowNetwork ? "--share-net" : "--unshare-net");
  if (config.dropCapabilities !== false) {
    args.push("--cap-drop", "ALL");
  }
  args.push("--ro-bind", "/", "/");
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");
  args.push("--tmpfs", "/tmp");
  args.push("--bind", workspace, workspace);
  args.push("--chdir", workspace);
  args.push("/bin/sh", "-lc", command);
  return args;
}

export function buildBwrapCommandString(
  command: string,
  config: SandboxConfig,
): string {
  const quoted = buildBwrapArgs(command, config).map((arg) =>
    /^[a-zA-Z0-9_\-./]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`,
  );
  return `bwrap ${quoted.join(" ")}`;
}

let bwrapProbe: boolean | undefined;

/** Whether `bwrap` exists on this host (cached; injectable for tests). */
export function isBwrapAvailable(probe?: () => boolean): boolean {
  if (probe) return probe();
  bwrapProbe ??= defaultBwrapProbe();
  return bwrapProbe;
}

/** Test hook: forget the cached probe result. */
export function resetBwrapProbe(): void {
  bwrapProbe = undefined;
}

function defaultBwrapProbe(): boolean {
  try {
    return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Wrap a bash command for the configured sandbox mode. Falls back to the raw
 * command (with a warning) when the mode is unavailable on this host.
 */
export function wrapCommandForSandbox(
  command: string,
  config: {
    mode?: SandboxMode;
    workspacePath?: string;
    allowNetwork?: boolean;
    probe?: () => boolean;
  } = {},
): WrappedCommand {
  const mode = config.mode ?? "off";
  if (mode === "off" || !config.workspacePath) {
    return { command, mode: "off", applied: false };
  }
  const full: SandboxConfig = {
    mode,
    workspacePath: config.workspacePath,
    allowNetwork: config.allowNetwork ?? true,
    dropCapabilities: true,
  };
  if (!isBwrapAvailable(config.probe)) {
    return {
      command,
      cwd: full.workspacePath,
      mode,
      applied: false,
      warning: "bwrap binary not found on host; running the command unsandboxed",
    };
  }
  return {
    command: buildBwrapCommandString(command, full),
    cwd: full.workspacePath,
    mode,
    applied: true,
  };
}

/** Sandbox mode from the environment (`THEBE_SANDBOX`). */
export function sandboxModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SandboxMode {
  return env.THEBE_SANDBOX?.trim().toLowerCase() === "bwrap" ? "bwrap" : "off";
}

/** Network access inside the sandbox (`THEBE_SANDBOX_NETWORK=deny`). */
export function sandboxNetworkFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.THEBE_SANDBOX_NETWORK?.trim().toLowerCase() !== "deny";
}
