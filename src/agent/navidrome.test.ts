import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
import type { NavidromeProvider } from "./capabilities/navidrome.ts";
import { createThebeAgent } from "./index.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";

function containerProvider(): ContainerInfoProvider {
  return {
    async listContainers() {
      return [];
    },
    async inspectContainer() {
      throw new Error("unused");
    },
    async getContainerLogs() {
      return "";
    },
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

function navidromeProvider(): NavidromeProvider {
  return {
    service: "navidrome",
    async listLibrary() {
      return { mode: "recent", albums: [] };
    },
    async search() {
      return { artists: [], albums: [], songs: [] };
    },
    async getArtist() {
      return undefined;
    },
    async getLyrics() {
      return undefined;
    },
    async getPlaybackQueue() {
      return { items: [], startIndex: 0, mode: "direct" };
    },
    async createPlaylist() {
      return undefined;
    },
    async updatePlaylist() {},
    async deletePlaylist() {},
  };
}

describe("Navidrome agent integration", () => {
  it("slims session observations while preserving ordered candidates and full capability results", async () => {
    const fake = createFakeRuntime();
    const creates: Array<Parameters<typeof fake.runtime.createSession>[0]> = [];
    const songs = Array.from({ length: 30 }, (_, index) => ({
      id: `song-${index}`, title: `Track ${index}`, artist: "Artist", albumId: "album-1",
      bitRate: 320, samplingRate: 48000, size: 12000000, coverArt: "cover-1",
    }));
    const agent = createThebeAgent({
      runtime: {
        ...fake.runtime,
        async createSession(create) {
          creates.push(create);
          return fake.runtime.createSession(create);
        },
      },
      provider: containerProvider(),
      navidrome: {
        ...navidromeProvider(),
        async search() { return { artists: [], albums: [], songs }; },
      },
    });
    await agent.createSession();
    const tool = creates[0]!.customTools.find((item) => item.name === "navidrome.search")!;
    const observation = await tool.execute("search-1", { query: "Artist", limit: 30 });
    const text = observation.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    expect(text).toContain('"id":"song-29"');
    expect(text).toContain('"albumId":"album-1"');
    expect(text.indexOf('"id":"song-0"')).toBeLessThan(text.indexOf('"id":"song-29"'));
    expect(text).not.toContain("samplingRate");
    expect(text).not.toContain("coverArt");
    const full = await agent.invokeTool("navidrome.search", { query: "Artist", limit: 30 });
    expect(full).toContain('"samplingRate":48000');
    expect(full).toContain('"id":"song-29"');
    expect(text.length).toBeLessThan(full.length);
  });

  it("registers read tools, gates playlist writes, and blocks direct writes", async () => {
    const fake = createFakeRuntime();
    const createCalls: Array<Parameters<typeof fake.runtime.createSession>[0]> = [];
    const runtime = {
      ...fake.runtime,
      async createSession(
        create: Parameters<typeof fake.runtime.createSession>[0],
      ) {
        createCalls.push(create);
        return fake.runtime.createSession(create);
      },
    };
    const agent = createThebeAgent({
      runtime,
      provider: containerProvider(),
      navidrome: navidromeProvider(),
    });

    const capabilities = await agent.listCapabilities();
    expect(capabilities.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "navidrome.library",
        "navidrome.queue",
        "navidrome.playlist.create",
        "navidrome.playlist.update",
        "navidrome.playlist.delete",
      ]),
    );

    await agent.createSession();
    const create = createCalls[0]!;
    expect(create.customTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["navidrome.library", "navidrome.queue"]),
    );
    expect(create.toolsRequiringApproval).toEqual(
      expect.arrayContaining([
        "navidrome.playlist.create",
        "navidrome.playlist.update",
        "navidrome.playlist.delete",
      ]),
    );

    await expect(
      agent.invokeTool("navidrome.library", { mode: "recent" }),
    ).resolves.toContain("\"albums\":[]");
    await expect(
      agent.invokeTool("navidrome.playlist.delete", {
        playlistId: "playlist-1",
      }),
    ).rejects.toThrow("runtime approval");
    await expect(
      agent.invokeCapability("navidrome.playlist.delete", {
        arguments: { playlistId: "playlist-1" },
      }),
    ).rejects.toThrow("runtime approval");
  });

  it("returns playback credentials but strips them from retained Artifacts", async () => {
    const base = navidromeProvider();
    const provider: NavidromeProvider = {
      ...base,
      async getPlaybackQueue() {
        return {
          items: [
            {
              queueId: "song-1",
              streamUrl:
                "http://navidrome.test/rest/stream.view?id=song-1&u=alice&t=secret-token&s=salt",
              requestHeaders: {},
              title: "Headlights",
              artist: "Thebe",
              album: "Night Drive",
              artworkUrl:
                "http://navidrome.test/rest/getCoverArt.view?id=cover-1&u=alice&t=secret-token&s=salt",
            },
          ],
          startIndex: 0,
          mode: "direct",
        };
      },
    };
    const agent = createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: containerProvider(),
      navidrome: provider,
    });

    const invoked = await agent.invokeCapability("navidrome.queue", {
      arguments: { songIds: ["song-1"] },
    });
    expect(invoked.type).toBe("result");
    if (invoked.type !== "result" || !invoked.artifactId) {
      throw new Error("expected a direct result with an Artifact");
    }
    expect(JSON.stringify(invoked.result)).toContain("secret-token");

    const artifact = await agent.getArtifactContent(invoked.artifactId);
    expect(artifact?.content).toContain("Headlights");
    expect(artifact?.content).not.toContain("secret-token");
    expect(artifact?.content).not.toContain("u=alice");
    expect(artifact?.content).not.toContain("s=salt");
  });
});
