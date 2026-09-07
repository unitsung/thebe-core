import { describe, expect, it, vi } from "vitest";
import { createStreamGuard } from "./index.ts";

describe("StreamGuard", () => {
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
    guard.beginRun();
    guard.armTtfb();
    await new Promise((r) => setTimeout(r, 60));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(events).toContain("ttfb_timeout");
    guard.dispose();
  });

  it("idle timeout fires after first content then silence", async () => {
    const abort = vi.fn();
    const events: string[] = [];
    const guard = createStreamGuard({
      ttfbMs: 1000,
      idleMs: 20,
      watchdogMs: 1000,
      abort,
      onEvent: (k) => events.push(k),
    });
    guard.beginRun();
    guard.armTtfb();
    guard.noteContent();
    await new Promise((r) => setTimeout(r, 60));
    expect(abort).toHaveBeenCalledTimes(1);
    expect(events).toContain("idle_timeout");
    guard.dispose();
  });

  it("content resets idle so a live stream is not aborted", async () => {
    const abort = vi.fn();
    const guard = createStreamGuard({
      ttfbMs: 1000,
      idleMs: 40,
      watchdogMs: 1000,
      abort,
    });
    guard.beginRun();
    guard.armTtfb();
    guard.noteContent();
    await new Promise((r) => setTimeout(r, 20));
    guard.noteContent();
    await new Promise((r) => setTimeout(r, 20));
    guard.notifyAgentEnd();
    expect(abort).not.toHaveBeenCalled();
    guard.dispose();
  });
});
