import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listConfiguredMcpServersSync } from "./config.ts";
import {
  openListMcpEndpoint,
  openListMcpServerConfig,
  presetMcpServers,
} from "./presets.ts";

const credentials = {
  THEBE_OPENLIST_BASE_URL: "https://openlist.example.com/",
  THEBE_OPENLIST_TOKEN: "openlist-user-token",
};

describe("OpenList MCP preset", () => {
  it("stays off unless THEBE_OPENLIST_MCP enables it", () => {
    expect(presetMcpServers({ ...credentials })).toEqual([]);
    expect(
      openListMcpServerConfig({ ...credentials, THEBE_OPENLIST_MCP: "off" })
    ).toBeUndefined();
    expect(
      openListMcpServerConfig({ ...credentials, THEBE_OPENLIST_MCP: "on" })
    ).toBeDefined();
  });

  it("needs both the base URL and the token", () => {
    expect(
      openListMcpServerConfig({
        THEBE_OPENLIST_MCP: "on",
        THEBE_OPENLIST_BASE_URL: credentials.THEBE_OPENLIST_BASE_URL,
      })
    ).toBeUndefined();
    expect(
      openListMcpServerConfig({
        THEBE_OPENLIST_MCP: "on",
        THEBE_OPENLIST_TOKEN: credentials.THEBE_OPENLIST_TOKEN,
      })
    ).toBeUndefined();
  });

  it("targets the official /mcp endpoint with the token sent verbatim", () => {
    const config = openListMcpServerConfig({
      ...credentials,
      THEBE_OPENLIST_MCP: "on",
    });
    expect(config).toMatchObject({
      name: "openlist",
      url: "https://openlist.example.com/mcp",
      headers: { Authorization: "openlist-user-token" },
      service: "openlist",
      category: "files",
      exposure: "deferred",
      disabled: false,
      readTools: ["openlist.fs.list", "openlist.fs.get", "openlist.fs.link"],
    });
  });

  it("normalises the base URL and keeps an /mcp suffix", () => {
    expect(openListMcpEndpoint("https://openlist.example.com")).toBe(
      "https://openlist.example.com/mcp"
    );
    expect(openListMcpEndpoint("https://openlist.example.com/")).toBe(
      "https://openlist.example.com/mcp"
    );
    expect(openListMcpEndpoint("https://openlist.example.com/base///")).toBe(
      "https://openlist.example.com/base/mcp"
    );
    expect(openListMcpEndpoint("https://openlist.example.com/mcp/")).toBe(
      "https://openlist.example.com/mcp"
    );
  });
});

describe("preset MCP configuration", () => {
  it("adds the enabled preset when no configuration file names it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "thebe-mcp-preset-cwd-"));
    const homeDir = await mkdtemp(join(tmpdir(), "thebe-mcp-preset-home-"));
    const servers = listConfiguredMcpServersSync({
      cwd,
      homeDir,
      env: { ...credentials, THEBE_OPENLIST_MCP: "on" },
    });
    expect(servers).toEqual([
      expect.objectContaining({
        name: "openlist",
        url: "https://openlist.example.com/mcp",
      }),
    ]);
  });

  it("lets an explicit openlist entry win, including a disabled one", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "thebe-mcp-preset-file-cwd-"));
    const homeDir = await mkdtemp(
      join(tmpdir(), "thebe-mcp-preset-file-home-")
    );
    await mkdir(join(cwd, ".thebe"), { recursive: true });
    await writeFile(
      join(cwd, ".thebe", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          openlist: {
            url: "https://custom.example.com/mcp",
            headers: { Authorization: "custom-token" },
            disabled: true,
          },
        },
      })
    );
    const servers = listConfiguredMcpServersSync({
      cwd,
      homeDir,
      env: { ...credentials, THEBE_OPENLIST_MCP: "on" },
    });
    expect(servers).toEqual([
      expect.objectContaining({
        name: "openlist",
        url: "https://custom.example.com/mcp",
        headers: { Authorization: "custom-token" },
        disabled: true,
      }),
    ]);
  });
});
