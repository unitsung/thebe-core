import { randomUUID } from "node:crypto";
import { createAuditLog, hashParameters } from "../audit/audit-log.ts";
import { createPolicyEngine } from "../policy/policy-engine.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import {
  PI_BUILTIN_TOOLS,
  type AgentRuntime,
  type EnabledResource,
  type NormalizedEvent,
  type RuntimeExport,
  type RuntimeSession,
} from "../runtime/types.ts";
import { createStreamGuard } from "../stream-guard/index.ts";
import {
  CONTAINER_TOOL_NAMES,
  createContainerTools,
} from "../tools/container-tools.ts";
import { createProductStore, type ProductSessionMeta } from "./store.ts";
import { wrapCustomTools } from "./wrap-tools.ts";

export type ThebeAskResult = {
  text: string;
  tools: string[];
  events: NormalizedEvent[];
  thebeSessionId: string;
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
  let requestStop: () => void | Promise<void> = () => {};

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
    const meta: ProductSessionMeta = {
      thebeSessionId: randomUUID(),
      runtimeId: options.runtime.runtimeId,
      runtimeSessionId: session.runtimeSessionId,
    };
    await persist(meta);
    active = { meta, session };
    return active;
  }

  async function prompt(
    text: string,
    thebeSessionId?: string,
  ): Promise<ThebeAskResult> {
    policy.beginRun();
    lastEvents.length = 0;
    const opened = await openSession(thebeSessionId);
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
      lastEvents.push(event);
      if (
        event.type === "text_delta" ||
        event.type === "tool_start" ||
        event.type === "tool_update" ||
        event.type === "tool_end"
      ) {
        guard.noteContent();
      }
      if (event.type === "session_end" || event.type === "error") {
        guard.notifyAgentEnd();
      }
    });
    guard.beginRun();
    guard.armTtfb();
    try {
      await opened.session.prompt(text);
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
        thebeSessionId: opened.meta.thebeSessionId,
      };
    } finally {
      unsub();
      guard.dispose();
    }
  }

  return {
    runtime: options.runtime,
    async ask(text: string, thebeSessionId?: string): Promise<ThebeAskResult> {
      return prompt(text, thebeSessionId);
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
    messages() {
      return active?.session.messages() ?? [];
    },
    async createSession(): Promise<ProductSessionMeta> {
      const session = await options.runtime.createSession(sessionOptions());
      const meta: ProductSessionMeta = {
        thebeSessionId: randomUUID(),
        runtimeId: options.runtime.runtimeId,
        runtimeSessionId: session.runtimeSessionId,
      };
      await persist(meta);
      active = { meta, session };
      return meta;
    },
    async listSessions(): Promise<ProductSessionMeta[]> {
      const fromStore = await store.list();
      if (fromStore.length > 0) {
        return fromStore;
      }
      return [...memory.values()];
    },
    async resume(thebeSessionId: string): Promise<ProductSessionMeta> {
      const opened = await openSession(thebeSessionId);
      return opened.meta;
    },
    async fork(thebeSessionId?: string): Promise<ProductSessionMeta> {
      const source = thebeSessionId
        ? await lookup(thebeSessionId)
        : active?.meta;
      if (!source) {
        throw new Error("no session to fork");
      }
      const child = await options.runtime.forkSession(
        source.runtimeSessionId,
        sessionOptions(),
      );
      const meta: ProductSessionMeta = {
        thebeSessionId: randomUUID(),
        runtimeId: options.runtime.runtimeId,
        runtimeSessionId: child.runtimeSessionId,
        selectedContext: source.selectedContext,
        labels: source.labels,
        shareMetadata: source.shareMetadata,
      };
      await persist(meta);
      active = { meta, session: child };
      return meta;
    },
    async compact(): Promise<void> {
      if (!active) {
        throw new Error("no active session");
      }
      await active.session.compact();
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
