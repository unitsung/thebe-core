import { describe, expect, it } from "vitest";
import type { Trigger } from "../sources/types.ts";
import type { AutoRestart } from "./auto-restart.ts";
import { createDecisionStore } from "./decision-store.ts";
import {
  createPolicyStore,
  MAX_AUTO_CONTAINERS,
  PolicyError,
  policyVersion,
} from "./policy-store.ts";
import { createEvalService } from "./service.ts";
import type { Decision, DecisionAction } from "./types.ts";

const T0 = Date.parse("2026-11-06T10:00:00Z");
const hex = (n: number) => n.toString(16).padStart(32, "0");
const down = (n: number): Trigger => ({
  id: hex(n),
  source: "container-health",
  kind: "container.went_down",
  at: new Date(T0 + n * 1000).toISOString(),
  threads: ["resource:container:emby"],
  resource: { kind: "container", id: "emby" },
  payload: { from: "running", to: "exited" },
});

async function setup(
  options: {
    mode?: "observe" | "auto";
    verdict?: "accept" | "ignore";
    act?: AutoRestart;
    withAct?: boolean;
    onAccepted?: (decision: Decision) => Promise<void>;
    /** Runs while the model "thinks", before it answers. */
    whileAssessing?: () => void;
  } = {}
) {
  const now = () => new Date(T0 + 60_000);
  const policy = createPolicyStore({ now });
  await policy.set({
    rules: ["Restart a media server that stopped"],
    acceptMode: options.mode ?? "auto",
    autoContainers: ["emby"],
  });
  const rule = (await policy.get()).rules[0]!;
  const decisions = createDecisionStore({});
  const calls: unknown[] = [];
  const accepted: Decision[] = [];
  const act: AutoRestart =
    options.act ??
    (async (input) => {
      calls.push(input);
      return {
        kind: "restart",
        status: "succeeded",
        note: "Restarted emby.",
        container: "emby",
        receiptId: "r1",
      };
    });
  const service = createEvalService({
    policy,
    decisions,
    sources: "container-health",
    now,
    act: options.withAct === false ? undefined : act,
    onAccepted:
      options.onAccepted ??
      (async (decision) => {
        accepted.push(decision);
      }),
    assess: async () => {
      options.whileAssessing?.();
      return JSON.stringify({
        decision: options.verdict ?? "accept",
        matched: options.verdict === "ignore" ? [] : [rule.id],
        reason: "it stopped",
      });
    },
  });
  return { service, decisions, calls, accepted };
}

async function run(s: Awaited<ReturnType<typeof setup>>) {
  s.service.enqueue([down(1)]);
  await s.service.idle();
  return (await s.decisions.list())[0]!;
}

