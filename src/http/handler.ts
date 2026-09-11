import type { ThebeProduct } from "../product/service.ts";
import { json } from "./json.ts";
import { validateRequestSecurity } from "./security.ts";
import { handleMessagesCompatibility } from "./routes/compat.ts";
import { handleMcp } from "./routes/mcp.ts";
import { handleProductApi } from "./routes/product-api.ts";

export { validateRequestSecurity } from "./security.ts";

export type ThebeHttpHandlerOptions = {
  version: string;
  token?: string;
  product?: ThebeProduct;
  allowedHosts?: string[];
};

export function createThebeHttpHandler(options: ThebeHttpHandlerOptions) {
  const token = options.token?.trim() || undefined;
  const allowedHostsSet = options.allowedHosts
    ? new Set(options.allowedHosts)
    : undefined;

  async function handle(request: Request): Promise<Response> {
    const sec = validateRequestSecurity(request, allowedHostsSet);
    if (!sec.ok) {
      return json({ ok: false, error: sec.reason }, 403);
    }
    if (token) {
      const got = request.headers.get("X-Thebe-Token") ?? "";
      if (got !== token) {
        return json({ ok: false }, 401);
      }
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    if (request.method === "GET" && path === "/v1/health") {
      return json({ ok: true, version: options.version });
    }
    if (request.method === "GET" && path === "/v1/events") {
      return json({ events: [] });
    }
    if (request.method === "POST" && path === "/v1/devices") {
      // TODO: validate and persist device registration
      return json({ ok: true });
    }
    if (request.method === "POST" && path === "/v1/messages") {
      return handleMessagesCompatibility(request, options.product);
    }
    if (request.method === "GET" && path === "/v1/system/status") {
      return json({ ok: true, quiesced: Boolean(options.product?.isQuiesced()) });
    }
    // Admin-equivalent: gated only by THEBE_TOKEN (or open if token is unset).
    if (request.method === "POST" && path === "/v1/system/quiesce") {
      if (!options.product) {
        return json({ ok: false, error: "product service unavailable" }, 503);
      }
      await options.product.quiesce();
      return json({ ok: true, status: "quiesced" });
    }
    if (request.method === "POST" && path === "/v1/system/unquiesce") {
      if (!options.product) {
        return json({ ok: false, error: "product service unavailable" }, 503);
      }
      await options.product.unquiesce();
      return json({ ok: true, status: "active" });
    }
    if (request.method === "GET" && path === "/v1/agent/running") {
      if (!options.product) {
        return json({ ok: false, error: "product service unavailable" }, 503);
      }
      return json({
        sessions: await options.product.listSessions({ status: "running" }),
      });
    }
    if (
      path.startsWith("/v1/session") ||
      path.startsWith("/v1/provider") ||
      path.startsWith("/v1/model") ||
      path.startsWith("/v1/auth")
    ) {
      return handleProductApi(request, path, options.product);
    }
    if (request.method === "POST" && path === "/mcp") {
      return handleMcp(request, options.product);
    }
    return json({ ok: false }, 404);
  }

  return { handle };
}
