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
  const quiescedWrite = (): Response | undefined => {
    if (!product.isQuiesced()) {
      return undefined;
    }
    return json(
      {
        ok: false,
        error:
          "System is quiesced for maintenance; write operations are temporarily disabled",
      },
      503,
    );
  };
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
      parts[0] === "v1" &&
      parts[1] === "provider" &&
      parts[3] === "oauth"
    ) {
      const providerId = parts[2] ?? "";
      if (
        request.method === "GET" &&
        parts[4] === "login"
      ) {
        const blocked = quiescedWrite();
        if (blocked) {
          return blocked;
        }
        return oauthLoginStream(product, providerId);
      }
      if (
        request.method === "POST" &&
        (parts[4] === "authorize" || parts[4] === "login")
      ) {
        const blocked = quiescedWrite();
        if (blocked) {
          return blocked;
        }
        if (parts[4] === "login") {
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
        const result = await product.auth().authorizeOAuth(providerId);
        if ("connected" in result && result.connected) {
          return json({ ok: true, connected: true, providerId });
        }
        return json({ ok: true, ...result }, 202);
      }
      if (parts[4] === "callback" && request.method === "POST") {
        const blocked = quiescedWrite();
        if (blocked) {
          return blocked;
        }
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
      if (
        (request.method === "POST" || request.method === "DELETE") &&
        parts[4] === "logout"
      ) {
        const blocked = quiescedWrite();
        if (blocked) {
          return blocked;
        }
        await product.auth().logout(providerId);
        return json({ ok: true });
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
        const authRes = await product.auth().testProvider(providerId);
        if (!authRes.ok) {
          return json({ ok: false, message: authRes.message }, 400);
        }
        const models = await product.listAvailableModels({ providerId });
        const model = models[0];
        if (!model) {
          return json(
            {
              ok: false,
              message: "no available model to probe",
            },
            400,
          );
        }
        try {
          const probed = await product.testModel({
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
      if (request.method === "POST" && parts[3] === "api-key") {
        const blocked = quiescedWrite();
        if (blocked) {
          return blocked;
        }
        const body = await readJson(request);
        const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
        if (!apiKey) {
          return json({ ok: false, error: "apiKey required" }, 400);
        }
        await product.auth().setApiKey(providerId, apiKey);
        return json({ ok: true });
      }
      if (request.method === "DELETE" && parts[3] === "api-key") {
        const blocked = quiescedWrite();
        if (blocked) {
          return blocked;
        }
        await product.auth().logout(providerId);
        return json({ ok: true });
      }
    }
    if (
      request.method === "POST" &&
      path === "/v1/auth"
    ) {
      const blocked = quiescedWrite();
      if (blocked) {
        return blocked;
      }
      const body = await readJson(request);
      const providerId =
        typeof body.providerId === "string" ? body.providerId : "";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
      if (!providerId || !apiKey) {
        return json(
          { ok: false, error: "providerId and apiKey required" },
          400,
        );
      }
      await product.auth().setApiKey(providerId, apiKey);
      return json({ ok: true });
    }
    if (
      request.method === "PUT" &&
      parts[0] === "v1" &&
      parts[1] === "auth" &&
      parts[2]
    ) {
      const blocked = quiescedWrite();
      if (blocked) {
        return blocked;
      }
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
      const blocked = quiescedWrite();
      if (blocked) {
        return blocked;
      }
      await product.auth().logout(parts[2]);
      return json({ ok: true });
    }
    return json({ ok: false }, 404);
  } catch (error) {
    return productError(error);
  }
}

function oauthLoginStream(product: ThebeProduct, providerId: string): Response {
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
          const result = await product.auth().authorizeOAuth(providerId);
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
