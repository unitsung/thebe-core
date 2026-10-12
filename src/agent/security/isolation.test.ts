import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIsolationReport } from "./isolation.ts";

const dir = mkdtempSync(join(tmpdir(), "thebe-isolation-"));

describe("buildIsolationReport", () => {
  it("reports no sandbox when the mode is off", () => {
    const report = buildIsolationReport({ env: {}, workspacePath: dir });
    expect(report.sandbox.mode).toBe("off");
    expect(report.sandbox.enforced).toBe(false);
    expect(report.sandbox.fallback).toBe(false);
    expect(report.sandbox.verified).toBe(true);
    expect(report.sandbox.reason).toBeUndefined();
    expect(report.commandGuard).toBe(true);
  });

  it("marks a requested sandbox active when its backend answers", () => {
    const report = buildIsolationReport({
      env: { THEBE_SANDBOX: "bwrap" },
      workspacePath: dir,
      probes: { bwrap: () => true },
    });
    expect(report.sandbox.mode).toBe("bwrap");
    expect(report.sandbox.enforced).toBe(true);
    expect(report.sandbox.fallback).toBe(false);
    expect(report.sandbox.reason).toBeUndefined();
  });

  it("flags a requested sandbox that would silently run unsandboxed", () => {
    const report = buildIsolationReport({
      env: { THEBE_SANDBOX: "bwrap" },
      workspacePath: dir,
      probes: { bwrap: () => false },
    });
    expect(report.sandbox.enforced).toBe(false);
    expect(report.sandbox.fallback).toBe(true);
    expect(report.sandbox.reason).toContain("bwrap");
  });

  it("treats the micro-VM as fail-closed, not a silent fallback", () => {
    const report = buildIsolationReport({
      env: { THEBE_SANDBOX: "gondolin" },
      workspacePath: dir,
    });
    expect(report.sandbox.mode).toBe("gondolin");
    expect(report.sandbox.fallback).toBe(false);
    expect(report.sandbox.enforced).toBe(true);
    expect(report.sandbox.verified).toBe(false);
  });

  it("resolves the scenario preset and the workspace state", () => {
    const report = buildIsolationReport({
      env: { THEBE_SCENARIO: "nas-strict" },
      workspacePath: dir,
      probes: { bwrap: () => true },
    });
    expect(report.scenario).toBe("nas-strict");
    expect(report.sandbox.mode).toBe("bwrap");
    expect(report.sandbox.enforced).toBe(true);
    expect(report.workspace.exists).toBe(true);
    expect(report.workspace.confinesEscapes).toBe(true);
  });

  it("marks a missing workspace and allowed escapes", () => {
    const report = buildIsolationReport({
      env: { THEBE_ALLOW_WORKSPACE_ESCAPES: "true" },
      workspacePath: join(dir, "does-not-exist"),
    });
    expect(report.workspace.exists).toBe(false);
    expect(report.workspace.allowsGlobalEscapes).toBe(true);
    expect(report.workspace.confinesEscapes).toBe(false);
  });

  it("warns when safety layers are relaxed", () => {
    const report = buildIsolationReport({
      env: {
        THEBE_ALLOWED_HOSTS: "*",
        THEBE_COMMAND_GUARD: "off",
        THEBE_ALLOW_WORKSPACE_ESCAPES: "true",
      },
      workspacePath: dir,
    });
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("any Host"),
        expect.stringContaining("command guard is off"),
        expect.stringContaining("Workspace escapes"),
      ]),
    );
  });

  it("has no warnings on a clean local posture", () => {
    const report = buildIsolationReport({ env: {}, workspacePath: dir });
    expect(report.warnings).toEqual([]);
  });
});
