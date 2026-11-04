import type { ThebeAgent } from "../../agent/index.ts";
import type { PushOutboxStatus } from "./push-status.ts";
import { json } from "./json.ts";
import type { DeviceRegistry } from "./devices.ts";
import type { TokenCaller } from "./token-store.ts";

/** The shared seam between HTTP dispatch and focused route modules. */
export type ThebeHttpContext = {
  request: Request;
  url: URL;
  path: string;
  parts: string[];
  version: string;
  agent?: ThebeAgent;
  /** Who sent the request and what their token may do; absent when no token is configured. */
  caller?: TokenCaller;
  /** Durable device registration state used by the device push endpoint. */
  deviceRegistry?: DeviceRegistry;
  /** Where devices register for push and the key Core signs events with; absent when push is off. */
  pushIdentity?: { publicKey: string; relayUrl: string };
  /** Push delivery state for the health response; absent when push is off. */
  pushOutbox?: { status(): PushOutboxStatus };
  /** The authorization boundary, used by the isolation report. */
  workspacePath?: string;
};

export type ThebeHttpRoute = (
  context: ThebeHttpContext
) => Response | undefined | Promise<Response | undefined>;

/** The path as routes match it: no trailing slash. The token scope gate uses this same function. */
export function normalizedPath(url: URL): string {
  return url.pathname.replace(/\/$/, "") || "/";
}

export function createThebeHttpContext(
  request: Request,
  options: {
    version: string;
    agent?: ThebeAgent;
    caller?: TokenCaller;
    path?: string;
    deviceRegistry?: DeviceRegistry;
    pushIdentity?: { publicKey: string; relayUrl: string };
    pushOutbox?: ThebeHttpContext["pushOutbox"];
    workspacePath?: string;
  }
): ThebeHttpContext {
  const url = new URL(request.url);
  const path = options.path ?? normalizedPath(url);
  return {
    request,
    url,
    path,
    parts: path.split("/").filter(Boolean),
    version: options.version,
    agent: options.agent,
    caller: options.caller,
    deviceRegistry: options.deviceRegistry,
    pushIdentity: options.pushIdentity,
    pushOutbox: options.pushOutbox,
    workspacePath: options.workspacePath,
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
    503
  );
}
