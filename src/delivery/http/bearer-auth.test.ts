import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThebeHttpHandler } from "./handler.ts";
import {
  createDeviceToken,
  createTokenVerifier,
  tokenFilePath,
} from "./token-store.ts";

const get = (headers: Record<string, string>) =>
  new Request("http://127.0.0.1:8787/v1/health", { headers });

async function handlerWithTokens() {
  const configDir = await mkdtemp(join(tmpdir(), "thebe-bearer-"));
  await writeFile(tokenFilePath(configDir), "shared-token\n");
  createDeviceToken({
    configDir,
    name: "Agent",
    generate: () => "d".repeat(64),
  });
  return createThebeHttpHandler({
    version: "t",
    token: createTokenVerifier({ configDir, env: {} }),
  });
}

describe("Authorization: Bearer", () => {
  it("is accepted for the shared token and a device token, whatever the case of the scheme", async () => {
    const handler = await handlerWithTokens();
    for (const header of [
      "Bearer shared-token",
      "bearer shared-token",
      `BEARER ${"d".repeat(64)}`,
    ]) {
      const res = await handler.handle(get({ Authorization: header }));
      expect(res.status, header).not.toBe(401);
    }
  });

  it("is refused when the token is wrong, empty, or not a Bearer scheme", async () => {
    const handler = await handlerWithTokens();
    for (const header of [
      "Bearer nope",
      "Bearer ",
      "Bearer",
      "Basic shared-token",
      "shared-token",
    ]) {
      const res = await handler.handle(get({ Authorization: header }));
      expect(res.status, header).toBe(401);
    }
  });

  it("yields to X-Thebe-Token when a request sends both", async () => {
    const handler = await handlerWithTokens();
    const wrongBearer = await handler.handle(
      get({ "X-Thebe-Token": "nope", Authorization: "Bearer shared-token" })
    );
    expect(wrongBearer.status).toBe(401);
    const rightHeader = await handler.handle(
      get({ "X-Thebe-Token": "shared-token", Authorization: "Bearer nope" })
    );
    expect(rightHeader.status).not.toBe(401);
  });
});
