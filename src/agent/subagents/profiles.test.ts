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
      "goal-observer",
      "goal-reviewer",
      "ticket-worker",
      "ticket-observer",
      "ticket-reviewer",
    ]);
    expect(RESERVED_SUBAGENT_TOOLS).toContain("run_subagent");
    expect(BUILTIN_SUBAGENT_PROFILES.diagnostics?.tools).toContain(
      "container_list"
    );
  });

  it("gives the observer only tools that cannot change anything", () => {
    const observer = BUILTIN_SUBAGENT_PROFILES["goal-observer"]!;
    expect(observer.allowWrites).toBeFalsy();
    for (const writing of ["edit", "write", "bash"]) {
      expect(observer.tools).not.toContain(writing);
    }
    // goal_report only records the worker's report for its own Goal; it changes nothing in the world.
    expect(observer.tools).toEqual([
      "ls",
      "find",
      "grep",
      "read",
      "goal_report",
    ]);
  });

  it("gives every built-in the explicit response and file-output policy", () => {
    for (const profile of Object.values(BUILTIN_SUBAGENT_PROFILES)) {
      expect(profile.systemPrompt).toContain(
        "Return ordinary answers and research results to the parent conversation buffer by default."
      );
      expect(profile.systemPrompt).toContain(
        "Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files."
      );
      expect(profile.systemPrompt).toContain(
        "Never create output.md, docs files, or any other file merely to display an answer."
      );
      expect(profile.systemPrompt).toContain(
        "outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output."
      );
    }
  });

  it("gives coding subagents the native search policy", () => {
    for (const name of ["goal-worker", "goal-reviewer"]) {
      const prompt = BUILTIN_SUBAGENT_PROFILES[name]!.systemPrompt;
      expect(prompt).toContain(
        "Use Pi's native find for filename searches and Pi's native grep for content searches."
      );
      expect(prompt).toContain("Do not use bash or rg for ordinary searches.");
      expect(prompt).toContain(
        "Use bash only when the task genuinely requires executing a shell command."
      );
    }
  });

  it("gives a Ticket's executor every home tool and no shell or file editing, and its observers only the ones that change nothing", () => {
    const worker = BUILTIN_SUBAGENT_PROFILES["ticket-worker"]!;
    // `*` is every home tool; which writes it may make is the permission layer's call, under the Mandate.
    expect(worker.tools).toContain("*");
    expect(worker.tools).toContain("goal_report");
    expect(worker.allowWrites).toBe(true);
    for (const forbidden of ["bash", "edit", "write"]) {
      expect(worker.tools).not.toContain(forbidden);
    }
    const observer = BUILTIN_SUBAGENT_PROFILES["ticket-observer"]!;
    expect(observer.readOnly).toBe(true);
    expect(observer.allowWrites).toBeFalsy();
    for (const forbidden of ["bash", "edit", "write", "goal_report"]) {
      expect(observer.tools).not.toContain(forbidden);
    }
    const reviewer = BUILTIN_SUBAGENT_PROFILES["ticket-reviewer"]!;
    expect(reviewer.readOnly).toBe(true);
    expect(reviewer.allowWrites).toBeFalsy();
    expect(reviewer.tools).toContain("*");
    for (const forbidden of ["bash", "edit", "write", "goal_report"]) {
      expect(reviewer.tools).not.toContain(forbidden);
    }
  });

  it("puts a Ticket's tools in front of its executor, so no turn of its budget goes to finding them", () => {
    for (const name of ["ticket-worker", "ticket-reviewer"]) {
      const profile = BUILTIN_SUBAGENT_PROFILES[name]!;
      expect(profile.directTools).toBe(true);
    }
    // The budget is the one every Goal worker and reviewer has, not a number picked for this profile.
    expect(BUILTIN_SUBAGENT_PROFILES["ticket-worker"]!.maxTurns).toBe(
      BUILTIN_SUBAGENT_PROFILES["goal-worker"]!.maxTurns
    );
    expect(BUILTIN_SUBAGENT_PROFILES["ticket-reviewer"]!.maxTurns).toBe(
      BUILTIN_SUBAGENT_PROFILES["goal-reviewer"]!.maxTurns
    );
  });
});
