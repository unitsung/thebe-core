import { mkdtemp } from "node:fs/promises";
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
import { createThebeAgent } from "../ask/ask.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";
import { parseRunJsonl } from "./index.ts";

const CANARY = "canary-s3cret";

describe("session export", () => {
  it("JSONL round-trips transcript content and HTML omits the pre-redaction secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-export-"));
    const provider: ContainerInfoProvider = {
      listContainers: async () => [],
      inspectContainer: async () => ({
        id: "abc123",
        name: "nginx",
        image: "nginx:1.27",
        state: "running",
        config: { env: [`API_TOKEN=${CANARY}`] },
      }),
      getContainerLogs: async () => {
        throw new Error("logs not used");
      },
      getStatusSummary: async () => {
        throw new Error("summary not used");
      },
    };
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const thebe = createThebeAgent({
      models,
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      provider,
      runStoreDir: dir,
      now: () => new Date("2026-09-05T12:00:00Z"),
    });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("container.inspect", { id: "abc123" }),
      ]),
      fauxAssistantMessage("inspected"),
    ]);
    await expect(thebe.ask("inspect nginx")).resolves.toBe("inspected");
    const inMemory = thebe.messages();
    expect(inMemory.some((m) => m.role === "toolResult")).toBe(true);
    const exported = await thebe.exportLastRun();
    const parsed = parseRunJsonl(exported.jsonl);
    expect(parsed.map(messageContent)).toEqual(inMemory.map(messageContent));
    expect(exported.html).toContain("<pre>");
    expect(exported.html).not.toMatch(/<script/i);
    expect(exported.html).not.toContain(CANARY);
    expect(exported.jsonl).not.toContain(CANARY);
    const toolResult = inMemory.find((m) => m.role === "toolResult");
    if (toolResult?.role === "toolResult") {
      expect(contentText(toolResult.content)).toContain("***REDACTED***");
    }
  });
});

function messageContent(message: {
  role: string;
  content?: unknown;
  toolName?: string;
}): unknown {
  return {
    role: message.role,
    toolName: "toolName" in message ? message.toolName : undefined,
    content: message.content,
  };
}
