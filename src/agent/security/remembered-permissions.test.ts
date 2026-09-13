import { describe, expect, it } from "vitest";
import { hashParameters } from "../../agent/security/audit/audit-log.ts";
import {
  rememberedDecision,
  rememberedPermissionKey,
} from "./remembered-permissions.ts";

describe("remembered permissions", () => {
  it("scopes high-risk allow to the argument hash", () => {
    const ls = { toolName: "bash", args: { command: "ls" }, risk: "high" as const };
    const rm = {
      toolName: "bash",
      args: { command: "rm -rf /" },
      risk: "high" as const,
    };
    const key = rememberedPermissionKey(ls, "allow");
    expect(key).toBe(`bash:${hashParameters(ls.args)}`);
    expect(key).not.toBe("bash");
    const map = { [key]: "allow" as const };
    expect(rememberedDecision(map, ls)).toBe("allow");
    expect(rememberedDecision(map, rm)).toBeUndefined();
  });

  it("still honors a session-wide tool deny from PATCH", () => {
    expect(
      rememberedDecision({ bash: "deny" }, {
        toolName: "bash",
        args: { command: "ls" },
        risk: "high",
      }),
    ).toBe("deny");
  });

  it("supports an explicit session-wide tool allow", () => {
    const bash = {
      toolName: "bash",
      args: { command: "ls" },
      risk: "high" as const,
    };
    expect(rememberedPermissionKey(bash, "allow", "tool")).toBe("bash");
    expect(
      rememberedDecision(
        { bash: "allow" },
        { ...bash, args: { command: "rm -rf /" } },
      ),
    ).toBe("allow");
  });

  it("supports a conversation-wide allow after specific rules", () => {
    const bash = {
      toolName: "bash",
      args: { command: "ls" },
      risk: "high" as const,
    };
    expect(rememberedPermissionKey(bash, "allow", "conversation")).toBe("*");
    expect(
      rememberedDecision(
        { "*": "allow" },
        { ...bash, args: { command: "git status" } },
      ),
    ).toBe("allow");
    expect(
      rememberedDecision(
        { "*": "allow", bash: "deny" },
        { ...bash, args: { command: "git status" } },
      ),
    ).toBe("deny");
  });
});
