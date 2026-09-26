import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPiCodingAgentRuntime } from "../pi/runtime.ts";
import { loadPiSdk } from "../pi/sdk/load-pi.ts";
import { ANTIGRAVITY_PROVIDER_ID } from "./antigravity.ts";
import { ANTIGRAVITY_BASELINE_IDS } from "./antigravity-provider.ts";

/**
 * End-to-end check of the Core wiring: the Pi runtime must expose the
 * Antigravity provider through the same `/v1/provider` surface as Pi's own
 * providers, and route its OAuth calls to the Google adapter.
 */
describe("Antigravity provider through the Pi runtime", () => {
  it("lists the provider and answers its OAuth contract", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "thebe-antigravity-runtime-"));
    const runtime = await createPiCodingAgentRuntime({
      cwd: agentDir,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
    });

    const providers = await runtime.listProviders();
    const antigravity = providers.filter((provider) => provider.id === ANTIGRAVITY_PROVIDER_ID);
    expect(antigravity).toHaveLength(1);
    expect(antigravity[0]).toMatchObject({
      authMethods: ["oauth"],
      authStatus: "missing",
    });

    const authorize = await runtime.auth().authorizeOAuth(ANTIGRAVITY_PROVIDER_ID, {});
    expect(authorize.pending).toBe(true);
    expect(authorize.pending && authorize.url).toContain("accounts.google.com");
    expect(await runtime.auth().check(ANTIGRAVITY_PROVIDER_ID)).toEqual({ ok: false });

    // Not connected: the provider is registered with its offline seed models,
    // none of them available, no API key path, and the probe reports a message
    // instead of throwing (it never reaches the network without a credential).
    const models = await runtime.listModels({ providerId: ANTIGRAVITY_PROVIDER_ID });
    expect(models.map((model) => model.modelId)).toEqual(ANTIGRAVITY_BASELINE_IDS);
    expect(models.every((model) => model.available === false)).toBe(true);
    expect(
      await runtime.listAvailableModels({ providerId: ANTIGRAVITY_PROVIDER_ID }),
    ).toEqual([]);

    // The same models are part of the Pi catalog, so sessions can resolve them.
    const all = await runtime.listModels({ all: true });
    expect(
      all
        .filter((model) => model.providerId === ANTIGRAVITY_PROVIDER_ID)
        .map((model) => model.modelId),
    ).toEqual(ANTIGRAVITY_BASELINE_IDS);

    const probe = await runtime.auth().testProvider(ANTIGRAVITY_PROVIDER_ID);
    expect(probe.ok).toBe(false);
    expect(probe.message).toContain("not connected");
    await expect(runtime.auth().setApiKey(ANTIGRAVITY_PROVIDER_ID, "key")).rejects.toThrow(
      "Google OAuth",
    );
  }, 60_000);

  it("chats through a Pi session stream with the stored Google session", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "thebe-antigravity-chat-"));
    const sdk = await loadPiSdk();
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const runtime = await createPiCodingAgentRuntime({
      cwd: agentDir,
      agentDir,
      sessionDir: join(agentDir, "sessions"),
      modelRuntime,
    });
    expect(runtime.runtimeId).toBeTruthy();

    // A Google session on disk is what makes the provider usable.
    writeFileSync(
      join(agentDir, "antigravity.json"),
      JSON.stringify({
        [ANTIGRAVITY_PROVIDER_ID]: {
          kind: "antigravity",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          projectId: "project-1",
          account: "person@example.com",
        },
      }),
      { mode: 0o600 },
    );

    const model = modelRuntime.getModel(ANTIGRAVITY_PROVIDER_ID, "gemini-3-pro");
    expect(model).toBeTruthy();
    const auth = await modelRuntime.getAuth(model);
    expect(auth).toMatchObject({
      auth: { apiKey: "access-token" },
      source: "Google account person@example.com",
    });

    const captured: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      captured.push({ url, body: JSON.parse(String(init?.body)) });
      const frames = [
        { response: { candidates: [{ content: { parts: [{ text: "Hello " }] } }] } },
        {
          response: {
            candidates: [{ content: { parts: [{ text: "from Pi" }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 },
          },
        },
      ];
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };

    const message = await modelRuntime
      .streamSimple(
        model as never,
        { systemPrompt: "You are Thebe.", messages: [{ role: "user", content: "hi" }] } as never,
        { fetch: fakeFetch as never },
      )
      .result();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toContain("/v1internal:streamGenerateContent?alt=sse");
    expect(captured[0]!.body).toMatchObject({
      project: "project-1",
      model: "gemini-3-pro",
      requestType: "agent",
    });
    expect(message.content).toMatchObject([{ type: "text", text: "Hello from Pi" }]);
    expect(message.stopReason).toBe("stop");
    expect(message.usage).toMatchObject({ input: 7, output: 2, totalTokens: 9 });
  }, 60_000);

  it("answers a Pi session prompt through Cloud Code Assist", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        calls.push({
          url: request.url ?? "",
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        const frames = [
          { response: { candidates: [{ content: { parts: [{ text: "ok " }] } }] } },
          {
            response: {
              candidates: [
                { content: { parts: [{ text: "from the session" }] }, finishReason: "STOP" },
              ],
              usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 },
            },
          },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    vi.stubEnv("THEBE_ANTIGRAVITY_ENDPOINT", `http://127.0.0.1:${port}`);
    try {
      const agentDir = mkdtempSync(join(tmpdir(), "thebe-antigravity-session-"));
      writeFileSync(
        join(agentDir, "antigravity.json"),
        JSON.stringify({
          [ANTIGRAVITY_PROVIDER_ID]: {
            kind: "antigravity",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            projectId: "project-1",
            account: "person@example.com",
          },
        }),
        { mode: 0o600 },
      );
      const runtime = await createPiCodingAgentRuntime({
        cwd: agentDir,
        agentDir,
        sessionDir: join(agentDir, "sessions"),
        inMemory: true,
      });
      const session = await runtime.createSession({
        customTools: [],
        builtinTools: [],
        inMemory: true,
        systemPrompt: "You are Thebe.",
        model: { providerId: ANTIGRAVITY_PROVIDER_ID, modelId: "gemini-3-pro" },
      });
      await session.prompt("say ok");

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/v1internal:streamGenerateContent?alt=sse");
      expect(calls[0]!.body).toMatchObject({
        project: "project-1",
        model: "gemini-3-pro",
        requestType: "agent",
      });
      expect(session.messages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "assistant", text: "ok from the session" }),
        ]),
      );
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
