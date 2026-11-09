import { describe, expect, it } from "vitest";
import type { Trigger } from "../sources/types.ts";
import { buildAssessmentPrompt, parseAssessment } from "./assess.ts";
import { createDecisionStore } from "./decision-store.ts";
import {
  createPolicyStore,
  PolicyError,
  policyVersion,
} from "./policy-store.ts";
import {
  createEvalService,
  DEFAULT_ACCEPTS_PER_THREAD_PER_HOUR,
} from "./service.ts";
import type { SpeculativePreparation } from "./types.ts";

const T0 = Date.parse("2026-11-06T10:00:00Z");
const hex = (n: number) => n.toString(16).padStart(32, "0");
const down = (n: number, thread = "resource:container:emby"): Trigger => ({
  id: hex(n),
  source: "container-health",
  kind: "container.went_down",
  at: new Date(T0 + n * 1000).toISOString(),
  threads: [thread],
  resource: { kind: "container", id: thread.split(":")[2]! },
  payload: { from: "running", to: "exited" },
});

type Accept = NonNullable<Parameters<typeof createEvalService>[0]["accept"]>;
type AcceptInput = Parameters<Accept>[0];

async function setup(
  options: {
    mode?: "observe" | "auto";
    verdict?: "accept" | "ignore";
    accept?: Accept;
    withAccept?: boolean;
    maxAccepts?: number;
    clock?: { now: number };
    /** Runs while the model "thinks", before it answers. */
    whileAssessing?: () => void;
    earlier?: { title: string; at: string; state: string }[];
    prepare?: () => Promise<SpeculativePreparation | undefined>;
    preparationTimeoutMs?: number;
  } = {}
) {
  const clock = options.clock ?? { now: T0 + 60_000 };
  const now = () => new Date(clock.now);
  const policy = createPolicyStore({ now });
  await policy.set({
    rules: ["Restart a media server that stopped"],
    acceptMode: options.mode ?? "auto",
  });
  const rule = (await policy.get()).rules[0]!;
  const decisions = createDecisionStore({});
  const accepted: AcceptInput[] = [];
  const prompts: string[] = [];
  const accept: Accept =
    options.accept ??
    (async (input) => {
      accepted.push(input);
      return {
        ticketId: `ticket-${accepted.length}`,
        goalId: `goal-${accepted.length}`,
      };
    });
  const service = createEvalService({
    policy,
    decisions,
    sources: "container-health",
    now,
    maxAcceptsPerThreadPerHour: options.maxAccepts,
    accept: options.withAccept === false ? undefined : accept,
    threadTickets: async () => options.earlier ?? [],
    ...(options.prepare ? { prepare: options.prepare } : {}),
    preparationTimeoutMs: options.preparationTimeoutMs,
    assess: async (prompt) => {
      prompts.push(prompt);
      options.whileAssessing?.();
      return JSON.stringify({
        decision: options.verdict ?? "accept",
        matched: options.verdict === "ignore" ? [] : [rule.id],
        intent: "bring the emby container back up",
        reason: "it stopped",
      });
    },
  });
  return { service, decisions, accepted, prompts, policy, rule, clock };
}

async function run(
  s: Awaited<ReturnType<typeof setup>>,
  n = 1,
  thread?: string
) {
  s.service.enqueue([down(n, thread)]);
  await s.service.idle();
  return (
    await s.decisions.list({ thread: thread ?? "resource:container:emby" })
  )[0]!;
}

