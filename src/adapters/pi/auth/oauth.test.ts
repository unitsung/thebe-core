import { describe, expect, it, vi } from "vitest";
import { createPiRuntimeAuth } from "./oauth.ts";

describe("Pi runtime OAuth", () => {
  it("selects browser before accepting the pasted callback", async () => {
    let receivedCallback = "";
    const modelRuntime = {
      login: vi.fn(
        async (
          _providerId: string,
          _method: "oauth" | "apiKey",
          interaction: {
            prompt: (request?: {
              type: string;
              options?: readonly { id: string }[];
            }) => Promise<string>;
            notify: (event: { type: string; url?: string }) => void;
          }
        ) => {
          expect(
            await interaction.prompt({
              type: "select",
              options: [{ id: "browser" }, { id: "device_code" }],
            })
          ).toBe("browser");
          interaction.notify({
            type: "auth_url",
            url: "https://example.com/oauth/openai",
          });
          receivedCallback = await interaction.prompt();
          return {};
        }
      ),
      setRuntimeApiKey: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}),
      checkAuth: vi.fn(async () => false),
      logout: vi.fn(async () => {}),
      getProviders: vi.fn(() => []),
    };
    const auth = createPiRuntimeAuth(modelRuntime);

    const pending = await auth.authorizeOAuth("openai");
    expect(pending).toMatchObject({
      pending: true,
      url: "https://example.com/oauth/openai",
    });

    await auth.submitOAuthCallback("openai", "pasted-from-app");

    expect(receivedCallback).toBe("pasted-from-app");
    expect(modelRuntime.login).toHaveBeenCalledOnce();
  });
});
