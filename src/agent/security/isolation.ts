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
import { DSH_RUNTIME_ID } from "../runtime/interface.ts";

/**
 * The effective isolation posture, for operators and clients.
 *
 * `fallback` stays false. `enforced` means either the Pi OS sandbox has its
 * dependencies or the DSH runtime owns a file sandbox. DSH also carries a
 * warning because its SDK does not expose Core's host network policy.
 */
export type IsolationReport = {
  runtimeId: string | null;
  commandGuard: boolean;
  workspace: {
    path: string | null;
    confinesEscapes: boolean;
    allowsGlobalEscapes: boolean;
    exists: boolean;
  };
  sandbox: {
    mode: SandboxMode | "dsh";
    /** The selected runtime exposes an enforcing file sandbox. */
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
    runtimeId?: string;
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
  const mode: SandboxMode | "dsh" =
    options.runtimeId === DSH_RUNTIME_ID && !inContainer
      ? "dsh"
      : settings.sandboxMode;
  const dependencies =
    mode === "os"
      ? (options.dependencies ?? osSandboxDependencies())
      : undefined;
  const enforced =
    mode === "dsh" ||
    (mode === "os" && (dependencies?.errors.length ?? 0) === 0);
  const reason =
    mode === "dsh"
      ? "DeepSeek Harness owns its host file sandbox; Core does not probe it."
      : mode === "os" && !enforced
        ? osSandboxUnavailableReason(
            dependencies ?? { errors: [], warnings: [] }
          )
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
  if (mode === "dsh") {
    warnings.push(
      "DeepSeek Harness tools use its runtime-owned file sandbox. The Core host network allowlist does not cover those tools."
    );
  }

  return {
    runtimeId: options.runtimeId ?? null,
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
      verified: mode !== "dsh",
      ...(reason ? { reason } : {}),
    },
    dockerGuard: settings.dockerGuard,
    warnings,
  };
}
