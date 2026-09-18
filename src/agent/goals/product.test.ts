import { describe, expect, it } from "vitest";
import type { GoalEvent } from "./runner.ts";
import type { GoalRun, SubagentRun } from "../types.ts";
import {
  goalControls,
  mapGoalStatus,
  toProductGoal,
  toProductGoalEvent,
} from "./product.ts";

function subagent(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    runId: "run-1",
    parentSessionId: "sess-1",
    profileName: "goal-worker",
    task: "do the work",
    status: "running",
    turns: 1,
    maxTurns: 8,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    activity: [{ id: 1, at: "2026-01-01T00:00:02.000Z", kind: "tool", title: "grep src" }],
    ...overrides,
  };
}

function goalRun(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    thebeSessionId: "sess-1",
    goal: "Ship the change",
    criteria: ["tests pass"],
    maxIterations: 8,
    iteration: 2,
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    subagentRunIds: ["run-1"],
    ...overrides,
  };
}

describe("product Goal mapper", () => {
  it("uses thebeSessionId as product id and collapses pausing to running", () => {
    const pausing = toProductGoal(
      goalRun({
        status: "pausing",
        activeSubagent: subagent(),
      }),
    );
    expect(pausing.id).toBe("sess-1");
    expect(pausing.sessionId).toBe("sess-1");
    expect(pausing.title).toBe("Ship the change");
    expect(pausing.status).toBe("running");
    expect(pausing.phase).toBe("pausing");
    expect(pausing.currentStep).toBe("Pausing current checkpoint");
    expect(pausing.progress).toBe(0.25);
    expect(pausing.controls).toEqual({ pause: false, resume: false, stop: true });
    expect(pausing).not.toHaveProperty("thebeSessionId");
    expect(pausing).not.toHaveProperty("finalReport");
    expect(pausing).not.toHaveProperty("subagentRunIds");
  });

  it("maps terminal statuses and pause/resume/stop controls", () => {
    expect(mapGoalStatus("running")).toBe("running");
    expect(mapGoalStatus("pausing")).toBe("running");
    expect(mapGoalStatus("paused")).toBe("paused");
    expect(mapGoalStatus("completed")).toBe("succeeded");
    expect(mapGoalStatus("cancelled")).toBe("cancelled");
    expect(mapGoalStatus("max_iterations")).toBe("failed");
    expect(mapGoalStatus("failed")).toBe("failed");

    expect(goalControls("running")).toEqual({ pause: true, resume: false, stop: true });
    expect(goalControls("paused")).toEqual({ pause: false, resume: true, stop: true });
    expect(goalControls("completed")).toEqual({ pause: false, resume: false, stop: false });

    const failed = toProductGoal(
      goalRun({
        status: "max_iterations",
        error: "stopped after 8 checkpoints",
        finishedAt: "2026-01-01T00:01:00.000Z",
        iteration: 8,
      }),
    );
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({
      code: "max_iterations",
      message: "stopped after 8 checkpoints",
    });
    expect(failed.controls.stop).toBe(false);
  });

  it("truncates review critique and omits raw subagent/runtime fields from events", () => {
    const critique = "x".repeat(401);
    const reviewed = toProductGoalEvent(
      "sess-1",
      {
        type: "goal_reviewed",
        iteration: 2,
        complete: false,
        score: 40,
        critique,
        remainingTasks: ["fix test"],
      },
      3,
      "2026-01-01T00:00:03.000Z",
    );
    expect(reviewed.critique).toHaveLength(401);
    expect(reviewed.critique?.endsWith("…")).toBe(true);
    expect(reviewed.critique?.slice(0, 400)).toBe("x".repeat(400));

    const child = toProductGoalEvent(
      "sess-1",
      {
        type: "goal_subagent_update",
        iteration: 1,
        role: "worker",
        run: subagent(),
        event: { type: "text_delta", text: "secret-runtime" },
      },
      4,
      "2026-01-01T00:00:04.000Z",
    );
    expect(child.worker).toEqual({
      id: "run-1",
      role: "worker",
      status: "running",
      title: "goal-worker",
    });
    expect(child).not.toHaveProperty("run");
    expect(child).not.toHaveProperty("event");
    expect(JSON.stringify(child)).not.toContain("secret-runtime");
    expect(JSON.stringify(child)).not.toContain("do the work");
  });

  it("maps lifecycle events to product statuses without Pi types", () => {
    const started = toProductGoalEvent(
      "sess-1",
      { type: "goal_started", goal: "Ship the change", maxIterations: 8 },
      0,
      "t0",
    );
    expect(started).toMatchObject({
      id: "0",
      type: "goal_started",
      goalId: "sess-1",
      title: "Ship the change",
      maxIterations: 8,
    });

    const completed = toProductGoalEvent(
      "sess-1",
      {
        type: "goal_completed",
        status: "completed",
        totalIterations: 2,
        summary: "done",
      },
      1,
      "t1",
    );
    expect(completed.status).toBe("succeeded");
    expect(completed.phase).toBe("completed");

    const pausing: GoalEvent = {
      type: "goal_status",
      status: "pausing",
      message: "Stopping the active checkpoint before pausing.",
    };
    const status = toProductGoalEvent("sess-1", pausing, 2, "t2");
    expect(status.status).toBe("running");
    expect(status.phase).toBe("pausing");
  });
});
