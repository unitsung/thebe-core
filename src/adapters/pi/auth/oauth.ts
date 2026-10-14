import type { RuntimeAuth, RuntimeProvider } from "../../../agent/runtime/interface.ts";
import { httpError } from "../../../agent/types.ts";

type PendingOAuthLogin = {
  providerId: string;
  url?: string;
  instructions?: string;
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  };
  urlReady: Promise<void>;
  resolveUrlReady: () => void;
  rejectUrlReady: (error: unknown) => void;
  resolvePrompt: (input: string) => void;
  completion: Promise<{ kind: "oauth"; providerId: string }>;
};

type ModelRuntimeAuth = {
  login: (
    providerId: string,
    method: "oauth" | "apiKey",
    opts: {
      prompt: () => Promise<string>;
      notify: (event: {
        type: string;
        url?: string;
        instructions?: string;
        userCode?: string;
        verificationUri?: string;
        intervalSeconds?: number;
        expiresInSeconds?: number;
      }) => void;
    },
  ) => Promise<unknown>;
  setRuntimeApiKey: (providerId: string, apiKey: string) => Promise<void>;
  refresh: (opts: { allowNetwork: boolean }) => Promise<unknown>;
  checkAuth: (providerId: string) => Promise<unknown>;
  logout: (providerId: string) => Promise<void>;
  getProviders: () => Array<{
    id: string;
    name?: string;
    auth?: { apiKey?: unknown; oauth?: unknown };
  }>;
};

export function createPiRuntimeAuth(modelRuntime: ModelRuntimeAuth): RuntimeAuth {
  const pendingOAuth = new Map<string, PendingOAuthLogin>();

  function ensureOAuthLogin(
    providerId: string,
    openUrl?: (url: string) => Promise<void> | void,
  ): PendingOAuthLogin {
    const existing = pendingOAuth.get(providerId);
    if (existing) {
      if (openUrl && existing.url) {
        void openUrl(existing.url);
      }
      return existing;
    }
    let resolveUrlReady!: () => void;
    let rejectUrlReady!: (error: unknown) => void;
    const urlReady = new Promise<void>((resolve, reject) => {
      resolveUrlReady = resolve;
      rejectUrlReady = reject;
    });
    let urlSettled = false;
    const settleUrl = () => {
      if (!urlSettled) {
        urlSettled = true;
        resolveUrlReady();
      }
    };
    let resolvePrompt!: (input: string) => void;
    const promptInput = new Promise<string>((resolve) => {
      resolvePrompt = resolve;
    });
    promptInput.catch(() => {});
    const entry: PendingOAuthLogin = {
      providerId,
      urlReady,
      resolveUrlReady,
      rejectUrlReady,
      resolvePrompt,
      completion: Promise.resolve({ kind: "oauth" as const, providerId }),
    };
    pendingOAuth.set(providerId, entry);
    entry.completion = (async () => {
      try {
        await modelRuntime.login(providerId, "oauth", {
          prompt: async () => promptInput,
          notify: (event) => {
            if (event.type === "auth_url" && event.url) {
              entry.url = event.url;
              entry.instructions = event.instructions;
              settleUrl();
              void openUrl?.(event.url);
            } else if (
              event.type === "device_code" &&
              event.userCode &&
              event.verificationUri
            ) {
              entry.deviceCode = {
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                intervalSeconds: event.intervalSeconds,
                expiresInSeconds: event.expiresInSeconds,
              };
              settleUrl();
            }
          },
        });
        return { kind: "oauth" as const, providerId };
      } catch (error) {
        if (!urlSettled) {
          urlSettled = true;
          rejectUrlReady(error);
        }
        throw error;
      } finally {
        if (pendingOAuth.get(providerId) === entry) {
          pendingOAuth.delete(providerId);
        }
      }
    })();
    entry.completion.catch(() => {});
    return entry;
  }

  return {
    async setApiKey(providerId, apiKey) {
      await modelRuntime.login(providerId, "apiKey", {
        prompt: async () => apiKey,
        notify: () => {},
      });
      await modelRuntime.refresh({ allowNetwork: false });
    },
    async loginOAuth(providerId, interaction) {
      const entry = ensureOAuthLogin(providerId, interaction?.openUrl);
      return entry.completion;
    },
    async authorizeOAuth(providerId, options) {
      if (!options?.force) {
        try {
          if (await modelRuntime.checkAuth(providerId)) {
            return { providerId, connected: true as const };
          }
        } catch {
          // fall through and start the login so the real error surfaces
        }
      }
      const entry = ensureOAuthLogin(providerId);
      await Promise.race([
        entry.urlReady,
        entry.completion.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      if (!options?.force) {
        try {
          if (await modelRuntime.checkAuth(providerId)) {
            return { providerId, connected: true as const };
          }
        } catch {
          // fall through to the pending response
        }
      }
      let failed: unknown;
      let settled = false;
      entry.completion.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          failed = error;
          settled = true;
        },
      );
      await Promise.resolve();
      if (settled && failed !== undefined) {
        throw failed;
      }
      if (settled && options?.force) {
        return { providerId, connected: true as const };
      }
      return {
        providerId,
        pending: true as const,
        url: entry.url,
        instructions: entry.instructions,
        deviceCode: entry.deviceCode,
      };
    },
    async submitOAuthCallback(providerId, input) {
      const entry = pendingOAuth.get(providerId);
      if (!entry) {
        throw httpError(404, `unknown OAuth authorization: ${providerId}`);
      }
      if (!input.trim()) {
        throw new Error("OAuth callback input required");
      }
      entry.resolvePrompt(input);
      await entry.completion;
    },
    async logout(providerId) {
      await modelRuntime.logout(providerId);
    },
    async check(providerId) {
      const status = await modelRuntime.checkAuth(providerId);
      return { ok: Boolean(status) };
    },
    async listProviders(): Promise<RuntimeProvider[]> {
      const providers = modelRuntime.getProviders();
      const out: RuntimeProvider[] = [];
      for (const provider of providers) {
        const methods: Array<"apiKey" | "oauth"> = [];
        if (provider.auth?.apiKey) {
          methods.push("apiKey");
        }
        if (provider.auth?.oauth) {
          methods.push("oauth");
        }
        let authStatus: RuntimeProvider["authStatus"];
        try {
          const status = await modelRuntime.checkAuth(provider.id);
          authStatus = status ? "connected" : "missing";
        } catch {
          authStatus = "error";
        }
        out.push({
          id: provider.id,
          displayName: provider.name,
          authMethods: methods,
          authStatus,
          oauthPending: pendingOAuth.has(provider.id),
        });
      }
      return out;
    },
    async testProvider(providerId: string): Promise<{ ok: boolean; message?: string }> {
      try {
        const ok = await modelRuntime.checkAuth(providerId);
        return {
          ok: Boolean(ok),
          message: ok
            ? "Provider authenticated successfully"
            : "Provider authentication check failed",
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
