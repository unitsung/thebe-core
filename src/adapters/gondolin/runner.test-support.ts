import { vi } from "vitest";
import type { IMicroVMInstance } from "./runner.ts";

/** Scripted VM double: each `exec` pops the next result. */
export function createFakeMicroVM(
  results: Array<{ exitCode: number; stdout: string; stderr: string }>,
): {
  instance: IMicroVMInstance;
} {
  const queue = [...results];
  const exec = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fake VM ran out of scripted results");
    return next;
  });
  const close = vi.fn(async () => undefined);
  return {
    instance: { exec, close } as unknown as IMicroVMInstance,
  };
}
