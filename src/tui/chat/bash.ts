import type { TUI } from "@earendil-works/pi-tui";
import {
  BashExecutionComponent,
  createLocalBashOperations,
} from "../../runtime/pi/official-ui.ts";
import type { ThebeProduct } from "../../product/service.ts";

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
    product?: ThebeProduct;
    sessionId?: string;
    signal: AbortSignal;
    onData: (chunk: string) => void;
  },
): Promise<{ exitCode?: number; cancelled: boolean }> {
  const { tui, insertBeforeFooter, notice } = hooks;
  const bashComp = new BashExecutionComponent(command, tui, excludeFromContext);
  insertBeforeFooter(bashComp);
  tui.requestRender();

  try {
    if (opts.product && opts.sessionId) {
      const res = await opts.product.executeBash(
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
    const ops = createLocalBashOperations();
    const res = await ops.exec(command, process.cwd(), {
      onData: (data: Buffer) => {
        const chunk = data.toString("utf8");
        bashComp.appendOutput(chunk);
        opts.onData(chunk);
        tui.requestRender();
      },
      signal: opts.signal,
    });
    const exitCode = res.exitCode ?? undefined;
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
