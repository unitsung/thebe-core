import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { httpError } from "../types.ts";
import { DEFAULT_RULE_SETS } from "./defaults.ts";
import {
  ACCEPT_MODES,
  type AcceptMode,
  type PolicyDefaultSet,
  type PolicySourceSettings,
  type PolicyUpdate,
  type PolicyVersion,
  type PolicyVersionSummary,
  type PolicyView,
} from "./types.ts";

const MAX_RULES = 50;
const MAX_NAME = 80;
const MAX_TEXT = 2000;
const MAX_SOURCES = 20;
const MAX_SOURCE_BYTES = 4096;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const UPDATE_KEYS = new Set([
  "baseVersion",
  "mode",
  "rules",
  "defaultSets",
  "sources",
]);

/**
 * The versioned policy: natural-language rules, the accept mode and per-source settings.
 *
 * Only an owner's authenticated request reaches `update`. No tool, event or model output has a path
 * to it, so text arriving in an event or in tool output cannot change the policy.
 *
 * Each update writes a new immutable version (`<dir>/000002.json`); the highest is current. Without
 * a directory the versions live in memory.
 */
export function createPolicyApi(options: { dir?: string; now: () => Date }) {
  let versions: PolicyVersion[] | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  /** Calls run one at a time so a read-check-write on the version cannot interleave. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  async function load(): Promise<PolicyVersion[]> {
    if (versions) return versions;
    const loaded: PolicyVersion[] = [];
    if (options.dir) {
      let names: string[] = [];
      try {
        names = (await readdir(options.dir))
          .filter((name) => /^\d{6}\.json$/.test(name))
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const [index, name] of names.entries()) {
        const version = parseStored(
          JSON.parse(await readFile(join(options.dir, name), "utf8")),
          name
        );
        // A gap would make "version N" mean different things; refuse to guess.
        if (version.version !== index + 1) {
          throw new Error(`Policy store is missing version ${index + 1}`);
        }
        loaded.push(version);
      }
    }
    if (loaded.length === 0) {
      const first = initialVersion(options.now());
      await write(first);
      loaded.push(first);
    }
    versions = loaded;
    return loaded;
  }

  async function write(version: PolicyVersion): Promise<void> {
    if (!options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const temporary = join(options.dir, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(version), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, join(options.dir, fileName(version.version)));
  }

  return {
    getPolicy(): Promise<PolicyView> {
      return serial(async () => view((await load()).at(-1)!));
    },
    getPolicyVersion(version: number): Promise<PolicyView> {
      return serial(async () => {
        const found = Number.isSafeInteger(version)
          ? (await load())[version - 1]
          : undefined;
        if (!found) {
          throw httpError(404, `No policy version ${version}`, "not_found");
        }
        return view(found);
      });
    },
    listPolicyVersions(): Promise<PolicyVersionSummary[]> {
      return serial(async () =>
        (await load()).map(({ version, createdAt, mode }) => ({
          version,
          createdAt,
          mode,
        }))
      );
    },
    updatePolicy(input: unknown): Promise<PolicyView> {
      return serial(async () => {
        const update = parseUpdate(input);
        const all = await load();
        const current = all.at(-1)!;
        if (update.baseVersion !== current.version) {
          throw httpError(
            409,
            `The policy changed: it is at version ${current.version}, not ${update.baseVersion}. Read it again and retry.`,
            "stale_revision"
          );
        }
        const next = applyUpdate(current, update, options.now());
        await write(next);
        all.push(next);
        return view(next);
      });
    },
  };
}

export type PolicyApi = ReturnType<typeof createPolicyApi>;

function fileName(version: number): string {
  return `${String(version).padStart(6, "0")}.json`;
}

function initialVersion(now: Date): PolicyVersion {
  return {
    version: 1,
    createdAt: now.toISOString(),
    mode: "observe",
    rules: [],
    defaultSets: resolveDefaultSets({}),
    sources: {},
  };
}

function resolveDefaultSets(
  enabled: Record<string, boolean>
): PolicyDefaultSet[] {
  return DEFAULT_RULE_SETS.map((set) => ({
    ...set,
    enabled: enabled[set.id] === true,
    rules: set.rules.map((rule) => ({ ...rule })),
  }));
}

function view(version: PolicyVersion): PolicyView {
  return {
    ...structuredClone(version),
    activeRules: [
      ...version.rules,
      ...version.defaultSets.flatMap((set) => (set.enabled ? set.rules : [])),
    ].map((rule) => ({ ...rule })),
  };
}

function applyUpdate(
  current: PolicyVersion,
  update: PolicyUpdate,
  now: Date
): PolicyVersion {
  const enabled: Record<string, boolean> = Object.fromEntries(
    current.defaultSets.map((set) => [set.id, set.enabled])
  );
  Object.assign(enabled, update.defaultSets);
  const sources = { ...current.sources };
  for (const [id, settings] of Object.entries(update.sources ?? {})) {
    if (settings === null) delete sources[id];
    else sources[id] = settings;
  }
  if (Object.keys(sources).length > MAX_SOURCES) {
    throw invalid(`at most ${MAX_SOURCES} sources`);
  }
  return {
    version: current.version + 1,
    createdAt: now.toISOString(),
    mode: update.mode ?? current.mode,
    rules: update.rules
      ? update.rules.map((rule) => ({
          id: rule.id ?? `rule-${randomUUID().slice(0, 8)}`,
          name: rule.name,
          text: rule.text,
        }))
      : current.rules,
    defaultSets: resolveDefaultSets(enabled),
    sources: structuredClone(sources),
  };
}

function invalid(message: string): Error {
  return httpError(400, message, "invalid_body");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUpdate(input: unknown): PolicyUpdate {
  if (!isRecord(input)) throw invalid("policy update must be an object");
  for (const key of Object.keys(input)) {
    if (!UPDATE_KEYS.has(key)) throw invalid(`${key} cannot be updated`);
  }
  const { baseVersion } = input;
  if (
    typeof baseVersion !== "number" ||
    !Number.isSafeInteger(baseVersion) ||
    baseVersion < 1
  ) {
    throw invalid(
      "baseVersion must be the policy version you last read (an integer)"
    );
  }
  const update: PolicyUpdate = { baseVersion };
  if (input.mode !== undefined) {
    if (!ACCEPT_MODES.includes(input.mode as AcceptMode)) {
      throw invalid(`mode must be ${ACCEPT_MODES.join(", ")}`);
    }
    update.mode = input.mode as AcceptMode;
  }
  if (input.rules !== undefined) update.rules = parseRules(input.rules);
  if (input.defaultSets !== undefined) {
    update.defaultSets = parseDefaultSets(input.defaultSets);
  }
  if (input.sources !== undefined) update.sources = parseSources(input.sources);
  if (
    update.mode === undefined &&
    update.rules === undefined &&
    update.defaultSets === undefined &&
    update.sources === undefined
  ) {
    throw invalid(
      "at least one of mode, rules, defaultSets or sources is required"
    );
  }
  return update;
}

function parseRules(value: unknown): NonNullable<PolicyUpdate["rules"]> {
  if (!Array.isArray(value)) throw invalid("rules must be an array");
  if (value.length > MAX_RULES) throw invalid(`at most ${MAX_RULES} rules`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw invalid(`rules[${index}] must be an object`);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!name || name.length > MAX_NAME) {
      throw invalid(`rules[${index}].name must be 1 to ${MAX_NAME} characters`);
    }
    if (!text || text.length > MAX_TEXT) {
      throw invalid(`rules[${index}].text must be 1 to ${MAX_TEXT} characters`);
    }
    let id: string | undefined;
    if (item.id !== undefined) {
      if (typeof item.id !== "string" || !ID_PATTERN.test(item.id)) {
        throw invalid(
          `rules[${index}].id must be lowercase letters, digits and dashes`
        );
      }
      if (seen.has(item.id)) throw invalid(`rules[${index}].id is used twice`);
      seen.add(item.id);
      id = item.id;
    }
    return { ...(id ? { id } : {}), name, text };
  });
}

function parseDefaultSets(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) throw invalid("defaultSets must be an object");
  const known = new Set(DEFAULT_RULE_SETS.map((set) => set.id));
  for (const [id, on] of Object.entries(value)) {
    if (!known.has(id)) throw invalid(`unknown default rule set ${id}`);
    if (typeof on !== "boolean") {
      throw invalid(`defaultSets.${id} must be a boolean`);
    }
  }
  return value as Record<string, boolean>;
}

function parseSources(
  value: unknown
): Record<string, PolicySourceSettings | null> {
  if (!isRecord(value)) throw invalid("sources must be an object");
  const out: Record<string, PolicySourceSettings | null> = {};
  for (const [id, settings] of Object.entries(value)) {
    if (!SOURCE_ID_PATTERN.test(id)) {
      throw invalid(
        `source id ${id} must be lowercase letters, digits and dashes`
      );
    }
    if (settings === null) {
      out[id] = null;
      continue;
    }
    if (!isRecord(settings) || typeof settings.enabled !== "boolean") {
      throw invalid(`sources.${id} must be an object with a boolean enabled`);
    }
    if (
      Buffer.byteLength(JSON.stringify(settings), "utf8") > MAX_SOURCE_BYTES
    ) {
      throw invalid(`sources.${id} is larger than ${MAX_SOURCE_BYTES} bytes`);
    }
    out[id] = settings as PolicySourceSettings;
  }
  return out;
}

function parseStored(raw: unknown, name: string): PolicyVersion {
  const fail = () => new Error(`Policy store file ${name} is not valid`);
  if (!isRecord(raw)) throw fail();
  if (
    typeof raw.version !== "number" ||
    typeof raw.createdAt !== "string" ||
    !ACCEPT_MODES.includes(raw.mode as AcceptMode) ||
    !Array.isArray(raw.rules) ||
    !Array.isArray(raw.defaultSets) ||
    !isRecord(raw.sources)
  ) {
    throw fail();
  }
  return raw as unknown as PolicyVersion;
}
