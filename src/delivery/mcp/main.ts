#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapThebe } from "../../app/bootstrap.ts";
import { createMcpStdioServer, serveMcpStdio } from "./stdio.ts";

const here = dirname(fileURLToPath(import.meta.url));
const app = await bootstrapThebe({ fromDir: here });
const controller = new AbortController();
let cleaned = false;
let force: NodeJS.Timeout | undefined;

async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  await app.agent.quiesce().catch(() => {});
  await app.disposeSandboxVms().catch(() => {});
}

function stop(): void {
  force ??= setTimeout(() => process.exit(1), 8_000);
  force.unref?.();
  controller.abort();
  process.stdin.destroy();
  void cleanup();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await serveMcpStdio({
    server: createMcpStdioServer({ agent: app.agent, version: app.version }),
    input: process.stdin,
    output: process.stdout,
    signal: controller.signal,
  });
} catch (error) {
  if (!controller.signal.aborted) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} finally {
  force ??= setTimeout(() => process.exit(1), 8_000);
  force.unref?.();
  await cleanup();
  if (force) clearTimeout(force);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
