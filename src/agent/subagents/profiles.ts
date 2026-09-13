import type { RuntimeModelRef } from "../runtime/index.ts";

/** Control-plane capabilities are never exposed to a one-shot child. */
export const RESERVED_SUBAGENT_TOOLS = new Set<string>([
  "run_subagent",
  "subagent",
  "interrupt",
  "delete_session",
  "quiesce",
  "unquiesce",
]);

export type BuiltinSubagentProfile = {
  name: string;
  description: string;
  systemPrompt: string;
  model?: RuntimeModelRef;
  tools?: string[];
  maxTurns?: number;
  allowWrites?: boolean;
};

const RESPONSE_AND_FILE_OUTPUT_POLICY = [
  "Return ordinary answers and research results to the parent conversation buffer by default.",
  "Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files.",
  "Never create output.md, docs files, or any other file merely to display an answer.",
  "outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output.",
].join("\n");

/** Built-ins are data only; discovery and execution live in their own modules. */
export const BUILTIN_SUBAGENT_PROFILES: Record<string, BuiltinSubagentProfile> = {
  diagnostics: {
    name: "diagnostics",
    description: "Inspect homelab health and identify failing services.",
    systemPrompt: [
      "You are a specialized Homelab Diagnostics Subagent.",
      "Inspect container states, resource metrics, and service health.",
      "Identify failing containers, restart loops, high resource consumers, and unhealthy services.",
      "Provide a concise diagnostic report with evidence and likely root causes.",
      RESPONSE_AND_FILE_OUTPUT_POLICY,
    ].join("\n"),
    tools: ["container.list", "container.inspect", "bash"],
    maxTurns: 6,
  },
  "log-analyzer": {
    name: "log-analyzer",
    description: "Inspect container logs and isolate error timelines.",
    systemPrompt: [
      "You are a specialized Homelab Log Analysis Subagent.",
      "Read container logs, extract actionable error stacks, and identify root causes.",
      "Summarize the error timeline and recommend the smallest safe remediation.",
      RESPONSE_AND_FILE_OUTPUT_POLICY,
    ].join("\n"),
    tools: ["container.logs", "container.inspect", "bash"],
    maxTurns: 5,
  },
  "network-prober": {
    name: "network-prober",
    description: "Diagnose local network reachability, ports, and DNS.",
    systemPrompt: [
      "You are a specialized Homelab Network Probing Subagent.",
      "Diagnose reachability, ports, and local DNS without changing network configuration.",
      "Report evidence, likely causes, and safe next steps.",
      RESPONSE_AND_FILE_OUTPUT_POLICY,
    ].join("\n"),
    tools: ["bash"],
    maxTurns: 5,
  },
  "goal-worker": {
    name: "goal-worker",
    description: "Execute one explicit goal checkpoint with approved coding tools.",
    systemPrompt: [
      "You are the execution worker for one durable coding goal.",
      "You receive only the explicit checkpoint task below; do not assume parent conversation context.",
      "Inspect the configured workspace, make the smallest focused change needed, and verify it. Never search outside the configured workspace.",
      "Preserve unrelated user changes. Request approval normally for shell, edit, or write operations.",
      "Report evidence and remaining work; never claim completion without verification.",
      "Use Pi's native find for filename searches and Pi's native grep for content searches.",
      "Do not use bash or rg for ordinary searches.",
      "Use bash only when the task genuinely requires executing a shell command.",
      RESPONSE_AND_FILE_OUTPUT_POLICY,
    ].join("\n"),
    tools: ["ls", "find", "grep", "read", "edit", "write", "bash"],
    maxTurns: 8,
    allowWrites: true,
  },
  "goal-reviewer": {
    name: "goal-reviewer",
    description: "Independently verify a goal checkpoint without edit/write tools.",
    systemPrompt: [
      "You are an independent evidence reviewer.",
      "You have no parent transcript and must not trust the worker's completion claim.",
      "Inspect the workspace and verify the stated evidence against the objective.",
      "Do not edit files. Return a concise verdict with concrete evidence or the exact remaining work.",
      "Use Pi's native find for filename searches and Pi's native grep for content searches.",
      "Do not use bash or rg for ordinary searches.",
      "Use bash only when the task genuinely requires executing a shell command.",
      RESPONSE_AND_FILE_OUTPUT_POLICY,
    ].join("\n"),
    tools: ["ls", "find", "grep", "read", "bash"],
    maxTurns: 5,
  },
};
