import { describe, expect, it } from "vitest";
import { mcpWritesAllowed } from "./mcp-writes.ts";

describe("mcpWritesAllowed", () => {
  it("is on unless the host turns it off", () => {
    expect(mcpWritesAllowed({})).toBe(true);
    expect(mcpWritesAllowed({ THEBE_MCP_WRITES: "" })).toBe(true);
    expect(mcpWritesAllowed({ THEBE_MCP_WRITES: "on" })).toBe(true);
    expect(mcpWritesAllowed({ THEBE_MCP_WRITES: "anything-else" })).toBe(true);
  });

  it.each(["off", "OFF", " deny ", "false", "0", "no"])(
    "is off for %j",
    (value) => {
      expect(mcpWritesAllowed({ THEBE_MCP_WRITES: value })).toBe(false);
    }
  );
});
