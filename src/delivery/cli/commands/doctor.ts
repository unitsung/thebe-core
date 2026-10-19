import { loadEnvLocal } from "../../../app/config/env.ts";
import { loadThebeConfig } from "../../tui/settings/config.ts";
import { buildIsolationReport } from "../../../agent/security/isolation.ts";

/**
 * `thebe doctor` — report the effective isolation posture without starting the
 * server or the agent, so it still works when configuration is broken.
 *
 * Exits non-zero when the OS sandbox cannot run (commands would be refused),
 * or when the workspace is missing. A `THEBE_SANDBOX` value other than `off`
 * is ignored.
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
      `  escapes:      ${workspace.allowsGlobalEscapes ? "allowed" : "confined"}`
    );
  }

  const status = sandbox.enforced
    ? "ACTIVE"
    : sandbox.mode === "off"
      ? "off"
      : "NOT ENFORCED";
  lines.push(`sandbox mode:   ${sandbox.mode}`);
  lines.push(`sandbox status: ${status}`);
  if (sandbox.reason) {
    lines.push(`  ${sandbox.reason}`);
  }

  lines.push(
    `docker guard:   privileged=${report.dockerGuard.blockPrivileged ? "block" : "allow"}` +
      ` host-root=${report.dockerGuard.blockHostRootMounts ? "block" : "allow"}` +
      ` socket=${report.dockerGuard.blockDockerSocketMount ? "block" : "allow"}` +
      ` volume-prune=${report.dockerGuard.blockVolumePrune ? "block" : "allow"}`
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
  if (sandbox.mode !== "off" && !sandbox.enforced) {
    lines.push(
      "⚠ The OS sandbox is not available. Bash commands will be refused."
    );
    lines.push("  Install its dependencies, or set THEBE_SANDBOX=off.");
    exitCode = 1;
  } else if (!workspace.path || !workspace.exists) {
    lines.push(
      "⚠ The workspace is not configured or does not exist; Core would refuse to start."
    );
    exitCode = 1;
  } else if (report.warnings.length > 0) {
    lines.push(
      `⚠ ${report.warnings.length} safety layer(s) relaxed (above); Core will start anyway.`
    );
  } else {
    lines.push("✓ isolation looks correct for this host.");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return exitCode;
}
