import { randomUUID } from "node:crypto";
import type {
  ForkSessionOptions,
  RuntimeModelRef,
  RuntimeThinkingInfo,
  ThinkingLevel,
  PermissionRememberScope,
} from "../runtime/index.ts";
import { httpError, type SessionRunStatus } from "../types.ts";
import type { AgentSessionMeta } from "../store.ts";
import type { AgentContext } from "../internal/context.ts";
import {
  toProductPendingPermission,
  type ProductPendingPermission,
} from "../security/pending-permission.ts";

export function createSessionApi(
  ctx: AgentContext,
  restoreSessionState?: (thebeSessionId: string) => Promise<void>,
) {
  const {
    options,
    checkNotQuiesced,
    sessionOptions,
    touchMeta,
    persist,
    lookup,
    openSession,
    listMetas,
    withRunState,
    stamp,
    streaming,
    abortRequested,
    appendEvent,
    sessionLog,
    pendingPermissions,
    memory,
    logs,
    store,
    cancelSubagentsForParent,
    resolvePermission,
  } = ctx;

  return {
    async createSession(init?: {
      title?: string;
      labels?: Record<string, string>;
      selectedContext?: AgentSessionMeta["selectedContext"];
      model?: RuntimeModelRef;
      builtinTools?: readonly string[];
    }): Promise<AgentSessionMeta> {
      checkNotQuiesced();
      const effectiveModel = init?.model ?? options.model;
      const thebeSessionId = randomUUID();
      const session = await options.runtime.createSession(
        sessionOptions(thebeSessionId, init?.builtinTools, effectiveModel),
      );
      const meta = touchMeta({
        thebeSessionId,
        runtimeId: options.runtime.runtimeId,
        runtimeSessionId: session.runtimeSessionId,
        title: init?.title,
        labels: init?.labels,
        selectedContext: init?.selectedContext,
        builtinTools: init?.builtinTools ? [...init.builtinTools] : undefined,
      });
      await persist(meta);
      ctx.active = { meta, session };
      if (effectiveModel) {
        try {
          await session.setModel(effectiveModel);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("unknown model")) {
            throw err;
          }
        }
      }
      return meta;
    },
    async listSessions(query?: {
      status?: string;
      hostId?: string;
      environmentId?: string;
    }): Promise<
      Array<AgentSessionMeta & { status: SessionRunStatus; streaming: boolean }>
    > {
      const rows = await listMetas();
      let mapped = rows
        .filter((row) => !row.inPlace)
        .map((row) => withRunState(row));
      if (query?.status) {
        mapped = mapped.filter((row) => row.status === query.status);
      }
      if (query?.hostId) {
        mapped = mapped.filter(
          (row) =>
            (row.selectedContext?.hostId ?? row.selectedContext?.host) ===
            query.hostId,
        );
      }
      if (query?.environmentId) {
        mapped = mapped.filter(
          (row) =>
            (row.selectedContext?.environmentId ??
              row.selectedContext?.environment) === query.environmentId,
        );
      }
      return mapped;
    },
    async getSession(thebeSessionId: string): Promise<AgentSessionMeta> {
      return lookup(thebeSessionId);
    },
    async patchSession(
      thebeSessionId: string,
      patch: Partial<
        Pick<
          AgentSessionMeta,
          | "title"
          | "labels"
          | "selectedContext"
          | "shareMetadata"
          | "rememberedPermissions"
        >
      >,
    ): Promise<AgentSessionMeta> {
      checkNotQuiesced();
      const current = await lookup(thebeSessionId);
      const meta = touchMeta({
        ...current,
        title: patch.title ?? current.title,
        labels: patch.labels ?? current.labels,
        selectedContext: patch.selectedContext ?? current.selectedContext,
        shareMetadata: patch.shareMetadata ?? current.shareMetadata,
        rememberedPermissions:
          patch.rememberedPermissions !== undefined
            ? patch.rememberedPermissions
            : current.rememberedPermissions,
      });
      await persist(meta);
      const opened = ctx.openedSessions.get(thebeSessionId);
      if (opened) {
        opened.meta = meta;
      }
      if (ctx.active?.meta.thebeSessionId === thebeSessionId) {
        ctx.active.meta = meta;
      }
      return meta;
    },
    /** Removes both the runtime transcript and the Thebe metadata mapping. */
    async deleteSession(thebeSessionId: string): Promise<void> {
      checkNotQuiesced();
      if (streaming.has(thebeSessionId)) {
        throw httpError(409, "cannot delete a running session or one awaiting confirmation");
      }
      await cancelSubagentsForParent(thebeSessionId);
      const awaitingConfirmation = [...pendingPermissions.values()].some(
        (pending) => pending.thebeSessionId === thebeSessionId,
      );
      if (awaitingConfirmation) {
        throw httpError(409, "cannot delete a running session or one awaiting confirmation");
      }
      const meta = await lookup(thebeSessionId);
      const opened = ctx.openedSessions.get(thebeSessionId);
      if (opened) {
        ctx.cancelAutoSummary(thebeSessionId);
        opened.session.dispose();
        ctx.openedSessions.delete(thebeSessionId);
      }
      if (ctx.active?.meta.thebeSessionId === thebeSessionId) {
        ctx.active = undefined;
      }
      memory.delete(thebeSessionId);
      logs.delete(thebeSessionId);
      await options.runtime.deleteSession(meta.runtimeSessionId);
      await store.delete(thebeSessionId);
    },
    /** Whether this host permits the session-scoped full-access preset. */
    getFullAccessSupport(): { allowed: boolean } {
      return ctx.getFullAccessSupport();
    },
    /**
     * Enable or disable bypass for one session. Subagents, schedules, background
     * goals and `/mcp` callers are unaffected.
     */
    setSessionFullAccess(
      thebeSessionId: string,
      enabled: boolean,
    ): Promise<{ thebeSessionId: string; fullAccess: boolean }> {
      return ctx.setSessionFullAccess(thebeSessionId, enabled);
    },
    /** Set (or with `undefined`, clear) the permission mode of one session. */
    setSessionPermissionMode(
      thebeSessionId: string,
      mode: import("../runtime/interface.ts").PermissionMode | undefined,
    ) {
      return ctx.setSessionPermissionMode(thebeSessionId, mode);
    },
    /** The permission mode a session runs in now. */
    sessionPermissionMode(thebeSessionId: string) {
      return ctx.sessionPermissionMode(thebeSessionId);
    },
    async sessionStatus(): Promise<
      Array<AgentSessionMeta & { status: SessionRunStatus; streaming: boolean }>
    > {
      const rows = await listMetas();
      return rows.filter((row) => !row.inPlace).map((row) => withRunState(row));
    },
    async resume(thebeSessionId: string): Promise<AgentSessionMeta> {
      checkNotQuiesced();
      const opened = await openSession(thebeSessionId);
      await restoreSessionState?.(thebeSessionId);
      return opened.meta;
    },
    async fork(
      thebeSessionId?: string,
      optionsOrEntryId?:
        | string
        | { atEntryId?: string; mode?: ForkSessionOptions["mode"] },
    ): Promise<AgentSessionMeta> {
      checkNotQuiesced();
      const forkOpts: ForkSessionOptions =
        typeof optionsOrEntryId === "string"
          ? { atEntryId: optionsOrEntryId }
          : optionsOrEntryId ?? {};
      const source = thebeSessionId
        ? await lookup(thebeSessionId)
        : ctx.active?.meta;
      if (!source) {
        throw httpError(404, "no session to fork");
      }
      const childThebeId = randomUUID();
      const child = await options.runtime.forkSession(
        source.runtimeSessionId,
        sessionOptions(childThebeId, source.builtinTools),
        forkOpts,
      );
      const inPlace = forkOpts.mode === "branch_in_place";
      const meta = stamp({
        thebeSessionId: childThebeId,
        runtimeId: options.runtime.runtimeId,
        runtimeSessionId: child.runtimeSessionId,
        parentThebeSessionId: source.thebeSessionId,
        selectedContext: source.selectedContext,
        labels: source.labels,
        shareMetadata: source.shareMetadata,
        title: source.title,
        builtinTools: source.builtinTools ? [...source.builtinTools] : undefined,
        inPlace: inPlace || undefined,
        leafId: child.getLeafId?.() ?? forkOpts.atEntryId,
      });
      await persist(meta);
      ctx.active = { meta, session: child };
      return meta;
    },
    async children(thebeSessionId: string): Promise<AgentSessionMeta[]> {
      const rows = await listMetas();
      return rows.filter((row) => row.parentThebeSessionId === thebeSessionId);
    },
    async getForkMessages(thebeSessionId?: string): Promise<Array<{ entryId: string; text: string }>> {
      const opened = await openSession(thebeSessionId);
      if (typeof opened.session.getForkMessages === "function") {
        return opened.session.getForkMessages();
      }
      return opened.session.messages()
        .filter((message) => message.role === "user" && message.text)
        .map((message) => ({ entryId: message.id, text: message.text ?? "" }));
    },
    async compact(
      thebeSessionId?: string,
      customInstructions?: string,
    ): Promise<void> {
      checkNotQuiesced();
      const opened = await openSession(thebeSessionId);
      const id = opened.meta.thebeSessionId;
      const unsub = opened.session.subscribe((event) => {
        appendEvent(id, event);
      });
      try {
        await opened.session.compact(customInstructions);
      } finally {
        unsub();
      }
    },
    async setAutoCompactionEnabled(
      thebeSessionId: string | undefined,
      enabled: boolean,
    ): Promise<void> {
      ctx.autoCompactOverride = enabled;
      const opened = await openSession(thebeSessionId);
      opened.session.setAutoCompactionEnabled?.(enabled);
    },
    async setAutoSummaryEnabled(enabled: boolean): Promise<void> {
      ctx.setAutoSummaryEnabled(enabled);
    },
    autoSummaryEnabled(): boolean {
      return ctx.autoSummaryEnabled();
    },
    async setAutoSummaryDelayMs(delayMs: number): Promise<void> {
      ctx.setAutoSummaryDelayMs(delayMs);
    },
    autoSummaryDelayMs(): number {
      return ctx.autoSummaryDelayMs();
    },
    async interrupt(thebeSessionId?: string): Promise<void> {
      const opened = await openSession(thebeSessionId);
      const id = opened.meta.thebeSessionId;
      abortRequested.add(id);
      ctx.rejectPendingFor(id);
      await opened.session.abort();
      // The runtime emits `interrupted` on the aborted handle only; a resume
      // handle has no listeners, so ensure the session log sees exactly one.
      const tail = sessionLog(id).events.at(-1);
      if (!tail || tail.type !== "interrupted") {
        appendEvent(id, { type: "interrupted" });
      }
    },
    /**
     * History-only revert to the last user turn. External side effects
     * (bash runs, file writes, container changes) are NOT rolled back;
     * clients must not present this as undoing what the agent did.
     */
    async revert(thebeSessionId?: string): Promise<void> {
      checkNotQuiesced();
      const opened = await openSession(thebeSessionId);
      await opened.session.revert();
    },
    async unrevert(thebeSessionId?: string): Promise<void> {
      checkNotQuiesced();
      const opened = await openSession(thebeSessionId);
      await opened.session.unrevert();
    },
    /**
     * Resolves one pending approval. `remember` persists the decision for
     * this tool on this session only (no TTL, no cross-session sharing).
     * `rememberScope: "request"` hashes high-risk arguments; `"tool"` is an
     * explicit session-wide decision for the named tool; `"conversation"`
     * applies to every approval-gated tool in this saved conversation;
     * pending entries are in-memory, so a restart turns them into
     * `unknown permission` 404s and the client should re-prompt. Resolving
     * twice is a deterministic 404, not silent success.
     */
    async resolvePermission(
      thebeSessionId: string,
      permissionId: string,
      decision: {
        response: "allow" | "deny";
        remember?: boolean;
        rememberScope?: PermissionRememberScope;
      },
    ): Promise<void> {
      await resolvePermission(thebeSessionId, permissionId, decision);
    },
    pendingPermissionIds(): string[] {
      return [...pendingPermissions.keys()];
    },
    listPendingPermissions(): ProductPendingPermission[] {
      return [...pendingPermissions.values()].map(toProductPendingPermission);
    },
    getPendingPermission(id: string): ProductPendingPermission | undefined {
      const pending = pendingPermissions.get(id);
      return pending ? toProductPendingPermission(pending) : undefined;
    },
    async resolvePendingPermission(
      id: string,
      decision: {
        response: "allow" | "deny";
        remember?: boolean;
        rememberScope?: PermissionRememberScope;
      },
    ): Promise<void> {
      const pending = pendingPermissions.get(id);
      if (!pending?.thebeSessionId) {
        throw httpError(404, `unknown permission: ${id}`);
      }
      await resolvePermission(pending.thebeSessionId, id, decision);
    },
    async setModel(
      thebeSessionId: string,
      model: RuntimeModelRef,
    ): Promise<void> {
      checkNotQuiesced();
      if (streaming.has(thebeSessionId)) {
        throw httpError(409, "session is streaming; switch model when idle");
      }
      const opened = await openSession(thebeSessionId);
      await opened.session.setModel(model);
    },
    async setThinkingLevel(
      thebeSessionId: string,
      level: ThinkingLevel,
    ): Promise<RuntimeThinkingInfo> {
      checkNotQuiesced();
      if (streaming.has(thebeSessionId)) {
        throw httpError(
          409,
          "session is streaming; switch thinking level when idle",
        );
      }
      const opened = await openSession(thebeSessionId);
      await opened.session.setThinkingLevel(level);
      return opened.session.getThinkingInfo();
    },
    async getThinkingInfo(
      thebeSessionId: string,
    ): Promise<RuntimeThinkingInfo> {
      const opened = await openSession(thebeSessionId);
      return opened.session.getThinkingInfo();
    },
  };
}
