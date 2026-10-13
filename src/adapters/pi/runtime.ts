import { existsSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AgentRuntime } from "../../agent/runtime/interface.ts";
import { PI_RUNTIME_ID } from "../../agent/runtime/interface.ts";
import { createPiRuntimeAuth } from "./auth/oauth.ts";
import {
  ANTIGRAVITY_PROVIDER_ID,
  AntigravityCredentialStore,
  createAntigravityAuth,
  withAntigravityAuth,
} from "../google/antigravity.ts";
import {
  createAntigravityProvider,
  loadAntigravityPiAi,
} from "../google/antigravity-provider.ts";
import {
  modelKey,
  resolveModelRef as resolvePiModel,
  toRuntimeModel,
  type PiModelShape,
} from "./config/model-shape.ts";
import { syncAgentModelsFile } from "./config/agent-dir.ts";
import { createProviderConfigurationStore } from "./config/provider-store.ts";
import { thebeUserConfigPath } from "./config/user-config.ts";
import { discoverProviderModels } from "./config/provider-discovery.ts";
import { loadPiSdk, piAiDistUrl, type PiSdk } from "./sdk/load-pi.ts";
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
  options: PiCodingAgentRuntimeOptions = {}
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
      authPath: options.agentDir ? `${options.agentDir}/auth.json` : undefined,
      modelsPath: options.agentDir
        ? `${options.agentDir}/models.json`
        : undefined,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }));

  if (options.apiKey) {
    await modelRuntime.setRuntimeApiKey(
      options.apiKey.providerId,
      options.apiKey.key
    );
  }

  function resolveModelRef(
    providerId: string,
    modelId: string
  ): PiModelShape | undefined {
    return resolvePiModel(
      (p, m) => modelRuntime.getModel(p, m),
      providerId,
      modelId
    );
  }

  const live = new Map<string, PiSession>();
  const backgroundTasks = new Map<string, BackgroundTaskRegistry>();
  const backgroundTaskDir = options.sessionDir
    ? join(options.sessionDir, "background-tasks")
    : undefined;
  let quiesced = false;
  const livenessRegistry = new Map<string, () => boolean>();
  // Antigravity keeps its own credential file next to Pi's auth.json so an agent
  // directory backup carries the Google session too.
  const antigravityAgentDir =
    options.agentDir ?? join(process.env.HOME ?? ".", ".thebe", "agent");
  const antigravityStore = new AntigravityCredentialStore(
    join(antigravityAgentDir, "antigravity.json")
  );
  // Escape hatch for local proxies and tests; defaults to Google's endpoint.
  const antigravityEndpoint =
    process.env.THEBE_ANTIGRAVITY_ENDPOINT?.trim() || undefined;
  const antigravity = createAntigravityAuth({
    store: antigravityStore,
    endpoint: antigravityEndpoint,
  });
  const auth = withAntigravityAuth(
    createPiRuntimeAuth(modelRuntime),
    antigravity
  );
  const providerConfigurations = createProviderConfigurationStore(
    antigravityAgentDir,
    thebeUserConfigPath()
  );
  // Pi dropped its built-in Antigravity provider, so Core registers one on the
  // same ModelRuntime the sessions use: `provider: "google-antigravity"` then
  // resolves, lists, and streams like any Pi provider, with auth and models
  // coming from Core's Google session.
  const antigravityProvider = createAntigravityProvider({
    piAi: await loadAntigravityPiAi(piAiDistUrl),
    store: antigravityStore,
    endpoint: antigravityEndpoint,
    credential: (refreshOptions) =>
      antigravity.credential(ANTIGRAVITY_PROVIDER_ID, refreshOptions),
    listModels: async () =>
      (await antigravity.models(ANTIGRAVITY_PROVIDER_ID)).map((model) => ({
        id: model.modelId,
        displayName: model.displayName,
      })),
  });
  modelRuntime.registerNativeProvider(
    antigravityProvider as Parameters<
      InstanceType<PiSdk["ModelRuntime"]>["registerNativeProvider"]
    >[0]
  );

  function backgroundTasksFor(
    runtimeSessionId: string
  ): BackgroundTaskRegistry {
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
        providerId
      )) as PiModelShape[];
      return new Set(available.map(modelKey));
    } catch {
      return new Set();
    }
  }

  async function open(
    create: Parameters<AgentRuntime["createSession"]>[0],
    sessionManager: InstanceType<PiSdk["SessionManager"]>
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
    async loadSkillDirectory(directory) {
      return sdk
        .loadSkillsFromDir({ dir: directory, source: "path" })
        .skills.map(
          ({
            name,
            description,
            filePath,
          }: {
            name: string;
            description: string;
            filePath: string;
          }) => ({ name, description, filePath })
        );
    },
    async createSession(create) {
      const sessionManager =
        (create.inMemory ?? inMemory)
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
          (row: { id: string; path: string }) => row.id === runtimeSessionId
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
          backgroundTasksFor(runtimeSessionId).wrap(
            sdk.createLocalBashOperations()
          )
        );
      }
      let info: { id: string; path: string } | undefined;
      if (!inMemory) {
        const listed = (await sdk.SessionManager.list(
          create.cwd ?? cwd,
          options.sessionDir
        )) as Array<{ id: string; path: string }>;
        info = listed.find((row) => row.id === runtimeSessionId);
        if (!info) {
          const all = (await sdk.SessionManager.listAll(
            options.sessionDir
          )) as Array<{ id: string; path: string }>;
          info = all.find((row) => row.id === runtimeSessionId);
        }
      }
      if (info) {
        return open(
          create,
          sdk.SessionManager.open(info.path, options.sessionDir)
        );
      }
      const sessionManager = inMemory
        ? sdk.SessionManager.inMemory(create.cwd ?? cwd, {
            id: runtimeSessionId,
          })
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
    async listBackgroundTasksForSession(runtimeSessionId: string) {
      return backgroundTasksFor(runtimeSessionId).list();
    },
    async listModels(query?: {
      all?: boolean;
      providerId?: string;
      refresh?: boolean;
    }) {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      if (
        query?.refresh &&
        query.providerId &&
        query.providerId !== antigravity.providerId
      ) {
        const providerId = query.providerId;
        const sample = modelRuntime.getModels(providerId)[0];
        const saved = await providerConfigurations.get(providerId);
        const api = saved?.api ?? sample?.api;
        const baseUrl = saved?.baseUrl ?? sample?.baseUrl;
        if (
          !baseUrl ||
          !api ||
          ![
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
            "google-generative-ai",
          ].includes(api)
        ) {
          throw new Error(
            "This provider does not expose a supported model discovery endpoint"
          );
        }
        const configuration = saved ?? {
          providerId,
          baseUrl,
          api: api as import("../../agent/runtime/interface.ts").RuntimeProviderConfiguration["api"],
          models: (modelRuntime.getModels(providerId) as PiModelShape[]).map(
            (model) => ({
              id: model.id,
              name: model.name,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              reasoning: model.reasoning,
            })
          ),
        };
        const resolved = await modelRuntime.getAuth(providerId);
        const discovered = await discoverProviderModels(
          configuration,
          resolved?.auth ?? {}
        );
        // An empty service list remains empty; never substitute the shared catalogue.
        if (!discovered.length) return [];
        const discoveredIds = new Set(discovered.map((model) => model.id));
        // Explicitly configured aliases can be callable even when the service
        // omits them from discovery. Retain them for existing sessions.
        await providerConfigurations.save({
          ...configuration,
          models: [
            ...configuration.models.filter(
              (model) => !discoveredIds.has(model.id)
            ),
            ...discovered,
          ],
        });
        await modelRuntime.refresh({ allowNetwork: false });
        const keys = await availableKeys(providerId);
        return discovered.map((model) => {
          const registered = modelRuntime.getModel(providerId, model.id);
          return toRuntimeModel(
            registered ?? { ...model, provider: providerId },
            keys
          );
        });
      }
      if (query?.providerId === antigravity.providerId) {
        // An explicit model listing is the one place Core may reach the network
        // for models: it refreshes the account's real Antigravity list (login,
        // app model picker, TUI "fetch models") and caches it in Pi's store.
        // PI_OFFLINE keeps even this offline.
        await modelRuntime
          .refresh({
            allowNetwork: process.env.PI_OFFLINE === undefined,
            providers: [antigravity.providerId],
          })
          .catch(() => {});
      }
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
      return list;
    },
    async listAvailableModels(query?: { providerId?: string }) {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      const available = (await modelRuntime.getAvailable(
        query?.providerId
      )) as PiModelShape[];
      const keys = new Set(available.map(modelKey));
      const list = available.map((model) => toRuntimeModel(model, keys));
      return list;
    },
    async listProviders() {
      await modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
      return auth.listProviders();
    },
    async providerConfiguration(providerId) {
      return providerConfigurations.get(providerId);
    },
    async saveProviderConfiguration(configuration, apiKey) {
      await providerConfigurations.save(configuration);
      await modelRuntime.refresh({ allowNetwork: false });
      if (apiKey?.trim())
        await auth.setApiKey(configuration.providerId, apiKey.trim());
      await modelRuntime.refresh({ allowNetwork: false });
    },
    async deleteProviderConfiguration(providerId) {
      await providerConfigurations.delete(providerId);
      await auth.logout(providerId);
      await modelRuntime.refresh({ allowNetwork: false });
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
          backgroundTasksFor(session.sessionId).wrap(
            sdk.createLocalBashOperations()
          )
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
          : await sdk.SessionManager.list(
              create.cwd ?? cwd,
              options.sessionDir
            );
        const info = listed.find(
          (row: { id: string; path: string }) => row.id === runtimeSessionId
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
          : await sdk.SessionManager.list(
              create.cwd ?? cwd,
              options.sessionDir
            );
        const info = listed.find(
          (row: { id: string; path: string }) => row.id === runtimeSessionId
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
        return open(create, sdk.SessionManager.open(path, options.sessionDir));
      }
      const leaf = fork?.atEntryId ?? parent.sessionManager.getLeafId();
      if (!leaf) {
        throw new Error("cannot fork empty session");
      }
      const path = parent.sessionManager.createBranchedSession(leaf);
      if (path) {
        return open(create, sdk.SessionManager.open(path, options.sessionDir));
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
    registerSessionLiveness(
      sessionId: string,
      isActive: () => boolean
    ): () => void {
      livenessRegistry.set(sessionId, isActive);
      return () => {
        livenessRegistry.delete(sessionId);
      };
    },
    reapInactiveSessions(): number {
      let reaped = 0;
      for (const [sessionId, isActive] of livenessRegistry.entries()) {
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
