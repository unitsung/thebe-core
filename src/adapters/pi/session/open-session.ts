import { createStaleToolResultExtension } from "./stale-tool-results.ts";
import { createRelevantToolSearchExtension } from "./tool-search.ts";
import { randomUUID } from "node:crypto";
import type {
  CreateRuntimeSessionOptions,
  NormalizedEvent,
  PermissionRequest,
  RuntimeModelRef,
  RuntimeSession,
} from "../../../agent/runtime/interface.ts";
import { PI_BUILTIN_TOOLS } from "../../../agent/runtime/interface.ts";
import { httpError } from "../../../agent/types.ts";
import {
  permissionRisk,
  summarizeArgs,
} from "../../../agent/security/redaction.ts";
import { createExplicitResourceLoader } from "../sdk/explicit-loader.ts";
import type { PiSdk } from "../sdk/load-pi.ts";
import { sanitizeBashEnv } from "../../../agent/security/process-env.ts";
import { sandboxedCommand } from "../../../agent/security/command-sandbox.ts";
import { resolveHostSecurity } from "../../../agent/security/host-security.ts";
import { createGondolinBashOperations } from "../../gondolin/bash-operations.ts";
import { loadThebeUserConfig } from "../config/user-config.ts";
import type { PiSession } from "./pi-session.ts";
import {
  createMcpGuardExtension,
  createMcpTransportFactory,
  toPiMcpConfig,
} from "./mcp-extension.ts";
import { toPiTool } from "./pi-tools.ts";
import { wrapSession as wrapPiSession } from "./wrap-session.ts";
import type { PiModelShape } from "../config/model-shape.ts";
import type { BackgroundTaskRegistry } from "./background-tasks.ts";

const sessionToolControllers = new WeakMap<
  object,
  Map<string, AbortController>
>();

export function toolControllersFor(
  session: object
): Map<string, AbortController> {
  let map = sessionToolControllers.get(session);
  if (!map) {
    map = new Map();
    sessionToolControllers.set(session, map);
  }
  return map;
}

function abortablePiTool<T extends { execute?: (...args: never[]) => unknown }>(
  tool: T,
  controllers: Map<string, AbortController>
): T {
  const original = tool.execute;
  if (typeof original !== "function") {
    return tool;
  }
  return {
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal
    ) => {
      const ac = new AbortController();
      controllers.set(toolCallId, ac);
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await (
          original as (
            toolCallId: string,
            params: unknown,
            signal?: AbortSignal
          ) => Promise<unknown>
        )(toolCallId, params, ac.signal);
      } finally {
        signal?.removeEventListener("abort", onAbort);
        controllers.delete(toolCallId);
      }
    },
  };
}

