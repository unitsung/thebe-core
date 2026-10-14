import {
  quiescedWrite,
  type ThebeHttpContext,
} from "../context.ts";
import { json, readJson } from "../json.ts";
import { oauthCallbackInput } from "../parsing/errors.ts";

/** Provider discovery, model discovery, and API-key/OAuth authentication. */
export async function handleProviderModelAuth(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  const { request, url, path, parts, agent } = context;
  if (!agent) {
    return undefined;
  }
  const [version, resource, encodedProviderId, operation, ...remainingSegments] = parts;
  if (version === "v1" && resource === "provider" && operation === "config" && remainingSegments.length === 0) {
    let providerId: string;
    try { providerId = decodeURIComponent(encodedProviderId ?? ""); }
    catch { return json({ error: "invalid provider ID encoding" }, 400); }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(providerId)) return json({ error: "invalid provider ID" }, 400);
    if (request.method === "GET") {
      const configuration = await agent.providerConfiguration(providerId);
      return configuration ? json(configuration) : json({ error: "no editable provider configuration" }, 404);
    }
    if (request.method === "PUT" || request.method === "DELETE") {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      if (request.method === "DELETE") {
        if (!await agent.providerConfiguration(providerId)) return json({ error: "no custom configuration to delete" }, 404);
        await agent.deleteProviderConfiguration(providerId);
        return json({ ok: true });
      }
      const body = await readJson(request);
      const apis = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
      const api = apis.find(value => value === body.api);
      let endpoint: URL;
      try { endpoint = new URL(String(body.baseUrl ?? "")); } catch { return json({ error: "invalid baseUrl" }, 400); }
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || !api) return json({ error: "invalid endpoint or API" }, 400);
      if (!Array.isArray(body.models) || !body.models.length || body.models.length > 500) return json({ error: "models must contain 1–500 entries" }, 400);
      const ids = new Set<string>();
      const models = [];
      for (const raw of body.models) {
        if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id.trim() || ids.has(raw.id.trim())) return json({ error: "model IDs must be non-empty and unique" }, 400);
        ids.add(raw.id.trim());
        if (raw.input !== undefined && (!Array.isArray(raw.input) || !raw.input.includes("text") || raw.input.some((value: unknown) => value !== "text" && value !== "image") || new Set(raw.input).size !== raw.input.length)) return json({ error: "input must contain text and optionally image" }, 400);
        for (const field of ["contextWindow", "maxTokens"] as const) {
          if (raw[field] !== undefined && (!Number.isSafeInteger(raw[field]) || raw[field] <= 0)) return json({ error: `${field} must be a positive integer` }, 400);
        }
        if (raw.contextWindow !== undefined && raw.maxTokens !== undefined && raw.maxTokens > raw.contextWindow) {
          return json({ error: "maxTokens must not exceed contextWindow" }, 400);
        }
        models.push({ id: raw.id.trim(), name: typeof raw.name === "string" ? raw.name : undefined, contextWindow: raw.contextWindow, maxTokens: raw.maxTokens, reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined, input: raw.input });
      }
      await agent.saveProviderConfiguration({ providerId, name: typeof body.name === "string" ? body.name : undefined, baseUrl: endpoint.toString().replace(/\/$/, ""), api, models }, typeof body.apiKey === "string" ? body.apiKey : undefined);
      return json(await agent.providerConfiguration(providerId));
    }
  }
  if (request.method === "GET" && path === "/v1/provider") {
    const all = url.searchParams.get("all") === "true";
    const providers = await agent.listProviders({ all });
    return json({
      providers,
      oauthProviders: providers.filter((provider) =>
        provider.authMethods?.includes("oauth"),
      ),
      apiKeyProviders: providers.filter((provider) =>
        provider.authMethods?.includes("apiKey"),
      ),
    });
  }
  if (request.method === "GET" && path === "/v1/provider/auth") {
    return json({ providers: await agent.auth().listProviders() });
  }
  if (
    parts[0] === "v1" &&
    parts[1] === "provider" &&
    parts[3] === "oauth"
  ) {
    return handleOAuth(context, parts[2] ?? "");
  }
  if (request.method === "GET" && path === "/v1/model") {
    const all = url.searchParams.get("all") === "true";
    const providerId = url.searchParams.get("provider") ?? undefined;
    const refresh = url.searchParams.get("refresh") === "true";
    if (refresh && !providerId) return json({ error: "provider is required for model discovery" }, 400);
    const models = all || refresh
      ? await agent.listModels({ all, providerId, refresh })
      : await agent.listAvailableModels({ providerId });
    return json({ models });
  }
  if (parts[0] === "v1" && parts[1] === "provider" && parts[2]) {
    return handleProviderAction(context, parts[2]);
  }
  if (request.method === "POST" && path === "/v1/auth") {
    const blocked = quiescedWrite(context);
    if (blocked) {
      return blocked;
    }
    const body = await readJson(request);
    const providerId = typeof body.providerId === "string" ? body.providerId : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    if (!providerId || !apiKey) {
      return json({ ok: false, error: "providerId and apiKey required" }, 400);
    }
    await agent.auth().setApiKey(providerId, apiKey);
    return json({ ok: true });
  }
  if (
    (request.method === "PUT" || request.method === "DELETE") &&
    parts[0] === "v1" &&
    parts[1] === "auth" &&
    parts[2]
  ) {
    const blocked = quiescedWrite(context);
    if (blocked) {
      return blocked;
    }
    if (request.method === "PUT") {
      const body = await readJson(request);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
      if (!apiKey) {
        return json({ ok: false, error: "apiKey required" }, 400);
      }
      await agent.auth().setApiKey(parts[2], apiKey);
    } else {
      await agent.auth().logout(parts[2]);
    }
    return json({ ok: true });
  }
  return undefined;
}

