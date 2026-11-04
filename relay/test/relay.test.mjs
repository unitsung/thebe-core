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
let apnsClient;
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
  apnsClient = apns;
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
  const event = signedEvent(id);
  const response = await post("/v1/events", event);
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
    id: event.id,
  });
  assert.match(call.headers["apns-collapse-id"], /^[0-9a-f]{32}$/);
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

test("a ticket and sequence number reach the device so it can order and deduplicate", async () => {
  received = [];
  const id = await registered();
  const event = signedEvent(id, { ticket: "ticket-a", seq: 7 });
  assert.equal((await post("/v1/events", event)).status, 200);
  assert.equal(received[0].body.id, event.id);
  assert.equal(received[0].body.ticket, "ticket-a");
  assert.equal(received[0].body.seq, 7);
  assert.equal(
    (await post("/v1/events", signedEvent(id, { seq: 0 }))).status,
    400
  );
  assert.equal(
    (await post("/v1/events", signedEvent(id, { ticket: "" }))).status,
    400
  );
});

test("an event APNs refused can be retried under the same id", async () => {
  received = [];
  const id = await registered();
  const event = signedEvent(id, { id: "retry-me" });
  respondWith = {
    status: 503,
    body: JSON.stringify({ reason: "ServiceUnavailable" }),
  };
  assert.equal((await post("/v1/events", event)).status, 502);
  respondWith = { status: 200, body: "" };
  const retry = await post("/v1/events", event);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, undefined);
  assert.equal(received.length, 2);
  // Delivered now: a third try is a duplicate and sends nothing.
  assert.equal(
    (await (await post("/v1/events", event)).json()).duplicate,
    true
  );
  assert.equal(received.length, 2);
});

test("an event is still sent once after the relay restarts", async () => {
  received = [];
  const id = await registered();
  const event = signedEvent(id, { id: "across-restart" });
  assert.equal((await post("/v1/events", event)).status, 200);
  assert.equal(received.length, 1);

  const second = createRelay({
    dataDir: dir,
    apns: apnsClient,
    now: () => clock,
  });
  await new Promise((resolve) => second.server.listen(0, "127.0.0.1", resolve));
  try {
    const again = await fetch(
      `http://127.0.0.1:${second.server.address().port}/v1/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }
    );
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);
    assert.equal(received.length, 1);
  } finally {
    second.server.close();
  }
});

test("a delivered event stays remembered for a day, not for ever", async () => {
  received = [];
  const id = await registered();
  const first = signedEvent(id, { id: "day-old" });
  assert.equal((await post("/v1/events", first)).status, 200);
  clock += 25 * 60 * 60 * 1000;
  const next = signedEvent(id, { id: "day-old" });
  assert.equal((await post("/v1/events", next)).status, 200);
  assert.equal(received.length, 2);
});
