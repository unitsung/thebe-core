import { existsSync } from "node:fs";
import {
  sandboxAvailability,
  sandboxUnavailableReason,
  type SandboxMode,
} from "./command-sandbox.ts";
import { resolveHostSecurity } from "./host-security.ts";
import type { DockerProxyPolicy } from "./docker-api-guard.ts";

/**
 * The effective isolation posture, for operators and clients.
 *
 * The point of this report is to answer one question that the environment
 * variables cannot: **is the requested sandbox actually in effect, or would the
 * bash tool silently run unsandboxed?** `bwrap`, `docker`, and `seatbelt` fall
 * back to the raw command when their backend is missing; `gondolin` fails
 * closed instead. `fallback` is the dangerous case and must be surfaced.
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
    /** Bash is isolated (or, for gondolin, would refuse rather than run raw). */
    enforced: boolean;
    /** A requested backend is unavailable: commands would run UNSANDBOXED. */
    fallback: boolean;
    /** Whether the backend was probed on this host (false for the micro-VM). */
    verified: boolean;
    /** Which backends this host can run right now. */
    backends: Record<SandboxMode, boolean>;
    reason?: string;
  };
  dockerGuard: Required<DockerProxyPolicy>;
  /** Human-readable notices for every safety layer that is currently relaxed. */
  warnings: string[];
};

export function buildIsolationReport(
  options: {
    env?: NodeJS.ProcessEnv;
    workspacePath?: string | null;
    probes?: Partial<Record<SandboxMode, () => boolean>>;
  } = {},
): IsolationReport {
  const env = options.env ?? process.env;
  const workspacePath = options.workspacePath?.trim() || null;
  const backends = sandboxAvailability(options.probes ?? {});
  const settings = resolveHostSecurity(env, backends);
  const mode = settings.sandboxMode;
  const isMicroVm = mode === "gondolin";
  const available = backends[mode];
  const enforced = mode === "off" ? false : isMicroVm ? true : available;
  const fallback = mode !== "off" && !isMicroVm && !available;
  const reason = fallback
    ? sandboxUnavailableReason(mode)
    : isMicroVm
      ? "readiness is confirmed by the gondolin adapter on first use; it fails closed rather than running unsandboxed"
      : undefined;

  const warnings: string[] = [];
  if ((env.THEBE_ALLOWED_HOSTS ?? "").split(",").some((value) => value.trim() === "*")) {
    warnings.push(
      "THEBE_ALLOWED_HOSTS=* accepts any Host header; the DNS-rebinding check is disabled.",
    );
  }
  if (fallback) {
    warnings.push(
      `The ${mode} sandbox is unavailable; bash commands run unsandboxed.`,
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
      fallback,
      verified: !isMicroVm,
      backends,
      ...(reason ? { reason } : {}),
    },
    dockerGuard: settings.dockerGuard,
    warnings,
  };
}
