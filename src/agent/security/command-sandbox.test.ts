import { describe, expect, it } from "vitest";
import {
  buildBwrapArgs,
  buildBwrapCommandString,
  sandboxModeFromEnv,
  sandboxNetworkFromEnv,
  wrapCommandForSandbox,
} from "./command-sandbox.ts";

describe("Command sandbox (bubblewrap)", () => {
  it("builds correct bwrap isolation arguments", () => {
    const config = {
      mode: "bwrap" as const,
      workspacePath: "/volume1/docker/my-app",
      allowNetwork: false,
      readOnlyHost: true,
      dropCapabilities: true,
    };

    const args = buildBwrapArgs("npm install", config);

    // Namespaces
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--die-with-parent");

    // Network isolation
    expect(args).toContain("--unshare-net");

    // Capabilities dropped
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");

    // Root mounted read-only
    const roBindIndex = args.indexOf("--ro-bind");
    expect(roBindIndex).toBeGreaterThanOrEqual(0);
    expect(args[roBindIndex + 1]).toBe("/");
    expect(args[roBindIndex + 2]).toBe("/");

    // Ephemeral devices and /tmp
    expect(args).toContain("--dev");
    expect(args).toContain("--proc");
    expect(args).toContain("--tmpfs");

    // Workspace mounted read-write
    const bindIndex = args.indexOf("--bind");
    expect(bindIndex).toBeGreaterThanOrEqual(0);
    expect(args[bindIndex + 1]).toBe("/volume1/docker/my-app");
    expect(args[bindIndex + 2]).toBe("/volume1/docker/my-app");

    // Chdir to workspace
    const chdirIndex = args.indexOf("--chdir");
    expect(chdirIndex).toBeGreaterThanOrEqual(0);
    expect(args[chdirIndex + 1]).toBe("/volume1/docker/my-app");

    // Command
    expect(args.slice(-3)).toEqual(["/bin/sh", "-lc", "npm install"]);
  });

  it("builds bwrap command string with shell escaping", () => {
    const config = {
      mode: "bwrap" as const,
      workspacePath: "/opt/app",
      allowNetwork: true,
    };

    const cmdStr = buildBwrapCommandString("echo 'hello world'", config);
    expect(cmdStr.startsWith("bwrap ")).toBe(true);
    expect(cmdStr).toContain("--share-net");
    expect(cmdStr).toContain("--bind /opt/app /opt/app");
    expect(cmdStr).toContain("--ro-bind / /");
  });
});

describe("Sandbox command wrapping", () => {
  it("passes command through unmodified when mode is none", () => {
    const res = wrapCommandForSandbox("ls -la", { mode: "off" });
    expect(res.command).toBe("ls -la");
    expect(res.applied).toBe(false);
  });

  it("applies bwrap wrapping when bwrap is available", () => {
    const res = wrapCommandForSandbox(
      "uptime",
      {
        mode: "bwrap",
        workspacePath: "/volume1/docker/app",
        allowNetwork: false,
        probe: () => true, // Mock bwrap is available
      },
    );

    expect(res.applied).toBe(true);
    expect(res.mode).toBe("bwrap");
    expect(res.command.startsWith("bwrap ")).toBe(true);
    expect(res.command).toContain("--bind /volume1/docker/app /volume1/docker/app");
    expect(res.command).toContain("--unshare-net");
    expect(res.cwd).toBe("/volume1/docker/app");
  });

  it("falls back to the raw command when bwrap is unavailable", () => {
    const res = wrapCommandForSandbox(
      "echo 'test'",
      {
        mode: "bwrap",
        workspacePath: "/home/user/workspace",
        probe: () => false, // Mock bwrap is NOT available
      },
    );

    expect(res.applied).toBe(false);
    expect(res.command).toBe("echo 'test'");
    expect(res.cwd).toBe("/home/user/workspace");
    expect(res.warning).toContain("bwrap binary not found");
  });

});

describe("Sandbox environment configuration", () => {
  it("enables bwrap only when THEBE_SANDBOX says so", () => {
    expect(sandboxModeFromEnv({})).toBe("off");
    expect(sandboxModeFromEnv({ THEBE_SANDBOX: "off" })).toBe("off");
    expect(sandboxModeFromEnv({ THEBE_SANDBOX: "bwrap" })).toBe("bwrap");
    expect(sandboxModeFromEnv({ THEBE_SANDBOX: " BWRAP " })).toBe("bwrap");
  });

  it("keeps the network unless it is explicitly denied", () => {
    expect(sandboxNetworkFromEnv({})).toBe(true);
    expect(sandboxNetworkFromEnv({ THEBE_SANDBOX_NETWORK: "allow" })).toBe(true);
    expect(sandboxNetworkFromEnv({ THEBE_SANDBOX_NETWORK: "deny" })).toBe(false);
  });
});
