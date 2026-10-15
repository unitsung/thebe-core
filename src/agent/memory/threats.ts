import { redactToolOutput } from "../security/redaction.ts";

/**
 * What a memory entry may not say. Memory is sent with every request of every later session, so a
 * poisoned entry persists; Hermes scans what it stores for the same reason (`tools/threat_patterns.py`,
 * scopes "all" and "strict"). This is that list, trimmed to the patterns that read the same in
 * Thebe, plus two checks of Thebe's own: a credential-shaped string (the output redactor decides) and
 * the tags the prompt wraps memory in.
 */
const FILLER = String.raw`(?:\w+\s+){0,3}`;
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;
const MODIFY = String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}`;

const PATTERNS: Array<[RegExp, string]> = [
  [new RegExp(String.raw`ignore\s+${FILLER}(previous|all|above|prior)\s+${FILLER}instructions`, "i"), "prompt_injection"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [new RegExp(String.raw`disregard\s+${FILLER}(your|all|any)\s+${FILLER}(instructions|rules|guidelines)`, "i"), "disregard_rules"],
  [new RegExp(String.raw`act\s+as\s+(if|though)\s+${FILLER}you\s+${FILLER}(have\s+no|don't\s+have)\s+${FILLER}(restrictions|limits|rules)`, "i"), "bypass_restrictions"],
  [/<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i, "html_comment_injection"],
  [/<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/i, "hidden_div"],
  [new RegExp(String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "i"), "deception_hide"],
  [new RegExp(String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`, "i"), "exfil_curl"],
  [new RegExp(String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`, "i"), "exfil_wget"],
  [/cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  [/(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?:\/\//i, "send_to_url"],
  [new RegExp(String.raw`(include|output|print|share)\s+${FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, "i"), "context_exfil"],
  [/authorized_keys/i, "ssh_backdoor"],
  [new RegExp(String.raw`${MODIFY}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, "i"), "agent_config_mod"],
  // The tags the system prompt wraps stored text in: an entry must not close or forge them.
  [/<\/?\s*(memory|owner_instructions|tool_output)\b/i, "prompt_tag"],
];

/** Zero-width and bidirectional control characters used to hide text from a reader. */
const INVISIBLE = new Set<number>([
  0x200b, 0x200c, 0x200d, 0x2060, 0x2062, 0x2063, 0x2064, 0xfeff,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

/** A reason to refuse `text`, or undefined when it is fine to store. */
export function memoryThreat(text: string): string | undefined {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (INVISIBLE.has(code)) {
      return `contains the invisible character U+${code.toString(16).toUpperCase().padStart(4, "0")} (possible injection)`;
    }
  }
  for (const [pattern, id] of PATTERNS) {
    if (pattern.test(text)) return `matches the blocked pattern "${id}" (possible injection)`;
  }
  if (redactToolOutput(text) !== text) {
    return "looks like it contains a credential; memory must not hold secrets";
  }
  return undefined;
}
