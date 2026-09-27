import { describe, expect, it } from "vitest";
import { listCoreMcpTools, withProductMetadata } from "./mcp.ts";

describe("capability product metadata", () => {
  it("defaults STRM capabilities to the STRM resource kind", () => {
    const capability = withProductMetadata({
      id: "strm.repair",
      name: "strm.repair",
      description: "Repair one STRM source",
      inputSchema: { type: "object" },
      category: "media",
      permission: "confirm",
      effect: "write",
      approval: "none",
      source: "external",
    });

    expect(capability.resourceKinds).toEqual(["strm"]);
  });

  it("publishes Navidrome capabilities only when the provider is configured", () => {
    const disabled = listCoreMcpTools();
    expect(disabled.some((tool) => tool.id.startsWith("navidrome."))).toBe(false);

    const enabled = listCoreMcpTools({ navidrome: true });
    expect(enabled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "navidrome.queue",
          service: "navidrome",
          category: "media",
          permission: "read",
          effect: "read",
          approval: "none",
          outputKind: "audio_queue",
        }),
        expect.objectContaining({
          id: "navidrome.playlist.create",
          permission: "confirm",
          effect: "write",
          approval: "required",
          execution: "agent",
          destructive: true,
        }),
        expect.objectContaining({
          id: "navidrome.playlist.delete",
          risk: "disruptive",
          approval: "required",
        }),
      ]),
    );
  });
});
