import { describe, expect, it } from "vitest";
import { REDACTED } from "../../agent/security/redaction.ts";
import { mapDshSessionEvent } from "./events.ts";

describe("DeepSeek Harness event mapping", () => {
  it("maps committed assistant text and thinking", () => {
    const mapped = mapDshSessionEvent({
      seq: 1,
      time: 1,
      type: "assistant/message",
      data: {
        message: {
          id: "message-1",
          role: "assistant",
          content: [
            { type: "reasoning", text: "Check the logs." },
            { type: "text", text: "The service is healthy." },
          ],
        },
      },
    });

    expect(mapped.events).toEqual([
      { type: "thinking_delta", text: "Check the logs." },
      { type: "text_delta", text: "The service is healthy." },
    ]);
    expect(mapped.message).toEqual({
      id: "message-1",
      role: "assistant",
      text: "The service is healthy.",
      thinking: "Check the logs.",
    });
    expect(mapped.assistantText).toBe("The service is healthy.");
  });

  it("maps tool calls and results with their stable ids", () => {
    const started = mapDshSessionEvent({
      seq: 2,
      time: 2,
      type: "tool/call",
      data: {
        callId: "call-1",
        name: "read",
        arguments: '{"path":"README.md"}',
      },
    });
    expect(started.events).toEqual([
      {
        type: "tool_start",
        toolName: "read",
        toolCallId: "call-1",
        args: { path: "README.md" },
      },
    ]);

    const ended = mapDshSessionEvent(
      {
        seq: 3,
        time: 3,
        type: "tool/result",
        data: {
          message: {
            id: "tool-1",
            role: "tool",
            toolCallId: "call-1",
            content: [{ type: "text", text: "file contents" }],
            isError: false,
          },
        },
      },
      new Map([["call-1", "read"]])
    );
    expect(ended.events).toEqual([
      {
        type: "tool_end",
        toolName: "read",
        toolCallId: "call-1",
        isError: false,
        text: "file contents",
      },
    ]);
    expect(ended.message).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      text: "file contents",
      isError: false,
    });
  });

  it("redacts credentials in tool-call arguments", () => {
    const mapped = mapDshSessionEvent({
      seq: 3,
      time: 3,
      type: "tool/call",
      data: {
        callId: "call-secret",
        name: "bash",
        arguments: '{"command":"API_TOKEN=super-secret"}',
      },
    });

    expect(mapped.events).toEqual([
      {
        type: "tool_start",
        toolName: "bash",
        toolCallId: "call-secret",
        args: { command: `API_TOKEN=${REDACTED}` },
      },
    ]);
    expect(JSON.stringify(mapped.events)).not.toContain("super-secret");
  });

  it("maps an aborted turn to interrupted", () => {
    expect(
      mapDshSessionEvent({
        seq: 4,
        time: 4,
        type: "turn/end",
        data: { reason: { kind: "aborted", reason: { kind: "user" } } },
      }).events
    ).toEqual([{ type: "interrupted" }]);
  });
});
