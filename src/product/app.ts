import type { ContainerInfoProvider } from "../providers/index.ts";
import type { AgentRuntime } from "../runtime/types.ts";
import { createThebeHttpHandler } from "../http/handler.ts";
import { createThebeProduct, type ThebeProduct } from "./service.ts";

export type ThebeAppAsk = (
  text: string,
) => Promise<{ text: string; tools: string[] }>;

export function createThebeApp(options: {
  runtime: AgentRuntime;
  provider: ContainerInfoProvider;
  version?: string;
  token?: string;
  auditPath?: string;
  productStoreDir?: string;
  now?: () => Date;
  callerId?: string;
}): {
  product: ThebeProduct;
  ask: ThebeAppAsk;
  handler: ReturnType<typeof createThebeHttpHandler>;
} {
  const product = createThebeProduct(options);
  const ask: ThebeAppAsk = async (text) => {
    const result = await product.ask(text);
    return { text: result.text, tools: result.tools };
  };
  const handler = createThebeHttpHandler({
    version: options.version ?? "0.1.0",
    provider: options.provider,
    token: options.token,
    product,
    ask,
  });
  return { product, ask, handler };
}
