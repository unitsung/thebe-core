import { loadEnvLocal } from "../../../app/config/env.ts";
import { loadThebeConfig } from "../../tui/settings/config.ts";
import { buildIsolationReport } from "../../../agent/security/isolation.ts";

/**
 * `thebe doctor` — report the effective isolation posture without starting the
 * server or the agent, so it still works when configuration is broken.
 *
 * Exits non-zero when the requested sandbox would silently fall back to running
 * raw commands, or when the workspace is missing.
 */
export async function runDoctor(): Promise<number> {
  loadEnvLocal();
  const config = await loadThebeConfig().catch(() => undefined);
  const workspacePath =
    config?.workspacePath?.trim() ||
    process.env.THEBE_WORKSPACE_DIR?.trim() ||
    null;
  const report = buildIsolationReport({ workspacePath });
  const { sandbox, workspace } = report;

  const lines: string[] = [];
  lines.push("Thebe Core — isolation check");
  lines.push("");
  lines.push(`command guard:  ${report.commandGuard ? "on" : "off"}`);
  lines.push(`workspace:      ${workspace.path ?? "(not configured)"}`);
  if (workspace.path) {
    lines.push(`  exists:       ${workspace.exists ? "yes" : "NO"}`);
    lines.push(
      `  escapes:      ${workspace.allowsGlobalEscapes ? "allowed" : "confined"}`,
    );
  }

  const status = sandbox.enforced
    ? "ACTIVE"
    : sandbox.fallback
      ? "NOT ACTIVE"
      : "off";
  lines.push(`sandbox mode:   ${sandbox.mode}`);
  lines.push(`sandbox status: ${status}`);
  if (!sandbox.verified) {
    lines.push("  (micro-VM readiness is confirmed by the adapter on first use)");
  }
  if (sandbox.reason) {
    lines.push(`  ${sandbox.fallback ? "⚠ " : ""}${sandbox.reason}`);
  }
  const available = (Object.keys(sandbox.backends) as Array<keyof typeof sandbox.backends>)
    .filter((mode) => mode !== "off" && sandbox.backends[mode]);
  lines.push(`  backends:     ${available.length ? available.join(", ") : "none available"}`);

  lines.push(
    `docker guard:   privileged=${report.dockerGuard.blockPrivileged ? "block" : "allow"}` +
      ` host-root=${report.dockerGuard.blockHostRootMounts ? "block" : "allow"}` +
      ` socket=${report.dockerGuard.blockDockerSocketMount ? "block" : "allow"}` +
      ` volume-prune=${report.dockerGuard.blockVolumePrune ? "block" : "allow"}`,
  );
  lines.push("");

  if (report.warnings.length > 0) {
    lines.push("Security warnings:");
    for (const warning of report.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
    lines.push("");
  }

  let exitCode = 0;
  if (sandbox.fallback) {
    lines.push(
      "⚠ The requested sandbox is not in effect: bash commands would run UNSANDBOXED.",
    );
    lines.push(
      "  Install the backend (or set THEBE_SANDBOX=off to make that explicit).",
    );
    exitCode = 1;
  } else if (!workspace.path || !workspace.exists) {
    lines.push(
      "⚠ The workspace is not configured or does not exist; Core would refuse to start.",
    );
    exitCode = 1;
  } else if (report.warnings.length > 0) {
    lines.push(
      `⚠ ${report.warnings.length} safety layer(s) relaxed (above); Core will start anyway.`,
    );
  } else {
    lines.push("✓ isolation looks correct for this host.");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return exitCode;
}
