import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AgentRuntime } from "../../agent/runtime/interface.ts";
import { PI_RUNTIME_ID } from "../../agent/runtime/interface.ts";
import { createPiRuntimeAuth } from "./auth/oauth.ts";
import {
  ensureOpencodeFreeAlias,
  modelKey,
  resolveModelRef as resolvePiModel,
  toRuntimeModel,
  type PiModelShape,
} from "./config/model-shape.ts";
import { syncAgentModelsFile } from "./config/agent-dir.ts";
import { loadPiSdk, type PiSdk } from "./sdk/load-pi.ts";
import { openPiSession, toolControllersFor } from "./session/open-session.ts";
import { wrapSession as wrapPiSession } from "./session/wrap-session.ts";
import type { PiSession } from "./session/pi-session.ts";
import {
  createBackgroundTaskRegistry,
  type BackgroundTaskRegistry,
} from "./session/background-tasks.ts";

export { sanitizeBashEnv } from "../../agent/security/process-env.ts";

export type PiCodingAgentRuntimeOptions = {
  cwd?: string;
  agentDir?: string;
  sessionDir?: string;
  inMemory?: boolean;
  modelRuntime?: InstanceType<PiSdk["ModelRuntime"]>;
  model?: unknown;
  apiKey?: { providerId: string; key: string };
};

