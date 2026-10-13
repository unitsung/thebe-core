import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./parser.ts";

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
      ])
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
      ])
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

  it("does not infer a removed OpenCode provider from a bare model ID", () => {
    expect(
      parseCliArgs(["-p", "hi", "--model", "muse-spark-1.3-free"])
    ).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["--model", "muse-spark-1.3-free"])).toMatchObject({
      kind: "error",
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
      message:
        'invalid --tui-mode: "invalid-mode"; want "regular" or "fullscreen"',
    });
  });

  it("parses mcp list/tools/enable/disable/remove", () => {
    expect(parseCliArgs(["mcp", "list"])).toEqual({ kind: "mcp-list" });
    expect(parseCliArgs(["mcp"])).toEqual({ kind: "mcp-list" });
    expect(parseCliArgs(["mcp", "tools"])).toEqual({ kind: "mcp-tools" });
    expect(parseCliArgs(["mcp", "enable", "music"])).toEqual({
      kind: "mcp-enable",
      name: "music",
    });
    expect(parseCliArgs(["mcp", "disable", "music"])).toEqual({
      kind: "mcp-disable",
      name: "music",
    });
    expect(parseCliArgs(["mcp", "remove", "music"])).toEqual({
      kind: "mcp-remove",
      name: "music",
    });
    expect(parseCliArgs(["mcp", "enable"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["mcp", "wat"])).toMatchObject({ kind: "error" });
  });

  it("parses a URL mcp add with repeated headers", () => {
    expect(
      parseCliArgs([
        "mcp",
        "add",
        "music",
        "--url",
        "http://127.0.0.1:8099/mcp",
        "--header",
        "sqmusic=jwt-token",
        "--header=X-Api-Key=abc",
      ])
    ).toEqual({
      kind: "mcp-add",
      name: "music",
      url: "http://127.0.0.1:8099/mcp",
      command: undefined,
      args: [],
      env: {},
      headers: { sqmusic: "jwt-token", "X-Api-Key": "abc" },
    });
  });

  it("parses a stdio mcp add with args and env, and rejects bad shapes", () => {
    expect(
      parseCliArgs([
        "mcp",
        "add",
        "notes",
        "--command",
        "notes-mcp",
        "--arg",
        "-y",
        "--arg",
        "serve",
        "--env",
        "TOKEN=t",
      ])
    ).toEqual({
      kind: "mcp-add",
      name: "notes",
      url: undefined,
      command: "notes-mcp",
      args: ["-y", "serve"],
      env: { TOKEN: "t" },
      headers: {},
    });
    expect(
      parseCliArgs([
        "mcp",
        "add",
        "both",
        "--url",
        "http://x/mcp",
        "--command",
        "y",
      ])
    ).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["mcp", "add", "none"])).toMatchObject({
      kind: "error",
    });
    expect(
      parseCliArgs([
        "mcp",
        "add",
        "x",
        "--url",
        "http://x/mcp",
        "--header",
        "novalue",
      ])
    ).toMatchObject({ kind: "error" });
  });
});