describe("auto in Eval: a positive assessment becomes a Ticket", () => {
  it("takes it on through the executor, with the Eval's own id and what the assessment said", async () => {
    const s = await setup();
    const decision = await run(s);
    expect(decision).toMatchObject({
      outcome: "accept",
      wouldAccept: true,
      ticketId: "ticket-1",
      goalId: "goal-1",
    });
    expect(s.accepted).toHaveLength(1);
    expect(s.accepted[0]).toMatchObject({
      evalId: decision.evalId,
      decisionId: decision.id,
      thread: "resource:container:emby",
      policyVersion: decision.policyVersion,
      assessment: {
        intent: "bring the emby container back up",
        matchedRuleIds: [s.rule.id],
      },
    });
  });

  it("does nothing in observe, and nothing when the model says no", async () => {
    const observing = await setup({ mode: "observe" });
    const seen = await run(observing);
    expect(seen).toMatchObject({ outcome: "ignore", wouldAccept: true });
    expect(seen.ticketId).toBeUndefined();
    expect(observing.accepted).toEqual([]);

    const refused = await setup({ verdict: "ignore" });
    expect(await run(refused)).toMatchObject({
      outcome: "ignore",
      wouldAccept: false,
    });
    expect(refused.accepted).toEqual([]);
  });

  it("keeps a positive assessment as a would-have, and says why it was not taken on", async () => {
    const noExecutor = await setup({ withAccept: false });
    expect(await run(noExecutor)).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      notTakenOn: "no_executor",
    });

    const failing = await setup({
      accept: async () => {
        throw new Error("could not start");
      },
    });
    expect(await run(failing)).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      notTakenOn: "accept_failed",
    });
  });

  it("does not take it on when Core was paused while the model was thinking", async () => {
    const holder: { stop?: () => void } = {};
    const s = await setup({ whileAssessing: () => holder.stop?.() });
    holder.stop = () => s.service.stop();
    expect(await run(s)).toMatchObject({
      outcome: "ignore",
      wouldAccept: true,
      notTakenOn: "quiesced",
    });
    expect(s.accepted).toEqual([]);
  });

  it("takes one thread on only so often in an hour, then leaves it to the person", async () => {
    const s = await setup();
    const outcomes: string[] = [];
    for (let n = 1; n <= DEFAULT_ACCEPTS_PER_THREAD_PER_HOUR + 1; n++) {
      s.clock.now += 60_000;
      s.service.enqueue([down(n)]);
      await s.service.idle();
      const latest = (
        await s.decisions.list({ thread: "resource:container:emby" })
      )[0]!;
      outcomes.push(
        `${latest.outcome}${latest.notTakenOn ? `:${latest.notTakenOn}` : ""}`
      );
    }
    expect(outcomes).toEqual([
      "accept",
      "accept",
      "accept",
      "ignore:thread_limit",
    ]);
    expect(s.accepted).toHaveLength(3);
    // Another thread is its own count, and an hour later the first thread is open again.
    s.clock.now += 30_000;
    expect(await run(s, 50, "resource:container:plex")).toMatchObject({
      outcome: "accept",
    });
    s.clock.now += 61 * 60_000;
    expect(await run(s, 60)).toMatchObject({ outcome: "accept" });
  });

  it("has no limit when it is 0", async () => {
    const s = await setup({ maxAccepts: 0 });
    for (let n = 1; n <= 5; n++) {
      s.clock.now += 1000;
      await run(s, n);
    }
    expect(s.accepted).toHaveLength(5);
  });

  it("shows the assessment the work already taken on for the thread, so it is not started twice", async () => {
    const s = await setup({
      earlier: [
        {
          title: "bring emby back up",
          at: "2026-11-06T09:58:00Z",
          state: "running",
        },
      ],
    });
    await run(s);
    expect(s.prompts[0]).toContain("Work already taken on for this thread");
    expect(s.prompts[0]).toContain("bring emby back up (running)");
    const none = await setup();
    await run(none);
    expect(none.prompts[0]).not.toContain("Work already taken on");
  });

  it("uses read-only preparation and carries it into an accepted execution", async () => {
    const preparation: SpeculativePreparation = {
      source: "container-diagnosis",
      observedAt: "2026-11-06T10:00:01.000Z",
      resource: { kind: "container", id: "emby" },
      diagnosis: {
        code: "container_exited",
        title: "Container is not running",
        summary: "Observed state for emby is exited.",
        confidence: "high",
      },
      observations: [
        {
          kind: "logs",
          severity: "error",
          fact: "Recent logs contain an OOM line.",
        },
      ],
      suggestions: [],
    };
    const s = await setup({ prepare: async () => preparation });

    await run(s);

    expect(s.prompts[0]).toContain(
      '<tool_output tool="speculative_preparation">'
    );
    expect(s.prompts[0]).toContain("Container is not running");
    expect(s.accepted[0]?.preparation).toEqual(preparation);
  });

  it("still assesses when read-only preparation fails", async () => {
    const s = await setup({
      prepare: async () => {
        throw new Error("diagnosis provider unavailable");
      },
    });

    expect(await run(s)).toMatchObject({ outcome: "accept" });
    expect(s.prompts[0]).not.toContain("speculative_preparation");
    expect(s.accepted[0]?.preparation).toBeUndefined();
  });

  it("discards read-only preparation that does not finish in time", async () => {
    const s = await setup({
      prepare: () => new Promise(() => {}),
      preparationTimeoutMs: 5,
    });

    expect(await run(s)).toMatchObject({ outcome: "accept" });
    expect(s.prompts[0]).not.toContain("speculative_preparation");
    expect(s.accepted[0]?.preparation).toBeUndefined();
  });
});

describe("the assessment says what the work is", () => {
  const rules = [{ id: "r1", text: "Restart a media server that stopped" }];

  it("asks for an intent with an accept, and keeps it", () => {
    const prompt = buildAssessmentPrompt(rules, [down(1)]);
    expect(prompt).toContain('"intent"');
    const parsed = parseAssessment(
      '{"decision":"accept","matched":["r1"],"intent":"  bring emby back up  ","reason":"x"}',
      rules
    );
    expect(parsed?.intent).toBe("bring emby back up");
    // No intent is still an accept; an ignore carries none.
    expect(
      parseAssessment(
        '{"decision":"accept","matched":["r1"],"reason":"x"}',
        rules
      )?.intent
    ).toBeUndefined();
    expect(
      parseAssessment('{"decision":"ignore","intent":"x","reason":"y"}', rules)
        ?.intent
    ).toBeUndefined();
  });
});

describe("the auto policy", () => {
  const now = () => new Date(T0);

  it("takes auto like any other mode, and refuses a mode it does not know", async () => {
    const store = createPolicyStore({ now });
    expect((await store.get()).acceptMode).toBe("observe");
    expect((await store.set({ acceptMode: "auto" })).acceptMode).toBe("auto");
    await expect(store.set({ acceptMode: "nonsense" })).rejects.toThrow(
      /off, observe or auto/
    );
    await expect(store.set({ acceptMode: "nonsense" })).rejects.toBeInstanceOf(
      PolicyError
    );
    expect((await store.get()).acceptMode).toBe("auto");
  });

  it("is part of the version, so Decisions under observe and auto are different", async () => {
    const store = createPolicyStore({ now });
    const a = await store.set({ rules: ["a"], acceptMode: "observe" });
    const b = await store.set({ acceptMode: "auto" });
    expect(policyVersion(a, "s")).not.toBe(policyVersion(b, "s"));
  });
});
