import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  configureNetworkAllowlist,
  resetNetworkAllowlist,
} from "./network-policy.ts";
import {
  OS_SANDBOX_DENY_READ,
  disposeOsSandbox,
  osSandboxPolicy,
  osSandboxUnavailableReason,
  setOsSandboxRuntime,
  wrapOsSandboxCommand,
  type OsSandboxRuntime,
} from "./os-sandbox.ts";

afterEach(async () => {
  await disposeOsSandbox();
  setOsSandboxRuntime(undefined);
  resetNetworkAllowlist();
});

describe("osSandboxPolicy", () => {
  it("writes only the workspace and temp dir, and blocks credential reads and the network", () => {
    const policy = osSandboxPolicy("workspace");
    expect(policy.filesystem.allowWrite).toEqual([
      resolve("workspace"),
      tmpdir(),
    ]);
    expect(policy.filesystem.denyRead).toEqual([...OS_SANDBOX_DENY_READ]);
    expect(policy.filesystem.denyWrite).toEqual([]);
    expect(policy.network.allowedDomains).toEqual([]);
    expect(policy.network.deniedDomains).toEqual([]);
  });
});

describe("wrapOsSandboxCommand", () => {
  function runtime(
    deps: { errors: string[]; warnings?: string[] } = { errors: [] }
  ) {
    const calls: {
      inits: SandboxRuntimeConfig[];
      asks: unknown[];
      wraps: Array<Partial<SandboxRuntimeConfig> | undefined>;
      resets: number;
    } = { inits: [], asks: [], wraps: [], resets: 0 };
    const fake: OsSandboxRuntime = {
      async initialize(config, ask) {
        calls.inits.push(config);
        calls.asks.push(ask);
      },
      async wrapWithSandbox(_command, _binShell, customConfig) {
        calls.wraps.push(customConfig);
        return `sandboxed:${_command}`;
      },
      updateConfig() {},
      async reset() {
        calls.resets += 1;
      },
      checkDependencies: () => ({
        errors: deps.errors,
        warnings: deps.warnings ?? [],
      }),
    };
    setOsSandboxRuntime(fake);
    return calls;
  }

  it("initializes once and passes the workspace write list on every wrap", async () => {
    const calls = runtime();
    await expect(wrapOsSandboxCommand("ls", "/work/a")).resolves.toBe(
      "sandboxed:ls"
    );
    await expect(wrapOsSandboxCommand("pwd", "/work/b")).resolves.toBe(
      "sandboxed:pwd"
    );
    expect(calls.inits).toHaveLength(1);
    expect(calls.wraps).toHaveLength(2);
    expect(calls.wraps[1]?.filesystem?.allowWrite).toEqual([
      resolve("/work/b"),
      tmpdir(),
    ]);
    expect(calls.wraps[1]?.network?.allowedDomains).toEqual([]);
  });

  it("refuses the command when dependencies are missing and does not wrap it", async () => {
    const calls = runtime({ errors: ["bubblewrap (bwrap) not found"] });
    await expect(wrapOsSandboxCommand("ls", "/work")).rejects.toThrow(
      /Command not run:.*will be refused/
    );
    expect(calls.inits).toHaveLength(0);
    expect(calls.wraps).toHaveLength(0);
    expect(
      osSandboxUnavailableReason({
        errors: ["bubblewrap (bwrap) not found"],
        warnings: [],
      })
    ).toContain("THEBE_SANDBOX=off");
  });

  it("can initialize again after reset", async () => {
    const calls = runtime();
    await wrapOsSandboxCommand("ls", "/work");
    await disposeOsSandbox();
    await wrapOsSandboxCommand("ls", "/work");
    expect(calls.inits).toHaveLength(2);
    expect(calls.resets).toBe(1);
  });

  it("passes the ask callback and the remembered hosts", async () => {
    const calls = runtime();
    configureNetworkAllowlist({
      allowedDomains: ["example.com"],
      deniedDomains: ["evil.test"],
    });
    await wrapOsSandboxCommand("curl", "/work");
    expect(calls.inits[0]?.network.allowedDomains).toEqual(["example.com"]);
    expect(calls.inits[0]?.network.deniedDomains).toEqual(["evil.test"]);
    expect(calls.asks).toHaveLength(1);
  });
});
