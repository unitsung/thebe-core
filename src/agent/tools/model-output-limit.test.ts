import { describe, expect, it } from "vitest";
import { limitModelOutput } from "./model-output-limit.ts";

describe("limitModelOutput", () => {
  it("passes a small result through untouched", () => {
    expect(limitModelOutput('{"a":1}', 100)).toBe('{"a":1}');
  });

  it("keeps JSON valid, keeps the leading items and says how many were omitted", () => {
    const big = JSON.stringify({
      items: Array.from({ length: 400 }, (_, i) => ({
        id: `item-${i}`,
        note: "x".repeat(40),
      })),
    });
    const out = limitModelOutput(big, 3_000);
    expect(out.length).toBeLessThanOrEqual(3_000);
    const parsed = JSON.parse(out) as { items: unknown[] };
    expect(JSON.stringify(parsed.items[0])).toContain("item-0");
    expect(String(parsed.items.at(-1))).toContain("more items omitted");
  });

  it("clips one huge string field instead of dropping the document", () => {
    const out = limitModelOutput(
      JSON.stringify({ log: "y".repeat(50_000) }),
      2_000
    );
    expect(JSON.parse(out).log).toContain("chars omitted");
  });

  it("keeps the tail of plain text and a marker", () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join(
      "\n"
    );
    const out = limitModelOutput(lines, 1_000);
    expect(out).toContain("line 1999");
    expect(out).not.toContain("line 0\n");
    expect(out.startsWith("[… ")).toBe(true);
  });
});

import {
  resolveModelResultLimit,
  MODEL_RESULT_CHAR_LIMIT,
} from "./model-output-limit.ts";

describe("resolveModelResultLimit", () => {
  it("applies no cap unless a positive limit is configured", () => {
    expect(MODEL_RESULT_CHAR_LIMIT).toBe(12_000);
    expect(resolveModelResultLimit(undefined)).toBe(0);
    expect(resolveModelResultLimit("  ")).toBe(0);
    expect(resolveModelResultLimit("lots")).toBe(0);
    expect(resolveModelResultLimit("off")).toBe(0);
    expect(resolveModelResultLimit("OFF")).toBe(0);
    expect(resolveModelResultLimit("0")).toBe(0);
    expect(resolveModelResultLimit("none")).toBe(0);
    expect(resolveModelResultLimit("30000")).toBe(30_000);
    expect(resolveModelResultLimit("50")).toBe(2_000);
  });
});
