import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createStreamGuard } from "./index.ts";

function hangingStream() {
  return createAssistantMessageEventStream();
}

async function drainUntilEnd(
  stream: AsyncIterable<{ type?: string }>,
  ms: number,
): Promise<string[]> {
  const got: string[] = [];
  const pump = (async () => {
    for await (const event of stream) {
      got.push(event.type ?? "");
    }
  })();
  await Promise.race([
    pump,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("stream did not end")), ms),
    ),
  ]);
  return got;
}

describe("StreamGuard (§5 dual timers)", () => {
  it("aborts on TTFB timeout, records ttfb_timeout, and ends the stream", async () => {
    const abort = vi.fn();
    const events: string[] = [];
    const guard = createStreamGuard({
      ttfbMs: 20,
      idleMs: 1000,
      watchdogMs: 1000,
      abort,
      onEvent: (k) => events.push(k),
    });
    const wrapped = guard.wrapStreamFn(async () => hangingStream());
    const stream = await wrapped({} as never, {} as never);
    const types = await drainUntilEnd(stream, 400);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(events).toContain("ttfb_timeout");
    expect(types).toContain("error");
    guard.dispose();
  });

  it("slow prefill longer than idle is TTFB, not idle", async () => {
    const abort = vi.fn();
    const events: string[] = [];
    const guard = createStreamGuard({
      ttfbMs: 80,
      idleMs: 20,
      watchdogMs: 1000,
      abort,
      onEvent: (k) => events.push(k),
    });
    const wrapped = guard.wrapStreamFn(async () => hangingStream());
    const stream = await wrapped({} as never, {} as never);
    await drainUntilEnd(stream, 400);
    expect(events).toContain("ttfb_timeout");
    expect(events).not.toContain("idle_timeout");
    expect(abort).toHaveBeenCalledTimes(1);
    guard.dispose();
  });

  it("cancels TTFB after first content; idle still fires", async () => {
    const abort = vi.fn();
    const events: string[] = [];
    const guard = createStreamGuard({
      ttfbMs: 1000,
      idleMs: 20,
      watchdogMs: 1000,
      abort,
      onEvent: (k) => events.push(k),
    });
    const inner = createAssistantMessageEventStream();
    const wrapped = guard.wrapStreamFn(async () => inner);
    const stream = await wrapped({} as never, {} as never);
    inner.push({ type: "start", partial: {} } as never);
    const seen = await drainUntilEnd(stream, 400);
    expect(events).not.toContain("ttfb_timeout");
    expect(events).toContain("idle_timeout");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(seen).toContain("start");
    expect(seen).toContain("error");
    guard.dispose();
  });

  it("content events reset idle so a slow stream is not treated as idle", async () => {
    const abort = vi.fn();
    const guard = createStreamGuard({
      ttfbMs: 1000,
      idleMs: 40,
      watchdogMs: 1000,
      abort,
    });
    const inner = createAssistantMessageEventStream();
    const wrapped = guard.wrapStreamFn(async () => inner);
    const stream = await wrapped({} as never, {} as never);
    const pump = (async () => {
      for await (const _ of stream) {
        // drain
      }
    })();
    inner.push({ type: "start", partial: {} } as never);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 15));
      inner.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "x",
        partial: {},
      } as never);
    }
    expect(abort).not.toHaveBeenCalled();
    guard.dispose();
    await Promise.race([pump, new Promise((r) => setTimeout(r, 50))]);
  });

  it("turns a throwing streamFn into an error event and does not hang", async () => {
    const guard = createStreamGuard({ ttfbMs: 1000, idleMs: 1000 });
    const wrapped = guard.wrapStreamFn(async () => {
      throw new Error("boom");
    });
    const stream = await wrapped({} as never, {} as never);
    const got = await drainUntilEnd(stream, 400);
    expect(got).toEqual(["error"]);
    guard.dispose();
  });

  it("idle-timeouts a stream that emitted content then never closed (#7954)", async () => {
    const abort = vi.fn();
    const events: string[] = [];
    const guard = createStreamGuard({
      ttfbMs: 1000,
      idleMs: 20,
      watchdogMs: 1000,
      abort,
      onEvent: (k) => events.push(k),
    });
    const inner = createAssistantMessageEventStream();
    const wrapped = guard.wrapStreamFn(async () => inner);
    const stream = await wrapped({} as never, {} as never);
    inner.push({
      type: "start",
      partial: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stopReason: "stop",
      },
    } as never);
    const types = await drainUntilEnd(stream, 400);
    expect(events).toContain("idle_timeout");
    expect(events).not.toContain("ttfb_timeout");
    expect(types).toContain("error");
    expect(abort).toHaveBeenCalledTimes(1);
    guard.dispose();
  });

  it("force-kills if agent_end never arrives after abort", async () => {
    const events: string[] = [];
    const guard = createStreamGuard({
      ttfbMs: 20,
      idleMs: 1000,
      watchdogMs: 20,
      abort: () => {},
      onEvent: (k) => events.push(k),
    });
    const wrapped = guard.wrapStreamFn(async () => hangingStream());
    const stream = await wrapped({} as never, {} as never);
    const pump = (async () => {
      for await (const _ of stream) {
        // hang
      }
    })();
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toContain("ttfb_timeout");
    expect(events).toContain("force-killed");
    expect(guard.wasForceKilled()).toBe(true);
    guard.dispose();
    await Promise.race([pump, new Promise((r) => setTimeout(r, 50))]);

    const events2: string[] = [];
    const g2 = createStreamGuard({
      ttfbMs: 20,
      idleMs: 1000,
      watchdogMs: 50,
      abort: () => {},
      onEvent: (k) => events2.push(k),
    });
    const w2 = g2.wrapStreamFn(async () => hangingStream());
    const s2 = await w2({} as never, {} as never);
    const p2 = (async () => {
      for await (const _ of s2) {
        // hang
      }
    })();
    await new Promise((r) => setTimeout(r, 30));
    g2.notifyAgentEnd();
    await new Promise((r) => setTimeout(r, 80));
    expect(events2).toContain("ttfb_timeout");
    expect(events2).not.toContain("force-killed");
    g2.dispose();
    await Promise.race([p2, new Promise((r) => setTimeout(r, 50))]);
  });
});
