import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic-write.ts";
import {
  parseImAccount,
  parseImBinding,
  parseImConversation,
  parseImCredentials,
  parseImInbound,
} from "./validation.ts";
import type {
  ImAccount,
  ImAdapterCredentials,
  ImBinding,
  ImConversation,
  ImInbound,
} from "./types.ts";

const STATE_FILE = "im.json";
const SECRETS_FILE = "im-secrets.json";
const DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACCOUNTS = 20;
const MAX_BINDINGS = 100;
const MAX_CONVERSATIONS = 200;
const MAX_DEDUPE = 5_000;
const MAX_PENDING = 100;

export type ImPendingInbound = {
  /** Deduplication key used to keep the queue itself idempotent. */
  key: string;
  inbound: ImInbound;
  enqueuedAt: string;
};

/** A persisted platform cursor, tied to the bot/account identity that produced it. */
export type ImCursor = {
  value: string;
  identity?: string;
};

export type ImState = {
  version: 1;
  accounts: ImAccount[];
  bindings: ImBinding[];
  conversations: ImConversation[];
  cursors: Record<string, ImCursor>;
  /** `(platform, account, chat, message)` and update keys, mapped to when they were seen. */
  dedupe: Record<string, number>;
  /** Accepted inbound messages not handled yet. Text is removed as soon as it is handled. */
  pending: ImPendingInbound[];
  updatedAt: string;
};

export type ImStore = {
  read(): Promise<ImState>;
  update<T>(mutate: (state: ImState) => T): Promise<T>;
  getSecret(accountId: string): Promise<ImAdapterCredentials | undefined>;
  setSecret(
    accountId: string,
    credentials: ImAdapterCredentials
  ): Promise<void>;
  deleteSecret(accountId: string): Promise<void>;
};

/**
 * Owner-only durable state for IM accounts, bindings, cursors, dedupe keys and the accepted inbound
 * queue. Credentials live in a separate 0600 file so a status read can never include them.
 */
