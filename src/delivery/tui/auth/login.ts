import type { TUI } from "../rendering/adapter.ts";
import type { ThebeAgent } from "../../../agent/index.ts";
import { chalk } from "../theme.ts";
import { openBrowser } from "../display/clipboard.ts";
import { attachPromptInput } from "../overlays/index.ts";

export async function runOAuthLogin(
  tui: TUI,
  agent: ThebeAgent,
  providerId: string,
  focusBack: unknown,
  notice: (text: string) => void,
): Promise<boolean> {
  try {
    notice(`initiating OAuth login for ${providerId}...`);
    const auth = agent.auth();
    const res = await auth.authorizeOAuth(providerId);
    if (res.connected) {
      return true;
    }
    if (res.url) {
      openBrowser(res.url);
    }
    if (res.deviceCode?.verificationUri) {
      openBrowser(res.deviceCode.verificationUri);
    }
    const hint = [
      res.url ? `authorize in your browser: ${res.url}` : undefined,
      res.deviceCode
        ? `device login: visit ${res.deviceCode.verificationUri} and enter ${res.deviceCode.userCode}`
        : undefined,
      res.instructions,
    ]
      .filter(Boolean)
      .join("\n");
    if (hint) {
      notice(hint);
    }

    const abortController = new AbortController();
    let autoConnected = false;

    const pollTimer = setInterval(async () => {
      try {
        const check = await auth.check(providerId);
        if (check.ok) {
          autoConnected = true;
          clearInterval(pollTimer);
          abortController.abort();
        }
      } catch {}
    }, 500);

    const callback = await attachPromptInput(tui, {
      prompt: chalk.cyan(`OAuth callback for ${providerId}: `),
      placeholder: "waiting for browser callback (or paste redirect URL/code here)",
      focusBack,
      abortSignal: abortController.signal,
    });
    clearInterval(pollTimer);

    if (autoConnected) {
      return true;
    }

    if (callback === null || !callback.trim()) {
      const already = await auth.check(providerId);
      if (already.ok) {
        return true;
      }
      notice(
        callback === null
          ? `OAuth login for ${providerId} cancelled`
          : `OAuth callback required for ${providerId}`,
      );
      return false;
    }
    try {
      await auth.submitOAuthCallback(providerId, callback.trim());
    } catch (error) {
      const already = await auth.check(providerId);
      if (!already.ok) {
        throw error;
      }
    }
    const status = await auth.check(providerId);
    if (!status.ok) {
      notice(`OAuth login for ${providerId} did not connect`);
      return false;
    }
    return true;
  } catch (e) {
    notice(
      `OAuth login error for ${providerId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}
