import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createThebeProduct } from "../../../product/service.ts";
import type { ContainerInfoProvider } from "../../../providers/index.ts";
import { loadPiSdk } from "../sdk/load-pi.ts";
import { createPiCodingAgentRuntime } from "../pi-coding-agent-runtime.ts";

const CANARY = "sk-canary-s3cret-leak";

function providerWithCanary(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => ({
      id: "abc123",
      name: "nginx",
      image: "nginx:1.27",
      state: "running",
      config: { env: [`API_TOKEN=${CANARY}`] },
    }),
    getContainerLogs: async () => `token=${CANARY}`,
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: 1,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

async function piProduct(provider: ContainerInfoProvider) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const { ModelRuntime } = await loadPiSdk();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.getModel().provider, "test-key");
  const dir = await mkdtemp(join(tmpdir(), "thebe-pi-tools-"));
  const runtime = await createPiCodingAgentRuntime({
    cwd: dir,
    sessionDir: join(dir, "sessions"),
    agentDir: join(dir, "agent"),
    inMemory: false,
    modelRuntime,
    model: faux.getModel(),
  });
  const product = createThebeProduct({
    runtime,
    provider,
    productStoreDir: join(dir, "meta"),
  });
  return { faux, product, runtime };
}

function dump(value: unknown): string {
  return JSON.stringify(value);
}

describe("mixed tools and redaction", () => {
  it("one session lists Pi built-ins and container tools", async () => {
    const { product } = await piProduct(providerWithCanary());
    expect(product.toolNames()).toEqual(
      expect.arrayContaining([
        "ls",
        "find",
        "grep",
        "read",
        "edit",
        "write",
        "bash",
        "container.list",
        "container.inspect",
        "container.logs",
        "container.status_summary",
      ]),
    );
  });

  it("canary is absent from events, Pi-facing messages, and export on success", async () => {
    const { faux, product } = await piProduct(providerWithCanary());
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("done"),
    ]);
    const result = await product.send("inspect");
    const exported = await product.exportSession();
    const blob = [
      dump(result.events),
      dump(product.messages()),
      exported.jsonl,
      exported.html,
    ].join("\n");
    expect(blob).not.toContain(CANARY);
  });

  it("canary is absent on fail, deny, and cancel paths", async () => {
    const throwing: ContainerInfoProvider = {
      ...providerWithCanary(),
      inspectContainer: async () => {
        throw new Error(`fail ${CANARY}`);
      },
    };
    const { faux, product } = await piProduct(throwing);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("failed"),
      fauxAssistantMessage([
        fauxToolCall("container.start", { id: "abc123" }),
      ]),
      fauxAssistantMessage("denied"),
    ]);
    await product.send("inspect");
    await product.send("start");
    const exported = await product.exportSession();
    const blob = [dump(product.messages()), dump(product.lastEvents()), exported.jsonl].join(
      "\n",
    );
    expect(blob).not.toContain(CANARY);

    const cancelling = await piProduct({
      ...providerWithCanary(),
      getContainerLogs: async () => {
        throw new Error(`cancel ${CANARY}`);
      },
    });
    cancelling.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.logs", { id: "abc123" }),
      ]),
      fauxAssistantMessage("cancelled"),
    ]);
    await cancelling.product.send("logs");
    const cancelBlob = dump(cancelling.product.messages());
    expect(cancelBlob).not.toContain(CANARY);
  });
});
