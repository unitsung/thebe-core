import { describe, expect, it } from "vitest";
import {
  CONTAINER_RESTART_METADATA,
  ProviderError,
  type ContainerDetail,
  type ContainerInfoProvider,
} from "../capabilities/containers.ts";
import { createThebeAgent } from "../create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createActionApi } from "./service.ts";
import { decide, createPolicyRunState } from "../security/policy/policy-engine.ts";

function embyDetail(state: string): ContainerDetail {
  return {
    id: "ctr-emby",
    name: "emby",
    image: "emby/embyserver:4.8",
    state,
    config: { labels: { "com.docker.compose.service": "emby" } },
    networkSettings: {
      ports: {
        "8096/tcp": [{ HostIp: "0.0.0.0", HostPort: "8096" }],
      },
    },
  };
}

function provider(opts: {
  state?: string;
  restart?: () => Promise<void>;
}): ContainerInfoProvider & { restarts: number } {
  let state = opts.state ?? "exited";
  const box = {
    restarts: 0,
    listContainers: async () => [],
    inspectContainer: async () => embyDetail(state),
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: state === "running" ? 1 : 0,
      pausedContainers: 0,
      exitedContainers: state === "exited" ? 1 : 0,
      lastUpdated: 1,
    }),
    restartContainer: async () => {
      box.restarts += 1;
      if (opts.restart) await opts.restart();
      else state = "running";
    },
  };
  return box;
}

const resource = {
  kind: "container" as const,
  id: "ctr-emby",
  name: "emby",
  provider: "arcane" as const,
};

describe("container.restart policy metadata", () => {
  it("is write, disruptive, and approval-required from code", () => {
    expect(CONTAINER_RESTART_METADATA).toEqual({
      effect: "write",
      risk: "disruptive",
      approval: "required",
      permission: "confirm",
    });
    const decision = decide({
      toolName: "container.restart",
      runState: createPolicyRunState(),
      maxToolCalls: 50,
      maxBlocks: 3,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.reason).toMatch(/approval/);
    }
  });
});

describe("approved restart action", () => {
  it("rejects execution without on-device approval", async () => {
    const boxes = provider({});
    const api = createActionApi({ now: () => new Date("2026-09-17T00:00:00Z"), provider: boxes });
    const receipt = await api.executeApprovedAction({
      actionId: "container.restart",
      resource,
      approval: { approved: false },
      idempotencyKey: "deny-1",
    });
    expect(receipt.action.status).toBe("rejected");
    expect(receipt.approval.approved).toBe(false);
    expect(receipt.approval.capability.approval).toBe("required");
    expect(receipt.verification.status).toBe("skipped");
    expect(boxes.restarts).toBe(0);
  });

  it("writes an activity record for rejected and successful outcomes", async () => {
    const { createActivityStore } = await import("../activity/store.ts");
    const store = createActivityStore({ now: () => new Date("2026-09-17T00:00:00Z") });
    const boxes = provider({});
    const api = createActionApi({
      now: () => new Date("2026-09-17T00:00:00Z"),
      provider: boxes,
      activityStore: store,
    });
    await api.executeApprovedAction({
      actionId: "container.restart",
      resource,
      approval: { approved: false },
      idempotencyKey: "deny-activity",
    });
    await api.executeApprovedAction({
      actionId: "container.restart",
      resource,
      approval: { approved: true },
      idempotencyKey: "ok-activity",
    });
    const listed = await api.listActivity();
    expect(listed.map((item) => item.status).sort()).toEqual(["rejected", "succeeded"]);
  });

  it("restarts, verifies running, and probes Emby when available", async () => {
    const boxes = provider({});
    const api = createActionApi({
      now: () => new Date("2026-09-17T00:00:00Z"),
      provider: boxes,
      probe: async (url) => {
        expect(url).toContain(":8096");
        return { ok: true, status: 200 };
      },
    });
    const receipt = await api.executeApprovedAction({
      actionId: "container.restart",
      resource,
      approval: { approved: true, approvedAt: "2026-09-17T00:00:00Z", client: "ios" },
      idempotencyKey: "ok-1",
    });
    expect(boxes.restarts).toBe(1);
    expect(receipt.action.status).toBe("succeeded");
    expect(receipt.verification.status).toBe("passed");
    expect(receipt.verification.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "container.state", ok: true, actual: "running" }),
        expect.objectContaining({ id: "emby.health", ok: true }),
      ]),
    );
    expect(receipt.tokenUsed).toBe(false);
  });

  it("records verification failure when state is not running", async () => {
    const boxes = provider({
      restart: async () => undefined,
    });
    const api = createActionApi({ now: () => new Date(), provider: boxes });
    const receipt = await api.executeApprovedAction({
      actionId: "container.restart",
      resource,
      approval: { approved: true },
      idempotencyKey: "verify-fail",
    });
    expect(receipt.action.status).toBe("succeeded");
    expect(receipt.verification.status).toBe("failed");
    expect(receipt.verification.checks[0]).toEqual(
      expect.objectContaining({ id: "container.state", ok: false, actual: "exited" }),
    );
  });

  it("maps provider unavailability without executing verification inventing facts", async () => {
    const boxes = provider({
      restart: async () => {
        throw new ProviderError("UNREACHABLE", "Arcane is down");
      },
    });
    const api = createActionApi({ now: () => new Date(), provider: boxes });
    const receipt = await api.executeApprovedAction({
      actionId: "container.restart",
      resource,
      approval: { approved: true },
      idempotencyKey: "down-1",
    });
    expect(receipt.action.status).toBe("provider_unavailable");
    expect(receipt.verification.checks).toEqual([]);
  });

  it("returns the same receipt for a duplicate idempotency key", async () => {
    const boxes = provider({});
    const api = createActionApi({ now: () => new Date(), provider: boxes });
    const first = await api.executeApprovedAction({
      actionId: "container.restart",
      resource,
      approval: { approved: true },
      idempotencyKey: "same",
    });
    const second = await api.executeApprovedAction({
      actionId: "container.restart",
      resource,
      approval: { approved: true },
      idempotencyKey: "same",
    });
    expect(second.receiptId).toBe(first.receiptId);
    expect(boxes.restarts).toBe(1);
  });
});

describe("agent invokeTool cannot bypass approval", () => {
  it("refuses container.restart on the MCP/tool path", async () => {
    const agent = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: provider({}),
    });
    await expect(agent.invokeTool("container.restart", { id: "ctr-emby" })).rejects.toThrow(
      /approval/,
    );
  });
});
