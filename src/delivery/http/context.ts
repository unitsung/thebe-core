import type { ThebeAgent } from "../../agent/index.ts";
import { json } from "./json.ts";

/** The shared seam between HTTP dispatch and focused route modules. */
export type ThebeHttpContext = {
  request: Request;
  url: URL;
  path: string;
  parts: string[];
  version: string;
  agent?: ThebeAgent;
  /** Process-local device registration state used by the iOS compatibility endpoint. */
  devices?: Map<string, { platform: string; deviceId?: string; registeredAt: string }>;
};

export type ThebeHttpRoute = (
  context: ThebeHttpContext,
) => Response | undefined | Promise<Response | undefined>;

export function createThebeHttpContext(
  request: Request,
  options: {
    version: string;
    agent?: ThebeAgent;
    path?: string;
    devices?: Map<string, { platform: string; deviceId?: string; registeredAt: string }>;
  },
): ThebeHttpContext {
  const url = new URL(request.url);
  const path = options.path ?? (url.pathname.replace(/\/$/, "") || "/");
  return {
    request,
    url,
    path,
    parts: path.split("/").filter(Boolean),
    version: options.version,
    agent: options.agent,
    devices: options.devices ?? new Map(),
  };
}

export function agentUnavailable(): Response {
  return json({ ok: false, error: "agent service unavailable" }, 503);
}

export function quiescedWrite(context: ThebeHttpContext): Response | undefined {
  if (!context.agent?.isQuiesced()) {
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
}
