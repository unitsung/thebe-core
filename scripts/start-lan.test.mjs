import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverLanIPv4s,
  parseEnvLocal,
  persistToken,
  resolveLanConfig,
} from "./start-lan.mjs";

describe("start:lan helpers", () => {
  it("finds unique external IPv4 addresses", () => {
    expect(
      discoverLanIPv4s({
        en0: [
          { address: "192.168.5.10", family: "IPv4", internal: false },
          { address: "192.168.5.10", family: "IPv4", internal: false },
        ],
        lo0: [{ address: "127.0.0.1", family: 4, internal: true }],
        en1: [{ address: "fe80::1", family: "IPv6", internal: false }],
      }),
    ).toEqual(["192.168.5.10"]);
  });

  it("parses simple .env.local values and strips matching quotes", () => {
    expect(parseEnvLocal("# comment\nTHEBE_TOKEN='secret'\nTHEBE_PORT=9000")).toEqual({
      THEBE_TOKEN: "secret",
      THEBE_PORT: "9000",
    });
  });

  it("defaults to a LAN bind and derives the host allowlist", () => {
    expect(
      resolveLanConfig({
        env: {},
        localEnv: {},
        addresses: ["192.168.5.10"],
        tokenFactory: () => "thebe-test",
      }),
    ).toEqual({
      advertisedHost: "192.168.5.10",
      host: "0.0.0.0",
      port: "8787",
      allowedHosts: "192.168.5.10",
      token: "thebe-test",
      generatedToken: true,
    });
  });

  it("keeps explicit settings and prefers process environment", () => {
    expect(
      resolveLanConfig({
        env: {
          THEBE_LAN_IP: "100.64.0.2",
          THEBE_ALLOWED_HOSTS: "100.64.0.2,thebe.local",
          THEBE_TOKEN: "from-process",
        },
        localEnv: {
          THEBE_LAN_IP: "192.168.5.10",
          THEBE_TOKEN: "from-file",
        },
        addresses: ["192.168.5.10"],
        tokenFactory: () => "unused",
      }),
    ).toMatchObject({
      advertisedHost: "100.64.0.2",
      allowedHosts: "100.64.0.2,thebe.local",
      token: "from-process",
      generatedToken: false,
    });
  });

  it("includes an explicitly advertised address in the default allowlist", () => {
    expect(
      resolveLanConfig({
        env: { THEBE_LAN_IP: "100.64.0.2" },
        localEnv: {},
        addresses: ["192.168.5.10"],
        tokenFactory: () => "thebe-test",
      }).allowedHosts,
    ).toBe("192.168.5.10,100.64.0.2");
  });

  it("persists a generated token without duplicating the env entry", () => {
    const directory = mkdtempSync(join(tmpdir(), "thebe-start-lan-"));
    const path = join(directory, ".env.local");
    try {
      writeFileSync(path, "ARCANE_BASE_URL=http://127.0.0.1:3552\nTHEBE_TOKEN=\n");
      expect(persistToken("thebe-first", path)).toBe(true);
      expect(persistToken("thebe-second", path)).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text).toContain("ARCANE_BASE_URL=http://127.0.0.1:3552");
      expect(text).toContain("THEBE_TOKEN=thebe-second");
      expect(text.match(/THEBE_TOKEN=/g)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
