import { quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import type { OAuthHttpIntegration } from "../oauth/service.ts";

export async function handleOAuthRoutes(
  context: ThebeHttpContext,
  oauth: OAuthHttpIntegration | undefined
): Promise<Response | undefined> {
  if (!oauth) return undefined;
  if (context.path === "/v1/oauth/pairing-code") {
    if (context.request.method !== "POST") {
      return methodNotAllowed("POST");
    }
    const blocked = quiescedWrite(context);
    if (blocked) return blocked;
    const issued = oauth.issuePairingCode();
    return json(
      {
        ok: true,
        code: issued.code,
        expiresAt: issued.expiresAt,
      },
      201,
      { "cache-control": "no-store" }
    );
  }
  const base = "/v1/oauth/connections";
  if (context.path === base) {
    if (context.request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    return json({ connections: await oauth.listConnections() }, 200, {
      "cache-control": "no-store",
    });
  }
  if (!context.path.startsWith(`${base}/`)) return undefined;
  const grantId = context.parts[3];
  if (!grantId || context.parts.length !== 4) return undefined;
  if (context.request.method !== "DELETE") {
    return methodNotAllowed("DELETE");
  }
  const blocked = quiescedWrite(context);
  if (blocked) return blocked;
  if (!(await oauth.revokeConnection(grantId))) {
    return json(
      { ok: false, error: "OAuth connection not found", code: "not_found" },
      404
    );
  }
  return json({ ok: true, id: grantId }, 200, { "cache-control": "no-store" });
}

function methodNotAllowed(allow: string): Response {
  return json(
    {
      ok: false,
      error: `Use ${allow} for this route`,
      code: "method_not_allowed",
    },
    405,
    { allow }
  );
}
