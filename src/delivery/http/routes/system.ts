import type { ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import { buildIsolationReport } from "../../../agent/security/isolation.ts";

/** System lifecycle controls and the running-session compatibility view. */
export async function handleSystemRoutes(
  context: ThebeHttpContext,
): Promise<Response | undefined> {
  const { request, path, agent } = context;
  if (request.method === "GET" && path === "/v1/system/status") {
    return json({ ok: true, quiesced: Boolean(agent?.isQuiesced()) });
  }
  if (request.method === "GET" && path === "/v1/system/isolation") {
    return json(
      buildIsolationReport({ workspacePath: context.workspacePath }),
    );
  }
  if (
    request.method !== "POST" ||
    !(
      path === "/v1/system/quiesce" ||
      path === "/v1/system/unquiesce" ||
      path === "/v1/system/reap"
    )
  ) {
    if (request.method === "GET" && path === "/v1/agent/running") {
      if (!agent) {
        return json({ ok: false, error: "agent service unavailable" }, 503);
      }
      return json({
        sessions: await agent.listSessions({ status: "running" }),
      });
    }
    return undefined;
  }
  if (!agent) {
    return json({ ok: false, error: "agent service unavailable" }, 503);
  }
  if (path === "/v1/system/quiesce") {
    await agent.quiesce();
    return json({ ok: true, status: "quiesced" });
  }
  if (path === "/v1/system/unquiesce") {
    await agent.unquiesce();
    return json({ ok: true, status: "active" });
  }
  return json({ ok: true, ...(await agent.reapIdleSessions()) });
}
