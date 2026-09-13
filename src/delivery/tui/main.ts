import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapThebe } from "../../app/bootstrap.ts";
import { parseCliArgs } from "../cli/args.ts";
import { startThebeTui } from "./app.ts";
import { loadThebeConfig } from "./settings/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const flags = parseCliArgs(process.argv.slice(2));

if (flags.kind === "error") {
  console.error(flags.message);
  process.exit(2);
}
if (flags.kind === "help") {
  const { CLI_HELP } = await import("../cli/args.ts");
  console.log(CLI_HELP.trimEnd());
  process.exit(0);
}

const sessionId =
  flags.kind === "tui" || flags.kind === "print"
    ? flags.sessionId
    : undefined;
const continueLast = flags.kind === "tui" ? flags.continueLast : false;
const title =
  flags.kind === "tui" || flags.kind === "print" ? flags.title : undefined;

const userConfig = await loadThebeConfig();
const tuiMode =
  flags.kind === "tui" && flags.tuiMode
    ? flags.tuiMode
    : userConfig.tuiMode ?? "regular";

const {
  agent,
  version,
  model: bootModel,
  workspacePath,
} = await bootstrapThebe({ fromDir: here });

const defaultModelRef: { providerId: string; modelId: string } =
  flags.kind === "tui" && flags.model
    ? flags.model
    : bootModel ?? { providerId: "opencode", modelId: "muse-spark-1.3-free" };

const modelRef = `${defaultModelRef.providerId}/${defaultModelRef.modelId}`;

let resolvedSessionId = sessionId;
if (continueLast && !resolvedSessionId) {
  const rows = await agent.listSessions();
  const sorted = [...rows].sort((a, b) => {
    const aTime = a.lastActiveAt ?? a.updatedAt ?? a.createdAt ?? "";
    const bTime = b.lastActiveAt ?? b.updatedAt ?? b.createdAt ?? "";
    return bTime.localeCompare(aTime);
  });
  resolvedSessionId = sorted[0]?.thebeSessionId;
}
if (resolvedSessionId) {
  await agent.resume(resolvedSessionId);
}

if (resolvedSessionId && typeof userConfig.autoCompact === "boolean") {
  await agent.setAutoCompactionEnabled(
    resolvedSessionId,
    userConfig.autoCompact,
  );
}
if (typeof userConfig.autoSummary === "boolean") {
  await agent.setAutoSummaryEnabled(userConfig.autoSummary);
}
if (typeof userConfig.autoSummaryDelayMs === "number") {
  await agent.setAutoSummaryDelayMs(userConfig.autoSummaryDelayMs);
}

startThebeTui({
  agent,
  sessionId: resolvedSessionId,
  title,
  model: modelRef,
  version,
  tuiMode,
  theme: userConfig.theme,
  cwd: workspacePath,
});
