import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../capabilities/containers.ts";
import { createThebeAgent } from "../index.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import { MEMORY_LIMIT_BYTES } from "./memory.ts";
import { createJsonMemoryStore } from "./store.ts";

function emptyProvider(): ContainerInfoProvider {
  const unused = async () => {
    throw new Error("unused");
  };
  return { listContainers: async () => [], inspectContainer: unused, getContainerLogs: unused, getStatusSummary: unused };
}

const workspace = await mkdtemp(join(tmpdir(), "thebe-memory-"));

async function setup(options: { withStore?: boolean; initial?: { user: string[]; notes: string[] }; auditPath?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "thebe-memory-store-"));
  const path = join(dir, "memory.json");
  const store = options.withStore === false ? undefined : createJsonMemoryStore(path);
  if (store && options.initial) store.save(options.initial);
  const fake = createFakeRuntime();
  const creates: Array<Parameters<typeof fake.runtime.createSession>[0]> = [];
  const runtime = {
    ...fake.runtime,
    async createSession(create: Parameters<typeof fake.runtime.createSession>[0]) {
      creates.push(create);
      return fake.runtime.createSession(create);
    },
  };
  const agent = createThebeAgent({
    runtime,
    provider: emptyProvider(),
    workspacePath: workspace,
    ...(store ? { memoryStore: store } : {}),
    ...(options.auditPath ? { auditPath: options.auditPath } : {}),
  });
  const tool = (index = creates.length - 1) => creates[index]!.customTools.find((t) => t.name === "memory");
  const toolNames = (index = creates.length - 1) => creates[index]!.customTools.map((t) => t.name);
  return { agent, creates, path, tool, toolNames };
}

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

/** The model sees a tool's output inside <tool_output> tags; this is what is inside them. */
const unwrap = (result: ToolResult) =>
  result.content[0]!.text!.replace(/^<tool_output[^>]*>\n?/, "").replace(/\n?<\/tool_output>$/, "");
const text = async (promise: Promise<ToolResult>) =>
  JSON.parse(unwrap(await promise)) as Record<string, unknown>;

// The system prompt and the tool list both open every request, so both must hold still for the
// provider's cache. These pin what memory may and may not change in them.
describe("Thebe Memory and the prompt cache", () => {
  it("with no memory store nothing changes: no tool, no section", async () => {
    const without = await setup({ withStore: false });
    await without.agent.createSession();
    expect(without.tool()).toBeUndefined();
    expect(without.creates[0]!.systemPrompt).not.toContain("<memory");
    expect(without.creates[0]!.toolsRequiringApproval).not.toContain("memory");
    expect(without.agent.getMemory().enabled).toBe(false);
  });

  it("an empty memory leaves the system prompt exactly as it was; the tool is added to the list", async () => {
    const without = await setup({ withStore: false });
    const empty = await setup();
    await without.agent.createSession();
    await empty.agent.createSession();
    expect(empty.creates[0]!.systemPrompt).toBe(without.creates[0]!.systemPrompt);
    expect(empty.toolNames().filter((n) => n !== "memory")).toEqual(without.toolNames());
    expect(empty.creates[0]!.toolsRequiringApproval).toContain("memory");
  });

  it("saved memory is appended after the built-in prompt", async () => {
    const empty = await setup();
    const filled = await setup({ initial: { user: ["Prefers Chinese replies"], notes: ["The NAS is Atlas"] } });
    await empty.agent.createSession();
    await filled.agent.createSession();
    expect(filled.creates[0]!.systemPrompt!.startsWith(empty.creates[0]!.systemPrompt!)).toBe(true);
    expect(filled.creates[0]!.systemPrompt).toContain("- Prefers Chinese replies");
    expect(filled.creates[0]!.systemPrompt).toContain("- The NAS is Atlas");
  });

  it("the tool list is the same whether memory is empty or full, and in every session", async () => {
    const empty = await setup();
    const filled = await setup({ initial: { user: ["a"], notes: ["b"] } });
    await empty.agent.createSession();
    await empty.agent.createSession();
    await filled.agent.createSession();
    expect(empty.toolNames(1)).toEqual(empty.toolNames(0));
    expect(filled.toolNames()).toEqual(empty.toolNames());
  });

  it("a write during a session reaches the next session and not the open one", async () => {
    const { agent, creates, tool } = await setup();
    await agent.createSession();
    const before = creates[0]!.systemPrompt!;
    const saved = await text(tool(0)!.execute("c1", { target: "user", operations: [{ action: "add", content: "Call me Li" }] }));
    expect(saved).toMatchObject({ ok: true, changed: true, entries: ["Call me Li"], appliesFrom: "next session" });
    expect(creates[0]!.systemPrompt).toBe(before);
    await agent.createSession();
    await agent.createSession();
    expect(creates[1]!.systemPrompt).toContain("- Call me Li");
    expect(creates[1]!.systemPrompt!.startsWith(before)).toBe(true);
    expect(creates[2]!.systemPrompt).toBe(creates[1]!.systemPrompt);
  });

  it("changing other settings does not touch the prompt", async () => {
    const { agent, creates } = await setup({ initial: { user: ["a"], notes: [] } });
    await agent.createSession();
    await agent.updateAgentSettings({ autoCompact: false });
    await agent.createSession();
    expect(creates[1]!.systemPrompt).toBe(creates[0]!.systemPrompt);
  });
});

