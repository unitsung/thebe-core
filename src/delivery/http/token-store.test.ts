import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTokenCommand } from "../cli/token.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { fileTokenSource, revokeToken, rotateToken, tokenFilePath, tokenStatus } from "./token-store.ts";

async function dir() {
  return mkdtemp(join(tmpdir(), "thebe-token-"));
}
const request = (token?: string) =>
  new Request("http://127.0.0.1:8787/v1/health", { headers: token ? { "X-Thebe-Token": token } : {} });

describe("rotating and revoking the token", () => {
  it("rotate writes a new private token and the running server follows it at once", async () => {
    const configDir = await dir();
    await writeFile(tokenFilePath(configDir), "old-token\n", { mode: 0o600 });
    const handler = createThebeHttpHandler({ version: "t", token: fileTokenSource(tokenFilePath(configDir)) });
    expect((await handler.handle(request("old-token"))).status).not.toBe(401);

    const result = rotateToken({ configDir, env: {}, generate: () => "fresh-token" });
    expect(result).toMatchObject({ ok: true, token: "fresh-token" });
    expect((await stat(tokenFilePath(configDir))).mode & 0o777).toBe(0o600);
    expect((await handler.handle(request("old-token"))).status).toBe(401);
    expect((await handler.handle(request("fresh-token"))).status).not.toBe(401);
  });

  it("revoke closes access for every client and reveals nothing", async () => {
    const configDir = await dir();
    await writeFile(tokenFilePath(configDir), "old-token\n");
    const handler = createThebeHttpHandler({ version: "t", token: fileTokenSource(tokenFilePath(configDir)) });
    const result = revokeToken({ configDir, env: {}, generate: () => "nobody-sees-this" });
    expect(result).toMatchObject({ ok: true, token: "" });
    expect((await handler.handle(request("old-token"))).status).toBe(401);
    expect((await handler.handle(request("nobody-sees-this"))).status).not.toBe(401);
  });

  it("a missing or empty token file refuses everything instead of opening up", async () => {
    const configDir = await dir();
    const handler = createThebeHttpHandler({ version: "t", token: fileTokenSource(tokenFilePath(configDir)) });
    expect((await handler.handle(request())).status).toBe(401);
    await writeFile(tokenFilePath(configDir), "\n");
    expect((await handler.handle(request(""))).status).toBe(401);
  });

  it("a token from THEBE_TOKEN belongs to the environment and is left alone", async () => {
    const configDir = await dir();
    const env = { THEBE_TOKEN: "env-token" };
    expect(rotateToken({ configDir, env })).toEqual({ ok: false, reason: "managed-by-env" });
    expect(revokeToken({ configDir, env })).toEqual({ ok: false, reason: "managed-by-env" });
    expect(tokenStatus({ configDir, env }).managedBy).toBe("env");
  });

  it("a fixed string token still works as before", async () => {
    const handler = createThebeHttpHandler({ version: "t", token: "fixed" });
    expect((await handler.handle(request("fixed"))).status).not.toBe(401);
    expect((await handler.handle(request("other"))).status).toBe(401);
  });
});

describe("thebe token", () => {
  const run = async (args: string[], configDir: string, env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runTokenCommand(args, configDir, { log: (l) => out.push(l), error: (l) => err.push(l), env });
    return { code, out, err };
  };

  it("status, show, rotate and revoke", async () => {
    const configDir = await dir();
    expect((await run(["status"], configDir)).out[0]).toContain("none yet");
    expect((await run(["show"], configDir)).code).toBe(1);
    const rotated = await run(["rotate"], configDir);
    expect(rotated.code).toBe(0);
    const token = rotated.out[0]!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await run(["show"], configDir)).out[0]).toBe(token);
    expect((await run(["status"], configDir)).out[0]).toContain("changed");
    const revoked = await run(["revoke"], configDir);
    expect(revoked.code).toBe(0);
    expect(revoked.out).toEqual([]);
    expect((await run(["show"], configDir)).out[0]).not.toBe(token);
    expect((await readFile(tokenFilePath(configDir), "utf8")).trim()).not.toBe(token);
  });

  it("refuses to change a token that the environment owns, and an unknown command", async () => {
    const configDir = await dir();
    expect((await run(["rotate"], configDir, { THEBE_TOKEN: "x" })).code).toBe(1);
    expect((await run(["frobnicate"], configDir)).code).toBe(2);
  });
});
