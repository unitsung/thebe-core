import type { ThebeAgent } from "../../agent/index.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import type { DeviceRegistry } from "./devices.ts";
import { normalizedPath } from "./context.ts";
import { json } from "./json.ts";
import { agentError } from "./parsing/errors.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { createThebeHttpRouter } from "./router.ts";
import { validateRequestSecurity } from "./security.ts";
import type { TokenCaller, TokenSource, TokenVerifier } from "./token-store.ts";

export { validateRequestSecurity } from "./security.ts";

export type ThebeHttpHandlerOptions = {
  version: string;
  /** A fixed token, or a source asked on every request so rotation needs no restart. */
  token?: string | TokenSource | TokenVerifier;
  agent?: ThebeAgent;
  allowedHosts?: string[];
  deviceStoreDir?: string;
  /** Use this registry instead of opening one on `deviceStoreDir`, so the push notifier shares it. */
  deviceRegistry?: DeviceRegistry;
  pushIdentity?: { publicKey: string; relayUrl: string };
  workspacePath?: string;
  /**
   * Serve only the paths in `MCP_LISTENER_PATHS` (today `/mcp`), every other path a 404 before any
   * token check. This is the handler for the second port that is safe to expose to the internet.
   */
  mcpOnly?: boolean;
  /** Per-token request limit; applied after the token is accepted. */
  rateLimiter?: RateLimiter;
};

/** What the `/mcp`-only listener serves. The authorization endpoints join this list when they exist. */
const MCP_LISTENER_PATHS: ReadonlySet<string> = new Set(["/mcp"]);

/** Stable public composition shell for the HTTP agent. */
export function createThebeHttpHandler(options: ThebeHttpHandlerOptions) {
  const identify: ((received: string) => TokenCaller | undefined) | undefined =
    typeof options.token === "object" && options.token !== null
      ? (received) => (options.token as TokenVerifier).verify(received)
      : typeof options.token === "function"
        ? (received) => {
            // A source with no token (revoked, unreadable) refuses everything rather than opening up.
            const expected = (options.token as TokenSource)();
            return expected && tokensEqual(received, expected)
              ? { name: "default" }
              : undefined;
          }
        : options.token?.trim()
          ? (received) =>
              tokensEqual(received, (options.token as string).trim())
                ? { name: "default" }
                : undefined
          : undefined;
  const allowedHostsSet = options.allowedHosts
    ? new Set(options.allowedHosts)
    : undefined;
  const router = createThebeHttpRouter({
    version: options.version,
    agent: options.agent,
    deviceStoreDir: options.deviceStoreDir,
    deviceRegistry: options.deviceRegistry,
    pushIdentity: options.pushIdentity,
    workspacePath: options.workspacePath,
  });

  return {
    async handle(request: Request): Promise<Response> {
      if (options.mcpOnly && !MCP_LISTENER_PATHS.has(pathOf(request))) {
        return json({ ok: false, error: "Not found", code: "not_found" }, 404);
      }
      const security = validateRequestSecurity(request, allowedHostsSet);
      if (!security.ok) {
        return json({ ok: false, error: security.reason }, 403);
      }
      // Documentation is intentionally readable without the shared token so
      // a client's "Open API docs" link can launch Safari. Swagger UI still asks
      // for X-Thebe-Token through its Authorize control when trying requests.
      let caller: TokenCaller | undefined;
      if (identify && !isDocumentationRequest(request)) {
        caller = identify(receivedToken(request));
        if (!caller) {
          return json(
            {
              ok: false,
              error:
                "Missing or invalid token (send X-Thebe-Token, or Authorization: Bearer)",
              code: "unauthorized",
            },
            401
          );
        }
        if (caller.scopes && pathOf(request) !== "/mcp") {
          // A valid token, but not one for this route: 403, so the caller can tell it from a bad token.
          return json(
            {
              ok: false,
              error: `This token (${caller.name}) is limited to /mcp (${caller.scopes.join(", ")}). Use a token made without --scope for other routes.`,
              code: "token_scope",
            },
            403
          );
        }
      }
      if (options.rateLimiter) {
        const name = caller?.name ?? "anonymous";
        const taken = options.rateLimiter.take(name);
        if (!taken.ok) {
          const { limit, windowMs } = options.rateLimiter.limit;
          const seconds = Math.round(windowMs / 1000);
          return json(
            {
              ok: false,
              error: `Rate limit reached for token ${name}: ${limit} requests per ${seconds} seconds. Retry in ${taken.retryAfterSeconds} seconds.`,
              code: "rate_limited",
              retryAfterSeconds: taken.retryAfterSeconds,
            },
            429,
            { "retry-after": String(taken.retryAfterSeconds) }
          );
        }
      }
      try {
        return await router.handle(request, caller);
      } catch (error) {
        // A failure that names its own status (a bad body, an unknown id) is an answer, not a crash.
        if (hasHttpStatus(error)) return agentError(error);
        throw error;
      }
    },
  };
}

function pathOf(request: Request): string {
  try {
    return normalizedPath(new URL(request.url));
  } catch {
    return "";
  }
}

/**
 * The token a request carries: `X-Thebe-Token`, or else `Authorization: Bearer`, the form Claude's
 * API and most agent clients send. When both are present the header wins, so one request is never
 * checked against two tokens.
 */
function receivedToken(request: Request): string {
  const header = request.headers.get("X-Thebe-Token");
  if (header !== null) return header;
  const bearer = /^bearer[ \t]+(\S+)$/i.exec(
    request.headers.get("Authorization")?.trim() ?? ""
  );
  return bearer?.[1] ?? "";
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
  return (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 600
  );
}