describe("the memory tool and the owner's edits", () => {
  it("returns the entries and the size, and a refusal shows what is there", async () => {
    const { agent, tool } = await setup({ initial: { user: [], notes: ["x".repeat(MEMORY_LIMIT_BYTES.notes - 10)] } });
    await agent.createSession();
    const refused = await text(tool(0)!.execute("c", { target: "notes", operations: [{ action: "add", content: "y".repeat(50) }] }));
    expect(refused).toMatchObject({ ok: false, limitBytes: MEMORY_LIMIT_BYTES.notes });
    expect((refused.entries as string[]).length).toBe(1);
  });

  it("reports malformed arguments as an error", async () => {
    const { agent, tool } = await setup();
    await agent.createSession();
    const badTarget = await tool(0)!.execute("c", { target: "elsewhere", operations: [] });
    expect(badTarget.isError).toBe(true);
    expect(unwrap(badTarget)).toMatch(/target/);
    const noContent = await tool(0)!.execute("c", { target: "user", operations: [{ action: "add" }] });
    expect(noContent.isError).toBe(true);
    expect(unwrap(noContent)).toMatch(/content/);
  });

  it("the owner can edit it without approval, and the file holds the result", async () => {
    const { agent, path } = await setup();
    const result = await agent.editMemory("user", [{ action: "add", content: "Likes short answers" }]);
    expect(result.ok).toBe(true);
    expect(agent.getMemory().memory.user.entries).toEqual(["Likes short answers"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ user: ["Likes short answers"], notes: [] });
    const refused = await agent.editMemory("user", [{ action: "remove", oldText: "no such entry" }]);
    expect(refused.ok).toBe(false);
    expect(agent.getMemory().memory.user.entries).toEqual(["Likes short answers"]);
  });

  it("audits each change by hash, never the text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-memory-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { agent } = await setup({ auditPath });
    await agent.editMemory("notes", [{ action: "add", content: "private detail about the house" }]);
    const raw = await readFile(auditPath, "utf8");
    expect(raw).not.toContain("private detail");
    expect(JSON.parse(raw.trim().split("\n").at(-1)!)).toMatchObject({ method: "memory.edit", result: "ok" });
  });

  it("two writes at once both land", async () => {
    const { agent } = await setup();
    await Promise.all([
      agent.editMemory("user", [{ action: "add", content: "one" }]),
      agent.editMemory("user", [{ action: "add", content: "two" }]),
    ]);
    expect(agent.getMemory().memory.user.entries.sort()).toEqual(["one", "two"]);
  });
});
