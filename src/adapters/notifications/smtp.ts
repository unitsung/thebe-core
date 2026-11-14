import { createHash } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type {
  NotificationAdapter,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import type { ChannelRef } from "../../agent/sources/types.ts";
import { addressValue, truncate } from "./shared.ts";

const MAX_BODY = 100_000;

type SmtpResponse = { code: number; lines: string[] };

/**
 * Minimal SMTP delivery for people who already run a mail server. It supports implicit TLS (`smtps://`)
 * and STARTTLS (`smtp://`), AUTH PLAIN/LOGIN, and plain UTF-8 text. No dependency, no HTML templates, and
 * no credentials in the settings file: `THEBE_SMTP_URL` and `THEBE_SMTP_FROM` are host configuration.
 */
export function createSmtpNotificationAdapter(options: {
  url: string;
  from: string;
  timeoutMs?: number;
}): NotificationAdapter {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    id: "smtp",
    capabilities: { proactive: true, markdown: false, maxTextLength: MAX_BODY },
    accepts(channel: ChannelRef): boolean {
      return mailboxes(channel.address).length > 0;
    },
    async send(input: NotificationSendInput) {
      const to = mailboxes(input.target.channel.address);
      if (to.length === 0)
        return { status: "discard", reason: "mail_to_missing" };
      if (!options.from.trim()) {
        return { status: "discard", reason: "smtp_from_missing" };
      }
      try {
        await deliver(options.url, options.from.trim(), to, input, timeoutMs);
        return { status: "sent" };
      } catch (error) {
        if (error instanceof SmtpConfigError) {
          return { status: "discard", reason: error.message };
        }
        if (error instanceof SmtpRefusal) {
          return {
            status: error.code >= 500 ? "discard" : "retry",
            reason: `smtp ${error.code}: ${error.message}`.slice(0, 300),
          };
        }
        if (error instanceof SmtpInterrupted) {
          return { status: "unknown", reason: error.message };
        }
        return {
          status: "retry",
          reason: `smtp connection failed: ${
            error instanceof Error ? error.message : String(error)
          }`.slice(0, 300),
        };
      }
    },
  };
}

