import { describe, expect, it } from "vitest";
import {
  compactStaleToolResults,
  createStaleToolResultExtension,
  STALE_RESULT_CHARS,
} from "./stale-tool-results.ts";

type Msg = { role: string; toolName?: string; content?: unknown };
const turn = (role: "user" | "assistant"): Msg => ({ role });
const result = (text: string): Msg => ({
  role: "toolResult",
  toolName: "web_search",
  content: [{ type: "text", text }],
});
const wrap = (payload: string) =>
  `<tool_output tool="web_search">\n${payload}\n</tool_output>`;
const big = (n: number) =>
  wrap(
    JSON.stringify({
      results: Array.from({ length: n }, (_, i) => ({
        title: `t${i}`,
        excerpt: "x".repeat(300),
      })),
    })
  );
const text = (message: { content?: unknown }) =>
  (message.content as Array<{ text: string }>)[0]!.text;

describe("compactStaleToolResults", () => {
  it("keeps the batch the model has not answered yet whole", () => {
    const fresh = result(big(40));
    const out = compactStaleToolResults([
      turn("user"),
      turn("assistant"),
      fresh,
    ]);
    expect(out[2]).toBe(fresh);
  });

  it("shortens a result the model already acted on, keeping the payload valid JSON inside the wrapper", () => {
    const messages = [
      turn("user"),
      turn("assistant"),
      result(big(40)),
      turn("assistant"),
    ];
    const shortened = text(compactStaleToolResults(messages)[2]!);
    expect(shortened.length).toBeLessThanOrEqual(
      STALE_RESULT_CHARS.sameTurn + 120
    );
    const inner = /^<tool_output[^>]*>\n([\s\S]*)\n<\/tool_output>$/.exec(
      shortened
    )![1]!;
    expect(JSON.parse(inner).results[0].title).toBe("t0");
  });

  it("shortens earlier turns harder than the current one", () => {
    const messages = [
      turn("user"),
      turn("assistant"),
      result(big(40)),
      turn("assistant"),
      turn("user"),
      turn("assistant"),
      result(big(40)),
      turn("assistant"),
    ];
    const out = compactStaleToolResults(messages);
    expect(text(out[2]!).length).toBeLessThan(text(out[6]!).length);
  });

  it("returns untouched messages as the same objects and never mutates its input", () => {
    const small = result(wrap('{"ok":true}'));
    const messages = [
      turn("user"),
      turn("assistant"),
      small,
      turn("assistant"),
    ];
    const before = JSON.stringify(messages);
    expect(compactStaleToolResults(messages)[2]).toBe(small);
    compactStaleToolResults([
      turn("user"),
      turn("assistant"),
      result(big(40)),
      turn("assistant"),
    ]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("drops pictures from earlier turns only", () => {
    const withImage: Msg = {
      role: "toolResult",
      content: [{ type: "image", data: "AAAA" }],
    };
    const out = compactStaleToolResults([
      turn("user"),
      turn("assistant"),
      withImage,
      turn("assistant"),
      turn("user"),
      turn("assistant"),
    ]);
    expect(text(out[2]!)).toContain("omitted");
    const sameTurn = compactStaleToolResults([
      turn("user"),
      turn("assistant"),
      withImage,
      turn("assistant"),
    ]);
    expect(sameTurn[2]).toBe(withImage);
  });
});

describe("createStaleToolResultExtension", () => {
  const install = (env: NodeJS.ProcessEnv) => {
    const handlers: Array<(event: { messages: unknown[] }) => unknown> = [];
    createStaleToolResultExtension(env)({
      on: (_event, handler) => {
        handlers.push(handler as never);
      },
    });
    return handlers;
  };

  it("is opt-in because rewriting sent results loses the prompt cache", () => {
    expect(install({})).toHaveLength(0);
    expect(install({ THEBE_TOOL_RESULT_COMPACTION: "off" })).toHaveLength(0);
  });

  it("registers a context handler when switched on", () => {
    expect(install({ THEBE_TOOL_RESULT_COMPACTION: "on" })).toHaveLength(1);
  });
});
