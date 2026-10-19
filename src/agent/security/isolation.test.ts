import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIsolationReport } from "./isolation.ts";

const dir = mkdtempSync(join(tmpdir(), "thebe-isolation-"));
const ready = { errors: [], warnings: [] };

describe("buildIsolationReport", () => {
  it("reports no sandbox when the mode is off", () => {
    const report = buildIsolationReport({
      env: { THEBE_SANDBOX: "off" },
      workspacePath: dir,
      inContainer: false,
    });
    expect(report.sandbox.mode).toBe("off");
    expect(report.sandbox.enforced).toBe(false);
    expect(report.sandbox.fallback).toBe(false);
    expect(report.sandbox.verified).toBe(true);
    expect(report.sandbox.reason).toBeUndefined();
    expect(report.commandGuard).toBe(true);
    expect(report.sandbox).not.toHaveProperty("backends");
  });

  it("treats an unset host as an enforced OS sandbox when dependencies are present", () => {
    const report = buildIsolationReport({
      env: {},
      workspacePath: dir,
      inContainer: false,
      dependencies: ready,
    });
    expect(report.sandbox.mode).toBe("os");
    expect(report.sandbox.enforced).toBe(true);
    expect(report.sandbox.fallback).toBe(false);
    expect(report.sandbox.reason).toBeUndefined();
    expect(report.workspace.exists).toBe(true);
    expect(report.workspace.confinesEscapes).toBe(true);
  });

  it("refuses rather than falling back when the OS sandbox cannot start", () => {
    const report = buildIsolationReport({
      env: {},
      workspacePath: dir,
      inContainer: false,
      dependencies: { errors: ["bubblewrap (bwrap) not found"], warnings: [] },
    });
    expect(report.sandbox.mode).toBe("os");
    expect(report.sandbox.enforced).toBe(false);
    expect(report.sandbox.fallback).toBe(false);
    expect(report.sandbox.reason).toContain("will be refused");
    expect(report.warnings).toEqual([]);
  });

  it("stays off inside the release container when the variable is unset", () => {
    const report = buildIsolationReport({
      env: {},
      workspacePath: dir,
      inContainer: true,
    });
    expect(report.sandbox.mode).toBe("off");
    expect(report.sandbox.enforced).toBe(false);
    expect(report.warnings).toEqual([]);
  });

  it("ignores a named backend and follows the install shape", () => {
    const host = buildIsolationReport({
      env: { THEBE_SANDBOX: "bwrap" },
      workspacePath: dir,
      inContainer: false,
      dependencies: ready,
    });
    expect(host.sandbox.mode).toBe("os");
    expect(host.sandbox.enforced).toBe(true);
    const container = buildIsolationReport({
      env: { THEBE_SANDBOX: "vm" },
      workspacePath: dir,
      inContainer: true,
    });
    expect(container.sandbox.mode).toBe("off");
    expect(container.sandbox.enforced).toBe(false);
  });

  it("marks a missing workspace", () => {
    const report = buildIsolationReport({
      env: { THEBE_SANDBOX: "off" },
      workspacePath: join(dir, "does-not-exist"),
    });
    expect(report.workspace.exists).toBe(false);
  });

  it("warns when the Host check is switched off", () => {
    const report = buildIsolationReport({
      env: { THEBE_ALLOWED_HOSTS: "*" },
      workspacePath: dir,
      inContainer: false,
      dependencies: ready,
    });
    expect(report.warnings).toEqual([expect.stringContaining("any Host")]);
  });

  it("has no warnings on a clean local posture", () => {
    const report = buildIsolationReport({
      env: {},
      workspacePath: dir,
      inContainer: false,
      dependencies: ready,
    });
    expect(report.warnings).toEqual([]);
  });
});
