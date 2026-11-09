import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizePairingCode,
  oauthPairingPath,
  PairingCodeStore,
} from "./pairing.ts";

describe("OAuth pairing codes", () => {
  it("issues a formatted code, keeps only its hash, and consumes it once", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-pairing-"));
    let at = Date.parse("2026-11-09T10:00:00Z");
    const store = new PairingCodeStore(configDir, {
      ttlSeconds: 300,
      now: () => at,
      generate: () => "abcde23456",
    });
    const issued = store.issue();
    expect(issued).toEqual({
      code: "ABCDE-23456",
      expiresAt: "2026-11-09T10:05:00.000Z",
    });
    const text = await readFile(oauthPairingPath(configDir), "utf8");
    expect(text).not.toContain("ABCDE23456");
    expect((await stat(oauthPairingPath(configDir))).mode & 0o777).toBe(0o600);
    expect(store.consume("abcde 23456")).toBe(true);
    expect(store.consume("ABCDE-23456")).toBe(false);
    at += 1;
  });

  it("expires short-lived codes", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-pairing-expire-"));
    let at = Date.parse("2026-11-09T10:00:00Z");
    const store = new PairingCodeStore(configDir, {
      ttlSeconds: 60,
      now: () => at,
      generate: () => "QRSTU34567",
    });
    store.issue();
    at += 61_000;
    expect(store.consume("QRSTU-34567")).toBe(false);
  });

  it("normalizes the code people type without accepting short guesses", () => {
    expect(normalizePairingCode(" abcd-efgh 2345 ")).toBe("ABCDEFGH2345");
    const store = new PairingCodeStore("/tmp/unused-pairing", {
      ttlSeconds: 300,
    });
    expect(store.consume("short")).toBe(false);
  });
});
