import { describe, expect, it, vi } from "vitest";
import type { ContainerInfoProvider } from "./capabilities/containers.ts";
import type { DownloadProvider } from "./capabilities/pipeline.ts";
import { createThebeAgent } from "./index.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";

const containerProvider = (): ContainerInfoProvider => ({
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
});

function recordingRuntime() {
  const fake = createFakeRuntime();
  const creates: Array<Parameters<typeof fake.runtime.createSession>[0]> = [];
  const runtime = {
    ...fake.runtime,
    async createSession(
      create: Parameters<typeof fake.runtime.createSession>[0]
    ) {
      creates.push(create);
      return fake.runtime.createSession(create);
    },
  };
  return { runtime, creates };
}

const downloads = (extra: Partial<DownloadProvider>): DownloadProvider => ({
  service: "qbittorrent",
  add: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  ...extra,
});

describe("download pause and resume in a session", () => {
  it("registers both tools and gates them behind approval", async () => {
    const { runtime, creates } = recordingRuntime();
    const agent = createThebeAgent({
      runtime,
      provider: containerProvider(),
      pipeline: {
        downloads: downloads({
          pause: async () => {},
          resume: async () => {},
          remove: async () => {},
        }),
      },
    });

    await agent.createSession();
    const create = creates[0]!;
    expect(create.customTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "download_list",
        "download_status",
        "download_pause",
        "download_resume",
        "download_delete",
      ])
    );
    expect(create.toolsRequiringApproval).toEqual(
      expect.arrayContaining([
        "download_pause",
        "download_resume",
        "download_delete",
      ])
    );
    expect(create.toolsRequiringApproval).not.toContain("download_list");
  });

  it("offers neither tool when the downloader cannot pause or resume", async () => {
    const { runtime, creates } = recordingRuntime();
    const agent = createThebeAgent({
      runtime,
      provider: containerProvider(),
      pipeline: { downloads: downloads({}) },
    });

    await agent.createSession();
    const create = creates[0]!;
    const names = create.customTools.map((tool) => tool.name);
    expect(names).toContain("download_add");
    expect(names).not.toContain("download_pause");
    expect(names).not.toContain("download_resume");
    expect(names).not.toContain("download_delete");
    expect(create.toolsRequiringApproval).not.toContain("download_pause");
  });
});
