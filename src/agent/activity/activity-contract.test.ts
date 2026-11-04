import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_CONTRACT_PATH,
  buildActivityContract,
} from "./activity-contract.ts";

const contractFile = new URL(
  `../../../${ACTIVITY_CONTRACT_PATH}`,
  import.meta.url
);
const render = () => `${JSON.stringify(buildActivityContract(), null, 2)}\n`;

describe("Activity contract", () => {
  it("matches the checked-in contract file (THEBE_UPDATE_CONTRACT=1 rewrites it)", async () => {
    if (process.env.THEBE_UPDATE_CONTRACT === "1")
      await writeFile(contractFile, render());
    expect(await readFile(contractFile, "utf8")).toBe(render());
  });

  it("gives every item a stage, keeps the legacy shape without one, and counts needs-you from the items", () => {
    const contract = buildActivityContract();
    expect(contract.items.every((entry) => "stage" in entry.item)).toBe(true);
    expect(contract.legacy.every((entry) => !("stage" in entry.item))).toBe(
      true
    );
    expect(contract.legacy.map((entry) => entry.name)).toEqual(
      contract.items.map((entry) => entry.name)
    );
    expect(contract.items.map((entry) => entry.item.stage)).toEqual([
      { kind: "person", reason: "answer" },
      { kind: "person", reason: "blocked" },
      { kind: "working" },
      { kind: "ended" },
      { kind: "person", reason: "failed" },
      { kind: "person", reason: "approval" },
      { kind: "person", reason: "failed" },
      { kind: "ended" },
      { kind: "ended" },
      { kind: "ended" },
      { kind: "working" },
      { kind: "ended" },
      { kind: "ended" },
    ]);
    expect(contract.needsYou.count).toBe(5);
    expect(contract.items.some((entry) => "ticketId" in entry.item)).toBe(
      false
    );
    const wrapped = contract.withTicketId.item as {
      ticketId?: string;
      goal: { ticketId?: string };
    };
    expect(wrapped.ticketId).toMatch(/^[0-9a-f]{32}$/);
    expect(wrapped.goal.ticketId).toBe(wrapped.ticketId);
  });
});
