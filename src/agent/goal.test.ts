import { describe, expect, it } from "vitest";
import { defaultHeuristicReview, runGoalLoop } from "./goal.ts";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";

describe("Goal Mode (Multi-turn iterative task convergence)", () => {
  it("evaluates completed output with 100 score and complete: true", async () => {
    const output = "All container configurations checked. Completed successfully with all checks passed.";
    const res = await defaultHeuristicReview("Verify containers", undefined, output);
    expect(res.complete).toBe(true);
    expect(res.score).toBe(100);
    expect(res.remainingTasks?.length).toBe(0);
  });

  it("evaluates output with errors as incomplete", async () => {
    const output = "Attempted restart but got Error: port 8080 already allocated.";
    const res = await defaultHeuristicReview("Restart nginx", undefined, output);
    expect(res.complete).toBe(false);
    expect(res.score).toBe(30);
    expect(res.critique).toContain("Encountered failures");
  });

  it("checks explicit criteria satisfaction", async () => {
    const criteria = ["verify memory usage", "check restart count", "clean orphan networks"];
    const output = "Checked memory usage: 200MB. Restart count is 0.";
    const res = await defaultHeuristicReview("Inspect services", criteria, output);
    expect(res.complete).toBe(false);
    expect(res.score).toBe(67); // 2 out of 3
    expect(res.remainingTasks).toContain("clean orphan networks");
  });

  it("runs goal loop, iterates when needed, and finishes when review passes", async () => {
    const { runtime, queueTurns } = createFakeRuntime();
    // Turn 1: incomplete with error
    // Turn 2: resolved and completed successfully
    queueTurns([
      { kind: "text", text: "Error: database container was unreachable, attempting recovery..." },
      { kind: "text", text: "Database container restarted and reconnected. Completed successfully." },
    ]);

    const session = await runtime.createSession({
      customTools: [],
    });

    const events: any[] = [];
    const res = await runGoalLoop({
      session,
      options: {
        goal: "Restore database connectivity and verify cluster",
        maxIterations: 3,
      },
      onEvent: (evt) => events.push(evt),
    });

    expect(res.complete).toBe(true);
    expect(res.iterations).toBe(2);
    expect(res.summary).toContain("successfully accomplished in 2 iteration(s)");

    // Events emitted
    expect(events.some((e) => e.type === "goal_started")).toBe(true);
    expect(events.some((e) => e.type === "goal_iteration" && e.iteration === 1)).toBe(true);
    expect(events.some((e) => e.type === "goal_iteration" && e.iteration === 2)).toBe(true);
    expect(events.some((e) => e.type === "goal_reviewed" && e.complete === true)).toBe(true);
    expect(events.some((e) => e.type === "goal_completed" && e.complete === true)).toBe(true);
  });
});
