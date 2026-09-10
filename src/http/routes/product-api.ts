import type { ThebeProduct } from "../../product/service.ts";
import { asObject, json, readJson } from "../json.ts";
import { oauthCallbackInput, productError } from "../parse.ts";
import { handleSession } from "./session.ts";

export async function handleProductApi(
  request: Request,
  path: string,
  product: ThebeProduct | undefined,
): Promise<Response> {
  if (!product) {
    return json({ ok: false, error: "product service unavailable" }, 503);
  }
  const url = new URL(request.url);
  const parts = path.split("/").filter(Boolean);
  try {
    if (parts[0] === "v1" && parts[1] === "session") {
      return await handleSession(request, url, parts, product);
    }
    if (request.method === "GET" && path === "/v1/provider") {
      const all = url.searchParams.get("all") === "true";
      const providers = await product.listProviders({ all });
      return json({
        providers,
        oauthProviders: providers.filter((p) =>
          p.authMethods?.includes("oauth"),
        ),
        apiKeyProviders: providers.filter((p) =>
          p.authMethods?.includes("apiKey"),
        ),
      });
    }
    if (request.method === "GET" && path === "/v1/provider/auth") {
      return json({ providers: await product.auth().listProviders() });
    }
    if (
      request.method === "POST" &&
      parts[0] === "v1" &&
      parts[1] === "provider" &&
      parts[3] === "oauth"
    ) {
      const providerId = parts[2] ?? "";
      if (parts[4] === "authorize") {
        const result = await product.auth().authorizeOAuth(providerId);
        if ("connected" in result && result.connected) {
          return json({ ok: true, connected: true, providerId });
        }
        return json({ ok: true, ...result }, 202);
      }
      if (parts[4] === "callback") {
        const body = await readJson(request);
        const input = oauthCallbackInput(body);
        if (!input) {
          return json(
            { ok: false, error: "callback url or code required" },
            400,
          );
        }
        await product.auth().submitOAuthCallback(providerId, input);
        return json({ ok: true, providerId });
      }
    }
    if (request.method === "GET" && path === "/v1/model") {
      const all = url.searchParams.get("all") === "true";
      const providerId = url.searchParams.get("provider") ?? undefined;
      const models = all
        ? await product.listModels({ all: true, providerId })
        : await product.listAvailableModels({ providerId });
      return json({ models });
    }
    if (parts[0] === "v1" && parts[1] === "provider" && parts[2]) {
      const providerId = parts[2];
      if (request.method === "POST" && parts[3] === "test") {
        const res = await product.auth().testProvider(providerId);
        return json({ ok: res.ok, message: res.message }, res.ok ? 200 : 400);
      }
      if (request.method === "POST" && parts[3] === "api-key") {
        const body = await readJson(request);
        const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
        if (!apiKey) {
          return json({ ok: false, error: "apiKey required" }, 400);
        }
        await product.auth().setApiKey(providerId, apiKey);
        return json({ ok: true });
      }
      if (request.method === "DELETE" && parts[3] === "api-key") {
        await product.auth().logout(providerId);
        return json({ ok: true });
      }
    }
    if (
      request.method === "PUT" &&
      parts[0] === "v1" &&
      parts[1] === "auth" &&
      parts[2]
    ) {
      const body = await readJson(request);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
      if (!apiKey) {
        return json({ ok: false, error: "apiKey required" }, 400);
      }
      await product.auth().setApiKey(parts[2], apiKey);
      return json({ ok: true });
    }
    if (
      request.method === "DELETE" &&
      parts[0] === "v1" &&
      parts[1] === "auth" &&
      parts[2]
    ) {
      await product.auth().logout(parts[2]);
      return json({ ok: true });
    }
    return json({ ok: false }, 404);
  } catch (error) {
    return productError(error);
  }
}
