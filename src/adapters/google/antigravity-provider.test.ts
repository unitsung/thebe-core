import { describe, expect, it } from "vitest";
import { piAiDistUrl } from "../pi/sdk/load-pi.ts";
import {
  ANTIGRAVITY_BASELINE_IDS,
  antigravityModelObjects,
  antigravityRequest,
  antigravityThinkingConfig,
  applyAntigravityChunk,
  closeAntigravityOutput,
  createAntigravityProvider,
  createAntigravityState,
  loadAntigravityPiAi,
  splitSseFrames,
  streamAntigravity,
  type AntigravityContext,
  type AntigravityEvent,
  type AntigravityPiModel,
} from "./antigravity-provider.ts";
import type { AntigravityCredential, FetchLike } from "./antigravity.ts";

const piAi = await loadAntigravityPiAi(piAiDistUrl);
const transcript = (await import(piAiDistUrl("utils/transcript.js"))) as {
  normalizeContext: (context: {
    systemPrompt?: string;
    tools?: unknown[];
    messages: unknown[];
  }) => AntigravityContext;
};

function model(id = "gemini-3-pro"): AntigravityPiModel {
  return antigravityModelObjects({
    providerId: "google-antigravity",
    endpoint: "https://cloudcode-pa.googleapis.com",
    models: [{ id, displayName: "Test Model" }],
  })[0]!;
}

function credential(): AntigravityCredential {
  return {
    kind: "antigravity",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    projectId: "project-1",
    account: "person@example.com",
  };
}

type CapturedRequest = { url: string; init: RequestInit | undefined };

function fakeFetch(
  captured: CapturedRequest[],
  respond: () => Response | Promise<Response>,
): FetchLike {
  return async (url, init) => {
    captured.push({ url, init });
    return respond();
  };
}

function sse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(stream: AsyncIterable<unknown>): Promise<AntigravityEvent[]> {
  const events: AntigravityEvent[] = [];
  for await (const event of stream) {
    events.push(event as AntigravityEvent);
  }
  return events;
}

