import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { fetchRemoteModels } from "./config.ts";

describe("fetchRemoteModels", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "gpt-4o", name: "GPT-4o" },
              { id: "deepseek-coder", display_name: "DeepSeek Coder" },
            ],
          }),
        );
        return;
      }
      if (url.pathname === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              { name: "llama3.1:latest", model: "llama3.1:latest" },
              { name: "qwen2.5:7b", model: "qwen2.5:7b" },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr !== null) {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("discovers OpenAI format models from /v1/models", async () => {
    const models = await fetchRemoteModels(`http://127.0.0.1:${port}/v1`, "test-key");
    expect(models).not.toBeNull();
    expect(models?.length).toBe(2);
    expect(models?.[0]?.id).toBe("gpt-4o");
    expect(models?.[1]?.id).toBe("deepseek-coder");
    expect(models?.[1]?.name).toBe("DeepSeek Coder");
  });

  it("discovers Ollama format models from /api/tags when /models is missing", async () => {
    const ollamaServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/api/tags") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              { name: "llama3.2:1b", model: "llama3.2:1b" },
              { name: "mistral:latest", model: "mistral:latest" },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const oPort = await new Promise<number>((resolve) => {
      ollamaServer.listen(0, "127.0.0.1", () => {
        const addr = ollamaServer.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    try {
      const models = await fetchRemoteModels(`http://127.0.0.1:${oPort}`);
      expect(models).not.toBeNull();
      expect(models?.map((m) => m.id)).toEqual(["llama3.2:1b", "mistral:latest"]);
    } finally {
      await new Promise<void>((resolve) => ollamaServer.close(() => resolve()));
    }
  });

  it("gracefully returns null when endpoint is unreachable or 404", async () => {
    const models = await fetchRemoteModels("http://127.0.0.1:59999", "dummy", "openai-completions", 500);
    expect(models).toBeNull();
  });
});

describe("isReasoningModel and saveCustomProvider reasoning support", () => {
  it("identifies reasoning models correctly", async () => {
    const { isReasoningModel } = await import("./config.ts");
    expect(isReasoningModel("deepseek-r1")).toBe(true);
    expect(isReasoningModel("deepseek-r1:14b")).toBe(true);
    expect(isReasoningModel("o1-preview")).toBe(true);
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("qwq-32b")).toBe(true);
    expect(isReasoningModel("custom-model", "DeepSeek Reasoner")).toBe(true);
    expect(isReasoningModel("qwen-2.5-coder")).toBe(false);
    expect(isReasoningModel("llama-3.1-8b")).toBe(false);
    expect(isReasoningModel("gpt-4o")).toBe(false);
  });

  it("persists reasoning flag and thinkingLevelMap and sets supportsReasoningEffort", async () => {
    const { saveCustomProvider } = await import("./config.ts");
    const { readFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const tmpAgent = "/tmp/thebe-config-test-" + Date.now();
    process.env.THEBE_AGENT_DIR = tmpAgent;

    try {
      await saveCustomProvider({
        providerId: "test-deepseek-endpoint",
        baseUrl: "https://api.deepseek.com/v1",
        api: "openai-completions",
        apiKey: "sk-test",
        models: [
          { id: "deepseek-r1:14b" },
          { id: "deepseek-chat" },
        ],
      });

      const modelsJson = JSON.parse(await readFile(join(tmpAgent, "models.json"), "utf8"));
      const p = modelsJson.providers["test-deepseek-endpoint"];
      expect(p).toBeDefined();
      expect(p.compat?.supportsReasoningEffort).toBe(true);
      expect(p.compat?.thinkingFormat).toBe("deepseek");

      const r1 = p.models.find((m: any) => m.id === "deepseek-r1:14b");
      const chat = p.models.find((m: any) => m.id === "deepseek-chat");
      expect(r1.thinkingLevelMap).toEqual({
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      });
      expect(chat.reasoning).toBe(false);
    } finally {
      await rm(tmpAgent, { recursive: true, force: true }).catch(() => {});
      delete process.env.THEBE_AGENT_DIR;
    }
  });
});
