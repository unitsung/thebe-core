import { describe, expect, it } from "vitest";
import {
  createOpenListBackgroundTaskProviderFromEnv,
  createOpenListStrmRepairProviderFromEnv,
} from "./index.ts";

describe("createOpenListStrmRepairProviderFromEnv", () => {
  it("does not configure a provider when either OpenList credential is missing", () => {
    expect(
      createOpenListStrmRepairProviderFromEnv({
        THEBE_OPENLIST_BASE_URL: "https://openlist.test",
      }),
    ).toBeUndefined();
    expect(
      createOpenListStrmRepairProviderFromEnv({
        THEBE_OPENLIST_TOKEN: "token",
      }),
    ).toBeUndefined();
  });

  it("creates the OpenList STRM provider from the Core environment", () => {
    const provider = createOpenListStrmRepairProviderFromEnv({
      THEBE_OPENLIST_BASE_URL: " https://openlist.test/ ",
      THEBE_OPENLIST_TOKEN: " token ",
    });

    expect(provider?.service).toBe("openlist");
  });

  it("creates the OpenList background task provider from the same credentials", () => {
    const provider = createOpenListBackgroundTaskProviderFromEnv({
      OPENLIST_BASE_URL: " https://openlist.test/ ",
      OPENLIST_TOKEN: " token ",
    });

    expect(provider?.service).toBe("openlist");
  });
});
