import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  SCHEDULES_CONTRACT_PATH,
  buildSchedulesContract,
} from "./schedules-contract.ts";

const contractFile = new URL(
  `../../../${SCHEDULES_CONTRACT_PATH}`,
  import.meta.url
);
const render = () => `${JSON.stringify(buildSchedulesContract(), null, 2)}\n`;

describe("Schedules contract", () => {
  it("matches the checked-in contract file (THEBE_UPDATE_CONTRACT=1 rewrites it)", async () => {
    if (process.env.THEBE_UPDATE_CONTRACT === "1")
      await writeFile(contractFile, render());
    expect(await readFile(contractFile, "utf8")).toBe(render());
  });

  it("gives every row a mode and keeps the legacy shape without one", () => {
    const contract = buildSchedulesContract();
    expect(contract.schedules.map((row) => row.mode)).toEqual([
      "observe",
      "auto",
      "off",
    ]);
    expect(contract.legacy.every((row) => !("mode" in row))).toBe(true);
  });
});
