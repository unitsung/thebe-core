import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createNavidromeTools } from "../tools/navidrome-tools.ts";
import { createPolicyEngine } from "../security/policy/policy-engine.ts";
import {
  buildNavidromeContract,
  NAVIDROME_CONTRACT_PATH,
  NAVIDROME_LYRICS_EXAMPLE,
  NAVIDROME_QUEUE_EXAMPLE,
} from "./navidrome-contract.ts";
import type { NavidromeProvider } from "./navidrome.ts";

const contractFile = new URL(
  `../../../${NAVIDROME_CONTRACT_PATH}`,
  import.meta.url
);
const render = () => `${JSON.stringify(buildNavidromeContract(), null, 2)}\n`;

describe("Navidrome client contract", () => {
  it("matches the checked-in contract file (THEBE_UPDATE_CONTRACT=1 rewrites it)", async () => {
    if (process.env.THEBE_UPDATE_CONTRACT === "1")
      await writeFile(contractFile, render());
    expect(await readFile(contractFile, "utf8")).toBe(render());
  });

  it("keeps the documented examples identical to what the tools emit", async () => {
    const provider = {
      service: "navidrome",
      getPlaybackQueue: async () => NAVIDROME_QUEUE_EXAMPLE,
      getLyrics: async () => NAVIDROME_LYRICS_EXAMPLE,
    } as unknown as NavidromeProvider;
    const tools = createNavidromeTools(provider, {
      policy: createPolicyEngine({
        now: () => new Date(),
        allowedToolNames: ["navidrome.queue", "navidrome.lyrics"],
      }),
      callerId: "contract",
    });
    const call = async (name: string, args: unknown) => {
      const result = await tools
        .find((tool) => tool.name === name)!
        .execute("c", args);
      return JSON.parse(result.content[0]!.text);
    };
    expect(await call("navidrome.queue", { songIds: ["song-1"] })).toEqual(
      NAVIDROME_QUEUE_EXAMPLE
    );
    expect(await call("navidrome.lyrics", { songId: "song-1" })).toEqual(
      NAVIDROME_LYRICS_EXAMPLE
    );
  });
});
