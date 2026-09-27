import { describe, expect, it } from "vitest";
import {
  createNavidromeProviderFromEnv,
  navidromeOptionsFromEnv,
} from "./index.ts";

describe("createNavidromeProviderFromEnv", () => {
  it("requires a URL, username, and password", () => {
    expect(createNavidromeProviderFromEnv({})).toBeUndefined();
    expect(
      createNavidromeProviderFromEnv({
        NAVIDROME_BASE_URL: "http://navidrome:4533",
        NAVIDROME_USERNAME: "listener",
      }),
    ).toBeUndefined();
  });

  it("accepts bare and THEBE-prefixed names with fallback URL", () => {
    expect(
      navidromeOptionsFromEnv({
        THEBE_NAVIDROME_BASE_URL: "http://navidrome:4533",
        THEBE_NAVIDROME_USERNAME: "listener",
        THEBE_NAVIDROME_PASSWORD: "secret",
        NAVIDROME_FALLBACK_URL: "https://music.example.com",
      }),
    ).toEqual({
      baseUrl: "http://navidrome:4533",
      username: "listener",
      password: "secret",
      fallbackUrl: "https://music.example.com",
    });

    expect(
      createNavidromeProviderFromEnv({
        NAVIDROME_BASE_URL: "http://navidrome:4533",
        NAVIDROME_USERNAME: "listener",
        NAVIDROME_PASSWORD: "secret",
      }),
    ).toMatchObject({ service: "navidrome" });
  });
});
