import { randomUUID } from "node:crypto";
import type {
  CreateRuntimeSessionOptions,
  NormalizedEvent,
  RuntimeModelRef,
  RuntimeSession,
} from "../../types.ts";
import { PI_BUILTIN_TOOLS } from "../../types.ts";
import { permissionRisk, summarizeArgs } from "../../../tools/redaction.ts";
import { createExplicitResourceLoader } from "../sdk/explicit-loader.ts";
import type { PiSdk } from "../sdk/load-pi.ts";
import { sanitizeBashEnv } from "../config/bash-env.ts";
import { loadThebeUserConfig } from "../config/user-config.ts";
import type { PiSession } from "./pi-session.ts";
import { toPiTool } from "./pi-tools.ts";
import { wrapSession as wrapPiSession } from "./wrap-session.ts";
import type { PiModelShape } from "../config/model-shape.ts";

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
  },
): Promise<RuntimeSession> {
  const { create, sessionManager, cwd, live } = args;
  const tools = [
    ...(create.builtinTools ?? PI_BUILTIN_TOOLS),
    ...create.customTools.map((tool) => tool.name),
  ];
  const listeners = new Set<(event: NormalizedEvent) => void>();
  const permissionHandler = create.permissionHandler
    ? {
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
              if (!required.has(event.toolName)) {
                return undefined;
              }
              const permissionId = randomUUID();
              const decision = await permissionHandler.request({
                permissionId,
                toolName: event.toolName,
                toolCallId: event.toolCallId ?? permissionId,
                args: event.input,
                argsSummary: summarizeArgs(event.input),
                risk: permissionRisk(event.toolName),
              });
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
    } catch {
      permissionExtension = [];
    }
  }
  const resourceLoader = createExplicitResourceLoader({
    systemPrompt: create.systemPrompt ?? "You are Thebe.",
    enabledResources: create.enabledResources,
    sdk,
    extensions: permissionExtension,
    extensionRuntime,
  });
  const autoCompact =
    create.autoCompact ?? loadThebeUserConfig().autoCompact ?? true;
  const settingsManager = sdk.SettingsManager.inMemory({
    defaultProjectTrust: "always",
    retry: { enabled: false, maxRetries: 0 },
    compaction: { enabled: autoCompact },
  });
  settingsManager.setDefaultProjectTrust?.("always");
  const sanitizedBash = sdk.createBashTool(create.cwd ?? cwd, {
    spawnHook: (ctx: {
      command: string;
      cwd: string;
      env: Record<string, string | undefined>;
    }) => ({
      ...ctx,
      env: sanitizeBashEnv(ctx.env),
    }),
  });
  const piCustomTools = [
    ...create.customTools.map((tool) => toPiTool(sdk, tool)),
    ...(tools.includes("bash") ? [sanitizedBash] : []),
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
  resolvedModel ??= args.defaultModel
    ? args.defaultModel
    : args.resolveModelRef("opencode", "muse-spark-1.3-free");

  const { session } = await sdk.createAgentSession({
    cwd: create.cwd ?? cwd,
    agentDir: args.agentDir,
    modelRuntime: args.modelRuntime,
    model: resolvedModel as never,
    thinkingLevel: "off",
    tools,
    customTools: piCustomTools,
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  live.set(session.sessionId, session as PiSession);
  return wrapPiSession(
    session as PiSession,
    create,
    listeners,
    args.resolveModelRef,
    async () => {
      await args.modelRuntime.refresh({ allowNetwork: false }).catch(() => {});
    },
  );
}
