import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../../agent/capabilities/containers.ts";
import { createThebeApp } from "../../app/create.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";

function provider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("unused");
    },
    getContainerLogs: async () => "unused",
    getStatusSummary: async () => ({
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 1,
    }),
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function setup(remoteBashAllowed: boolean | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "thebe-remote-bash-"));
  const auditPath = join(dir, "audit.jsonl");
  const app = createThebeApp({
    runtime: createFakeRuntime().runtime,
    provider: provider(),
    remoteBashAllowed,
    auditPath,
    workspacePath: dir,
  });
  const session = await app.agent.createSession();
  const run = (command: unknown) =>
    app.handler.handle(
      new Request(
        `http://127.0.0.1:8787/v1/session/${session.thebeSessionId}/bash`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command }),
        }
      )
    );
  const audit = async () =>
    (await readFile(auditPath, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { run, audit };
}

describe("Session bash product HTTP", () => {
  it("is refused unless the host allows it, and runs nothing", async () => {
    const { run, audit } = await setup(false);
    const refused = await run("ls");
    expect(refused.status).toBe(403);
    expect(await json(refused)).toEqual({
      ok: false,
      error: "remote commands are not enabled on this Core host",
      code: "remote_bash_not_allowed",
    });
    expect(await audit()).toEqual([]);
  });

  it("runs an allowed command and audits it by hash, not by text", async () => {
    const { run, audit } = await setup(true);
    const response = await run("ls -la");
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      exitCode: 0,
      cancelled: false,
      output: "fake output for ls -la\n",
      truncated: false,
    });
    const records = await audit();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ method: "session.bash", result: "ok" });
    expect(JSON.stringify(records[0])).not.toContain("ls -la");
  });

  it("refuses a command the guard rates critical and records the refusal", async () => {
    const { run, audit } = await setup(true);
    const response = await run("rm -rf /");
    expect(response.status).toBe(403);
    expect((await json(response)).code).toBe("command_refused");
    expect((await audit())[0]).toMatchObject({
      method: "session.bash",
      result: "denied",
    });
  });

  it("rejects a missing or blank command", async () => {
    const { run } = await setup(true);
    for (const command of [undefined, "", "   ", 5]) {
      const response = await run(command);
      expect(response.status).toBe(400);
    }
  });
});
