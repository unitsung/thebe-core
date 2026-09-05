import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentText,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createThebeAgent } from "./ask.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";

function emptyProvider(): ContainerInfoProvider {
  return {
    listContainers: async () => [],
    inspectContainer: async () => {
      throw new Error("inspect not used");
    },
    getContainerLogs: async () => {
      throw new Error("logs not used");
    },
    getStatusSummary: async () => {
      throw new Error("summary not used");
    },
  };
}

function thebeWithFaux(
  provider: ContainerInfoProvider = emptyProvider(),
  extras: {
    auditPath?: string;
    now?: () => Date;
    callerId?: string;
  } = {},
) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const thebe = createThebeAgent({
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    provider,
    ...extras,
  });
  return { faux, thebe };
}

describe("Ask", () => {
  it("returns the Pi agent's reply", async () => {
    const { faux, thebe } = thebeWithFaux();
    faux.setResponses([fauxAssistantMessage("pong")]);
    await expect(thebe.ask("ping")).resolves.toBe("pong");
  });

  it("runs tools sequentially", () => {
    const { thebe } = thebeWithFaux();
    expect(thebe.toolExecution()).toBe("sequential");
  });

  it("registers only the four read-only container tools", async () => {
    const { thebe } = thebeWithFaux();
    expect(thebe.toolNames()).toEqual([
      "container.list",
      "container.inspect",
      "container.logs",
      "container.status_summary",
    ]);
    expect(thebe.toolNames()).not.toContain("bash");
    expect(thebe.toolNames()).not.toContain("read");
    expect(thebe.toolNames()).not.toContain("edit");
    expect(thebe.toolNames()).not.toContain("write");
    expect(thebe.toolNames()).not.toContain("container.start");
  });

  it("refuses bash when the model tries to call it", async () => {
    const { faux, thebe } = thebeWithFaux();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })]),
      fauxAssistantMessage("done"),
    ]);
    const reply = await thebe.ask("list files");
    expect(reply).toBe("done");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.toolName).toBe("bash");
    }
  });

  it("Ask inspect redacts secret env in the tool result", async () => {
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      inspectContainer: async () => ({
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        config: { env: ["NODE_ENV=production", "API_TOKEN=s3cret"] },
      }),
    };
    const { faux, thebe } = thebeWithFaux(provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("inspected"),
    ]);
    await expect(thebe.ask("inspect nginx")).resolves.toBe("inspected");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      const text = contentText(toolResult.content);
      expect(text).toContain("API_TOKEN=***REDACTED***");
      expect(text).toContain("NODE_ENV=production");
      expect(text).not.toContain("s3cret");
    }
  });

  it("Ask logs redacts tokens and truncates with the spec marker", async () => {
    const hex = "a".repeat(40);
    const lines = [
      ...Array.from({ length: 201 }, (_, i) => `L${i}`),
      `token=sk-live-abc123 hex=${hex}`,
    ];
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      getContainerLogs: async () => lines.join("\n"),
    };
    const { faux, thebe } = thebeWithFaux(provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.logs", { id: "abc123" }),
      ]),
      fauxAssistantMessage("logged"),
    ]);
    await expect(thebe.ask("show logs")).resolves.toBe("logged");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      const text = contentText(toolResult.content);
      expect(text).toContain("[... truncated ...]");
      expect(text).toContain("token=***REDACTED***");
      expect(text).toContain("hex=***REDACTED***");
      expect(text).not.toContain("sk-live-abc123");
    }
  });

  it("refuses container.start when the model tries to call it", async () => {
    const { faux, thebe } = thebeWithFaux();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("container.start", { id: "abc123" })]),
      fauxAssistantMessage("stopped"),
    ]);
    await expect(thebe.ask("start nginx")).resolves.toBe("stopped");
    const toolResult = thebe.messages().find((m) => m.role === "toolResult");
    expect(toolResult?.role).toBe("toolResult");
    if (toolResult?.role === "toolResult") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.toolName).toBe("container.start");
    }
  });

  it("refuses the 1001st container.logs call in the same day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      getContainerLogs: async () => "ok",
    };
    const { faux, thebe } = thebeWithFaux(provider, {
      auditPath,
      now: () => new Date("2026-09-05T12:00:00Z"),
      callerId: "agent-1",
    });
    for (let i = 0; i < 1000; i++) {
      faux.appendResponses([
        fauxAssistantMessage([fauxToolCall("container.logs", { id: "abc123" })]),
        fauxAssistantMessage("ok"),
      ]);
      await thebe.ask("logs");
    }
    faux.appendResponses([
      fauxAssistantMessage([fauxToolCall("container.logs", { id: "abc123" })]),
      fauxAssistantMessage("capped"),
    ]);
    await expect(thebe.ask("logs again")).resolves.toBe("capped");
    const toolResults = thebe
      .messages()
      .filter((m) => m.role === "toolResult");
    const last = toolResults.at(-1);
    expect(last?.role).toBe("toolResult");
    if (last?.role === "toolResult") {
      expect(last.isError).toBe(true);
    }
  });

  it("appends JSONL audit without raw secrets after success and refusal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const provider: ContainerInfoProvider = {
      ...emptyProvider(),
      inspectContainer: async () => ({
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        config: { env: ["API_TOKEN=s3cret"] },
      }),
    };
    const { faux, thebe } = thebeWithFaux(provider, {
      auditPath,
      now: () => new Date("2026-09-05T12:00:00Z"),
      callerId: "agent-1",
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("inspected"),
      fauxAssistantMessage([fauxToolCall("container.start", { id: "abc123" })]),
      fauxAssistantMessage("denied"),
    ]);
    await thebe.ask("inspect nginx");
    await thebe.ask("start nginx");
    const lines = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const inspectLine = lines.find((row) => row.method === "container.inspect");
    expect(inspectLine).toMatchObject({
      timestamp: "2026-09-05T12:00:00.000Z",
      method: "container.inspect",
      redactionFired: true,
    });
    expect(inspectLine).toHaveProperty("parameterHash");
    expect(inspectLine).toHaveProperty("responseBytes");
    expect(inspectLine).toHaveProperty("budgetConsumed");
    const startLine = lines.find((row) => row.method === "container.start");
    expect(startLine).toMatchObject({
      timestamp: "2026-09-05T12:00:00.000Z",
      method: "container.start",
      budgetConsumed: 0,
      redactionFired: false,
    });
    expect(startLine).toHaveProperty("parameterHash");
    expect(startLine).toHaveProperty("responseBytes");
    const dumped = JSON.stringify(lines);
    expect(dumped).not.toContain("s3cret");
    expect(dumped).not.toContain("API_TOKEN=");
  });
});



