import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Duplex } from "node:stream";
import type {
  NotificationAdapter,
  NotificationDeliveryAttempt,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import { addressValue, renderNotice, truncate } from "./shared.ts";

const MAX_TEXT = 400;

export type IrcConnectionOptions = {
  host: string;
  port: number;
  tls: boolean;
};

/**
 * IRC has no HTTP API, so this adapter opens one short-lived connection per notice: register, join
 * the target channel, send one PRIVMSG, then quit. A socket error before the message is written is
 * retryable; an error after it is `unknown`, because the server may have accepted the line already.
 */
export function createIrcNotificationAdapter(options: {
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  password?: string;
  timeoutMs?: number;
  connect?: (options: IrcConnectionOptions) => Duplex;
}): NotificationAdapter {
  const connect = options.connect ?? defaultConnect;
  return {
    id: "irc",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_TEXT },
    accepts(channel: ChannelRef): boolean {
      return validServer(options) && channelName(channel.address) !== undefined;
    },
    async send(input: NotificationSendInput) {
      const channel = channelName(input.target.channel.address);
      if (!validServer(options) || !channel) {
        return { status: "discard", reason: "irc_target_missing" };
      }
      return sendOne(input, channel, options, connect);
    },
  };
}

function sendOne(
  input: NotificationSendInput,
  channel: string,
  options: {
    host: string;
    port: number;
    tls: boolean;
    nick: string;
    password?: string;
    timeoutMs?: number;
  },
  connect: (options: IrcConnectionOptions) => Duplex
): Promise<NotificationDeliveryAttempt> {
  return new Promise((resolve) => {
    let settled = false;
    let wrote = false;
    let buffer = "";
    let socket: Duplex;
    try {
      socket = connect({
        host: options.host,
        port: options.port,
        tls: options.tls,
      });
    } catch (error) {
      resolve({
        status: "retry",
        reason: `irc connection error: ${message(error)}`,
      });
      return;
    }
    const timer = setTimeout(() => {
      finish(
        wrote
          ? { status: "unknown", reason: "irc timed out after sending" }
          : { status: "retry", reason: "irc connection timed out" }
      );
    }, options.timeoutMs ?? 15_000);

    function finish(attempt: NotificationDeliveryAttempt): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(attempt);
    }

    function line(value: string): void {
      if (!socket.destroyed) socket.write(`${value}\r\n`);
    }

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const raw = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        handleLine(raw);
        index = buffer.indexOf("\n");
      }
    });
    socket.once("error", (error) => {
      finish(
        wrote
          ? {
              status: "unknown",
              reason: `irc error after sending: ${message(error)}`,
            }
          : {
              status: "retry",
              reason: `irc connection error: ${message(error)}`,
            }
      );
    });
    socket.once("close", () => {
      if (!settled) {
        finish(
          wrote
            ? { status: "unknown", reason: "irc closed after sending" }
            : { status: "retry", reason: "irc closed before sending" }
        );
      }
    });

    if (options.password) line(`PASS ${sanitizeToken(options.password)}`);
    line(`NICK ${sanitizeToken(options.nick)}`);
    line(`USER ${sanitizeToken(options.nick)} 0 * :Thebe notifications`);

    function handleLine(raw: string): void {
      if (raw.startsWith("PING ")) {
        line(`PONG ${raw.slice(5)}`);
        return;
      }
      const numeric = /^(?::\S+ )?(\d{3}) /.exec(raw)?.[1];
      if (numeric === "001") {
        line(`JOIN ${channel}`);
        return;
      }
      if (numeric === "366") {
        line(
          `PRIVMSG ${channel} :${truncate(
            renderNotice(input).replace(/[\r\n]+/g, " "),
            MAX_TEXT
          )}`
        );
        wrote = true;
        line("QUIT :Thebe notification sent");
        // The write callback confirms the line reached the socket, not the remote server.
        finish({ status: "sent" });
        return;
      }
      if (numeric === "403" || numeric === "404" || numeric === "405") {
        finish({
          status: "discard",
          reason: `irc refused the channel: ${raw.slice(0, 200)}`,
        });
      }
    }
  });
}

function defaultConnect(options: IrcConnectionOptions): Duplex {
  return options.tls
    ? tlsConnect({
        host: options.host,
        port: options.port,
        servername: options.host,
      })
    : netConnect({ host: options.host, port: options.port });
}

function validServer(options: {
  host: string;
  port: number;
  nick: string;
}): boolean {
  return (
    /^[^\s/]+$/.test(options.host) &&
    Number.isInteger(options.port) &&
    options.port > 0 &&
    options.port <= 65_535 &&
    /^[^\s\x00-\x1f]{1,32}$/.test(options.nick)
  );
}

function channelName(
  address: Record<string, string> | undefined
): string | undefined {
  const raw = addressValue(address, "channel");
  if (!raw || !/^#[^\s,\x00-\x1f]{1,64}$/.test(raw)) return undefined;
  return raw;
}

function sanitizeToken(value: string): string {
  return value.replace(/[\s\x00-\x1f]/g, "");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}
