import { describe, expect, it } from "vitest";
import {
  BUILTIN_SUBAGENT_PROFILES,
  RESERVED_SUBAGENT_TOOLS,
} from "./profiles.ts";

describe("built-in subagent profiles", () => {
  it("keeps the built-in profiles and control-plane exclusions colocated", () => {
    expect(Object.keys(BUILTIN_SUBAGENT_PROFILES)).toEqual([
      "diagnostics",
      "log-analyzer",
      "network-prober",
      "goal-worker",
      "goal-reviewer",
    ]);
    expect(RESERVED_SUBAGENT_TOOLS).toContain("run_subagent");
    expect(BUILTIN_SUBAGENT_PROFILES.diagnostics?.tools).toContain("container.list");
  });

  it("gives every built-in the explicit response and file-output policy", () => {
    for (const profile of Object.values(BUILTIN_SUBAGENT_PROFILES)) {
      expect(profile.systemPrompt).toContain("Return ordinary answers and research results to the parent conversation buffer by default.");
      expect(profile.systemPrompt).toContain("Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files.");
      expect(profile.systemPrompt).toContain("Never create output.md, docs files, or any other file merely to display an answer.");
      expect(profile.systemPrompt).toContain("outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output.");
    }
  });

  it("gives coding subagents the native search policy", () => {
    for (const name of ["goal-worker", "goal-reviewer"]) {
      const prompt = BUILTIN_SUBAGENT_PROFILES[name]!.systemPrompt;
      expect(prompt).toContain("Use Pi's native find for filename searches and Pi's native grep for content searches.");
      expect(prompt).toContain("Do not use bash or rg for ordinary searches.");
      expect(prompt).toContain("Use bash only when the task genuinely requires executing a shell command.");
    }
  });
});
