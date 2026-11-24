import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type {
  FilesProvider,
  FilesProviderRegistry,
  FilesProviderSnapshot,
} from "../agent/capabilities/pipeline.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";
import { LocalFilesProvider } from "../adapters/pipeline/local-files.ts";
import { OpenListFilesProvider } from "../adapters/pipeline/openlist-files.ts";
import { WebDavFilesProvider } from "../adapters/pipeline/webdav-files.ts";
import { thebeUserConfigPath } from "../adapters/pi/config/user-config.ts";

const BACKEND_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export type StorageBackendType = "openlist" | "local" | "webdav";

export type StorageBackendConfig =
  | {
      id: string;
      type: "openlist";
      baseUrl: string;
      token: string;
    }
  | {
      id: string;
      type: "local";
      roots: string[];
    }
  | {
      id: string;
      type: "webdav";
      url: string;
      username?: string;
      password?: string;
      token?: string;
    };

export type StorageConfigIssue = { id?: string; message: string };

export type LoadedStorageConfig = {
  /** True when config.json has a storage section, even if that section is invalid. */
  configured: boolean;
  source: "config" | "env" | "none";
  defaultId?: string;
  backends: StorageBackendConfig[];
  issues: StorageConfigIssue[];
};

/** What `thebe storage list` and the product HTTP API show: no secrets. */
export type StorageBackendView = {
  id: string;
  type: StorageBackendType;
  baseUrl?: string;
  url?: string;
  roots?: string[];
  username?: string;
  hasToken: boolean;
  hasPassword: boolean;
};

export type StorageConfigView = {
  path: string;
  source: LoadedStorageConfig["source"];
  default?: string;
  backends: StorageBackendView[];
  issues: string[];
};

export function thebeStorageConfigPath(): string {
  return thebeUserConfigPath();
}

/**
 * Read the storage section from the user config. Runtime callers get a lenient
 * result: one broken backend does not prevent the others from being used.
 */
export function loadStorageConfig(
  options: {
    path?: string;
    env?: Record<string, string | undefined>;
  } = {}
): LoadedStorageConfig {
  const path = options.path ?? thebeStorageConfigPath();
  const env = options.env ?? process.env;
  let document: Record<string, unknown>;
  try {
    document = readConfigDocument(path);
  } catch (error) {
    return {
      configured: false,
      source: storageEnvPresent(env) ? "env" : "none",
      backends: [],
      issues: [{ message: messageOf(error) }],
    };
  }
  if (!Object.hasOwn(document, "storage")) {
    const parsed = parseStorageBackends(storageEnvBackends(env), {
      label: "environment",
    });
    return {
      configured: false,
      source: storageEnvPresent(env) ? "env" : "none",
      defaultId: parsed.backends[0]?.id,
      backends: parsed.backends,
      issues: parsed.issues,
    };
  }
  const section = document.storage;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return {
      configured: true,
      source: "config",
      backends: [],
      issues: [{ message: "storage must be an object with a backends array" }],
    };
  }
  const record = section as Record<string, unknown>;
  const parsed = parseStorageBackends(record.backends, {
    label: "storage.backends",
  });
  const issues = [...parsed.issues];
  let defaultId: string | undefined;
  if (record.default !== undefined) {
    if (typeof record.default !== "string" || !record.default.trim()) {
      issues.push({ message: "storage.default must be a backend id" });
    } else if (
      !parsed.backends.some((backend) => backend.id === record.default)
    ) {
      issues.push({
        id: record.default,
        message: `storage.default names an unknown backend: ${record.default}`,
      });
    } else {
      defaultId = record.default;
    }
  }
  defaultId ??= parsed.backends[0]?.id;
  return {
    configured: true,
    source: "config",
    defaultId,
    backends: parsed.backends,
    issues,
  };
}

/** Redacted view of the current configuration, for CLI output and the web UI. */
export function storageConfigView(
  options: {
    path?: string;
    env?: Record<string, string | undefined>;
  } = {}
): StorageConfigView {
  const path = options.path ?? thebeStorageConfigPath();
  const loaded = loadStorageConfig({ ...options, path });
  return {
    path,
    source: loaded.source,
    default: loaded.defaultId,
    backends: loaded.backends.map(backendView),
    issues: loaded.issues.map((issue) => issue.message),
  };
}

/**
 * Validate backend objects and, where a secret is omitted, keep the one from
 * the backend with the same id and type. This is what makes editing a backend
 * from the web UI or `thebe storage add` possible without re-entering secrets.
 */
