import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveScenarioSettings } from "./scenario-profile.ts";
import {
  buildDockerArgs,
  buildSeatbeltProfile,
  isBwrapAvailable,
  isDockerAvailable,
  isSeatbeltAvailable,
  sandboxAvailability,
  wrapCommandForSandbox,
} from "./command-sandbox.ts";

function run(command: string): { status: number | null } {
  return { status: spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" }).status };
}

/**
 * The sandbox must actually execute and confine commands, not just build
 * argument lists. These run through the real backend on this host.
 */
describe.skipIf(process.platform !== "darwin")("seatbelt sandbox execution", () => {
  it("runs commands and confines writes to the workspace", () => {
    if (!isSeatbeltAvailable()) {
      expect(isSeatbeltAvailable()).toBe(false); // macOS without sandbox-exec
      return;
    }
    const parent = mkdtempSync(join(tmpdir(), "thebe-seatbelt-"));
    const workspace = join(parent, "workspace");
    spawnSync("mkdir", ["-p", workspace]);
    // Outside both the workspace and the sandbox's temp allowances.
    const outside = join(homedir(), `.thebe-sandbox-outside-${Date.now()}.txt`);
    rmSync(outside, { force: true });

    const wrapped = wrapCommandForSandbox(
      `echo inside > ${workspace}/inside.txt; echo outside > ${outside}`,
      { mode: "seatbelt", workspacePath: workspace, allowNetwork: false, probe: () => true },
    );
    expect(wrapped.applied).toBe(true);

    const sandboxed = run(wrapped.command);
    // The workspace write happened; the write outside the workspace did not.
    expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toContain("inside");
    expect(sandboxed.status).not.toBe(0);
    expect(() => readFileSync(outside, "utf8")).toThrow();

    // Control: the same command outside the sandbox writes there happily.
    expect(run(`echo outside > ${outside}`).status).toBe(0);
    expect(readFileSync(outside, "utf8")).toContain("outside");
    rmSync(outside, { force: true });
  }, 30_000);

  it("denies network access unless the sandbox allows it", () => {
    if (!isSeatbeltAvailable()) return;
    const workspace = mkdtempSync(join(tmpdir(), "thebe-seatbelt-net-"));
    const denied = wrapCommandForSandbox("nc -z -G 1 1.1.1.1 53", {
      mode: "seatbelt",
      workspacePath: workspace,
      allowNetwork: false,
      probe: () => true,
    });
    const allowed = wrapCommandForSandbox("nc -z -G 1 1.1.1.1 53", {
      mode: "seatbelt",
      workspacePath: workspace,
      allowNetwork: true,
      probe: () => true,
    });
    expect(denied.command).toContain("(deny default)");
    expect(denied.command).not.toContain("(allow network*)");
    expect(allowed.command).toContain("(allow network*)");
    // Denied network means the connection attempt fails.
    expect(run(denied.command).status).not.toBe(0);
  }, 30_000);
});

describe("docker sandbox arguments", () => {
  it("runs unprivileged, read-only containers with only the workspace mounted", () => {
    const args = buildDockerArgs("npm test", {
      mode: "docker",
      workspacePath: "/volume1/docker/app",
      allowNetwork: false,
      image: "node:24-alpine",
    });
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).toContain("--security-opt");
    expect(args).toContain("/volume1/docker/app:/volume1/docker/app:rw");
    expect(args.slice(-3)).toEqual(["/bin/sh", "-lc", "npm test"]);
    expect(args).toContain("node:24-alpine");
  });

  it("keeps the network only when asked", () => {
    const args = buildDockerArgs("true", {
      mode: "docker",
      workspacePath: "/srv/app",
      allowNetwork: true,
    });
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
    expect(args).toContain("alpine:3");
  });
});

describe("sandbox probes and warnings", () => {
  it("reports which backends this host can run", () => {
    expect(
      sandboxAvailability({
        bwrap: () => true,
        docker: () => false,
        seatbelt: () => true,
        gondolin: () => false,
      }),
    ).toEqual({ off: true, bwrap: true, docker: false, seatbelt: true, gondolin: false });
  });

  it("explains why a backend is unusable", () => {
    expect(
      wrapCommandForSandbox("ls", {
        mode: "docker",
        workspacePath: "/srv/app",
        probe: () => false,
      }).warning,
    ).toContain("no Docker daemon");
    expect(
      wrapCommandForSandbox("ls", { mode: "gondolin", workspacePath: "/srv/app" }).warning,
    ).toContain("Micro-VM");
  });

  it("accepts every THEBE_SANDBOX value", () => {
    for (const mode of ["off", "bwrap", "docker", "seatbelt", "gondolin"] as const) {
      expect(resolveScenarioSettings(undefined, { THEBE_SANDBOX: mode }).sandboxMode).toBe(mode);
    }
    expect(resolveScenarioSettings(undefined, { THEBE_SANDBOX: "nonsense" }).sandboxMode).toBe("off");
  });
});

