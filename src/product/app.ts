import type { ContainerInfoProvider } from "../providers/index.ts";
import type { AgentRuntime } from "../runtime/types.ts";
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
}): {
  product: ThebeProduct;
  prompt: ThebeAppPrompt;
  send: ThebeAppSend;
  handler: ReturnType<typeof createThebeHttpHandler>;
} {
  const product = createThebeProduct(options);
  const prompt: ThebeAppPrompt = async (text) => {
    const result = await product.prompt(text);
    return { text: result.text, tools: result.tools };
  };
  const handler = createThebeHttpHandler({
    version: options.version ?? "0.1.0",
    token: options.token,
    product,
  });
  return { product, prompt, send: prompt, handler };
}
