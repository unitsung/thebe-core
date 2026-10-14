import { describe, expect, it } from "vitest";
import { wrapCustomTools } from "./wrapped-tool.ts";
import { createPolicyEngine } from "../security/policy/policy-engine.ts";
import type { CustomToolDefinition } from "../runtime/index.ts";

const policyFor = (...names: string[]) =>
  createPolicyEngine({ now: () => new Date(), allowedToolNames: names });

function tool(
  name: string,
  execute: CustomToolDefinition["execute"]
): CustomToolDefinition {
  return { name, label: name, description: "", parameters: {}, execute } as CustomToolDefinition;
}

describe("wrapped custom tools", () => {
  it("aborts a tool that outlives the watchdog and reports the timeout once", async () => {
    let sawAbort = false;
    let finished = false;
    const [slow] = wrapCustomTools(
      [
        tool("slow", async (_id, _params, signal) => {
          signal?.addEventListener("abort", () => (sawAbort = true));
          await new Promise((resolve) => setTimeout(resolve, 150));
          finished = true;
          return { content: [{ type: "text", text: "late" }], details: {} };
        }),
      ],
      { policy: policyFor("slow"), toolWatchdogMs: 30 }
    );
    const result = await slow!.execute("1", {}, new AbortController().signal);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("watchdog timeout");
    expect(result.details).toMatchObject({ watchdogTimeout: true });
    expect(sawAbort).toBe(true);
    // The tool may still finish on its own; what matters is that it was told to stop.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(finished).toBe(true);
  });

  it("passes the runtime's abort on to the tool", async () => {
    let sawAbort = false;
    const parent = new AbortController();
    const [wait] = wrapCustomTools(
      [
        tool("wait", async (_id, _params, signal) => {
          await new Promise<void>((resolve) => {
            const stop = () => {
              sawAbort = true;
              resolve();
            };
            // The abort may already have happened by the time the tool starts.
            if (signal?.aborted) stop();
            else signal?.addEventListener("abort", stop, { once: true });
          });
          return { content: [{ type: "text", text: "stopped" }], details: {} };
        }),
      ],
      { policy: policyFor("wait") }
    );
    const pending = wait!.execute("1", {}, parent.signal);
    parent.abort();
    await pending;
    expect(sawAbort).toBe(true);
  });

  it("does not leave an unhandled rejection when a timed-out tool fails later", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const [flaky] = wrapCustomTools(
        [
          tool("flaky", async () => {
            await new Promise((resolve) => setTimeout(resolve, 80));
            throw new Error("failed after the watchdog");
          }),
        ],
        { policy: policyFor("flaky"), toolWatchdogMs: 20 }
      );
      await flaky!.execute("1", {}, new AbortController().signal);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("returns a normal result unchanged when no watchdog fires", async () => {
    const [fast] = wrapCustomTools(
      [tool("fast", async () => ({ content: [{ type: "text", text: "ok" }], details: {} }))],
      { policy: policyFor("fast"), toolWatchdogMs: 1000 }
    );
    const result = await fast!.execute("1", {}, new AbortController().signal);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain("ok");
  });
});
