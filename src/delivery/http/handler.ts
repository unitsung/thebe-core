import type { ThebeAgent } from "../../agent/index.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { json } from "./json.ts";
import { agentError } from "./parsing/errors.ts";
import { createThebeHttpRouter } from "./router.ts";
import { validateRequestSecurity } from "./security.ts";

export { validateRequestSecurity } from "./security.ts";

export type ThebeHttpHandlerOptions = {
  version: string;
  token?: string;
  agent?: ThebeAgent;
  allowedHosts?: string[];
  deviceStoreDir?: string;
  workspacePath?: string;
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
    deviceStoreDir: options.deviceStoreDir,
    workspacePath: options.workspacePath,
  });

  return {
    async handle(request: Request): Promise<Response> {
      const security = validateRequestSecurity(request, allowedHostsSet);
      if (!security.ok) {
        return json({ ok: false, error: security.reason }, 403);
      }
      // Documentation is intentionally readable without the shared token so
      // the iOS "Open API docs" link can launch Safari. Swagger UI still asks
      // for X-Thebe-Token through its Authorize control when trying requests.
      if (token && !isDocumentationRequest(request)) {
        const received = request.headers.get("X-Thebe-Token") ?? "";
        if (!tokensEqual(received, token)) {
          return json({ ok: false }, 401);
        }
      }
      try {
        return await router.handle(request);
      } catch (error) {
        // A failure that names its own status (a bad body, an unknown id) is an answer, not a crash.
        if (hasHttpStatus(error)) return agentError(error);
        throw error;
      }
    },
  };
}

function isDocumentationRequest(request: Request): boolean {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  return (
    pathname === "/openapi.json" ||
    pathname === "/docs" ||
    pathname === "/swagger" ||
    pathname.startsWith("/docs/")
  );
}

/** Compares digests, so the time taken does not depend on how much of the token matched. */
function tokensEqual(received: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

function hasHttpStatus(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600;
}
