import type { TUI } from "../rendering/adapter.ts";
import { BashExecutionComponent } from "../rendering/adapter.ts";
import type { ThebeAgent } from "../../../agent/index.ts";
import { spawn } from "node:child_process";

export type ChatBashHooks = {
  tui: TUI;
  insertBeforeFooter: (component: { render(width: number): string[] }) => void;
  notice: (text: string) => void;
};

export async function runChatBash(
  hooks: ChatBashHooks,
  command: string,
  excludeFromContext: boolean,
  opts: {
    agent?: ThebeAgent;
    sessionId?: string;
    signal: AbortSignal;
    onData: (chunk: string) => void;
    cwd?: string;
  },
): Promise<{ exitCode?: number; cancelled: boolean }> {
  const { tui, insertBeforeFooter, notice } = hooks;
  const bashComp = new BashExecutionComponent(command, tui, excludeFromContext);
  insertBeforeFooter(bashComp);
  tui.requestRender();

  try {
    if (opts.agent && opts.sessionId) {
      const res = await opts.agent.executeBash(
        opts.sessionId,
        command,
        (chunk: string) => {
          bashComp.appendOutput(chunk);
          opts.onData(chunk);
          tui.requestRender();
        },
        { excludeFromContext },
      );
      bashComp.setComplete(res.exitCode, res.cancelled);
      return { exitCode: res.exitCode, cancelled: res.cancelled };
    }
    const exitCode = await runLocalCommand(command, opts.cwd ?? process.cwd(), opts.signal, (chunk) => {
      bashComp.appendOutput(chunk);
      opts.onData(chunk);
      tui.requestRender();
    });
    bashComp.setComplete(exitCode, false);
    return { exitCode, cancelled: false };
  } catch (err: unknown) {
    if (opts.signal.aborted) {
      bashComp.setComplete(undefined, true);
      return { cancelled: true };
    }
    bashComp.setComplete(1, false);
    notice(`Bash command failed: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1, cancelled: false };
  }
}

function runLocalCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  onData: (chunk: string) => void,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const forward = (data: Buffer) => onData(data.toString("utf8"));
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    const abort = () => child.kill("SIGTERM");
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      resolve(code ?? undefined);
    });
  });
}
