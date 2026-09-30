import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExplicitResourceLoader } from "./explicit-loader.ts";
import { loadPiSdk } from "./load-pi.ts";

describe("explicit skill discovery", () => {
  it("exposes the activation description without loading the body into the prompt and refreshes it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "thebe-skill-description-"));
    const filePath = join(directory, "SKILL.md");
    try {
      await writeFile(filePath, "---\nname: music\ndescription: Recommend library music\n---\nPrivate workflow body\n");
      const loader = createExplicitResourceLoader({
        systemPrompt: "You are Thebe.",
        enabledResources: [{ kind: "skill", identity: "music", source: filePath, version: "1" }],
        sdk: await loadPiSdk(),
      });
      expect(loader.getSkills()).toMatchObject({ skills: [{ description: "Recommend library music", filePath }] });
      expect(JSON.stringify(loader.getSkills())).not.toContain("Private workflow body");
      await writeFile(filePath, "---\nname: music\ndescription: >-\n  Curate mood\n  playlists\n---\nNew workflow\n");
      await loader.reload();
      expect(loader.getSkills()).toMatchObject({ skills: [{ description: "Curate mood playlists" }] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not discover ambient skills when nothing is explicitly enabled", async () => {
    const loader = createExplicitResourceLoader({ systemPrompt: "Thebe", sdk: await loadPiSdk() });
    expect(loader.getSkills()).toMatchObject({ skills: [], diagnostics: [] });
  });
});
