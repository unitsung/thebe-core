import { describe, expect, it } from "vitest";
import { withProductMetadata } from "./mcp.ts";

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
});
