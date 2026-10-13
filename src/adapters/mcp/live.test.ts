import { describe, expect, it } from "vitest";
import { McpConnection } from "./connection.ts";

/**
 * Live checks against real MCP servers. Opt-in, because they need network access
 * and (for the reference server) an `npx` download:
 *
 *   THEBE_MCP_LIVE=1 npx vitest run src/adapters/mcp/live.test.ts
 *
 * Nothing here runs in the default `npm test`.
 */
const liveIt = process.env.THEBE_MCP_LIVE === "1" ? it : it.skip;

const REFERENCE_EVERYTHING = {
  name: "everything",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything"],
};

function textOf(result: unknown): string {
  return JSON.stringify(result);
}

describe("live MCP servers", () => {
  liveIt(
    "connects to the official reference stdio server and calls a tool",
    async () => {
      const connection = new McpConnection(REFERENCE_EVERYTHING, 60_000);
      try {
        const names = (await connection.listTools()).map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(["echo", "get-sum"]));

        const echoed = await connection.callToolResult("echo", {
          message: "hello-mcp",
        });
        expect(textOf(echoed)).toContain("hello-mcp");
      } finally {
        connection.close();
      }
    },
    180_000
  );

  liveIt(
    "connects to a public remote MCP server over Streamable HTTP and calls a tool",
    async () => {
      const connection = new McpConnection(
        { name: "cloudflare-docs", url: "https://docs.mcp.cloudflare.com/mcp" },
        30_000
      );
      try {
        const names = (await connection.listTools()).map((tool) => tool.name);
        expect(names).toContain("search_cloudflare_documentation");

        const searched = await connection.callToolResult(
          "search_cloudflare_documentation",
          {
            query: "wrangler",
          }
        );
        expect(textOf(searched).length).toBeGreaterThan(20);
      } finally {
        connection.close();
      }
    },
    60_000
  );

  liveIt(
    "delivers a configured request header to a real remote MCP server",
    async () => {
      // GitHub's remote MCP endpoint answers 401 "missing required Authorization
      // header" without one, and a different error once an Authorization header is
      // present, so a change in the response is proof Core sent the header.
      const bare = new McpConnection(
        { name: "github", url: "https://api.githubcopilot.com/mcp/" },
        30_000
      );
      let withoutHeader = "";
      try {
        await bare.listTools();
      } catch (error) {
        withoutHeader = error instanceof Error ? error.message : String(error);
      } finally {
        bare.close();
      }

      const withHeader = new McpConnection(
        {
          name: "github",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer not-a-real-token" },
        },
        30_000
      );
      let withAuthHeader = "";
      try {
        await withHeader.listTools();
      } catch (error) {
        withAuthHeader = error instanceof Error ? error.message : String(error);
      } finally {
        withHeader.close();
      }

      expect(withoutHeader).not.toBe("");
      expect(withAuthHeader).not.toBe("");
      expect(withAuthHeader).not.toBe(withoutHeader);
    },
    60_000
  );
});
