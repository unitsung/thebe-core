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
import { createThebeAgent } from "../../../agent/index.ts";
import type { ContainerInfoProvider } from "../../../agent/capabilities/containers.ts";
import { loadPiSdk } from "../sdk/load-pi.ts";
import { createPiCodingAgentRuntime } from "../runtime.ts";

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
  const agent = createThebeAgent({
    runtime,
    provider,
    agentStoreDir: join(dir, "meta"),
  });
  return { faux, agent, runtime };
}

function dump(value: unknown): string {
  return JSON.stringify(value);
}

describe("mixed tools and redaction", () => {
  it("one session lists Pi built-ins and container tools", async () => {
    const { agent } = await piProduct(providerWithCanary());
    expect(agent.toolNames()).toEqual(
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
    const { faux, agent } = await piProduct(providerWithCanary());
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("done"),
    ]);
    const result = await agent.send("inspect");
    const exported = await agent.exportSession();
    const blob = [
      dump(result.events),
      dump(agent.messages()),
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
    const { faux, agent } = await piProduct(throwing);
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
    await agent.send("inspect");
    await agent.send("start");
    const exported = await agent.exportSession();
    const blob = [dump(agent.messages()), dump(agent.lastEvents()), exported.jsonl].join(
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
    await cancelling.agent.send("logs");
    const cancelBlob = dump(cancelling.agent.messages());
    expect(cancelBlob).not.toContain(CANARY);
  });
});
