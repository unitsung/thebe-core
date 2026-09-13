import { describe, expect, it } from "vitest";
import {
  buildGoalPrompt,
  buildGoalVerifierPrompt,
  defaultHeuristicReview,
  runGoalLoop,
} from "./runner.ts";

describe("goal runner", () => {
  it("keeps ordinary answers and research in the parent buffer", () => {
    const workerPrompt = buildGoalPrompt({ goal: "x" });
    const reviewerPrompt = buildGoalVerifierPrompt({ goal: "x" }, "worker report");

    for (const prompt of [workerPrompt, reviewerPrompt]) {
      expect(prompt).toContain("Return ordinary answers and research results to the parent conversation buffer by default.");
      expect(prompt).toContain("Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files.");
      expect(prompt).toContain("Never create output.md, docs files, or any other file merely to display an answer.");
      expect(prompt).toContain("outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output.");
      expect(prompt).toContain("Use Pi's native find for filename searches and Pi's native grep for content searches.");
      expect(prompt).toContain("Do not use bash or rg for ordinary searches.");
      expect(prompt).toContain("Use bash only when the task genuinely requires executing a shell command.");
    }
  });

  it("requires an explicit completion marker and verification evidence", async () => {
    await expect(
      defaultHeuristicReview("Ship the change", undefined, "Completed successfully."),
    ).resolves.toMatchObject({ complete: false, score: 50 });

    await expect(
      defaultHeuristicReview(
        "Ship the change",
        ["tests pass"],
        "GOAL_STATUS: complete\nCHECKPOINT: finished\nVERIFICATION: pnpm test — 310 passed\nREMAINING: none\nTests pass.",
      ),
    ).resolves.toMatchObject({ complete: true, score: 100 });
  });

  it("builds a checkpoint prompt and keeps running until verified completion", async () => {
    const prompts: string[] = [];
    const result = await runGoalLoop({
      options: { goal: "Migrate the API", criteria: ["tests pass"], maxIterations: 3 },
      execute: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? "GOAL_STATUS: continue\nCHECKPOINT: migrated handlers\nVERIFICATION: pnpm test — one failure\nREMAINING: fix test\n"
          : "GOAL_STATUS: complete\nCHECKPOINT: migration finished\nVERIFICATION: pnpm test — all tests pass\nREMAINING: none\n";
      },
    });

    expect(prompts[0]).toContain("Required checkpoint footer");
    expect(buildGoalPrompt({ goal: "x" })).toContain("Durable coding goal");
    expect(result).toMatchObject({ status: "completed", complete: true, iterations: 2 });
  });
});
