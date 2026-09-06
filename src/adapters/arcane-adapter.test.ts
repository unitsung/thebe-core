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
  it("pages container list until totalItems is exhausted", async () => {
    const starts: number[] = [];
    const adapter = new ArcaneAdapter({
      baseUrl: "https://arcane.internal:3552",
      apiKey: "thebe-key",
      environmentId: "0",
      pageSize: 10,
      fetch: async (input) => {
        const url = new URL(String(input));
        const start = Number(url.searchParams.get("start") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "20");
        starts.push(start);
        const all = Array.from({ length: 25 }, (_, i) => ({
          id: `id-${i}`,
          name: `c${i}`,
          image: "nginx:1.27",
          state: "running",
          status: "Up",
          created: 1_700_000_000 + i,
        }));
        return jsonResponse(200, {
          success: true,
          data: all.slice(start, start + limit),
          pagination: { totalItems: 25, itemsPerPage: limit },
        });
      },
    });
    const listed = await adapter.listContainers();
    expect(listed).toHaveLength(25);
    expect(listed[0]?.name).toBe("c0");
    expect(listed[24]?.name).toBe("c24");
    expect(starts).toEqual([0, 10, 20]);
  });

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

  it("reads container logs from the Arcane WebSocket path", async () => {
    let logsUrl = "";
    let logsKey = "";
    const adapter = new ArcaneAdapter({
      baseUrl: "https://arcane.internal:3552",
      apiKey: "thebe-key",
      environmentId: "0",
      openLogSocket: async (url, headers) => {
        logsUrl = url;
        logsKey = headers["X-Api-Key"] ?? "";
        return (async function* () {
          yield JSON.stringify({
            seq: 1,
            level: "stdout",
            message: "line1",
          });
          yield JSON.stringify({
            seq: 2,
            level: "stderr",
            message: "line2",
          });
        })();
      },
    });
    await expect(adapter.getContainerLogs("abc123", 50)).resolves.toBe(
      "line1\nline2",
    );
    expect(logsUrl).toContain(
      "/api/environments/0/ws/containers/abc123/logs",
    );
    expect(logsUrl).toContain("tail=50");
    expect(logsUrl).toContain("follow=false");
    expect(logsKey).toBe("thebe-key");
    expect(logsUrl).toContain("/ws/containers/");
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

  it("maps HTTP failures to ProviderError codes without leaking the panel body", async () => {
    const failing = (status: number) =>
      new ArcaneAdapter({
        baseUrl: "https://arcane.internal:3552",
        apiKey: "thebe-key",
        environmentId: "0",
        fetch: async () =>
          jsonResponse(status, {
            message: "nope",
            error: "raw-arcane-stack-trace",
          }),
      });

    const cases: Array<[number, ProviderError["code"]]> = [
      [404, "NOT_FOUND"],
      [401, "UNAUTHORIZED"],
      [429, "RATE_LIMITED"],
    ];
    for (const [status, code] of cases) {
      const err = await failing(status)
        .listContainers()
        .then(
          () => {
            throw new Error(`expected ${status} to reject`);
          },
          (error: unknown) => error,
        );
      expect(err).toMatchObject({
        name: "ProviderError",
        code,
      } satisfies Partial<ProviderError>);
      expect(err).toBeInstanceOf(ProviderError);
      const pe = err as ProviderError;
      expect(pe.message).not.toContain("nope");
      expect(pe.message).not.toContain("raw-arcane-stack-trace");
      expect(JSON.stringify(pe)).not.toContain("nope");
      expect(JSON.stringify(pe)).not.toContain("raw-arcane-stack-trace");
    }
  });

  it("maps network failure to UNREACHABLE without leaking the cause message to tools", async () => {
    const adapter = new ArcaneAdapter({
      baseUrl: "https://arcane.internal:3552",
      apiKey: "thebe-key",
      environmentId: "0",
      fetch: async () => {
        throw new TypeError("ECONNREFUSED 10.0.0.5:3552 secret-host");
      },
    });
    const err = await adapter.listContainers().then(
      () => {
        throw new Error("expected unreachable to reject");
      },
      (error: unknown) => error,
    );
    expect(err).toMatchObject({ code: "UNREACHABLE" });
    expect(err).toBeInstanceOf(ProviderError);
    const pe = err as ProviderError;
    expect(pe.message).toBe("Arcane is unreachable");
    expect(pe.message).not.toContain("secret-host");
    expect(JSON.stringify(pe)).not.toContain("secret-host");
  });
});
