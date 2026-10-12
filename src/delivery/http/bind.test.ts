import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEBE_HOST,
  productionTokenError,
  resolveAllowedHosts,
  resolveThebeListen,
  resolveThebeToken,
} from "./bind.ts";

describe("resolveThebeListen", () => {
  it("defaults to loopback and no token", () => {
    const config = resolveThebeListen({});
    expect(config.host).toBe(DEFAULT_THEBE_HOST);
    expect(config.port).toBe(8787);
    expect(config.token).toBeUndefined();
    expect(config.allowedHosts).toEqual(
      expect.arrayContaining(["127.0.0.1", "localhost", "::1"]),
    );
  });

  it("keeps a Host allowlist on wildcard binds so DNS-rebinding cannot skip it", () => {
    const config = resolveThebeListen({ THEBE_HOST: "0.0.0.0" });
    expect(config.host).toBe("0.0.0.0");
    expect(config.allowedHosts).toEqual(
      expect.arrayContaining(["127.0.0.1", "localhost", "::1"]),
    );
    expect(config.allowedHosts).not.toContain("evil.com");
  });

  it("merges THEBE_ALLOWED_HOSTS onto the loopback set", () => {
    const config = resolveThebeListen({
      THEBE_HOST: "0.0.0.0",
      THEBE_ALLOWED_HOSTS: "thebe.local, 192.168.1.5",
    });
    expect(config.allowedHosts).toEqual(
      expect.arrayContaining(["127.0.0.1", "thebe.local", "192.168.1.5"]),
    );
  });
});

describe("resolveAllowedHosts", () => {
  it("includes a specific bind host", () => {
    expect(resolveAllowedHosts("10.0.0.2")).toEqual(
      expect.arrayContaining(["10.0.0.2", "127.0.0.1"]),
    );
  });

  it("passes through the wildcard entry", () => {
    expect(resolveAllowedHosts("0.0.0.0", ["*"])).toContain("*");
  });
});

describe("productionTokenError", () => {
  it("only fails when NODE_ENV is production and token is missing", () => {
    expect(productionTokenError(undefined, "development")).toBeUndefined();
    expect(productionTokenError("secret", "production")).toBeUndefined();
    expect(productionTokenError("  ", "production")).toMatch(/THEBE_TOKEN/);
    expect(productionTokenError(undefined, "production")).toMatch(/THEBE_TOKEN/);
  });
});

describe("resolveThebeToken", () => {
  it("prefers an explicit THEBE_TOKEN and generates nothing", () => {
    const result = resolveThebeToken({ env: { THEBE_TOKEN: "explicit" } });
    expect(result).toEqual({ token: "explicit", generated: false });
  });

  it("generates, persists with 0600, and reuses the token", () => {
    const dir = mkdtempSync(join(tmpdir(), "thebe-token-"));
    const first = resolveThebeToken({
      env: {},
      configDir: dir,
      generate: () => "generated-1",
    });
    expect(first).toMatchObject({ token: "generated-1", generated: true });

    const path = join(dir, "token");
    expect(readFileSync(path, "utf8").trim()).toBe("generated-1");
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const second = resolveThebeToken({
      env: {},
      configDir: dir,
      generate: () => "generated-2",
    });
    expect(second).toMatchObject({ token: "generated-1", generated: false });
  });

  it("generates in memory when there is no config dir", () => {
    const result = resolveThebeToken({ env: {}, generate: () => "memory" });
    expect(result).toEqual({ token: "memory", generated: true });
  });
});
