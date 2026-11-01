import type { DeviceRegistry } from "../../delivery/http/devices.ts";
import { pushEventMessage, type PushIdentity } from "./identity.ts";

export type PushNotice = {
  /** `thebe.activity` or `thebe.permission`, the categories the App registers. */
  category: string;
  /** Short and generic. Never filenames, logs or credentials. */
  title: string;
  body: string;
  /** `thebe://…` route the App opens when the notice is tapped. */
  deepLink: string;
  /** Stable per event, so the relay can drop a repeat. */
  id: string;
};

export type PushNotifier = {
  notify(notice: PushNotice): Promise<void>;
};

/**
 * Hands signed, minimal events to the Push Relay for every device that registered with it for
 * this category. Core holds no APNs credentials; the relay does. A relay that is down or slow
 * never fails the caller: a notice is best effort.
 */
export function createPushNotifier(options: {
  relayUrl: string;
  identity: PushIdentity;
  devices: DeviceRegistry;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): PushNotifier {
  const send = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const endpoint = new URL("/v1/events", options.relayUrl).toString();
  return {
    async notify(notice) {
      let devices;
      try {
        devices = await options.devices.list();
      } catch {
        return;
      }
      const targets = devices.filter(
        (device) =>
          device.relayDeviceId && device.categories.includes(notice.category)
      );
      await Promise.all(
        targets.map(async (device) => {
          const event = {
            relayDeviceId: device.relayDeviceId as string,
            id: notice.id,
            ts: Math.floor(now().getTime() / 1000),
            category: notice.category,
            title: notice.title,
            body: notice.body,
            deepLink: notice.deepLink,
          };
          try {
            await send(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                ...event,
                signature: options.identity.sign(pushEventMessage(event)),
              }),
              signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
            });
          } catch {
            // Best effort.
          }
        })
      );
    },
  };
}