export function parseStorageBackends(
  raw: unknown,
  options: {
    label?: string;
    previous?: StorageBackendConfig[];
  } = {}
): { backends: StorageBackendConfig[]; issues: StorageConfigIssue[] } {
  const label = options.label ?? "backends";
  const issues: StorageConfigIssue[] = [];
  if (!Array.isArray(raw)) {
    issues.push({ message: `${label} must be an array` });
    return { backends: [], issues };
  }
  const backends: StorageBackendConfig[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const parsed = parseBackend(
      entry,
      `${label}[${index}]`,
      issues,
      options.previous
    );
    if (!parsed) return;
    if (seen.has(parsed.id)) {
      issues.push({
        id: parsed.id,
        message: `${label}[${index}].id is duplicated: ${parsed.id}`,
      });
      return;
    }
    seen.add(parsed.id);
    backends.push(parsed);
  });
  return { backends, issues };
}

/** Persist the whole storage section, preserving every other config key. */
export function saveStorageConfig(
  backends: StorageBackendConfig[],
  options: {
    /** `undefined` keeps the existing default when it still exists; `null` picks the first. */
    defaultId?: string | null;
    path?: string;
  } = {}
): StorageConfigView {
  const path = options.path ?? thebeStorageConfigPath();
  const parsed = parseStorageBackends(backends);
  if (parsed.issues.length > 0) {
    throw new Error(
      `Invalid storage configuration: ${parsed.issues
        .map((issue) => issue.message)
        .join("; ")}`
    );
  }
  const document = readConfigDocument(path);
  const existing = document.storage;
  const existingDefault =
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    typeof (existing as Record<string, unknown>).default === "string"
      ? ((existing as Record<string, unknown>).default as string)
      : undefined;
  const requested =
    options.defaultId === undefined ? existingDefault : options.defaultId;
  const defaultId =
    requested && parsed.backends.some((backend) => backend.id === requested)
      ? requested
      : parsed.backends[0]?.id;
  document.storage = {
    ...(defaultId ? { default: defaultId } : {}),
    backends: parsed.backends,
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomicSync(path, `${JSON.stringify(document, null, 2)}\n`, {
    mode: 0o600,
  });
  return storageConfigView({ path });
}

/** Add or replace one backend, keeping the rest of the configuration intact. */
export function upsertStorageBackend(
  backend: unknown,
  options: {
    makeDefault?: boolean;
    path?: string;
    env?: Record<string, string | undefined>;
  } = {}
): StorageConfigView {
  const path = options.path ?? thebeStorageConfigPath();
  const loaded = loadStorageConfig({ path, env: options.env });
  const parsed = parseStorageBackends([backend], {
    label: "backend",
    previous: loaded.backends,
  });
  if (parsed.issues.length > 0)
    throw new Error(parsed.issues.map((issue) => issue.message).join("; "));
  const added = parsed.backends[0]!;
  const next = [...loaded.backends];
  const index = next.findIndex((existing) => existing.id === added.id);
  if (index >= 0) next[index] = added;
  else next.push(added);
  return saveStorageConfig(next, {
    // Undefined would only preserve a default stored in the file; an environment
    // fallback default lives in the loaded result, so carry it across explicitly.
    defaultId: options.makeDefault ? added.id : loaded.defaultId,
    path,
  });
}

export function removeStorageBackend(
  id: string,
  options: { path?: string } = {}
): StorageConfigView {
  const path = options.path ?? thebeStorageConfigPath();
  const loaded = loadStorageConfig({ path });
  if (!loaded.backends.some((backend) => backend.id === id))
    throw new Error(`unknown storage backend: ${id}`);
  const next = loaded.backends.filter((backend) => backend.id !== id);
  return saveStorageConfig(next, {
    defaultId: next.some((backend) => backend.id === loaded.defaultId)
      ? loaded.defaultId
      : null,
    path,
  });
}

export function setDefaultStorageBackend(
  id: string,
  options: { path?: string } = {}
): StorageConfigView {
  const path = options.path ?? thebeStorageConfigPath();
  const loaded = loadStorageConfig({ path });
  if (!loaded.backends.some((backend) => backend.id === id))
    throw new Error(`unknown storage backend: ${id}`);
  return saveStorageConfig(loaded.backends, { defaultId: id, path });
}

/** Materialize the legacy environment variables as config entries. */
export function importStorageFromEnv(
  options: {
    path?: string;
    env?: Record<string, string | undefined>;
  } = {}
): StorageConfigView {
  const path = options.path ?? thebeStorageConfigPath();
  const env = options.env ?? process.env;
  const loaded = loadStorageConfig({ path, env });
  const imported = parseStorageBackends(storageEnvBackends(env), {
    label: "environment",
  });
  if (imported.issues.length > 0)
    throw new Error(imported.issues.map((issue) => issue.message).join("; "));
  if (imported.backends.length === 0)
    throw new Error(
      "No storage environment variables are set (THEBE_OPENLIST_BASE_URL, THEBE_OPENLIST_TOKEN, THEBE_FILES_LOCAL_ROOTS, THEBE_WEBDAV_URL)"
    );
  const next = [...loaded.backends];
  for (const backend of imported.backends) {
    const index = next.findIndex((existing) => existing.id === backend.id);
    if (index >= 0) next[index] = backend;
    else next.push(backend);
  }
  return saveStorageConfig(next, { path });
}

export function createFilesProvider(
  backend: StorageBackendConfig
): FilesProvider {
  switch (backend.type) {
    case "openlist":
      return new OpenListFilesProvider({
        baseUrl: backend.baseUrl,
        token: backend.token,
        service: backend.id,
      });
    case "local":
      return new LocalFilesProvider({
        roots: backend.roots,
        service: backend.id,
      });
    case "webdav":
      return new WebDavFilesProvider({
        baseUrl: backend.url,
        service: backend.id,
        ...(backend.username ? { username: backend.username } : {}),
        ...(backend.password ? { password: backend.password } : {}),
        ...(backend.token ? { token: backend.token } : {}),
      });
  }
}

/**
 * Read-through registry: every `snapshot()` re-reads config.json, so adding,
 * editing, or removing a backend applies without restarting Core or reopening
 * a session. The file is tiny, and a tool call reads it at most a few times.
 */
export class StorageRegistry implements FilesProviderRegistry {
  private readonly path: string | undefined;
  private readonly env: Record<string, string | undefined> | undefined;

  constructor(
    options: {
      path?: string;
      env?: Record<string, string | undefined>;
    } = {}
  ) {
    this.path = options.path;
    this.env = options.env;
  }

  snapshot(): FilesProviderSnapshot {
    const loaded = loadStorageConfig({
      ...(this.path ? { path: this.path } : {}),
      ...(this.env ? { env: this.env } : {}),
    });
    const providers: FilesProvider[] = [];
    const issues = loaded.issues.map((issue) => issue.message);
    let defaultProvider: FilesProvider | undefined;
    for (const backend of loaded.backends) {
      try {
        const provider = createFilesProvider(backend);
        providers.push(provider);
        if (backend.id === loaded.defaultId) defaultProvider = provider;
      } catch (error) {
        issues.push(`${backend.id}: ${messageOf(error)}`);
      }
    }
    defaultProvider ??= providers[0];
    return {
      providers,
      ...(defaultProvider
        ? { defaultProvider, defaultId: defaultProvider.service }
        : {}),
      source: loaded.source,
      issues,
    };
  }
}

function backendView(backend: StorageBackendConfig): StorageBackendView {
  switch (backend.type) {
    case "openlist":
      return {
        id: backend.id,
        type: backend.type,
        baseUrl: backend.baseUrl,
        hasToken: true,
        hasPassword: false,
      };
    case "local":
      return {
        id: backend.id,
        type: backend.type,
        roots: backend.roots,
        hasToken: false,
        hasPassword: false,
      };
    case "webdav":
      return {
        id: backend.id,
        type: backend.type,
        url: backend.url,
        ...(backend.username ? { username: backend.username } : {}),
        hasToken: Boolean(backend.token),
        hasPassword: Boolean(backend.password),
      };
  }
}

function parseBackend(
  raw: unknown,
  label: string,
  issues: StorageConfigIssue[],
  previous?: StorageBackendConfig[]
): StorageBackendConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    issues.push({ message: `${label} must be an object` });
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!BACKEND_ID.test(id)) {
    issues.push({
      message: `${label}.id must match ${BACKEND_ID.source}`,
    });
    return undefined;
  }
  const before = previous?.find(
    (backend) => backend.id === id && backend.type === record.type
  );
  switch (record.type) {
    case "openlist": {
      const baseUrl = httpUrl(record.baseUrl);
      if (!baseUrl) {
        issues.push({
          id,
          message: `${label}.baseUrl must be an http(s) URL`,
        });
        return undefined;
      }
      const token =
        optionalString(record.token) ??
        (before?.type === "openlist" ? before.token : undefined);
      if (!token) {
        issues.push({ id, message: `${label}.token is required` });
        return undefined;
      }
      return { id, type: "openlist", baseUrl, token };
    }
    case "local": {
      const roots = Array.isArray(record.roots)
        ? [
            ...new Set(
              record.roots
                .map((root) => (typeof root === "string" ? root.trim() : ""))
                .filter(Boolean)
            ),
          ]
        : [];
      if (roots.length === 0) {
        issues.push({
          id,
          message: `${label}.roots must list at least one directory`,
        });
        return undefined;
      }
      const relative = roots.find((root) => !isAbsolute(root));
      if (relative) {
        issues.push({
          id,
          message: `${label}.roots must be absolute paths: ${relative}`,
        });
        return undefined;
      }
      return { id, type: "local", roots };
    }
    case "webdav": {
      const url = httpUrl(optionalString(record.url) ?? record.baseUrl);
      if (!url) {
        issues.push({ id, message: `${label}.url must be an http(s) URL` });
        return undefined;
      }
      const prior = before?.type === "webdav" ? before : undefined;
      const username = optionalString(record.username) ?? prior?.username;
      const password = optionalString(record.password) ?? prior?.password;
      const token = optionalString(record.token) ?? prior?.token;
      return {
        id,
        type: "webdav",
        url,
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        ...(token ? { token } : {}),
      };
    }
    default:
      issues.push({
        id,
        message: `${label}.type must be openlist, local, or webdav`,
      });
      return undefined;
  }
}

