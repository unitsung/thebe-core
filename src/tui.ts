import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapThebe } from "./bootstrap.ts";
import { parseCliArgs } from "./cli/args.ts";
import { startThebeTui } from "./tui/app.ts";
import { loadThebeConfig } from "./tui/config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const flags = parseCliArgs(process.argv.slice(2));

if (flags.kind === "error") {
  console.error(flags.message);
  process.exit(2);
}
if (flags.kind === "help") {
  const { CLI_HELP } = await import("./cli/args.ts");
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

const { product, version, model: bootModel } = await bootstrapThebe({ fromDir: here });

const defaultModelRef: { providerId: string; modelId: string } =
  flags.kind === "tui" && flags.model
    ? flags.model
    : bootModel ?? { providerId: "opencode", modelId: "muse-spark-1.3-free" };

const modelRef = `${defaultModelRef.providerId}/${defaultModelRef.modelId}`;

let resolvedSessionId = sessionId;
if (continueLast && !resolvedSessionId) {
  const rows = await product.listSessions();
  const sorted = [...rows].sort((a, b) => {
    const aTime = a.lastActiveAt ?? a.updatedAt ?? a.createdAt ?? "";
    const bTime = b.lastActiveAt ?? b.updatedAt ?? b.createdAt ?? "";
    return bTime.localeCompare(aTime);
  });
  resolvedSessionId = sorted[0]?.thebeSessionId;
}
if (resolvedSessionId) {
  await product.resume(resolvedSessionId);
} else {
  const meta = await product.createSession({
    title,
    model: defaultModelRef,
  });
  resolvedSessionId = meta.thebeSessionId;
}

startThebeTui({
  product,
  sessionId: resolvedSessionId,
  title,
  model: modelRef,
  version,
  tuiMode,
  theme: userConfig.theme,
});
