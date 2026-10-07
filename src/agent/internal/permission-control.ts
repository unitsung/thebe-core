import type { PermissionPreflightDecision, PermissionRequest, PermissionMode } from "../runtime/index.ts";
import { rememberedDecision, rememberedPermissionKey } from "../security/remembered-permissions.ts";
import type { AgentSessionMeta } from "../store.ts";
import type { OpenedSession } from "./session-state.ts";

const PERMISSION_TTL_MS = 10 * 60 * 1000;

export type PendingPermission = {
  request: PermissionRequest;
  thebeSessionId?: string;
  requestedAt: string;
  resolve: (decision: "allow" | "deny") => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** Owns approval policy, remembered decisions, expiry, and pending requests. */
export function createPermissionControl(input: {
  initialMode?: PermissionMode;
  preflight(request: PermissionRequest): PermissionPreflightDecision | Promise<PermissionPreflightDecision>;
  workspaceReadTools: readonly string[];
  lookupRemembered(thebeSessionId: string): Promise<Record<string, "allow" | "deny"> | undefined>;
  active(): OpenedSession | undefined;
  openedSessions: Map<string, OpenedSession>;
  lookup(thebeSessionId: string): Promise<AgentSessionMeta>;
  persist(meta: AgentSessionMeta): Promise<void>;
  touchMeta(meta: AgentSessionMeta): AgentSessionMeta;
}) {
  let mode: PermissionMode = input.initialMode ?? "ask";
  const nonInteractiveRuns = new Set<string>();
  const pendingPermissions = new Map<string, PendingPermission>();

  function permissionMode(): PermissionMode { return mode; }
  function setPermissionMode(value: PermissionMode): void { mode = value; }

  function hasPendingFor(thebeSessionId: string): boolean {
    return [...pendingPermissions.values()].some(
      (pending) => pending.thebeSessionId === thebeSessionId,
    );
  }

  function rejectPendingPermission(permissionId: string): boolean {
    const pending = pendingPermissions.get(permissionId);
    if (!pending) return false;
    pendingPermissions.delete(permissionId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve("deny");
    return true;
  }

  function rejectPendingFor(thebeSessionId: string): void {
    for (const [permissionId, pending] of [...pendingPermissions]) {
      if (pending.thebeSessionId !== thebeSessionId) continue;
      pendingPermissions.delete(permissionId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve("deny");
    }
  }

  function permissionHandler(explicitSessionId?: string) {
    return {
      async preflight(request: PermissionRequest): Promise<PermissionPreflightDecision> {
        const policy = await input.preflight(request);
        if (policy === "deny") return "deny";
        const thebeSessionId = explicitSessionId ?? input.active()?.meta.thebeSessionId;
        const remembered = rememberedDecision(
          thebeSessionId ? await input.lookupRemembered(thebeSessionId) : input.active()?.meta.rememberedPermissions,
          request,
        );
        if (remembered === "deny") return "deny";
        if (mode === "read-only" && !input.workspaceReadTools.includes(request.toolName)) return "deny";
        if (policy === "allow" || mode === "full-access" || remembered === "allow") return "allow";
        if (thebeSessionId && nonInteractiveRuns.has(thebeSessionId)) return "deny";
        return "ask";
      },
      async request(request: PermissionRequest): Promise<"allow" | "deny"> {
        const thebeSessionId = explicitSessionId ?? input.active()?.meta.thebeSessionId;
        const remembered = rememberedDecision(
          thebeSessionId
            ? await input.lookupRemembered(thebeSessionId)
            : input.active()?.meta.rememberedPermissions,
          request,
        );
        if (remembered === "deny") return "deny";
        if (mode === "read-only") {
          return input.workspaceReadTools.includes(request.toolName) ? "allow" : "deny";
        }
        if (mode === "full-access") return "allow";
        if (remembered === "allow") return remembered;
        if (thebeSessionId && nonInteractiveRuns.has(thebeSessionId)) return "deny";
        return new Promise<"allow" | "deny">((resolve) => {
          const timer = setTimeout(() => {
            const pending = pendingPermissions.get(request.permissionId);
            if (!pending) return;
            pendingPermissions.delete(request.permissionId);
            pending.resolve("deny");
          }, PERMISSION_TTL_MS);
          timer.unref?.();
          pendingPermissions.set(request.permissionId, {
            request,
            thebeSessionId,
            requestedAt: new Date().toISOString(),
            resolve,
            timer,
          });
        });
      },
    };
  }

  async function resolvePermission(
    thebeSessionId: string,
    permissionId: string,
    decision: {
      response: "allow" | "deny";
      remember?: boolean;
      rememberScope?: Parameters<typeof rememberedPermissionKey>[2];
    },
  ): Promise<void> {
    const pending = pendingPermissions.get(permissionId);
    if (!pending || pending.thebeSessionId !== thebeSessionId) {
      throw new Error(`unknown permission: ${permissionId}`);
    }
    pendingPermissions.delete(permissionId);
    if (pending.timer) clearTimeout(pending.timer);
    if (decision.remember) {
      const meta = await input.lookup(thebeSessionId);
      const key = rememberedPermissionKey(
        pending.request,
        decision.response,
        decision.rememberScope ?? "request",
      );
      meta.rememberedPermissions = {
        ...meta.rememberedPermissions,
        [key]: decision.response,
      };
      await input.persist(input.touchMeta(meta));
      const opened = input.openedSessions.get(thebeSessionId);
      if (opened) opened.meta = meta;
    }
    pending.resolve(decision.response);
  }

  return {
    nonInteractiveRuns,
    pendingPermissions,
    permissionMode,
    setPermissionMode,
    permissionHandler,
    hasPendingFor,
    rejectPendingFor,
    rejectPendingPermission,
    resolvePermission,
  };
}

export type PermissionControl = ReturnType<typeof createPermissionControl>;
