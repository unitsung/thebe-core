/**
 * The fenced cards a reply may carry, as example payloads. One list feeds the system prompt and the
 * contract a client can check (`contracts/cards.json`), so the model is never taught a card a client
 * cannot read. Library, table and file listings from tool results are drawn by the client on its own.
 */
export const CARD_EXAMPLES = {
  gallery: { images: ["https://example.invalid/a.png"], caption: "Caption" },
  player: {
    title: "Title",
    url: "https://example.invalid/a.mp3",
    isAudio: true,
  },
  stats: { title: "Title", items: [{ label: "Label", value: "1" }] },
  table: { headers: ["A", "B"], rows: [["1", "2"]] },
  link: { title: "Title", url: "https://example.invalid" },
  todo: { items: [{ text: "Item", checked: false }] },
  tree: {
    nodes: [
      { name: "folder", isFolder: true, children: [{ name: "file.txt" }] },
    ],
  },
} as const;

export const CARDS_CONTRACT_PATH = "contracts/cards.json";

export function buildCardsContract() {
  return { version: 1, cards: CARD_EXAMPLES };
}

/** The card list for the system prompt, e.g. `thebe:gallery {"images":["https://..."],...}; ...`. */
export function cardCatalogPrompt(): string {
  return Object.entries(CARD_EXAMPLES)
    .map(([type, payload]) => `thebe:${type} ${JSON.stringify(payload)}`)
    .join("; ");
}
