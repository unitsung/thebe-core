import { describe, expect, it } from "vitest";
import { createCoreEventTools } from "./core-event-tools.ts";
import type { NormalizedEvent } from "../runtime/interface.ts";

describe("Core event tools", () => {
  const events: NormalizedEvent[] = [{ type: "text_delta", text: "hello" }, { type: "interrupted" }];
  it("reads bounded events through the supplied session scope", async () => {
    let received: string | undefined;
    const tool = createCoreEventTools(id => { received = id; return events; }).find(t => t.name === "list_core_events")!;
    const result = await tool.execute("test", { sessionId: "session", limit: 1 });
    expect(received).toBe("session");
    expect(JSON.parse(result.content[0]!.text)).toEqual([{ type: "interrupted" }]);
  });
  it("diagnoses recorded errors without inventing a result", async () => {
    const tool = createCoreEventTools(() => events).find(t => t.name === "diagnose_from_events")!;
    expect(JSON.parse((await tool.execute("test", {})).content[0]!.text)).toEqual({
      category: "all", totalEvents: 2, errors: 1, lastError: { type: "interrupted" },
    });
  });
});
