import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createImIntegration } from "./im.ts";
import type { ImAdapter, ImAdapterFactory } from "../agent/im/types.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

function idleAdapter(platform: string): ImAdapter {
  return {
    platform,
    capabilities: {
      proactive: false,
      replyOnly: true,
      recall: false,
      media: false,
      maxTextLength: 1_000,
    },
    start: async () => {},
    stop: async () => {},
    health: async () => ({ state: "connected" }),
    send: async () => ({ status: "sent" }),
    onInbound: () => {},
  };
}

describe("IM integration composition", () => {
  it("registers Weixin as a QR-login platform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-im-wechat-"));
    dirs.push(dir);
    const gateway = createImIntegration({
      agent: { askMainSession: async () => ({ text: "" }) },
      dir,
      env: {},
      onError: () => {},
    });
    await gateway.start();
    expect(gateway.platforms()).toEqual(
      expect.arrayContaining([
        {
          platform: "wechat",
          credentials: [],
          login: true,
        },
        {
          platform: "qq",
          credentials: [
            { key: "appId", label: "AppID" },
            { key: "clientSecret", label: "AppSecret", secret: true },
          ],
          login: false,
        },
        {
          platform: "imessage",
          credentials: [
            {
              key: "backend",
              label: "Backend (imsg or bluebubbles)",
              required: false,
            },
            {
              key: "cliPath",
              label: "Local imsg executable (default imsg)",
              required: false,
            },
            {
              key: "dbPath",
              label: "Messages database (optional)",
              required: false,
            },
            {
              key: "baseUrl",
              label: "BlueBubbles server URL (bluebubbles backend)",
              required: false,
            },
            {
              key: "password",
              label: "Server password (bluebubbles backend)",
              secret: true,
              required: false,
            },
          ],
          login: false,
        },
      ])
    );
    await gateway.stop();
  });

  it("seeds QQ and iMessage accounts from the environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-im-seeds-"));
    dirs.push(dir);
    const factory = (platform: string): ImAdapterFactory => ({
      platform,
      credentials: [],
      create: () => idleAdapter(platform),
    });
    const gateway = createImIntegration({
      agent: { askMainSession: async () => ({ text: "" }) },
      dir,
      env: {
        THEBE_QQ_APP_ID: "102030",
        THEBE_QQ_APP_SECRET: "qq-secret",
        THEBE_BLUEBUBBLES_URL: "https://bluebubbles.test",
        THEBE_BLUEBUBBLES_PASSWORD: "blue-secret",
      },
      factories: [factory("qq"), factory("imessage")],
      onError: () => {},
    });
    await gateway.start();
    const channels = await gateway.channels();
    expect(channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "qq-env",
          platform: "qq",
          source: "environment",
        }),
        expect.objectContaining({
          id: "imessage-env",
          platform: "imessage",
          source: "environment",
        }),
      ])
    );
    await gateway.stop();
  });

  it("turns THEBE_TELEGRAM_BOT_TOKEN into an environment-owned channel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-im-app-"));
    dirs.push(dir);
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL) => {
      calls.push(String(input));
      return new Promise<Response>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("stop")), 1_000);
        timer.unref?.();
      });
    }) as unknown as typeof fetch;
    const gateway = createImIntegration({
      agent: { askMainSession: async () => ({ text: "" }) },
      dir,
      env: {
        THEBE_TELEGRAM_BOT_TOKEN: "test-token",
        THEBE_TELEGRAM_API_BASE: "https://telegram.test",
      },
      fetch: fetchFn,
      onError: () => {},
    });
    await gateway.start();
    const channels = await gateway.channels();
    expect(channels).toEqual([
      expect.objectContaining({
        id: "telegram-env",
        platform: "telegram",
        source: "environment",
        health: expect.objectContaining({ state: expect.any(String) }),
      }),
    ]);
    await gateway.removeChannel("telegram-env").catch((error) => {
      expect(error).toMatchObject({ code: "environment_channel" });
    });
    expect(calls[0]).toContain(
      "https://telegram.test/bottest-token/getUpdates"
    );
    await gateway.stop();
  });

  it("seeds the local imsg backend from the environment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-im-imsg-"));
    dirs.push(dir);
    const factory = (platform: string): ImAdapterFactory => ({
      platform,
      credentials: [],
      create: () => idleAdapter(platform),
    });
    const gateway = createImIntegration({
      agent: { askMainSession: async () => ({ text: "" }) },
      dir,
      env: {
        THEBE_IMESSAGE_BACKEND: "imsg",
        THEBE_IMSG_PATH: "/opt/homebrew/bin/imsg",
        THEBE_IMSG_DB_PATH: "/tmp/chat.db",
      },
      factories: [factory("imessage")],
      onError: () => {},
    });
    await gateway.start();
    expect(await gateway.channels()).toEqual([
      expect.objectContaining({
        id: "imessage-imsg-env",
        platform: "imessage",
        source: "environment",
      }),
    ]);
    await gateway.stop();
  });
});
