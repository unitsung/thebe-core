import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../agent/capabilities/containers.ts";
import { OpenListFilesProvider } from "../adapters/pipeline/openlist-files.ts";
import { createThebeAgent } from "../agent/index.ts";
import { createThebeHttpHandler } from "../delivery/http/handler.ts";
import {
  createDeviceToken,
  createTokenVerifier,
} from "../delivery/http/token-store.ts";
import { createFakeRuntime } from "../testing/runtime/index.ts";

const WRITE_TOKEN = "w".repeat(64);

const noContainers: ContainerInfoProvider = {
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

/** The real OpenList adapter over a fake fetch holding directory listings, recording every call. */
async function setup(directories: Record<string, string[]>) {
  const paths: string[] = [];
  const files = new OpenListFilesProvider({
    baseUrl: "http://openlist.test",
    token: "t",
    fetch: (async (url: string, init: { body: string }) => {
      const path = new URL(url).pathname;
      paths.push(path);
      const dir = (JSON.parse(init.body) as { path?: string }).path ?? "";
      const names = directories[dir] ?? [];
      const data =
        path === "/api/fs/list"
          ? {
              content: names.map((name) => ({ name, is_dir: false, size: 1 })),
              total: names.length,
            }
          : { tasks: [{ id: "task-1" }] };
      return new Response(JSON.stringify({ code: 200, data }));
    }) as unknown as typeof fetch,
  });
  const configDir = await mkdtemp(join(tmpdir(), "thebe-file-clash-"));
  createDeviceToken({
    configDir,
    name: "Writer",
    scope: "mcp:write",
    generate: () => WRITE_TOKEN,
  });
  const handler = createThebeHttpHandler({
    version: "0.1.0",
    agent: createThebeAgent({
      runtime: createFakeRuntime().runtime,
      provider: noContainers,
      pipeline: { files },
      mcpWritesAllowed: true,
    }),
    token: createTokenVerifier({ configDir, env: {} }),
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handler.handle(
      new Request("http://127.0.0.1:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${WRITE_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      })
    );
    const reply = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> };
    };
    return {
      isError: reply.result?.isError === true,
      text: reply.result?.content?.[0]?.text ?? "",
    };
  };
  const changes = () =>
    paths.filter((path) => /\/api\/fs\/(move|copy)$/.test(path));
  return { call, changes };
}

const directories = {
  "/media/inbox": ["Dune.mkv"],
  "/media/movies": ["Dune.mkv", "Arrival.mkv"],
  "/media/empty": [],
};

describe("moving and copying files over /mcp", () => {
  it("fail at once on a name clash, explain it, and change nothing", async () => {
    const { call, changes } = await setup(directories);
    for (const tool of ["files.move", "files.copy"]) {
      const reply = await call(tool, {
        sourceDir: "/media/inbox",
        destinationDir: "/media/movies",
        names: ["Dune.mkv"],
      });
      expect(reply.isError, tool).toBe(true);
      expect(reply.text, tool).toContain("Dune.mkv");
      expect(reply.text, tool).toContain("already exists");
      expect(reply.text, tool).toContain("Nothing was changed");
    }
    expect(changes()).toEqual([]);
  });

  it("stay ordinary writes: a write token moves and copies onto a free name", async () => {
    const { call, changes } = await setup(directories);
    for (const tool of ["files.move", "files.copy"]) {
      const reply = await call(tool, {
        sourceDir: "/media/inbox",
        destinationDir: "/media/empty",
        names: ["Dune.mkv"],
      });
      expect(reply.isError, tool).toBe(false);
      expect(reply.text.toLowerCase(), tool).not.toContain("irreversible");
    }
    expect(changes()).toEqual(["/api/fs/move", "/api/fs/copy"]);
  });

  it("fail on the one clashing name among several and move none of them", async () => {
    const { call, changes } = await setup(directories);
    const reply = await call("files.move", {
      sourceDir: "/media/inbox",
      destinationDir: "/media/movies",
      names: ["Brand.New.mkv", "Arrival.mkv"],
    });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("Arrival.mkv");
    expect(reply.text).not.toContain("Brand.New.mkv already");
    expect(changes()).toEqual([]);
  });
});
