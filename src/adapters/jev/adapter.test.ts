import { describe, expect, it } from "vitest";
import { createJevAdapter } from "./adapter.ts";

describe("JevAdapter", () => {
  it("posts state and typed questions and returns Noul", async () => {
    const seen: { url: string; body: unknown; auth: string | null }[] = [];
    const adapter = createJevAdapter({
      apiKey: "ts-key",
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { restart_supported: { type: "noul", noul: 0.91 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await adapter.judge({
      siteId: "diagnosis.write_recommendation",
      state: { code: "container_exited" },
      questions: {
        restart_supported: {
          type: "noul",
          instructions: "Support restart?",
        },
      },
    });
    expect(adapter.adapterId).toBe("jev");
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers.restart_supported).toEqual({ type: "noul", noul: 0.91 });
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0]?.auth).toBe("Bearer ts-key");
    expect(seen[0]?.body).toEqual(
      expect.objectContaining({
        model: "jev-latest",
        state: { code: "container_exited" },
      }),
    );
  });

  it("fails closed on HTTP errors", async () => {
    const adapter = createJevAdapter({
      apiKey: "ts-key",
      fetch: async () => new Response("nope", { status: 401 }),
    });
    await expect(
      adapter.judge({
        siteId: "diagnosis.write_recommendation",
        state: {},
        questions: { restart_supported: { type: "noul", instructions: "x" } },
      }),
    ).rejects.toThrow(/Jev HTTP 401/);
  });
});
