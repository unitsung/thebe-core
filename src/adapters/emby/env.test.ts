import { describe, expect, it } from "vitest";
import { createEmbyProviderFromEnv, embyOptionsFromEnv } from "./env.ts";
import { createJellyfinProviderFromEnv } from "../jellyfin/env.ts";
import { createImmichProviderFromEnv, immichOptionsFromEnv } from "../immich/env.ts";

describe("media provider env", () => {
  it("requires a complete Emby or Jellyfin URL, key, and user", () => {
    expect(createEmbyProviderFromEnv({})).toBeUndefined();
    expect(createJellyfinProviderFromEnv({
      JELLYFIN_BASE_URL: "http://jellyfin:8096",
      JELLYFIN_API_KEY: "key",
    })).toBeUndefined();
    expect(embyOptionsFromEnv({
      THEBE_EMBY_BASE_URL: "http://emby:8096",
      EMBY_API_KEY: "key",
      EMBY_USER_ID: "user-1",
    })).toEqual({
      baseUrl: "http://emby:8096",
      apiKey: "key",
      userId: "user-1",
    });
  });

  it("requires an Immich URL and API key", () => {
    expect(createImmichProviderFromEnv({ IMMICH_BASE_URL: "http://immich:2283" })).toBeUndefined();
    expect(immichOptionsFromEnv({
      THEBE_IMMICH_BASE_URL: "http://immich:2283",
      THEBE_IMMICH_API_KEY: "key",
    })).toEqual({ baseUrl: "http://immich:2283", apiKey: "key" });
  });
});
