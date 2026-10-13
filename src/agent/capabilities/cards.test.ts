import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildCardsContract, CARD_EXAMPLES, CARDS_CONTRACT_PATH, cardCatalogPrompt } from "./cards.ts";

const contractFile = new URL(`../../../${CARDS_CONTRACT_PATH}`, import.meta.url);
const render = () => `${JSON.stringify(buildCardsContract(), null, 2)}\n`;

describe("Card catalog", () => {
  it("matches the checked-in file the App syncs (THEBE_UPDATE_CONTRACT=1 rewrites it)", async () => {
    if (process.env.THEBE_UPDATE_CONTRACT === "1") await writeFile(contractFile, render());
    expect(await readFile(contractFile, "utf8")).toBe(render());
  });

  it("teaches the model exactly the cards in the contract", () => {
    const prompt = cardCatalogPrompt();
    for (const [type, payload] of Object.entries(CARD_EXAMPLES)) {
      expect(prompt).toContain(`thebe:${type} ${JSON.stringify(payload)}`);
    }
  });
});
