import { describe, expect, it, vi } from "vitest";
import {
  DockerEngineAdapter,
  createDockerEngineProviderFromEnv,
} from "./adapter.ts";
import { createActionApi } from "../../agent/action/service.ts";
import { ProviderError } from "../../agent/capabilities/containers.ts";

function frame(stream: number, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + payload.length);
  out[0] = stream;
  out[4] = (payload.length >>> 24) & 0xff;
  out[5] = (payload.length >>> 16) & 0xff;
  out[6] = (payload.length >>> 8) & 0xff;
  out[7] = payload.length & 0xff;
  out.set(payload, 8);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function client(
  handler?: (url: string, init?: RequestInit) => Response | undefined
) {
  const calls: Array<{ url: string; method: string; redirect?: string }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      redirect: init?.redirect,
    });
    const custom = handler?.(url, init);
    if (custom) return custom;
    if (url.endsWith("/containers/json?all=true")) {
      return Response.json([
        {
          Id: "abc",
          Names: ["/emby"],
          Image: "emby/embyserver:latest",
          State: "running",
          Status: "Up 3 hours",
          Created: 1_690_000_000,
        },
        {
          Id: "def",
          Names: ["/qbittorrent"],
          Image: "qbittorrent:latest",
          State: "exited",
          Status: "Exited (0) 2 hours ago",
          Created: 1_690_000_100,
        },
        {
          Id: "ghi",
          Names: ["/paused"],
          Image: "x",
          State: "paused",
          Status: "Up (Paused)",
          Created: 1_690_000_200,
        },
      ]);
    }
    if (url.includes("/containers/emby/json")) {
      return Response.json({
        Id: "abc",
        Name: "/emby",
        Config: {
          Image: "emby/embyserver:latest",
          Env: ["TZ=UTC"],
          Cmd: ["/init"],
          Labels: { "com.example.role": "media" },
        },
        State: { Status: "running", Running: true },
        NetworkSettings: {
          Ports: { "8096/tcp": [{ HostIp: "0.0.0.0", HostPort: "8096" }] },
        },
      });
    }
    if (url.includes("/containers/emby/logs")) {
      return new Response(concat([frame(1, "hello\n"), frame(2, "warning\n")]));
    }
    if (url.endsWith("/containers/emby/restart")) {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    calls,
    adapter: new DockerEngineAdapter({
      baseUrl: "http://proxy.example:2375/",
      fetch: fetchImpl,
      now: () => 42,
    }),
  };
}

