import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceAccessPolicy } from "./workspace-policy.ts";

function request(toolName: string, path?: string) {
  return {
    permissionId: "permission-test",
    toolName,
    toolCallId: "call-test",
    args: path === undefined ? {} : { path },
  };
}

describe("workspace access policy", () => {
  it("allows ordinary reads in the workspace without prompting", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "thebe-workspace-policy-"));
    await writeFile(join(workspace, "README.md"), "hello\n", "utf8");
    const policy = createWorkspaceAccessPolicy(workspace);

    await expect(policy.preflight(request("read", "README.md"))).resolves.toBe(
      "allow",
    );
    await expect(policy.preflight(request("ls"))).resolves.toBe("allow");
  });

  it("allows instruction files in the workspace but asks before reading outside", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "thebe-workspace-policy-"));
    await writeFile(join(workspace, "AGENTS.md"), "workspace guidance\n", "utf8");
    const policy = createWorkspaceAccessPolicy(workspace);

    await expect(
      policy.preflight(request("read", "AGENTS.md")),
    ).resolves.toBe("allow");
    await expect(
      policy.preflight(request("read", "../outside.txt")),
    ).resolves.toBe("ask");
    await expect(
      policy.preflight(request("grep", "/tmp/outside")),
    ).resolves.toBe("ask");
  });

  it("keeps writes and shell commands on the normal approval path", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "thebe-workspace-policy-"));
    const policy = createWorkspaceAccessPolicy(workspace);

    await expect(policy.preflight(request("write", "README.md"))).resolves.toBe(
      "ask",
    );
    await expect(policy.preflight(request("bash"))).resolves.toBe("ask");
  });
});
