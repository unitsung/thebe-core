/**
 * How a `memory` call reads in the terminal. The model's arguments are a target and a list of
 * operations; the approval prompt and the tool line show what would be saved, changed or removed
 * rather than the first string in the arguments, which is only the target.
 */

type MemoryOperationArgs = {
  action?: unknown;
  content?: unknown;
  old_text?: unknown;
  oldText?: unknown;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** One line per operation, or none when the arguments are not a memory call. */
export function describeMemoryOperations(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const operations = (args as { operations?: unknown }).operations;
  if (!Array.isArray(operations)) return [];
  const lines: string[] = [];
  for (const item of operations as MemoryOperationArgs[]) {
    if (!item || typeof item !== "object") continue;
    const content = text(item.content);
    const old = text(item.old_text ?? item.oldText);
    if (item.action === "add") lines.push(`add: ${content}`);
    else if (item.action === "patch") lines.push(`change: ${old} → ${content}`);
    else if (item.action === "remove") lines.push(`remove: ${old}`);
  }
  return lines;
}

/** `user: add: …; remove: …` for the single-line tool row. */
export function formatMemoryArgs(args: unknown): string {
  const lines = describeMemoryOperations(args);
  if (!lines.length) return "";
  const target = text((args as { target?: unknown }).target);
  return `${target ? `${target}: ` : ""}${lines.join("; ")}`;
}

/** What the approval prompt shows above its choices. */
export function memoryApprovalNotice(args: unknown): string | undefined {
  const lines = describeMemoryOperations(args);
  if (!lines.length) return undefined;
  const target = text((args as { target?: unknown }).target) || "memory";
  return [`memory (${target}) would be changed:`, ...lines.map((line) => `  ${line}`)].join("\n");
}
