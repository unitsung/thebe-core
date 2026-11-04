import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildTicketsContract,
  TICKETS_CONTRACT_PATH,
} from "./tickets-contract.ts";

const contractFile = new URL(
  `../../../${TICKETS_CONTRACT_PATH}`,
  import.meta.url
);
const render = async () =>
  `${JSON.stringify(await buildTicketsContract(), null, 2)}\n`;

describe("Tickets contract", () => {
  it("matches the checked-in contract file (THEBE_UPDATE_CONTRACT=1 rewrites it)", async () => {
    if (process.env.THEBE_UPDATE_CONTRACT === "1")
      await writeFile(contractFile, await render());
    expect(await readFile(contractFile, "utf8")).toBe(await render());
  });

  it("wraps goals with explicit tickets and keeps the legacy goal free of ticket fields", async () => {
    const contract = await buildTicketsContract();
    expect(contract.list.tickets).toHaveLength(2);
    expect(
      contract.list.tickets.map((ticket) => [
        ticket.mandate.strength,
        ticket.stage,
      ])
    ).toEqual([
      ["explicit", { kind: "person", reason: "answer" }],
      ["explicit", { kind: "ended" }],
    ]);
    expect(contract.item).toEqual(contract.list.tickets[0]);
    expect(contract.goal.withTicketId.ticketId).toBe(contract.item!.id);
    expect(contract.goal.legacy).not.toHaveProperty("ticketId");
    expect(contract.health.legacy).not.toHaveProperty("capabilities");
  });
});
