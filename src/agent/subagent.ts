import { readdir, readFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type { AgentRuntime, RuntimeModelRef, NormalizedEvent } from "../runtime/types.ts";

export interface SubagentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  model?: RuntimeModelRef;
  tools?: string[];
  maxTurns?: number;
  inheritContext?: boolean;
  source: "project" | "global" | "workspace" | "builtin";
}

/**
 * Reserved control-plane tools that subagents are strictly forbidden from having
 * to prevent runaway recursion or unauthorized session control (§7.6).
 */
export const RESERVED_TOOLS = new Set<string>([
  "run_subagent",
  "subagent",
  "interrupt",
  "delete_session",
  "quiesce",
  "unquiesce",
]);

/**
 * Built-in Homelab Subagents
 */
export const BUILTIN_SUBAGENTS: Record<string, SubagentProfile> = {
  diagnostics: {
    name: "diagnostics",
    description: "Homelab health and container diagnostics subagent. Checks container states, disk, memory, and identifies failing services.",
    systemPrompt: [
      "You are a specialized Homelab Diagnostics Subagent.",
      "Your responsibility is inspecting container states, resource metrics, and service health.",
      "Focus on identifying failing containers, restarting loops, high resource consumers, and unhealthy services.",
      "Provide a concise diagnostic report with identified root causes.",
    ].join("\n"),
    tools: ["container.list", "container.inspect", "bash"],
    maxTurns: 6,
    inheritContext: false,
    source: "builtin",
  },
  "log-analyzer": {
    name: "log-analyzer",
    description: "Homelab container log analyzer. Inspects error stacks, detects anomalous patterns and root causes.",
    systemPrompt: [
      "You are a specialized Homelab Log Analysis Subagent.",
      "Your responsibility is reading container logs, extracting stacktraces, and pinpointing exact error causes.",
      "Summarize the error timeline and recommend remediation steps.",
    ].join("\n"),
    tools: ["container.logs", "container.inspect", "bash"],
    maxTurns: 5,
    inheritContext: false,
    source: "builtin",
  },
  "network-prober": {
    name: "network-prober",
    description: "Homelab network and connectivity diagnostic subagent. Inspects open ports, reachability, and internal DNS.",
    systemPrompt: [
      "You are a specialized Homelab Network Probing Subagent.",
      "Your responsibility is diagnosing connectivity between containers, testing open ports, and checking local DNS resolution.",
      "Be safe: do not alter firewall rules or bring interfaces down.",
    ].join("\n"),
    tools: ["bash"],
    maxTurns: 5,
    inheritContext: false,
    source: "builtin",
  },
};

/**
 * Simple YAML-frontmatter parser without external dependencies.
 */
export function parseSubagentMarkdown(content: string, source: SubagentProfile["source"]): SubagentProfile | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return null;
  }
  const frontmatter = match[1]!;
  const systemPrompt = match[2]!.trim();

  let name = "";
  let description = "";
  let maxTurns: number | undefined;
  let inheritContext: boolean | undefined;
  const tools: string[] = [];
  let model: RuntimeModelRef | undefined;

  let currentKey = "";
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && currentKey === "tools") {
      const tool = trimmed.slice(2).trim();
      if (tool) tools.push(tool);
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      currentKey = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();
      if (currentKey === "name") name = val;
      else if (currentKey === "description") description = val;
      else if (currentKey === "maxTurns") maxTurns = Number(val) || undefined;
      else if (currentKey === "inheritContext") inheritContext = val === "true";
      else if (currentKey === "model" && val) {
        const parts = val.split("/");
        if (parts.length === 2) {
          model = { providerId: parts[0]!, modelId: parts[1]! };
        }
      }
    }
  }

  if (!name) return null;

  // Filter out reserved tools (§7.6)
  const safeTools = tools.filter((t) => !RESERVED_TOOLS.has(t));

  return {
    name,
    description: description || name,
    systemPrompt,
    model,
    tools: safeTools.length > 0 ? safeTools : undefined,
    maxTurns,
    inheritContext,
    source,
  };
}

/**
 * Checks for path traversal and ensures target path is inside expected root.
 */
export function isPathSafe(root: string, target: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget.startsWith(resolvedRoot);
}

/**
 * Discovers subagents according to the priority chain:
 * project (.thebe/subagents) > global (~/.thebe/subagents) > workspace (subagents/) > builtin (§8.3)
 */
export async function loadSubagents(cwd: string = process.cwd()): Promise<Map<string, SubagentProfile>> {
  const result = new Map<string, SubagentProfile>();

  // 1. Load built-ins first (lowest priority, overridden by user profiles)
  for (const [name, profile] of Object.entries(BUILTIN_SUBAGENTS)) {
    result.set(name, profile);
  }

  // Helper to scan a directory for .md subagents
  async function scanDir(dir: string, source: SubagentProfile["source"]) {
    try {
      if (!isAbsolute(dir)) {
        dir = resolve(cwd, dir);
      }
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const filePath = join(dir, entry.name);
          if (!isPathSafe(dir, filePath)) continue;
          try {
            const content = await readFile(filePath, "utf8");
            const profile = parseSubagentMarkdown(content, source);
            if (profile) {
              result.set(profile.name, profile);
            }
          } catch {
            // ignore unreadable files
          }
        }
      }
    } catch {
      // directory does not exist, ignore
    }
  }

  // 2. Workspace directory: <cwd>/subagents
  await scanDir(join(cwd, "subagents"), "workspace");

  // 3. Global directory: ~/.thebe/subagents
  try {
    const globalDir = process.env.THEBE_SUBAGENTS_DIR || join(homedir(), ".thebe", "subagents");
    await scanDir(globalDir, "global");
  } catch {
    // ignore
  }

  // 4. Project directory: <cwd>/.thebe/subagents (highest priority)
  await scanDir(join(cwd, ".thebe", "subagents"), "project");

  return result;
}

export interface RunSubagentOptions {
  runtime: AgentRuntime;
  profile: SubagentProfile;
  task: string;
  contextText?: string;
  onEvent?: (event: NormalizedEvent) => void;
}

/**
 * Runs a subagent in pure in-memory mode, tagging events and stripping reserved tools.
 */
export async function runSubagent(options: RunSubagentOptions): Promise<{
  result: string;
  turns: number;
  subagent: string;
}> {
  const { runtime, profile, task, contextText, onEvent } = options;

  // Filter tools strictly
  const safeTools = (profile.tools ?? []).filter((t) => !RESERVED_TOOLS.has(t));

  let systemPrompt = profile.systemPrompt;
  if (profile.inheritContext && contextText) {
    systemPrompt += `\n\n### Prior Session Context:\n${contextText}`;
  }

  // Create ephemeral in-memory session (pure in-memory, not persisted in session store)
  const session = await runtime.createSession({
    inMemory: true,
    systemPrompt,
    model: profile.model,
    builtinTools: safeTools,
    customTools: [],
  });

  let turns = 0;
  const maxTurns = profile.maxTurns ?? 5;

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") {
      turns += 1;
      if (turns >= maxTurns) {
        void session.abort().catch(() => {});
      }
    }
    if (onEvent) {
      // Tag event with subagent metadata
      onEvent({
        ...event,
        subagent: profile.name,
      } as NormalizedEvent & { subagent: string });
    }
  });

  try {
    await session.prompt(task);
    const result = session.lastAssistantText();
    return {
      result,
      turns,
      subagent: profile.name,
    };
  } finally {
    unsubscribe();
    session.dispose();
  }
}
