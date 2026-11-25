import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { key } from "./ids.ts";
import { createTriggerFanoutDispositionStore } from "./fanout-disposition-store.ts";

const triggerId = key("trigger", "fanout-disposition");
const firstTicketId = key("ticket", "first");
const secondTicketId = key("ticket", "second");
const laterTicketId = key("ticket", "later");

describe("Trigger fan-out dispositions", () => {
  it("freezes recipients on the first plan and survives a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-fanout-dispositions-"));
    const store = createTriggerFanoutDispositionStore({ dir });
    const planned = await store.plan({
      triggerId,
      recipients: [secondTicketId, firstTicketId, secondTicketId],
      at: "2026-11-25T03:00:00.000Z",
    });

    expect(planned.recipients).toEqual([secondTicketId, firstTicketId]);
    expect(planned.delivered).toEqual([]);
    await expect(
      store.plan({
        triggerId,
        recipients: [laterTicketId],
        at: "2026-11-25T03:05:00.000Z",
      })
    ).resolves.toEqual(planned);

    const completed = await store.markDelivered(triggerId, firstTicketId);
    expect(completed?.delivered).toEqual([firstTicketId]);
    await expect(
      store.markDelivered(triggerId, firstTicketId)
    ).resolves.toEqual(completed);

    const reopened = createTriggerFanoutDispositionStore({ dir });
    await expect(reopened.get(triggerId)).resolves.toEqual(completed);
    const file = await stat(join(dir, `${triggerId}.json`));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("persists an empty recipient plan", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-fanout-empty-"));
    const planned = await createTriggerFanoutDispositionStore({ dir }).plan({
      triggerId,
      recipients: [],
      at: "2026-11-25T03:00:00.000Z",
    });

    expect(planned.recipients).toEqual([]);
    await expect(
      createTriggerFanoutDispositionStore({ dir }).get(triggerId)
    ).resolves.toEqual(planned);
  });
});
