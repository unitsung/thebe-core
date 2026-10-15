import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createJsonAgentSettingsStore } from "../../agent/settings/store.ts";
import { createThebeApp } from "../../app/create.ts";
import { createThebeHttpHandler } from "./handler.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "unused",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("Agent settings product HTTP", () => {
  it("reports effective values and whether each value is configured or defaulted", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      workspacePath: "/tmp/thebe-settings-workspace",
      outputDirectory: "/tmp/thebe-settings-workspace/.thebe/outputs",
    });

    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/agent")
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      autoCompact: true,
      autoSummary: true,
      autoSummaryDelayMs: 120_000,
      permissionMode: "manual",
      maxSubagentConcurrency: 3,
      maxSubagentsPerParent: 2,
      workspacePath: "/tmp/thebe-settings-workspace",
      outputDirectory: "/tmp/thebe-settings-workspace/.thebe/outputs",
      instructions: "",
      sources: {
        autoCompact: "default",
        autoSummary: "default",
        autoSummaryDelayMs: "default",
        permissionMode: "default",
        maxSubagentConcurrency: "default",
        maxSubagentsPerParent: "default",
        workspacePath: "configured",
        outputDirectory: "configured",
        instructions: "default",
      },
      persistence: { enabled: false },
      mutable: ["autoCompact", "autoSummary", "autoSummaryDelayMs", "instructions"],
    });
  });

  it("updates the owner instructions and refuses text over 4096 bytes", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      workspacePath: "/tmp/thebe-settings-workspace",
    });
    const patch = (body: unknown) =>
      app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/settings/agent", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );

    const ok = await patch({ instructions: "  Reply in Chinese.\r\n" });
    expect(ok.status).toBe(200);
    expect((await json(ok)).instructions).toBe("Reply in Chinese.");

    const tooLong = await patch({ instructions: "a".repeat(4_097) });
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(await json(tooLong))).toContain("4097 bytes");

    const wrongType = await patch({ instructions: 5 });
    expect(wrongType.status).toBe(400);

    const read = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/agent")
    );
    expect((await json(read)).instructions).toBe("Reply in Chinese.");

    const cleared = await patch({ instructions: "" });
    expect((await json(cleared)).instructions).toBe("");
  });

  it("updates mutable settings and clamps the summary delay to the safe range", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({
      runtime: fake.runtime,
      provider: provider(),
    });

    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/agent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          autoCompact: false,
          autoSummary: false,
          autoSummaryDelayMs: 1,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual(
      expect.objectContaining({
        autoCompact: false,
        autoSummary: false,
        autoSummaryDelayMs: 60_000,
      })
    );

    const session = await app.agent.createSession();
    expect(fake.snapshot(session.runtimeSessionId).autoCompact).toBe(false);
  });

  it("reports bounded effective concurrency values", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      maxSubagentConcurrency: 99,
      maxSubagentsPerParent: 98,
    });

    const settings = await json(
      await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/settings/agent")
      )
    );

    expect(settings).toEqual(
      expect.objectContaining({
        maxSubagentConcurrency: 16,
        maxSubagentsPerParent: 16,
        sources: expect.objectContaining({
          maxSubagentConcurrency: "configured",
          maxSubagentsPerParent: "configured",
        }),
      })
    );
  });

  it("restores persisted mutable settings in a new Agent instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-agent-settings-"));
    const configPath = join(dir, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        theme: "dark",
        providers: { notes: { baseUrl: "https://example.test" } },
      })
    );
    const first = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      settingsStore: createJsonAgentSettingsStore(configPath),
    });

    const updated = await first.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/agent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          autoCompact: false,
          autoSummary: false,
          autoSummaryDelayMs: 300_000,
        }),
      })
    );
    expect(updated.status).toBe(200);

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      settingsStore: createJsonAgentSettingsStore(configPath),
    });
    const restored = await restarted.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/agent")
    );

    expect(await json(restored)).toEqual(
      expect.objectContaining({
        autoCompact: false,
        autoSummary: false,
        autoSummaryDelayMs: 300_000,
        sources: expect.objectContaining({
          autoCompact: "configured",
          autoSummary: "configured",
          autoSummaryDelayMs: "configured",
        }),
        persistence: { enabled: true },
      })
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      theme: "dark",
      providers: { notes: { baseUrl: "https://example.test" } },
      autoCompact: false,
      autoSummary: false,
      autoSummaryDelayMs: 300_000,
    });
  });

  it("documents the Agent settings routes and named schemas", async () => {
    const response = await createThebeHttpHandler({ version: "0.1.0" }).handle(
      new Request("http://127.0.0.1:8787/openapi.json")
    );
    const document = await json(response);

    expect(document.paths).toEqual(
      expect.objectContaining({
        "/v1/settings/agent": expect.objectContaining({
          get: expect.any(Object),
          patch: expect.any(Object),
        }),
      })
    );
    expect(document.components).toEqual(
      expect.objectContaining({
        schemas: expect.objectContaining({
          AgentSettings: expect.any(Object),
          AgentSettingsPatch: expect.any(Object),
        }),
      })
    );
  });

  it("returns stable validation errors for invalid and guarded fields", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const cases = [
      {
        body: { autoSummary: "yes" },
        error: "autoSummary must be a boolean",
        status: 400,
      },
      {
        body: { maxSubagentConcurrency: "one" },
        error: "maxSubagentConcurrency must be a finite number",
        status: 400,
      },
      {
        body: { workspacePath: "/tmp/other" },
        error: "workspacePath cannot be updated through /v1/settings/agent",
        status: 400,
      },
      {
        body: {},
        error: "at least one Agent setting is required",
        status: 400,
      },
    ];

    for (const item of cases) {
      const response = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/settings/agent", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(item.body),
        })
      );
      expect(response.status).toBe(item.status);
      expect(await json(response)).toEqual({
        ok: false,
        error: item.error,
        code: "invalid_body",
      });
    }
  });

  it("blocks Agent setting mutations while Core is quiesced", async () => {
    const fake = createFakeRuntime();
    const app = createThebeApp({ runtime: fake.runtime, provider: provider() });
    await fake.runtime.quiesce();

    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/agent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ autoSummary: false }),
      })
    );

    expect(response.status).toBe(503);
    expect(await json(response)).toEqual({
      ok: false,
      error:
        "System is quiesced for maintenance; write operations are temporarily disabled",
    });
  });

  it("reports restart-required for concurrency changes instead of claiming a live update", async () => {
    const app = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });

    const response = await app.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/agent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxSubagentConcurrency: 1 }),
      })
    );

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({
      ok: false,
      error: "maxSubagentConcurrency requires a Core restart",
      code: "restart_required",
    });
    expect(app.agent.getAgentSettings().maxSubagentConcurrency).toBe(3);
  });

  it("persists permission mode through the existing permission settings route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-permission-settings-"));
    const configPath = join(dir, "config.json");
    const first = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      settingsStore: createJsonAgentSettingsStore(configPath),
    });

    const patched = await first.handler.handle(
      new Request("http://127.0.0.1:8787/v1/settings/permissions", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "acceptEdits" }),
      })
    );
    expect(patched.status).toBe(200);

    const restarted = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      settingsStore: createJsonAgentSettingsStore(configPath),
    });
    const permissionSettings = await json(
      await restarted.handler.handle(
        new Request("http://127.0.0.1:8787/v1/settings/permissions")
      )
    );
    const agentSettings = await json(
      await restarted.handler.handle(
        new Request("http://127.0.0.1:8787/v1/settings/agent")
      )
    );

    expect(permissionSettings).toEqual({ mode: "acceptEdits" });
    expect(agentSettings).toEqual(
      expect.objectContaining({
        permissionMode: "acceptEdits",
        sources: expect.objectContaining({ permissionMode: "configured" }),
      })
    );
  });

  it("reports the full-access host gate and enables it per session", async () => {
    const closed = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
    });
    const closedSupport = await json(
      await closed.handler.handle(
        new Request("http://127.0.0.1:8787/v1/settings/full-access")
      )
    );
    expect(closedSupport).toEqual({ allowed: false });
    const closedSession = await closed.agent.createSession();
    const refused = await closed.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${closedSession.thebeSessionId}/full-access`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }
      )
    );
    expect(refused.status).toBe(403);
    expect(await json(refused)).toEqual({
      ok: false,
      error: "bypassPermissions is not enabled on this Core host",
      code: "full_access_not_allowed",
    });

    const open = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      fullAccessAllowed: true,
    });
    const openSupport = await json(
      await open.handler.handle(
        new Request("http://127.0.0.1:8787/v1/settings/full-access")
      )
    );
    expect(openSupport).toEqual({ allowed: true });

    const session = await open.agent.createSession();
    const invalid = await open.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/full-access`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: "yes" }),
        }
      )
    );
    expect(invalid.status).toBe(400);

    const enabled = await open.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/full-access`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }
      )
    );
    expect(enabled.status).toBe(200);
    expect(await json(enabled)).toEqual({
      thebeSessionId: session.thebeSessionId,
      fullAccess: true,
    });
    const readBack = await json(
      await open.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}`
        )
      )
    );
    expect(readBack.permissionMode).toBe("bypassPermissions");

    const disabled = await open.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/full-access`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        }
      )
    );
    expect(await json(disabled)).toEqual({
      thebeSessionId: session.thebeSessionId,
      fullAccess: false,
    });
    const afterDisable = await json(
      await open.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}`
        )
      )
    );
    expect(afterDisable.permissionMode).toBeUndefined();
  });

  it("sets and reads the permission mode of one session, and lets bypassPermissions in only where the host allows it", async () => {
    const closed = createThebeApp({ runtime: createFakeRuntime().runtime, provider: provider() });
    const session = await closed.agent.createSession();
    const url = `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/permissions`;
    const put = (app: typeof closed, mode: unknown) =>
      app.handler.handle(
        new Request(url, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        })
      );

    expect(await json(await closed.handler.handle(new Request(url)))).toEqual({
      thebeSessionId: session.thebeSessionId,
      mode: "manual",
      inherited: true,
    });
    expect(await json(await put(closed, "plan"))).toEqual({
      thebeSessionId: session.thebeSessionId,
      mode: "plan",
    });
    expect(await json(await closed.handler.handle(new Request(url)))).toEqual({
      thebeSessionId: session.thebeSessionId,
      mode: "plan",
      inherited: false,
    });
    // Another session is untouched.
    const other = await closed.agent.createSession();
    expect(
      (await closed.agent.sessionPermissionMode(other.thebeSessionId)).mode
    ).toBe("manual");

    // Only the four names are accepted.
    expect((await put(closed, "read-only")).status).toBe(400);
    expect((await put(closed, "bypassPermissions")).status).toBe(403);
    expect((await put(closed, "nonsense")).status).toBe(400);
    expect(await json(await put(closed, null))).toEqual({
      thebeSessionId: session.thebeSessionId,
      mode: "manual",
    });

    const open = createThebeApp({
      runtime: createFakeRuntime().runtime,
      provider: provider(),
      fullAccessAllowed: true,
    });
    const openSession = await open.agent.createSession();
    const openUrl = `http://127.0.0.1:8787/v1/session/${openSession.thebeSessionId}/permissions`;
    const response = await open.handler.handle(
      new Request(openUrl, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "bypassPermissions" }),
      })
    );
    expect(await json(response)).toEqual({
      thebeSessionId: openSession.thebeSessionId,
      mode: "bypassPermissions",
    });
  });
});
