import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryCredentialStore,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createThebeProduct } from "../../product/service.ts";
import type { ContainerInfoProvider } from "../../providers/index.ts";
import { PI_RUNTIME_ID } from "../types.ts";
import { loadPiSdk } from "./load-pi.ts";
import { createPiCodingAgentRuntime } from "./pi-coding-agent-runtime.ts";

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
    await expect(product.ask("hi")).resolves.toMatchObject({
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
    const again = await resumed.ask("again", meta.thebeSessionId);
    expect(again.text).toBe("resumed");
    const listed = await second.runtime.listSessions();
    expect(listed.some((row) => row.runtimeSessionId === meta.runtimeSessionId)).toBe(
      true,
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
    await product.ask("one");
    const parentMessages = product.messages().map((m) => m.text);
    const parentId = product.lastThebeSessionId()!;
    await product.fork(parentId);
    await product.ask("two");
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
      fauxAssistantMessage("summary"),
      fauxAssistantMessage("after-compact"),
    ]);
    const product = createThebeProduct({
      runtime,
      provider: emptyProvider(),
    });
    await product.ask("one");
    await product.compact();
    const continued = await product.ask("two");
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
    await product.ask("say exported-turn");
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
    const src = await readFile(
      new URL("./pi-coding-agent-runtime.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/function refresh/);
    expect(src).not.toContain("refresh_token");
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
    await product.ask("hi");
    const names = await readdir(join(dir, "meta"));
    const raw = await readFile(join(dir, "meta", names[0]!), "utf8");
    expect(raw).not.toContain("secret-turn");
    expect(raw).not.toContain("transcript");
    expect(raw).not.toContain("refresh_token");
  });
});
