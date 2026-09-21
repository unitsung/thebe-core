import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CONTAINER_RESTART_ACTION_ID } from "../capabilities/containers.ts";
import { hashParameters } from "../../agent/security/audit/audit-log.ts";
import type { RuntimeExport, RuntimeModelRef, BackgroundTask, ThebeSessionContext } from "../runtime/index.ts";
import { wrapCustomTools } from "../../agent/tools/wrapped-tool.ts";
import type { AuditPage, AuditQuery } from "../security/audit/audit-log.ts";
import { DEFAULT_MODEL_TEST_TIMEOUT_MS, httpError } from "../types.ts";
import type { AgentContext } from "../internal/context.ts";
import {
  DIAGNOSE_FROM_EVENTS_TOOL,
  LIST_CORE_EVENTS_TOOL,
  listCoreMcpTools,
  withProductMetadata,
} from "../extensions/mcp.ts";
import {
  CAPABILITY_INVOKE_MODE_BACKGROUND,
  CAPABILITY_INVOKE_MODE_DIRECT,
  CAPABILITY_INVOKE_TYPE_RESULT,
  CAPABILITY_INVOKE_TYPE_RUN,
  CAPABILITY_RUN_STATUS_FAILED,
  CAPABILITY_RUN_STATUS_RUNNING,
  CAPABILITY_RUN_STATUS_SUCCEEDED,
  parseCapabilityResult,
  type CapabilityInvokeInput,
  type CapabilityInvokeResult,
  type CapabilityRun,
} from "../capabilities/invoke.ts";
import { createCapabilityRunStore } from "../capabilities/runs.ts";

const RESTART_REQUIRES_ON_DEVICE_APPROVAL =
  `${CONTAINER_RESTART_ACTION_ID} requires on-device approval; use POST /v1/action`;

