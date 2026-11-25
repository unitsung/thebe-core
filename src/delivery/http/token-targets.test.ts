import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDeviceToken,
  createTokenVerifier,
  describeTokenScopes,
  tokenMayCallTool,
} from "./token-store.ts";

describe("targeted MCP token scopes", () => {
  it("grants only the named tool or service at the requested level", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "thebe-mcp-targets-"));
    const token = "t".repeat(64);
    createDeviceToken({
      configDir,
      name: "Media tools",
      scopes: [
        "mcp:tool:container_restart:write",
        "mcp:service:navidrome:write",
      ],
      generate: () => token,
    });
    const caller = createTokenVerifier({ configDir, env: {} }).verify(token);

    expect(caller).toBeDefined();
    expect(
      tokenMayCallTool(caller, "container_restart", "write", "container")
    ).toBe(true);
    expect(
      tokenMayCallTool(caller, "container_list", "read", "container")
    ).toBe(false);
    expect(
      tokenMayCallTool(
        caller,
        "navidrome_playlist_create",
        "write",
        "navidrome"
      )
    ).toBe(true);
    expect(
      tokenMayCallTool(
        caller,
        "navidrome_playlist_create",
        "irreversible",
        "navidrome"
      )
    ).toBe(false);
    expect(
      tokenMayCallTool(caller, "mcp:radarr/list_movies", "read", "radarr")
    ).toBe(false);
    expect(describeTokenScopes(caller?.scopes)).toContain(
      "mcp:tool:container_restart:write"
    );
    expect(describeTokenScopes(caller?.scopes)).toContain(
      "mcp:service:navidrome:write"
    );
  });
});
