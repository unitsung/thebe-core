import { describe, expect, it } from "vitest";
import type {
  ContainerDetail,
  ContainerInfoProvider,
  ContainerSummary,
  HostStatusSummary,
} from "../capabilities/containers.ts";
import { createToolLayer } from "./tool-layer.ts";

function fakeProvider(opts: {
  list?: ContainerSummary[];
  inspect?: ContainerDetail;
  logs?: string;
  summary?: HostStatusSummary;
}): ContainerInfoProvider {
  return {
    listContainers: async () => opts.list ?? [],
    inspectContainer: async () => {
      if (!opts.inspect) {
        throw new Error("inspect not used");
      }
      return opts.inspect;
    },
    getContainerLogs: async () => {
      if (opts.logs === undefined) {
        throw new Error("logs not used");
      }
      return opts.logs;
    },
    getStatusSummary: async () => {
      if (!opts.summary) {
        throw new Error("summary not used");
      }
      return opts.summary;
    },
  };
}

describe("Tool Layer", () => {
  it("container.list returns container summaries from ContainerInfoProvider", async () => {
    const tools = createToolLayer(
      fakeProvider({
        list: [
          {
            id: "abc123",
            name: "nginx",
            image: "nginx:1.27",
            state: "running",
            status: "Up 3 hours",
            created: 1_700_000_000,
          },
        ],
      }),
    );
    await expect(tools.invoke("container.list")).resolves.toEqual([
      {
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        status: "Up 3 hours",
        created: 1_700_000_000,
      },
    ]);
  });

  it("container.inspect redacts SECRET TOKEN KEY PASSWORD PASS CREDENTIAL PRIVATE keys", async () => {
    const tools = createToolLayer(
      fakeProvider({
        inspect: {
          id: "abc123",
          name: "nginx",
          image: "nginx:1.27",
          state: "running",
          config: {
            env: [
              "API_SECRET=s3cret",
              "auth_token=abc",
              "Service-Key=k",
              "DB_PASSWORD=p",
              "DB_PASS=p2",
              "APP_CREDENTIAL=c",
              "TLS_PRIVATE=x",
              "NODE_ENV=production",
            ],
          },
        },
      }),
    );
    const result = (await tools.invoke("container.inspect", {
      id: "abc123",
    })) as { config: { env?: string[] } };
    expect(result.config.env).toEqual([
      "API_SECRET=***REDACTED***",
      "auth_token=***REDACTED***",
      "Service-Key=***REDACTED***",
      "DB_PASSWORD=***REDACTED***",
      "DB_PASS=***REDACTED***",
      "APP_CREDENTIAL=***REDACTED***",
      "TLS_PRIVATE=***REDACTED***",
      "NODE_ENV=production",
    ]);
  });

  it("container.inspect redacts secret env before returning detail", async () => {
    const tools = createToolLayer(
      fakeProvider({
        inspect: {
          id: "abc123",
          name: "nginx",
          image: "nginx:1.27",
          state: "running",
          config: {
            env: ["NODE_ENV=production", "API_TOKEN=s3cret"],
            cmd: ["nginx"],
          },
        },
      }),
    );
    await expect(
      tools.invoke("container.inspect", { id: "abc123" }),
    ).resolves.toEqual({
      id: "abc123",
      name: "nginx",
      image: "nginx:1.27",
      state: "running",
      config: {
        env: ["NODE_ENV=production", "API_TOKEN=***REDACTED***"],
        cmd: ["nginx"],
      },
    });
  });

  it("container.logs redacts tokens and truncates to 200 lines", async () => {
    const hex = "a".repeat(40);
    const lines = [
      ...Array.from({ length: 201 }, (_, i) => `L${i}`),
      `token=sk-live-abc123 hex=${hex}`,
    ];
    const tools = createToolLayer(fakeProvider({ logs: lines.join("\n") }));
    const result = await tools.invoke("container.logs", { id: "abc123" });
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text.startsWith("[... truncated ...]\n")).toBe(true);
    expect(text).toContain("token=***REDACTED***");
    expect(text).toContain("hex=***REDACTED***");
    expect(text).not.toContain("sk-live-abc123");
    expect(text.split("\n")).toHaveLength(201);
  });

  it("container.status_summary returns host counts from ContainerInfoProvider", async () => {
    const tools = createToolLayer(
      fakeProvider({
        summary: {
          totalContainers: 4,
          runningContainers: 2,
          pausedContainers: 1,
          exitedContainers: 1,
          lastUpdated: 1_700_000_100,
        },
      }),
    );
    await expect(tools.invoke("container.status_summary")).resolves.toEqual({
      totalContainers: 4,
      runningContainers: 2,
      pausedContainers: 1,
      exitedContainers: 1,
      lastUpdated: 1_700_000_100,
    });
  });

  it("rejects a method name that is not one of the four container tools", async () => {
    const tools = createToolLayer(fakeProvider({}));
    await expect(tools.invoke("container.start")).rejects.toThrow(
      "unknown tool: container.start",
    );
  });
});
