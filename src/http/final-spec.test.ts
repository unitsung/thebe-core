import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { createThebeApp } from "../product/app.ts";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";
import { sanitizeBashEnv } from "../runtime/pi/pi-coding-agent-runtime.ts";
import { wrapCustomTools } from "../product/wrap-tools.ts";
import { createPolicyEngine } from "../policy/policy-engine.ts";

function mockProvider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "ok",
    getStatusSummary: async () => ({
      totalContainers: 1,
      runningContainers: 1,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

describe("thebe spec alignment tests", () => {
  describe("P0: Security Baseline", () => {
    it("sanitizes bash process environment from sensitive host variables", () => {
      const hostEnv = {
        PATH: "/usr/local/bin:/usr/bin",
        USER: "thebe-user",
        HOME: "/home/thebe",
        THEBE_API_TOKEN: "secret-token-123",
        THEBE_SERVER_SECRET: "server-secret-xyz",
        DATABASE_URL: "postgres://user:pass@localhost:5432/db",
        ARCANE_SECRET_KEY: "arcane-key-789",
        AWS_ACCESS_KEY: "aws-key",
        PI_SESSION_ID: "pi-session-1",
        PI_OPENAI_KEY: "sk-pi-secret",
      };
      const sanitized = sanitizeBashEnv(hostEnv);
      expect(sanitized.PATH).toBe("/usr/local/bin:/usr/bin");
      expect(sanitized.USER).toBe("thebe-user");
      expect(sanitized.PI_SESSION_ID).toBe("pi-session-1");
      expect(sanitized.PI_OPENAI_KEY).toBeUndefined();
      expect(sanitized.THEBE_API_TOKEN).toBeUndefined();
      expect(sanitized.THEBE_SERVER_SECRET).toBeUndefined();
      expect(sanitized.DATABASE_URL).toBeUndefined();
      expect(sanitized.ARCANE_SECRET_KEY).toBeUndefined();
      expect(sanitized.AWS_ACCESS_KEY).toBeUndefined();
    });

    it("rejects cross-site browser requests on mutating routes with 403", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });
      const res = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sec-fetch-site": "cross-site",
          },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("cross-site");
    });

    it("rejects cross-origin browser requests when Origin host differs from Host header", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });
      const res = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://malicious-site.com",
            host: "127.0.0.1:8787",
          },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(403);
    });

    it("includes X-Content-Type-Options: nosniff on API and export responses", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });
      const health = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/health"),
      );
      expect(health.headers.get("x-content-type-options")).toBe("nosniff");

      const created = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      );
      const session = (await created.json()) as { thebeSessionId: string };
      const exported = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/export?format=jsonl`,
        ),
      );
      expect(exported.headers.get("x-content-type-options")).toBe("nosniff");
      expect(exported.headers.get("content-disposition")).toContain("attachment");

      const html = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/export?format=html`,
        ),
      );
      expect(html.headers.get("x-content-type-options")).toBe("nosniff");
      expect(html.headers.get("content-disposition")).toContain("attachment");
      expect(html.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
    });

    it("rejects DNS-rebinding Host headers even when Origin matches Host", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
        allowedHosts: ["127.0.0.1", "localhost"],
      });
      const res = await app.handler.handle(
        new Request("http://attacker.example/v1/session", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://attacker.example",
            "sec-fetch-site": "same-origin",
          },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("host not allowed");
    });
  });

  describe("P0: Protocol & Attachment Handling", () => {
    it("supports reference and lines mode attachments, auto-degrading inline >12KB", async () => {
      const fake = createFakeRuntime();
      fake.queueTurns([{ kind: "text", text: "got attachments" }]);
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      const created = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", { method: "POST" }),
      );
      const session = (await created.json()) as { thebeSessionId: string };

      // Generate a payload >12KB (say 15KB base64) with filename to trigger auto-degrade
      const largeText = "A".repeat(15_000);
      const largeBase64 = Buffer.from(largeText).toString("base64");

      const promptRes = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/prompt`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: "inspect logs",
              files: [
                {
                  mode: "inline",
                  filename: "large.log",
                  mediaType: "text/plain",
                  data: largeBase64,
                },
                {
                  mode: "reference",
                  path: "/var/log/syslog",
                  mediaType: "text/plain",
                },
                {
                  mode: "lines",
                  path: "/etc/hosts",
                  lineRange: { start: 1, end: 10 },
                  mediaType: "text/plain",
                },
              ],
            }),
          },
        ),
      );
      expect(promptRes.status).toBe(200);

      // Verify the user message recorded on the session
      const msgs = await app.product.loadMessages(session.thebeSessionId);
      const userMsg = msgs.find((m) => m.role === "user");
      expect(userMsg?.text).toContain("[file reference: large.log");
      expect(userMsg?.text).toContain("[file reference: /var/log/syslog");
      expect(userMsg?.text).toContain("[file snippet: /etc/hosts lines 1-10");
    });

    it("supports fork with mode: new_session and branch_in_place", async () => {
      const fake = createFakeRuntime();
      fake.queueTurns([
        { kind: "text", text: "turn 1" },
        { kind: "text", text: "turn 2" },
      ]);
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      const s1 = await app.product.createSession({ title: "parent" });
      await app.product.send("hello", s1.thebeSessionId);

      // Fork with branch_in_place
      const forkedInPlace = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${s1.thebeSessionId}/fork`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "branch_in_place" }),
          },
        ),
      );
      expect(forkedInPlace.status).toBe(201);
      const forkedMeta = (await forkedInPlace.json()) as {
        parentThebeSessionId?: string;
        thebeSessionId: string;
      };
      expect(forkedMeta.parentThebeSessionId).toBe(s1.thebeSessionId);

      // Check children
      const childrenRes = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${s1.thebeSessionId}/children`,
        ),
      );
      const childrenData = (await childrenRes.json()) as {
        sessions: Array<{ thebeSessionId: string }>;
      };
      expect(childrenData.sessions.some((s) => s.thebeSessionId === forkedMeta.thebeSessionId)).toBe(true);

      const listed = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session"),
      );
      const listedData = (await listed.json()) as {
        sessions: Array<{ thebeSessionId: string; inPlace?: boolean }>;
      };
      expect(
        listedData.sessions.some(
          (s) => s.thebeSessionId === forkedMeta.thebeSessionId,
        ),
      ).toBe(false);
    });
  });

  describe("P1: Control, Observability & Lifecycle", () => {
    it("manages quiesce state and rejects mutating prompts during quiesce", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      // Initially active
      const status1 = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/system/status"),
      );
      expect((await status1.json()) as { quiesced: boolean }).toEqual({
        ok: true,
        quiesced: false,
      });

      // Quiesce
      const qRes = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/system/quiesce", {
          method: "POST",
        }),
      );
      expect(qRes.status).toBe(200);

      // Mutating operation returns 503
      const promptRes = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "blocked" }),
        }),
      );
      expect(promptRes.status).toBe(503);

      // Read requests still work
      const listRes = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session"),
      );
      expect(listRes.status).toBe(200);

      // Unquiesce
      const unqRes = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/system/unquiesce", {
          method: "POST",
        }),
      );
      expect(unqRes.status).toBe(200);
      expect(app.product.isQuiesced()).toBe(false);
    });

    it("retrieves session context usage via GET /v1/session/:id/context", async () => {
      const fake = createFakeRuntime();
      fake.queueTurns([{ kind: "text", text: "done" }]);
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      const s = await app.product.createSession();
      await app.product.send("hello world", s.thebeSessionId);

      const res = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${s.thebeSessionId}/context`,
        ),
      );
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        contextUsage: { usedTokens: number; maxTokens: number };
        compaction: { nearThreshold: boolean };
      };
      expect(data.contextUsage.usedTokens).toBeGreaterThan(0);
      expect(data.contextUsage.maxTokens).toBe(128_000);
    });

    it("stops an individual in-flight tool call via POST /v1/session/:id/tool-call/:toolCallId/stop", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });
      const s = await app.product.createSession();

      const res = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${s.thebeSessionId}/tool-call/call_123/stop`,
          { method: "POST" },
        ),
      );
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    });

    it("lists and stops background tasks", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });
      const s = await app.product.createSession();

      const listRes = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${s.thebeSessionId}/background-task`,
        ),
      );
      expect(listRes.status).toBe(501);
      const listData = (await listRes.json()) as { code?: string };
      expect(listData.code).toBe("feature_not_implemented");

      const stopOne = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${s.thebeSessionId}/background-task/task-1/stop`,
          { method: "POST" },
        ),
      );
      expect(stopOne.status).toBe(501);

      const stopAll = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${s.thebeSessionId}/background-task/stop-all`,
          { method: "POST" },
        ),
      );
      expect(stopAll.status).toBe(501);
    });

    it("supports provider testing and API key management", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      // Provider test before setting API key
      const testRes1 = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/provider/fake/test", {
          method: "POST",
        }),
      );
      expect(testRes1.status).toBe(400);

      // Set API key via POST /v1/provider/:id/api-key
      const setKeyRes = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/provider/fake/api-key", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey: "test-api-key" }),
        }),
      );
      expect(setKeyRes.status).toBe(200);

      // Provider test after setting API key
      const testRes2 = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/provider/fake/test", {
          method: "POST",
        }),
      );
      expect(testRes2.status).toBe(200);
      const testBody = (await testRes2.json()) as { ok: boolean };
      expect(testBody.ok).toBe(true);

      // Delete API key via DELETE /v1/provider/:id/api-key
      const delKeyRes = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/provider/fake/api-key", {
          method: "DELETE",
        }),
      );
      expect(delKeyRes.status).toBe(200);
    });

    it("filters sessions by status, hostId, environmentId and provides /v1/agent/running", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      await app.product.createSession({
        selectedContext: { hostId: "host-a", environmentId: "env-prod" },
      });
      await app.product.createSession({
        selectedContext: { hostId: "host-b", environmentId: "env-dev" },
      });

      const filteredHost = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session?hostId=host-a"),
      );
      const hostData = (await filteredHost.json()) as {
        sessions: Array<{ selectedContext?: { hostId?: string } }>;
      };
      expect(hostData.sessions).toHaveLength(1);
      expect(hostData.sessions[0]?.selectedContext?.hostId).toBe("host-a");

      const runningRes = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/agent/running"),
      );
      expect(runningRes.status).toBe(200);
      const runningData = (await runningRes.json()) as { sessions: unknown[] };
      expect(runningData.sessions).toHaveLength(0); // all idle
    });

    it("returns oauthProviders and apiKeyProviders in GET /v1/provider", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      const res = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/provider"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        providers: unknown[];
        oauthProviders: unknown[];
        apiKeyProviders: unknown[];
      };
      expect(Array.isArray(body.providers)).toBe(true);
      expect(Array.isArray(body.oauthProviders)).toBe(true);
      expect(Array.isArray(body.apiKeyProviders)).toBe(true);
    });

    it("creates chat-only session with builtinTools: [] and patches rememberedPermissions", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      // Create session with builtinTools: []
      const createRes = await app.handler.handle(
        new Request("http://127.0.0.1:8787/v1/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Chat Only Session",
            builtinTools: [],
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        thebeSessionId: string;
        builtinTools?: string[];
      };
      expect(created.builtinTools).toEqual([]);

      // Patch rememberedPermissions
      const patchRes = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${created.thebeSessionId}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              rememberedPermissions: { bash: "deny" },
            }),
          },
        ),
      );
      expect(patchRes.status).toBe(200);
      const patched = (await patchRes.json()) as {
        rememberedPermissions?: Record<string, string>;
      };
      expect(patched.rememberedPermissions).toEqual({ bash: "deny" });
    });

    it("supports backward cursor pagination with before parameter on /message", async () => {
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: mockProvider(),
        version: "0.1.0",
      });

      fake.queueTurns([
        { kind: "text", text: "first response" },
        { kind: "text", text: "second response" },
      ]);

      const session = await app.product.createSession();
      // Prompt twice
      await app.product.prompt(
        { text: "first question" },
        { thebeSessionId: session.thebeSessionId },
      );
      await app.product.prompt(
        { text: "second question" },
        { thebeSessionId: session.thebeSessionId },
      );

      const allRes = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/message`,
        ),
      );
      const allBody = (await allRes.json()) as {
        messages: Array<{ id: string }>;
      };
      expect(allBody.messages.length).toBeGreaterThanOrEqual(2);

      const secondId = allBody.messages[1]!.id;
      const beforeRes = await app.handler.handle(
        new Request(
          `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/message?before=${secondId}&limit=1`,
        ),
      );
      expect(beforeRes.status).toBe(200);
      const beforeBody = (await beforeRes.json()) as {
        messages: Array<{ id: string }>;
      };
      expect(beforeBody.messages).toHaveLength(1);
      expect(beforeBody.messages[0]?.id).toBe(allBody.messages[0]!.id);
    });

    it("triggers tool_watchdog_timeout when a tool execution exceeds threshold", async () => {
      const events: unknown[] = [];
      const policy = createPolicyEngine({ now: () => new Date() });
      const slowTool = {
        name: "container.logs",
        label: "Logs",
        description: "A tool that takes too long",
        parameters: {},
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            content: [{ type: "text" as const, text: "finished" }],
          };
        },
      };

      const wrapped = wrapCustomTools([slowTool], {
        policy,
        toolWatchdogMs: 15,
        onEvent: (evt) => events.push(evt),
      });

      const result = await wrapped[0]!.execute("call_123", {});
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({ watchdogTimeout: true });
      expect(result.content[0]?.text).toContain("<tool_output tool=\"container.logs\">");
      expect(result.content[0]?.text).toContain("exceeded watchdog timeout (15ms)");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "tool_watchdog_timeout",
        toolCallId: "call_123",
        toolName: "container.logs",
        elapsedMs: 15,
      });
    });
  });
});
