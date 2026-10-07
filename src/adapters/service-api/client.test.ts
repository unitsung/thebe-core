import { describe, expect, it } from "vitest";
import { createServiceAPIProvidersFromEnv } from "./client.ts";

describe("service connection composition", () => {
  it("accepts arbitrary services without registering tools or service names in code", () => {
    expect(createServiceAPIProvidersFromEnv({})).toEqual([]);
    const connections = createServiceAPIProvidersFromEnv({ THEBE_SERVICE_APIS: JSON.stringify([
      { id: "new-service", baseURL: "https://service.invalid", headersEnv: { "X-API-Key": "CUSTOM_API_KEY" } },
      { id: "another-service", baseURL: "https://other.invalid", openapiPath: "/v3/description" },
    ]), CUSTOM_API_KEY: "private-key" });
    expect(connections.map(provider => provider.id)).toEqual(["new-service", "another-service"]);
  });
  it("preserves existing connection variables and lets generic configuration override them", () => {
    expect(createServiceAPIProvidersFromEnv({ THEBE_OPENLIST_BASE_URL: "https://files.invalid", THEBE_OPENLIST_TOKEN: "secret" }).map(p => p.id)).toEqual(["openlist"]);
    expect(createServiceAPIProvidersFromEnv({ THEBE_OPENLIST_BASE_URL: "https://files.invalid", THEBE_OPENLIST_TOKEN: "secret",
      THEBE_SERVICE_APIS: JSON.stringify([{ id: "openlist", baseURL: "https://replacement.invalid" }]) })).toHaveLength(1);
  });
  it("rejects missing credential references and duplicate connection names", () => {
    expect(() => createServiceAPIProvidersFromEnv({ THEBE_SERVICE_APIS: JSON.stringify([{ id: "files", baseURL: "https://files.invalid", headersEnv: { Authorization: "MISSING_AUTH" } }]) })).toThrow("Missing environment variable");
    expect(() => createServiceAPIProvidersFromEnv({ THEBE_SERVICE_APIS: JSON.stringify([{ id: "files", baseURL: "https://files.invalid" }, { id: "files", baseURL: "https://other.invalid" }]) })).toThrow("Duplicate");
  });
});
