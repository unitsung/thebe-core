import { describe, expect, it } from "vitest";
import {
  describeMemoryOperations,
  formatMemoryArgs,
  memoryApprovalNotice,
} from "./memory-call.ts";
import { createToolRenderers } from "./tool-renderer.ts";

const call = {
  target: "user",
  operations: [
    { action: "add", content: "Call me Li\nreply in Chinese" },
    { action: "patch", old_text: "likes tea", content: "likes coffee" },
    { action: "remove", old_text: "old address" },
  ],
};

describe("memory calls in the terminal", () => {
  it("describes what each operation would do", () => {
    expect(describeMemoryOperations(call)).toEqual([
      "add: Call me Li reply in Chinese",
      "change: likes tea → likes coffee",
      "remove: old address",
    ]);
  });

  it("shows the target and the changes on the tool row, not just the target", () => {
    expect(formatMemoryArgs(call)).toBe(
      "user: add: Call me Li reply in Chinese; change: likes tea → likes coffee; remove: old address"
    );
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
    const row = createToolRenderers("memory").renderCall(call, theme as never);
    expect(row.render(400).join("")).toContain("add: Call me Li reply in Chinese");
  });

  it("gives the approval prompt the text that would be saved", () => {
    expect(memoryApprovalNotice(call)).toBe(
      [
        "memory (user) would be changed:",
        "  add: Call me Li reply in Chinese",
        "  change: likes tea → likes coffee",
        "  remove: old address",
      ].join("\n")
    );
  });

  it("says nothing for arguments that are not a memory call", () => {
    expect(memoryApprovalNotice(undefined)).toBeUndefined();
    expect(memoryApprovalNotice({ operations: "x" })).toBeUndefined();
    expect(formatMemoryArgs({})).toBe("");
  });
});
