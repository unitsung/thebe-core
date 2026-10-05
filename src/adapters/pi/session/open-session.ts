import { randomUUID } from "node:crypto";
import type {
  CreateRuntimeSessionOptions,
  NormalizedEvent,
  PermissionRequest,
  RuntimeModelRef,
  RuntimeSession,
} from "../../../agent/runtime/interface.ts";
import { PI_BUILTIN_TOOLS } from "../../../agent/runtime/interface.ts";
import { permissionRisk, summarizeArgs } from "../../../agent/security/redaction.ts";
import { createExplicitResourceLoader } from "../sdk/explicit-loader.ts";
import type { PiSdk } from "../sdk/load-pi.ts";
import { sanitizeBashEnv } from "../../../agent/security/process-env.ts";
import { wrapCommandForSandbox } from "../../../agent/security/command-sandbox.ts";
import { resolveScenarioSettings } from "../../../agent/security/scenario-profile.ts";
import { createGondolinBashOperations } from "../../gondolin/bash-operations.ts";
import { loadThebeUserConfig } from "../config/user-config.ts";
import type { PiSession } from "./pi-session.ts";
import { toPiTool } from "./pi-tools.ts";
import { wrapSession as wrapPiSession } from "./wrap-session.ts";
import type { PiModelShape } from "../config/model-shape.ts";
import type { BackgroundTaskRegistry } from "./background-tasks.ts";
import type { BashOperations } from "./background-tasks.ts";

const sessionToolControllers = new WeakMap<object, Map<string, AbortController>>();

