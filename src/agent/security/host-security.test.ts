import { describe, expect, it } from "vitest";
import { parseSandboxMode, resolveHostSecurity } from "./host-security.ts";
import type { SandboxMode } from "./command-sandbox.ts";

const none: Record<SandboxMode, boolean> = {
  off: true,
  bwrap: false,
  docker: false,
  seatbelt: false,
  gondolin: false,
};

describe("resolveHostSecurity", () => {
  it("keeps the guard on, confines to the workspace and leaves the sandbox off by default", () => {
    const settings = resolveHostSecurity({});
    expect(settings.commandGuard).toBe(true);
    expect(settings.workspaceEscapes).toBe(false);
    expect(settings.sandboxMode).toBe("off");
    expect(settings.sandboxNetwork).toBe(true);
    expect(settings.dockerGuard).toEqual({
      blockPrivileged: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    });
  });

  it("no longer reads the removed switches", () => {
    const settings = resolveHostSecurity({
      THEBE_SCENARIO: "homelab-host",
      THEBE_COMMAND_GUARD: "off",
      THEBE_ALLOW_WORKSPACE_ESCAPES: "true",
      THEBE_SANDBOX_NETWORK: "deny",
    });
    expect(settings).toMatchObject({ commandGuard: true, workspaceEscapes: false, sandboxNetwork: true });
  });
});

describe("parseSandboxMode", () => {
  it("takes the named backends and treats anything else as off", () => {
    for (const mode of ["off", "bwrap", "docker", "seatbelt", "gondolin"] as const) {
      expect(parseSandboxMode(mode)).toBe(mode);
    }
    expect(parseSandboxMode(" BWRAP ")).toBe("bwrap");
    expect(parseSandboxMode("firecracker")).toBe("off");
    expect(parseSandboxMode(undefined)).toBe("off");
  });

  it("auto picks what this machine can run", () => {
    expect(parseSandboxMode("auto", "darwin", { ...none, seatbelt: true })).toBe("seatbelt");
    expect(parseSandboxMode("auto", "linux", { ...none, bwrap: true })).toBe("bwrap");
    expect(parseSandboxMode("auto", "linux", { ...none, docker: true })).toBe("docker");
    // Nothing available: it names the native backend, so the report says what is missing.
    expect(parseSandboxMode("auto", "linux", none)).toBe("bwrap");
    expect(parseSandboxMode("auto", "darwin", none)).toBe("seatbelt");
  });
});
