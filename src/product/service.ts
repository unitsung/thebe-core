import { randomUUID } from "node:crypto";
import { createAuditLog, hashParameters } from "../audit/audit-log.ts";
import { createPolicyEngine } from "../policy/policy-engine.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import {
  PI_BUILTIN_TOOLS,
  TOOLS_REQUIRING_APPROVAL,
  asPromptInput,
  type AgentRuntime,
  type EnabledResource,
  type NormalizedEvent,
  type PermissionRequest,
  type PromptInput,
  type PromptMode,
  type RuntimeExport,
  type RuntimeModelRef,
  type RuntimeSession,
  type ThinkingLevel,
} from "../runtime/types.ts";
import { createStreamGuard } from "../stream-guard/index.ts";
import {
  CONTAINER_TOOL_NAMES,
  createContainerTools,
} from "../tools/container-tools.ts";
import { createProductStore, type ProductSessionMeta } from "./store.ts";
import { wrapCustomTools } from "./wrap-tools.ts";

export type ThebePromptResult = {
  text: string;
  tools: string[];
  events: NormalizedEvent[];
  thebeSessionId: string;
};

/** @deprecated Use ThebePromptResult */
export type ThebeReply = ThebePromptResult;

export type ThebePromptOptions = {
  thebeSessionId?: string;
  mode?: PromptMode;
};

/** Error with an HTTP status hint for the thin Serve layer. */
export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

type SessionLog = {
  events: NormalizedEvent[];
  listeners: Set<(event: NormalizedEvent) => void>;
};

type PendingPermission = {
  request: PermissionRequest;
  resolve: (decision: "allow" | "deny") => void;
};

