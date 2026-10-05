import { expect, it, vi } from "vitest";
import { createMusicResearchTools } from "./music-research-tools.ts";
import { createPolicyEngine } from "../security/policy/policy-engine.ts";
it("enforces policy and validates queries before requesting external evidence", async () => {
  const research = vi.fn().mockResolvedValue({ sources: [{ title: "Album" }] });
  const allowed = createPolicyEngine({ now: () => new Date(), allowedToolNames: ["music_research"] });
  const tool = createMusicResearchTools({ research }, allowed, "test")[0]!;
  await expect(tool.execute("1", { query: " " })).rejects.toThrow("query");
  await expect(tool.execute("1", { query: "Song", entity: "invalid" })).rejects.toThrow("entity");
  expect(research).not.toHaveBeenCalled();
  expect(await tool.execute("1", { query: " Song " })).toMatchObject({ content: [{ type: "text", text: '{"sources":[{"title":"Album"}]}' }] });
  expect(research).toHaveBeenCalledWith({ query: "Song", entity: undefined, language: undefined });
  const denied = createMusicResearchTools({ research }, createPolicyEngine({ now: () => new Date(), allowedToolNames: [] }), "test")[0]!;
  await expect(denied.execute("2", { query: "Song" })).rejects.toThrow();
  expect(research).toHaveBeenCalledTimes(1);
});