describe("seatbelt profile", () => {
  it("confines writes and blocks the network by default", () => {
    const profile = buildSeatbeltProfile({
      mode: "seatbelt",
      workspacePath: "/Users/dev/app",
      allowNetwork: false,
    });
    expect(profile).toContain("(deny default)");
    expect(profile).toContain('(subpath "/Users/dev/app")');
    expect(profile).toContain("(allow file-write*");
    expect(profile).not.toContain("(allow network*)");
    expect(
      buildSeatbeltProfile({
        mode: "seatbelt",
        workspacePath: "/Users/dev/app",
        allowNetwork: true,
      }),
    ).toContain("(allow network*)");
  });
});

/**
 * bwrap must actually confine a running process, not just build an argument
 * list. The workspace sits under `$HOME` because the backend mounts a tmpfs at
 * `/tmp`, which would mask a workspace created there.
 *
 * Opt-in: `THEBE_SANDBOX_IT=1 npx vitest run src/agent/security`. It needs bwrap
 * plus unprivileged user namespaces, which CI runners usually restrict, so it
 * does not run by default (skipped on macOS too, where bwrap does not exist).
 */
describe.skipIf(
  process.env.THEBE_SANDBOX_IT !== "1" ||
    process.platform === "darwin" ||
    !isBwrapAvailable(),
)(
  "bwrap sandbox execution",
  () => {
    it("confines writes to the workspace and denies the network", () => {
      const parent = mkdtempSync(join(homedir(), "thebe-bwrap-"));
      const workspace = join(parent, "workspace");
      mkdirSync(workspace);
      const outside = join(parent, "outside.txt");

      const wrapped = wrapCommandForSandbox(
        `echo inside > ${workspace}/inside.txt; echo outside > ${outside}`,
        { mode: "bwrap", workspacePath: workspace, allowNetwork: false, probe: () => true },
      );
      expect(wrapped.applied).toBe(true);

      const status = run(wrapped.command);
      expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toContain("inside");
      expect(status).not.toBe(0);
      expect(() => readFileSync(outside, "utf8")).toThrow();

      const net = wrapCommandForSandbox("curl -s -m 2 -o /dev/null http://1.1.1.1", {
        mode: "bwrap",
        workspacePath: workspace,
        allowNetwork: false,
        probe: () => true,
      });
      expect(run(net.command)).not.toBe(0);

      rmSync(parent, { recursive: true, force: true });
    }, 30_000);
  },
);

/**
 * The docker backend runs a disposable, unprivileged container. Verified on
 * Linux (Docker Desktop on macOS shares `$HOME` over virtiofs, which shadows a
 * same-path bind mount, so the run is skipped there).
 *
 * Opt-in: `THEBE_SANDBOX_IT=1 npx vitest run src/agent/security`. It pulls a
 * base image, which is fragile on shared CI runners (Docker Hub rate limits).
 */
describe.skipIf(
  process.env.THEBE_SANDBOX_IT !== "1" ||
    process.platform === "darwin" ||
    !isDockerAvailable(),
)(
  "docker sandbox execution",
  () => {
    it("confines writes to the workspace and denies the network", () => {
      const parent = mkdtempSync(join(homedir(), "thebe-docker-"));
      const workspace = join(parent, "workspace");
      mkdirSync(workspace);
      const outside = join(parent, "outside.txt");

      const wrapped = wrapCommandForSandbox(
        `echo inside > ${workspace}/inside.txt; echo outside > ${outside}`,
        { mode: "docker", workspacePath: workspace, allowNetwork: false, probe: () => true },
      );
      expect(wrapped.applied).toBe(true);

      const status = run(wrapped.command);
      expect(readFileSync(join(workspace, "inside.txt"), "utf8")).toContain("inside");
      expect(status).not.toBe(0);
      expect(() => readFileSync(outside, "utf8")).toThrow();

      rmSync(parent, { recursive: true, force: true });
    }, 120_000);
  },
);
