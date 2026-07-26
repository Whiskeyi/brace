import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_PROVIDER_ID,
  OPENAI_COMPATIBLE_MODEL_PROVIDERS,
  buildProviderRequestOptions,
  credentialScopeForModelEndpoint,
  getLocalAgentConfig,
  getModelCapabilityProbeProfile,
  getModelProvider,
  inferModelProviderFromBaseUrl,
  modelBaseUrlSchema,
  resolveModelProvider,
  saveLocalModelSettingsSchema,
} from "@/lib/local-agent";

describe("OpenAI-compatible model providers", () => {
  it("publishes exact provider endpoints and editable model suggestions", () => {
    expect(
      OPENAI_COMPATIBLE_MODEL_PROVIDERS.map(
        ({ id, baseUrl, defaultModel, recommendedModels }) => ({
          id,
          baseUrl,
          defaultModel,
          recommendedModels,
        }),
      ),
    ).toEqual([
      {
        id: "bailian-payg",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        defaultModel: "qwen-plus",
        recommendedModels: ["qwen-plus", "qwen3-coder-plus", "qwen-max"],
      },
      {
        id: "bailian-coding-plan",
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
        defaultModel: "qwen3-coder-plus",
        recommendedModels: [
          "qwen3-coder-plus",
          "qwen3.7-plus",
          "qwen3-coder-next",
        ],
      },
      {
        id: "minimax-cn-token-plan",
        baseUrl: "https://api.minimaxi.com/v1",
        defaultModel: "MiniMax-M3",
        recommendedModels: [
          "MiniMax-M3",
          "MiniMax-M2.7",
          "MiniMax-M2.7-highspeed",
        ],
      },
      {
        id: "minimax-global-token-plan",
        baseUrl: "https://api.minimax.io/v1",
        defaultModel: "MiniMax-M3",
        recommendedModels: [
          "MiniMax-M3",
          "MiniMax-M2.7",
          "MiniMax-M2.7-highspeed",
        ],
      },
      {
        id: "kimi-code",
        baseUrl: "https://api.kimi.com/coding/v1",
        defaultModel: "kimi-for-coding",
        recommendedModels: [
          "k3",
          "k3-256k",
          "kimi-for-coding",
          "kimi-for-coding-highspeed",
        ],
      },
      {
        id: "deepseek",
        baseUrl: "https://api.deepseek.com",
        defaultModel: "deepseek-v4-flash",
        recommendedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
      },
      {
        id: "glm-payg",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        defaultModel: "glm-5.2",
        recommendedModels: ["glm-5.2", "glm-5-turbo", "glm-4.7"],
      },
      {
        id: "glm-coding-plan",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
        defaultModel: "glm-5.2",
        recommendedModels: ["glm-5.2", "glm-5-turbo", "glm-4.7"],
      },
      {
        id: "custom",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
        recommendedModels: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
      },
    ]);
  });

  it("keeps subscription and pay-as-you-go credentials in separate scopes", () => {
    expect(getModelProvider("bailian-payg").credentialScope).not.toBe(
      getModelProvider("bailian-coding-plan").credentialScope,
    );
    expect(getModelProvider("glm-payg").credentialScope).not.toBe(
      getModelProvider("glm-coding-plan").credentialScope,
    );
    expect(getModelProvider("minimax-cn-token-plan").credentialScope).not.toBe(
      getModelProvider("minimax-global-token-plan").credentialScope,
    );
    expect(
      credentialScopeForModelEndpoint(
        "deepseek",
        "https://proxy.example.com/v1",
      ),
    ).toBe("custom:https://proxy.example.com/v1");
  });

  it("gives Kimi a larger stable capability-probe budget and cache key", () => {
    expect(
      getModelCapabilityProbeProfile("kimi-code", "thread-123"),
    ).toEqual({
      maxOutputTokens: 4_096,
      promptCacheKey:
        "base-agent:model-capability-probe:thread-123",
    });
    expect(getModelCapabilityProbeProfile("deepseek")).toEqual({
      maxOutputTokens: 1_024,
    });
  });

  it("builds task request options from provider prompt-cache capabilities", () => {
    expect(
      buildProviderRequestOptions("kimi-code", {
        maxOutputTokens: 4_096,
        promptCacheScope: "desktop:thread-123",
      }),
    ).toEqual({
      max_tokens: 4_096,
      prompt_cache_key: "base-agent:desktop:thread-123",
    });
    expect(
      buildProviderRequestOptions("deepseek", {
        maxOutputTokens: 1_024,
        promptCacheScope: "web:conversation-123",
      }),
    ).toEqual({ max_tokens: 1_024 });
    expect(() =>
      buildProviderRequestOptions("kimi-code", {
        maxOutputTokens: 1_024,
        promptCacheScope: "x".repeat(256),
      }),
    ).toThrow("prompt-cache scope is too long");
  });
});

