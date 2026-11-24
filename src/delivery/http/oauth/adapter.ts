import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Adapter,
  AdapterConstructor,
  AdapterPayload,
} from "oidc-provider";
import { writeFileAtomicSync } from "../../../atomic-write.ts";

type StoredAdapterItem = {
  model: string;
  id: string;
  payload: AdapterPayload;
  expiresAt?: number;
};

type StoredAdapterState = {
  version: 1;
  items: StoredAdapterItem[];
};

export function oauthAdapterPath(configDir: string): string {
  return join(configDir, "oauth-state.json");
}

/**
 * The adapter uses synchronous read-modify-write inside each operation. Node's
 * event loop cannot interleave two such operations, so consume is atomic within
 * the one Core process that owns the config directory.
 */
export function createOAuthAdapter(configDir: string): AdapterConstructor {
  const path = oauthAdapterPath(configDir);
  const now = () => Date.now();

  return class PersistentOAuthAdapter implements Adapter {
    constructor(readonly model: string) {}

    async upsert(
      id: string,
      payload: AdapterPayload,
      expiresIn?: number
    ): Promise<void> {
      const state = readState(path, now());
      const existing = state.items.findIndex(
        (item) => item.model === this.model && item.id === id
      );
      if (this.model === "ReplayDetection" && existing >= 0) {
        throw new Error("replay detected");
      }
      const item: StoredAdapterItem = {
        model: this.model,
        id,
        payload,
        ...(typeof expiresIn === "number" && Number.isFinite(expiresIn)
          ? { expiresAt: now() + expiresIn * 1000 }
          : {}),
      };
      if (existing >= 0) {
        state.items[existing] = item;
      } else {
        state.items.push(item);
      }
      writeState(path, state);
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      const state = readState(path, now());
      return state.items.find(
        (item) => item.model === this.model && item.id === id
      )?.payload;
    }

    async findByUserCode(
      userCode: string
    ): Promise<AdapterPayload | undefined> {
      const state = readState(path, now());
      return state.items.find(
        (item) =>
          item.model === this.model && item.payload.userCode === userCode
      )?.payload;
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const state = readState(path, now());
      return state.items.find(
        (item) => item.model === this.model && item.payload.uid === uid
      )?.payload;
    }

    async consume(id: string): Promise<void> {
      const state = readState(path, now());
      const item = state.items.find(
        (candidate) => candidate.model === this.model && candidate.id === id
      );
      if (!item || item.payload.consumed !== undefined) {
        throw new Error("already consumed");
      }
      item.payload.consumed = now();
      writeState(path, state);
    }

    async destroy(id: string): Promise<void> {
      const state = readState(path, now());
      const next = state.items.filter(
        (item) => item.model !== this.model || item.id !== id
      );
      if (next.length !== state.items.length) {
        state.items = next;
        writeState(path, state);
      }
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      const state = readState(path, now());
      const next = state.items.filter(
        (item) => item.payload.grantId !== grantId
      );
      if (next.length !== state.items.length) {
        state.items = next;
        writeState(path, state);
      }
    }
  };
}

export function listOAuthAdapterPayloads(
  configDir: string,
  model: string
): AdapterPayload[] {
  return readState(oauthAdapterPath(configDir), Date.now())
    .items.filter((item) => item.model === model)
    .map((item) => item.payload);
}

function readState(path: string, at: number): StoredAdapterState {
  if (!existsSync(path)) return { version: 1, items: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid OAuth state`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} does not contain OAuth state`);
  }
  const state = value as Partial<StoredAdapterState>;
  if (
    state.version !== 1 ||
    !Array.isArray(state.items) ||
    !state.items.every(validItem)
  ) {
    throw new Error(`${path} does not contain valid OAuth state`);
  }
  const items = (state.items as StoredAdapterItem[]).filter(
    (item) => item.expiresAt === undefined || item.expiresAt > at
  );
  return { version: 1, items };
}

function writeState(path: string, state: StoredAdapterState): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileAtomicSync(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function validItem(value: unknown): value is StoredAdapterItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Partial<StoredAdapterItem>;
  return (
    typeof item.model === "string" &&
    typeof item.id === "string" &&
    !!item.payload &&
    typeof item.payload === "object" &&
    !Array.isArray(item.payload) &&
    (item.expiresAt === undefined || typeof item.expiresAt === "number")
  );
}
