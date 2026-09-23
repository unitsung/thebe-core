import { describe, expect, it } from "vitest";
import { OpenListBackgroundTaskProvider } from "./tasks.ts";

function response(data: unknown): Response {
  return new Response(JSON.stringify({ code: 200, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenListBackgroundTaskProvider", () => {
  it("lists and normalizes OpenList task snapshots", async () => {
    const requests: Array<{ url: string; method: string; authorization: string }> = [];
    const provider = new OpenListBackgroundTaskProvider({
      baseUrl: "https://openlist.test/",
      token: "openlist-token",
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method ?? "GET",
          authorization: String(new Headers(init?.headers).get("authorization")),
        });
        if (url.endsWith("/api/task/copy/undone")) {
          return response([
            {
              id: "copy-1",
              name: "copy movie",
              state: 1,
              progress: 42,
              start_time: "2026-09-22T01:00:00Z",
              error: "TOKEN=top-secret",
            },
          ]);
        }
        if (url.endsWith("/api/task/move/done")) {
          return response([
            {
              id: "move-1",
              name: "move movie",
              state: 2,
              end_time: "2026-09-22T02:00:00Z",
            },
          ]);
        }
        return response([]);
      },
    });

    const tasks = await provider.list();

    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "copy:copy-1",
          kind: "copy",
          name: "copy movie",
          status: "running",
          startedAt: "2026-09-22T01:00:00Z",
          updatedAt: "2026-09-22T01:00:00Z",
          error: "TOKEN=***REDACTED***",
        }),
        expect.objectContaining({
          id: "move:move-1",
          kind: "move",
          name: "move movie",
          status: "stopped",
          finishedAt: "2026-09-22T02:00:00Z",
          updatedAt: "2026-09-22T02:00:00Z",
        }),
      ]),
    );
    expect(requests.length).toBe(14);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.every((request) => request.authorization === "openlist-token")).toBe(true);
  });

  it("cancels a provider task by its stable product id", async () => {
    const requests: string[] = [];
    const provider = new OpenListBackgroundTaskProvider({
      baseUrl: "https://openlist.test",
      token: "token",
      fetch: async (input, init) => {
        requests.push(`${init?.method ?? "GET"} ${String(input)}`);
        return response({});
      },
    });

    await provider.stop("copy:copy-1");

    expect(requests).toEqual(["POST https://openlist.test/api/task/copy/cancel?tid=copy-1"]);
  });
});
