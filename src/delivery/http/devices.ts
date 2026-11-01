import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DeviceRegistration = {
  registrationId: string;
  platform: string;
  deviceId?: string;
  /** The id the Push Relay gave this device; it is not a secret and is what Core addresses events to. */
  relayDeviceId?: string;
  categories: string[];
  registeredAt: string;
  updatedAt: string;
};

export type DeviceRegistrationInput = {
  token: string;
  platform: string;
  deviceId?: string;
  relayDeviceId?: string;
  categories: string[];
};

type StoredDeviceRegistration = DeviceRegistration & {
  tokenDigest: string;
};

type DeviceStore = {
  devices: StoredDeviceRegistration[];
};

export type DeviceRegistry = ReturnType<typeof createDeviceRegistry>;

export type DeviceCategoriesResult =
  | { ok: true; categories: string[] }
  | { ok: false; error: string };

const DEVICE_FILE = "devices.json";
const MAX_CATEGORIES = 16;
const MAX_CATEGORY_LENGTH = 64;

export function parseDeviceCategories(value: unknown): DeviceCategoriesResult {
  if (value === undefined) {
    return { ok: true, categories: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "categories must be an array of strings" };
  }
  if (value.length > MAX_CATEGORIES) {
    return {
      ok: false,
      error: `categories must contain at most ${MAX_CATEGORIES} items`,
    };
  }

  const categories: string[] = [];
  for (const category of value) {
    if (typeof category !== "string") {
      return { ok: false, error: "categories must be an array of strings" };
    }
    const normalized = category.trim();
    if (!normalized || normalized.length > MAX_CATEGORY_LENGTH) {
      return {
        ok: false,
        error: `each category must be between 1 and ${MAX_CATEGORY_LENGTH} characters`,
      };
    }
    if (!categories.includes(normalized)) {
      categories.push(normalized);
    }
  }
  return { ok: true, categories };
}

export function createDeviceRegistry(
  options: {
    dir?: string;
    now?: () => Date;
  } = {}
) {
  const file = options.dir ? join(options.dir, DEVICE_FILE) : undefined;
  const now = options.now ?? (() => new Date());
  let loaded = false;
  let store: DeviceStore = { devices: [] };
  let operationQueue = Promise.resolve();

  async function load(): Promise<DeviceStore> {
    if (loaded) return store;
    loaded = true;
    if (!file) return store;
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      const entries = Array.isArray(raw)
        ? raw
        : isRecord(raw) && Array.isArray(raw.devices)
          ? raw.devices
          : [];
      store = {
        devices: entries.filter(isStoredDeviceRegistration),
      };
    } catch (error) {
      // A missing file is an empty registry. A corrupt one is an error:
      // registering a device would otherwise replace every other device.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      store = { devices: [] };
    }
    return store;
  }

  async function persist(): Promise<void> {
    if (!file || !options.dir) return;
    await mkdir(options.dir, { recursive: true });
    const temporaryFile = join(options.dir, `.devices.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryFile, `${JSON.stringify(store)}\n`, "utf8");
      await rename(temporaryFile, file);
    } finally {
      await rm(temporaryFile, { force: true });
    }
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = operationQueue.then(operation);
    operationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  return {
    async register(
      input: DeviceRegistrationInput
    ): Promise<DeviceRegistration> {
      return enqueue(async () => {
        await load();
        const tokenDigest = createHash("sha256")
          .update(input.token)
          .digest("hex");
        const existing = store.devices.find(
          (device) => device.tokenDigest === tokenDigest
        );
        const timestamp = now().toISOString();
        const registration: StoredDeviceRegistration = existing
          ? {
              ...existing,
              platform: input.platform,
              deviceId: input.deviceId,
              // A re-registration that leaves it out (the relay was unreachable) keeps the one it had.
              relayDeviceId: input.relayDeviceId ?? existing.relayDeviceId,
              categories: [...input.categories],
              updatedAt: timestamp,
            }
          : {
              registrationId: `ios_${tokenDigest.slice(0, 32)}`,
              tokenDigest,
              platform: input.platform,
              deviceId: input.deviceId,
              relayDeviceId: input.relayDeviceId,
              categories: [...input.categories],
              registeredAt: timestamp,
              updatedAt: timestamp,
            };
        store.devices = existing
          ? store.devices.map((device) =>
              device.registrationId === existing.registrationId
                ? registration
                : device
            )
          : [...store.devices, registration];
        await persist();
        return redact(registration);
      });
    },

    async list(): Promise<DeviceRegistration[]> {
      return enqueue(async () => {
        await load();
        return store.devices
          .map(redact)
          .sort((left, right) =>
            left.registrationId.localeCompare(right.registrationId)
          );
      });
    },

    async remove(registrationId: string): Promise<boolean> {
      return enqueue(async () => {
        await load();
        const before = store.devices.length;
        store.devices = store.devices.filter(
          (device) => device.registrationId !== registrationId
        );
        if (store.devices.length === before) return false;
        await persist();
        return true;
      });
    },
  };
}

function redact(device: StoredDeviceRegistration): DeviceRegistration {
  const { tokenDigest: _tokenDigest, ...publicRegistration } = device;
  return {
    ...publicRegistration,
    categories: [...publicRegistration.categories],
  };
}

function isStoredDeviceRegistration(
  value: unknown
): value is StoredDeviceRegistration {
  if (!isRecord(value)) return false;
  return (
    typeof value.registrationId === "string" &&
    typeof value.tokenDigest === "string" &&
    typeof value.platform === "string" &&
    (value.deviceId === undefined || typeof value.deviceId === "string") &&
    (value.relayDeviceId === undefined ||
      typeof value.relayDeviceId === "string") &&
    Array.isArray(value.categories) &&
    value.categories.every((category) => typeof category === "string") &&
    typeof value.registeredAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
