import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNotificationChannelConfigStore } from "./channel-config.ts";
import { createNotificationChannelConfigService } from "./channel-config-service.ts";
import type { NotificationAdapter } from "./types.ts";

function adapter(id: string): NotificationAdapter {
  return {
    id,
    accepts: () => true,
    send: async () => ({ status: "sent" }),
  };
}

describe("notification channel config service", () => {
  it("rebuilds adapters when the owner writes the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-config-service-"));
    try {
      let built: string[] = [];
      const service = createNotificationChannelConfigService({
        dir,
        buildAdapters: (config) => [
          adapter("webhook"),
          ...(config.telegram?.botToken ? [adapter("telegram")] : []),
        ],
        onChange: (adapters) => {
          built = adapters.map((entry) => entry.id);
        },
        watch: true,
      });
      await service.start();
      try {
        await createNotificationChannelConfigStore({ dir }).set({
          telegram: { botToken: "watch-me" },
        });
        await waitFor(() => built.includes("telegram"));
        expect(built).toContain("telegram");
      } finally {
        service.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for the config watcher");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
