import type { ContainerInfoProvider } from "../providers/index.ts";
import { createThebeProduct, type ThebeProduct } from "../product/service.ts";
import type { AgentRuntime, EnabledResource } from "../runtime/types.ts";

export function createThebeAgent(options: {
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
  const product = createThebeProduct(options);
  return {
    product,
    toolNames(): string[] {
      return product.toolNames();
    },
    messages() {
      return product.messages();
    },
    lastThebeSessionId(): string | undefined {
      return product.lastThebeSessionId();
    },
    lastEvents() {
      return product.lastEvents();
    },
    async ask(input: string): Promise<string> {
      const result = await product.ask(input);
      return result.text;
    },
    async exportLastSession() {
      return product.exportSession();
    },
    async fork() {
      return product.fork();
    },
    async compact() {
      return product.compact();
    },
    async enableResource(resource: EnabledResource) {
      return product.enableResource(resource);
    },
    auth() {
      return product.auth();
    },
  };
}

export type ThebeAgent = ReturnType<typeof createThebeAgent>;
export type { ThebeProduct };
