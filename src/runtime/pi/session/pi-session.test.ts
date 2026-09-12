import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createThebeProduct } from "../../../product/service.ts";
import type { ContainerInfoProvider } from "../../../providers/index.ts";
import { PI_RUNTIME_ID } from "../../types.ts";
import { loadPiSdk } from "../sdk/load-pi.ts";
import { createPiCodingAgentRuntime } from "../pi-coding-agent-runtime.ts";

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

async function piWithFaux(sessionDir?: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const { ModelRuntime } = await loadPiSdk();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.getModel().provider, "test-key");
  const runtime = await createPiCodingAgentRuntime({
    cwd: process.cwd(),
    sessionDir,
    inMemory: !sessionDir,
    modelRuntime,
    model: faux.getModel(),
    agentDir: sessionDir ? join(sessionDir, "agent") : undefined,
  });
  return { faux, runtime, modelRuntime };
}

describe("PiCodingAgentRuntime sessions", () => {
  it("create, persist, resume in a new runtime instance", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-sess-"));
    const first = await piWithFaux(dir);
    first.faux.setResponses([fauxAssistantMessage("hello-from-parent")]);
    const product = createThebeProduct({
      runtime: first.runtime,
      provider: emptyProvider(),
      productStoreDir: join(dir, "meta"),
    });
    await expect(product.send("hi")).resolves.toMatchObject({
      text: "hello-from-parent",
    });
    const meta = (await product.listSessions())[0]!;
    expect(meta.runtimeId).toBe(PI_RUNTIME_ID);

    const second = await piWithFaux(dir);
    second.faux.setResponses([fauxAssistantMessage("resumed")]);
    const resumed = createThebeProduct({
      runtime: second.runtime,
      provider: emptyProvider(),
      productStoreDir: join(dir, "meta"),
    });
    await resumed.resume(meta.thebeSessionId);
    const again = await resumed.send("again", meta.thebeSessionId);
    expect(again.text).toBe("resumed");
    const listed = await second.runtime.listSessions();
    expect(listed.some((row) => row.runtimeSessionId === meta.runtimeSessionId)).toBe(
      true,
    );
  });

  it("deletes the persisted Pi transcript with the Thebe session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-delete-"));
    const { faux, runtime } = await piWithFaux(dir);
    faux.setResponses([fauxAssistantMessage("delete-ready")]);
    const product = createThebeProduct({
      runtime,
      provider: emptyProvider(),
      productStoreDir: join(dir, "meta"),
    });
    const meta = await product.createSession({ title: "delete-real-session" });
    await product.send("persist this", meta.thebeSessionId);
    expect((await readdir(dir)).some((name) => name.endsWith(".jsonl"))).toBe(true);

    await product.deleteSession(meta.thebeSessionId);

    expect((await readdir(dir)).some((name) => name.endsWith(".jsonl"))).toBe(false);
    expect(await runtime.listSessions()).toHaveLength(0);
  });

  it("reports the effective thinking level and restores it after resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-thinking-"));
    const first = await piWithFaux(dir);
    const model = first.faux.getModel() as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    model.reasoning = true;
    model.thinkingLevelMap = {
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    };
    const product = createThebeProduct({
      runtime: first.runtime,
      provider: emptyProvider(),
      productStoreDir: join(dir, "meta"),
    });
    const created = await product.createSession();
    first.faux.setResponses([fauxAssistantMessage("seed")]);
    await product.send("seed", created.thebeSessionId);
    await expect(product.setThinkingLevel(created.thebeSessionId, "high"))
      .resolves.toMatchObject({ level: "high" });

    const second = await piWithFaux(dir);
    const resumedModel = second.faux.getModel() as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    resumedModel.reasoning = true;
    resumedModel.thinkingLevelMap = model.thinkingLevelMap;
    const registeredResumedModel = second.modelRuntime.getModel(
      "faux",
      second.faux.getModel().id,
    ) as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    registeredResumedModel.reasoning = true;
    registeredResumedModel.thinkingLevelMap = model.thinkingLevelMap;
    const resumed = createThebeProduct({
      runtime: second.runtime,
      provider: emptyProvider(),
      productStoreDir: join(dir, "meta"),
    });
    await resumed.resume(created.thebeSessionId);
    await expect(resumed.getThinkingInfo(created.thebeSessionId))
      .resolves.toMatchObject({ level: "high" });
  });

  it("forwards Pi thinking and tool events through the product log", async () => {
    const { faux, runtime } = await piWithFaux();
    const model = faux.getModel() as unknown as {
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    };
    model.reasoning = true;
    model.thinkingLevelMap = { high: "high" };
    faux.setResponses([
      fauxAssistantMessage([
        fauxThinking("inspect the workspace"),
        fauxToolCall("container.list", {}, { id: "call_container_list" }),
      ]),
      fauxAssistantMessage("tools are visible"),
    ]);
    const product = createThebeProduct({
      runtime,
      provider: emptyProvider(),
    });
    const created = await product.createSession();
    const events: string[] = [];
    product.subscribeLog(created.thebeSessionId, (event) => {
      events.push(event.type);
    });

    await product.send("list containers", created.thebeSessionId);

    expect(events).toEqual(
      expect.arrayContaining([
        "thinking_delta",
        "tool_start",
        "tool_end",
        "text_delta",
      ]),
    );
  });

  it("fork does not mutate parent messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-fork-"));
    const { faux, runtime } = await piWithFaux(dir);
    faux.setResponses([
      fauxAssistantMessage("parent-only"),
      fauxAssistantMessage("child-only"),
    ]);
    const product = createThebeProduct({
      runtime,
      provider: emptyProvider(),
      productStoreDir: join(dir, "meta"),
    });
    await product.send("one");
    const parentMessages = product.messages().map((m) => m.text);
    const parentId = product.lastThebeSessionId()!;
    await product.fork(parentId);
    await product.send("two");
    const parentMeta = (await product.listSessions()).find(
      (row) => row.thebeSessionId === parentId,
    )!;
    const parentSession = await runtime.resumeSession(
      parentMeta.runtimeSessionId,
      {
        customTools: [],
      },
    );
    expect(parentSession.messages().map((m) => m.text)).toEqual(parentMessages);
  });

  it("compact then continue", async () => {
    const { faux, runtime } = await piWithFaux();
    faux.setResponses([
      fauxAssistantMessage("before-compact"),
      fauxAssistantMessage("after-compact"),
    ]);
    const product = createThebeProduct({
      runtime,
      provider: emptyProvider(),
    });
    await product.send("one");
    await expect(product.compact()).rejects.toThrow(/Nothing to compact/i);
    const continued = await product.send("two");
    expect(continued.text.length).toBeGreaterThan(0);
    expect(product.messages().length).toBeGreaterThan(0);
  });

  it("JSONL and HTML export include session turns", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-export-"));
    const { faux, runtime } = await piWithFaux(dir);
    faux.setResponses([fauxAssistantMessage("exported-turn")]);
    const product = createThebeProduct({
      runtime,
      provider: emptyProvider(),
    });
    await product.send("say exported-turn");
    const cwd = process.cwd();
    const before = new Set(await readdir(cwd));
    const exported = await product.exportSession();
    expect(exported.jsonl).toContain("exported-turn");
    expect(exported.html).toMatch(/<!doctype html/i);
    const b64 = exported.html.match(/[A-Za-z0-9+/]{80,}={0,2}/)?.[0] ?? "";
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain("exported-turn");
    const added = (await readdir(cwd)).filter((name) => !before.has(name));
    expect(
      added.filter(
        (name) =>
          name.endsWith(".jsonl") ||
          name.endsWith(".html") ||
          name.startsWith("session-") ||
          name.startsWith("pi-session-"),
      ),
    ).toEqual([]);
  });

  it("API key and OAuth go through ModelRuntime, Thebe has no refresh", async () => {
    const { runtime, modelRuntime } = await piWithFaux();
    const setSpy = vi.spyOn(modelRuntime, "setRuntimeApiKey");
    const loginSpy = vi.spyOn(modelRuntime, "login").mockResolvedValue({
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
    });
    await runtime.auth().setApiKey("faux", "sk-test");
    expect(setSpy).toHaveBeenCalledWith("faux", "sk-test");
    await runtime.auth().loginOAuth("faux", { type: "oauth" });
    expect(loginSpy).toHaveBeenCalled();
    const src = [
      await readFile(
        new URL("../pi-coding-agent-runtime.ts", import.meta.url),
        "utf8",
      ),
      await readFile(new URL("../auth/oauth.ts", import.meta.url), "utf8"),
    ].join("\n");
    expect(src).not.toMatch(/function refresh/);
    expect(src).not.toContain("refresh_token");
  });

  it("authorizeOAuth surfaces the provider auth URL without blocking", async () => {
    const { runtime, modelRuntime } = await piWithFaux();
    const loginSpy = vi
      .spyOn(modelRuntime, "login")
      .mockImplementation(async (...args: unknown[]) => {
        const interaction = args[2] as {
          notify: (event: {
            type: string;
            url?: string;
            instructions?: string;
          }) => void;
        };
        interaction.notify({
          type: "auth_url",
          url: "https://example.com/oauth/authorize",
          instructions: "open me",
        });
        return {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: Date.now() + 60_000,
        };
      });
    const result = await runtime
      .auth()
      .authorizeOAuth("unauthorized-provider");
    expect(result).toMatchObject({
      pending: true,
      url: "https://example.com/oauth/authorize",
    });
    expect(loginSpy).toHaveBeenCalled();
    await expect(
      runtime.auth().submitOAuthCallback("unauthorized-provider", "code"),
    ).rejects.toThrow("unknown OAuth authorization");
  });

  it("submitOAuthCallback feeds the prompt and waits for login to finish", async () => {
    const { runtime, modelRuntime } = await piWithFaux();
    let received = "";
    vi.spyOn(modelRuntime, "login").mockImplementation(
      async (...args: unknown[]) => {
        const interaction = args[2] as {
          prompt: () => Promise<string>;
          notify: (event: { type: string; url?: string }) => void;
        };
        interaction.notify({
          type: "auth_url",
          url: "https://example.com/oauth/google",
        });
        received = await interaction.prompt();
        return {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: Date.now() + 60_000,
        };
      },
    );
    const pending = await runtime.auth().authorizeOAuth("google");
    expect(pending).toMatchObject({
      pending: true,
      url: "https://example.com/oauth/google",
    });
    await runtime.auth().submitOAuthCallback("google", "pasted-from-tui");
    expect(received).toBe("pasted-from-tui");
  });

  it("product metadata files omit transcript payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thebe-pi-meta-"));
    const { faux, runtime } = await piWithFaux(dir);
    faux.setResponses([fauxAssistantMessage("secret-turn")]);
    const product = createThebeProduct({
      runtime,
      provider: emptyProvider(),
      productStoreDir: join(dir, "meta"),
    });
    await product.send("hi");
    const names = await readdir(join(dir, "meta"));
    const raw = await readFile(join(dir, "meta", names[0]!), "utf8");
    expect(raw).not.toContain("secret-turn");
    expect(raw).not.toContain("transcript");
    expect(raw).not.toContain("refresh_token");
  });
});
