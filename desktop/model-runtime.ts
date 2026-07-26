import { credentialScopeForModelEndpoint } from "../src/lib/model-providers";
import {
  getLocalAgentConfig,
  type LocalAgentConfig,
} from "../src/lib/local-agent/config";
import type { DesktopModelSettings } from "./settings";

export type DesktopApiKeySource =
  | "secure_storage"
  | "environment"
  | "none";

export function resolveDesktopRuntimeConfig(
  settings: DesktopModelSettings,
  environmentConfig: LocalAgentConfig | null,
  source: Record<string, string | undefined>,
): {
  readonly config: LocalAgentConfig;
  readonly apiKeySource: DesktopApiKeySource;
} {
  if (!settings.model) {
    throw new Error("A model identifier is required.");
  }
  const credentialScope =
    settings.credentialScope ??
    credentialScopeForModelEndpoint(
      settings.provider,
      settings.baseUrl ?? undefined,
    );
  const environmentApiKey = environmentKeyForScope(
    credentialScope,
    environmentConfig,
  );
  const apiKey = settings.apiKey ?? environmentApiKey;

  return {
    config: getLocalAgentConfig({
      ...source,
      LLM_PROVIDER: settings.provider,
      LLM_BASE_URL: settings.baseUrl ?? "",
      LLM_MODEL: settings.model,
      LLM_API_KEY: apiKey ?? "",
      // These legacy aliases must never bypass the credential-scope check
      // above when the user changes provider or custom endpoint.
      OPENAI_API_KEY: "",
      DASHSCOPE_API_KEY: "",
    }),
    apiKeySource: settings.apiKey
      ? "secure_storage"
      : environmentApiKey
        ? "environment"
        : "none",
  };
}

function environmentKeyForScope(
  credentialScope: string,
  environmentConfig: LocalAgentConfig | null,
): string | undefined {
  if (!environmentConfig?.LLM_API_KEY) return undefined;
  const environmentScope = credentialScopeForModelEndpoint(
    environmentConfig.LLM_PROVIDER,
    environmentConfig.LLM_BASE_URL,
  );
  return environmentScope === credentialScope
    ? environmentConfig.LLM_API_KEY
    : undefined;
}
