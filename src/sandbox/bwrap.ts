import path from "node:path";
import type { SandboxConfig } from "./types.ts";

/**
 * Builds bubblewrap (bwrap) arguments for running commands inside a secure Linux jail.
 *
 * Security properties:
 * - Read-only rootfs (--ro-bind / /): Host files cannot be modified, preventing system corruption.
 * - Ephemeral /tmp (--tmpfs /tmp): Scratch files live in RAM and disappear on exit.
 * - Minimal devfs (--dev /dev) & private proc (--proc /proc).
 * - Read-write workspace (--bind <workspacePath> <workspacePath>): ONLY the declared workspace is writable.
 * - Namespaces isolation (--unshare-all): PID, IPC, UTS, and user namespaces isolated.
 * - Capability drop (--cap-drop ALL): Prevents root privilege escalation.
 * - Process lifecycle (--die-with-parent): Prevents zombie processes.
 * - Network isolation: Optional --unshare-net if allowNetwork is false.
 */
export function buildBwrapArgs(
  command: string,
  config: SandboxConfig,
): string[] {
  const normWorkspace = path.resolve(config.workspacePath);
  const args: string[] = [
    // 1. Core namespaces
    "--unshare-all",
    "--die-with-parent",
  ];

  // 2. Network isolation
  if (!config.allowNetwork) {
    args.push("--unshare-net");
  } else {
    args.push("--share-net");
  }

  // 3. Drop all Linux capabilities
  if (config.dropCapabilities !== false) {
    args.push("--cap-drop", "ALL");
  }

  // 4. File system layout
  // Mount host root read-only
  args.push("--ro-bind", "/", "/");

  // Mount clean ephemeral devices and proc
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");
  args.push("--tmpfs", "/tmp");

  // Mount the authorized workspace as the ONLY read-write location
  args.push("--bind", normWorkspace, normWorkspace);

  // Set working directory inside workspace
  args.push("--chdir", normWorkspace);

  // 5. Shell command execution
  args.push("/bin/sh", "-lc", command);

  return args;
}

export function buildBwrapCommandString(
  command: string,
  config: SandboxConfig,
): string {
  const args = buildBwrapArgs(command, config);
  // Safely quote arguments
  const quoted = args.map((arg) => {
    if (/^[a-zA-Z0-9_\-\.\/]+$/.test(arg)) {
      return arg;
    }
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  });
  return `bwrap ${quoted.join(" ")}`;
}
