import { describe, expect, it } from "vitest";
import { createTriggerStore } from "../sources/store.ts";
import type { Trigger } from "../sources/types.ts";
import { createTicketStore } from "../tickets/store.ts";
import { createEvalDispositionStore } from "./disposition-store.ts";
import { createEvalRoutingApi } from "./routing.ts";
import {
  THREAD_UNSUBSCRIBE_TOOL_NAME,
  TRIGGER_REQUEUE_TOOL_NAME,
} from "./routing-tools.ts";

const NOW = "2026-11-10T10:00:00.000Z";
const trigger: Trigger = {
  id: "1".repeat(32),
  source: "container-health",
  kind: "container.unhealthy",
  at: "2026-11-10T09:59:00.000Z",
  threads: ["resource:container:emby"],
  resource: { kind: "container", id: "emby" },
  payload: { state: "unhealthy" },
};

async function setup() {
  const triggers = createTriggerStore({});
  await triggers.add([trigger]);
  const tickets = createTicketStore({});
  const dispositions = createEvalDispositionStore({});
  const requeued: Array<{ triggerId: string; requeueId: string }> = [];
  const api = createEvalRoutingApi({
    triggers,
    tickets,
    dispositions,
    eval: {
      requeue: (row, requeueId) => {
        requeued.push({ triggerId: row.id, requeueId });
      },
    },
    checkWritable: () => {},
    now: () => new Date(NOW),
  });
  return { api, tickets, dispositions, requeued };
}

describe("Eval routing", () => {
  it("records and queues one explicit Trigger requeue", async () => {
    const s = await setup();
    const result = await s.api.invoke(
      TRIGGER_REQUEUE_TOOL_NAME,
      { triggerId: trigger.id },
      { name: "main-session", writes: true, irreversible: true }
    );

    expect(result).toMatchObject({
      queued: true,
      triggerId: trigger.id,
    });
    expect(s.requeued).toEqual([
      {
        triggerId: trigger.id,
        requeueId: (result as { requeueId: string }).requeueId,
      },
    ]);
    await expect(
      s.dispositions.listTriggerRequeues({ triggerId: trigger.id })
    ).resolves.toMatchObject([
      {
        triggerId: trigger.id,
        requester: "chat",
      },
    ]);
  });

  it("leaves a follow-up with the Ticket that already owns it", async () => {
    const s = await setup();
    await s.tickets.attachToTicket({
      ticketId: (
        await s.tickets.recordDirect({
          thread: "chat:owner",
          triggerId: "2".repeat(32),
          kind: "goal-start",
          at: NOW,
          title: "Owned work",
          requester: "chat",
          subscriptions: ["resource:container:emby"],
        })
      ).id,
      triggers: [trigger],
    });

    await expect(
      s.api.requeueTrigger(trigger.id, "chat")
    ).rejects.toMatchObject({
      status: 409,
      code: "trigger_owned_by_ticket",
    });
    expect(s.requeued).toEqual([]);
  });

  it("drops a Thread subscription from every Ticket while preserving their inputs", async () => {
    const s = await setup();
    const first = await s.tickets.recordDirect({
      thread: "chat:first",
      triggerId: "3".repeat(32),
      kind: "goal-start",
      at: NOW,
      title: "First",
      requester: "chat",
      subscriptions: ["resource:container:emby"],
    });
    const second = await s.tickets.recordDirect({
      thread: "chat:second",
      triggerId: "4".repeat(32),
      kind: "goal-start",
      at: NOW,
      title: "Second",
      requester: "chat",
      subscriptions: ["resource:container:emby"],
    });
    await s.tickets.attachToTicket({
      ticketId: first.id,
      triggers: [trigger],
    });

    await expect(
      s.api.invoke(
        THREAD_UNSUBSCRIBE_TOOL_NAME,
        { thread: "resource:container:emby" },
        { name: "main-session", writes: true, irreversible: true }
      )
    ).resolves.toMatchObject({
      thread: "resource:container:emby",
      removedFrom: expect.arrayContaining([first.id, second.id]),
    });
    await expect(s.tickets.get(first.id)).resolves.toMatchObject({
      subscriptions: ["chat:first"],
      inputs: [expect.objectContaining({ triggerId: trigger.id })],
    });
    await expect(s.tickets.get(second.id)).resolves.toMatchObject({
      subscriptions: ["chat:second"],
    });
  });
});
