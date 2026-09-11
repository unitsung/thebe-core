import { describe, expect, it } from "vitest";
import { wrapBashCommand } from "./runner.ts";

describe("Sandbox Runner Command Wrapping", () => {
  it("passes command through unmodified when mode is none", () => {
    const res = wrapBashCommand("ls -la", { mode: "none" });
    expect(res.command).toBe("ls -la");
    expect(res.appliedSandbox).toBe(false);
  });

  it("applies bwrap wrapping when bwrap is available", () => {
    const res = wrapBashCommand(
      "uptime",
      {
        mode: "bwrap",
        workspacePath: "/volume1/docker/app",
        allowNetwork: false,
      },
      () => true, // Mock bwrap is available
    );

    expect(res.appliedSandbox).toBe(true);
    expect(res.mode).toBe("bwrap");
    expect(res.command.startsWith("bwrap ")).toBe(true);
    expect(res.command).toContain("--bind /volume1/docker/app /volume1/docker/app");
    expect(res.command).toContain("--unshare-net");
    expect(res.cwd).toBe("/volume1/docker/app");
  });

  it("gracefully falls back to workspace-jail when bwrap is unavailable", () => {
    const res = wrapBashCommand(
      "echo 'test'",
      {
        mode: "bwrap",
        workspacePath: "/home/user/workspace",
      },
      () => false, // Mock bwrap is NOT available
    );

    expect(res.appliedSandbox).toBe(false);
    expect(res.mode).toBe("workspace-jail");
    expect(res.command).toBe("echo 'test'");
    expect(res.cwd).toBe("/home/user/workspace");
    expect(res.warning).toContain("bwrap binary not found");
  });

  it("sets cwd to workspace in workspace-jail mode", () => {
    const res = wrapBashCommand("pwd", {
      mode: "workspace-jail",
      workspacePath: "/opt/homelab",
    });

    expect(res.appliedSandbox).toBe(true);
    expect(res.mode).toBe("workspace-jail");
    expect(res.cwd).toBe("/opt/homelab");
    expect(res.command).toBe("pwd");
  });
});
