import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RunSnapshot } from "../run-store/index.ts";

export function exportRunJsonl(snapshot: RunSnapshot): string {
  return snapshot.messages.map((message) => JSON.stringify(message)).join("\n");
}

export function parseRunJsonl(jsonl: string): AgentMessage[] {
  const trimmed = jsonl.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed.split("\n").map((line) => JSON.parse(line) as AgentMessage);
}

export function exportRunHtml(snapshot: RunSnapshot): string {
  const rows = snapshot.messages.map(renderMessage).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Thebe run ${escapeHtml(snapshot.runId)}</title>
</head>
<body>
<h1>Thebe run ${escapeHtml(snapshot.runId)}</h1>
<p>status: ${escapeHtml(snapshot.status)}</p>
<ol>
${rows}
</ol>
</body>
</html>
`;
}

function renderMessage(message: AgentMessage): string {
  const role = escapeHtml(message.role);
  const body = escapeHtml(messageText(message));
  return `<li><strong>${role}</strong><pre>${body}</pre></li>`;
}

function messageText(message: AgentMessage): string {
  if ("content" in message && message.content !== undefined) {
    try {
      return typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    } catch {
      return "";
    }
  }
  try {
    return JSON.stringify(message);
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
