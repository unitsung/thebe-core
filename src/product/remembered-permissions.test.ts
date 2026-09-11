import { describe, expect, it } from "vitest";
import { hashParameters } from "../audit/audit-log.ts";
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
});