describe("auto in Eval", () => {
  it("takes on a positive assessment and records what was done", async () => {
    const s = await setup();
    const decision = await run(s);
    expect(s.calls).toHaveLength(1);
    expect(decision).toMatchObject({
      outcome: "accept",
      wouldAccept: true,
      action: { kind: "restart", status: "succeeded", receiptId: "r1" },
    });
    // The id the action keys its single restart on is the Decision's own.
    expect(s.calls[0]).toMatchObject({
      decisionId: decision.id,
      thread: "resource:container:emby",
    });
  });

  it("counts being handed to the person as taken on, and a refusal to act as a would-have", async () => {
    const asked = await setup({
      act: async () =>
        ({
          kind: "diagnose",
          status: "awaiting_approval",
          note: "asked",
        }) as DecisionAction,
    });
    expect(await run(asked)).toMatchObject({ outcome: "accept" });
    const skipped = await setup({
      act: async () =>
        ({ kind: "none", status: "stale", note: "too old" }) as DecisionAction,
    });
    expect(await run(skipped)).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      action: { kind: "none", status: "stale" },
    });
  });

  it("does nothing when there is nothing to carry the action out, and says so", async () => {
    const s = await setup({ withAct: false });
    expect(await run(s)).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      action: { kind: "none", status: "no_executor" },
    });
  });

  it("gives what it took on a Ticket, and what it did not take on none", async () => {
    const s = await setup();
    const decision = await run(s);
    expect(s.accepted.map((row) => row.id)).toEqual([decision.id]);
    const skipped = await setup({
      act: async () =>
        ({ kind: "none", status: "stale", note: "too old" }) as DecisionAction,
    });
    await run(skipped);
    expect(skipped.accepted).toEqual([]);
    const observing = await setup({ mode: "observe" });
    await run(observing);
    expect(observing.accepted).toEqual([]);
  });

  it("keeps the Decision when the Ticket cannot be made", async () => {
    const s = await setup({
      onAccepted: async () => {
        throw new Error("disk full");
      },
    });
    expect(await run(s)).toMatchObject({ outcome: "accept" });
  });

  it("never acts in observe, and never when the model says no", async () => {
    const observing = await setup({ mode: "observe" });
    const decision = await run(observing);
    expect(decision).toMatchObject({ outcome: "ignore", wouldAccept: true });
    expect(decision.action).toBeUndefined();
    expect(observing.calls).toEqual([]);

    const refused = await setup({ verdict: "ignore" });
    expect(await run(refused)).toMatchObject({
      outcome: "ignore",
      wouldAccept: false,
    });
    expect(refused.calls).toEqual([]);
  });

  it("records a failing action as nothing done instead of losing the Decision", async () => {
    const s = await setup({
      act: async () => {
        throw new Error("provider exploded");
      },
    });
    expect(await run(s)).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      action: { kind: "none", status: "act_failed", note: "provider exploded" },
    });
  });

  it("does not act when Core was paused while the model was thinking", async () => {
    const holder: { stop?: () => void } = {};
    const s = await setup({ whileAssessing: () => holder.stop?.() });
    holder.stop = () => s.service.stop();
    expect(await run(s)).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      action: { kind: "none", status: "quiesced" },
    });
    expect(s.calls).toEqual([]);
  });
});

describe("the auto policy", () => {
  const now = () => new Date(T0);

  it("takes auto like any other mode, and refuses a mode it does not know", async () => {
    const store = createPolicyStore({ now });
    expect((await store.set({ acceptMode: "auto" })).acceptMode).toBe("auto");
    await expect(store.set({ acceptMode: "nonsense" })).rejects.toThrow(
      /off, observe or auto/
    );
    await expect(store.set({ acceptMode: "nonsense" })).rejects.toBeInstanceOf(
      PolicyError
    );
    expect((await store.get()).acceptMode).toBe("auto");
  });

  it("keeps the list of containers, replaces it, clears it, and checks it", async () => {
    const store = createPolicyStore({ now });
    expect(
      (await store.set({ autoContainers: [" emby ", "emby", "jellyfin"] }))
        .autoContainers
    ).toEqual(["emby", "jellyfin"]);
    // Leaving it out keeps it.
    expect((await store.set({ rules: ["a"] })).autoContainers).toEqual([
      "emby",
      "jellyfin",
    ]);
    expect(
      (await store.set({ autoContainers: [] })).autoContainers
    ).toBeUndefined();
    for (const bad of [
      "emby",
      [""],
      [3],
      Array.from({ length: MAX_AUTO_CONTAINERS + 1 }, (_, i) => `c${i}`),
    ]) {
      await expect(store.set({ autoContainers: bad })).rejects.toBeInstanceOf(
        PolicyError
      );
    }
  });

  it("is part of the version, so Decisions under different lists are different", async () => {
    const store = createPolicyStore({ now });
    const a = await store.set({ rules: ["a"], autoContainers: ["emby"] });
    const b = await store.set({ autoContainers: ["emby", "plex"] });
    expect(policyVersion(a, "s")).not.toBe(policyVersion(b, "s"));
  });
});
