import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KEY_FILE = "push-signing-key.pem";

export type PushIdentity = {
  /** The raw 32-byte Ed25519 public key, base64url. Devices give it to the relay. */
  publicKey: string;
  sign(message: string): string;
};

/**
 * The key this Core signs push events with. It is created once and kept next to the other
 * device state with owner-only permissions; the relay only ever sees the public half.
 */
export function createPushIdentity(
  options: { dir?: string } = {}
): PushIdentity {
  const privateKey = loadOrCreate(options.dir);
  const spki = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  const publicKey = Buffer.from(spki.subarray(spki.length - 32)).toString(
    "base64url"
  );
  return {
    publicKey,
    sign: (message) =>
      sign(null, Buffer.from(message, "utf8"), privateKey).toString(
        "base64url"
      ),
  };
}

function loadOrCreate(dir: string | undefined): KeyObject {
  const file = dir ? join(dir, KEY_FILE) : undefined;
  if (file) {
    try {
      return createPrivateKey(readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
  }
  return privateKey;
}

/** The bytes both sides sign and verify. A fixed-order array, so there is no key ordering to agree on. */
export function pushEventMessage(event: {
  relayDeviceId: string;
  id: string;
  ts: number;
  category: string;
  title: string;
  body: string;
  deepLink: string;
}): string {
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
