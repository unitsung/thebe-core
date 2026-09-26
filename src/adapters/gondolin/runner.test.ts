import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GondolinMicroVMRunner,
  toGuestWorkspacePath,
  type IMicroVMInstance,
} from "./runner.ts";

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
    expect(mockVm.exec).toHaveBeenCalledWith("uname -a", { cwd: "/workspace" });

    await runner.destroy();
    expect(mockVm.close).toHaveBeenCalled();
  });
});

/**
 * Real micro-VM boot: downloads the guest image on first run (~200MB, cached in
 * `~/.cache/gondolin`) and needs a VM backend (bundled krun runner or QEMU), so
 * it is opt-in: `THEBE_GONDOLIN_IT=1 pnpm vitest run src/adapters/gondolin`.
 */
const gondolinIt = process.env.THEBE_GONDOLIN_IT === "1" ? it : it.skip;

describe("Gondolin micro-VM (real backend)", () => {
  gondolinIt(
    "boots a VM, runs a command against the mounted workspace, and shuts down",
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), "thebe-gondolin-"));
      writeFileSync(join(workspace, "hello.txt"), "from the host\n", "utf8");
      const runner = new GondolinMicroVMRunner({
        workspacePath: workspace,
        allowedHosts: [],
        timeoutMs: 180_000,
      });

      try {
        await runner.init();
        const result = await runner.exec(
          "uname -s; pwd; cat /workspace/hello.txt; echo guest > /workspace/out.txt",
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Linux");
        expect(result.stdout).toContain("/workspace");
        expect(result.stdout).toContain("from the host");
        // Writes under /workspace land on the host filesystem.
        expect(readFileSync(join(workspace, "out.txt"), "utf8")).toContain("guest");
        // The guest is its own machine: the host root is not visible.
        const host = await runner.exec("ls /Users 2>&1 || true");
        expect(host.stdout).not.toContain("Shared");
      } finally {
        await runner.destroy();
      }
    },
    600_000,
  );
});
