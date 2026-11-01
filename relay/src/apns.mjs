import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";

const PRODUCTION = "https://api.push.apple.com";
const SANDBOX = "https://api.sandbox.push.apple.com";
const TOKEN_LIFETIME_MS = 50 * 60 * 1000;

/**
 * Sends alerts to APNs over HTTP/2 with token-based provider authentication
 * (an ES256 JWT from the team's .p8 key, reused for under an hour as Apple requires).
 * `origin` replaces both Apple hosts, which is how the tests point it at a local server.
 */
export function createApnsClient({
  keyFile,
  keyId,
  teamId,
  topic,
  origin,
  now = () => Date.now(),
}) {
  const key = createPrivateKey(readFileSync(keyFile, "utf8"));
  const sessions = new Map();
  let cached;

  function providerToken() {
    if (cached && now() - cached.at < TOKEN_LIFETIME_MS) return cached.value;
    const part = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${part({ alg: "ES256", kid: keyId })}.${part({ iss: teamId, iat: Math.floor(now() / 1000) })}`;
    const signature = sign("sha256", Buffer.from(unsigned), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    cached = { value: `${unsigned}.${signature}`, at: now() };
    return cached.value;
  }

  function session(target) {
    const existing = sessions.get(target);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const created = http2.connect(target);
    created.on("error", () => sessions.delete(target));
    created.on("close", () => sessions.delete(target));
    created.unref();
    sessions.set(target, created);
    return created;
  }

  return {
    /** Resolves `{ status, reason }`; a 410 or BadDeviceToken means the token is dead. */
    send({ token, environment, payload }) {
      const target =
        origin ?? (environment === "production" ? PRODUCTION : SANDBOX);
      return new Promise((resolve, reject) => {
        const request = session(target).request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${providerToken()}`,
          "apns-topic": topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "content-type": "application/json",
        });
        let status = 0;
        let body = "";
        request.setEncoding("utf8");
        request.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          let reason;
          try {
            reason = JSON.parse(body).reason;
          } catch {
            reason = undefined;
          }
          resolve({ status, reason });
        });
        request.on("error", reject);
        request.setTimeout(10_000, () =>
          request.close(http2.constants.NGHTTP2_CANCEL)
        );
        request.end(JSON.stringify(payload));
      });
    },
    close() {
      for (const open of sessions.values()) open.close();
    },
  };
}