describe("Antigravity requests", () => {
  it("envelopes a Gemini body for Cloud Code Assist", () => {
    const context = transcript.normalizeContext({
      systemPrompt: "You are Thebe.",
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    const request = antigravityRequest({
      piAi,
      model: model(),
      context,
      options: { maxTokens: 4096, toolChoice: "auto", reasoning: "medium" },
      credential: credential(),
    });

    expect(request.url).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    expect(request.body).toMatchObject({
      project: "project-1",
      model: "gemini-3-pro",
      requestType: "agent",
      userAgent: "antigravity",
    });
    const payload = request.body.request as Record<string, unknown>;
    expect(payload.systemInstruction).toEqual({ parts: [{ text: "You are Thebe." }] });
    expect(payload.contents).toMatchObject([
      { role: "user", parts: [{ text: "hello" }] },
    ]);
    expect(payload.tools).toMatchObject([
      { functionDeclarations: [{ name: "read", description: "Read a file" }] },
    ]);
    expect(payload.toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(payload.generationConfig).toMatchObject({
      maxOutputTokens: 4096,
      // Gemini 3 levels pass through by name (pi's own Google model mapping).
      thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    });
  });

  it("uses budgets below Gemini 3 and honours thinking off", () => {
    const twoFive = model("gemini-2.5-flash");
    expect(antigravityThinkingConfig(piAi, twoFive, { reasoning: "low" })).toEqual({
      includeThoughts: true,
      thinkingBudget: 2048,
    });
    expect(antigravityThinkingConfig(piAi, twoFive, { reasoning: "off" })).toEqual({
      thinkingBudget: 0,
    });
    // Gemini 3 cannot disable thinking: pi maps "off" to the lowest supported
    // level through the model's thinkingLevelMap.
    expect(antigravityThinkingConfig(piAi, model(), { reasoning: "off" })).toEqual({
      thinkingLevel: "MINIMAL",
    });
    expect(antigravityThinkingConfig(piAi, model(), {})).toBeUndefined();
  });

  it("keeps Claude models on the parameters field", () => {
    const request = antigravityRequest({
      piAi,
      model: model("claude-sonnet-4-5"),
      context: transcript.normalizeContext({
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
        tools: [
          { name: "read", description: "r", parameters: { type: "object", properties: {} } },
        ],
      }),
      options: {},
      credential: credential(),
    });
    const tools = (request.body.request as Record<string, unknown>).tools as Array<{
      functionDeclarations: Array<Record<string, unknown>>;
    }>;
    expect(tools[0]!.functionDeclarations[0]).toHaveProperty("parameters");
    expect(tools[0]!.functionDeclarations[0]).not.toHaveProperty("parametersJsonSchema");
  });
});

describe("Antigravity SSE parsing", () => {
  it("buffers partial frames and unwraps the response envelope", () => {
    const first = splitSseFrames('data: {"response":{"candidates":[]}}\n\ndata: {"cand');
    expect(first.payloads).toEqual(['{"response":{"candidates":[]}}']);
    const second = splitSseFrames(`${first.rest}idates":[]}\n\n`);
    expect(second.payloads).toEqual(['{"candidates":[]}']);
    expect(second.rest).toBe("");

    const multi = splitSseFrames("event: message\ndata: a\ndata: b\n\n");
    expect(multi.payloads).toEqual(["a\nb"]);
  });

  it("emits text, thinking, tool calls and usage for a chunk", () => {
    const events: AntigravityEvent[] = [];
    const state = createAntigravityState(model());
    const send = (event: AntigravityEvent) => events.push(event);

    applyAntigravityChunk({
      piAi,
      model: model(),
      state,
      send,
      chunk: {
        candidates: [
          {
            content: {
              parts: [
                { text: "thinking...", thought: true },
                { text: "hello" },
                { functionCall: { name: "read", args: { path: "/tmp/a" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 20,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 10,
          totalTokenCount: 140,
        },
      },
    });
    closeAntigravityOutput(state, send);

    expect(events.map((event) => event.type)).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
    expect(state.output.content).toMatchObject([
      { type: "thinking", thinking: "thinking..." },
      { type: "text", text: "hello" },
      { type: "toolCall", name: "read", arguments: { path: "/tmp/a" } },
    ]);
    expect(state.output.stopReason).toBe("toolUse");
    expect(state.output.usage).toMatchObject({
      input: 80,
      output: 40,
      cacheRead: 20,
      reasoning: 10,
      totalTokens: 140,
    });
  });
});

describe("Antigravity streaming", () => {
  it("streams SSE frames with bearer auth and reports usage", async () => {
    const captured: CapturedRequest[] = [];
    const deps = {
      piAi,
      credential: async () => credential(),
      fetchImpl: fakeFetch(captured, () =>
        sse([
          { response: { candidates: [{ content: { parts: [{ text: "Hel" }] } }] } },
          { response: { candidates: [{ content: { parts: [{ text: "lo" }] } }] } },
          {
            response: {
              candidates: [{ content: { parts: [{ text: "!" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
            },
          },
        ]),
      ),
      endpoint: "https://cloudcode-pa.googleapis.com",
    };
    const events = await collect(
      streamAntigravity(deps, model(), { messages: [{ role: "user", content: "hi" }] }, {}),
    );

    expect(captured).toHaveLength(1);
    const headers = captured[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer access-token");
    expect(headers["X-Goog-Api-Client"]).toContain("google-cloud-sdk");
    expect(JSON.parse(String(captured[0]!.init?.body)).project).toBe("project-1");

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    const done = events.at(-1)!;
    expect(done.reason).toBe("stop");
    expect((done.message as { content: unknown[] }).content).toEqual([
      { type: "text", text: "Hello!" },
    ]);
  });

  it("accepts a non-streaming JSON body", async () => {
    const deps = {
      piAi,
      credential: async () => credential(),
      fetchImpl: fakeFetch([], () =>
        new Response(
          JSON.stringify({
            response: {
              candidates: [{ content: { parts: [{ text: "once" }] }, finishReason: "STOP" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    };
    const events = await collect(streamAntigravity(deps, model(), { messages: [] }, {}));
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  });

  it("surfaces Cloud Code Assist errors as error events", async () => {
    const deps = {
      piAi,
      credential: async () => credential(),
      fetchImpl: fakeFetch([], () =>
        new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      ),
    };
    const events = await collect(streamAntigravity(deps, model(), { messages: [] }, {}));
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect((events[0]!.error as { errorMessage: string }).errorMessage).toBe("quota exhausted");
  });
});

type ProviderShape = {
  id: string;
  name: string;
  baseUrl: string;
  getModels: () => Array<{ id: string }>;
  auth: {
    apiKey: {
      check: () => Promise<unknown>;
      resolve: () => Promise<unknown>;
    };
  };
  refreshModels?: (context: {
    allowNetwork: boolean;
    signal: AbortSignal;
    stored?: { models?: unknown[] };
    publish?: (publication: { update?: () => void; persist?: unknown }) => Promise<boolean>;
  }) => Promise<unknown>;
};

describe("Antigravity provider registration", () => {
  const stored = credential();

  function provider(
    options: {
      connected?: boolean;
      listModels?: () => Promise<Array<{ id: string; displayName?: string }>>;
    } = {},
  ): ProviderShape {
    return createAntigravityProvider({
      piAi,
      store: { get: () => (options.connected === false ? undefined : stored) },
      credential: async () => stored,
      listModels: options.listModels ?? (async () => []),
    }) as ProviderShape;
  }

  it("registers models, base url and status-aware auth", async () => {
    const connected = provider();
    expect(connected.id).toBe("google-antigravity");
    expect(connected.baseUrl).toBe("https://cloudcode-pa.googleapis.com");
    expect(connected.getModels().map((entry) => entry.id)).toEqual(ANTIGRAVITY_BASELINE_IDS);
    expect(await connected.auth.apiKey.check()).toEqual({
      type: "api_key",
      source: "person@example.com",
    });
    expect(await connected.auth.apiKey.resolve()).toEqual({
      auth: { apiKey: "access-token" },
      source: "Google account person@example.com",
    });

    const missing = provider({ connected: false });
    expect(await missing.auth.apiKey.check()).toBeUndefined();
  });

  it("overlays the account's models only when the network is allowed", async () => {
    const live = provider({
      listModels: async () => [{ id: "gemini-3-pro-high", displayName: "Gemini 3 Pro High" }],
    });
    const signal = new AbortController().signal;
    const published: Array<{ update?: () => void; persist?: unknown }> = [];
    const publish = async (publication: { update?: () => void; persist?: unknown }) => {
      published.push(publication);
      publication.update?.();
      return true;
    };

    // Offline refreshes leave the published catalog untouched.
    await live.refreshModels?.({ allowNetwork: false, signal, publish });
    expect(live.getModels().map((entry) => entry.id)).toEqual(ANTIGRAVITY_BASELINE_IDS);
    expect(published).toHaveLength(0);

    // A network refresh adds the account's real models (pi merges them over the
    // seed baseline, so seeded ids stay resolvable).
    await live.refreshModels?.({ allowNetwork: true, signal, publish });
    expect(live.getModels().map((entry) => entry.id)).toEqual([
      ...ANTIGRAVITY_BASELINE_IDS,
      "gemini-3-pro-high",
    ]);
    expect(
      (published.at(-1)?.persist as { models: Array<{ id: string }> }).models.map(
        (entry) => entry.id,
      ),
    ).toEqual(["gemini-3-pro-high"]);

    // Without a Google session the baseline survives.
    const disconnected = provider({ connected: false });
    await disconnected.refreshModels?.({ allowNetwork: true, signal, publish });
    expect(disconnected.getModels().map((entry) => entry.id)).toEqual(ANTIGRAVITY_BASELINE_IDS);
  });
});
