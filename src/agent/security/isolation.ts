import { existsSync } from "node:fs";
import type { DockerProxyPolicy } from "./docker-api-guard.ts";
import {
  coreRunsInContainer,
  resolveHostSecurity,
  type SandboxMode,
} from "./host-security.ts";
import {
  osSandboxDependencies,
  osSandboxUnavailableReason,
  type OsSandboxDependencyCheck,
} from "./os-sandbox.ts";

/**
 * The effective isolation posture, for operators and clients.
 *
 * `fallback` stays false: a sandbox that cannot run refuses the command
 * instead of executing it unsandboxed. `enforced` is true only for a host
 * `os` sandbox whose dependencies are present.
 */
export type IsolationReport = {
  commandGuard: boolean;
  workspace: {
    path: string | null;
    confinesEscapes: boolean;
    allowsGlobalEscapes: boolean;
    exists: boolean;
  };
  sandbox: {
    mode: SandboxMode;
    /** Bash commands are wrapped by the OS sandbox. */
    enforced: boolean;
    /** Always false. A missing sandbox refuses commands; it does not run them bare. */
    fallback: boolean;
    /** Dependencies were probed on this host. */
    verified: boolean;
    reason?: string;
  };
  dockerGuard: Required<DockerProxyPolicy>;
  /** Human-readable notices for every safety layer that is currently relaxed. */
  warnings: string[];
};

export { coreRunsInContainer };

export function buildIsolationReport(
  options: {
    env?: NodeJS.ProcessEnv;
    workspacePath?: string | null;
    /** Test seam. Defaults to detecting `/.dockerenv` or `/run/.containerenv`. */
    inContainer?: boolean;
    /** Test seam. Defaults to `SandboxManager.checkDependencies()`. */
    dependencies?: OsSandboxDependencyCheck;
  } = {}
): IsolationReport {
  const env = options.env ?? process.env;
  const workspacePath = options.workspacePath?.trim() || null;
  const inContainer = options.inContainer ?? coreRunsInContainer();
  const settings = resolveHostSecurity(env, { inContainer });
  const mode = settings.sandboxMode;
  const dependencies =
    mode === "os"
      ? (options.dependencies ?? osSandboxDependencies())
      : undefined;
  const enforced = mode === "os" && (dependencies?.errors.length ?? 0) === 0;
  const reason =
    mode === "os" && !enforced
      ? osSandboxUnavailableReason(dependencies ?? { errors: [], warnings: [] })
      : undefined;

  const warnings: string[] = [];
  if (
    (env.THEBE_ALLOWED_HOSTS ?? "")
      .split(",")
      .some((value) => value.trim() === "*")
  ) {
    warnings.push(
      "THEBE_ALLOWED_HOSTS=* accepts any Host header; the DNS-rebinding check is disabled."
    );
  }

  return {
    commandGuard: settings.commandGuard,
    workspace: {
      path: workspacePath,
      confinesEscapes: !settings.workspaceEscapes,
      allowsGlobalEscapes: settings.workspaceEscapes,
      exists: workspacePath ? existsSync(workspacePath) : false,
    },
    sandbox: {
      mode,
      enforced,
      fallback: false,
      verified: true,
      ...(reason ? { reason } : {}),
    },
    dockerGuard: settings.dockerGuard,
    warnings,
  };
}
