import { describe, expect, it } from "vitest";
import { mapPiEvent, mapPiMessages } from "./map-events.ts";

describe("mapPiEvent", () => {
  it("normalizes tool and turn events without Pi names", async () => {
    const started = mapPiEvent({
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call_1",
    });
    expect(started).toMatchObject({
      type: "tool_start",
      toolName: "bash",
      toolCallId: "call_1",
    });
    expect(mapPiEvent({ type: "turn_end" })).toEqual({ type: "turn_end" });
    expect(
      JSON.stringify([
        started,
        mapPiEvent({ type: "turn_end" }),
        mapPiEvent({ type: "agent_end" }),
      ]),
    ).not.toContain("message_update");
  });

  it("maps compaction_end with token estimates", async () => {
    expect(
      mapPiEvent({
        type: "compaction_start",
        reason: "threshold",
      }),
    ).toEqual({ type: "compaction_start", reason: "threshold" });
    expect(
      mapPiEvent({
        type: "compaction_end",
        reason: "threshold",
        aborted: false,
        result: { tokensBefore: 90000, estimatedTokensAfter: 21000 },
      } as unknown as { type: string }),
    ).toEqual({
      type: "compaction_end",
      aborted: false,
      reason: "threshold",
      tokensBefore: 90000,
      estimatedTokensAfter: 21000,
      errorMessage: undefined,
    });
  });

  it("maps queue arrays to counts", async () => {
    const event = mapPiEvent({
      type: "queue_update",
      steering: ["a"],
      followUp: ["b", "c"],
    } as unknown as { type: string });
    expect(event).toEqual({
      type: "queue_update",
      steering: 1,
      followUp: 2,
    });
  });
});

describe("mapPiMessages", () => {
  it("keeps stable ids and surfaces image attachments", async () => {
    const messages = mapPiMessages([
      { id: "m1", role: "user", content: "hello" },
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "text", text: "seen" },
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "aa" },
          },
        ],
      },
      {
        id: "m3",
        role: "toolResult",
        content: "ok",
        toolName: "bash",
        toolCallId: "call_1",
      },
    ]);
    expect(messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    expect(messages[1]?.attachments).toEqual([{ mediaType: "image/png" }]);
    expect(messages[0]?.attachments).toBeUndefined();
    expect(messages[2]).toMatchObject({ role: "tool", toolName: "bash" });
  });
});
