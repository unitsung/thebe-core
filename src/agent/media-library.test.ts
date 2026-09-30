import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
import type { MediaLibraryProvider, PhotoLibraryProvider } from "./capabilities/media.ts";
import { createThebeAgent } from "./index.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";

function containerProvider(): ContainerInfoProvider {
  return {
    async listContainers() { return []; },
    async inspectContainer() { throw new Error("unused"); },
    async getContainerLogs() { return ""; },
    async getStatusSummary() {
      return {
        totalContainers: 0,
        runningContainers: 0,
        pausedContainers: 0,
        exitedContainers: 0,
        lastUpdated: 0,
      };
    },
  };
}

function library(detailOverview: string): MediaLibraryProvider {
  return {
    async listLibraries() { return []; },
    async listRecent() { return []; },
    async listSessions() { return []; },
    async searchItems() {
      return {
        items: [{ id: "item-1", title: "Arrival", type: "Movie", year: 2016 }],
        total: 1,
      };
    },
    async getItem(id) {
      if (id === "missing") return undefined;
      return {
        id,
        title: "Arrival",
        type: "Movie",
        year: 2016,
        overview: detailOverview,
        people: [{ name: "Amy Adams", role: "Louise", type: "Actor" }],
      };
    },
  };
}

describe("media library capabilities", () => {
  it("registers search and item tools only when that provider is configured", async () => {
    const fake = createFakeRuntime();
    const creates: Array<Parameters<typeof fake.runtime.createSession>[0]> = [];
    const runtime = {
      ...fake.runtime,
      async createSession(create: Parameters<typeof fake.runtime.createSession>[0]) {
        creates.push(create);
        return fake.runtime.createSession(create);
      },
    };
    const absent = createThebeAgent({ runtime, provider: containerProvider() });
    await absent.createSession();
    expect(creates[0]!.customTools.some((tool) => tool.name === "emby.search")).toBe(false);

    const overview = "A".repeat(2001);
    const agent = createThebeAgent({
      runtime,
      provider: containerProvider(),
      emby: library(overview),
      immich: {
        async listAssets() { return []; },
        async listAlbums() { return []; },
        async getStatistics() { return { images: 0, videos: 0, total: 0 }; },
        async searchSemantic() {
          return [{ id: "asset-1", title: "beach.jpg", type: "IMAGE" }];
        },
      } satisfies PhotoLibraryProvider,
    });
    await agent.createSession();
    const names = creates[1]!.customTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["emby.search", "emby.item", "immich.search"]));
    expect(names).not.toContain("jellyfin.search");

    const capabilities = (await agent.listCapabilities()).map((item) => item.id);
    expect(capabilities).toEqual(expect.arrayContaining(["emby.search", "emby.item", "immich.search"]));
    expect(capabilities).not.toContain("jellyfin.item");

    const item = creates[1]!.customTools.find((tool) => tool.name === "emby.item")!;
    const observation = await item.execute("call-1", { id: "item-1" });
    const text = observation.content.map((part) => part.text).join("");
    expect(text).toContain('"overviewTruncated":true');
    expect(text).not.toContain("A".repeat(2001));

    const full = await agent.invokeTool("emby.item", { id: "item-1" });
    expect(full).toContain("A".repeat(2001));
    expect(full).not.toContain("overviewTruncated");
    const search = await agent.invokeTool("emby.search", { query: "Arrival", year: 2016 });
    expect(search).toContain('"id":"item-1"');
    const photos = await agent.invokeTool("immich.search", { query: "bicycle" });
    expect(photos).toContain('"id":"asset-1"');
    expect(await agent.invokeTool("emby.item", { id: "missing" })).toContain("null");
  });
});