describe("Docker Engine container provider", () => {
  it("lists containers with stripped names and mapped states", async () => {
    const { adapter } = client();
    const containers = await adapter.listContainers();
    expect(containers).toEqual([
      expect.objectContaining({
        id: "abc",
        name: "emby",
        state: "running",
        created: 1_690_000_000,
      }),
      expect.objectContaining({
        id: "def",
        name: "qbittorrent",
        state: "exited",
      }),
      expect.objectContaining({ id: "ghi", name: "paused", state: "paused" }),
    ]);
  });

  it("inspects one container with config and published ports", async () => {
    const { adapter } = client();
    const detail = await adapter.inspectContainer("emby");
    expect(detail).toMatchObject({
      id: "abc",
      name: "emby",
      image: "emby/embyserver:latest",
      state: "running",
      config: {
        env: ["TZ=UTC"],
        cmd: ["/init"],
        labels: { "com.example.role": "media" },
      },
      networkSettings: {
        ports: { "8096/tcp": [{ HostIp: "0.0.0.0", HostPort: "8096" }] },
      },
    });
  });

  it("demultiplexes framed logs and falls back to plain text", async () => {
    const framed = client();
    expect(await framed.adapter.getContainerLogs("emby", 50)).toBe(
      "hello\nwarning\n"
    );

    const plain = client((url) =>
      url.includes("/containers/emby/logs")
        ? new Response("plain text log\nline 2\n")
        : undefined
    );
    expect(await plain.adapter.getContainerLogs("emby")).toBe(
      "plain text log\nline 2\n"
    );
  });

  it("summarises host counts from the container list", async () => {
    const { adapter } = client();
    expect(await adapter.getStatusSummary()).toEqual({
      totalContainers: 3,
      runningContainers: 1,
      pausedContainers: 1,
      exitedContainers: 1,
      lastUpdated: 42,
    });
  });

  it("restarts through POST and never follows a redirect", async () => {
    const { adapter, calls } = client();
    await adapter.restartContainer("emby");
    const restart = calls.find((call) =>
      call.url.endsWith("/containers/emby/restart")
    )!;
    expect(restart.method).toBe("POST");
    expect(restart.redirect).toBe("error");
  });

  it("maps HTTP and transport failures to provider errors", async () => {
    const missing = client((url) =>
      url.includes("/containers/missing/json")
        ? new Response("", { status: 404 })
        : undefined
    );
    await expect(
      missing.adapter.inspectContainer("missing")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const down = new DockerEngineAdapter({
      baseUrl: "http://proxy.example:2375",
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(down.listContainers()).rejects.toBeInstanceOf(ProviderError);
    await expect(down.listContainers()).rejects.toMatchObject({
      code: "UNREACHABLE",
    });

    expect(
      () => new DockerEngineAdapter({ baseUrl: "proxy.example:2375" })
    ).toThrow("http://");
  });

  it("adds an optional API version prefix when configured", async () => {
    const calls: string[] = [];
    const adapter = new DockerEngineAdapter({
      baseUrl: "http://proxy.example:2375/",
      apiVersion: "v1.43",
      fetch: vi.fn(async (input) => {
        calls.push(String(input));
        return Response.json([]);
      }),
    });
    await adapter.listContainers();
    expect(calls[0]).toBe(
      "http://proxy.example:2375/v1.43/containers/json?all=true"
    );
  });

  it("is created from the environment only when a proxy URL is set", () => {
    expect(createDockerEngineProviderFromEnv({})).toBeUndefined();
    expect(
      createDockerEngineProviderFromEnv({ DOCKER_PROXY_URL: "http://p:2375" })
    ).toBeInstanceOf(DockerEngineAdapter);
    const fromThebe = createDockerEngineProviderFromEnv({
      THEBE_DOCKER_PROXY_URL: "http://p:2375",
      THEBE_DOCKER_API_VERSION: "v1.41",
    });
    expect(fromThebe).toBeInstanceOf(DockerEngineAdapter);
  });

  it("restarts and verifies through the approved-action product path", async () => {
    let state = "exited";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/containers/emby/restart") && init?.method === "POST") {
        state = "running";
        return new Response(null, { status: 204 });
      }
      if (url.includes("/containers/emby/json")) {
        return Response.json({
          Id: "emby",
          Name: "/emby",
          Config: { Image: "emby/embyserver:4.8", Labels: {} },
          State: { Status: state },
          NetworkSettings: {
            Ports: { "8096/tcp": [{ HostIp: "0.0.0.0", HostPort: "8096" }] },
          },
        });
      }
      return new Response("", { status: 404 });
    });
    const adapter = new DockerEngineAdapter({
      baseUrl: "http://proxy.example:2375",
      fetch: fetchImpl,
    });
    const api = createActionApi({
      now: () => new Date("2026-10-13T00:00:00Z"),
      provider: adapter,
      probe: async () => ({ ok: true, status: 200 }),
    });
    const receipt = await api.executeApprovedAction({
      actionId: "container.restart",
      resource: {
        kind: "container",
        id: "emby",
        name: "emby",
        provider: "docker",
      },
      approval: {
        approved: true,
        approvedAt: "2026-10-13T00:00:00Z",
        client: "ios",
      },
      idempotencyKey: "docker-restart-1",
    });
    expect(receipt.action.status).toBe("succeeded");
    expect(receipt.verification.status).toBe("passed");
    expect(state).toBe("running");
  });
});
