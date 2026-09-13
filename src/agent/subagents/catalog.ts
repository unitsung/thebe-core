import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SUBAGENT_PROFILES } from "./profiles.ts";
import type { RuntimeModelRef } from "../runtime/index.ts";

export type SubagentProfile = {
  name: string;
  description: string;
  filePath: string;
  scope: "project" | "global" | "builtin";
  model?: RuntimeModelRef;
  tools?: string[];
  maxTurns?: number;
  /** Allow this built-in role to request edit/write tools through normal approval. */
  allowWrites?: boolean;
  /** Retained for profile compatibility; agent runs never inherit context. */
  inheritContext?: boolean;
  systemPrompt: string;
};

export function parseSubagentFrontmatter(content: string): {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  inheritContext?: boolean;
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
  let maxTurns: number | undefined;
  let inheritContext: boolean | undefined;

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
    const maxTurnsMatch = line.match(/^maxTurns:\s*(.+)$/i);
    if (maxTurnsMatch) {
      const parsed = Number(maxTurnsMatch[1]?.trim());
      if (Number.isFinite(parsed)) maxTurns = parsed;
    }
    const inheritMatch = line.match(/^inheritContext:\s*(.+)$/i);
    if (inheritMatch) {
      inheritContext = inheritMatch[1]?.trim().toLowerCase() === "true";
    }
  }

  return { name, description, model, tools, maxTurns, inheritContext, body };
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
            model: parseModelRef(parsed.model),
            tools: parsed.tools,
            maxTurns: parsed.maxTurns,
            inheritContext: parsed.inheritContext,
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
  const cwd = options && "cwd" in options ? options.cwd : process.cwd();
  const home = options?.homeDir ?? homedir();
  const [projectProfiles, globalProfiles] = await Promise.all([
    cwd
      ? collectProfilesFromDir(join(cwd, ".thebe", "agents"), "project")
      : Promise.resolve([]),
    collectProfilesFromDir(join(home, ".thebe", "agents"), "global"),
  ]);

  const profileMap = new Map<string, SubagentProfile>();
  for (const profile of Object.values(BUILTIN_SUBAGENT_PROFILES)) {
    profileMap.set(profile.name, {
      name: profile.name,
      description: profile.description,
      filePath: "",
      scope: "builtin",
      model: profile.model,
      tools: profile.tools,
      maxTurns: profile.maxTurns,
      allowWrites: profile.allowWrites,
      inheritContext: false,
      systemPrompt: profile.systemPrompt,
    });
  }
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

function parseModelRef(value?: string): RuntimeModelRef | undefined {
  if (!value) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return {
    providerId: value.slice(0, separator),
    modelId: value.slice(separator + 1),
  };
}
