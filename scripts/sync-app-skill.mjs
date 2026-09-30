import { readFile, writeFile } from "node:fs/promises";

// Core owns the editable workflow; the App ships an identical offline resource.
const source = new URL("../.thebe/skills/navidrome-recommend/SKILL.md", import.meta.url);
const destination = new URL("../../ui/App/Resources/navidrome-recommend.md", import.meta.url);
const content = await readFile(source, "utf8");
if (process.argv.includes("--check")) {
  if (await readFile(destination, "utf8") !== content) {
    throw new Error("App music skill is stale: run node scripts/sync-app-skill.mjs from Core");
  }
} else {
  await writeFile(destination, content);
}
