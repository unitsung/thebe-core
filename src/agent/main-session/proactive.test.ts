import { describe, expect, it, vi } from "vitest";
import {
  countWords,
  stripToolLogs,
  shortenToWords,
  sanitizeProactiveMessage,
  assertWorkerCannotMessageOwner,
  createProactiveMessageTool,
} from "./proactive.ts";
import { BUILTIN_SUBAGENT_PROFILES } from "../subagents/profiles.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Issue #48: The main session as the only voice", () => {
  describe("criterion 1: workers cannot send messages to the owner directly (asserted)", () => {
    it("asserts caller role and throws if a worker attempts to message the owner directly", () => {
      expect(() => assertWorkerCannotMessageOwner("ticket-worker")).toThrow(
        "Workers cannot send messages to the owner directly"
      );
      expect(() => assertWorkerCannotMessageOwner("goal-worker")).toThrow(
        "Workers cannot send messages to the owner directly"
      );
      expect(() => assertWorkerCannotMessageOwner("worker")).toThrow(
        "Workers cannot send messages to the owner directly"
      );
      // Only main-session is permitted
      expect(() =>
        assertWorkerCannotMessageOwner("main-session")
      ).not.toThrow();
    });

    it("asserts that all built-in subagent profiles exclude proactive messaging tools", () => {
      for (const [name, profile] of Object.entries(BUILTIN_SUBAGENT_PROFILES)) {
        const tools = profile.tools ?? [];
        expect(
          tools,
          `profile ${name} must not contain proactive_message`
        ).not.toContain("proactive_message");
        expect(
          tools,
          `profile ${name} must not contain push or notify tools`
        ).not.toContain("notify");
      }
    });

    it("refuses execution of proactive_message tool if called from a worker", async () => {
      const tool = createProactiveMessageTool({});
      expect(() =>
        tool.invoke("call-1", { message: "Hello owner" }, "ticket-worker")
      ).toThrow("Workers cannot send messages to the owner directly");
    });
  });

  describe("criterion 2: a proactive message over 100 words is shortened or refused", () => {
    const under100 =
      "Container emby has exited due to an unhandled exception. I checked the logs and identified the issue. Would you like me to restart it?";
    const over100 = Array(125).fill("word").join(" ");

    it("shortens arbitrary text to requested word count", () => {
      const shortened = shortenToWords(over100, 10);
      expect(countWords(shortened)).toBe(10);
      expect(shortened.endsWith("…")).toBe(true);
    });

    it("preserves messages under 100 words", () => {
      const result = sanitizeProactiveMessage(under100);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.body).toBe(under100);
        expect(countWords(result.body)).toBeLessThanOrEqual(100);
      }
    });

    it("accurately counts CJK ideographs and mixed text units", () => {
      expect(countWords("Docker 容器 emby 已经重启完成")).toBe(10);
      expect(countWords("备份成功，无异常。")).toBe(7);
    });

    it("shortens to natural sentence boundary when available instead of mid-sentence cutoff", () => {
      const text =
        "Emby 容器异常退出。我已经诊断了日志并完成了重启，所有服务已恢复正常。稍后会持续观察5分钟，如果有新的告警会再次通知你。";
      const shortened = shortenToWords(text, 40);
      expect(shortened).toBe(
        "Emby 容器异常退出。我已经诊断了日志并完成了重启，所有服务已恢复正常。"
      );
      expect(shortened.endsWith("。")).toBe(true);
    });

    it("shortens messages over 100 words by default", () => {
      const result = sanitizeProactiveMessage(over100);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(countWords(result.body)).toBe(100);
        expect(result.body.endsWith("…")).toBe(true);
      }
    });

    it("refuses messages over 100 words when mode is refuse", () => {
      const result = sanitizeProactiveMessage(over100, { mode: "refuse" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("over 100 words");
        expect(result.reason).toContain("is refused");
      }
    });

    it("returns error result in proactive_message tool when refused", async () => {
      const tool = createProactiveMessageTool({});
      const res = await tool.invoke(
        "call-1",
        { message: over100, mode: "refuse" },
        "main-session"
      );
      const text = res.content[0]?.text ?? "{}";
      const parsed = JSON.parse(text) as {
        ok: boolean;
        error?: string;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("is refused");
    });

    it("supports providing a concise summary alongside full message", async () => {
      let receivedNotice: any;
      const tool = createProactiveMessageTool({
        onProactiveMessage: (notice) => {
          receivedNotice = notice;
        },
      });
      const res = await tool.invoke(
        "call-summary",
        {
          message: "Long detailed explanation about container recovery...",
          summary: "Container recovered",
          ticketId: "ticket-1",
        },
        "main-session"
      );
      expect(JSON.parse(res.content[0]?.text ?? "{}").ok).toBe(true);
      expect(receivedNotice?.summary).toBe("Container recovered");
      expect(receivedNotice?.body).toBe(
        "Long detailed explanation about container recovery..."
      );
    });
  });

  describe("criterion 3: a message about a result carries no tool log text", () => {
    it("strips fenced execution code blocks from result messages", () => {
      const textWithBlock = [
        "The download has finished successfully.",
        "```bash",
        "$ qbittorrent-cli list --status completed",
        "hash: 12345 status: completed",
        "```",
        "Files are ready in your media library.",
      ].join("\n");

      const stripped = stripToolLogs(textWithBlock);
      expect(stripped).not.toContain("```bash");
      expect(stripped).not.toContain("qbittorrent-cli");
      expect(stripped).toContain("The download has finished successfully.");
      expect(stripped).toContain("Files are ready in your media library.");
    });

    it("strips tool call headers, stdout/stderr and exit code lines", () => {
      const textWithToolLogs = [
        "Container plex was successfully restarted.",
        "Tool call: container_inspect",
        "stdout: State: running",
        "stderr:",
        "Exit code 0",
        "Plex is healthy and responding to requests.",
      ].join("\n");

      const stripped = stripToolLogs(textWithToolLogs);
      expect(stripped).not.toContain("Tool call:");
      expect(stripped).not.toContain("stdout:");
      expect(stripped).not.toContain("stderr:");
      expect(stripped).not.toContain("Exit code 0");
      expect(stripped).toContain("Container plex was successfully restarted.");
      expect(stripped).toContain("Plex is healthy and responding to requests.");
    });

    it("rejects messages containing exclusively tool logs", () => {
      const purelyToolLogs = [
        "```log",
        "error stack trace",
        "exit code 1",
        "```",
        "stdout: none",
      ].join("\n");

      const result = sanitizeProactiveMessage(purelyToolLogs);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("no content after removing tool logs");
      }
    });
  });

  describe("criterion 4: integration tests with fake runtime and fake relay", () => {
    it("delivers proactive message from main session to relay while enforcing voice constraints", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "thebe-voice-"));
      const calls: Array<Record<string, unknown>> = [];
      const fake = createFakeRuntime();
      const app = createThebeApp({
        runtime: fake.runtime,
        provider: {
          listContainers: async () => [],
          inspectContainer: async () => {
            throw new Error("unused");
          },
          getContainerLogs: async () => "ok",
          getStatusSummary: async () => ({
            totalContainers: 0,
            runningContainers: 0,
            pausedContainers: 0,
            exitedContainers: 0,
            lastUpdated: 1,
          }),
        },
        agentStoreDir: tempDir,
        pushRelayUrl: "https://relay.example",
        pushFetch: (async (_url: string, init: RequestInit) => {
          calls.push(
            JSON.parse(init.body as string) as Record<string, unknown>
          );
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      });

      try {
        // Register device
        await app.handler.handle(
          new Request("http://127.0.0.1:8787/v1/devices", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              token: "t1",
              platform: "ios",
              relayDeviceId: "relay-1",
              categories: ["thebe.activity"],
            }),
          })
        );

        // Tool with tool log text and long text
        const tool = createProactiveMessageTool({
          onProactiveMessage: (notice) =>
            app.agent.onProactiveMessage?.(notice),
        });

        const rawMessage = [
          "Media library sync has completed.",
          "```log",
          "scanning 1500 items...",
          "exit code 0",
          "```",
          "All newly added movies are available to stream.",
        ].join("\n");

        const toolRes = await tool.invoke(
          "call-voice-1",
          { message: rawMessage, ticketId: "ticket-voice-48" },
          "main-session"
        );
        const toolResult = JSON.parse(toolRes.content[0]?.text ?? "{}") as {
          ok: boolean;
          message: string;
        };
        expect(toolResult.ok).toBe(true);
        expect(toolResult.message).not.toContain("```log");
        expect(toolResult.message).toContain(
          "Media library sync has completed."
        );

        // Wait for relay push delivery
        await vi.waitFor(() => {
          expect(calls.length).toBeGreaterThan(0);
        });

        const delivered = calls[0]!;
        expect(delivered).toMatchObject({
          relayDeviceId: "relay-1",
          category: "thebe.activity",
          ticket: "ticket-voice-48",
          deepLink: "thebe://ticket/ticket-voice-48",
        });
        expect(typeof delivered.body).toBe("string");
        expect(delivered.body).not.toContain("```");
        expect(countWords(delivered.body as string)).toBeLessThanOrEqual(100);
      } finally {
        await app.agent.quiesce();
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