describe("model provider URL policy", () => {
  it("accepts HTTPS and loopback-only HTTP endpoints", () => {
    expect(modelBaseUrlSchema.parse(" https://models.example.com/v1/ ")).toBe(
      "https://models.example.com/v1",
    );
    expect(modelBaseUrlSchema.parse("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
    expect(modelBaseUrlSchema.parse("http://127.0.0.1:1234/v1")).toBe(
      "http://127.0.0.1:1234/v1",
    );
    expect(modelBaseUrlSchema.parse("http://[::1]:8080/v1")).toBe(
      "http://[::1]:8080/v1",
    );
  });

  it("rejects remote HTTP and credential-bearing or ambiguous URLs", () => {
    expect(() =>
      modelBaseUrlSchema.parse("http://models.example.com/v1"),
    ).toThrow();
    expect(() =>
      modelBaseUrlSchema.parse("http://127.0.0.1.evil.example/v1"),
    ).toThrow();
    expect(() =>
      modelBaseUrlSchema.parse("https://user:secret@models.example.com/v1"),
    ).toThrow();
    expect(() =>
      modelBaseUrlSchema.parse("https://models.example.com/v1?tenant=1"),
    ).toThrow();
    expect(() =>
      modelBaseUrlSchema.parse("https://models.example.com/v1#token"),
    ).toThrow();
  });

  it.each([
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "bailian-payg"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "bailian-payg"],
    ["https://dashscope-us.aliyuncs.com/compatible-mode/v1", "bailian-payg"],
    [
      "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "bailian-payg",
    ],
    ["https://coding.dashscope.aliyuncs.com/v1", "bailian-coding-plan"],
    ["https://coding-intl.dashscope.aliyuncs.com/v1", "bailian-coding-plan"],
    ["https://api.minimaxi.com/v1", "minimax-cn-token-plan"],
    ["https://api.minimax.io/v1", "minimax-global-token-plan"],
    ["https://api.kimi.com/coding/v1", "kimi-code"],
    ["https://api.deepseek.com", "deepseek"],
    ["https://api.deepseek.com/v1", "deepseek"],
    ["https://open.bigmodel.cn/api/paas/v4", "glm-payg"],
    ["https://open.bigmodel.cn/api/coding/paas/v4", "glm-coding-plan"],
    ["https://models.example.com/v1", "custom"],
  ] as const)("infers %s as %s", (baseUrl, provider) => {
    expect(inferModelProviderFromBaseUrl(baseUrl)).toBe(provider);
  });

  it("does not mistake Anthropic endpoints for OpenAI-compatible presets", () => {
    expect(
      inferModelProviderFromBaseUrl(
        "https://dashscope.aliyuncs.com/apps/anthropic",
      ),
    ).toBe("custom");
    expect(
      inferModelProviderFromBaseUrl("https://api.kimi.com/coding/"),
    ).toBe("custom");
    expect(
      inferModelProviderFromBaseUrl(
        "https://open.bigmodel.cn/api/anthropic",
      ),
    ).toBe("custom");
  });
});

describe("local model provider configuration", () => {
  it("defaults an empty configuration to a coherent Qwen endpoint and model", () => {
    const config = getLocalAgentConfig({
      LLM_BASE_URL: "",
      LLM_MODEL: "",
    });
    expect(config).toMatchObject({
      LLM_PROVIDER: DEFAULT_MODEL_PROVIDER_ID,
      LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      LLM_MODEL: "qwen-plus",
    });
  });

  it("infers the provider and default model from a canonical base URL", () => {
    expect(
      getLocalAgentConfig({
        LLM_BASE_URL: "https://api.deepseek.com",
        LLM_API_KEY: "deepseek-test-key",
      }),
    ).toMatchObject({
      LLM_PROVIDER: "deepseek",
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_MODEL: "deepseek-v4-flash",
      LLM_API_KEY: "deepseek-test-key",
    });
  });

  it("preserves legacy DashScope and OpenAI environment aliases", () => {
    expect(
      getLocalAgentConfig({ DASHSCOPE_API_KEY: "dashscope-test-key" }),
    ).toMatchObject({
      LLM_PROVIDER: "bailian-payg",
      LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      LLM_MODEL: "qwen-plus",
      LLM_API_KEY: "dashscope-test-key",
    });
    expect(
      getLocalAgentConfig({ OPENAI_API_KEY: "openai-test-key" }),
    ).toMatchObject({
      LLM_PROVIDER: "custom",
      LLM_BASE_URL: "https://api.openai.com/v1",
      LLM_MODEL: "gpt-4.1-mini",
      LLM_API_KEY: "openai-test-key",
    });
  });

  it("uses an explicit provider preset while keeping the model editable", () => {
    expect(
      getLocalAgentConfig({
        LLM_PROVIDER: "kimi-code",
        LLM_BASE_URL: "",
        LLM_MODEL: "future-kimi-model",
      }),
    ).toMatchObject({
      LLM_PROVIDER: "kimi-code",
      LLM_BASE_URL: "https://api.kimi.com/coding/v1",
      LLM_MODEL: "future-kimi-model",
    });
  });

  it("pins explicit provider presets when environment variables supply another URL", () => {
    expect(
      getLocalAgentConfig({
        LLM_PROVIDER: "kimi-code",
        LLM_BASE_URL: "https://attacker.example.com/v1",
        LLM_MODEL: "kimi-for-coding",
      }),
    ).toMatchObject({
      LLM_PROVIDER: "kimi-code",
      LLM_BASE_URL: "https://api.kimi.com/coding/v1",
    });
  });

  it("preserves official regional endpoints without sharing their credentials", () => {
    expect(
      getLocalAgentConfig({
        LLM_PROVIDER: "bailian-payg",
        LLM_BASE_URL:
          "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        LLM_API_KEY: "regional-dashscope-key",
      }),
    ).toMatchObject({
      LLM_PROVIDER: "bailian-payg",
      LLM_BASE_URL:
        "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    });
    expect(
      resolveModelProvider({
        provider: "bailian-coding-plan",
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      }),
    ).toMatchObject({
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      credentialScope:
        "bailian-cn-coding-plan:https://coding-intl.dashscope.aliyuncs.com/v1",
    });
  });

  it("resolves a custom endpoint without sharing preset credentials", () => {
    expect(
      resolveModelProvider({ baseUrl: "https://proxy.example.com/v1" }),
    ).toMatchObject({
      provider: { id: "custom" },
      baseUrl: "https://proxy.example.com/v1",
      credentialScope: "custom:https://proxy.example.com/v1",
    });
  });

  it.each(
    OPENAI_COMPATIBLE_MODEL_PROVIDERS.filter(
      ({ id }) => id !== "custom",
    ).map(({ id, baseUrl }) => [id, baseUrl] as const),
  )("pins the %s preset to its registry endpoint", (provider, baseUrl) => {
    expect(
      resolveModelProvider({
        provider,
        baseUrl: "https://attacker.example.com/v1",
      }),
    ).toMatchObject({
      provider: { id: provider },
      baseUrl,
      credentialScope: getModelProvider(provider).credentialScope,
    });
  });

  it("only lets the custom provider use a renderer-supplied endpoint", () => {
    expect(
      resolveModelProvider({
        provider: "custom",
        baseUrl: "https://proxy.example.com/v1",
      }),
    ).toMatchObject({
      provider: { id: "custom" },
      baseUrl: "https://proxy.example.com/v1",
      credentialScope: "custom:https://proxy.example.com/v1",
    });
  });

  it("accepts a provider in the settings protocol without breaking old input", () => {
    expect(
      saveLocalModelSettingsSchema.parse({
        provider: "glm-coding-plan",
        baseUrl: "",
        model: "glm-next",
      }),
    ).toEqual({
      provider: "glm-coding-plan",
      baseUrl: "",
      model: "glm-next",
      clearApiKey: false,
    });
    expect(
      saveLocalModelSettingsSchema.parse({
        baseUrl: "https://models.example.com/v1",
        model: "custom-model",
      }),
    ).toEqual({
      baseUrl: "https://models.example.com/v1",
      model: "custom-model",
      clearApiKey: false,
    });
  });
});
