import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapThebe } from "./bootstrap.ts";
import { parseCliArgs } from "./cli/args.ts";
import { startThebeTui } from "./tui/app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const flags = parseCliArgs(process.argv.slice(2));
const sessionId =
  flags.kind === "tui" || flags.kind === "print"
    ? flags.sessionId
    : undefined;
const continueLast = flags.kind === "tui" ? flags.continueLast : false;
const title =
  flags.kind === "tui" || flags.kind === "print" ? flags.title : undefined;

const { product } = await bootstrapThebe({ fromDir: here });

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
  const meta = await product.createSession({ title });
  resolvedSessionId = meta.thebeSessionId;
}

startThebeTui({
  product,
  sessionId: resolvedSessionId,
  title,
});
