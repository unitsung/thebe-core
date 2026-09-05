import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_TAIL,
  REDACTED,
  TRUNCATION_MARKER,
  redactEnv,
  redactLogs,
} from "./redaction.ts";

describe("redactEnv", () => {
  it("redacts keys matching the spec patterns, case-insensitive", () => {
    const input = [
      "API_SECRET=s3cret",
      "auth_token=abc",
      "Service-Key=k",
      "DB_PASSWORD=p",
      "DB_PASS=p2",
      "APP_CREDENTIAL=c",
      "TLS_PRIVATE=x",
    ];
    expect(redactEnv(input)).toEqual([
      `API_SECRET=${REDACTED}`,
      `auth_token=${REDACTED}`,
      `Service-Key=${REDACTED}`,
      `DB_PASSWORD=${REDACTED}`,
      `DB_PASS=${REDACTED}`,
      `APP_CREDENTIAL=${REDACTED}`,
      `TLS_PRIVATE=${REDACTED}`,
    ]);
  });

  it("leaves ordinary env values unchanged", () => {
    expect(redactEnv(["NODE_ENV=production", "PORT=8080"])).toEqual([
      "NODE_ENV=production",
      "PORT=8080",
    ]);
  });

  it("leaves lines without KEY=VALUE as-is", () => {
    expect(redactEnv(["just-a-flag", "=emptykey"])).toEqual([
      "just-a-flag",
      "=emptykey",
    ]);
  });
});

describe("redactLogs", () => {
  it("replaces 40-char hex and sk- tokens inline", () => {
    const hex = "a".repeat(40);
    const log = `user=${hex} token=sk-live-abc123`;
    expect(redactLogs(log)).toBe(`user=${REDACTED} token=${REDACTED}`);
  });

  it("truncates to the last tail lines and marks the cut", () => {
    const lines = Array.from({ length: DEFAULT_LOG_TAIL + 5 }, (_, i) => `L${i}`);
    const out = redactLogs(lines.join("\n"));
    expect(out.startsWith(`${TRUNCATION_MARKER}\n`)).toBe(true);
    expect(out.split("\n")).toHaveLength(DEFAULT_LOG_TAIL + 1);
    expect(out.endsWith("L204")).toBe(true);
  });
});
