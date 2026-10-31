import type { RuntimeProvider, ThebeAgent } from "../../../agent/index.ts";
import { chalk } from "../theme.ts";
import { attachSearchableModelPicker, attachSearchableProviderPicker } from "../overlays/model-picker.ts";
import { saveProviderEndpoint } from "../settings/provider-config.ts";
import { attachPromptInput, attachSelectList } from "../overlays/index.ts";
import { resolveListedProvider, sameProviderId } from "../overlays/model-ref.ts";
import { runOAuthLogin } from "../auth/login.ts";
import type { SlashHost } from "./context.ts";

export async function handleProviderCommand(
  host: SlashHost,
  agent: ThebeAgent,
  name: string,
  arg: string,
): Promise<boolean> {
  switch (name) {
          case "provider": {
            const id = await host.ensureSession();
            const providers = await agent.listProviders();
            let chosenProvider: RuntimeProvider | undefined;
            if (arg) {
              chosenProvider = resolveListedProvider(providers, arg);
              if (!chosenProvider) {
                host.notice(`unknown provider: ${arg.trim()}`);
                break;
              }
            } else {
              chosenProvider =
                (await attachSearchableProviderPicker(host.tui, {
                  agent,
                  currentModel: host.currentModel,
                  focusBack: host.editor,
                })) ?? undefined;
              if (!chosenProvider) {
                break;
              }
            }

            const scoped = await agent.listAvailableModels({
              providerId: chosenProvider.id,
            });
            if (scoped.length === 0) {
              host.notice(
                `no models available for provider ${chosenProvider.id}; login may be required`,
              );
              break;
            }

            const selectedModel = await attachSearchableModelPicker(host.tui, {
              agent,
              currentModel: host.currentModel,
              providerFilter: chosenProvider.id,
              focusBack: host.editor,
            });
            if (selectedModel) {
              if (!sameProviderId(selectedModel.providerId, chosenProvider.id)) {
                host.notice(
                  `model ${selectedModel.providerId}/${selectedModel.modelId} is not a ${chosenProvider.id} model`,
                );
                break;
              }
              await host.applyModel(id, selectedModel);
            }
            break;
          }
          case "custom":
          case "login": {
            const isCustomDirect = name === "custom" || arg.trim() === "custom";
            if (isCustomDirect) {
              const configured = await host.runCustomProviderWizard(
                arg.trim() === "custom" ? undefined : arg.trim(),
              );
              if (configured) {
                await host.afterProviderLoggedIn(
                  configured.providerId,
                  `configured custom provider ${configured.providerId} (${configured.modelId})`,
                  configured.modelId,
                );
              }
              break;
            }

            const providers = await agent.listProviders();
            let target = arg.trim();
            if (!target) {
              const chosen = await attachSearchableProviderPicker(host.tui, {
                agent,
                currentModel: host.currentModel,
                focusBack: host.editor,
                includeCustom: true,
              });
              if (!chosen) break;
              target = chosen.id;
            }

            if (target === "custom") {
              const configured = await host.runCustomProviderWizard();
              if (configured) {
                await host.afterProviderLoggedIn(
                  configured.providerId,
                  `configured custom provider ${configured.providerId} (${configured.modelId})`,
                  configured.modelId,
                );
              }
              break;
            }

            const providerObj = resolveListedProvider(providers, target);
            if (!providerObj) {
              host.notice(`unknown provider: ${target}`);
              break;
            }
            const targetProvider = providerObj.id;
            const display = providerObj.displayName ?? targetProvider;
            const methods = providerObj.authMethods ?? ["apiKey"];
            const supportsOAuth = methods.includes("oauth");
            const supportsApiKey = methods.includes("apiKey") || methods.length === 0;

            let method: "oauth" | "apikey" = supportsOAuth ? "oauth" : "apikey";
            if (supportsOAuth && supportsApiKey) {
              const chosen = await attachSelectList(
                host.tui,
                [
                  { label: `1. OAuth Login with ${display}`, value: "oauth" },
                  { label: `2. Set API Key for ${display}`, value: "apikey" },
                ],
                host.editor,
                undefined,
                host.getActiveSelectListTheme(),
              );
              if (!chosen) break;
              method = chosen.value === "apikey" ? "apikey" : "oauth";
            }

            if (method === "oauth") {
              const ok = await runOAuthLogin(
                host.tui,
                agent,
                targetProvider,
                host.editor,
                host.notice,
              );
              if (ok) {
                await host.afterProviderLoggedIn(
                  targetProvider,
                  `logged in provider ${targetProvider} via OAuth`,
                );
              }
              break;
            }

            const apiKey = await attachPromptInput(host.tui, {
              prompt: chalk.cyan(`API key for ${targetProvider}: `),
              placeholder: "paste API key and press Enter",
              focusBack: host.editor,
            });
            if (apiKey === null) {
              host.notice(`login cancelled for ${targetProvider}`);
              break;
            }
            if (!apiKey.trim()) {
              host.notice(`API key required for ${targetProvider}`);
              break;
            }

            let customBaseUrl: string | undefined;
            if (
              (targetProvider === "openai" || targetProvider === "anthropic") &&
              process.stdin.isTTY
            ) {
              const endpoint = await attachPromptInput(host.tui, {
                prompt: chalk.cyan(`Base URL endpoint for ${targetProvider} (optional, Enter to skip): `),
                placeholder: targetProvider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com",
                focusBack: host.editor,
              });
              if (endpoint && endpoint.trim()) {
                customBaseUrl = endpoint.trim();
                try {
                  await saveProviderEndpoint(targetProvider, customBaseUrl);
                } catch (error) {
                  host.notice(
                    `could not save the endpoint for ${targetProvider}: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  );
                  break;
                }
              }
            }

            try {
              await agent.auth().setApiKey(targetProvider, apiKey.trim());
              await host.afterProviderLoggedIn(
                targetProvider,
                `saved API key for ${targetProvider}${customBaseUrl ? ` (endpoint: ${customBaseUrl})` : ""}`,
              );
            } catch (e) {
              host.notice(
                `login error for ${targetProvider}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
            break;
          }
          case "logout": {
            const providers = await agent.listProviders();
            let target = arg.trim();
            if (!target) {
              const chosen = await attachSearchableProviderPicker(host.tui, {
                agent,
                currentModel: host.currentModel,
                focusBack: host.editor,
              });
              if (!chosen) break;
              target = chosen.id;
            }
            const providerObj = resolveListedProvider(providers, target);
            if (!providerObj) {
              host.notice(`unknown provider: ${target}`);
              break;
            }
            try {
              await agent.auth().logout(providerObj.id);
              host.notice(`logged out provider ${providerObj.id}`);
            } catch (e) {
              host.notice(
                `logout error for ${providerObj.id}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
            break;
          }
    default:
      return false;
  }
  return true;
}
