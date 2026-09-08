import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ArcaneAdapter } from "./adapters/arcane-adapter.ts";
import { applyThebeApiKey } from "./auth/credentials.ts";
import { envLocalCandidates, loadEnvLocal } from "./env.ts";
import { createThebeApp } from "./product/app.ts";
import type { ThebeProduct } from "./product/service.ts";
import type { ContainerInfoProvider } from "./providers/index.ts";
import { createPiCodingAgentRuntime } from "./runtime/pi/pi-coding-agent-runtime.ts";
import type { AgentRuntime } from "./runtime/types.ts";

export type ThebeBootstrap = {
  runtime: AgentRuntime;
  product: ThebeProduct;
  prompt: (
    text: string,
  ) => Promise<{ text: string; tools: string[] }>;
  send: (
    text: string,
  ) => Promise<{ text: string; tools: string[] }>;
  handler: ReturnType<typeof createThebeApp>["handler"];
  version: string;
};

export type BootstrapOptions = {
  fromDir?: string;
  requireArcane?: boolean;
  model?: { providerId: string; modelId: string };
};

/**
 * Shared factory for serve / CLI / TUI. Loads `.env.local`, embeds Pi via
 * AgentRuntime, and returns a product service — never spawns the Pi CLI.
 */
export async function bootstrapThebe(
  options?: BootstrapOptions,
): Promise<ThebeBootstrap> {
  const fromDir = options?.fromDir ?? dirname(fileURLToPath(import.meta.url));
  loadEnvLocal(fromDir);

  const requireArcane = options?.requireArcane ?? false;
  const baseUrl = process.env.ARCANE_BASE_URL;
  const arcaneKey = process.env.ARCANE_API_KEY;
  const openCodeKey = process.env.OPENCODE_API_KEY;

  if (!openCodeKey) {
    failEnv("Missing OPENCODE_API_KEY", fromDir);
  }
  if (requireArcane && (!baseUrl || !arcaneKey)) {
    failEnv("Missing ARCANE_BASE_URL or ARCANE_API_KEY", fromDir);
  }

  const defaultModel = options?.model ?? {
    providerId: "opencode",
    modelId: "muse-spark-1.3-free",
  };

  const runtime = await createPiCodingAgentRuntime({
    cwd: process.cwd(),
    sessionDir: process.env.THEBE_SESSION_DIR,
    agentDir: process.env.THEBE_AGENT_DIR,
    apiKey: { providerId: "opencode", key: openCodeKey! },
    model: defaultModel,
  });
  await applyThebeApiKey(runtime.auth(), "opencode", openCodeKey!);

  const provider: ContainerInfoProvider =
    baseUrl && arcaneKey
      ? new ArcaneAdapter({ baseUrl, apiKey: arcaneKey })
      : stubProvider();

  const version = readPackageVersion(fromDir);
  const productStoreDir =
    process.env.THEBE_PRODUCT_STORE_DIR ??
    join(process.env.HOME ?? ".", ".thebe", "sessions");

  const app = createThebeApp({
    runtime,
    provider,
    version,
    token: process.env.THEBE_TOKEN,
    productStoreDir,
    auditPath: process.env.THEBE_AUDIT_PATH,
    model: defaultModel,
  });

  return {
    runtime,
    product: app.product,
    prompt: app.prompt,
    send: app.send,
    handler: app.handler,
    version,
  };
}

function failEnv(message: string, fromDir: string): never {
  console.error(message);
  console.error("Put them in .env.local. Looked in:");
  for (const path of envLocalCandidates(fromDir)) {
    console.error(`  ${path}`);
  }
  process.exit(1);
}

function stubProvider(): ContainerInfoProvider {
  return {
    async listContainers() {
      return [];
    },
    async inspectContainer() {
      throw new Error("Arcane is not configured");
    },
    async getContainerLogs() {
      throw new Error("Arcane is not configured");
    },
    async getStatusSummary() {
      return {
        totalContainers: 0,
        runningContainers: 0,
        pausedContainers: 0,
        exitedContainers: 0,
        lastUpdated: Date.now(),
      };
    },
  };
}

function readPackageVersion(fromDir: string): string {
  let dir = fromDir;
  for (let i = 0; i < 6; i++) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { version?: string };
      if (parsed.version) {
        return parsed.version;
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "0.1.0";
}
