import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { key } from "../tickets/ids.ts";
import type { AcceptMode, Policy, PolicyRule } from "./types.ts";

export const MAX_RULES = 20;
export const MAX_RULE_LENGTH = 500;
export const MAX_AUTO_CONTAINERS = 20;

export type PolicyInput = {
  rules?: unknown;
  acceptMode?: unknown;
  model?: unknown;
  autoContainers?: unknown;
};

export class PolicyError extends Error {}

export type PolicyStore = {
  get(): Promise<Policy>;
  set(input: PolicyInput): Promise<Policy>;
};

export function createPolicyStore(options: {
  dir?: string;
  now: () => Date;
}): PolicyStore {
  let current: Policy | undefined;
  const file = options.dir ? join(options.dir, "policy.json") : undefined;

  async function load(): Promise<Policy> {
    if (current) return current;
    if (file) {
      try {
        current = JSON.parse(await readFile(file, "utf8")) as Policy;
        return current;
      } catch {
        // No saved policy yet, or it is unreadable: start from the default.
      }
    }
    current = {
      rules: [],
      acceptMode: "observe",
      revision: 0,
      updatedAt: options.now().toISOString(),
    };
    return current;
  }

  return {
    get: load,
    async set(input) {
      const before = await load();
      const next: Policy = {
        rules:
          input.rules === undefined ? before.rules : parseRules(input.rules),
        acceptMode:
          input.acceptMode === undefined
            ? before.acceptMode
            : parseMode(input.acceptMode),
        ...autoContainersOf(input.autoContainers, before.autoContainers),
        ...(input.model === undefined
          ? before.model
            ? { model: before.model }
            : {}
          : input.model === null
            ? {}
            : { model: parseModel(input.model) }),
        revision: before.revision + 1,
        updatedAt: options.now().toISOString(),
      };
      current = next;
      if (file && options.dir) {
        await mkdir(options.dir, { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify(next)}\n`, "utf8");
        await rename(temp, file);
      }
      return next;
    },
  };
}

/**
 * What a Decision records as the policy it was made under: the rules, the mode, the model and which
 * Sources were on. A change to any of them is a different version.
 */
export function policyVersion(policy: Policy, sources: string): string {
  return key(
    "policy",
    JSON.stringify({
      rules: policy.rules.map((rule) => rule.text),
      mode: policy.acceptMode,
      model: policy.model ?? null,
      autoContainers: policy.autoContainers ?? [],
      sources,
    })
  );
}

function parseRules(value: unknown): PolicyRule[] {
  if (!Array.isArray(value))
    throw new PolicyError("rules must be a list of strings");
  if (value.length > MAX_RULES)
    throw new PolicyError(`at most ${MAX_RULES} rules`);
  const rules: PolicyRule[] = [];
  for (const entry of value) {
    const text =
      typeof entry === "string" ? entry : (entry as { text?: unknown })?.text;
    if (typeof text !== "string" || !text.trim()) {
      throw new PolicyError("each rule must be a non-empty string");
    }
    const trimmed = text.trim();
    if (trimmed.length > MAX_RULE_LENGTH) {
      throw new PolicyError(`a rule is at most ${MAX_RULE_LENGTH} characters`);
    }
    if (rules.some((rule) => rule.text === trimmed)) continue;
    rules.push({ id: key("rule", trimmed).slice(0, 12), text: trimmed });
  }
  return rules;
}

function parseMode(value: unknown): AcceptMode {
  if (value === "off" || value === "observe" || value === "auto") return value;
  throw new PolicyError("acceptMode must be off, observe or auto");
}

/** Left out keeps what was there; a list replaces it (an empty list clears it). */
function autoContainersOf(
  value: unknown,
  before: string[] | undefined
): { autoContainers?: string[] } {
  if (value === undefined) return before ? { autoContainers: before } : {};
  if (!Array.isArray(value)) {
    throw new PolicyError("autoContainers must be a list of container names");
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new PolicyError(
        "each autoContainers entry must be a container name"
      );
    }
    const name = entry.trim();
    if (name.length > 200)
      throw new PolicyError("a container name is too long");
    if (!names.includes(name)) names.push(name);
  }
  if (names.length > MAX_AUTO_CONTAINERS) {
    throw new PolicyError(`at most ${MAX_AUTO_CONTAINERS} autoContainers`);
  }
  return names.length > 0 ? { autoContainers: names } : {};
}

function parseModel(value: unknown): { providerId: string; modelId: string } {
  const row = value as { providerId?: unknown; modelId?: unknown } | null;
  if (
    !row ||
    typeof row.providerId !== "string" ||
    typeof row.modelId !== "string" ||
    !row.providerId ||
    !row.modelId
  ) {
    throw new PolicyError(
      "model needs providerId and modelId (or null for Core's default)"
    );
  }
  return { providerId: row.providerId, modelId: row.modelId };
}
