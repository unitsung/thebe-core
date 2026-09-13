import type { ContainerInfoProvider } from "../agent/capabilities/containers.ts";
import type { AgentRuntime } from "../agent/runtime/interface.ts";
import { resolveAllowedHosts } from "../delivery/http/bind.ts";
import { createThebeHttpHandler } from "../delivery/http/handler.ts";
import { createThebeAgent, type ThebeAgent } from "../agent/index.ts";
import { createMcpClientRegistry } from "../adapters/mcp/index.ts";

export type ThebeAppPrompt = (
  text: string,
) => Promise<{ text: string; tools: string[] }>;

/** @deprecated Use ThebeAppPrompt */
export type ThebeAppSend = ThebeAppPrompt;

export function createThebeApp(options: {
  runtime: AgentRuntime;
  provider: ContainerInfoProvider;
  version?: string;
  token?: string;
  auditPath?: string;
  agentStoreDir?: string;
  now?: () => Date;
  callerId?: string;
  model?: import("../agent/runtime/interface.ts").RuntimeModelRef;
  allowedHosts?: string[];
  sessionIdleTimeoutMs?: number;
  autoCompact?: boolean;
  autoSummary?: boolean;
  autoSummaryDelayMs?: number;
  permissionMode?: import("../agent/runtime/interface.ts").PermissionMode;
  maxSubagentConcurrency?: number;
  maxSubagentsPerParent?: number;
  workspacePath?: string;
  outputDirectory?: string;
}): {
  agent: ThebeAgent;
  prompt: ThebeAppPrompt;
  send: ThebeAppSend;
  handler: ReturnType<typeof createThebeHttpHandler>;
} {
  const agent = createThebeAgent({
    runtime: options.runtime,
    provider: options.provider,
    auditPath: options.auditPath,
    agentStoreDir: options.agentStoreDir,
    now: options.now,
    callerId: options.callerId,
    model: options.model,
    sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
    autoCompact: options.autoCompact,
    autoSummary: options.autoSummary,
    autoSummaryDelayMs: options.autoSummaryDelayMs,
    permissionMode: options.permissionMode,
    maxSubagentConcurrency: options.maxSubagentConcurrency,
    maxSubagentsPerParent: options.maxSubagentsPerParent,
    workspacePath: options.workspacePath,
    outputDirectory: options.outputDirectory,
    mcp: createMcpClientRegistry({ cwd: options.workspacePath }),
  });
  const prompt: ThebeAppPrompt = async (text) => {
    const result = await agent.prompt(text);
    return { text: result.text, tools: result.tools };
  };
  const handler = createThebeHttpHandler({
    version: options.version ?? "0.1.0",
    token: options.token,
    agent,
    allowedHosts: options.allowedHosts ?? resolveAllowedHosts("127.0.0.1"),
  });
  return { agent, prompt, send: prompt, handler };
}
