import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

describe("GET /v1/system/isolation", () => {
  const original = process.env.THEBE_SANDBOX;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.THEBE_SANDBOX;
    } else {
      process.env.THEBE_SANDBOX = original;
    }
  });

  it("reports the effective posture and echoes the workspace path", async () => {
    process.env.THEBE_SANDBOX = "off";
    const dir = await mkdtemp(join(tmpdir(), "thebe-isolation-http-"));
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "0.1.0",
      workspacePath: dir,
    });
    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/system/isolation"),
    );
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      sandbox: { mode: string; enforced: boolean; fallback: boolean };
      workspace: { path: string; exists: boolean };
      commandGuard: boolean;
    };
    expect(report.sandbox.mode).toBe("off");
    expect(report.sandbox.fallback).toBe(false);
    expect(report.commandGuard).toBe(true);
    expect(report.workspace.path).toBe(dir);
    expect(report.workspace.exists).toBe(true);
  });

  it("is documented in the OpenAPI document", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      version: "0.1.0",
    });
    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/openapi.json"),
    );
    const document = (await response.json()) as { paths: Record<string, unknown> };
    expect(document.paths).toHaveProperty("/v1/system/isolation");
  });
});
