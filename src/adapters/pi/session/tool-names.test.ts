import { describe, expect, it } from "vitest";
import { createToolNameMap } from "./tool-names.ts";

describe("the names the model sees for Core's tools", () => {
  it("are safe for every provider, and Core gets its own name back", () => {
    const map = createToolNameMap([
      "container_list",
      "navidrome_playlist_update",
      "memory",
      "service_write",
    ]);
    expect(map.toWire("container_list")).toBe("container_list");
    expect(map.toWire("navidrome_playlist_update")).toBe(
      "navidrome_playlist_update"
    );
    expect(map.fromWire("container_list")).toBe("container_list");
    expect(map.fromWire("navidrome_playlist_update")).toBe(
      "navidrome_playlist_update"
    );
    // A name that was already safe is not touched, and a name never mapped (a built-in) passes through.
    expect(map.toWire("memory")).toBe("memory");
    expect(map.fromWire("memory")).toBe("memory");
    expect(map.fromWire("bash")).toBe("bash");
    expect(map.toWire("bash")).toBe("bash");
  });

  it("keeps two names that would collide apart, and maps each back to its own", () => {
    const map = createToolNameMap(["a.b", "a_b", "a-b.c", "a-b_c"]);
    const wires = ["a.b", "a_b", "a-b.c", "a-b_c"].map((name) =>
      map.toWire(name)
    );
    expect(new Set(wires).size).toBe(4);
    for (const name of ["a.b", "a_b", "a-b.c", "a-b_c"]) {
      expect(map.fromWire(map.toWire(name))).toBe(name);
    }
    for (const wire of wires) expect(wire).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("stays within the length providers allow", () => {
    const long = `service.${"x".repeat(100)}`;
    const wire = createToolNameMap([long]).toWire(long);
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(wire).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});
