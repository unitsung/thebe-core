import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Command sandboxing for the bash tool.
 *
 * Ported from the pre-refactor `src/sandbox/bwrap.ts` + `runner.ts` and extended
 * with the backends this product actually deploys on:
 *
 * - `bwrap` (Linux/NAS, the isolation research doc's phase 2): read-only host,
 *   ephemeral `/tmp`, workspace-only writes, no capabilities, namespaces unshared.
 * - `docker` (any host with a Docker daemon, NAS hosts included): a disposable
 *   container with `--read-only`, `--cap-drop ALL`, no network unless allowed,
 *   and the workspace bind-mounted read-write.
 * - `seatbelt` (macOS developers): `sandbox-exec` with a generated profile that
 *   confines writes to the workspace and `/tmp` and denies network by default.
 * - `gondolin` (phase 3, Pi's official micro-VM extension): routed in
 *   `open-session.ts`, not by rewriting the command string.
 *
 * `THEBE_SANDBOX` selects the mode (or inherits it from a `THEBE_SCENARIO`
 * preset). Every backend degrades to the raw command with a warning when its
 * binary or daemon is missing, so Core keeps working everywhere.
 */

export type SandboxMode = "off" | "bwrap" | "docker" | "seatbelt" | "gondolin";

export type SandboxConfig = {
  mode: SandboxMode;
  workspacePath: string;
  allowNetwork?: boolean;
  dropCapabilities?: boolean;
  /** Container image for the `docker` backend. */
  image?: string;
};

export type WrappedCommand = {
  command: string;
  cwd?: string;
  mode: SandboxMode;
  applied: boolean;
  warning?: string;
};

export const DEFAULT_SANDBOX_IMAGE = "alpine:3";

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

/**
 * Docker arguments for a disposable, unprivileged container run.
 *
 * `--read-only` makes the container filesystem immutable, `--cap-drop ALL` +
 * `no-new-privileges` remove escalation paths, `--network none` (unless allowed)
 * cuts off the LAN and the internet, and only the workspace is bind-mounted
 * read-write. `--rm` keeps no container behind.
 */
export function buildDockerArgs(
  command: string,
  config: SandboxConfig,
): string[] {
  const workspace = resolve(config.workspacePath);
  const image = config.image?.trim() || DEFAULT_SANDBOX_IMAGE;
  const args: string[] = ["run", "--rm", "-i"];
  args.push("--network", config.allowNetwork ? "bridge" : "none");
  args.push("--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m");
  if (config.dropCapabilities !== false) {
    args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
  }
  args.push("-v", `${workspace}:${workspace}:rw`, "-w", workspace);
  args.push(image, "/bin/sh", "-lc", command);
  return args;
}

export function buildDockerCommandString(
  command: string,
  config: SandboxConfig,
): string {
  return `docker ${buildDockerArgs(command, config).map(quoteShellArg).join(" ")}`;
}

/**
 * macOS seatbelt profile: reads stay open, writes are confined to the
 * workspace and temporary directories, and the network is denied unless the
 * caller allows it. Seatbelt matches canonical paths, so `/var/folders/...`
 * (`TMPDIR`) is emitted as its `/private/var/...` form too.
 */
export function buildSeatbeltProfile(config: SandboxConfig): string {
  const workspace = canonicalPath(config.workspacePath);
  const temp = process.env.TMPDIR ? canonicalPath(process.env.TMPDIR) : "/tmp";
  const writePaths = [...new Set([workspace, temp, "/tmp", "/private/tmp"])];
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    "(allow file-write* " +
      writePaths.map((path) => `(subpath ${JSON.stringify(path)})`).join(" ") +
      ' (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))',
    ...(config.allowNetwork ? ["(allow network*)"] : []),
  ];
  return rules.join("");
}

function canonicalPath(target: string): string {
  const resolved = resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function buildSeatbeltCommandString(
  command: string,
  config: SandboxConfig,
): string {
  return `sandbox-exec -p ${quoteShellArg(buildSeatbeltProfile(config))} /bin/sh -lc ${quoteShellArg(command)}`;
}

function quoteShellArg(arg: string): string {
  return /^[a-zA-Z0-9_\-./:=,]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, "'\\''")}'`;
}

let bwrapProbe: boolean | undefined;
let dockerProbe: boolean | undefined;
let seatbeltProbe: boolean | undefined;

