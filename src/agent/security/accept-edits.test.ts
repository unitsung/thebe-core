import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePermissionMode, PERMISSION_MODES } from "../runtime/interface.ts";
import { acceptEditsApproves } from "./accept-edits.ts";

describe("permission mode names", () => {
  it("are Claude Code's", () => {
    expect(PERMISSION_MODES).toEqual(["plan", "manual", "acceptEdits", "bypassPermissions"]);
  });

  it("are the only names read", () => {
    for (const mode of PERMISSION_MODES) expect(parsePermissionMode(mode)).toBe(mode);
    for (const other of ["default", "ask", "read-only", "full-access", "auto", "bypass", "yolo", "Plan"]) {
      expect(parsePermissionMode(other)).toBeUndefined();
    }
    expect(parsePermissionMode(undefined)).toBeUndefined();
  });
});

describe("acceptEdits", () => {
  let workspace: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "thebe-accept-edits-"));
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, ".git"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const ask = (
    toolName: string,
    args: unknown,
    sandbox: boolean,
    commandGuard = true
  ) =>
    acceptEditsApproves(
      { permissionId: "p", toolCallId: "c", toolName, args },
      {
        workspacePath: workspace,
        sandboxEnforced: () => sandbox,
        guard: { workspacePath: workspace },
        commandGuard,
      }
    );

  it("lets a write inside the workspace run, including a file that does not exist yet", async () => {
    expect(await ask("write", { path: "src/new.ts", content: "x" }, false)).toBe(true);
    expect(await ask("edit", { path: join(workspace, "src", "a.ts") }, false)).toBe(true);
  });

  it("asks about a write outside the workspace, through ../ or through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "thebe-outside-"));
    try {
      await symlink(outside, join(workspace, "link"));
      expect(await ask("write", { path: "../elsewhere.txt" }, true)).toBe(false);
      expect(await ask("write", { path: "/etc/hosts" }, true)).toBe(false);
      expect(await ask("write", { path: "link/file.txt" }, true)).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps .git out of reach, as Codex's workspace-write sandbox does", async () => {
    expect(await ask("write", { path: ".git/config" }, true)).toBe(false);
    expect(await ask("edit", { path: "src/../.git/hooks/pre-commit" }, true)).toBe(false);
  });

  it("runs a command only when a sandbox that confines it is in place", async () => {
    expect(await ask("bash", { command: "ls -la" }, true)).toBe(true);
    expect(await ask("bash", { command: "ls -la" }, false)).toBe(false);
  });

  it("still asks about what the command guard flags, sandbox or not", async () => {
    expect(await ask("bash", { command: "docker run --privileged nginx" }, true)).toBe(false);
    expect(await ask("bash", { command: "zpool destroy tank" }, true)).toBe(false);
  });

  it("asks about what Codex's check finds, however the script is wrapped", async () => {
    for (const command of [
      "rm -rf build",
      "rm -f notes.txt",
      "ls && rm -r -f build",
      "sudo rm -fr build",
      "bash -c 'rm -f a'",
      "env X=1 rm --force a",
      "trap 'rm -rf build' EXIT",
    ]) {
      expect(await ask("bash", { command }, true), command).toBe(false);
    }
  });

  it("asks about a script it cannot read", async () => {
    expect(await ask("bash", { command: "if then rm -rf build" }, true)).toBe(false);
    expect(await ask("bash", { command: "" }, true)).toBe(false);
  });

  it("lets ordinary commands through when the sandbox is there", async () => {
    for (const command of ["ls -la", "git status", "npm test && echo done", "cat a | grep b", "rm -r build"]) {
      expect(await ask("bash", { command }, true), command).toBe(true);
    }
  });

  it("never approves other tools", async () => {
    expect(await ask("memory", { target: "user", operations: [] }, true)).toBe(false);
    expect(await ask("mcp__demo__delete_all", {}, true)).toBe(false);
    expect(await ask("write", {}, true)).toBe(false);
    await writeFile(join(workspace, "f"), "");
  });
});
