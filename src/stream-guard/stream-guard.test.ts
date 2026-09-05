import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createStreamGuard } from "./index.ts";

function hangingStream() {
  return createAssistantMessageEventStream();
}

describe("StreamGuard (§5 dual timers)", () => {
  it("aborts on TTFB timeout and records ttfb_timeout", async () => {
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
    const pump = (async () => {
      for await (const _ of stream) {
        // noop
      }
    })();
    await new Promise((r) => setTimeout(r, 60));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(events).toContain("ttfb_timeout");
    guard.dispose();
    await Promise.race([pump, new Promise((r) => setTimeout(r, 50))]);
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
    const seen: string[] = [];
    const pump = (async () => {
      for await (const e of stream) {
        seen.push((e as { type: string }).type);
      }
    })();
    inner.push({ type: "start", partial: {} } as never);
    await new Promise((r) => setTimeout(r, 60));
    expect(events).not.toContain("ttfb_timeout");
    expect(events).toContain("idle_timeout");
    expect(abort).toHaveBeenCalledTimes(1);
    guard.dispose();
    await Promise.race([pump, new Promise((r) => setTimeout(r, 50))]);
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

  it("turns a throwing streamFn into an error event", async () => {
    const guard = createStreamGuard({ ttfbMs: 1000, idleMs: 1000 });
    const wrapped = guard.wrapStreamFn(async () => {
      throw new Error("boom");
    });
    const stream = await wrapped({} as never, {} as never);
    const got: string[] = [];
    for await (const e of stream) {
      got.push((e as { type: string }).type);
      break;
    }
    expect(got).toEqual(["error"]);
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
