import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_BODY = 8 * 1024;
const MAX_SKEW_SECONDS = 300;
const EVENTS_PER_MINUTE = 30;

/** Must match `pushEventMessage` in Core's `src/app/push/identity.ts`. */
export function eventMessage(event) {
  return JSON.stringify([
    "thebe-push-v1",
    event.relayDeviceId,
    event.id,
    event.ts,
    event.category,
    event.title,
    event.body,
    event.deepLink,
  ]);
}

/**
 * The relay: devices register an APNs token together with the public key of the Core they trust;
 * the relay then forwards only events that Core signed, to only that device. It never sees a
 * conversation, a filename or a credential, because Core sends none.
 */
export function createRelay({ dataDir, apns, now = () => Date.now() }) {
  const file = join(dataDir, "registrations.json");
  let registrations = load();
  const seen = new Map();
  const recent = new Map();

  function load() {
    try {
      return new Map(Object.entries(JSON.parse(readFileSync(file, "utf8"))));
    } catch (error) {
      if (error.code === "ENOENT") return new Map();
      throw error;
    }
  }

  function persist() {
    mkdirSync(dataDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify(Object.fromEntries(registrations)),
      { mode: 0o600 }
    );
    renameSync(temporary, file);
  }

  const idFor = (token, publicKey) =>
    `rl_${createHash("sha256").update(`${token}\n${publicKey}`).digest("hex").slice(0, 32)}`;

  function verifySignature(event, publicKey) {
    try {
      const key = createPublicKey({
        key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey, "base64url")]),
        format: "der",
        type: "spki",
      });
      return verify(
        null,
        Buffer.from(eventMessage(event)),
        key,
        Buffer.from(event.signature, "base64url")
      );
    } catch {
      return false;
    }
  }

  function underRateLimit(id) {
    const cutoff = now() - 60_000;
    const stamps = (recent.get(id) ?? []).filter((stamp) => stamp > cutoff);
    if (stamps.length >= EVENTS_PER_MINUTE) return false;
    stamps.push(now());
    recent.set(id, stamps);
    return true;
  }

  const isText = (value, max) =>
    typeof value === "string" && value.length > 0 && value.length <= max;

  async function register(body) {
    const { apnsToken, corePublicKey, environment } = body;
    if (!isText(apnsToken, 200) || !/^[0-9a-fA-F]+$/.test(apnsToken))
      return [400, { error: "apnsToken must be hex" }];
    if (
      !isText(corePublicKey, 64) ||
      Buffer.from(corePublicKey, "base64url").length !== 32
    ) {
      return [
        400,
        { error: "corePublicKey must be a 32-byte Ed25519 key, base64url" },
      ];
    }
    if (environment !== "development" && environment !== "production") {
      return [400, { error: "environment must be development or production" }];
    }
    const id = idFor(apnsToken, corePublicKey);
    registrations.set(id, {
      apnsToken,
      corePublicKey,
      environment,
      registeredAt: new Date(now()).toISOString(),
    });
    persist();
    return [200, { ok: true, relayDeviceId: id }];
  }

  async function unregister(id, body) {
    const entry = registrations.get(id);
    // The token is the proof of ownership; without it anyone could drop another device.
    if (!entry || body.apnsToken !== entry.apnsToken)
      return [404, { error: "not found" }];
    registrations.delete(id);
    persist();
    return [200, { ok: true }];
  }

  async function deliver(event) {
    if (
      !isText(event.relayDeviceId, 128) ||
      !isText(event.id, 128) ||
      !Number.isInteger(event.ts)
    )
      return [400, { error: "malformed event" }];
    if (
      !isText(event.category, 64) ||
      !isText(event.title, 64) ||
      !isText(event.body, 200)
    )
      return [400, { error: "malformed event" }];
    if (!isText(event.deepLink, 512) || !event.deepLink.startsWith("thebe://"))
      return [400, { error: "deepLink must be a thebe:// route" }];
    if (!isText(event.signature, 200))
      return [400, { error: "unsigned event" }];
    const entry = registrations.get(event.relayDeviceId);
    if (!entry) return [404, { error: "unknown device" }];
    if (!verifySignature(event, entry.corePublicKey))
      return [401, { error: "bad signature" }];
    if (Math.abs(Math.floor(now() / 1000) - event.ts) > MAX_SKEW_SECONDS)
      return [400, { error: "stale event" }];
    const replayKey = `${event.relayDeviceId}:${event.id}`;
    for (const [key, expires] of seen) if (expires < now()) seen.delete(key);
    if (seen.has(replayKey)) return [200, { ok: true, duplicate: true }];
    if (!underRateLimit(event.relayDeviceId))
      return [429, { error: "too many events" }];
    seen.set(replayKey, now() + 2 * MAX_SKEW_SECONDS * 1000);

    const result = await apns.send({
      token: entry.apnsToken,
      environment: entry.environment,
      payload: {
        aps: {
          alert: { title: event.title, body: event.body },
          sound: "default",
          category: event.category,
        },
        deepLink: event.deepLink,
      },
    });
    if (
      result.status === 410 ||
      result.reason === "BadDeviceToken" ||
      result.reason === "Unregistered"
    ) {
      registrations.delete(event.relayDeviceId);
      persist();
      return [410, { error: "device token is no longer valid" }];
    }
    return result.status === 200
      ? [200, { ok: true }]
      : [502, { error: "APNs refused the notice", reason: result.reason }];
  }

  async function route(request, body) {
    const url = new URL(request.url, "http://relay");
    if (request.method === "GET" && url.pathname === "/healthz")
      return [200, { ok: true }];
    if (request.method === "POST" && url.pathname === "/v1/registrations")
      return register(body);
    if (request.method === "POST" && url.pathname === "/v1/events")
      return deliver(body);
    const match = /^\/v1\/registrations\/([\w-]+)$/.exec(url.pathname);
    if (request.method === "DELETE" && match) return unregister(match[1], body);
    return [404, { error: "not found" }];
  }

  const server = createServer((request, response) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", async () => {
      let body = {};
      try {
        if (chunks.length > 0)
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response
          .writeHead(400, { "content-type": "application/json" })
          .end('{"error":"invalid JSON"}');
        return;
      }
      try {
        const [status, payload] = await route(request, body ?? {});
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(payload));
      } catch {
        response
          .writeHead(500, { "content-type": "application/json" })
          .end('{"error":"internal error"}');
      }
    });
  });

  return { server, registrations: () => registrations };
}
