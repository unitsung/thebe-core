import { describe, expect, it } from "vitest";
import {
  createPolicyEngine,
  createPolicyRunState,
  decide,
} from "./policy-engine.ts";

describe("PolicyEngine decide (§4 pure)", () => {
  it("allows known read-only tools with fresh state", () => {
    expect(
      decide({
        toolName: "container.list",
        runState: createPolicyRunState(),
        maxToolCalls: 50,
        maxBlocks: 3,
      }),
    ).toEqual({ allow: true });
  });

  it("rejects unknown tools", () => {
    const d = decide({
      toolName: "container.start",
      runState: createPolicyRunState(),
      maxToolCalls: 50,
      maxBlocks: 3,
    });
    expect(d.allow).toBe(false);
  });

  it("rejects container.restart because approval is required", () => {
    const d = decide({
      toolName: "container.restart",
      runState: createPolicyRunState(),
      maxToolCalls: 50,
      maxBlocks: 3,
    });
    expect(d).toEqual({
      allow: false,
      reason: "container.restart requires on-device approval",
    });
  });

  it("blocks everything once deny/violation latch is set", () => {
    expect(
      decide({
        toolName: "container.list",
        runState: { ...createPolicyRunState(), denyLatch: true },
        maxToolCalls: 50,
        maxBlocks: 3,
      }).allow,
    ).toBe(false);
    expect(
      decide({
        toolName: "container.list",
        runState: { ...createPolicyRunState(), violationLatch: true },
        maxToolCalls: 50,
        maxBlocks: 3,
      }).allow,
    ).toBe(false);
  });
});

describe("PolicyEngine hooks (§4.4 deny-latch via shouldStopAfterTurn, Q9)", () => {
  it("exhausts budget: further calls block and shouldStopAfterTurn ends the run", async () => {
    const policy = createPolicyEngine({
      now: () => new Date(),
      maxToolCalls: 2,
      maxBlocks: 10,
    });
    policy.beginRun();
    await expect(
      policy.beforeToolCall({ toolCall: { name: "container.list" } }),
    ).resolves.toEqual({});
    await expect(
      policy.beforeToolCall({ toolCall: { name: "container.list" } }),
    ).resolves.toEqual({});
    expect(await policy.shouldStopAfterTurn()).toBe(true);
    const blocked = await policy.beforeToolCall({
      toolCall: { name: "container.list" },
    });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("Budget exhausted");
    expect("terminate" in blocked).toBe(false);
    expect(await policy.shouldStopAfterTurn()).toBe(true);
  });

  it("stops without a terminate field on the hook result", async () => {
    const policy = createPolicyEngine({
      now: () => new Date(),
      maxToolCalls: 1,
      maxBlocks: 10,
    });
    policy.beginRun();
    await policy.beforeToolCall({ toolCall: { name: "container.list" } });
    const b = await policy.beforeToolCall({
      toolCall: { name: "container.list" },
    });
    expect(b).not.toHaveProperty("terminate");
    expect(await policy.shouldStopAfterTurn()).toBe(true);
  });

  it("sets violationLatch after N blocks and stops", async () => {
    const policy = createPolicyEngine({
      now: () => new Date(),
      maxToolCalls: 50,
      maxBlocks: 3,
    });
    policy.beginRun();
    for (let i = 0; i < 3; i++) {
      const r = await policy.beforeToolCall({
        toolCall: { name: "container.start" },
      });
      expect(r.block).toBe(true);
    }
    expect(policy.runSnapshot().violationLatch).toBe(true);
    expect(await policy.shouldStopAfterTurn()).toBe(true);
  });

  it("fail-closed: a throw in decide still blocks", async () => {
    const policy = createPolicyEngine({ now: () => new Date() });
    policy.beginRun();
    const r = await policy.beforeToolCall(null as never);
    expect(r.block).toBe(true);
  });

  it("beginRun resets counters for a new Run", async () => {
    const policy = createPolicyEngine({
      now: () => new Date(),
      maxToolCalls: 1,
      maxBlocks: 10,
    });
    policy.beginRun();
    await policy.beforeToolCall({ toolCall: { name: "container.list" } });
    expect(await policy.shouldStopAfterTurn()).toBe(true);
    policy.beginRun();
    expect(await policy.shouldStopAfterTurn()).toBe(false);
    await expect(
      policy.beforeToolCall({ toolCall: { name: "container.list" } }),
    ).resolves.toEqual({});
  });
});
