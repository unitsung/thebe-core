import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ImInbound } from "../../agent/im/types.ts";
import {
  createImsgLocalAdapter,
  createNodeImsgRunner,
  imsgCursorIdentity,
  validateImsgCredentials,
  type ImsgCliRunner,
} from "./imsg.ts";
import { createImessageFactory } from "./imessage.ts";

function runner() {
  const watchArgs: string[][] = [];
  const sendArgs: string[][] = [];
  const sentFileData: Buffer[] = [];
  const cli: ImsgCliRunner = {
    async watch(input) {
      watchArgs.push(input.args);
      input.onLine(
        JSON.stringify({
          id: 42,
          guid: "message-guid",
          chat_id: 7,
          chat_guid: "iMessage;-;+15550100",
          chat_identifier: "+15550100",
          chat_name: "Owner",
          is_group: false,
          sender: "+15550100",
          sender_name: "Owner",
          is_from_me: false,
          text: "hello from Messages",
          created_at: "2026-11-24T10:00:00.000Z",
          attachments: [],
        })
      );
      await new Promise<void>((resolve) => {
        input.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
    async send(input) {
      sendArgs.push(input.args);
      const index = input.args.indexOf("--file");
      if (index >= 0) {
        sentFileData.push(await readFile(input.args[index + 1]!));
      }
      return {
        code: 0,
        stdout: '{"status":"sent","id":99,"guid":"sent-guid"}\n',
        stderr: "",
      };
    },
  };
  return { cli, watchArgs, sendArgs, sentFileData };
}

describe("local imsg IM adapter", () => {
  it("streams Messages through imsg watch and sends text by stable chat id", async () => {
    const fake = runner();
    const inbound: ImInbound[] = [];
    const cursors: string[] = [];
    const adapter = createImsgLocalAdapter({
      account: {
        id: "im-imsg-test",
        platform: "imessage",
        label: "iMessage",
        enabled: true,
        createdAt: "2026-11-24T00:00:00Z",
      },
      credentials: { cliPath: "/opt/homebrew/bin/imsg" },
      runner: fake.cli,
      onCursor: (value) => cursors.push(value),
      now: () => new Date("2026-11-24T10:01:00.000Z"),
    });
    adapter.onInbound(async (message) => {
      inbound.push(message);
    });

    await adapter.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0]).toMatchObject({
      platform: "imessage",
      accountId: "im-imsg-test",
      chat: { kind: "direct", id: "7", title: "Owner" },
      sender: { id: "+15550100", name: "Owner" },
      messageId: "message-guid",
      text: "hello from Messages",
    });
    expect(fake.watchArgs[0]).toEqual(["watch", "--json", "--attachments"]);
    expect(cursors).toEqual(["42"]);

    const sent = await adapter.send({
      platform: "imessage",
      accountId: "im-imsg-test",
      chat: { kind: "direct", id: "7" },
      text: "reply",
      mode: "proactive",
      idempotencyKey: "notice-1",
    });
    expect(sent).toEqual({ status: "sent", platformMessageId: "sent-guid" });
    expect(fake.sendArgs[0]).toEqual([
      "send",
      "--chat-id",
      "7",
      "--text",
      "reply",
      "--json",
    ]);

    await adapter.stop();
    expect((await adapter.health()).state).toBe("stopped");
  });

  it("reads only bounded Messages attachments and sends media through a temporary file", async () => {
    const fake = runner();
    const root = await mkdtemp(join(tmpdir(), "thebe-imsg-files-"));
    await mkdir(join(root, "Attachments"));
    const attachment = join(root, "Attachments", "photo.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(attachment, bytes);
    const adapter = createImsgLocalAdapter({
      account: {
        id: "im-imsg-test",
        platform: "imessage",
        label: "iMessage",
        enabled: true,
        createdAt: "2026-11-24T00:00:00Z",
      },
      credentials: {
        cliPath: "/opt/homebrew/bin/imsg",
        dbPath: join(root, "chat.db"),
      },
      runner: fake.cli,
      onCursor: () => {},
    });

    const fetched = await adapter.fetchMedia?.({
      accountId: "im-imsg-test",
      chat: { kind: "direct", id: "7" },
      messageId: "message-guid",
      media: { kind: "image", id: attachment, mimeType: "image/png" },
    });
    expect(fetched).toMatchObject({
      mediaType: "image/png",
      filename: "photo.png",
    });
    expect([...fetched!.data]).toEqual([...bytes]);

    const sent = await adapter.send({
      platform: "imessage",
      accountId: "im-imsg-test",
      chat: { kind: "direct", id: "7" },
      text: "chart",
      media: [
        {
          kind: "image",
          mediaType: "image/png",
          data: bytes.toString("base64"),
          filename: "chart.png",
        },
      ],
      mode: "proactive",
      idempotencyKey: "media-1",
    });
    expect(sent.status).toBe("sent");
    expect(fake.sendArgs.at(-1)).toEqual([
      "send",
      "--chat-id",
      "7",
      "--text",
      "chart",
      "--file",
      expect.stringContaining("chart.png"),
      "--json",
      "--db",
      join(root, "chat.db"),
    ]);
    expect(fake.sentFileData.at(-1)).toEqual(bytes);
    expect(adapter.capabilities.media).toBe(true);
  });

  it("bounds local configuration and scopes its cursor to the CLI database", () => {
    expect(validateImsgCredentials({ cliPath: "imsg" })).toBeUndefined();
    expect(
      validateImsgCredentials({ cliPath: "imsg --not-an-argument" })
    ).toContain("cliPath");
    expect(imsgCursorIdentity({ cliPath: "/opt/homebrew/bin/imsg" })).toBe(
      imsgCursorIdentity({ cliPath: "/opt/homebrew/bin/imsg", dbPath: "" })
    );
    expect(
      imsgCursorIdentity({ cliPath: "/a", dbPath: "/tmp/chat.db" })
    ).not.toBe(imsgCursorIdentity({ cliPath: "/a", dbPath: "/tmp/other.db" }));

    const factory = createImessageFactory({});
    expect(factory.validateCredentials?.({ backend: "imsg" })).toBeUndefined();
    expect(factory.cursorIdentity?.({ backend: "imsg", cliPath: "/a" })).toBe(
      imsgCursorIdentity({ cliPath: "/a" })
    );
  });

  it("returns unknown rather than retrying a send that timed out", async () => {
    const adapter = createImsgLocalAdapter({
      account: {
        id: "im-imsg-test",
        platform: "imessage",
        label: "iMessage",
        enabled: true,
        createdAt: "2026-11-24T00:00:00Z",
      },
      credentials: { cliPath: "/opt/homebrew/bin/imsg" },
      runner: {
        async watch() {},
        async send(input) {
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) {
              resolve();
              return;
            }
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          return { code: null, stdout: "", stderr: "" };
        },
      },
      sendTimeoutMs: 5,
      onCursor: () => {},
    });

    await expect(
      adapter.send({
        platform: "imessage",
        accountId: "im-imsg-test",
        chat: { kind: "direct", id: "7" },
        text: "slow",
        mode: "proactive",
        idempotencyKey: "slow",
      })
    ).resolves.toMatchObject({ status: "unknown" });
  });

  it("drains inbound persistence before writing the cursor and stopping", async () => {
    const fake = runner();
    const cursors: string[] = [];
    let release!: () => void;
    const handled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = createImsgLocalAdapter({
      account: {
        id: "im-imsg-test",
        platform: "imessage",
        label: "iMessage",
        enabled: true,
        createdAt: "2026-11-24T00:00:00Z",
      },
      credentials: { cliPath: "/opt/homebrew/bin/imsg" },
      runner: fake.cli,
      onCursor: (value) => cursors.push(value),
    });
    adapter.onInbound(async () => handled);

    await adapter.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stopped = adapter.stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cursors).toEqual([]);

    release();
    await stopped;
    expect(cursors).toEqual(["42"]);
  });

  it("applies the 1MB output bound per watch message, not for the process lifetime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-imsg-output-"));
    const cli = join(dir, "imsg");
    await writeFile(
      cli,
      `#!/usr/bin/env node
for (let index = 0; index < 2; index += 1) {
  process.stdout.write(JSON.stringify({ padding: "x".repeat(600000) }) + "\\n");
}
setInterval(() => {}, 1000);
`,
      { mode: 0o700 }
    );
    await chmod(cli, 0o700);
    const controller = new AbortController();
    const lines: string[] = [];
    const finished = new Promise<void>((resolve) => {
      const watching = createNodeImsgRunner().watch({
        cliPath: cli,
        args: ["watch", "--json"],
        signal: controller.signal,
        onLine: (line) => {
          lines.push(line);
          if (lines.length === 2) controller.abort();
        },
        onDiagnostic: () => {},
      });
      void watching.then(() => resolve());
    });

    await finished;
    expect(lines).toHaveLength(2);
  });

  it("does not pass Core secrets to the local imsg process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-imsg-env-"));
    const cli = join(dir, "imsg");
    await writeFile(
      cli,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  hasSecret: Boolean(process.env.THEBE_IMSG_TEST_SECRET),
  hasHome: Boolean(process.env.HOME),
}) + "\\n");
setInterval(() => {}, 1000);
`,
      { mode: 0o700 }
    );
    process.env.THEBE_IMSG_TEST_SECRET = "must-not-reach-child";
    try {
      const controller = new AbortController();
      let observed: Record<string, unknown> | undefined;
      await createNodeImsgRunner().watch({
        cliPath: cli,
        args: ["watch", "--json"],
        signal: controller.signal,
        onLine: (line) => {
          observed = JSON.parse(line) as Record<string, unknown>;
          controller.abort();
        },
        onDiagnostic: () => {},
      });
      expect(observed).toEqual({ hasSecret: false, hasHome: true });
    } finally {
      delete process.env.THEBE_IMSG_TEST_SECRET;
    }
  });
});
