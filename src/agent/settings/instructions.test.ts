import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerInfoProvider } from "../capabilities/containers.ts";
import { createThebeAgent } from "../index.ts";
import { hashParameters } from "../security/audit/audit-log.ts";
import { createFakeRuntime } from "../../testing/runtime/index.ts";
import {
  checkAgentInstructions,
  clampStoredInstructions,
  MAX_AGENT_INSTRUCTIONS_BYTES,
  withUserInstructions,
} from "./instructions.ts";
import { createJsonAgentSettingsStore } from "./store.ts";

function emptyProvider(): ContainerInfoProvider {
  const unused = async () => {
    throw new Error("unused");
  };
  return {
    listContainers: async () => [],
    inspectContainer: unused,
    getContainerLogs: unused,
    getStatusSummary: unused,
  };
}

// One workspace for every agent: the prompt names it, so different paths would differ by themselves.
const workspace = await mkdtemp(join(tmpdir(), "thebe-instructions-"));

async function setup(options: { instructions?: string; auditPath?: string; settingsPath?: string } = {}) {
  const fake = createFakeRuntime();
  const prompts: string[] = [];
  const runtime = {
    ...fake.runtime,
    async createSession(create: Parameters<typeof fake.runtime.createSession>[0]) {
      prompts.push(create.systemPrompt ?? "");
      return fake.runtime.createSession(create);
    },
  };
  const agent = createThebeAgent({
    runtime,
    provider: emptyProvider(),
    workspacePath: workspace,
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
    ...(options.auditPath ? { auditPath: options.auditPath } : {}),
    ...(options.settingsPath ? { settingsStore: createJsonAgentSettingsStore(options.settingsPath) } : {}),
  });
  return { agent, prompts };
}

// A provider's prompt cache matches a request from its first byte, and the system prompt is the
// first thing in it. These tests pin what may and may not change that prefix.
describe("owner instructions and the prompt cache", () => {
  it("adds nothing to the system prompt while no instructions are set", async () => {
    const plain = await setup();
    const emptied = await setup({ instructions: "" });
    await plain.agent.createSession();
    await emptied.agent.createSession();
    expect(plain.prompts[0]).not.toContain("owner_instructions");
    expect(emptied.prompts[0]).toBe(plain.prompts[0]);
    expect(withUserInstructions("base", "")).toBe("base");
  });

  it("only appends: the built-in prompt stays the same leading bytes", async () => {
    const plain = await setup();
    const withText = await setup({ instructions: "Reply in Chinese. The NAS is called Atlas." });
    await plain.agent.createSession();
    await withText.agent.createSession();
    expect(withText.prompts[0]!.startsWith(plain.prompts[0]!)).toBe(true);
    expect(withText.prompts[0]).toContain("Reply in Chinese. The NAS is called Atlas.");
    expect(withText.prompts[0]).toContain("cannot relax the approval");
  });

  it("gives every session the same bytes while the instructions are unchanged", async () => {
    const { agent, prompts } = await setup({ instructions: "Be brief." });
    await agent.createSession();
    await agent.createSession();
    await agent.createSession();
    expect(new Set(prompts).size).toBe(1);
  });

  it("a change reaches sessions opened afterwards and leaves earlier prompts as they were", async () => {
    const { agent, prompts } = await setup({ instructions: "Be brief." });
    await agent.createSession();
    const before = prompts[0]!;
    const updated = await agent.updateAgentSettings({ instructions: "Be detailed." });
    expect(updated.instructions).toBe("Be detailed.");
    await agent.createSession();
    await agent.createSession();
    expect(prompts[0]).toBe(before);
    expect(prompts[1]).toContain("Be detailed.");
    expect(prompts[1]).not.toContain("Be brief.");
    expect(prompts[2]).toBe(prompts[1]);
  });

  it("changing other settings does not touch the prompt", async () => {
    const { agent, prompts } = await setup({ instructions: "Be brief." });
    await agent.createSession();
    await agent.updateAgentSettings({ autoCompact: false, autoSummaryDelayMs: 300_000 });
    await agent.createSession();
    expect(prompts[1]).toBe(prompts[0]);
  });

  it("clearing the instructions returns to the exact built-in prompt", async () => {
    const plain = await setup();
    const { agent, prompts } = await setup({ instructions: "Be brief." });
    await plain.agent.createSession();
    await agent.updateAgentSettings({ instructions: "" });
    await agent.createSession();
    expect(prompts[0]).toBe(plain.prompts[0]);
  });
});

describe("owner instructions settings", () => {
  it("refuses text over the byte limit and keeps the old text", async () => {
    const { agent } = await setup({ instructions: "Be brief." });
    const tooLong = "家".repeat(Math.floor(MAX_AGENT_INSTRUCTIONS_BYTES / 3) + 1);
    await expect(agent.updateAgentSettings({ instructions: tooLong })).rejects.toMatchObject({ status: 400 });
    expect(agent.getAgentSettings().instructions).toBe("Be brief.");
  });

  it("counts bytes, not characters", () => {
    expect(checkAgentInstructions("a".repeat(MAX_AGENT_INSTRUCTIONS_BYTES)).ok).toBe(true);
    expect(checkAgentInstructions("a".repeat(MAX_AGENT_INSTRUCTIONS_BYTES + 1)).ok).toBe(false);
    expect(checkAgentInstructions("家".repeat(1_365)).ok).toBe(true);
    expect(checkAgentInstructions("家".repeat(1_366)).ok).toBe(false);
    expect(checkAgentInstructions(42)).toMatchObject({ ok: false });
    expect(checkAgentInstructions("a\u0000b")).toMatchObject({ ok: false });
  });

  it("normalizes line endings and surrounding space", () => {
    expect(checkAgentInstructions("  one\r\ntwo\r  ")).toEqual({ ok: true, value: "one\ntwo" });
  });

  it("keeps what fits when text already on disk is too long", () => {
    const clamped = clampStoredInstructions("家".repeat(2_000));
    expect(Buffer.byteLength(clamped, "utf8")).toBeLessThanOrEqual(MAX_AGENT_INSTRUCTIONS_BYTES);
    expect(clamped.length).toBeGreaterThan(1_300);
  });

  it("persists across a restart and reports its source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-instructions-store-"));
    const settingsPath = join(dir, "config.json");
    const first = await setup({ settingsPath });
    expect(first.agent.getAgentSettings().sources.instructions).toBe("default");
    await first.agent.updateAgentSettings({ instructions: "Reply in Chinese." });
    expect(first.agent.getAgentSettings().sources.instructions).toBe("configured");
    const second = await setup({ settingsPath });
    expect(second.agent.getAgentSettings().instructions).toBe("Reply in Chinese.");
    await second.agent.createSession();
    expect(second.prompts[0]).toContain("Reply in Chinese.");
  });

  it("audits a change by hash and size, never the text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-instructions-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { agent } = await setup({ auditPath });
    await agent.updateAgentSettings({ instructions: "my private note about the NAS" });
    const raw = await readFile(auditPath, "utf8");
    expect(raw).not.toContain("private note");
    const entry = JSON.parse(raw.trim().split("\n").at(-1)!) as Record<string, unknown>;
    expect(entry.method).toBe("settings.instructions");
    expect(entry.parameterHash).toBe(hashParameters({ instructions: "my private note about the NAS" }));
  });
});
