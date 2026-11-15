import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createImIntegration } from "./im.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("IM integration composition", () => {
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
});
