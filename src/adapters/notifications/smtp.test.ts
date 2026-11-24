import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Notification,
  NotificationSendInput,
} from "../../agent/notifications/types.ts";
import { createSmtpNotificationAdapter } from "./smtp.ts";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

const notification: Notification = {
  id: "event-1",
  category: "pipeline",
  priority: "normal",
  title: "Nightly run",
  body: "The nightly run finished.",
  deepLink: "thebe://pipeline/42",
  createdAt: "2026-11-14T10:00:00.000Z",
};

function input(to: string): NotificationSendInput {
  return {
    target: {
      id: "mail",
      channel: { source: "smtp", thread: "mail", address: { to } },
      categories: "all",
      enabled: true,
    },
    notification,
    idempotencyKey: "idem-1",
  };
}

async function fakeSmtp(options: { rejectRecipient?: boolean } = {}): Promise<{
  url: string;
  messages: string[];
}> {
  const messages: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    let data: string | undefined;
    socket.write("220 test.local ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        if (data !== undefined) {
          if (line === ".") {
            messages.push(data);
            data = undefined;
            socket.write("250 queued\r\n");
          } else {
            data += `${line}\r\n`;
          }
          continue;
        }
        if (line.startsWith("EHLO")) {
          socket.write("250-test.local\r\n250 AUTH PLAIN LOGIN\r\n");
        } else if (line.startsWith("AUTH")) {
          socket.write("235 authenticated\r\n");
        } else if (line.startsWith("MAIL FROM")) {
          socket.write("250 sender ok\r\n");
        } else if (line.startsWith("RCPT TO")) {
          socket.write(
            options.rejectRecipient
              ? "550 no such user\r\n"
              : "250 recipient ok\r\n"
          );
        } else if (line === "DATA") {
          data = "";
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `smtp://user:u@127.0.0.1:${address.port}?starttls=false`,
    messages,
  };
}

describe("SMTP notification adapter", () => {
  it("sends a UTF-8 text message through AUTH and DATA", async () => {
    const smtp = await fakeSmtp();
    const adapter = createSmtpNotificationAdapter({
      url: smtp.url,
      from: "thebe@example.test",
    });
    expect(
      adapter.accepts({
        source: "smtp",
        thread: "mail",
        address: { to: "me@example.test" },
      })
    ).toBe(true);
    const result = await adapter.send(input("me@example.test"));
    expect(result).toEqual({ status: "sent" });
    expect(smtp.messages).toHaveLength(1);
    const message = smtp.messages[0]!;
    expect(message).toContain("To: me@example.test");
    expect(message).toContain("Subject: =?UTF-8?B?");
    expect(message).toContain("Content-Transfer-Encoding: base64");
    const encoded = message.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    expect(decoded).toContain("The nightly run finished.");
    expect(decoded).toContain("thebe://pipeline/42");
  });

  it("treats a rejected recipient as a permanent failure", async () => {
    const smtp = await fakeSmtp({ rejectRecipient: true });
    const adapter = createSmtpNotificationAdapter({
      url: smtp.url,
      from: "thebe@example.test",
    });
    expect(await adapter.send(input("nobody@example.test"))).toMatchObject({
      status: "discard",
      reason: expect.stringContaining("550"),
    });
  });

  it("rejects an empty recipient", () => {
    const adapter = createSmtpNotificationAdapter({
      url: "smtp://127.0.0.1:2525",
      from: "thebe@example.test",
    });
    expect(
      adapter.accepts({ source: "smtp", thread: "mail", address: { to: "" } })
    ).toBe(false);
  });
});
