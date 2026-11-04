import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../agent/capabilities/containers.ts";
import { Aria2BackgroundTaskProvider } from "../adapters/pipeline/aria2-tasks.ts";
import { Aria2DownloadProvider } from "../adapters/pipeline/aria2-downloads.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";
import { createThebeApp } from "./create.ts";

const ORIGIN = "http://127.0.0.1:8787";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("inspect not used");
    },
    getContainerLogs: async () => {
      throw new Error("logs not used");
    },
    getStatusSummary: async () => {
      throw new Error("summary not used");
    },
  };
}

describe("aria2 in Activity", () => {
  function aria2(rows: () => Array<Record<string, unknown>>) {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string) as { method: string };
      const all = rows();
      const pick = (status: string[]) =>
        all.filter((row) => status.includes(String(row.status)));
      const result =
        method === "aria2.tellActive"
          ? pick(["active"])
          : method === "aria2.tellWaiting"
            ? pick(["waiting", "paused"])
            : method === "aria2.tellStopped"
              ? pick(["complete", "error", "removed"])
              : [];
      return new Response(JSON.stringify({ result }));
    }) as unknown as typeof fetch;
    return new Aria2DownloadProvider({
      baseUrl: "http://aria2.local:6800",
      fetch: fetchImpl,
    });
  }
  const gid = (n: number) => String(n).padStart(16, "0");

  it("lists aria2 downloads as background tasks with a stage", async () => {
    let status = "active";
    const downloads = aria2(() => [
      {
        gid: gid(1),
        status,
        totalLength: "100",
        completedLength: "10",
        files: [{ path: "/d/movie.mkv" }],
      },
      {
        gid: gid(2),
        status: "complete",
        totalLength: "5",
        completedLength: "5",
        files: [{ path: "/d/old.iso" }],
      },
    ]);
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      backgroundTaskProviders: [new Aria2BackgroundTaskProvider(downloads)],
    });
    const call = async (path: string) =>
      (await (
        await app.handler.handle(new Request(`${ORIGIN}${path}`))
      ).json()) as Record<string, any>;
    const tasks = async () =>
      (await call("/v1/activity?source=background_task")).items as Record<
        string,
        any
      >[];

    let items = await tasks();
    expect(items).toHaveLength(2);
    const running = items.find((row) => row.task.id === gid(1))!;
    expect(running).toMatchObject({
      type: "background_task",
      group: "running",
      task: { provider: "aria2", name: "movie.mkv" },
    });
    expect(running.stage).toEqual({ kind: "working" });
    expect(items.find((row) => row.task.id === gid(2))!.stage).toEqual({
      kind: "ended",
    });

    // A download that fails while Core is watching asks for the person.
    status = "error";
    items = await tasks();
    const failed = items.find((row) => row.task.id === gid(1))!;
    expect(failed.task.status).toBe("failed");
    expect(failed.stage).toEqual({ kind: "person", reason: "failed" });
    expect((await call("/v1/activity/summary")).needsYou.count).toBe(1);
    expect((await call(`/v1/activity/${failed.id}`)).stage).toEqual({
      kind: "person",
      reason: "failed",
    });
  });
});