async function deliver(
  rawUrl: string,
  from: string,
  to: string[],
  input: NotificationSendInput,
  timeoutMs: number
): Promise<void> {
  const config = parseSmtpUrl(rawUrl);
  let socket: Socket | TLSSocket;
  const secure = config.secure;
  socket = secure
    ? tlsConnect({
        host: config.host,
        port: config.port,
        servername: config.host,
      })
    : netConnect({ host: config.host, port: config.port });
  socket.setTimeout(timeoutMs);
  let connection = new SmtpConnection(socket);
  let dataStarted = false;
  try {
    await expect(await connection.next(), 220);
    await connection.command("EHLO thebe.local", 250);
    if (!secure && config.starttls) {
      await connection.command("STARTTLS", 220);
      connection.detach();
      socket = tlsConnect({ socket, servername: config.host });
      socket.setTimeout(timeoutMs);
      connection = new SmtpConnection(socket);
      await connection.command("EHLO thebe.local", 250);
    }
    if (config.username) {
      await authenticate(connection, config.username, config.password ?? "");
    }
    await connection.command(`MAIL FROM:<${from}>`, 250);
    for (const recipient of to) {
      await connection.command(`RCPT TO:<${recipient}>`, 250, 251);
    }
    await connection.command("DATA", 354);
    dataStarted = true;
    await connection.write(message(from, to, input));
    await expect(await connection.next(), 250);
    await connection.command("QUIT", 221).catch(() => undefined);
  } catch (error) {
    if (dataStarted && !(error instanceof SmtpRefusal)) {
      throw new SmtpInterrupted(
        `smtp interrupted after DATA: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    throw error;
  } finally {
    socket.destroy();
  }
}

async function authenticate(
  connection: SmtpConnection,
  username: string,
  password: string
): Promise<void> {
  const plain = Buffer.from(`\0${username}\0${password}`, "utf8").toString(
    "base64"
  );
  try {
    await connection.command(`AUTH PLAIN ${plain}`, 235, 503);
    return;
  } catch (error) {
    if (!(error instanceof SmtpRefusal) || error.code !== 504) throw error;
  }
  await connection.command("AUTH LOGIN", 334);
  await connection.command(
    Buffer.from(username, "utf8").toString("base64"),
    334
  );
  await connection.command(
    Buffer.from(password, "utf8").toString("base64"),
    235
  );
}

function message(
  from: string,
  to: string[],
  input: NotificationSendInput
): string {
  const subject = `=?UTF-8?B?${Buffer.from(
    truncate(input.notification.title, 200),
    "utf8"
  ).toString("base64")}?=`;
  const body = Buffer.from(
    [
      truncate(input.notification.body, MAX_BODY),
      ...(input.notification.deepLink ? ["", input.notification.deepLink] : []),
    ].join("\n"),
    "utf8"
  )
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${createHash("sha256")
      .update(input.idempotencyKey)
      .digest("hex")
      .slice(0, 32)}@thebe.local>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    ".",
    "",
  ].join("\r\n");
}

class SmtpConnection {
  private buffer = "";
  private queued: SmtpResponse[] = [];
  private waiters: Array<{
    resolve: (value: SmtpResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed: Error | undefined;
  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString("utf8");
    this.drain();
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error("SmtpClosed"));
  private readonly onTimeout = () => {
    this.fail(
      Object.assign(new Error("smtp timeout"), { name: "TimeoutError" })
    );
    this.socket.destroy();
  };

  constructor(private readonly socket: Socket | TLSSocket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
    socket.on("timeout", this.onTimeout);
  }

  /** Stop listening before the socket is wrapped in TLS; the new connection reads the TLS stream. */
  detach(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    this.socket.off("timeout", this.onTimeout);
  }

  next(): Promise<SmtpResponse> {
    const ready = this.queued.shift();
    if (ready) return Promise.resolve(ready);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async command(line: string, ...expected: number[]): Promise<boolean> {
    this.socket.write(`${line}\r\n`);
    const response = await this.next();
    if (!expected.includes(response.code)) {
      throw new SmtpRefusal(
        response.code,
        response.lines.at(-1) ?? "unexpected response"
      );
    }
    return true;
  }

  write(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(text.replace(/\r?\n/g, "\r\n"), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private drain(): void {
    while (true) {
      const end = responseEnd(this.buffer);
      if (end < 0) return;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const code = Number(lines[0]?.slice(0, 3));
      const response = { code, lines };
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(response);
      else this.queued.push(response);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

class SmtpRefusal extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

class SmtpInterrupted extends Error {}
class SmtpConfigError extends Error {}

function expect(response: SmtpResponse, ...codes: number[]): SmtpResponse {
  if (!codes.includes(response.code)) {
    throw new SmtpRefusal(
      response.code,
      response.lines.at(-1) ?? "unexpected response"
    );
  }
  return response;
}

function responseEnd(buffer: string): number {
  const lines = buffer.split("\r\n");
  let offset = 0;
  for (const line of lines) {
    if (line.length === 0 && offset === buffer.length) return -1;
    if (/^\d{3} /.test(line)) return offset + line.length + 2;
    offset += line.length + 2;
  }
  return -1;
}

function parseSmtpUrl(raw: string): {
  host: string;
  port: number;
  secure: boolean;
  starttls: boolean;
  username?: string;
  password?: string;
} {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SmtpConfigError("SMTP URL is invalid");
  }
  const secure = url.protocol === "smtps:";
  if (url.protocol !== "smtp:" && !secure) {
    throw new SmtpConfigError("SMTP URL must start with smtp:// or smtps://");
  }
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  return {
    host: url.hostname,
    port,
    secure,
    starttls: secure || url.searchParams.get("starttls") !== "false",
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

function mailboxes(address: Record<string, string> | undefined): string[] {
  const raw = addressValue(address, "to");
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(item))
    .slice(0, 20);
}
