import { describe, expect, it, vi } from "vitest";
import {
  GondolinMicroVMRunner,
  toGuestWorkspacePath,
  type IMicroVMInstance,
} from "./gondolin-runner.ts";

describe("Gondolin Micro-VM Runner (Layer 3 Virtualization)", () => {
  it("maps local workspace paths to /workspace accurately", () => {
    const ws = "/volume1/docker/app";
    expect(toGuestWorkspacePath(ws, "/volume1/docker/app/src/main.py")).toBe(
      "/workspace/src/main.py",
    );
    expect(toGuestWorkspacePath(ws, "/volume1/docker/app")).toBe("/workspace");
  });

  it("throws when path escapes workspace jail", () => {
    const ws = "/volume1/docker/app";
    expect(() => toGuestWorkspacePath(ws, "/volume1/photos")).toThrow(
      "Path escapes Micro-VM workspace jail",
    );
    expect(() => toGuestWorkspacePath(ws, "/etc/shadow")).toThrow(
      "Path escapes Micro-VM workspace jail",
    );
  });

  it("initializes and executes commands via Micro-VM provider", async () => {
    const mockVm: IMicroVMInstance = {
      exec: vi.fn().mockResolvedValue({
        exitCode: 0,
        stdout: "Linux microvm 6.6.0-alpine #1 SMP x86_64\n",
        stderr: "",
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const runner = new GondolinMicroVMRunner({
      workspacePath: "/volume1/docker/test",
      allowedHosts: ["api.github.com"],
    });

    await runner.init(async () => mockVm);
    const res = await runner.exec("uname -a");

    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Linux microvm");
    expect(mockVm.exec).toHaveBeenCalledWith("uname -a");

    await runner.destroy();
    expect(mockVm.close).toHaveBeenCalled();
  });
});
