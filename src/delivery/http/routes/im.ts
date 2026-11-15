import { quiescedWrite, type ThebeHttpContext } from "../context.ts";
import { json, readJson } from "../json.ts";
import { ImInputError } from "../../../agent/im/validation.ts";
import { redactToolOutput } from "../../../agent/security/redaction.ts";

/**
 * IM channels, their bindings, and local test sends. Inbound platform traffic never uses these routes;
 * an adapter calls the gateway directly. Every write is refused while Core is quiesced.
 */
export async function handleImRoutes(
  context: ThebeHttpContext
): Promise<Response | undefined> {
  const { path, parts, request, im } = context;
  if (path !== "/v1/im" && !path.startsWith("/v1/im/")) return undefined;
  if (!im) {
    return json(
      {
        ok: false,
        error: "IM channels are unavailable",
        code: "im_unavailable",
      },
      503
    );
  }
  if (parts[0] !== "v1" || parts[1] !== "im") return undefined;

  try {
    if (parts.length === 3 && parts[2] === "channels") {
      if (request.method === "GET") {
        return json({ ok: true, channels: await im.channels() });
      }
      if (request.method === "POST") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        const channel = await im.addChannel(await readJson(request));
        return json({ ok: true, channel }, 201);
      }
      return methodNotAllowed();
    }
    if (
      parts.length === 4 &&
      parts[2] === "channels" &&
      request.method === "DELETE"
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      await im.removeChannel(parts[3]!);
      return json({ ok: true, removed: true });
    }
    if (
      parts.length === 5 &&
      parts[2] === "channels" &&
      parts[4] === "test" &&
      request.method === "POST"
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      const result = await im.testChannel(parts[3]!);
      return json({
        ok: result.status === "sent",
        status: result.status,
        ...(result.status === "sent" && result.platformMessageId
          ? { platformMessageId: result.platformMessageId }
          : {}),
        ...(result.status !== "sent"
          ? { reason: redactToolOutput(result.reason) }
          : {}),
      });
    }
    if (
      parts.length === 3 &&
      parts[2] === "platforms" &&
      request.method === "GET"
    ) {
      return json({ ok: true, platforms: im.platforms() });
    }
    if (parts.length === 3 && parts[2] === "logins") {
      if (request.method === "POST") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        return json(
          { ok: true, login: await im.beginLogin(await readJson(request)) },
          201
        );
      }
      return methodNotAllowed();
    }
    if (parts.length === 4 && parts[2] === "logins") {
      if (request.method === "GET") {
        return json({ ok: true, login: await im.pollLogin(parts[3]!) });
      }
      if (request.method === "DELETE") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        await im.cancelLogin(parts[3]!);
        return json({ ok: true, cancelled: true });
      }
      return methodNotAllowed();
    }
    if (
      parts.length === 3 &&
      parts[2] === "status" &&
      request.method === "GET"
    ) {
      return json({ ok: true, ...(await im.status()) });
    }
    if (
      parts.length === 3 &&
      parts[2] === "conversations" &&
      request.method === "GET"
    ) {
      return json({ ok: true, conversations: await im.conversations() });
    }
    if (parts.length === 3 && parts[2] === "bind") {
      if (request.method === "POST") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        return json(
          { ok: true, binding: await im.bind(await readJson(request)) },
          201
        );
      }
      return methodNotAllowed();
    }
    if (
      parts.length === 4 &&
      parts[2] === "bind" &&
      request.method === "DELETE"
    ) {
      const blocked = quiescedWrite(context);
      if (blocked) return blocked;
      await im.unbind(parts[3]!);
      return json({ ok: true, unbound: true });
    }
    if (parts.length === 3 && parts[2] === "send") {
      if (request.method === "POST") {
        const blocked = quiescedWrite(context);
        if (blocked) return blocked;
        const result = await im.send(await readJson(request));
        return json({
          ok: result.status === "sent",
          status: result.status,
          ...(result.status === "sent" && result.platformMessageId
            ? { platformMessageId: result.platformMessageId }
            : {}),
          ...(result.status !== "sent"
            ? { reason: redactToolOutput(result.reason) }
            : {}),
        });
      }
      return methodNotAllowed();
    }
    return undefined;
  } catch (error) {
    if (error instanceof ImInputError) {
      return json(
        { ok: false, error: error.message, code: error.code },
        error.status
      );
    }
    throw error;
  }
}

function methodNotAllowed(): Response {
  return json(
    { ok: false, error: "method not allowed", code: "method_not_allowed" },
    405
  );
}
