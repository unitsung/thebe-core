import { afterEach, describe, expect, it } from "vitest";
import {
  decideUnmatchedHost,
  normalizeNetworkHost,
  rememberNetworkHost,
  resetNetworkAllowlist,
  trackSandboxedCommand,
  networkAllowedDomains,
  networkDeniedDomains,
} from "./network-policy.ts";

afterEach(() => {
  resetNetworkAllowlist();
});

describe("network allowlist", () => {
  it("asks only the single running command and remembers a host", async () => {
    const stop = trackSandboxedCommand(async () => true);
    await expect(
      decideUnmatchedHost({ host: "Example.COM", port: 443 })
    ).resolves.toBe(true);
    stop();

    const first = trackSandboxedCommand(async () => true);
    const second = trackSandboxedCommand(async () => true);
    await expect(
      decideUnmatchedHost({ host: "example.com", port: 443 })
    ).resolves.toEqual({
      allow: false,
      reason: expect.stringContaining("more than one"),
    });
    first();
    second();

    const saved: string[] = [];
    const { configureNetworkAllowlist } = await import("./network-policy.ts");
    configureNetworkAllowlist({
      persist: (patch) => {
        saved.push(...patch.sandboxAllowedDomains);
      },
    });
    await rememberNetworkHost("example.com", "allow");
    expect(networkAllowedDomains()).toEqual(["example.com"]);
    expect(saved).toEqual(["example.com"]);
    await rememberNetworkHost("evil.test", "deny");
    expect(networkDeniedDomains()).toEqual(["evil.test"]);
    expect(normalizeNetworkHost("*")).toBeUndefined();
    expect(normalizeNetworkHost("not a host")).toBeUndefined();
  });
});