export async function openPiSession(
  sdk: PiSdk,
  args: {
    create: CreateRuntimeSessionOptions;
    sessionManager: InstanceType<PiSdk["SessionManager"]>;
    cwd: string;
    agentDir?: string;
    modelRuntime: InstanceType<PiSdk["ModelRuntime"]>;
    defaultModel?: unknown;
    resolveModelRef: (
      providerId: string,
      modelId: string
    ) => PiModelShape | undefined;
    live: Map<string, PiSession>;
    backgroundTasks: BackgroundTaskRegistry;
  }
): Promise<RuntimeSession> {
  const { create, sessionManager, cwd, live, backgroundTasks } = args;
  const tools = [
    ...(create.builtinTools ?? PI_BUILTIN_TOOLS),
    ...create.customTools.map((tool) => tool.name),
  ];
  const hasMcp = Boolean(create.mcp);
  const hasDiscovery = hasMcp || create.customTools.length > 0;
  const listeners = new Set<(event: NormalizedEvent) => void>();
  const permissionHandler = create.permissionHandler
    ? {
        async preflight(request: PermissionRequest) {
          return (
            (await create.permissionHandler!.preflight?.(request)) ?? "ask"
          );
        },
        async request(
          request: Parameters<
            NonNullable<
              CreateRuntimeSessionOptions["permissionHandler"]
            >["request"]
          >[0]
        ) {
          for (const listener of listeners) {
            listener({
              type: "permission_requested",
              permissionId: request.permissionId,
              toolName: request.toolName,
              toolCallId: request.toolCallId,
              argsSummary: request.argsSummary,
              risk: request.risk,
            });
          }
          return create.permissionHandler!.request(request);
        },
      }
    : undefined;
  async function loadSessionExtensions() {
    const extensionRuntime = sdk.createExtensionRuntime();
    let permissionExtension: unknown[] = [];
    if (permissionHandler) {
      try {
        permissionExtension = [
          await sdk.loadExtensionFromFactory(
            (pi: {
              on: (
                event: string,
                handler: (payload: {
                  toolName: string;
                  toolCallId?: string;
                  input?: unknown;
                }) => Promise<unknown>
              ) => void;
            }) => {
              const required = new Set(create.toolsRequiringApproval ?? []);
              pi.on("tool_call", async (event) => {
                if (!required.has(event.toolName)) {
                  return undefined;
                }
                const permissionId = randomUUID();
                const request = {
                  permissionId,
                  toolName: event.toolName,
                  toolCallId: event.toolCallId ?? permissionId,
                  args: event.input,
                  argsSummary: summarizeArgs(event.input),
                  risk: permissionRisk(event.toolName),
                };
                const preflight = await permissionHandler.preflight(request);
                if (preflight === "allow") {
                  return undefined;
                }
                if (preflight === "deny") {
                  return { block: true, reason: "denied by policy" };
                }
                const decision = await permissionHandler.request(request);
                if (decision !== "allow") {
                  return { block: true, reason: "denied by user" };
                }
                return undefined;
              });
            },
            create.cwd ?? cwd,
            sdk.createEventBus(),
            extensionRuntime,
            "thebe://permission-gate"
          ),
        ];
      } catch (error) {
        throw new Error(
          `failed to install permission gate: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (create.mcp) {
      const mcp = create.mcp;
      const load = (
        factory: Parameters<typeof sdk.loadExtensionFromFactory>[0],
        path: string
      ) =>
        sdk.loadExtensionFromFactory(
          factory,
          create.cwd ?? cwd,
          sdk.createEventBus(),
          extensionRuntime,
          path
        );
      permissionExtension.push(
        await load(
          createMcpGuardExtension(sdk, mcp, permissionHandler) as never,
          "thebe://mcp-guard"
        ),
        await load(
          sdk.createMcpExtension({
            loadConfig: () => toPiMcpConfig(mcp.servers()),
            createTransport: createMcpTransportFactory(sdk),
          }),
          "thebe://mcp"
        ),
        // Scripts run in Pi's QuickJS sandbox and reach tools only through the guarded pipeline.
        await load(
          sdk.createCodemodeExtension({ mode: "on", models: false }),
          "thebe://codemode"
        )
      );
    }
    if (hasDiscovery) {
      permissionExtension.push(
        await sdk.loadExtensionFromFactory(
          createRelevantToolSearchExtension() as never,
          create.cwd ?? cwd,
          sdk.createEventBus(),
          extensionRuntime,
          "thebe://tool-discovery"
        )
      );
    }
    // Results the model has already answered from are resent on every later call; shorten them.
    permissionExtension.push(
      await sdk.loadExtensionFromFactory(
        createStaleToolResultExtension() as never,
        create.cwd ?? cwd,
        sdk.createEventBus(),
        extensionRuntime,
        "thebe://tool-result-hygiene"
      )
    );
    return { extensions: permissionExtension, runtime: extensionRuntime };
  }
  const loadedExtensions = await loadSessionExtensions();
  const resourceLoader = createExplicitResourceLoader({
    systemPrompt: create.systemPrompt ?? "You are Thebe.",
    enabledResources: create.enabledResources,
    sdk,
    extensions: loadedExtensions.extensions,
    extensionRuntime: loadedExtensions.runtime,
    reloadExtensions: loadSessionExtensions,
  });
  const autoCompact =
    create.autoCompact ?? loadThebeUserConfig().autoCompact ?? true;
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultProjectTrust: "always",
    retry: { enabled: false, maxRetries: 0 },
    compaction: { enabled: autoCompact },
    ...(hasDiscovery
      ? {
          defaultTools: [
            ...(create.builtinTools ?? PI_BUILTIN_TOOLS),
            "tool_search",
          ],
        }
      : {}),
  });
  settingsManager.setDefaultProjectTrust?.("always");
  const controllers = new Map<string, AbortController>();
  const sandbox = resolveHostSecurity();
  const fullAccessActive = () => create.fullAccess?.() === true;
  const workspacePath = create.cwd ?? cwd;
  const baseBashOperations = backgroundTasks.wrap(
    sdk.createLocalBashOperations()
  );
  const gondolinBash =
    !fullAccessActive() && sandbox.sandboxMode === "gondolin"
      ? createGondolinBashOperations({
          workspacePath,
          allowedHosts: sandbox.sandboxNetwork ? undefined : [],
        })
      : undefined;
  const bashOperations = gondolinBash ?? baseBashOperations;
  // `THEBE_SANDBOX=bwrap` jails bash in a bubblewrap namespace: read-only host,
  // ephemeral /tmp, one writable workspace. Off by default (and it degrades to
  // the raw command when bwrap is missing, e.g. on macOS).
  const sanitizedBash = sdk.createBashTool(workspacePath, {
    operations: bashOperations,
    spawnHook: (ctx: {
      command: string;
      cwd: string;
      env: Record<string, string | undefined>;
    }) => {
      // bypassPermissions lifts the sandbox for this session only; it is read per
      // command so a mid-conversation change takes effect at once.
      const wrapped = sandboxedCommand(
        ctx.command,
        fullAccessActive() ? "off" : sandbox.sandboxMode,
        workspacePath,
        sandbox.sandboxNetwork
      );
      // bwrap re-enters the workspace with --chdir, so ctx.cwd stays the
      // tool's own working directory.
      return {
        ...ctx,
        command: wrapped.command,
        env: sanitizeBashEnv(ctx.env),
      };
    },
  });
  // `executeBash` (a command the user typed) runs through Pi's session, not through the bash tool
  // above, so it never saw that tool's spawn hook: no sandbox wrapper and the whole process
  // environment, including Core's own token. It now crosses the same two filters as the tool.
  const guardedBashOperations: typeof bashOperations = {
    exec(command, cwd, execOptions) {
      const wrapped = sandboxedCommand(
        command,
        fullAccessActive() ? "off" : sandbox.sandboxMode,
        workspacePath,
        sandbox.sandboxNetwork
      );
      return bashOperations.exec(wrapped.command, cwd, {
        ...execOptions,
        env: sanitizeBashEnv({
          ...process.env,
          ...execOptions.env,
        }) as NodeJS.ProcessEnv,
      });
    },
  };
  const piCustomTools = [
    ...create.customTools.map((tool) =>
      abortablePiTool(toPiTool(sdk, tool), controllers)
    ),
    ...(tools.includes("bash")
      ? [abortablePiTool(sanitizedBash, controllers)]
      : []),
  ];

  const requestedModel =
    create.model ??
    (typeof args.defaultModel === "object" &&
    args.defaultModel &&
    "providerId" in args.defaultModel
      ? (args.defaultModel as RuntimeModelRef)
      : undefined);
  let resolvedModel: unknown = requestedModel
    ? args.resolveModelRef(requestedModel.providerId, requestedModel.modelId)
    : undefined;
  if (requestedModel && !resolvedModel) {
    await args.modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
    resolvedModel = args.resolveModelRef(
      requestedModel.providerId,
      requestedModel.modelId
    );
  }
  if (!resolvedModel && !requestedModel) {
    resolvedModel = (await args.modelRuntime.getAvailable())[0];
  }
  if (!resolvedModel) {
    // A missing setup is the caller's to fix, not a server fault, so it is not a 500.
    throw requestedModel
      ? httpError(
          404,
          `Model ${requestedModel.providerId}/${requestedModel.modelId} is not available. Pick one from the configured providers.`,
          "model_not_found"
        )
      : httpError(
          409,
          "No configured model is available. Configure a provider and select a model.",
          "no_model_configured"
        );
  }

  const { session } = await sdk.createAgentSession({
    cwd: create.cwd ?? cwd,
    agentDir: args.agentDir,
    modelRuntime: args.modelRuntime,
    model: resolvedModel as never,
    // New sessions start at `off`, which sends no effort parameter, so the
    // provider's own default applies. Existing sessions must omit this option
    // so Pi can restore their persisted level.
    thinkingLevel: sessionManager.getBranch().length === 0 ? "off" : undefined,
    // Newly enabled MCP tools must remain registerable when the session reloads.
    ...(hasDiscovery
      ? {
          excludeTools: PI_BUILTIN_TOOLS.filter(
            (name) => !tools.includes(name)
          ),
        }
      : { tools }),
    customTools: piCustomTools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  // A bound error listener makes `reload()` start the extensions again, so a changed server list takes effect.
  if (hasMcp) await session.bindExtensions({ onError: () => {} });
  live.set(session.sessionId, session as PiSession);
  sessionToolControllers.set(session as object, controllers);
  const wrappedSession = wrapPiSession(
    session as PiSession,
    create,
    listeners,
    args.resolveModelRef,
    async () => {
      await args.modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
    },
    controllers,
    backgroundTasks,
    guardedBashOperations
  );
  if (!gondolinBash) return wrappedSession;
  // Pi's dispose is synchronous, so this teardown cannot be awaited here. Starting
  // it still frees the VM the moment a session ends mid-run; the guarantee for the
  // case this cannot cover — Core stopping with the session still open — is
  // `adapters/gondolin/lifecycle.ts`, reached through the bootstrap teardown.
  const dispose = wrappedSession.dispose.bind(wrappedSession);
  wrappedSession.dispose = () => {
    dispose();
    void gondolinBash.dispose();
  };
  return wrappedSession;
}
