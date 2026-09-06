import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  isFailureSentinel,
  thebeConvertToLlm,
  thebeTransformContext,
} from "./convert.ts";

function user(text: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  };
}

function assistant(
  text: string,
  stopReason: "stop" | "error" | "aborted" | "toolUse",
  extra: Record<string, unknown> = {},
): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    timestamp: 1,
    ...extra,
  } as AgentMessage;
}

function toolCallAssistant(): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call-1",
        name: "container.list",
        arguments: {},
      },
    ],
    stopReason: "toolUse",
    timestamp: 1,
  } as AgentMessage;
}

describe("thebeTransformContext (§10 / §15 #4)", () => {
  it("strips trailing assistant error and aborted messages", async () => {
    const ok = assistant("hi", "stop");
    const aborted = assistant("", "aborted", { errorMessage: "ttfb_timeout" });
    const messages = [user("ping"), ok, aborted];
    await expect(thebeTransformContext(messages)).resolves.toEqual([
      user("ping"),
      ok,
    ]);
  });

  it("strips aborted assistants sitting under a trailing user prompt", async () => {
    const aborted = assistant("", "error", { errorMessage: "boom" });
    const next = user("try again");
    const messages = [user("ping"), aborted, next];
    await expect(thebeTransformContext(messages)).resolves.toEqual([
      user("ping"),
      next,
    ]);
  });

  it("does not drop user steering messages", async () => {
    const messages = [user("steer left"), assistant("ok", "stop")];
    await expect(thebeTransformContext(messages)).resolves.toBe(messages);
  });

  it("does not repair orphan tool_use by inserting a tool result", async () => {
    const orphan = toolCallAssistant();
    const messages = [user("list"), orphan];
    const out = await thebeTransformContext(messages);
    expect(out).toBe(messages);
    expect(out.some((m) => m.role === "toolResult")).toBe(false);
  });
});

describe("thebeConvertToLlm (§3.3)", () => {
  it("keeps user, assistant, and toolResult only", () => {
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "container.list",
      content: [{ type: "text", text: "[]" }],
      isError: false,
      timestamp: 1,
    };
    const custom = { role: "custom", customType: "notice" } as AgentMessage;
    const out = thebeConvertToLlm([
      user("hi"),
      assistant("yo", "stop"),
      toolResult,
      custom,
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
  });
});

describe("isFailureSentinel (§9 / §15 #15)", () => {
  it("matches Agent.handleRunFailure empty-text error/aborted messages", () => {
    expect(
      isFailureSentinel(
        assistant("", "error", { errorMessage: "stream failed" }),
      ),
    ).toBe(true);
    expect(
      isFailureSentinel(
        assistant("", "aborted", { errorMessage: "ttfb_timeout" }),
      ),
    ).toBe(true);
  });

  it("does not treat a normal or partial assistant reply as a sentinel", () => {
    expect(isFailureSentinel(assistant("pong", "stop"))).toBe(false);
    expect(
      isFailureSentinel(
        assistant("partial", "aborted", { errorMessage: "aborted" }),
      ),
    ).toBe(false);
  });
});
