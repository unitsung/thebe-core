import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { EnabledResource } from "../runtime/index.ts";

export type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
  scope: "project" | "global" | "builtin";
  enabled: boolean;
  content?: string;
  contentHash?: string;
};

/** Import a new, disabled project skill; never replace an existing file. */
export async function importProjectSkill(cwd: string, content: string): Promise<SkillInfo> {
  if (Buffer.byteLength(content, "utf8") > 1_048_576) throw new Error("Skill exceeds 1 MB");
  const parsed = parseSkillFrontmatter(content);
  if (!parsed.name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(parsed.name)) {
    throw new Error("Skill name must contain 1–64 letters, numbers, underscores or hyphens");
  }
  if (!parsed.description || !parsed.body.trim()) throw new Error("Skill requires a description and instructions");
  const root = await realpath(cwd);
  const directory = join(root, ".thebe", "skills");
  await mkdir(directory, { recursive: true });
  if (relative(root, await realpath(directory)) !== join(".thebe", "skills")) {
    throw new Error("Skill directory must be inside the workspace");
  }
  const filePath = join(directory, `${parsed.name}.md`);
  await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  return { name: parsed.name, description: parsed.description, filePath, scope: "project", enabled: false };
}

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
  loadDirectory?: (directory: string) => Promise<Array<Pick<SkillInfo, "name" | "description" | "filePath">>>;
}): Promise<SkillInfo[]> {
  const cwd = options && "cwd" in options ? options.cwd : process.cwd();
  const home = options?.homeDir ?? homedir();
  const enabledResources = options?.enabledResources ?? [];
  const collect = options?.loadDirectory
    ? async (directory: string, scope: "project" | "global"): Promise<SkillInfo[]> =>
        (await options.loadDirectory!(directory)).map((skill) => ({ ...skill, scope, enabled: false }))
    : collectSkillsFromDir;

  const [projectSkills, globalSkills] = await Promise.all([
    cwd
      ? Promise.all(
          [
            join(cwd, ".thebe", "skills"),
            join(cwd, ".pi", "skills"),
          ].map((dir) => collect(dir, "project")),
        ).then((groups) => groups.flat())
      : Promise.resolve([]),
    Promise.all(
      [
        join(home, ".thebe", "skills"),
        join(home, ".pi", "agent", "skills"),
      ].map((dir) => collect(dir, "global")),
    ).then((groups) => groups.flat()),
  ]);

  const skillMap = new Map<string, SkillInfo>();
  for (const s of [...globalSkills].reverse()) {
    skillMap.set(s.name, s);
  }
  for (const s of [...projectSkills].reverse()) {
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
  return readFile(filePath, "utf8");
}

export function skillContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
