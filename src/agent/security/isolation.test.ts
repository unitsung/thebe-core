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

  it("picks the backend for THEBE_SANDBOX=auto and reports the workspace state", () => {
    const report = buildIsolationReport({
      env: { THEBE_SANDBOX: "auto" },
      workspacePath: dir,
      probes: { bwrap: () => true, seatbelt: () => true },
    });
    expect(report.sandbox.mode).toBe(process.platform === "darwin" ? "seatbelt" : "bwrap");
    expect(report.sandbox.enforced).toBe(true);
    expect(report.workspace.exists).toBe(true);
    expect(report.workspace.confinesEscapes).toBe(true);
  });

  it("marks a missing workspace", () => {
    const report = buildIsolationReport({
      env: {},
      workspacePath: join(dir, "does-not-exist"),
    });
    expect(report.workspace.exists).toBe(false);
  });

  it("warns when the Host check is switched off", () => {
    const report = buildIsolationReport({
      env: { THEBE_ALLOWED_HOSTS: "*" },
      workspacePath: dir,
    });
    expect(report.warnings).toEqual([expect.stringContaining("any Host")]);
  });

  it("has no warnings on a clean local posture", () => {
    const report = buildIsolationReport({ env: {}, workspacePath: dir });
    expect(report.warnings).toEqual([]);
  });
});
