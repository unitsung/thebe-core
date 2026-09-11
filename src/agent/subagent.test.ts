import { describe, expect, it, vi } from "vitest";
import {
  parseSubagentMarkdown,
  isPathSafe,
  RESERVED_TOOLS,
  BUILTIN_SUBAGENTS,
  runSubagent,
} from "./subagent.ts";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";

describe("subagent (Homelab Subagent engine)", () => {
  it("has default built-in subagents tailored for homelab", () => {
    expect(BUILTIN_SUBAGENTS["diagnostics"]).toBeDefined();
    expect(BUILTIN_SUBAGENTS["log-analyzer"]).toBeDefined();
    expect(BUILTIN_SUBAGENTS["network-prober"]).toBeDefined();
  });

  it("parses subagent markdown frontmatter correctly", () => {
    const md = `---
name: custom-diagnostics
description: Diagnostic tool for custom services
tools:
  - container.logs
  - run_subagent
  - bash
maxTurns: 4
inheritContext: true
---
You are a custom diagnostic agent.`;

    const parsed = parseSubagentMarkdown(md, "project");
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe("custom-diagnostics");
    expect(parsed?.description).toBe("Diagnostic tool for custom services");
    expect(parsed?.maxTurns).toBe(4);
    expect(parsed?.inheritContext).toBe(true);
    expect(parsed?.systemPrompt).toBe("You are a custom diagnostic agent.");

    // Reserved tool 'run_subagent' must be stripped (§7.6)
    expect(parsed?.tools).toContain("container.logs");
    expect(parsed?.tools).toContain("bash");
    expect(parsed?.tools).not.toContain("run_subagent");
  });

  it("safeguards against path traversal", () => {
    expect(isPathSafe("/var/thebe", "/var/thebe/subagents/test.md")).toBe(true);
    expect(isPathSafe("/var/thebe", "/var/thebe/../../etc/passwd")).toBe(false);
  });

  it("runs a subagent in ephemeral memory without persisting top-level session", async () => {
    const { runtime, queueTurns } = createFakeRuntime();
    queueTurns([{ kind: "text", text: "All 5 homelab containers are healthy." }]);
    const profile = BUILTIN_SUBAGENTS["diagnostics"]!;
    const events: any[] = [];

    const res = await runSubagent({
      runtime,
      profile,
      task: "Check if containers are healthy",
      onEvent: (evt) => events.push(evt),
    });

    expect(res.subagent).toBe("diagnostics");
    expect(typeof res.result).toBe("string");
    // Ensure events were tagged with subagent
    expect(events.some((e) => e.subagent === "diagnostics")).toBe(true);

    // Ensure ephemeral session did not pollute runtime session list
    const sessions = await runtime.listSessions();
    expect(sessions.length).toBe(0);
  });
});
