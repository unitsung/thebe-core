import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SubagentProfile = {
  name: string;
  description: string;
  filePath: string;
  scope: "project" | "global";
  model?: string;
  tools?: string[];
  systemPrompt: string;
};

export function parseSubagentFrontmatter(content: string): {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { body: content.trim() };
  }
  const header = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  let name: string | undefined;
  let description: string | undefined;
  let model: string | undefined;
  let tools: string[] | undefined;

  for (const line of header.split(/\r?\n/)) {
    const nameMatch = line.match(/^name:\s*(.+)$/i);
    if (nameMatch) {
      name = nameMatch[1]?.trim().replace(/^["']|["']$/g, "");
    }
    const descMatch = line.match(/^description:\s*(.+)$/i);
    if (descMatch) {
      description = descMatch[1]?.trim().replace(/^["']|["']$/g, "");
    }
    const modelMatch = line.match(/^model:\s*(.+)$/i);
    if (modelMatch) {
      model = modelMatch[1]?.trim().replace(/^["']|["']$/g, "");
    }
    const toolsMatch = line.match(/^tools:\s*(.+)$/i);
    if (toolsMatch) {
      const raw = toolsMatch[1]?.trim().replace(/^\[|\]$/g, "") ?? "";
      tools = raw
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
  }

  return { name, description, model, tools, body };
}

async function collectProfilesFromDir(
  dir: string,
  scope: "project" | "global",
): Promise<SubagentProfile[]> {
  const results: SubagentProfile[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const filePath = join(dir, entry.name);
        try {
          const content = await readFile(filePath, "utf8");
          const parsed = parseSubagentFrontmatter(content);
          const fallbackName = entry.name.replace(/\.md$/, "");
          results.push({
            name: parsed.name || fallbackName,
            description: parsed.description || `Subagent profile ${fallbackName}`,
            filePath,
            scope,
            model: parsed.model,
            tools: parsed.tools,
            systemPrompt: parsed.body,
          });
        } catch {}
      }
    }
  } catch {}
  return results;
}

export async function discoverSubagentProfiles(options?: {
  cwd?: string;
  homeDir?: string;
}): Promise<SubagentProfile[]> {
  const cwd = options?.cwd ?? process.cwd();
  const home = options?.homeDir ?? homedir();
  const [projectProfiles, globalProfiles] = await Promise.all([
    collectProfilesFromDir(join(cwd, ".thebe", "agents"), "project"),
    collectProfilesFromDir(join(home, ".thebe", "agents"), "global"),
  ]);

  const profileMap = new Map<string, SubagentProfile>();
  for (const p of globalProfiles) {
    profileMap.set(p.name, p);
  }
  for (const p of projectProfiles) {
    profileMap.set(p.name, p);
  }

  return Array.from(profileMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
