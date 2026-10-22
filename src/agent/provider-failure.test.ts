import { describe, expect, it } from "vitest";
import { describeProviderFailure } from "./provider-failure.ts";

describe("describeProviderFailure", () => {
  it("reads an expired key as an upstream auth failure with the provider's own wording", () => {
    const failure = describeProviderFailure(
      '401 {"type":"error","error":{"type":"authentication_error","code":"api_key_expired","message":"This API key has expired."}}'
    );
    expect(failure).toEqual({
      status: 502,
      code: "provider_auth_failed",
      message:
        "The model provider rejected Core's credentials (401): This API key has expired.",
    });
  });

  it("separates rate limits and other upstream faults", () => {
    expect(describeProviderFailure("429 Too Many Requests")).toMatchObject({
      status: 429,
      code: "provider_rate_limited",
    });
    expect(describeProviderFailure("503")).toMatchObject({
      status: 502,
      code: "provider_error",
      message: "The model provider failed (503): HTTP 503",
    });
  });

  it("reads the colon form some providers use", () => {
    expect(
      describeProviderFailure(
        '503: {"message":"No available accounts: no available accounts","type":"api_error"}'
      )
    ).toEqual({
      status: 502,
      code: "provider_error",
      message:
        "The model provider failed (503): No available accounts: no available accounts",
    });
  });

  it("leaves everything that is not a provider reply alone", () => {
    expect(describeProviderFailure("session not found")).toBeUndefined();
    expect(describeProviderFailure("200 ok")).toBeUndefined();
    expect(describeProviderFailure("4040 widgets")).toBeUndefined();
  });
});
