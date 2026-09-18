import { describe, expect, it } from "vitest";
import { createJudgmentApi } from "./service.ts";

const model = {
  adapterId: "jev" as const,
  judge: async () => ({
    adapter: "jev" as const,
    model: "jev-test",
    answers: { urgent: { type: "noul" as const, noul: 0.8 } },
  }),
};

describe("JudgmentApi", () => {
  it("skips when no model is configured", async () => {
    const judgment = createJudgmentApi({});
    expect(judgment.enabled("home.attention")).toBe(false);
    await expect(judgment.ask("home.attention", { kind: "disk" })).resolves.toEqual({
      siteId: "home.attention",
      used: false,
      path: "traditional",
    });
  });

  it("skips a Site that is not enabled even when the model is on", async () => {
    const judgment = createJudgmentApi({
      model,
      sites: ["intent.capability"],
    });
    expect(judgment.enabled("home.attention")).toBe(false);
    expect(judgment.enabled("intent.capability")).toBe(true);
    await expect(judgment.ask("home.attention", {})).resolves.toEqual({
      siteId: "home.attention",
      used: false,
      path: "traditional",
    });
  });

  it("asks any catalog Site when sites are all", async () => {
    const judgment = createJudgmentApi({ model, sites: "all" });
    const result = await judgment.ask("home.attention", { kind: "disk" });
    expect(result).toEqual({
      siteId: "home.attention",
      used: true,
      path: "judgment",
      adapter: "jev",
      answers: { urgent: { type: "noul", noul: 0.8 } },
    });
  });
});
