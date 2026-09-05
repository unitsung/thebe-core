import { describe, expect, it } from "vitest";
import { ProviderError } from "../providers/index.ts";
import { ArcaneAdapter } from "./arcane-adapter.ts";

function jsonResponse(status: number, body: unknown): Response {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ArcaneAdapter", () => {
  it("lists containers with X-Api-Key and maps summaries", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const adapter = new ArcaneAdapter({
      baseUrl: "https://arcane.internal:3552",
      apiKey: "thebe-key",
      environmentId: "0",
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        seen.push({ url, key: headers.get("X-Api-Key") });
        return jsonResponse(200, {
          success: true,
          data: [
            {
              id: "abc123",
              name: "/nginx",
              image: "nginx:1.27",
              state: "running",
              status: "Up 3 hours",
              created: 1_700_000_000,
            },
          ],
        });
      },
    });

    await expect(adapter.listContainers()).resolves.toEqual([
      {
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        status: "Up 3 hours",
        created: 1_700_000_000,
      },
    ]);
    expect(seen[0]?.key).toBe("thebe-key");
    expect(seen[0]?.url).toContain(
      "/api/environments/0/containers",
    );
  });

  it("inspects a container and maps env, cmd, and ports", async () => {
    const adapter = new ArcaneAdapter({
      baseUrl: "https://arcane.internal:3552",
      apiKey: "thebe-key",
      environmentId: "0",
      fetch: async () =>
        jsonResponse(200, {
          success: true,
          data: {
            id: "abc123",
            name: "/nginx",
            image: "nginx:1.27",
            state: { status: "running" },
            config: { env: ["NODE_ENV=production"], cmd: ["nginx"] },
            ports: [
              { ip: "0.0.0.0", publicPort: 8080, privatePort: 80, type: "tcp" },
            ],
          },
        }),
    });

    await expect(adapter.inspectContainer("abc123")).resolves.toEqual({
      id: "abc123",
      name: "nginx",
      image: "nginx:1.27",
      state: "running",
      config: { env: ["NODE_ENV=production"], cmd: ["nginx"] },
      networkSettings: {
        ports: {
          "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
        },
      },
    });
  });

  it("returns container logs from the REST logs path", async () => {
    let logsUrl = "";
    const adapter = new ArcaneAdapter({
      baseUrl: "https://arcane.internal:3552",
      apiKey: "thebe-key",
      environmentId: "0",
      fetch: async (input) => {
        logsUrl = String(input);
        return jsonResponse(200, { success: true, data: "line1\nline2" });
      },
    });
    await expect(adapter.getContainerLogs("abc123", 50)).resolves.toBe(
      "line1\nline2",
    );
    expect(logsUrl).toContain(
      "/api/environments/0/containers/abc123/logs",
    );
    expect(logsUrl).toContain("tail=50");
  });

  it("maps status counts", async () => {
    const adapter = new ArcaneAdapter({
      baseUrl: "https://arcane.internal:3552",
      apiKey: "thebe-key",
      environmentId: "0",
      now: () => 1_700_000_100,
      fetch: async () =>
        jsonResponse(200, {
          success: true,
          data: {
            runningContainers: 2,
            stoppedContainers: 1,
            totalContainers: 4,
          },
        }),
    });
    await expect(adapter.getStatusSummary()).resolves.toEqual({
      totalContainers: 4,
      runningContainers: 2,
      pausedContainers: 0,
      exitedContainers: 1,
      lastUpdated: 1_700_000_100,
    });
  });

  it("maps HTTP failures to ProviderError codes", async () => {
    const failing = (status: number) =>
      new ArcaneAdapter({
        baseUrl: "https://arcane.internal:3552",
        apiKey: "thebe-key",
        environmentId: "0",
        fetch: async () => jsonResponse(status, { message: "nope" }),
      });

    await expect(failing(404).listContainers()).rejects.toMatchObject({
      name: "ProviderError",
      code: "NOT_FOUND",
    } satisfies Partial<ProviderError>);
    await expect(failing(401).listContainers()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(failing(429).listContainers()).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("maps network failure to UNREACHABLE", async () => {
    const adapter = new ArcaneAdapter({
      baseUrl: "https://arcane.internal:3552",
      apiKey: "thebe-key",
      environmentId: "0",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(adapter.listContainers()).rejects.toMatchObject({
      code: "UNREACHABLE",
    });
  });
});