/** Whether `bwrap` exists on this host (cached; injectable for tests). */
export function isBwrapAvailable(probe?: () => boolean): boolean {
  if (probe) return probe();
  bwrapProbe ??= defaultBwrapProbe();
  return bwrapProbe;
}

/** Whether a Docker daemon answers (cached; injectable for tests). */
export function isDockerAvailable(probe?: () => boolean): boolean {
  if (probe) return probe();
  dockerProbe ??= defaultDockerProbe();
  return dockerProbe;
}

/** Whether the macOS seatbelt sandbox is usable (cached; injectable for tests). */
export function isSeatbeltAvailable(probe?: () => boolean): boolean {
  if (probe) return probe();
  seatbeltProbe ??= defaultSeatbeltProbe();
  return seatbeltProbe;
}

/** Test hook: forget every cached probe result. */
export function resetSandboxProbes(): void {
  bwrapProbe = undefined;
  dockerProbe = undefined;
  seatbeltProbe = undefined;
}

function defaultBwrapProbe(): boolean {
  return binaryAnswers("bwrap", ["--version"]);
}

function defaultDockerProbe(): boolean {
  // `--version` only proves the CLI exists; the daemon is what runs commands.
  return binaryAnswers("docker", ["info", "--format", "{{.ServerVersion}}"]);
}

function defaultSeatbeltProbe(): boolean {
  if (process.platform !== "darwin") return false;
  // `-h` is not a valid flag (exit 64); prove it can actually sandbox a process.
  return binaryAnswers("sandbox-exec", [
    "-p",
    "(version 1)(allow default)",
    "/usr/bin/true",
  ]);
}

function binaryAnswers(binary: string, args: string[]): boolean {
  try {
    return spawnSync(binary, args, { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Which backends this host can actually run right now. */
export function sandboxAvailability(
  probes: Partial<Record<SandboxMode, () => boolean>> = {},
): Record<SandboxMode, boolean> {
  return {
    off: true,
    bwrap: isBwrapAvailable(probes.bwrap),
    docker: isDockerAvailable(probes.docker),
    seatbelt: isSeatbeltAvailable(probes.seatbelt),
    // The micro-VM needs both the package and QEMU; `gondolinBackendReady` checks it.
    gondolin: probes.gondolin ? probes.gondolin() : false,
  };
}

export function sandboxUnavailableReason(mode: SandboxMode): string {
  switch (mode) {
    case "bwrap":
      return "bwrap binary not found on host; install bubblewrap (apt install bubblewrap)";
    case "docker":
      return "no Docker daemon reachable; start Docker or use another sandbox mode";
    case "seatbelt":
      return "sandbox-exec is only available on macOS";
    case "gondolin":
      return "Gondolin micro-VM is not ready; install @earendil-works/gondolin and QEMU";
    default:
      return "sandbox disabled";
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
    image?: string;
    probe?: () => boolean;
  } = {},
): WrappedCommand {
  const mode = config.mode ?? "off";
  if (mode === "gondolin") {
    // The Micro-VM backend runs the command itself (see
    // `adapters/gondolin/bash-operations.ts`), so there is nothing to rewrite.
    return {
      command,
      mode,
      applied: false,
      warning: "gondolin sandbox executes through the Micro-VM bash backend",
    };
  }
  if (mode === "off" || !config.workspacePath) {
    return { command, mode: "off", applied: false };
  }
  const full: SandboxConfig = {
    mode,
    workspacePath: config.workspacePath,
    allowNetwork: config.allowNetwork ?? true,
    dropCapabilities: true,
    image: config.image,
  };
  const available =
    mode === "bwrap"
      ? isBwrapAvailable(config.probe)
      : mode === "docker"
        ? isDockerAvailable(config.probe)
        : isSeatbeltAvailable(config.probe);
  if (!available) {
    return {
      command,
      cwd: full.workspacePath,
      mode,
      applied: false,
      warning: sandboxUnavailableReason(mode),
    };
  }
  const wrapped =
    mode === "bwrap"
      ? buildBwrapCommandString(command, full)
      : mode === "docker"
        ? buildDockerCommandString(command, full)
        : buildSeatbeltCommandString(command, full);
  return {
    command: wrapped,
    cwd: full.workspacePath,
    mode,
    applied: true,
  };
}
