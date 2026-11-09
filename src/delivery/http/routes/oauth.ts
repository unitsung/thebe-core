import { quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json } from "../json.ts";
import type { OAuthHttpIntegration } from "../oauth/service.ts";

export async function handleOAuthRoutes(
  context: ThebeHttpContext,
  oauth: OAuthHttpIntegration | undefined
): Promise<Response | undefined> {
  if (!oauth || context.path !== "/v1/oauth/pairing-code") return undefined;
  if (context.request.method !== "POST") {
    return json(
      {
        ok: false,
        error: "Use POST to issue a pairing code",
        code: "method_not_allowed",
      },
      405,
      { allow: "POST" }
    );
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
