import { describe, expect, it } from "vitest";
import { dangerousCommand } from "./dangerous-command.ts";
import { literalCommands } from "./shell-parse.ts";

// Codex's own cases (`is_dangerous_command.rs` tests), kept as they are.
describe("dangerousCommand (Codex's cases)", () => {
  it("rm -rf and rm -f are dangerous", async () => {
    expect(await dangerousCommand(["rm", "-rf", "/"])).toBe("forced-rm");
    expect(await dangerousCommand(["rm", "-f", "/"])).toBe("forced-rm");
  });

  it("forced rm in its variants is dangerous", async () => {
    for (const command of [
      ["/bin/rm", "-fr", "/tmp/example"],
      ["rm", "-r", "-f", "/tmp/example"],
      ["rm", "--force", "/tmp/example"],
      ["rm", "/tmp/example", "-f"],
      ["sudo", "rm", "-rf", "/tmp/example"],
      ["env", "TARGET=/tmp/example", "rm", "-rf", "/tmp/example"],
    ]) {
      expect(await dangerousCommand(command), command.join(" ")).toBe("forced-rm");
    }
  });

  it("wrappers nested too deeply fail closed", async () => {
    const nest = (depth: number) => [...Array<string>(depth).fill("env"), "rm", "-rf", "/tmp/example"];
    expect(await dangerousCommand(nest(8))).toBe("forced-rm");
    expect(await dangerousCommand(nest(9))).toBe("other");
  });

  it("forced rm in complex shell syntax is dangerous", async () => {
    for (const script of [
      "printf x | rm -rf /tmp/example",
      "if test -d /tmp/example; then rm --force /tmp/example; fi",
      'rm -rf "$TARGET" >/dev/null',
      'for target in /tmp/a /tmp/b; do rm -r -f "$target"; done',
      'echo "$(rm -rf /tmp/example)"',
      "bash -c 'rm -rf /tmp/example'",
      "trap 'rm -rf /tmp/example' EXIT",
      `for a in '-C5a25KeRr' '--' '--json' '--bogus'; do HOME=$(mktemp -d) MDE_URL=http://127.0.0.1:1 MDE_TOKEN=x node cli/mde.cjs ls "$a" >/tmp/mde-review-out 2>/tmp/mde-review-err; code=$?; printf '%s\\t%s\\t%s\\n' "$a" "$code" "$(tr '\\n' ' ' </tmp/mde-review-err)"; rm -rf "$HOME"; done`,
    ]) {
      expect(await dangerousCommand(["bash", "-lc", script]), script).toBe("forced-rm");
    }
  });

  it("an unforced or non-literal rm is not dangerous", async () => {
    for (const command of [
      ["rm", "-r", "/tmp/example"],
      ["rm", "--", "-f"],
      ["bash", "-lc", "echo 'rm -rf /tmp/example'"],
      ["bash", "-lc", "cmd=rm; $cmd -rf /tmp/example"],
      ["bash", "-lc", "if then rm -rf /tmp/example"],
      ["env", "TARGET=/tmp/example", "rm", "-r", "/tmp/example"],
      ["bash", "-lc", "trap 'echo rm -rf /tmp/example' EXIT"],
    ]) {
      expect(await dangerousCommand(command), command.join(" ")).toBeUndefined();
    }
  });
});

describe("literalCommands", () => {
  it("gives the words of every command, nested ones included", async () => {
    expect(await literalCommands("ls -1 | grep 'a b' && echo \"$(date)\"")).toEqual(
      expect.arrayContaining([["ls", "-1"], ["grep", "a b"], ["echo"], ["date"]])
    );
  });

  it("leaves out words that expand at run time", async () => {
    expect(await literalCommands("rm -rf $TARGET *.log ~/x")).toEqual([["rm", "-rf"]]);
  });

  it("returns nothing for a script that does not parse", async () => {
    expect(await literalCommands("if then rm -rf /tmp/example")).toBeUndefined();
  });
});
