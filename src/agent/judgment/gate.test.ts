import { describe, expect, it } from "vitest";
import { DEFAULT_JEV_MODEL, DEFAULT_TYPESAFE_BASE_URL, readJudgmentGate } from "./gate.ts";

describe("readJudgmentGate", () => {
  it("defaults off", () => {
    expect(readJudgmentGate({})).toEqual({ adapter: "off" });
  });

  it("stays off without an API key", () => {
    expect(readJudgmentGate({ THEBE_JUDGMENT_MODEL: "jev" })).toEqual({
      adapter: "off",
    });
  });

  it("enables Jev when the adapter and key are set", () => {
    expect(
      readJudgmentGate({
        THEBE_JUDGMENT_MODEL: "JEV",
        THEBE_TYPESAFE_API_KEY: " ts-key ",
      }),
    ).toEqual({
      adapter: "jev",
      apiKey: "ts-key",
      baseUrl: DEFAULT_TYPESAFE_BASE_URL,
      model: DEFAULT_JEV_MODEL,
      sites: "all",
    });
  });

  it("can enable only named Sites", () => {
    expect(
      readJudgmentGate({
        THEBE_JUDGMENT_MODEL: "jev",
        THEBE_TYPESAFE_API_KEY: "ts-key",
        THEBE_JUDGMENT_SITES: "home.attention, intent.capability",
      }),
    ).toEqual({
      adapter: "jev",
      apiKey: "ts-key",
      baseUrl: DEFAULT_TYPESAFE_BASE_URL,
      model: DEFAULT_JEV_MODEL,
      sites: ["home.attention", "intent.capability"],
    });
  });
});