export function createControlApi(ctx: AgentContext) {
  const {
    options,
    audit,
    openSession,
    lastEvents,
    sessionLog,
    policy,
    baseTools,
    mcp,
    now,
  } = ctx;
  const capabilityRuns = new Map<string, CapabilityRun>();
  const capabilityRunStore = createCapabilityRunStore({
    dir: options.agentStoreDir
      ? join(options.agentStoreDir, "capability-runs")
      : undefined,
    now,
    ownerId: randomUUID(),
  });
  let capabilityRunsLoaded = false;
  let capabilityRunsLoadPromise: Promise<void> | undefined;

  async function ensureCapabilityRunsLoaded(): Promise<void> {
    if (capabilityRunsLoaded) return;
    capabilityRunsLoadPromise ??= (async () => {
      for (const run of await capabilityRunStore.list()) {
        capabilityRuns.set(run.runId, run);
      }
      capabilityRunsLoaded = true;
    })();
    await capabilityRunsLoadPromise;
  }

  async function updateCapabilityRun(
    runId: string,
    patch: Partial<Pick<CapabilityRun, "status" | "finishedAt" | "result" | "error">>,
  ): Promise<void> {
    const current = capabilityRuns.get(runId);
    if (!current) return;
    const updated: CapabilityRun = {
      ...current,
      ...patch,
      updatedAt: now().toISOString(),
    };
    await capabilityRunStore.save(updated);
    capabilityRuns.set(runId, updated);
  }

  async function invokeTool(name: string, args: unknown): Promise<string> {
    if (name === CONTAINER_RESTART_ACTION_ID) {
      throw httpError(403, RESTART_REQUIRES_ON_DEVICE_APPROVAL);
    }
    const params = (args ?? {}) as Record<string, unknown>;
    const external = await mcp.invokeTool(name, params);
    if (external !== undefined) return external;
    if (name === LIST_CORE_EVENTS_TOOL) {
      const sid =
        typeof params.sessionId === "string"
          ? params.sessionId
          : ctx.active?.meta.thebeSessionId;
      const events = sid ? sessionLog(sid).events : lastEvents;
      const limit =
        typeof params.limit === "number" && params.limit > 0
          ? params.limit
          : 50;
      return JSON.stringify(events.slice(-limit), null, 2);
    }
    if (name === DIAGNOSE_FROM_EVENTS_TOOL) {
      const events = lastEvents;
      const errors = events.filter(
        (event) => event.type === "error" || event.type === "interrupted",
      );
      return JSON.stringify(
        {
          category: params.category ?? "all",
          totalEvents: events.length,
          errors: errors.length,
          lastError: errors.at(-1) ?? null,
        },
        null,
        2,
      );
    }
    const tools = wrapCustomTools(baseTools(), { policy, audit });
    const tool = tools.find((item) => item.name === name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }
    const result = await tool.execute("mcp", args ?? {});
    return result.content.map((block) => block.text).join("\n");
  }

  return {
    permissionMode(): import("../runtime/interface.ts").PermissionMode {
      return ctx.permissionMode();
    },
    setPermissionMode(
      mode: import("../runtime/interface.ts").PermissionMode,
    ): void {
      ctx.setPermissionMode(mode);
    },
    updatePermissionMode(
      mode: import("../runtime/interface.ts").PermissionMode,
    ) {
      return ctx.updatePermissionMode(mode);
    },
    getAgentSettings() {
      return ctx.getAgentSettings();
    },
    updateAgentSettings(patch: import("../settings/product.ts").AgentSettingsPatch) {
      return ctx.updateAgentSettings(patch);
    },
    async listModels(query?: { all?: boolean; providerId?: string }) {
      return options.runtime.listModels(query);
    },
    /**
     * Connectivity probe for onboarding: runs one minimal turn with the
     * given model on an ephemeral runtime session. The session is never
     * persisted to the AgentStore and never becomes `active`; unknown
     * models 404 via setModel validation, hung runs abort and 504.
     */
    async testModel(
      model: RuntimeModelRef,
      query?: { timeoutMs?: number },
    ): Promise<{
      providerId: string;
      modelId: string;
      text: string;
      latencyMs: number;
    }> {
      const timeoutMs = query?.timeoutMs ?? DEFAULT_MODEL_TEST_TIMEOUT_MS;
      const session = await options.runtime.createSession({
        customTools: [],
        builtinTools: [],
        systemPrompt: "You are a connectivity probe. Reply briefly.",
      });
      const started = Date.now();
      try {
        await session.setModel(model);
        const reply = await Promise.race([
          session.prompt("Reply with exactly: ok").then(() => undefined),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => {
              reject(
                httpError(504, "model test timed out; provider may be slow"),
              );
            }, timeoutMs);
            if (typeof timer === "object" && "unref" in timer) {
              (timer as { unref(): void }).unref?.();
            }
          }),
        ]);
        void reply;
        const text = session.lastAssistantText();
        await audit
          ?.append({
            method: "model.test",
            parameterHash: hashParameters(model),
            responseBytes: text.length,
            budgetConsumed: 0,
            redactionFired: false,
          })
          .catch(() => {});
        return {
          providerId: model.providerId,
          modelId: model.modelId,
          text,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        await session.abort().catch(() => {});
        throw error;
      } finally {
        session.dispose();
      }
    },
    async listAvailableModels(query?: { providerId?: string }) {
      return options.runtime.listAvailableModels(query);
    },
    async listProviders(query?: { all?: boolean }) {
      return options.runtime.listProviders(query);
    },
    async exportSession(
      thebeSessionId?: string,
    ): Promise<RuntimeExport> {
      const opened = await openSession(thebeSessionId);
      return opened.session.exportSession();
    },
    async listAudit(query?: AuditQuery): Promise<AuditPage> {
      return audit?.list(query) ?? { entries: [] };
    },
    invokeTool,
    async invokeCapability(
      id: string,
      input: CapabilityInvokeInput = {},
    ): Promise<CapabilityInvokeResult> {
      const capabilities = [
        ...listCoreMcpTools(),
        ...(await mcp.listTools()),
      ].map(withProductMetadata);
      const capability = capabilities.find(
        (item) => item.id === id || item.name === id,
      );
      if (!capability) {
        throw httpError(404, `unknown capability: ${id}`);
      }
      if (capability.approval === "required" || capability.id === CONTAINER_RESTART_ACTION_ID) {
        throw httpError(403, RESTART_REQUIRES_ON_DEVICE_APPROVAL);
      }
      const mode = input.mode ?? CAPABILITY_INVOKE_MODE_DIRECT;
      const args = input.arguments ?? {};
      if (mode === CAPABILITY_INVOKE_MODE_BACKGROUND) {
        if (!capability.background) {
          throw httpError(
            400,
            "capability does not support background execution",
            "invalid_body",
          );
        }
        const runId = randomUUID();
        const createdAt = now().toISOString();
        const run: CapabilityRun = {
          runId,
          capabilityId: capability.id,
          status: CAPABILITY_RUN_STATUS_RUNNING,
          createdAt,
          updatedAt: createdAt,
          resource: input.resource,
        };
        await ensureCapabilityRunsLoaded();
        capabilityRuns.set(runId, run);
        try {
          await capabilityRunStore.save(run);
        } catch (error) {
          capabilityRuns.delete(runId);
          throw error;
        }
        void (async () => {
          try {
            const text = await invokeTool(capability.id, args);
            await updateCapabilityRun(runId, {
              status: CAPABILITY_RUN_STATUS_SUCCEEDED,
              result: parseCapabilityResult(text),
              finishedAt: now().toISOString(),
            });
          } catch (error) {
            await updateCapabilityRun(runId, {
              status: CAPABILITY_RUN_STATUS_FAILED,
              error: error instanceof Error ? error.message : String(error),
              finishedAt: now().toISOString(),
            }).catch(() => {});
          }
        })();
        return { type: CAPABILITY_INVOKE_TYPE_RUN, runId };
      }
      const text = await invokeTool(capability.id, args);
      return { type: CAPABILITY_INVOKE_TYPE_RESULT, result: parseCapabilityResult(text) };
    },
    async getCapabilityRun(runId: string): Promise<CapabilityRun | undefined> {
      await ensureCapabilityRunsLoaded();
      const run = capabilityRuns.get(runId);
      return run ? { ...run } : undefined;
    },
    async listCapabilityRuns(): Promise<CapabilityRun[]> {
      await ensureCapabilityRunsLoaded();
      return [...capabilityRuns.values()]
        .sort((left, right) => {
          const a = left.updatedAt ?? left.createdAt;
          const b = right.updatedAt ?? right.createdAt;
          return a < b ? 1 : a > b ? -1 : 0;
        })
        .map((run) => ({ ...run }));
    },
    async getContext(thebeSessionId: string): Promise<ThebeSessionContext> {
      const opened = await openSession(thebeSessionId);
      return opened.session.getContextUsage();
    },
    async getContextUsage(thebeSessionId: string): Promise<ThebeSessionContext> {
      const opened = await openSession(thebeSessionId);
      return opened.session.getContextUsage();
    },
    async stopToolCall(
      thebeSessionId: string,
      toolCallId: string,
    ): Promise<void> {
      ctx.checkNotQuiesced();
      const opened = await openSession(thebeSessionId);
      await opened.session.stopToolCall(toolCallId);
    },
    async listBackgroundTasks(
      thebeSessionId: string,
    ): Promise<BackgroundTask[]> {
      const opened = await openSession(thebeSessionId);
      return opened.session.listBackgroundTasks();
    },
    async stopBackgroundTask(
      thebeSessionId: string,
      taskId: string,
    ): Promise<void> {
      const opened = await openSession(thebeSessionId);
      await opened.session.stopBackgroundTask(taskId);
    },
    async stopAllBackgroundTasks(thebeSessionId: string): Promise<void> {
      const opened = await openSession(thebeSessionId);
      const tasks = await opened.session.listBackgroundTasks();
      for (const task of tasks) {
        await opened.session.stopBackgroundTask(task.id);
      }
    },
    async executeBash(
      thebeSessionId: string,
      command: string,
      onChunk?: (chunk: string) => void,
      options?: { excludeFromContext?: boolean },
    ): Promise<{ exitCode?: number; cancelled: boolean; output: string }> {
      const opened = await openSession(thebeSessionId);
      if (opened.session.executeBash) {
        return opened.session.executeBash(command, onChunk, options);
      }
      return { exitCode: 0, cancelled: false, output: "" };
    },
    async quiesce(): Promise<void> {
      await options.runtime.quiesce();
    },
    async unquiesce(): Promise<void> {
      await options.runtime.unquiesce();
    },
    async reapIdleSessions(idleMs?: number): Promise<{ reaped: number }> {
      const reaped = await ctx.reapIdleSessions(idleMs);
      return { reaped };
    },
    isQuiesced(): boolean {
      return options.runtime.isQuiesced();
    },
    auth() {
      return options.runtime.auth();
    },
  };
}
