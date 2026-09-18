import { describe, expect, it } from "vitest";
import { applyWriteRecommendationJudgment } from "./write-judgment.ts";
import { restartWriteRecommendation } from "./deterministic.ts";

const readRec = {
  id: "rec-review-logs",
  title: "Review logs",
  detail: "on-device",
  kind: "read" as const,
  requiresApproval: false,
};

describe("applyWriteRecommendationJudgment", () => {
  it("leaves traditional recommendations when Judgment was not used", () => {
    const recs = [readRec, restartWriteRecommendation()];
    expect(
      applyWriteRecommendationJudgment({
        code: "unknown_degraded",
        recommendations: recs,
        trace: {
          siteId: "diagnosis.write_recommendation",
          adapter: "jev",
          used: false,
          path: "traditional",
        },
      }),
    ).toEqual(recs);
  });

  it("adds a restart recommendation when Noul is high", () => {
    const next = applyWriteRecommendationJudgment({
      code: "unknown_degraded",
      recommendations: [readRec],
      trace: {
        siteId: "diagnosis.write_recommendation",
        adapter: "jev",
        used: true,
        path: "judgment",
        answers: { restart_supported: { type: "noul", noul: 0.88 } },
      },
    });
    expect(next.some((item) => item.id === "rec-restart")).toBe(true);
  });

  it("strips uncertain write recs when Noul is low", () => {
    const next = applyWriteRecommendationJudgment({
      code: "unknown_degraded",
      recommendations: [readRec, restartWriteRecommendation()],
      trace: {
        siteId: "diagnosis.write_recommendation",
        adapter: "jev",
        used: true,
        path: "judgment",
        answers: { restart_supported: { type: "noul", noul: 0.2 } },
      },
    });
    expect(next.some((item) => item.id === "rec-restart")).toBe(false);
  });

  it("does not veto a high-confidence deterministic restart", () => {
    const next = applyWriteRecommendationJudgment({
      code: "container_exited",
      recommendations: [readRec, restartWriteRecommendation()],
      trace: {
        siteId: "diagnosis.write_recommendation",
        adapter: "jev",
        used: true,
        path: "judgment",
        answers: { restart_supported: { type: "noul", noul: 0.1 } },
      },
    });
    expect(next.some((item) => item.id === "rec-restart")).toBe(true);
  });
});
