import { describe, expect, it } from "vitest";
import { ProviderError } from "../../agent/capabilities/containers.ts";
import {
  ArcaneBackgroundTaskProvider,
  arcaneEnvironmentIdFromEnv,
  createArcaneBackgroundTaskProviderFromEnv,
} from "./tasks.ts";

function response(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failure(status: number): Response {
  return new Response(JSON.stringify({ success: false, error: "nope" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Request = { url: string; method: string; apiKey: string };

function recordingProvider(
  requests: Request[],
  handler: (url: string, method: string) => Response,
): ArcaneBackgroundTaskProvider {
  return new ArcaneBackgroundTaskProvider({
    baseUrl: "https://arcane.test/",
    apiKey: "arcane-key",
    limit: 25,
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        apiKey: String(new Headers(init?.headers).get("x-api-key")),
      });
      return handler(url, method);
    },
  });
}

/** Replace the provider transport so env-built providers can be exercised. */
function stubFetch(
  provider: ArcaneBackgroundTaskProvider,
  requests: Request[],
): void {
  const mutable = provider as unknown as { fetchImpl: typeof fetch };
  mutable.fetchImpl = async (input, init) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      apiKey: String(new Headers(init?.headers).get("x-api-key")),
    });
    return response([]);
  };
}

describe("ArcaneBackgroundTaskProvider", () => {
  it("lists Arcane activities as product background tasks", async () => {
    const requests: Request[] = [];
    const provider = recordingProvider(requests, () =>
      response([
        {
          id: "act-1",
          type: "image_pull",
          status: "running",
          resourceType: "container",
          resourceId: "ctr-42",
          resourceName: "immich-server",
          progress: 42,
          latestMessage: "Pulling image layers",
          startedAt: "2026-09-26T01:00:00Z",
          updatedAt: "2026-09-26T01:02:00Z",
        },
        {
          id: "act-2",
          type: "container_redeploy",
          status: "queued",
          step: "Waiting for lock",
          startedAt: "2026-09-26T01:03:00Z",
        },
        {
          id: "act-3",
          type: "vulnerability_scan",
          status: "success",
          resourceName: "jellyfin",
          startedAt: "2026-09-25T22:00:00Z",
          endedAt: "2026-09-25T22:05:00Z",
        },
        {
          id: "act-4",
          type: "auto_update",
          status: "failed",
          resourceName: "photoprism",
          startedAt: "2026-09-25T21:00:00Z",
          endedAt: "2026-09-25T21:01:00Z",
          error: "TOKEN=top-secret",
        },
        {
          id: "act-5",
          type: "system_prune",
          status: "cancelled",
          resourceType: "system",
          startedAt: "2026-09-25T20:00:00Z",
          endedAt: "2026-09-25T20:00:30Z",
        },
        {
          id: "act-6",
          type: "resource_action",
          status: "paused",
          startedAt: "2026-09-25T19:00:00Z",
          endedAt: "2026-09-25T19:00:10Z",
        },
      ]),
    );

    const tasks = await provider.list();

    expect(tasks).toEqual([
      expect.objectContaining({
        id: "act-1",
        kind: "image_pull",
        name: "immich-server",
        status: "running",
        startedAt: "2026-09-26T01:00:00Z",
        updatedAt: "2026-09-26T01:02:00Z",
        resource: { kind: "container", id: "ctr-42" },
      }),
      expect.objectContaining({
        id: "act-2",
        kind: "container_redeploy",
        name: "Waiting for lock",
        status: "running",
        updatedAt: "2026-09-26T01:03:00Z",
      }),
      expect.objectContaining({
        id: "act-3",
        kind: "vulnerability_scan",
        name: "jellyfin",
        status: "stopped",
        finishedAt: "2026-09-25T22:05:00Z",
        updatedAt: "2026-09-25T22:05:00Z",
      }),
      expect.objectContaining({
        id: "act-4",
        kind: "auto_update",
        name: "photoprism",
        status: "failed",
        error: "TOKEN=***REDACTED***",
      }),
      expect.objectContaining({
        id: "act-5",
        kind: "system_prune",
        name: "system_prune",
        status: "stopped",
      }),
      // Unknown status falls back to the timestamps instead of claiming progress.
      expect.objectContaining({
        id: "act-6",
        kind: "resource_action",
        status: "stopped",
        updatedAt: "2026-09-25T19:00:10Z",
      }),
    ]);
    // Only activities that name a resource id get a link; a kind alone is not
    // enough to guess a target.
    expect(tasks.filter((task) => task.resource !== undefined).map((task) => task.id)).toEqual([
      "act-1",
    ]);
    expect(requests).toEqual([
      {
        url: "https://arcane.test/api/environments/0/activities?start=0&limit=25&order=desc",
        method: "GET",
        apiKey: "arcane-key",
      },
    ]);
  });

  it("tolerates empty payloads and activities without an id", async () => {
    const empty = recordingProvider([], () => response(null));
    await expect(empty.list()).resolves.toEqual([]);

    const rows = recordingProvider([], () =>
      response([{ type: "image_pull", status: "running" }, "not-an-object"]),
    );
    await expect(rows.list()).resolves.toEqual([]);
  });

  it("keeps the provider HTTP status on failures", async () => {
    for (const [status, code] of [
      [401, "UNAUTHORIZED"],
      [403, "UNAUTHORIZED"],
      [404, "NOT_FOUND"],
      [429, "RATE_LIMITED"],
      [500, "UNKNOWN"],
    ] as const) {
      const provider = recordingProvider([], () => failure(status));
      const error = await provider.list().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe(code);
      expect((error as ProviderError & { status?: number }).status).toBe(status);
    }
  });

  it("reports unreachable and malformed Arcane responses", async () => {
    const unreachable = new ArcaneBackgroundTaskProvider({
      baseUrl: "https://arcane.test",
      apiKey: "key",
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    await expect(unreachable.list()).rejects.toMatchObject({
      code: "UNREACHABLE",
    });

    const invalid = recordingProvider(
      [],
      () => new Response("<html>nope</html>", { status: 200 }),
    );
    await expect(invalid.list()).rejects.toMatchObject({ code: "UNKNOWN" });

    const rejected = recordingProvider(
      [],
      () =>
        new Response(JSON.stringify({ success: false, error: "bad" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(rejected.list()).rejects.toMatchObject({ code: "UNKNOWN" });
  });

  it("cancels an activity through the documented cancel route", async () => {
    const requests: Request[] = [];
    const provider = recordingProvider(requests, () => response({}));

    await provider.stop("act/1");

    expect(requests).toEqual([
      {
        url: "https://arcane.test/api/environments/0/activities/act%2F1/cancel",
        method: "POST",
        apiKey: "arcane-key",
      },
    ]);
  });

  it("explains an activity that already finished", async () => {
    const provider = recordingProvider([], () => failure(409));

    await expect(provider.stop("act-9")).rejects.toMatchObject({
      code: "UNKNOWN",
      status: 409,
      message: "Arcane activity act-9 has already finished",
    });

    await expect(provider.stop("  ")).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  it("cancels only running activities for stopAll", async () => {
    const requests: Request[] = [];
    const provider = recordingProvider(requests, (url) => {
      if (url.includes("/cancel")) return response({});
      return response([
        { id: "act-1", type: "image_pull", status: "running" },
        { id: "act-2", type: "project_build", status: "queued" },
        { id: "act-3", type: "system_prune", status: "success" },
      ]);
    });

    await provider.stopAll();

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://arcane.test/api/environments/0/activities?start=0&limit=25&order=desc",
      "POST https://arcane.test/api/environments/0/activities/act-1/cancel",
      "POST https://arcane.test/api/environments/0/activities/act-2/cancel",
    ]);
  });
});

describe("createArcaneBackgroundTaskProviderFromEnv", () => {
  it("requires both credentials and honors environment aliases", () => {
    expect(createArcaneBackgroundTaskProviderFromEnv({})).toBeUndefined();
    expect(
      createArcaneBackgroundTaskProviderFromEnv({ ARCANE_API_KEY: "key" }),
    ).toBeUndefined();

    const withBareNames = createArcaneBackgroundTaskProviderFromEnv({
      ARCANE_BASE_URL: "https://arcane.test",
      ARCANE_API_KEY: "bare-key",
    });
    expect(withBareNames).toBeInstanceOf(ArcaneBackgroundTaskProvider);

    const withThebeNames = createArcaneBackgroundTaskProviderFromEnv({
      THEBE_ARCANE_BASE_URL: "https://arcane.thebe.test",
      THEBE_ARCANE_API_KEY: "thebe-key",
    });
    expect(withThebeNames).toBeInstanceOf(ArcaneBackgroundTaskProvider);
  });

  it("targets the configured Arcane environment", async () => {
    expect(arcaneEnvironmentIdFromEnv({ ARCANE_ENVIRONMENT_ID: "3" })).toBe("3");
    expect(arcaneEnvironmentIdFromEnv({ THEBE_ARCANE_ENVIRONMENT_ID: "4" })).toBe("4");
    expect(arcaneEnvironmentIdFromEnv({ ARCANE_ENVIRONMENT_ID: "  " })).toBeUndefined();

    const requests: Request[] = [];
    const provider = createArcaneBackgroundTaskProviderFromEnv({
      ARCANE_BASE_URL: "https://arcane.test",
      ARCANE_API_KEY: "key",
      ARCANE_ENVIRONMENT_ID: "3",
    });
    expect(provider).toBeInstanceOf(ArcaneBackgroundTaskProvider);
    stubFetch(provider as ArcaneBackgroundTaskProvider, requests);

    await (provider as ArcaneBackgroundTaskProvider).list();

    expect(requests[0]?.url).toBe(
      "https://arcane.test/api/environments/3/activities?start=0&limit=25&order=desc",
    );
  });
});
