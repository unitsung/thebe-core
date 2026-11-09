import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOAuthAdapter, listOAuthAdapterPayloads } from "./adapter.ts";

describe("persistent OAuth adapter", () => {
  it("persists provider artifacts across adapter instances", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-oauth-adapter-"));
    const Adapter = createOAuthAdapter(configDir);
    const first = new Adapter("AccessToken");
    await first.upsert("token", {
      jti: "token",
      kind: "AccessToken",
      clientId: "client",
      grantId: "grant",
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const second = new (createOAuthAdapter(configDir))("AccessToken");
    await expect(second.find("token")).resolves.toMatchObject({
      clientId: "client",
    });
    expect(listOAuthAdapterPayloads(configDir, "AccessToken")).toHaveLength(1);
  });

  it("consumes once and rejects replay", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-oauth-consume-"));
    const Adapter = createOAuthAdapter(configDir);
    const codes = new Adapter("AuthorizationCode");
    await codes.upsert("code", {
      jti: "code",
      kind: "AuthorizationCode",
      grantId: "grant",
    });
    await codes.consume("code");
    await expect(codes.consume("code")).rejects.toThrow(/already consumed/);
    await expect(codes.find("code")).resolves.toMatchObject({
      consumed: expect.any(Number),
    });
  });

  it("revokes every artifact in a grant", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-oauth-revoke-"));
    const Adapter = createOAuthAdapter(configDir);
    const access = new Adapter("AccessToken");
    const refresh = new Adapter("RefreshToken");
    const grant = new Adapter("Grant");
    await access.upsert("access", {
      jti: "access",
      kind: "AccessToken",
      grantId: "grant",
    });
    await refresh.upsert("refresh", {
      jti: "refresh",
      kind: "RefreshToken",
      grantId: "grant",
    });
    await grant.upsert("grant", {
      jti: "grant",
      kind: "Grant",
      grantId: "grant",
    });
    await access.revokeByGrantId("grant");
    expect(listOAuthAdapterPayloads(configDir, "AccessToken")).toEqual([]);
    expect(listOAuthAdapterPayloads(configDir, "RefreshToken")).toEqual([]);
    expect(listOAuthAdapterPayloads(configDir, "Grant")).toEqual([]);
  });

  it("refuses duplicate replay-detection entries", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-oauth-replay-"));
    const Adapter = createOAuthAdapter(configDir);
    const replay = new Adapter("ReplayDetection");
    await replay.upsert("nonce", {
      jti: "nonce",
      kind: "ReplayDetection",
    });
    await expect(
      replay.upsert("nonce", { jti: "nonce", kind: "ReplayDetection" })
    ).rejects.toThrow(/replay detected/);
  });
});
