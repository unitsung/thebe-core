import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createThebeProduct } from "../product/service.ts";
import { createFakeRuntime } from "../runtime/fake-runtime.ts";
import { runCliCommand } from "./commands.ts";
import type { ContainerInfoProvider } from "../providers/index.ts";

const provider: ContainerInfoProvider = {
  async listContainers() {
    return [];
  },
  async inspectContainer() {
    throw new Error("unused");
  },
  async getContainerLogs() {
    throw new Error("unused");
  },
  async getStatusSummary() {
    return {
      totalContainers: 0,
      runningContainers: 0,
      pausedContainers: 0,
      exitedContainers: 0,
      lastUpdated: 0,
    };
  },
};

describe("runCliCommand", () => {
  it("creates, lists, prompts, exports through product", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "pong" }]);
    const dir = await mkdtemp(join(tmpdir(), "thebe-cli-"));
    const product = createThebeProduct({
      runtime: fake.runtime,
      provider,
      productStoreDir: dir,
    });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    expect(
      await runCliCommand(
        product,
        { kind: "session-create", title: "demo" },
        { log },
      ),
    ).toBe(0);
    const id = lines.at(-1)!;
    expect(id.length).toBeGreaterThan(8);

    lines.length = 0;
    expect(await runCliCommand(product, { kind: "session-list" }, { log })).toBe(
      0,
    );
    expect(lines.some((line) => line.includes(id))).toBe(true);

    lines.length = 0;
    expect(
      await runCliCommand(
        product,
        { kind: "print", text: "ping", sessionId: id },
        { log },
      ),
    ).toBe(0);
    expect(lines.at(-1)).toBe("pong");

    const out = join(dir, "export-out");
    lines.length = 0;
    expect(
      await runCliCommand(
        product,
        {
          kind: "session-export",
          sessionId: id,
          format: "jsonl",
          out,
        },
        { log },
      ),
    ).toBe(0);
    const jsonl = await readFile(`${out}.jsonl`, "utf8");
    expect(jsonl.length).toBeGreaterThan(0);
  });

  it("compacts and forks", async () => {
    const fake = createFakeRuntime();
    fake.queueTurns([{ kind: "text", text: "one" }]);
    const product = createThebeProduct({ runtime: fake.runtime, provider });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    await runCliCommand(product, { kind: "session-create" }, { log });
    const id = lines.at(-1)!;
    await runCliCommand(
      product,
      { kind: "print", text: "hi", sessionId: id },
      { log },
    );
    expect(
      await runCliCommand(
        product,
        { kind: "session-compact", sessionId: id },
        { log },
      ),
    ).toBe(0);
    lines.length = 0;
    expect(
      await runCliCommand(product, { kind: "session-fork", sessionId: id }, { log }),
    ).toBe(0);
    expect(lines.at(-1)).not.toBe(id);
    expect(fake.compactCalls()).toBe(1);
  });
});
