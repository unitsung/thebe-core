import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.ts";

describe("parseCliArgs", () => {
  it("defaults to tui", () => {
    expect(parseCliArgs([])).toEqual({
      kind: "tui",
      sessionId: undefined,
      continueLast: false,
      title: undefined,
      tuiMode: undefined,
    });
  });

  it("parses print mode", () => {
    expect(parseCliArgs(["-p", "hello world"])).toEqual({
      kind: "print",
      text: "hello world",
      sessionId: undefined,
      continueLast: false,
      title: undefined,
      model: undefined,
      thinking: undefined,
      mode: undefined,
    });
  });

  it("parses session list/create/export", () => {
    expect(parseCliArgs(["session", "list"])).toEqual({ kind: "session-list" });
    expect(parseCliArgs(["session", "create", "--name", "demo"])).toEqual({
      kind: "session-create",
      title: "demo",
      model: undefined,
    });
    expect(
      parseCliArgs([
        "session",
        "export",
        "abc",
        "--format",
        "html",
        "-o",
        "out",
      ]),
    ).toEqual({
      kind: "session-export",
      sessionId: "abc",
      format: "html",
      out: "out",
    });
  });

  it("parses model flags and list-models", () => {
    expect(parseCliArgs(["--list-models", "gpt"])).toMatchObject({
      kind: "list-models",
      search: "gpt",
    });
    expect(
      parseCliArgs([
        "-p",
        "hi",
        "--model",
        "opencode/gpt-5",
        "--thinking",
        "high",
      ]),
    ).toMatchObject({
      kind: "print",
      text: "hi",
      model: { providerId: "opencode", modelId: "gpt-5" },
      thinking: "high",
    });
  });

  it("rejects bad model", () => {
    expect(parseCliArgs(["-p", "hi", "--model", "nope"])).toMatchObject({
      kind: "error",
    });
  });

  it("supports muse-spark shorthand without provider", () => {
    expect(
      parseCliArgs(["-p", "hi", "--model", "muse-spark-1.3-free"]),
    ).toMatchObject({
      kind: "print",
      model: { providerId: "opencode", modelId: "muse-spark-1.3-free" },
    });
    expect(parseCliArgs(["--model", "muse-spark-1.3-free"])).toMatchObject({
      kind: "tui",
      model: { providerId: "opencode", modelId: "muse-spark-1.3-free" },
    });
  });

  it("parses continue and resume", () => {
    expect(parseCliArgs(["-c"])).toEqual({
      kind: "tui",
      sessionId: undefined,
      continueLast: true,
      title: undefined,
      tuiMode: undefined,
    });
    expect(parseCliArgs(["--session", "abc-123"])).toEqual({
      kind: "tui",
      sessionId: "abc-123",
      continueLast: false,
      title: undefined,
      tuiMode: undefined,
    });
  });

  it("parses --tui-mode and --fullscreen flags", () => {
    expect(parseCliArgs(["--tui-mode", "fullscreen"])).toMatchObject({
      kind: "tui",
      tuiMode: "fullscreen",
    });
    expect(parseCliArgs(["--tui-mode", "regular"])).toMatchObject({
      kind: "tui",
      tuiMode: "regular",
    });
    expect(parseCliArgs(["--fullscreen"])).toMatchObject({
      kind: "tui",
      tuiMode: "fullscreen",
    });
    expect(parseCliArgs(["--tui-mode", "invalid-mode"])).toMatchObject({
      kind: "error",
      message: 'invalid --tui-mode: "invalid-mode"; want "regular" or "fullscreen"',
    });
  });
});
