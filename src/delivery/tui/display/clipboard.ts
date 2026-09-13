import { spawn } from "node:child_process";
import { copyToClipboard as copyOfficial } from "../rendering/adapter.ts";

/** Same platform open as official Pi `utils/open-browser.ts`. */
export function openBrowser(target: string): void {
  if (!process.stdout.isTTY) {
    return;
  }
  const [cmd, args] =
    process.platform === "darwin"
      ? (["open", [target]] as const)
      : process.platform === "win32"
        ? (["rundll32", ["url.dll,FileProtocolHandler", target]] as const)
        : (["xdg-open", [target]] as const);
  spawn(cmd, [...args], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

/**
 * Clipboard helper aligned with official Pi (`utils/clipboard.ts`).
 *
 * Uses Pi's public `copyToClipboard` for the native path. The optional `write`
 * hook is Thebe-only so tests and SSH sessions can inject OSC 52 onto a
 * specific stream — that parameter is not on the Pi export.
 */
function writeOsc52(text: string, write: (data: string) => void): boolean {
  try {
    const payload = Buffer.from(text, "utf8").toString("base64");
    write(`\x1b]52;c;${payload}\x07`);
    return true;
  } catch {
    return false;
  }
}

export async function copyToClipboard(
  text: string,
  write?: (data: string) => void,
): Promise<boolean> {
  const osc = write ? writeOsc52(text, write) : false;
  try {
    await copyOfficial(text);
    return true;
  } catch {
    return osc;
  }
}
