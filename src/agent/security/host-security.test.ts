import { afterEach, describe, expect, it } from "vitest";
import {
  coreRunsInContainer,
  resolveHostSecurity,
  setConfiguredSandboxEnabled,
} from "./host-security.ts";

afterEach(() => {
  setConfiguredSandboxEnabled(undefined);
});

describe("resolveHostSecurity", () => {
  it("uses the OS sandbox on a host and stays off inside a container", () => {
    const host = resolveHostSecurity({}, { inContainer: false });
    expect(host.sandboxMode).toBe("os");
    expect(host.commandGuard).toBe(true);
    expect(host.workspaceEscapes).toBe(false);
    expect(host.dockerGuard).toEqual({
      blockPrivileged: true,
      blockHostRootMounts: true,
      blockDockerSocketMount: true,
      blockVolumePrune: true,
    });
    expect(resolveHostSecurity({}, { inContainer: true }).sandboxMode).toBe(
      "off"
    );
  });

  it("accepts only off, including in a container", () => {
    expect(
      resolveHostSecurity({ THEBE_SANDBOX: "off" }, { inContainer: false })
        .sandboxMode
    ).toBe("off");
    expect(
      resolveHostSecurity({ THEBE_SANDBOX: " OFF " }, { inContainer: false })
        .sandboxMode
    ).toBe("off");
    expect(
      resolveHostSecurity({ THEBE_SANDBOX: "   " }, { inContainer: true })
        .sandboxMode
    ).toBe("off");
  });

  it("lets Agent settings turn a host sandbox off, unless the environment or a container forces it", () => {
    setConfiguredSandboxEnabled(false);
    expect(resolveHostSecurity({}, { inContainer: false }).sandboxMode).toBe(
      "off"
    );
    expect(
      resolveHostSecurity({ THEBE_SANDBOX: "off" }, { inContainer: false })
        .sandboxMode
    ).toBe("off");
    setConfiguredSandboxEnabled(true);
    expect(resolveHostSecurity({}, { inContainer: false }).sandboxMode).toBe(
      "os"
    );
    expect(resolveHostSecurity({}, { inContainer: true }).sandboxMode).toBe(
      "off"
    );
    expect(
      resolveHostSecurity({ THEBE_SANDBOX: "off" }, { inContainer: false })
        .sandboxMode
    ).toBe("off");
  });

  it("ignores old backend names and any other value", () => {
    for (const value of [
      "os",
      "auto",
      "vm",
      "gondolin",
      "bwrap",
      "docker",
      "seatbelt",
      "firecracker",
    ]) {
      expect(
        resolveHostSecurity({ THEBE_SANDBOX: value }, { inContainer: false })
          .sandboxMode
      ).toBe("os");
      expect(
        resolveHostSecurity({ THEBE_SANDBOX: value }, { inContainer: true })
          .sandboxMode
      ).toBe("off");
    }
  });

  it("no longer reads the removed switches", () => {
    const settings = resolveHostSecurity(
      {
        THEBE_SCENARIO: "homelab-host",
        THEBE_COMMAND_GUARD: "off",
        THEBE_ALLOW_WORKSPACE_ESCAPES: "true",
        THEBE_SANDBOX_NETWORK: "deny",
      },
      { inContainer: true }
    );
    expect(settings).toMatchObject({
      commandGuard: true,
      workspaceEscapes: false,
      sandboxMode: "off",
    });
    expect(settings).not.toHaveProperty("sandboxNetwork");
  });
});

describe("coreRunsInContainer", () => {
  it("recognizes docker and podman markers", () => {
    expect(coreRunsInContainer((path) => path === "/.dockerenv")).toBe(true);
    expect(coreRunsInContainer((path) => path === "/run/.containerenv")).toBe(
      true
    );
    expect(coreRunsInContainer(() => false)).toBe(false);
  });
});
