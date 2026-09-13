import type { ThebeAgent } from "../../agent/index.ts";
import { json } from "./json.ts";
import { createThebeHttpRouter } from "./router.ts";
import { validateRequestSecurity } from "./security.ts";

export { validateRequestSecurity } from "./security.ts";

export type ThebeHttpHandlerOptions = {
  version: string;
  token?: string;
  agent?: ThebeAgent;
  allowedHosts?: string[];
};

/** Stable public composition shell for the HTTP agent. */
export function createThebeHttpHandler(options: ThebeHttpHandlerOptions) {
  const token = options.token?.trim() || undefined;
  const allowedHostsSet = options.allowedHosts
    ? new Set(options.allowedHosts)
    : undefined;
  const router = createThebeHttpRouter({
    version: options.version,
    agent: options.agent,
  });

  return {
    async handle(request: Request): Promise<Response> {
      const security = validateRequestSecurity(request, allowedHostsSet);
      if (!security.ok) {
        return json({ ok: false, error: security.reason }, 403);
      }
      if (token) {
        const received = request.headers.get("X-Thebe-Token") ?? "";
        if (received !== token) {
          return json({ ok: false }, 401);
        }
      }
      return router.handle(request);
    },
  };
}