export async function createPiCodingAgentRuntime(
  options: PiCodingAgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const sdk = await loadPiSdk();
  const cwd = options.cwd ?? process.cwd();
  const inMemory = options.inMemory ?? !options.sessionDir;
  if (options.sessionDir) {
    mkdirSync(options.sessionDir, { recursive: true });
  }
  if (options.agentDir) {
    syncAgentModelsFile(options.agentDir);
  }

  const modelRuntime =
    options.modelRuntime ??
    (await sdk.ModelRuntime.create({
      authPath: options.agentDir
        ? `${options.agentDir}/auth.json`
        : undefined,
      modelsPath: options.agentDir
        ? `${options.agentDir}/models.json`
        : undefined,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }));

  if (options.apiKey) {
    await modelRuntime.setRuntimeApiKey(
      options.apiKey.providerId,
      options.apiKey.key,
    );
  }

  function resolveModelRef(
    providerId: string,
    modelId: string,
  ): PiModelShape | undefined {
    return resolvePiModel(
      (p, m) => modelRuntime.getModel(p, m),
      providerId,
      modelId,
    );
  }

  const live = new Map<string, PiSession>();
  const backgroundTasks = new Map<string, BackgroundTaskRegistry>();
  const backgroundTaskDir = options.sessionDir
    ? join(options.sessionDir, "background-tasks")
    : undefined;
  let quiesced = false;
  const livenessRegistry = new Map<string, () => boolean>();
  const auth = createPiRuntimeAuth(modelRuntime);

  function backgroundTasksFor(runtimeSessionId: string): BackgroundTaskRegistry {
    let registry = backgroundTasks.get(runtimeSessionId);
    if (!registry) {
      registry = createBackgroundTaskRegistry({
        dir: backgroundTaskDir,
        sessionId: runtimeSessionId,
      });
      backgroundTasks.set(runtimeSessionId, registry);
    }
    return registry;
  }

  async function availableKeys(providerId?: string): Promise<Set<string>> {
    try {
      const available = (await modelRuntime.getAvailable(
        providerId,
      )) as PiModelShape[];
      return new Set(available.map(modelKey));
    } catch {
      return new Set();
    }
  }

  async function open(
    create: Parameters<AgentRuntime["createSession"]>[0],
    sessionManager: InstanceType<PiSdk["SessionManager"]>,
  ) {
    return openPiSession(sdk, {
      create,
      sessionManager,
      cwd,
      agentDir: options.agentDir,
      modelRuntime,
      defaultModel: options.model,
      resolveModelRef,
      live,
      backgroundTasks: backgroundTasksFor(sessionManager.getSessionId()),
    });
  }

  return {
    runtimeId: PI_RUNTIME_ID,
    async createSession(create) {
      const sessionManager = (create.inMemory ?? inMemory)
        ? sdk.SessionManager.inMemory(create.cwd ?? cwd)
        : sdk.SessionManager.create(create.cwd ?? cwd, options.sessionDir);
      const session = await open(create, sessionManager);
      if (create.inMemory) {
        const dispose = session.dispose.bind(session);
        session.dispose = () => {
          dispose();
          live.delete(session.runtimeSessionId);
        };
      }
      return session;
    },
    async deleteSession(runtimeSessionId) {
      const active = live.get(runtimeSessionId);
      let sessionPath = active?.sessionManager.getSessionFile?.();
      if (!sessionPath && !inMemory) {
        const listed = await sdk.SessionManager.list(cwd, options.sessionDir);
        sessionPath = listed.find(
          (row: { id: string; path: string }) => row.id === runtimeSessionId,
        )?.path;
      }
      active?.dispose();
      live.delete(runtimeSessionId);
      livenessRegistry.delete(runtimeSessionId);
      if (!sessionPath || !existsSync(sessionPath)) return;

      const trashArgs = sessionPath.startsWith("-")
        ? ["--", sessionPath]
        : [sessionPath];
      const trashed = spawnSync("trash", trashArgs, { encoding: "utf8" });
      if (trashed.status === 0 || !existsSync(sessionPath)) return;
      await unlink(sessionPath);
    },
    async resumeSession(runtimeSessionId, create) {
      const existing = live.get(runtimeSessionId);
      if (existing) {
        return wrapPiSession(
          existing,
          create,
          undefined,
          resolveModelRef,
          async () => {
            await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
          },
          toolControllersFor(existing),
          backgroundTasksFor(runtimeSessionId),
          backgroundTasksFor(runtimeSessionId).wrap(sdk.createLocalBashOperations()),
        );
      }
      let info: { id: string; path: string } | undefined;
      if (!inMemory) {
        const listed = (await sdk.SessionManager.list(
          create.cwd ?? cwd,
          options.sessionDir,
        )) as Array<{ id: string; path: string }>;
        info = listed.find((row) => row.id === runtimeSessionId);
        if (!info) {
          const all = (await sdk.SessionManager.listAll(
            options.sessionDir,
          )) as Array<{ id: string; path: string }>;
          info = all.find((row) => row.id === runtimeSessionId);
        }
      }
      if (info) {
        return open(
          create,
          sdk.SessionManager.open(info.path, options.sessionDir),
        );
      }
      const sessionManager = inMemory
        ? sdk.SessionManager.inMemory(create.cwd ?? cwd, { id: runtimeSessionId })
        : sdk.SessionManager.create(create.cwd ?? cwd, options.sessionDir, {
            id: runtimeSessionId,
          });
      return open(create, sessionManager);
    },
    async listSessions() {
      if (inMemory) {
        return [...live.keys()].map((runtimeSessionId) => ({
          runtimeSessionId,
        }));
      }
      const listed = await sdk.SessionManager.list(cwd, options.sessionDir);
      return listed.map((row: { id: string }) => ({
        runtimeSessionId: row.id,
      }));
    },
    async listModels(query?: { all?: boolean; providerId?: string }) {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      const models = (
        query?.providerId
          ? modelRuntime.getModels(query.providerId)
          : modelRuntime.getModels()
      ) as PiModelShape[];
      const keys = await availableKeys(query?.providerId);
      const filtered =
        query?.all === false
          ? models.filter((model) => keys.has(modelKey(model)))
          : models;
      const list = filtered.map((model) => toRuntimeModel(model, keys));
      if (!query?.providerId || query.providerId === "opencode") {
        ensureOpencodeFreeAlias(list);
      }
      return list;
    },
    async listAvailableModels(query?: { providerId?: string }) {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      const available = (await modelRuntime.getAvailable(
        query?.providerId,
      )) as PiModelShape[];
      const keys = new Set(available.map(modelKey));
      const list = available.map((model) => toRuntimeModel(model, keys));
      if (!query?.providerId || query.providerId === "opencode") {
        ensureOpencodeFreeAlias(list);
      }
      return list;
    },
    async listProviders() {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      return auth.listProviders();
    },
    async forkSession(runtimeSessionId, create, fork) {
      const parent = live.get(runtimeSessionId);
      const wrapLive = (session: PiSession) =>
        wrapPiSession(
          session,
          create,
          undefined,
          resolveModelRef,
          async () => {
            await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
          },
          toolControllersFor(session),
          backgroundTasksFor(session.sessionId),
          backgroundTasksFor(session.sessionId).wrap(sdk.createLocalBashOperations()),
        );
      if (fork?.mode === "branch_in_place") {
        if (parent) {
          if (fork.atEntryId) {
            await parent.navigateTree(fork.atEntryId);
          }
          return wrapLive(parent);
        }
        const listed = inMemory
          ? []
          : await sdk.SessionManager.list(create.cwd ?? cwd, options.sessionDir);
        const info = listed.find(
          (row: { id: string; path: string }) => row.id === runtimeSessionId,
        );
        if (!info) {
          throw new Error(`unknown runtime session: ${runtimeSessionId}`);
        }
        const manager = sdk.SessionManager.open(info.path, options.sessionDir);
        if (fork.atEntryId) {
          await manager.navigateTree?.(fork.atEntryId);
        }
        return open(create, manager);
      }
      if (!parent) {
        const listed = inMemory
          ? []
          : await sdk.SessionManager.list(create.cwd ?? cwd, options.sessionDir);
        const info = listed.find(
          (row: { id: string; path: string }) => row.id === runtimeSessionId,
        );
        if (!info) {
          throw new Error(`unknown runtime session: ${runtimeSessionId}`);
        }
        const opened = sdk.SessionManager.open(info.path, options.sessionDir);
        const leaf = fork?.atEntryId ?? opened.getLeafId();
        if (!leaf) {
          throw new Error("cannot fork empty session");
        }
        const path = opened.createBranchedSession(leaf);
        if (!path) {
          throw new Error("Pi fork did not persist a child session");
        }
        return open(
          create,
          sdk.SessionManager.open(path, options.sessionDir),
        );
      }
      const leaf = fork?.atEntryId ?? parent.sessionManager.getLeafId();
      if (!leaf) {
        throw new Error("cannot fork empty session");
      }
      const path = parent.sessionManager.createBranchedSession(leaf);
      if (path) {
        return open(
          create,
          sdk.SessionManager.open(path, options.sessionDir),
        );
      }
      const child = sdk.SessionManager.inMemory(create.cwd ?? cwd, {
        parentSession: runtimeSessionId,
      });
      for (const entry of parent.sessionManager.getEntries()) {
        if (entry.type === "message") {
          child.appendMessage(entry.message);
        }
      }
      return open(create, child);
    },
    auth() {
      return auth;
    },
    async quiesce(): Promise<void> {
      quiesced = true;
    },
    async unquiesce(): Promise<void> {
      quiesced = false;
    },
    isQuiesced(): boolean {
      return quiesced;
    },
    registerSessionLiveness(sessionId: string, isActive: () => boolean): () => void {
      livenessRegistry.set(sessionId, isActive);
      return () => {
        livenessRegistry.delete(sessionId);
      };
    },
    reapInactiveSessions(): number {
      let reaped = 0;
      for (const [sessionId, isActive] of [...livenessRegistry.entries()]) {
        if (isActive()) {
          continue;
        }
        livenessRegistry.delete(sessionId);
        const session = live.get(sessionId);
        live.delete(sessionId);
        session?.dispose();
        reaped += 1;
      }
      return reaped;
    },
  };
}
