import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApnsClient } from "../src/apns.mjs";
import { createRelay, eventMessage } from "../src/relay.mjs";

const dir = mkdtempSync(join(tmpdir(), "thebe-relay-"));
const { privateKey: apnsKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});
writeFileSync(
  join(dir, "AuthKey.p8"),
  apnsKey.export({ type: "pkcs8", format: "pem" })
);

const core = generateKeyPairSync("ed25519");
const corePublicKey = Buffer.from(
  core.publicKey.export({ type: "spki", format: "der" }).subarray(-32)
).toString("base64url");
const token = "ab".repeat(32);

let mock;
let received = [];
let respondWith = { status: 200, body: "" };
let relay;
let base;
let clock = Date.UTC(2026, 10, 1);

before(async () => {
  mock = http2.createServer();
  mock.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", () => {
      received.push({ headers, body: JSON.parse(body) });
      stream.respond({ ":status": respondWith.status });
      stream.end(respondWith.body);
    });
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const apns = createApnsClient({
    keyFile: join(dir, "AuthKey.p8"),
    keyId: "KEY1234567",
    teamId: "TEAM123456",
    topic: "com.unitsung.thebe",
    origin: `http://127.0.0.1:${mock.address().port}`,
    now: () => clock,
  });
  relay = createRelay({ dataDir: dir, apns, now: () => clock });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${relay.server.address().port}`;
});

after(() => {
  relay.server.close();
  mock.close();
  mock.closeAllConnections?.();
});

const post = (path, body) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function signedEvent(relayDeviceId, overrides = {}) {
  const event = {
    relayDeviceId,
    id: `evt-${Math.random()}`,
    ts: Math.floor(clock / 1000),
    category: "thebe.permission",
    title: "Thebe",
    body: "An action is waiting for your approval.",
    deepLink: "thebe://approval/abc",
    ...overrides,
  };
  return {
    ...event,
    signature: sign(
      null,
      Buffer.from(eventMessage(event)),
      core.privateKey
    ).toString("base64url"),
  };
}

async function registered() {
  const response = await post("/v1/registrations", {
    apnsToken: token,
    corePublicKey,
    environment: "development",
  });
  assert.equal(response.status, 200);
  return (await response.json()).relayDeviceId;
}

test("a signed event reaches APNs as a minimal alert with the deep link", async () => {
  received = [];
  respondWith = { status: 200, body: "" };
  const id = await registered();
  const response = await post("/v1/events", signedEvent(id));
  assert.equal(response.status, 200);
  assert.equal(received.length, 1);
  const [call] = received;
  assert.equal(call.headers[":path"], `/3/device/${token}`);
  assert.equal(call.headers["apns-topic"], "com.unitsung.thebe");
  assert.equal(call.headers["apns-push-type"], "alert");
  assert.match(call.headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(call.body, {
    aps: {
      alert: {
        title: "Thebe",
        body: "An action is waiting for your approval.",
      },
      sound: "default",
      category: "thebe.permission",
    },
    deepLink: "thebe://approval/abc",
  });
});

test("an event signed by another key is refused and never reaches APNs", async () => {
  received = [];
  const id = await registered();
  const other = generateKeyPairSync("ed25519");
  const event = signedEvent(id);
  event.signature = sign(
    null,
    Buffer.from(eventMessage(event)),
    other.privateKey
  ).toString("base64url");
  assert.equal((await post("/v1/events", event)).status, 401);
  assert.equal(received.length, 0);
});

test("a tampered event, a stale event and a non-thebe link are refused", async () => {
  received = [];
  const id = await registered();
  const tampered = signedEvent(id);
  tampered.body = "Something else";
  assert.equal((await post("/v1/events", tampered)).status, 401);
  assert.equal(
    (
      await post(
        "/v1/events",
        signedEvent(id, { ts: Math.floor(clock / 1000) - 3600 })
      )
    ).status,
    400
  );
  assert.equal(
    (
      await post(
        "/v1/events",
        signedEvent(id, { deepLink: "https://evil.example" })
      )
    ).status,
    400
  );
  assert.equal(received.length, 0);
});

test("a repeated event id is sent once", async () => {
  received = [];
  const id = await registered();
  const event = signedEvent(id, { id: "same" });
  assert.equal((await post("/v1/events", event)).status, 200);
  assert.equal((await post("/v1/events", event)).status, 200);
  assert.equal(received.length, 1);
});

test("a token APNs reports as gone drops the registration", async () => {
  received = [];
  respondWith = {
    status: 410,
    body: JSON.stringify({ reason: "Unregistered" }),
  };
  const id = await registered();
  assert.equal((await post("/v1/events", signedEvent(id))).status, 410);
  assert.equal((await post("/v1/events", signedEvent(id))).status, 404);
  respondWith = { status: 200, body: "" };
});

test("unregistering needs the device token", async () => {
  const id = await registered();
  const wrong = await fetch(`${base}/v1/registrations/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ apnsToken: "00" }),
  });
  assert.equal(wrong.status, 404);
  const right = await fetch(`${base}/v1/registrations/${id}`, {
    method: "DELETE",
    body: JSON.stringify({ apnsToken: token }),
  });
  assert.equal(right.status, 200);
});

test("registration rejects a bad token or key", async () => {
  assert.equal(
    (
      await post("/v1/registrations", {
        apnsToken: "zz",
        corePublicKey,
        environment: "development",
      })
    ).status,
    400
  );
  assert.equal(
    (
      await post("/v1/registrations", {
        apnsToken: token,
        corePublicKey: "short",
        environment: "development",
      })
    ).status,
    400
  );
  assert.equal(
    (
      await post("/v1/registrations", {
        apnsToken: token,
        corePublicKey,
        environment: "staging",
      })
    ).status,
    400
  );
});
