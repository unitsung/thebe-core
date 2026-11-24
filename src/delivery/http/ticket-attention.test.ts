import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const provider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "ok",
  getStatusSummary: async () => ({
    totalContainers: 0,
    runningContainers: 0,
    pausedContainers: 0,
    exitedContainers: 0,
    lastUpdated: 1,
  }),
};

const report = (args: Record<string, unknown>) => ({
  kind: "tools" as const,
  calls: [{ name: "goal_report", args }],
});
const text = (value: string) => ({ kind: "text" as const, text: value });
const pass = text("VERDICT: pass\nEVIDENCE: checked it\nREMAINING: none");

type Turn = ReturnType<typeof report> | ReturnType<typeof text>;

async function start(turns: Turn[], body: Record<string, unknown> = {}) {
  const fake = createFakeRuntime();
  fake.queueTurns(turns);
  const app = createThebeApp({ runtime: fake.runtime, provider });
  const call = async (path: string, init?: RequestInit) => {
    const res = await app.handler.handle(
      new Request(`http://127.0.0.1:8787${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
      })
    );
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  };
  const created = await call("/v1/tickets", {
    method: "POST",
    body: JSON.stringify({
      task: "Move the library",
      idempotencyKey: "ticket-attention",
      maxIterations: 3,
      ...body,
    }),
  });
  const ticketId = created.body.ticket.id as string;
  const goalId = created.body.goal.id as string;
  await app.agent.waitGoal(goalId);
  return { app, call, ticketId, goalId, fake };
}

const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
});

describe("a Ticket waiting on the person", () => {
  it("shows its question, hides plain resume, and is in the needs-you list", async () => {
    const { call, ticketId, goalId } = await start(
      [
        report({
          state: "ask",
          question: "Which library?",
          options: ["Movies", "Shows"],
        }),
      ],
      { allowAsk: true }
    );
    const task = await call(`/v1/tickets/${ticketId}/execution`);
    expect(task.body).toMatchObject({
      stage: "attention",
      execution: { status: "paused", controls: { resume: false } },
      receipt: {
        attention: {
          kind: "answer",
          question: "Which library?",
          options: ["Movies", "Shows"],
        },
      },
    });
    const person = await call("/v1/activity?stage=person");
    expect(
      person.body.items.map((item: any) => [item.id, item.stage, item.reason])
    ).toContainEqual([goalId, "person", "answer"]);
    const resume = await call(`/v1/tickets/${ticketId}/resume`, {
      method: "POST",
    });
    expect(resume.status).toBe(409);
    expect(resume.body.code).toBe("attention_open");
  });

  it("takes the answer once, uses it in the next checkpoint, and refuses a stale or empty one", async () => {
    const { app, call, ticketId, goalId } = await start(
      [
        report({ state: "ask", question: "Which library?" }),
        text("Asked."), // the worker's turn closes after its tool call
        text("Moved it to Movies."),
        pass,
      ],
      { allowAsk: true }
    );
    const attentionId = (await call(`/v1/tickets/${ticketId}/execution`)).body
      .receipt.attention.id as string;

    expect((await call(`/v1/tickets/${ticketId}/reply`, post({}))).status).toBe(
      400
    );
    expect(
      (
        await call(
          `/v1/tickets/${ticketId}/reply`,
          post({ attentionId, answer: "  " })
        )
      ).status
    ).toBe(400);
    const stale = await call(
      `/v1/tickets/${ticketId}/reply`,
      post({ attentionId: "old", answer: "Movies" })
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("attention_stale");

    const answered = await call(
      `/v1/tickets/${ticketId}/reply`,
      post({ attentionId, answer: "Movies" })
    );
    expect(answered.status).toBe(200);
    expect(answered.body.receipt.attention).toBeUndefined();
    const done = await app.agent.waitGoal(goalId);
    expect(done.status).toBe("completed");
    expect(done.guidance?.[0]).toContain("Movies");

    const again = await call(
      `/v1/tickets/${ticketId}/reply`,
      post({ attentionId, answer: "Shows" })
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("attention_none");
  });

  it("gives an answer to the last checkpoint one more checkpoint to be used", async () => {
    const { app, call, ticketId, goalId } = await start(
      [
        report({ state: "ask", question: "Which?" }),
        text("Asked."), // the worker's turn closes after its tool call
        text("Done with Movies."),
        pass,
      ],
      { allowAsk: true, maxIterations: 1 }
    );
    const task = (await call(`/v1/tickets/${ticketId}/execution`)).body;
    expect(task.execution.iteration).toBe(1);
    expect(task.execution.maxIterations).toBe(1);
    const answered = await call(
      `/v1/tickets/${ticketId}/reply`,
      post({ attentionId: task.receipt.attention.id, answer: "Movies" })
    );
    expect(answered.body.execution.maxIterations).toBe(2);
    expect((await app.agent.waitGoal(goalId)).status).toBe("completed");
  });
});

describe("a Ticket that asked to be reviewed before it finishes", () => {
  const finished = [text("All moved."), pass];

  it("waits for review after the independent check passes, and accepting finishes it", async () => {
    const { call, ticketId, goalId } = await start(finished, {
      reviewBeforeDone: true,
    });
    const task = (await call(`/v1/tickets/${ticketId}/execution`)).body;
    expect(task).toMatchObject({
      stage: "attention",
      execution: { status: "paused" },
      receipt: { attention: { kind: "review" } },
    });
    const person = await call("/v1/activity?stage=person");
    expect(
      person.body.items.map((item: any) => [item.id, item.reason])
    ).toContainEqual([goalId, "review"]);

    const noDecision = await call(
      `/v1/tickets/${ticketId}/reply`,
      post({ attentionId: task.receipt.attention.id })
    );
    expect(noDecision.status).toBe(400);
    const accepted = await call(
      `/v1/tickets/${ticketId}/reply`,
      post({
        attentionId: task.receipt.attention.id,
        decision: "accept",
      })
    );
    expect(accepted.body).toMatchObject({
      execution: { status: "succeeded" },
    });
    expect(accepted.body.receipt.attention).toBeUndefined();
  });

  it("sends a result back with the person's note when they reject it, and asks again after", async () => {
    const { app, call, ticketId, goalId } = await start(
      [...finished, text("Fixed the names."), pass],
      {
        reviewBeforeDone: true,
      }
    );
    const first = (await call(`/v1/tickets/${ticketId}/execution`)).body.receipt
      .attention.id as string;
    const noNote = await call(
      `/v1/tickets/${ticketId}/reply`,
      post({ attentionId: first, decision: "reject" })
    );
    expect(noNote.status).toBe(400);
    await call(
      `/v1/tickets/${ticketId}/reply`,
      post({
        attentionId: first,
        decision: "reject",
        answer: "Rename the folders",
      })
    );
    const done = await app.agent.waitGoal(goalId);
    expect(done.guidance?.[0]).toContain("Rename the folders");
    // Finished again, so it waits for review again, with a new request.
    expect(done).toMatchObject({
      status: "paused",
      attention: { kind: "review" },
    });
    expect(done.attention?.id).not.toBe(first);
  });
});
