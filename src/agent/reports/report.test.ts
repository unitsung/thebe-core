import { describe, expect, it } from "vitest";
import { parseReportInput, reportFromText } from "./report.ts";

describe("parseReportInput", () => {
  it("accepts the six states, with nothing-to-do as an alias of dropped", () => {
    for (const state of ["progress", "ready", "blocked", "failed", "dropped"]) {
      expect(parseReportInput({ state, summary: "s" })).toEqual({
        state,
        summary: "s",
      });
    }
    expect(parseReportInput({ state: "nothing_to_do", summary: "s" })).toEqual({
      state: "dropped",
      summary: "s",
    });
    expect(
      parseReportInput({ state: "waiting", summary: "s", question: " Which? " })
    ).toEqual({
      state: "waiting",
      summary: "s",
      question: "Which?",
    });
  });

  it("says what is wrong so the model can correct itself", () => {
    expect(parseReportInput(null)).toMatch(/object/);
    expect(parseReportInput({ state: "done", summary: "s" })).toMatch(
      /state must be one of/
    );
    expect(parseReportInput({ state: "ready" })).toMatch(/summary is required/);
    expect(parseReportInput({ state: "waiting", summary: "s" })).toMatch(
      /needs one question/
    );
    expect(
      parseReportInput({ state: "ready", summary: "s", question: "Why?" })
    ).toMatch(/only for state waiting or blocked/);
  });
});

describe("reportFromText", () => {
  it("reads the older worker and reviewer footers in one place", () => {
    expect(
      reportFromText("worker", "GOAL_STATUS: continue\nCHECKPOINT: half way")
    ).toEqual({
      state: "progress",
      summary: "half way",
    });
    expect(reportFromText("worker", "GOAL_STATUS: blocked")?.state).toBe(
      "blocked"
    );
    expect(
      reportFromText("reviewer", "VERDICT: pass\nEVIDENCE: tests pass")
    ).toEqual({
      state: "ready",
      summary: "tests pass",
    });
    expect(
      reportFromText("reviewer", "VERDICT: fail\nEVIDENCE: one failure")?.state
    ).toBe("progress");
    expect(reportFromText("reviewer", "VERDICT: pass")?.state).toBe("progress");
    expect(reportFromText("worker", "Completed successfully.")).toBeUndefined();
  });
});
