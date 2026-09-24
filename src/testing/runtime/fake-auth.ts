import type { RuntimeAuth, RuntimeProvider } from "../../agent/runtime/interface.ts";
import { FAKE_RUNTIME_PROVIDERS } from "./fixtures.ts";

export type FakeAuthState = {
  apiKeys: Map<string, string>;
  oauthLogins: string[];
  oauthPending: Set<string>;
};

export function createFakeRuntimeAuth(state: FakeAuthState): RuntimeAuth {
  return {
    async setApiKey(providerId: string, apiKey: string): Promise<void> {
      state.apiKeys.set(providerId, apiKey);
    },
    async loginOAuth(providerId) {
      state.oauthLogins.push(providerId);
      return { kind: "oauth", providerId };
    },
    async authorizeOAuth(providerId, options) {
      if (
        !options?.force &&
        (state.apiKeys.has(providerId) || state.oauthLogins.includes(providerId))
      ) {
        return { providerId, connected: true as const };
      }
      state.oauthPending.add(providerId);
      return {
        providerId,
        pending: true as const,
        url: `https://oauth.example/${providerId}/authorize`,
        instructions:
          "Complete login in your browser, then paste the redirect URL or code.",
        deviceCode: {
          userCode: `${providerId.toUpperCase()}-DEV`,
          verificationUri: `https://oauth.example/${providerId}/device`,
        },
      };
    },
    async submitOAuthCallback(providerId, input) {
      if (!state.oauthPending.has(providerId)) {
        throw new Error(`unknown OAuth authorization: ${providerId}`);
      }
      if (!input.trim()) {
        throw new Error("OAuth callback input required");
      }
      state.oauthPending.delete(providerId);
      if (!state.oauthLogins.includes(providerId)) {
        state.oauthLogins.push(providerId);
      }
    },
    async logout(providerId: string): Promise<void> {
      state.apiKeys.delete(providerId);
      const index = state.oauthLogins.indexOf(providerId);
      if (index >= 0) {
        state.oauthLogins.splice(index, 1);
      }
      state.oauthPending.delete(providerId);
    },
    async check(providerId: string) {
      return {
        ok:
          state.apiKeys.has(providerId) || state.oauthLogins.includes(providerId),
      };
    },
    async listProviders(): Promise<RuntimeProvider[]> {
      return FAKE_RUNTIME_PROVIDERS.map((provider) => ({
        ...provider,
        oauthPending: state.oauthPending.has(provider.id),
        authStatus:
          state.apiKeys.has(provider.id) || state.oauthLogins.includes(provider.id)
            ? ("connected" as const)
            : ("missing" as const),
      }));
    },
    async testProvider(
      providerId: string,
    ): Promise<{ ok: boolean; message?: string }> {
      const ok =
        state.apiKeys.has(providerId) || state.oauthLogins.includes(providerId);
      return {
        ok,
        message: ok ? "Connected" : "Provider credentials not found",
      };
    },
  };
}