export function createThebeProduct(options: {
  runtime: AgentRuntime;
  provider: ContainerInfoProvider;
  auditPath?: string;
  productStoreDir?: string;
  now?: () => Date;
  callerId?: string;
  maxToolCalls?: number;
  maxBlocks?: number;
  ttfbMs?: number;
  idleMs?: number;
  watchdogMs?: number;
  systemPrompt?: string;
  builtinTools?: readonly string[];
  enabledResources?: EnabledResource[];
}) {
  const now = options.now ?? (() => new Date());
  const callerId = options.callerId ?? "default";
  const policy = createPolicyEngine({
    now,
    maxToolCalls: options.maxToolCalls,
    maxBlocks: options.maxBlocks,
  });
  const audit = options.auditPath
    ? createAuditLog(options.auditPath, now)
    : undefined;
  const store = createProductStore(options.productStoreDir);
  const memory = new Map<string, ProductSessionMeta>();
  const enabledResources: EnabledResource[] = [
    ...(options.enabledResources ?? []),
  ];
  const builtinTools = options.builtinTools ?? PI_BUILTIN_TOOLS;
  const systemPrompt = options.systemPrompt ?? "You are Thebe.";
  let active: { meta: ProductSessionMeta; session: RuntimeSession } | undefined;
  const lastEvents: NormalizedEvent[] = [];
  const logs = new Map<string, SessionLog>();
  const pendingPermissions = new Map<string, PendingPermission>();
  const streaming = new Set<string>();
  let requestStop: () => void | Promise<void> = () => {};

  function sessionLog(thebeSessionId: string): SessionLog {
    const existing = logs.get(thebeSessionId);
    if (existing) {
      return existing;
    }
    const created: SessionLog = { events: [], listeners: new Set() };
    logs.set(thebeSessionId, created);
    return created;
  }

  function appendEvent(
    thebeSessionId: string,
    event: NormalizedEvent,
  ): void {
    lastEvents.push(event);
    const log = sessionLog(thebeSessionId);
    log.events.push(event);
    for (const listener of log.listeners) {
      listener(event);
    }
  }

  function permissionHandler() {
    return {
      async request(request: PermissionRequest): Promise<"allow" | "deny"> {
        const remembered =
          active?.meta.rememberedPermissions?.[request.toolName];
        if (remembered) {
          return remembered;
        }
        return await new Promise<"allow" | "deny">((resolve) => {
          pendingPermissions.set(request.permissionId, { request, resolve });
        });
      },
    };
  }

  function baseTools() {
    return createContainerTools(options.provider, {
      policy,
      audit,
      callerId,
    });
  }

  function sessionOptions() {
    return {
      customTools: wrapCustomTools(baseTools(), {
        policy,
        audit,
        onStop: () => requestStop(),
      }),
      builtinTools,
      systemPrompt,
      enabledResources: enabledResources.slice(),
      permissionHandler: permissionHandler(),
      toolsRequiringApproval: TOOLS_REQUIRING_APPROVAL,
    };
  }

  function stamp(meta: ProductSessionMeta): ProductSessionMeta {
    const ts = now().toISOString();
    return {
      ...meta,
      createdAt: meta.createdAt ?? ts,
      lastActiveAt: ts,
    };
  }

  async function persist(meta: ProductSessionMeta): Promise<void> {
    memory.set(meta.thebeSessionId, meta);
    await store.save(meta);
  }

  async function lookup(thebeSessionId: string): Promise<ProductSessionMeta> {
    const cached = memory.get(thebeSessionId);
    if (cached) {
      return cached;
    }
    const loaded = await store.load(thebeSessionId);
    memory.set(thebeSessionId, loaded);
    return loaded;
  }

  async function openSession(
    thebeSessionId?: string,
  ): Promise<{ meta: ProductSessionMeta; session: RuntimeSession }> {
    if (thebeSessionId) {
      const meta = await lookup(thebeSessionId);
      const session = await options.runtime.resumeSession(
        meta.runtimeSessionId,
        sessionOptions(),
      );
      requestStop = () => session.abort();
      active = { meta, session };
      return active;
    }
    if (active) {
      return active;
    }
    const session = await options.runtime.createSession(sessionOptions());
    requestStop = () => session.abort();
    const meta = stamp({
      thebeSessionId: randomUUID(),
      runtimeId: options.runtime.runtimeId,
      runtimeSessionId: session.runtimeSessionId,
    });
    await persist(meta);
    active = { meta, session };
    return active;
  }

  async function runPrompt(
    input: string | PromptInput,
    promptOptions: ThebePromptOptions = {},
  ): Promise<ThebePromptResult> {
    const opened = await openSession(promptOptions.thebeSessionId);
    const thebeSessionId = opened.meta.thebeSessionId;
    const mode = promptOptions.mode ?? "prompt";
    if (streaming.has(thebeSessionId) && mode === "prompt") {
      throw httpError(
        409,
        "session is streaming; use steer or followUp",
      );
    }
    const queueOnly =
      (mode === "steer" || mode === "followUp") &&
      streaming.has(thebeSessionId);
    if (!queueOnly) {
      policy.beginRun();
      lastEvents.length = 0;
    }
    const body = asPromptInput(input);
    if (!opened.meta.title && body.text.trim()) {
      opened.meta.title = body.text.trim().slice(0, 80);
    }
    opened.meta = stamp(opened.meta);
    await persist(opened.meta);
    if (queueOnly) {
      if (mode === "steer") {
        await opened.session.steer(body.text);
      } else {
        await opened.session.followUp(body.text);
      }
      return {
        text: opened.session.lastAssistantText(),
        tools: opened.session
          .messages()
          .filter((message) => message.role === "tool")
          .map((message) => message.toolName)
          .filter((name): name is string => Boolean(name)),
        events: lastEvents.slice(),
        thebeSessionId,
      };
    }
    const guard = createStreamGuard({
      ttfbMs: options.ttfbMs,
      idleMs: options.idleMs,
      watchdogMs: options.watchdogMs,
      abort: () => opened.session.abort(),
      onEvent: (kind) => {
        void audit
          ?.append({
            method: `streamguard.${kind}`,
            parameterHash: hashParameters({}),
            responseBytes: 0,
            budgetConsumed: 0,
            redactionFired: false,
          })
          .catch(() => {});
      },
    });
    requestStop = () => opened.session.abort();
    const unsub = opened.session.subscribe((event) => {
      appendEvent(thebeSessionId, event);
      if (
        event.type === "text_delta" ||
        event.type === "tool_start" ||
        event.type === "tool_update" ||
        event.type === "tool_end"
      ) {
        guard.noteContent();
      }
      if (
        event.type === "session_end" ||
        event.type === "error" ||
        event.type === "interrupted"
      ) {
        guard.notifyAgentEnd();
      }
    });
    streaming.add(thebeSessionId);
    guard.beginRun();
    guard.armTtfb();
    try {
      if (mode === "steer") {
        await opened.session.steer(body.text);
      } else if (mode === "followUp") {
        await opened.session.followUp(body.text);
      } else {
        await opened.session.prompt(body);
      }
      const reply = opened.session.lastAssistantText();
      const tools = opened.session
        .messages()
        .filter((message) => message.role === "tool")
        .map((message) => message.toolName)
        .filter((name): name is string => Boolean(name));
      return {
        text: reply,
        tools,
        events: lastEvents.slice(),
        thebeSessionId,
      };
    } finally {
      streaming.delete(thebeSessionId);
      unsub();
      guard.dispose();
    }
  }

  async function listMetas(): Promise<ProductSessionMeta[]> {
    const fromStore = await store.list();
    if (fromStore.length > 0) {
      return fromStore;
    }
    return [...memory.values()];
  }

  return {
    runtime: options.runtime,
    async prompt(
      input: string | PromptInput,
      promptOptions?: ThebePromptOptions,
    ): Promise<ThebePromptResult> {
      return runPrompt(input, promptOptions);
    },
    async send(
      text: string,
      thebeSessionId?: string,
    ): Promise<ThebePromptResult> {
      return runPrompt(text, { thebeSessionId });
    },
    toolNames(): string[] {
      return [...builtinTools, ...CONTAINER_TOOL_NAMES];
    },
    lastThebeSessionId(): string | undefined {
      return active?.meta.thebeSessionId;
    },
    lastEvents(): NormalizedEvent[] {
      return lastEvents.slice();
    },
    events(thebeSessionId?: string): NormalizedEvent[] {
      const id = thebeSessionId ?? active?.meta.thebeSessionId;
      if (!id) {
        return [];
      }
      return sessionLog(id).events.slice();
    },
    subscribeLog(
      thebeSessionId: string,
      listener: (event: NormalizedEvent) => void,
    ): () => void {
      const log = sessionLog(thebeSessionId);
      log.listeners.add(listener);
      return () => {
        log.listeners.delete(listener);
      };
    },
    messages() {
      return active?.session.messages() ?? [];
    },
    async loadMessages(thebeSessionId: string) {
      const opened = await openSession(thebeSessionId);
      return opened.session.messages();
    },
    async message(thebeSessionId: string, messageId: string) {
      const opened = await openSession(thebeSessionId);
      return opened.session.messages().find((row) => row.id === messageId);
    },
    isStreaming(thebeSessionId: string): boolean {
      return streaming.has(thebeSessionId);
    },
    async createSession(): Promise<ProductSessionMeta> {
      const session = await options.runtime.createSession(sessionOptions());
      const meta = stamp({
        thebeSessionId: randomUUID(),
        runtimeId: options.runtime.runtimeId,
        runtimeSessionId: session.runtimeSessionId,
      });
      await persist(meta);
      active = { meta, session };
      return meta;
    },
    async listSessions(): Promise<ProductSessionMeta[]> {
      return listMetas();
    },
    async getSession(thebeSessionId: string): Promise<ProductSessionMeta> {
      return lookup(thebeSessionId);
    },
    async patchSession(
      thebeSessionId: string,
      patch: Partial<
        Pick<
          ProductSessionMeta,
          "title" | "labels" | "selectedContext" | "shareMetadata"
        >
      >,
    ): Promise<ProductSessionMeta> {
      const current = await lookup(thebeSessionId);
      const meta = stamp({
        ...current,
        title: patch.title ?? current.title,
        labels: patch.labels ?? current.labels,
        selectedContext: patch.selectedContext ?? current.selectedContext,
        shareMetadata: patch.shareMetadata ?? current.shareMetadata,
      });
      await persist(meta);
      if (active?.meta.thebeSessionId === thebeSessionId) {
        active.meta = meta;
      }
      return meta;
    },
    async deleteSession(thebeSessionId: string): Promise<void> {
      if (active?.meta.thebeSessionId === thebeSessionId) {
        active.session.dispose();
        active = undefined;
      }
      memory.delete(thebeSessionId);
      logs.delete(thebeSessionId);
      await store.delete(thebeSessionId);
    },
    async sessionStatus(): Promise<
      Array<ProductSessionMeta & { streaming: boolean }>
    > {
      const rows = await listMetas();
      return rows.map((row) => ({
        ...row,
        streaming: streaming.has(row.thebeSessionId),
      }));
    },
    async resume(thebeSessionId: string): Promise<ProductSessionMeta> {
      const opened = await openSession(thebeSessionId);
      return opened.meta;
    },
    async fork(
      thebeSessionId?: string,
      atEntryId?: string,
    ): Promise<ProductSessionMeta> {
      const source = thebeSessionId
        ? await lookup(thebeSessionId)
        : active?.meta;
      if (!source) {
        throw new Error("no session to fork");
      }
      const child = await options.runtime.forkSession(
        source.runtimeSessionId,
        sessionOptions(),
        atEntryId ? { atEntryId } : undefined,
      );
      const meta = stamp({
        thebeSessionId: randomUUID(),
        runtimeId: options.runtime.runtimeId,
        runtimeSessionId: child.runtimeSessionId,
        parentThebeSessionId: source.thebeSessionId,
        selectedContext: source.selectedContext,
        labels: source.labels,
        shareMetadata: source.shareMetadata,
        title: source.title,
      });
      await persist(meta);
      active = { meta, session: child };
      return meta;
    },
    async children(thebeSessionId: string): Promise<ProductSessionMeta[]> {
      const rows = await listMetas();
      return rows.filter((row) => row.parentThebeSessionId === thebeSessionId);
    },
    async compact(thebeSessionId?: string): Promise<void> {
      const opened = await openSession(thebeSessionId);
      await opened.session.compact();
    },
    async interrupt(thebeSessionId?: string): Promise<void> {
      const opened = await openSession(thebeSessionId);
      await opened.session.abort();
    },
    async revert(thebeSessionId?: string): Promise<void> {
      const opened = await openSession(thebeSessionId);
      await opened.session.revert();
    },
    async unrevert(thebeSessionId?: string): Promise<void> {
      const opened = await openSession(thebeSessionId);
      await opened.session.unrevert();
    },
    async resolvePermission(
      thebeSessionId: string,
      permissionId: string,
      decision: { response: "allow" | "deny"; remember?: boolean },
    ): Promise<void> {
      const pending = pendingPermissions.get(permissionId);
      if (!pending) {
        throw new Error(`unknown permission: ${permissionId}`);
      }
      pendingPermissions.delete(permissionId);
      if (decision.remember) {
        const meta = await lookup(thebeSessionId);
        meta.rememberedPermissions = {
          ...meta.rememberedPermissions,
          [pending.request.toolName]: decision.response,
        };
        await persist(stamp(meta));
        if (active?.meta.thebeSessionId === thebeSessionId) {
          active.meta = meta;
        }
      }
      pending.resolve(decision.response);
    },
    pendingPermissionIds(): string[] {
      return [...pendingPermissions.keys()];
    },
    async setModel(
      thebeSessionId: string,
      model: RuntimeModelRef,
    ): Promise<void> {
      const opened = await openSession(thebeSessionId);
      await opened.session.setModel(model);
    },
    async setThinkingLevel(
      thebeSessionId: string,
      level: ThinkingLevel,
    ): Promise<void> {
      const opened = await openSession(thebeSessionId);
      await opened.session.setThinkingLevel(level);
    },
    async listModels(query?: { all?: boolean }) {
      return options.runtime.listModels(query);
    },
    async listAvailableModels() {
      return options.runtime.listAvailableModels();
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
      const tools = wrapCustomTools(baseTools(), { policy, audit });
      const tool = tools.find((item) => item.name === name);
      if (!tool) {
        throw new Error(`unknown tool: ${name}`);
      }
      const result = await tool.execute("mcp", args ?? {});
      return result.content.map((block) => block.text).join("\n");
    },
    async enableResource(resource: EnabledResource): Promise<void> {
      enabledResources.push(resource);
      await audit?.append({
        method: "resource.enable",
        parameterHash: hashParameters(resource),
        responseBytes: 0,
        budgetConsumed: 0,
        redactionFired: false,
        identity: resource.identity,
        version: resource.version,
        source: resource.source,
      });
    },
    enabledResources(): EnabledResource[] {
      return enabledResources.slice();
    },
    auth() {
      return options.runtime.auth();
    },
  };
}

export type ThebeProduct = ReturnType<typeof createThebeProduct>;
