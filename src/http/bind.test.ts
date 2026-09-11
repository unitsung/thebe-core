import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEBE_HOST,
  productionTokenError,
  resolveAllowedHosts,
  resolveThebeListen,
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
});

describe("productionTokenError", () => {
  it("only fails when NODE_ENV is production and token is missing", () => {
    expect(productionTokenError(undefined, "development")).toBeUndefined();
    expect(productionTokenError("secret", "production")).toBeUndefined();
    expect(productionTokenError("  ", "production")).toMatch(/THEBE_TOKEN/);
    expect(productionTokenError(undefined, "production")).toMatch(/THEBE_TOKEN/);
  });
});
