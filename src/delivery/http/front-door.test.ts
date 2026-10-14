import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { createThebeApp } from "../../app/create.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { agentError } from "./parsing/errors.ts";
import { httpError } from "../../agent/types.ts";

const provider: ContainerInfoProvider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => "",
  getStatusSummary: async () => {
    throw new Error("unused");
  },
};

const app = () => createThebeApp({ runtime: createFakeRuntime().runtime, provider }).handler;
const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

describe("request bodies", () => {
  it("answers a body that is not JSON with 400, not as if it were empty", async () => {
    const response = await app().handle(post("/v1/session", "{not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "invalid_body" });
  });

  it("still treats no body at all as an empty request", async () => {
    const response = await app().handle(post("/v1/session", ""));
    expect(response.status).toBe(201);
  });
});

describe("error status", () => {
  it("uses the status an error carries", async () => {
    const response = agentError(httpError(404, "unknown thing", "not_found"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("does not guess 404 from the wording of an unexpected failure", () => {
    expect(agentError(new Error("unknown host in the middle of a request")).status).toBe(500);
    expect(agentError(new Error("file not found")).status).toBe(500);
  });
});

describe("token check", () => {
  const guarded = () => createThebeHttpHandler({ version: "t", token: "s3cret-token" });

  it("accepts the token and rejects near misses of any length", async () => {
    for (const [value, status] of [
      ["s3cret-token", 200],
      ["s3cret-toke", 401],
      ["s3cret-tokenX", 401],
      ["", 401],
    ] as const) {
      const response = await guarded().handle(
        new Request("http://127.0.0.1:8787/v1/health", { headers: { "X-Thebe-Token": value } })
      );
      expect(response.status).toBe(status);
    }
  });
});
