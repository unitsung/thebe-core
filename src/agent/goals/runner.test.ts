import { describe, expect, it } from "vitest";
import {
  buildGoalPrompt,
  buildGoalVerifierPrompt,
  defaultHeuristicReview,
  normalizeGoalMaxIterations,
  runGoalLoop,
} from "./runner.ts";

describe("goal runner", () => {
  it("keeps ordinary answers and research in the parent buffer", () => {
    const workerPrompt = buildGoalPrompt({ goal: "x" });
    const reviewerPrompt = buildGoalVerifierPrompt(
      { goal: "x" },
      "worker report"
    );

    for (const prompt of [workerPrompt, reviewerPrompt]) {
      expect(prompt).toContain(
        "Return ordinary answers and research results to the parent conversation buffer by default."
      );
      expect(prompt).toContain(
        "Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files."
      );
      expect(prompt).toContain(
        "Never create output.md, docs files, or any other file merely to display an answer."
      );
      expect(prompt).toContain(
        "outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output."
      );
      expect(prompt).toContain(
        "Use Pi's native find for filename searches and Pi's native grep for content searches."
      );
      expect(prompt).toContain("Do not use bash or rg for ordinary searches.");
      expect(prompt).toContain(
        "Use bash only when the task genuinely requires executing a shell command."
      );
    }
  });

  it("requires an explicit completion marker and verification evidence", async () => {
    await expect(
      defaultHeuristicReview(
        "Ship the change",
        undefined,
        "Completed successfully."
      )
    ).resolves.toMatchObject({ complete: false, score: 50 });

    await expect(
      defaultHeuristicReview(
        "Ship the change",
        ["tests pass"],
        "GOAL_STATUS: complete\nCHECKPOINT: finished\nVERIFICATION: pnpm test — 310 passed\nREMAINING: none\nTests pass."
      )
    ).resolves.toMatchObject({ complete: true, score: 100 });
  });

  it("builds a checkpoint prompt and keeps running until verified completion", async () => {
    const prompts: string[] = [];
    const result = await runGoalLoop({
      options: {
        goal: "Migrate the API",
        criteria: ["tests pass"],
        maxIterations: 3,
      },
      execute: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? "GOAL_STATUS: continue\nCHECKPOINT: migrated handlers\nVERIFICATION: pnpm test — one failure\nREMAINING: fix test\n"
          : "GOAL_STATUS: complete\nCHECKPOINT: migration finished\nVERIFICATION: pnpm test — all tests pass\nREMAINING: none\n";
      },
    });

    expect(prompts[0]).toContain("Required checkpoint footer");
    expect(buildGoalPrompt({ goal: "x" })).toContain("Durable coding goal");
    expect(result).toMatchObject({
      status: "completed",
      complete: true,
      iterations: 2,
    });
  });

  it("applies guidance added while the goal is running at the next checkpoint", async () => {
    const guidance: string[] = [];
    const prompts: string[] = [];
    const result = await runGoalLoop({
      options: {
        goal: "Move the library",
        maxIterations: 2,
        guidance,
      },
      execute: async (prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          guidance.push("Put the library in Movies.");
          return "GOAL_STATUS: continue\nCHECKPOINT: inspected the source\nVERIFICATION: source exists\nREMAINING: move it\n";
        }
        return "GOAL_STATUS: complete\nCHECKPOINT: moved\nVERIFICATION: Movies contains the library\nREMAINING: none\n";
      },
    });

    expect(prompts[0]).not.toContain("Put the library in Movies.");
    expect(prompts[1]).toContain("Put the library in Movies.");
    expect(result.status).toBe("completed");
  });

  it("stops at the first blocker instead of spending every checkpoint on work that cannot go on", async () => {
    let runs = 0;
    const result = await runGoalLoop({
      options: { goal: "Move the library", maxIterations: 8 },
      execute: async () => {
        runs += 1;
        return "GOAL_STATUS: blocked\nCHECKPOINT: waiting\nVERIFICATION: none\nREMAINING: choose the destination";
      },
    });
    expect(runs).toBe(1);
    expect(result).toMatchObject({
      complete: false,
      blocked: true,
      blocker: "choose the destination",
      iterations: 1,
    });
    expect(result.summary).toContain("blocked at checkpoint 1");
  });

  it("takes the independent reviewer's blocker and keeps going when only a check failed", async () => {
    const verdicts = [
      "VERDICT: fail\nEVIDENCE: test red\nREMAINING: fix it",
      "VERDICT: blocked\nEVIDENCE: no access\nREMAINING: grant access",
    ];
    let call = 0;
    const result = await runGoalLoop({
      options: { goal: "x", maxIterations: 8 },
      execute: async () => "worker",
      reviewEvaluator: async (goal, criteria, output) => {
        const { reviewGoalEvidence } = await import("./runner.ts");
        return reviewGoalEvidence(goal, criteria, verdicts[call++] ?? output);
      },
    });
    expect(call).toBe(2);
    expect(result).toMatchObject({
      blocked: true,
      blocker: "grant access",
      iterations: 2,
    });
  });

  it("does not call a completed goal blocked", async () => {
    const result = await runGoalLoop({
      options: { goal: "x", maxIterations: 2 },
      execute: async () => "w",
      reviewEvaluator: async () => ({
        complete: true,
        score: 100,
        critique: "ok",
        remainingTasks: [],
      }),
    });
    expect(result.blocked).toBeUndefined();
    expect(result.status).toBe("completed");
  });

  it("does not cap an explicit checkpoint budget at the old ceiling", async () => {
    expect(normalizeGoalMaxIterations(undefined)).toBe(8);
    expect(normalizeGoalMaxIterations(75)).toBe(75);

    let runs = 0;
    const result = await runGoalLoop({
      options: { goal: "x", maxIterations: 75 },
      execute: async () => {
        runs += 1;
        return "GOAL_STATUS: continue\nCHECKPOINT: still working\nVERIFICATION: none\nREMAINING: continue";
      },
    });

    expect(runs).toBe(75);
    expect(result).toMatchObject({
      status: "max_iterations",
      complete: false,
      iterations: 75,
    });
  });
});
