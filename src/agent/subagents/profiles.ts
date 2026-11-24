import type { RuntimeModelRef } from "../runtime/index.ts";

/** The turn budget of a Goal's worker and of its reviewer: one number each, shared by every profile that plays the role. */
export const GOAL_WORKER_MAX_TURNS = 8;
export const GOAL_REVIEWER_MAX_TURNS = 5;

/** Control-plane capabilities are never exposed to a one-shot child. */
export const RESERVED_SUBAGENT_TOOLS = new Set<string>([
  "run_subagent",
  "subagent",
  "interrupt",
  "delete_session",
  "quiesce",
  "unquiesce",
  "list_core_events",
  "diagnose_from_events",
]);

export type BuiltinSubagentProfile = {
  name: string;
  description: string;
  systemPrompt: string;
  model?: RuntimeModelRef;
  /** Tool names. `*` stands for every custom (home) tool the session has. */
  tools?: string[];
  maxTurns?: number;
  allowWrites?: boolean;
  /** Takes `*` without the tools that change something (those that ask for approval). */
  readOnly?: boolean;
  /** Its tools are in front of the model from the start, so none of its turns go to looking for them. */
  directTools?: boolean;
};

const RESPONSE_AND_FILE_OUTPUT_POLICY = [
  "Return ordinary answers and research results to the parent conversation buffer by default.",
  "Write files only when the user explicitly asks to create, save, or export a file, or when the coding task itself requires changing repository files.",
  "Never create output.md, docs files, or any other file merely to display an answer.",
  "outputDirectory is only the default destination for explicitly requested non-code artifacts; it is not an instruction to write output.",
].join("\n");

/** Built-ins are data only; discovery and execution live in their own modules. */
export const BUILTIN_SUBAGENT_PROFILES: Record<string, BuiltinSubagentProfile> =
  {
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
      tools: ["container_list", "container_inspect", "bash"],
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
      tools: ["container_logs", "container_inspect", "bash"],
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
      description:
        "Execute one explicit goal checkpoint with approved coding tools.",
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
      tools: [
        "ls",
        "find",
        "grep",
        "read",
        "edit",
        "write",
        "bash",
        "goal_report",
      ],
      maxTurns: GOAL_WORKER_MAX_TURNS,
      allowWrites: true,
    },
    "goal-observer": {
      name: "goal-observer",
      description:
        "Investigate one goal checkpoint read-only and report what it would do, changing nothing.",
      systemPrompt: [
        "You are the observation worker for one durable goal. You can look but not change anything.",
        "You receive only the explicit checkpoint task below; do not assume parent conversation context.",
        "Inspect the configured workspace and the evidence the task names. Never search outside the configured workspace.",
        "Report what you found and exactly what you would do about it, with evidence. Never claim you changed or fixed anything.",
        "Use Pi's native find for filename searches and Pi's native grep for content searches.",
        RESPONSE_AND_FILE_OUTPUT_POLICY,
      ].join("\n"),
      tools: ["ls", "find", "grep", "read", "goal_report"],
      maxTurns: GOAL_WORKER_MAX_TURNS,
    },
    "goal-reviewer": {
      name: "goal-reviewer",
      description:
        "Independently verify a goal checkpoint without edit/write tools.",
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
      maxTurns: GOAL_REVIEWER_MAX_TURNS,
    },
    "ticket-worker": {
      name: "ticket-worker",
      description:
        "Carry out work the person's own rules asked for on their home server, within the authority of a Ticket.",
      systemPrompt: [
        "You look after the person's home server. A change on it matched a rule the person wrote, and you are asked to do what the rule says.",
        "You receive only the task below; do not assume parent conversation context.",
        "You plan the work yourself with the home tools you have. Look at the current state before acting, and again afterwards to check the result.",
        "Your authority is the Mandate in the task. A tool call the system refuses is outside it: stop and report blocked, do not look for another way.",
        "Never claim something is fixed without having looked at its state after your action.",
        RESPONSE_AND_FILE_OUTPUT_POLICY,
      ].join("\n"),
      tools: ["ls", "read", "*", "goal_report"],
      maxTurns: GOAL_WORKER_MAX_TURNS,
      directTools: true,
      allowWrites: true,
    },
    "ticket-observer": {
      name: "ticket-observer",
      description:
        "Inspect the current home-server state for one stuck Ticket without changing anything.",
      systemPrompt: [
        "You are a read-only status observer for work on the person's home server.",
        "You receive only the explicit status-check task below; do not assume parent conversation context.",
        "Look at the current state with the read tools. Do not restart, edit, or change anything.",
        "Report evidence about whether the work is still moving, what is currently true, and the smallest safe next step.",
        RESPONSE_AND_FILE_OUTPUT_POLICY,
      ].join("\n"),
      tools: ["ls", "read", "*"],
      readOnly: true,
      maxTurns: 4,
      directTools: true,
    },
    "ticket-reviewer": {
      name: "ticket-reviewer",
      description:
        "Independently check, from the current state of the home server, that work a Ticket asked for is done.",
      systemPrompt: [
        "You are an independent reviewer of work on the person's home server.",
        "You have no parent transcript and must not trust the worker's claim.",
        "Look at the current state with the home tools and compare it with the objective. You cannot change anything.",
        "Return a concise verdict with the evidence you saw, or exactly what remains.",
        RESPONSE_AND_FILE_OUTPUT_POLICY,
      ].join("\n"),
      tools: ["ls", "read", "*"],
      readOnly: true,
      maxTurns: GOAL_REVIEWER_MAX_TURNS,
      directTools: true,
    },
  };
