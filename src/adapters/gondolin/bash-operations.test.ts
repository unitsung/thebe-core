import { describe, expect, it, vi } from "vitest";
import { createGondolinBashOperations } from "./bash-operations.ts";
import { createFakeMicroVM } from "./runner.test-support.ts";

describe("Gondolin bash backend", () => {
  it("runs commands in the Micro-VM and streams output", async () => {
    const vm = createFakeMicroVM([
      { exitCode: 0, stdout: "hello from vm\n", stderr: "" },
    ]);
    const operations = createGondolinBashOperations({
      workspacePath: "/volume1/docker/app",
      vmProvider: async () => vm.instance,
    });
    const chunks: string[] = [];

    const result = await operations.exec("uname -a", "/volume1/docker/app", {
      onData: (data) => chunks.push(data.toString()),
    });

    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("hello from vm");
    expect(vm.instance.exec).toHaveBeenCalledWith("uname -a");

    await operations.dispose();
    expect(vm.instance.close).toHaveBeenCalled();
  });

  it("starts one VM for many commands and reports failures", async () => {
    const vm = createFakeMicroVM([
      { exitCode: 0, stdout: "first", stderr: "" },
      { exitCode: 2, stdout: "", stderr: "boom" },
    ]);
    const provider = vi.fn(async () => vm.instance);
    const operations = createGondolinBashOperations({
      workspacePath: "/volume1/docker/app",
      vmProvider: provider,
    });
    const chunks: string[] = [];

    await operations.exec("echo first", "/volume1/docker/app", {
      onData: (data) => chunks.push(data.toString()),
    });
    const second = await operations.exec("exit 2", "/volume1/docker/app", {
      onData: (data) => chunks.push(data.toString()),
    });

    expect(provider).toHaveBeenCalledTimes(1);
    expect(second.exitCode).toBe(2);
    expect(chunks.join("")).toContain("boom");
  });
});
