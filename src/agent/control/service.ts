import { hashParameters } from "../../agent/security/audit/audit-log.ts";
import type { RuntimeExport, RuntimeModelRef, BackgroundTask, ThebeSessionContext } from "../runtime/index.ts";
import { wrapCustomTools } from "../../agent/tools/wrapped-tool.ts";
import { DEFAULT_MODEL_TEST_TIMEOUT_MS, httpError } from "../types.ts";
import type { AgentContext } from "../internal/context.ts";

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
  } = ctx;

  return {
    permissionMode(): import("../runtime/interface.ts").PermissionMode {
      return ctx.permissionMode();
    },
    setPermissionMode(
      mode: import("../runtime/interface.ts").PermissionMode,
    ): void {
      ctx.setPermissionMode(mode);
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
    async invokeTool(name: string, args: unknown): Promise<string> {
      if (name === "container.restart") {
        throw httpError(
          403,
          "container.restart requires on-device approval; use POST /v1/action",
        );
      }
      const params = (args ?? {}) as Record<string, unknown>;
      const external = await mcp.invokeTool(name, params);
      if (external !== undefined) return external;
      if (name === "list_core_events") {
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
      if (name === "diagnose_from_events") {
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