export function createImStore(options: {
  dir?: string;
  now?: () => Date;
}): ImStore {
  const now = options.now ?? (() => new Date());
  const stateFile = options.dir ? join(options.dir, STATE_FILE) : undefined;
  const secretsFile = options.dir ? join(options.dir, SECRETS_FILE) : undefined;
  let state: ImState | undefined;
  let loading: Promise<ImState> | undefined;
  let secrets: Record<string, ImAdapterCredentials> | undefined;
  let secretsLoading: Promise<Record<string, ImAdapterCredentials>> | undefined;
  let stateChain: Promise<unknown> = Promise.resolve();
  let secretsChain: Promise<unknown> = Promise.resolve();

  function emptyState(): ImState {
    return {
      version: 1,
      accounts: [],
      bindings: [],
      conversations: [],
      cursors: {},
      dedupe: {},
      pending: [],
      updatedAt: now().toISOString(),
    };
  }

  async function loadState(): Promise<ImState> {
    if (state) return state;
    if (!stateFile) {
      state = emptyState();
      return state;
    }
    try {
      const raw = JSON.parse(await readFile(stateFile, "utf8")) as unknown;
      state = parseState(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state = emptyState();
      } else {
        // A corrupt file must not silently forget bindings and accounts.
        throw error;
      }
    }
    prune(state, now().getTime());
    return state;
  }

  async function persistState(value: ImState): Promise<void> {
    if (!stateFile || !options.dir) return;
    await mkdir(options.dir, { recursive: true });
    await writeFileAtomic(stateFile, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async function loadSecrets(): Promise<Record<string, ImAdapterCredentials>> {
    if (secrets) return secrets;
    if (!secretsFile) {
      secrets = {};
      return secrets;
    }
    try {
      const raw = JSON.parse(await readFile(secretsFile, "utf8")) as unknown;
      secrets = parseSecrets(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        secrets = {};
      } else {
        throw error;
      }
    }
    return secrets;
  }

  async function persistSecrets(
    value: Record<string, ImAdapterCredentials>
  ): Promise<void> {
    if (!secretsFile || !options.dir) return;
    await mkdir(options.dir, { recursive: true });
    await writeFileAtomic(
      secretsFile,
      `${JSON.stringify({ version: 1, accounts: value })}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      }
    );
  }

  return {
    async read() {
      loading ??= loadState();
      return loading;
    },
    update<T>(mutate: (value: ImState) => T): Promise<T> {
      const run = stateChain.then(async () => {
        const value = await (loading ??= loadState());
        const result = mutate(value);
        prune(value, now().getTime());
        value.updatedAt = now().toISOString();
        await persistState(value);
        return result;
      });
      stateChain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    async getSecret(accountId) {
      const value = await (secretsLoading ??= loadSecrets());
      return value[accountId];
    },
    setSecret(accountId, credentials) {
      const run = secretsChain.then(async () => {
        const value = await (secretsLoading ??= loadSecrets());
        value[accountId] = { ...credentials };
        await persistSecrets(value);
      });
      secretsChain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
    deleteSecret(accountId) {
      const run = secretsChain.then(async () => {
        const value = await (secretsLoading ??= loadSecrets());
        delete value[accountId];
        await persistSecrets(value);
      });
      secretsChain = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
}

function parseState(value: unknown): ImState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IM state must be an object");
  }
  const row = value as Record<string, unknown>;
  if (row.version !== undefined && row.version !== 1) {
    throw new Error("IM state version must be 1");
  }
  const accounts = arrayOf(row.accounts, "accounts", MAX_ACCOUNTS).map(
    parseImAccount
  );
  const bindings = arrayOf(row.bindings, "bindings", MAX_BINDINGS).map(
    parseImBinding
  );
  const conversations = arrayOf(
    row.conversations,
    "conversations",
    MAX_CONVERSATIONS
  ).map(parseImConversation);
  const pending = arrayOf(row.pending, "pending", MAX_PENDING).map(
    parsePending
  );
  return {
    version: 1,
    accounts,
    bindings,
    conversations,
    cursors: parseCursorMap(row.cursors, "cursors"),
    dedupe: parseNumberMap(row.dedupe, "dedupe"),
    pending,
    updatedAt:
      typeof row.updatedAt === "string" &&
      Number.isFinite(Date.parse(row.updatedAt))
        ? new Date(row.updatedAt).toISOString()
        : new Date(0).toISOString(),
  };
}

function parsePending(value: unknown): ImPendingInbound {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IM pending entry must be an object");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.key !== "string" || !row.key.trim()) {
    throw new Error("IM pending entry key is required");
  }
  const inbound = parseImInbound(row.inbound);
  return {
    key: row.key,
    inbound,
    enqueuedAt:
      typeof row.enqueuedAt === "string" &&
      Number.isFinite(Date.parse(row.enqueuedAt))
        ? new Date(row.enqueuedAt).toISOString()
        : inbound.receivedAt,
  };
}

function parseSecrets(value: unknown): Record<string, ImAdapterCredentials> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IM secrets must be an object");
  }
  const row = value as Record<string, unknown>;
  if (row.version !== undefined && row.version !== 1) {
    throw new Error("IM secrets version must be 1");
  }
  const accounts = row.accounts;
  if (accounts === undefined) return {};
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
    throw new Error("IM secrets.accounts must be an object");
  }
  const parsed: Record<string, ImAdapterCredentials> = {};
  for (const [key, entry] of Object.entries(
    accounts as Record<string, unknown>
  )) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`IM secrets for ${key} must be an object`);
    }
    parsed[key] = parseImCredentials(entry, `im-secrets.accounts.${key}`);
  }
  return parsed;
}

function parseCursorMap(
  value: unknown,
  field: string
): Record<string, ImCursor> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const out: Record<string, ImCursor> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      if (item.trim()) out[key] = { value: item };
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.value !== "string" || !row.value.trim()) continue;
    out[key] = {
      value: row.value,
      ...(typeof row.identity === "string" && row.identity.trim()
        ? { identity: row.identity }
        : {}),
    };
  }
  return out;
}

function parseNumberMap(value: unknown, field: string): Record<string, number> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "number" && Number.isFinite(item)) out[key] = item;
  }
  return out;
}

function arrayOf(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.slice(-max);
}

/** Keeps the state bounded without making a read mutate the file. */
function prune(state: ImState, at: number): void {
  const cutoff = at - DEDUPE_TTL_MS;
  const entries = Object.entries(state.dedupe).filter(
    ([, seen]) => seen >= cutoff
  );
  entries.sort((left, right) => left[1] - right[1]);
  state.dedupe = Object.fromEntries(entries.slice(-MAX_DEDUPE));
  state.pending = state.pending.slice(-MAX_PENDING);
  state.accounts = state.accounts.slice(-MAX_ACCOUNTS);
  state.bindings = state.bindings.slice(-MAX_BINDINGS);
  state.conversations = state.conversations
    .slice()
    .sort(
      (left, right) =>
        Date.parse(left.lastSeenAt) - Date.parse(right.lastSeenAt)
    )
    .slice(-MAX_CONVERSATIONS);
}