/** Raw env entries; parsed through the same validator as the config file. */
function storageEnvBackends(
  env: Record<string, string | undefined>
): unknown[] {
  const pick = (...values: Array<string | undefined>) =>
    values.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
  const backends: unknown[] = [];
  const openlistUrl = pick(env.THEBE_OPENLIST_BASE_URL, env.OPENLIST_BASE_URL);
  const openlistToken = pick(env.THEBE_OPENLIST_TOKEN, env.OPENLIST_TOKEN);
  if (openlistUrl || openlistToken) {
    backends.push({
      id: "openlist",
      type: "openlist",
      baseUrl: openlistUrl,
      token: openlistToken,
    });
  }
  const roots = pick(env.THEBE_FILES_LOCAL_ROOTS, env.THEBE_LOCAL_FILES_ROOTS);
  if (roots) {
    backends.push({
      id: "local",
      type: "local",
      roots: roots.split(",").map((root) => root.trim()),
    });
  }
  const webdavUrl = pick(env.THEBE_WEBDAV_URL, env.WEBDAV_URL);
  const webdavUsername = pick(env.THEBE_WEBDAV_USERNAME, env.WEBDAV_USERNAME);
  const webdavPassword = pick(env.THEBE_WEBDAV_PASSWORD, env.WEBDAV_PASSWORD);
  const webdavToken = pick(env.THEBE_WEBDAV_TOKEN, env.WEBDAV_TOKEN);
  if (webdavUrl || webdavUsername || webdavPassword || webdavToken) {
    backends.push({
      id: "webdav",
      type: "webdav",
      url: webdavUrl,
      username: webdavUsername,
      password: webdavPassword,
      token: webdavToken,
    });
  }
  return backends;
}

function storageEnvPresent(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.THEBE_OPENLIST_BASE_URL ||
    env.OPENLIST_BASE_URL ||
    env.THEBE_OPENLIST_TOKEN ||
    env.OPENLIST_TOKEN ||
    env.THEBE_FILES_LOCAL_ROOTS ||
    env.THEBE_LOCAL_FILES_ROOTS ||
    env.THEBE_WEBDAV_URL ||
    env.WEBDAV_URL ||
    env.THEBE_WEBDAV_USERNAME ||
    env.WEBDAV_USERNAME ||
    env.THEBE_WEBDAV_PASSWORD ||
    env.WEBDAV_PASSWORD ||
    env.THEBE_WEBDAV_TOKEN ||
    env.WEBDAV_TOKEN
  );
}

function readConfigDocument(path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${path} is not valid JSON; fix it before changing storage configuration`
    );
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