export function toolControllersFor(
  session: object,
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
  controllers: Map<string, AbortController>,
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
      signal?: AbortSignal,
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
            signal?: AbortSignal,
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
      modelId: string,
    ) => PiModelShape | undefined;
    live: Map<string, PiSession>;
    backgroundTasks: BackgroundTaskRegistry;
  },
): Promise<RuntimeSession> {
  const { create, sessionManager, cwd, live, backgroundTasks } = args;
  const tools = [
    ...(create.builtinTools ?? PI_BUILTIN_TOOLS),
    ...create.customTools.map((tool) => tool.name),
  ];
  const externalNames = new Set<string>();
  const externalApproval = new Set<string>();
  async function discoverMcpTools() {
    const external = await create.externalMcp?.listTools() ?? [];
    externalNames.clear();
    externalApproval.clear();
    return external.map((tool) => {
    const server = tool.serverName ?? "external";
    const originalName = tool.originalName ?? tool.name;
    const name = sdk.createMcpToolName(server, originalName,
      (candidate: string) => externalNames.has(candidate) || tools.includes(candidate));
    externalNames.add(name);
    if (tool.permission !== "read") externalApproval.add(name);
    return sdk.createMcpToolDefinition({
      server, name, tool: { name: originalName, description: tool.description,
        inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
        annotations: tool.annotations } as never,
      exposure: "deferred", namespace: { name: `mcp__${server}` }, timeoutMs: 15_000,
      getClient: async () => ({
        callTool: async (_name: string, args: Record<string, unknown>, options: { signal?: AbortSignal }) =>
          create.externalMcp!.callTool(tool.name, args, options.signal) as never,
      }),
    });
    });
  }
  const mcpTools = await discoverMcpTools();
  const hasMcp = Boolean(create.externalMcp);
  const listeners = new Set<(event: NormalizedEvent) => void>();
  const permissionHandler = create.permissionHandler
    ? {
        async preflight(
          request: PermissionRequest,
        ) {
          return (
            (await create.permissionHandler!.preflight?.(request)) ?? "ask"
          );
        },
        async request(
          request: Parameters<
            NonNullable<CreateRuntimeSessionOptions["permissionHandler"]>["request"]
          >[0],
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
              }) => Promise<unknown>,
            ) => void;
          }) => {
            const required = new Set(create.toolsRequiringApproval ?? []);
            pi.on("tool_call", async (event) => {
              if (!required.has(event.toolName) && !externalApproval.has(event.toolName)) {
                return undefined;
              }
              const permissionId = randomUUID();
              const request = {
                permissionId,
                toolName: event.toolName,
                toolCallId: event.toolCallId ?? permissionId,
                args: event.input,
                argsSummary: summarizeArgs(event.input),
                risk: externalApproval.has(event.toolName) ? "high" as const : permissionRisk(event.toolName),
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
          "thebe://permission-gate",
        ),
      ];
    } catch (error) {
      throw new Error(
        `failed to install permission gate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (hasMcp) {
    permissionExtension.push(await sdk.loadExtensionFromFactory(
      sdk.createToolSearchExtension(), create.cwd ?? cwd, sdk.createEventBus(),
      extensionRuntime, "thebe://tool-search"));
  }
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
    ...(hasMcp ? { defaultTools: [...tools, "tool_search"] } : {}),
  });
  settingsManager.setDefaultProjectTrust?.("always");
  const controllers = new Map<string, AbortController>();
  const sandbox = resolveScenarioSettings();
  const workspacePath = create.cwd ?? cwd;
  const baseBashOperations = backgroundTasks.wrap(sdk.createLocalBashOperations());
  const gondolinBash =
    sandbox.sandboxMode === "gondolin"
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
      const wrapped = wrapCommandForSandbox(ctx.command, {
        mode: sandbox.sandboxMode,
        workspacePath,
        allowNetwork: sandbox.sandboxNetwork,
        image: process.env.THEBE_SANDBOX_IMAGE?.trim() || undefined,
      });
      // bwrap re-enters the workspace with --chdir, so ctx.cwd stays the
      // tool's own working directory.
      return { ...ctx, command: wrapped.command, env: sanitizeBashEnv(ctx.env) };
    },
  });
  const piCustomTools = [
    ...mcpTools.map((tool) => abortablePiTool(tool, controllers)),
    ...create.customTools.map((tool) =>
      abortablePiTool(toPiTool(sdk, tool), controllers),
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
      requestedModel.modelId,
    );
  }
  if (!resolvedModel && !requestedModel) {
    resolvedModel = (await args.modelRuntime.getAvailable()).find((model: { provider: string; id: string }) =>
      !(model.provider === "opencode" && model.id.endsWith("-free")));
  }
  if (!resolvedModel) throw new Error("No configured model is available. Configure a provider and select a model.");

  const { session } = await sdk.createAgentSession({
    cwd: create.cwd ?? cwd,
    agentDir: args.agentDir,
    modelRuntime: args.modelRuntime,
    model: resolvedModel as never,
    // New sessions start with Thebe's explicit default. Existing sessions
    // must omit this option so Pi can restore their persisted level.
    thinkingLevel: sessionManager.getBranch().length === 0 ? "off" : undefined,
    // An explicit allowlist would hide deferred tools from tool_search.
    ...(hasMcp ? {
      excludeTools: PI_BUILTIN_TOOLS.filter((name) => !tools.includes(name)),
    } : { tools }),
    customTools: piCustomTools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  if (hasMcp) await session.bindExtensions({});
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
    bashOperations,
  );
  if (hasMcp) {
    const reload = wrappedSession.reloadResources!.bind(wrappedSession);
    wrappedSession.reloadResources = async () => {
      const next = await discoverMcpTools();
      const local = piCustomTools.filter((tool) => !tool.name.startsWith("mcp__"));
      piCustomTools.splice(0, piCustomTools.length,
        ...next.map((tool) => abortablePiTool(tool, controllers)), ...local);
      await reload();
    };
  }
  if (!gondolinBash) return wrappedSession;
  // Pi's dispose is synchronous, so the Micro-VM is torn down best-effort
  // (its lifetime is the session; the VM is disposable either way).
  const dispose = wrappedSession.dispose.bind(wrappedSession);
  wrappedSession.dispose = () => {
    dispose();
    void gondolinBash.dispose();
  };
  return wrappedSession;
}