async function handleOAuth(
  context: ThebeHttpContext,
  providerId: string,
): Promise<Response | undefined> {
  const { request, parts, agent } = context;
  if (!agent) {
    return undefined;
  }
  if (request.method === "GET" && parts[4] === "login") {
    const blocked = quiescedWrite(context);
    if (blocked) {
      return blocked;
    }
    return oauthLoginStream(agent, providerId);
  }
  if (
    request.method === "POST" &&
    (parts[4] === "authorize" || parts[4] === "login")
  ) {
    const blocked = quiescedWrite(context);
    if (blocked) {
      return blocked;
    }
    if (parts[4] === "login") {
      return submitOAuthCallback(request, agent, providerId);
    }
    const body = await readJson(request);
    const result = await agent.auth().authorizeOAuth(providerId, {
      force: body.force === true,
    });
    if ("connected" in result && result.connected) {
      return json({ ok: true, connected: true, providerId });
    }
    return json({ ok: true, ...result }, 202);
  }
  if (request.method === "POST" && parts[4] === "callback") {
    const blocked = quiescedWrite(context);
    if (blocked) {
      return blocked;
    }
    return submitOAuthCallback(request, agent, providerId);
  }
  if (
    (request.method === "POST" || request.method === "DELETE") &&
    parts[4] === "logout"
  ) {
    const blocked = quiescedWrite(context);
    if (blocked) {
      return blocked;
    }
    await agent.auth().logout(providerId);
    return json({ ok: true });
  }
  return undefined;
}

async function submitOAuthCallback(
  request: Request,
  agent: NonNullable<ThebeHttpContext["agent"]>,
  providerId: string,
): Promise<Response> {
  const input = oauthCallbackInput(await readJson(request));
  if (!input) {
    return json({ ok: false, error: "callback url or code required" }, 400);
  }
  await agent.auth().submitOAuthCallback(providerId, input);
  return json({ ok: true, providerId });
}

async function handleProviderAction(
  context: ThebeHttpContext,
  providerId: string,
): Promise<Response | undefined> {
  const { request, parts, agent } = context;
  if (!agent) {
    return undefined;
  }
  if (request.method === "POST" && parts[3] === "test") {
    const authResult = await agent.auth().testProvider(providerId);
    if (!authResult.ok) {
      return json({ ok: false, message: authResult.message }, 400);
    }
    const models = await agent.listAvailableModels({ providerId });
    const model = models[0];
    if (!model) {
      // The auth-level probe already reached the provider (that is how
      // providers that own their sessions report health); with no
      // model to run, report that result instead of failing.
      return json({
        ok: true,
        message: authResult.message ?? "provider reachable",
      });
    }
    try {
      const probed = await agent.testModel({
        providerId: model.providerId,
        modelId: model.modelId,
      });
      return json({
        ok: true,
        message: `probed ${model.modelId}`,
        latencyMs: probed.latencyMs,
      });
    } catch (error) {
      return json(
        {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }
  if (
    (request.method === "POST" || request.method === "DELETE") &&
    parts[3] === "api-key"
  ) {
    const blocked = quiescedWrite(context);
    if (blocked) {
      return blocked;
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
      if (!apiKey) {
        return json({ ok: false, error: "apiKey required" }, 400);
      }
      await agent.auth().setApiKey(providerId, apiKey);
    } else {
      await agent.auth().logout(providerId);
    }
    return json({ ok: true });
  }
  return undefined;
}

function oauthLoginStream(
  agent: NonNullable<ThebeHttpContext["agent"]>,
  providerId: string,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      void (async () => {
        try {
          const result = await agent.auth().authorizeOAuth(providerId);
          if ("connected" in result && result.connected) {
            send("success", { providerId });
          } else {
            if (result.url) {
              send("auth", { url: result.url, providerId });
            }
            if (result.deviceCode) {
              send("device_code", result.deviceCode);
            }
            send("progress", {
              message: result.instructions ?? "complete login in the browser",
            });
          }
        } catch (error) {
          send("error", {
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      })();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
