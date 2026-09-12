import type { ContainerInfoProvider } from "../providers/index.ts";
import type { AgentRuntime } from "../runtime/types.ts";
import { resolveAllowedHosts } from "../http/bind.ts";
import { createThebeHttpHandler } from "../http/handler.ts";
import { createThebeProduct, type ThebeProduct } from "./service.ts";

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
  productStoreDir?: string;
  now?: () => Date;
  callerId?: string;
  model?: import("../runtime/types.ts").RuntimeModelRef;
  allowedHosts?: string[];
  sessionIdleTimeoutMs?: number;
  autoCompact?: boolean;
  autoSummary?: boolean;
  autoSummaryDelayMs?: number;
  permissionMode?: import("../runtime/types.ts").PermissionMode;
  maxSubagentConcurrency?: number;
  maxSubagentsPerParent?: number;
}): {
  product: ThebeProduct;
  prompt: ThebeAppPrompt;
  send: ThebeAppSend;
  handler: ReturnType<typeof createThebeHttpHandler>;
} {
  const product = createThebeProduct({
    runtime: options.runtime,
    provider: options.provider,
    auditPath: options.auditPath,
    productStoreDir: options.productStoreDir,
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
  });
  const prompt: ThebeAppPrompt = async (text) => {
    const result = await product.prompt(text);
    return { text: result.text, tools: result.tools };
  };
  const handler = createThebeHttpHandler({
    version: options.version ?? "0.1.0",
    token: options.token,
    product,
    allowedHosts: options.allowedHosts ?? resolveAllowedHosts("127.0.0.1"),
  });
  return { product, prompt, send: prompt, handler };
}
