import { describe, expect, it } from "vitest";

import { resolveDesktopRuntimeConfig } from "../desktop/model-runtime";
import type { DesktopModelSettings } from "../desktop/settings";
import { getLocalAgentConfig } from "@/lib/local-agent";

const deepSeekEnvironment = getLocalAgentConfig({
  LLM_PROVIDER: "deepseek",
  LLM_API_KEY: "deepseek-environment-key",
});

describe("desktop model runtime configuration", () => {
  it("reuses an environment key only inside the same credential scope", () => {
    const resolved = resolveDesktopRuntimeConfig(
      settings({
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        credentialScope: "deepseek-payg",
      }),
      deepSeekEnvironment,
      {
        OPENAI_API_KEY: "legacy-openai-key",
        DASHSCOPE_API_KEY: "legacy-dashscope-key",
      },
    );

    expect(resolved.apiKeySource).toBe("environment");
    expect(resolved.config.LLM_API_KEY).toBe("deepseek-environment-key");
  });

  it("never falls back to legacy environment aliases across scopes", () => {
    const resolved = resolveDesktopRuntimeConfig(
      settings({
        provider: "kimi-code",
        baseUrl: "https://api.kimi.com/coding/v1",
        model: "kimi-for-coding",
        credentialScope: "kimi-code-membership",
      }),
      deepSeekEnvironment,
      {
        LLM_API_KEY: "unscoped-key",
        OPENAI_API_KEY: "legacy-openai-key",
        DASHSCOPE_API_KEY: "legacy-dashscope-key",
      },
    );

    expect(resolved.apiKeySource).toBe("none");
    expect(resolved.config.LLM_API_KEY).toBeUndefined();
  });

  it("prefers an explicitly entered key for the selected endpoint", () => {
    const resolved = resolveDesktopRuntimeConfig(
      settings({
        provider: "custom",
        baseUrl: "http://127.0.0.1:4010/v1",
        model: "base-agent-e2e",
        apiKey: "local-e2e-key",
        credentialScope: "custom:http://127.0.0.1:4010/v1",
      }),
      deepSeekEnvironment,
      { OPENAI_API_KEY: "legacy-openai-key" },
    );

    expect(resolved.apiKeySource).toBe("secure_storage");
    expect(resolved.config).toMatchObject({
      LLM_PROVIDER: "custom",
      LLM_BASE_URL: "http://127.0.0.1:4010/v1",
      LLM_MODEL: "base-agent-e2e",
      LLM_API_KEY: "local-e2e-key",
    });
  });
});

function settings(
  overrides: Partial<DesktopModelSettings>,
): DesktopModelSettings {
  return {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    customBaseUrl: null,
    model: "deepseek-v4-flash",
    apiKey: null,
    credentialScope: "deepseek-payg",
    ...overrides,
  };
}
