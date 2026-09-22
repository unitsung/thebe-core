import { describe, expect, it } from "vitest";
import type { ProductGoal } from "../goals/product.ts";
import { toActivityFeed } from "./feed.ts";
import type { ActivityRecord } from "./types.ts";

function approval(): ActivityRecord {
  return {
    id: "appr-1",
    kind: "container.restart",
    actionId: "container.restart",
    resource: { kind: "container", id: "ctr-emby", name: "emby", provider: "arcane" },
    status: "pending",
    group: "needs_approval",
    summary: "Restart emby",
    createdAt: "2026-09-17T00:00:00Z",
    updatedAt: "2026-09-17T00:00:00Z",
    diagnosisRunId: "run-1",
    idempotencyKey: "approve:container.restart:ctr-emby:run-1",
  };
}

function goal(overrides: Partial<ProductGoal> = {}): ProductGoal {
  return {
    id: "goal-1",
    sessionId: "goal-1",
    title: "Repair STRM",
    status: "running",
    phase: "running",
    iteration: 1,
    maxIterations: 8,
    createdAt: "2026-09-17T00:00:02Z",
    updatedAt: "2026-09-17T00:00:03Z",
    controls: { pause: true, resume: false, stop: true },
    ...overrides,
  };
}

describe("toActivityFeed", () => {
  it("types pending restarts as approval and running goals as running", () => {
    const items = toActivityFeed([approval()], [goal()]);
    expect(items.map((item) => item.type)).toEqual(["goal", "approval"]);
    expect(items[0]?.group).toBe("running");
    expect(items[1]?.type).toBe("approval");
  });

  it("includes completed diagnosis rows without a write recommendation", () => {
    const diagnose: ActivityRecord = {
      id: "run-ok",
      kind: "container.diagnose",
      actionId: "container.diagnose",
      resource: { kind: "container", id: "ctr-emby", provider: "arcane" },
      status: "completed",
      group: "recent",
      summary: "running",
      createdAt: "2026-09-17T00:00:00Z",
      updatedAt: "2026-09-17T00:00:00Z",
      idempotencyKey: "diagnose:ctr-emby:run-ok",
      recommendations: [],
    };
    expect(toActivityFeed([diagnose], [])).toEqual([
      {
        type: "diagnosis",
        id: "run-ok",
        group: "recent",
        updatedAt: "2026-09-17T00:00:00Z",
        diagnosis: diagnose,
      },
    ]);
  });
});
