import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { createAgentAdapter } from "../agent-adapter/index.ts";
import { createAuditLog, hashParameters } from "../audit/audit-log.ts";
import { createPolicyEngine } from "../policy/policy-engine.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { createRunStore } from "../run-store/index.ts";
import {
  CONTAINER_TOOL_NAMES,
  createContainerTools,
} from "../tools/container-tools.ts";

export function createThebeAgent(options: {
  model: Model<string>;
  streamFn: StreamFn;
  provider: ContainerInfoProvider;
  auditPath?: string;
  runStoreDir?: string;
  now?: () => Date;
  callerId?: string;
  getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  maxToolCalls?: number;
  maxBlocks?: number;
  ttfbMs?: number;
  idleMs?: number;
  watchdogMs?: number;
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
  const tools = createContainerTools(options.provider, {
    policy,
    audit,
    callerId,
  });
  const allowed = new Set<string>(CONTAINER_TOOL_NAMES);
  const auditedUnknown = new Set<string>();
  const adapter = createAgentAdapter({
    model: options.model,
    streamFn: options.streamFn,
    tools,
    toolExecution: "sequential",
    getApiKey: options.getApiKey,
    beforeToolCall: (ctx) => policy.beforeToolCall(ctx),
    shouldStopAfterTurn: () => policy.shouldStopAfterTurn(),
    ttfbMs: options.ttfbMs,
    idleMs: options.idleMs,
    watchdogMs: options.watchdogMs,
    onStreamGuardEvent: (kind) => {
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
  const runStore = createRunStore(options.runStoreDir, now);
  let runSeq = 0;
  let currentRunId: string | undefined;
  let messagesBeforeRun = 0;
  let persistedForRun: string | undefined;
  let recordedForRun = false;

  async function persistCurrentRun(): Promise<void> {
    if (!currentRunId) {
      return;
    }
    if (!recordedForRun) {
      runStore.recordMessages(adapter.messages().slice(messagesBeforeRun));
      recordedForRun = true;
    }
    if (persistedForRun === currentRunId) {
      return;
    }
    if (!options.runStoreDir) {
      persistedForRun = currentRunId;
      return;
    }
    const reply = adapter.lastReply();
    try {
      await runStore.save({
        runId: currentRunId,
        systemPrompt: adapter.systemPrompt(),
        messages: adapter.messages().slice(),
        tools: adapter.toolNames(),
        status: adapter.wasForceKilled()
          ? "force-killed"
          : reply.kind !== "ok"
            ? "failed"
            : "done",
      });
      persistedForRun = currentRunId;
    } catch {
      // snapshot is best-effort; Ask still returns or throws from the reply
    }
  }

  adapter.subscribe(async (event) => {
    if (event.type !== "agent_end") {
      return;
    }
    await persistCurrentRun();
  });

  async function auditUnknownToolResults(
    messages: AgentMessage[],
  ): Promise<void> {
    if (!audit) {
      return;
    }
    for (const message of messages) {
      if (message.role !== "toolResult" || !message.isError) {
        continue;
      }
      if (allowed.has(message.toolName)) {
        continue;
      }
      if (auditedUnknown.has(message.toolCallId)) {
        continue;
      }
      auditedUnknown.add(message.toolCallId);
      await audit.append({
        method: message.toolName,
        parameterHash: hashParameters(
          argumentsForToolCall(messages, message.toolCallId),
        ),
        responseBytes: 0,
        budgetConsumed: 0,
        redactionFired: false,
      });
    }
  }

  return {
    toolNames(): string[] {
      return adapter.toolNames();
    },
    toolExecution(): "sequential" {
      return adapter.toolExecution;
    },
    messages(): AgentMessage[] {
      return adapter.messages();
    },
    async ask(input: string): Promise<string> {
      policy.beginRun();
      runStore.resetLedger();
      runSeq += 1;
      currentRunId = `run-${now().toISOString().replace(/[:.]/g, "-")}-${runSeq}`;
      persistedForRun = undefined;
      recordedForRun = false;
      messagesBeforeRun = adapter.messages().length;
      await adapter.prompt(input);
      await persistCurrentRun();
      await auditUnknownToolResults(adapter.messages());
      const reply = adapter.lastReply();
      if (reply.kind === "missing") {
        throw new Error("Ask did not produce an assistant reply");
      }
      if (reply.kind === "sentinel") {
        throw new Error(reply.errorMessage);
      }
      return reply.text;
    },
  };
}

function argumentsForToolCall(
  messages: AgentMessage[],
  toolCallId: string,
): unknown {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "toolCall" &&
        "id" in block &&
        block.id === toolCallId &&
        "arguments" in block
      ) {
        return block.arguments;
      }
    }
  }
  return {};
}
