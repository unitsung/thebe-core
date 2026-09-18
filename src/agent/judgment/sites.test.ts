import { describe, expect, it } from "vitest";
import { JUDGMENT_SITES, siteEnabled } from "./sites.ts";

describe("Judgment Sites", () => {
  it("catalogs reusable Sites and never includes PolicyEngine", () => {
    expect(JUDGMENT_SITES.map((site) => site.id)).toEqual([
      "diagnosis.write_recommendation",
      "diagnosis.severity",
      "intent.capability",
      "home.attention",
      "agent.tool_result_sufficient",
      "activity.notify",
    ]);
    expect(JUDGMENT_SITES.some((site) => site.id.includes("policy"))).toBe(false);
    expect(siteEnabled("home.attention", "all")).toBe(true);
    expect(siteEnabled("home.attention", ["intent.capability"])).toBe(false);
  });
});
