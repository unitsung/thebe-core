import { describe, expect, it } from "vitest";
import {
  ProviderError,
  type ContainerInfoProvider,
} from "../capabilities/containers.ts";
import { createThebeAgent } from "../create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

const SECRET = "sk-live-diagnosis-secret";

function embyProvider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async (id: string) => ({
      id,
      name: "emby",
      image: "emby/embyserver:4.8",
      state: "exited",
      config: {
        env: [`API_TOKEN=${SECRET}`, "UID=1000"],
        cmd: ["/init"],
        labels: { "com.docker.compose.service": "emby" },
      },
    }),
    getContainerLogs: async () =>
      ["boot", `token=${SECRET}`, "fatal: database locked"].join("\n"),
    getStatusSummary: async () => ({
      totalContainers: 4,
      runningContainers: 3,
      pausedContainers: 0,
      exitedContainers: 1,
      lastUpdated: 1,
    }),
  };
}

describe("container diagnosis service", () => {
  it("collects redacted observations and returns a structured result without dumping inspect", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: embyProvider(),
    });
    const result = await agent.diagnose({
      resource: {
        kind: "container",
        id: "ctr-emby",
        name: "emby",
        provider: "arcane",
        instanceId: "arcane-1",
        environmentId: "0",
      },
    });
    expect(result.actionId).toBe("container.diagnose");
    expect(result.status).toBe("completed");
    expect(result.resource.id).toBe("ctr-emby");
    expect(
      result.observations.some((item) => item.source === "container.inspect")
    ).toBe(true);
    expect(
      result.observations.every((item) => item.observedAt.length > 0)
    ).toBe(true);
    expect(result.diagnosis.code).toBe("container_exited");
    expect(result.diagnosis.tokenUsed).toBe(false);
    const raw = JSON.stringify(result);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("API_TOKEN=sk-");
    expect(result.technicalDetails.toolTranscript.length).toBeGreaterThan(0);
  });

  it("maps provider unavailability without invented facts", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: {
        listContainers: async () => [],
        inspectContainer: async () => {
          throw new ProviderError("UNREACHABLE", "Arcane is down");
        },
        getContainerLogs: async () => {
          throw new ProviderError("UNREACHABLE", "Arcane is down");
        },
        getStatusSummary: async () => {
          throw new ProviderError("UNREACHABLE", "Arcane is down");
        },
      },
    });
    const result = await agent.diagnose({
      resource: { kind: "container", id: "ctr-emby", provider: "arcane" },
    });
    expect(result.status).toBe("provider_unavailable");
    expect(result.observations).toEqual([]);
    expect(result.diagnosis.code).toBe("provider_unavailable");
    expect(result.diagnosis.tokenUsed).toBe(false);
  });

  it("does not let the model invent a cause when tools only return errors", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([
      { kind: "text", text: '{"code":"invented","title":"nope"}' },
    ]);
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: {
        listContainers: async () => [],
        inspectContainer: async () => {
          throw new Error("not found");
        },
        getContainerLogs: async () => {
          throw new Error("not found");
        },
        getStatusSummary: async () => {
          throw new Error("not found");
        },
      },
    });
    const result = await agent.diagnose({
      resource: { kind: "container", id: "missing", provider: "arcane" },
    });
    expect(result.diagnosis.tokenUsed).toBe(false);
    expect(result.diagnosis.code).not.toBe("invented");
    expect(
      result.observations.every((item) => item.source.startsWith("container."))
    ).toBe(true);
  });

  it("recommends a restart, pending approval, for an exited container", async () => {
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: embyProvider(),
    });
    const result = await agent.diagnose({
      resource: {
        kind: "container",
        id: "ctr-emby",
        name: "emby",
        provider: "arcane",
      },
    });
    expect(
      result.recommendations.some((item) => item.id === "rec-restart")
    ).toBe(true);
  });

  it("updates the linked Artifact when explaining a diagnosis", async () => {
    let tick = 0;
    const fake = createFakeRuntime();
    const agent = createThebeAgent({
      runtime: fake.runtime,
      provider: embyProvider(),
      now: () => new Date(`2026-09-21T00:00:0${tick++}.000Z`),
    });
    const initial = await agent.diagnose({
      resource: {
        kind: "container",
        id: "ctr-emby",
        name: "emby",
        provider: "arcane",
      },
    });
    const initialArtifact = await agent.getArtifactContent(initial.artifactId!);
    expect(initialArtifact?.content).not.toContain("why-reasoning");

    fake.queueTurns([
      {
        kind: "text",
        text: JSON.stringify({
          code: "container_exited",
          title: "Container is not running",
          summary: "The container exited after a database lock.",
          confidence: "high",
          reasoning: "why-reasoning",
          recommendations: [],
        }),
      },
    ]);
    const explained = await agent.explainDiagnosis(
      initial.runId,
      "Why did this happen?"
    );

    expect(explained.artifactId).toBe(initial.artifactId);
    const updatedArtifact = await agent.getArtifactContent(initial.artifactId!);
    expect(updatedArtifact?.content).toContain("why-reasoning");
    expect(updatedArtifact?.artifact.updatedAt).not.toBe(
      initialArtifact?.artifact.updatedAt
    );
  });
});
