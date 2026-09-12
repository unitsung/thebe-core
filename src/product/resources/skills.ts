import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnabledResource } from "../../runtime/types.ts";

export type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
  scope: "project" | "global" | "builtin";
  enabled: boolean;
  content?: string;
};

export function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { body: content };
  }
  const header = match[1] ?? "";
  const body = match[2] ?? "";
  let name: string | undefined;
  let description: string | undefined;

  for (const line of header.split(/\r?\n/)) {
    const nameMatch = line.match(/^name:\s*(.+)$/i);
    if (nameMatch) {
      name = nameMatch[1]?.trim().replace(/^["']|["']$/g, "");
    }
    const descMatch = line.match(/^description:\s*(.+)$/i);
    if (descMatch) {
      description = descMatch[1]?.trim().replace(/^["']|["']$/g, "");
    }
  }

  return { name, description, body };
}

async function collectSkillsFromDir(
  dir: string,
  scope: "project" | "global",
): Promise<SkillInfo[]> {
  const results: SkillInfo[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillMd = join(dir, entry.name, "SKILL.md");
        try {
          const content = await readFile(skillMd, "utf8");
          const parsed = parseSkillFrontmatter(content);
          results.push({
            name: parsed.name || entry.name,
            description: parsed.description || `Skill in ${entry.name}`,
            filePath: skillMd,
            scope,
            enabled: false,
            content: parsed.body,
          });
        } catch {}
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const skillMd = join(dir, entry.name);
        try {
          const content = await readFile(skillMd, "utf8");
          const parsed = parseSkillFrontmatter(content);
          const fallbackName = entry.name.replace(/\.md$/, "");
          results.push({
            name: parsed.name || fallbackName,
            description: parsed.description || `Skill ${fallbackName}`,
            filePath: skillMd,
            scope,
            enabled: false,
            content: parsed.body,
          });
        } catch {}
      }
    }
  } catch {}
  return results;
}

export async function discoverSkills(options?: {
  cwd?: string;
  homeDir?: string;
  enabledResources?: EnabledResource[];
}): Promise<SkillInfo[]> {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? homedir();
  const enabledResources = options?.enabledResources ?? [];

  const [projectSkills, globalSkills] = await Promise.all([
    Promise.all(
      [
        join(cwd, ".thebe", "skills"),
        join(cwd, ".pi", "skills"),
      ].map((dir) => collectSkillsFromDir(dir, "project")),
    ).then((groups) => groups.flat()),
    Promise.all(
      [
        join(home, ".thebe", "skills"),
        join(home, ".pi", "agent", "skills"),
      ].map((dir) => collectSkillsFromDir(dir, "global")),
    ).then((groups) => groups.flat()),
  ]);

  const skillMap = new Map<string, SkillInfo>();
  for (const s of globalSkills) {
    skillMap.set(s.name, s);
  }
  for (const s of projectSkills) {
    skillMap.set(s.name, s);
  }

  for (const resource of enabledResources) {
    if (resource.kind !== "skill") continue;
    const existing = skillMap.get(resource.identity);
    if (existing) {
      existing.enabled = true;
    } else {
      skillMap.set(resource.identity, {
        name: resource.identity,
        description: `Enabled skill (${resource.source})`,
        filePath: resource.source,
        scope: "builtin",
        enabled: true,
      });
    }
  }

  return Array.from(skillMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export async function readSkillDetails(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    return `Unable to read skill file: ${err instanceof Error ? err.message : String(err)}`;
  }
}
