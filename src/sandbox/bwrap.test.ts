import { describe, expect, it } from "vitest";
import { buildBwrapArgs, buildBwrapCommandString } from "./bwrap.ts";

describe("Bubblewrap (bwrap) Sandbox Argument Builder", () => {
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
