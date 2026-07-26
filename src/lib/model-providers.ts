import { z } from "zod";

import type { OpenAICompatibleRequestProfile } from "./agent/model";

export const MODEL_PROVIDER_IDS = [
  "bailian-payg",
  "bailian-coding-plan",
  "minimax-cn-token-plan",
  "minimax-global-token-plan",
  "kimi-code",
  "deepseek",
  "glm-payg",
  "glm-coding-plan",
  "custom",
] as const;

export const modelProviderIdSchema = z.enum(MODEL_PROVIDER_IDS);

export type ModelProviderId = z.infer<typeof modelProviderIdSchema>;

export interface OpenAICompatibleModelProvider {
  readonly id: ModelProviderId;
  readonly label: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  /**
   * Suggestions only. The settings UI must continue to accept an editable
   * model identifier because provider catalogs change independently of the app.
   */
  readonly recommendedModels: readonly string[];
  /**
   * Keys may only be silently reused inside the same credential scope.
   * Subscription-plan keys and pay-as-you-go keys intentionally never share it.
   */
  readonly credentialScope: string;
  readonly apiKeyHint: string;
  readonly requestProfile: OpenAICompatibleRequestProfile;
  readonly promptCache?: {
    readonly keyPrefix: string;
  };
  readonly capabilityProbe?: {
    readonly maxOutputTokens: number;
    readonly usePromptCache?: boolean;
  };
  readonly notice?: string;
}

export interface ModelCapabilityProbeProfile {
  readonly maxOutputTokens: number;
  readonly promptCacheKey?: string;
}

export const DEFAULT_MODEL_PROVIDER_ID: ModelProviderId = "bailian-payg";
export const DEFAULT_MODEL_CAPABILITY_PROBE_OUTPUT_TOKENS = 1_024;
export const KIMI_MODEL_CAPABILITY_PROBE_OUTPUT_TOKENS = 4_096;

export interface BuildProviderRequestOptionsInput {
  readonly maxOutputTokens: number;
  readonly promptCacheScope?: string;
}

export interface ProviderRequestOptions
  extends Readonly<Record<string, unknown>> {
  readonly max_tokens: number;
  readonly prompt_cache_key?: string;
}

export const OPENAI_COMPATIBLE_MODEL_PROVIDERS: readonly OpenAICompatibleModelProvider[] =
  [
    {
      id: "bailian-payg",
      label: "百炼 / Qwen（按量）",
      description: "阿里云百炼中国站 OpenAI 兼容接口。",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen-plus",
      recommendedModels: ["qwen-plus", "qwen3-coder-plus", "qwen-max"],
      credentialScope: "bailian-cn-payg",
      apiKeyHint: "使用百炼按量 API Key（通常以 sk- 开头）",
      requestProfile: {
        includeStreamUsage: true,
        outputTokenParameter: "max_tokens",
      },
    },
    {
      id: "bailian-coding-plan",
      label: "百炼 Coding Plan",
      description: "阿里云百炼 Coding Plan 的 OpenAI 兼容接口。",
      baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      defaultModel: "qwen3-coder-plus",
      recommendedModels: [
        "qwen3-coder-plus",
        "qwen3.7-plus",
        "qwen3-coder-next",
      ],
      credentialScope: "bailian-cn-coding-plan",
      apiKeyHint: "必须使用 Coding Plan 专用 Key（以 sk-sp- 开头）",
      requestProfile: {
        includeStreamUsage: true,
        outputTokenParameter: "max_tokens",
      },
      notice: "仅用于交互式编码工具，不可用于后端或批处理任务。",
    },
    {
      id: "minimax-cn-token-plan",
      label: "MiniMax Token Plan（中国）",
      description: "MiniMax 中国站 Token Plan 的 OpenAI 兼容接口。",
      baseUrl: "https://api.minimaxi.com/v1",
      defaultModel: "MiniMax-M3",
      recommendedModels: [
        "MiniMax-M3",
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
      ],
      credentialScope: "minimax-cn-token-plan",
      apiKeyHint: "使用 MiniMax 中国站 Token Plan 订阅 Key",
      requestProfile: {
        includeStreamUsage: true,
        outputTokenParameter: "max_completion_tokens",
      },
    },
    {
      id: "minimax-global-token-plan",
      label: "MiniMax Token Plan（全球）",
      description: "MiniMax 全球站 Token Plan 的 OpenAI 兼容接口。",
      baseUrl: "https://api.minimax.io/v1",
      defaultModel: "MiniMax-M3",
      recommendedModels: [
        "MiniMax-M3",
        "MiniMax-M2.7",
        "MiniMax-M2.7-highspeed",
      ],
      credentialScope: "minimax-global-token-plan",
      apiKeyHint: "使用 MiniMax 全球站 Token Plan 订阅 Key",
      requestProfile: {
        includeStreamUsage: true,
        outputTokenParameter: "max_completion_tokens",
      },
    },
    {
      id: "kimi-code",
      label: "Kimi Code",
      description: "Kimi Code 会员订阅的 OpenAI 兼容接口。",
      baseUrl: "https://api.kimi.com/coding/v1",
      defaultModel: "kimi-for-coding",
      recommendedModels: [
        "k3",
        "k3-256k",
        "kimi-for-coding",
        "kimi-for-coding-highspeed",
      ],
      credentialScope: "kimi-code-membership",
      apiKeyHint: "使用 Kimi Code 控制台生成的会员 API Key",
      requestProfile: {
        includeStreamUsage: false,
        outputTokenParameter: "max_completion_tokens",
      },
      promptCache: {
        keyPrefix: "base-agent",
      },
      capabilityProbe: {
        maxOutputTokens: KIMI_MODEL_CAPABILITY_PROBE_OUTPUT_TOKENS,
        usePromptCache: true,
      },
      notice: "保留 Brace 的真实客户端身份，不模拟其他编码工具。",
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      description: "DeepSeek 官方 OpenAI 兼容接口。",
      baseUrl: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      recommendedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
      credentialScope: "deepseek-payg",
      apiKeyHint: "使用 DeepSeek 开放平台 API Key",
      requestProfile: {
        includeStreamUsage: false,
        outputTokenParameter: "max_tokens",
      },
    },
    {
      id: "glm-payg",
      label: "GLM（按量）",
      description: "智谱开放平台标准 OpenAI 兼容接口。",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-5.2",
      recommendedModels: ["glm-5.2", "glm-5-turbo", "glm-4.7"],
      credentialScope: "glm-payg",
      apiKeyHint: "使用智谱开放平台标准 API Key",
      requestProfile: {
        includeStreamUsage: false,
        outputTokenParameter: "max_tokens",
        requestOverrides: { tool_stream: true },
      },
    },
    {
      id: "glm-coding-plan",
      label: "GLM Coding Plan",
      description: "GLM Coding Plan 面向编码工具的 OpenAI 兼容接口。",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      defaultModel: "glm-5.2",
      recommendedModels: ["glm-5.2", "glm-5-turbo", "glm-4.7"],
      credentialScope: "glm-coding-plan",
      apiKeyHint: "使用具备 GLM Coding Plan 权益的 API Key",
      requestProfile: {
        includeStreamUsage: false,
        outputTokenParameter: "max_tokens",
        requestOverrides: { tool_stream: true },
      },
      notice:
        "套餐仅限智谱官方支持的指定工具；Brace 不保证能够抵扣套餐额度。",
    },
    {
      id: "custom",
      label: "自定义 OpenAI 兼容接口",
      description: "OpenAI 或其他兼容 Chat Completions 的服务。",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
      recommendedModels: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini"],
      credentialScope: "openai-default",
      apiKeyHint: "使用该接口地址对应的 API Key",
      requestProfile: {
        // Generic compatible endpoints frequently reject stream_options.
        // Hosts that require streamed usage can inject a narrower profile.
        includeStreamUsage: false,
        outputTokenParameter: "max_tokens",
      },
    },
  ];

const providersById = new Map(
  OPENAI_COMPATIBLE_MODEL_PROVIDERS.map((provider) => [provider.id, provider]),
);

export const modelBaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        message:
          "Model URL must not contain credentials, query parameters, or fragments.",
      });
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
    ) {
      context.addIssue({
        code: "custom",
        message: "Model URL must use HTTPS, except for loopback HTTP endpoints.",
      });
    }
  })
  .transform(stripTrailingSlashes);

export function getModelProvider(
  providerId: ModelProviderId,
): OpenAICompatibleModelProvider {
  const provider = providersById.get(providerId);
  if (!provider) {
    throw new Error(`Unknown model provider: ${providerId}`);
  }
  return provider;
}

export function getModelCapabilityProbeProfile(
  providerId: ModelProviderId,
  cacheScope?: string,
): ModelCapabilityProbeProfile {
  const provider = getModelProvider(providerId);
  const capabilityProbe = provider.capabilityProbe;
  const normalizedScope = cacheScope?.trim() || "settings";
  const promptCacheKey = capabilityProbe?.usePromptCache
    ? buildProviderPromptCacheKey(
        provider,
        `model-capability-probe:${normalizedScope}`,
      )
    : undefined;
  return {
    maxOutputTokens:
      capabilityProbe?.maxOutputTokens ??
      DEFAULT_MODEL_CAPABILITY_PROBE_OUTPUT_TOKENS,
    ...(promptCacheKey ? { promptCacheKey } : {}),
  };
}

export function buildProviderRequestOptions(
  providerId: ModelProviderId,
  input: BuildProviderRequestOptionsInput,
): ProviderRequestOptions {
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
    throw new RangeError("maxOutputTokens must be a positive safe integer.");
  }
  const provider = getModelProvider(providerId);
  const promptCacheKey = buildProviderPromptCacheKey(
    provider,
    input.promptCacheScope,
  );
  return {
    max_tokens: input.maxOutputTokens,
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
  };
}

export function inferModelProviderFromBaseUrl(
  baseUrl: string | undefined,
): ModelProviderId | undefined {
  if (!baseUrl?.trim()) return undefined;

  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return undefined;
  }

  const hostname = url.hostname.toLowerCase();
  const pathname = normalizedPathname(url.pathname);

  if (
    (hostname === "coding.dashscope.aliyuncs.com" ||
      hostname === "coding-intl.dashscope.aliyuncs.com") &&
    pathStartsWith(pathname, "/v1")
  ) {
    return "bailian-coding-plan";
  }
  if (
    (hostname === "dashscope.aliyuncs.com" ||
      hostname === "dashscope-intl.aliyuncs.com" ||
      hostname === "dashscope-us.aliyuncs.com" ||
      hostname.endsWith(".maas.aliyuncs.com")) &&
    pathname.includes("/compatible-mode/v1")
  ) {
    return "bailian-payg";
  }
  if (
    hostname === "api.minimaxi.com" &&
    pathStartsWith(pathname, "/v1")
  ) {
    return "minimax-cn-token-plan";
  }
  if (hostname === "api.minimax.io" && pathStartsWith(pathname, "/v1")) {
    return "minimax-global-token-plan";
  }
  if (
    hostname === "api.kimi.com" &&
    pathStartsWith(pathname, "/coding/v1")
  ) {
    return "kimi-code";
  }
  if (
    hostname === "api.deepseek.com" &&
    (pathname === "/" || pathStartsWith(pathname, "/v1"))
  ) {
    return "deepseek";
  }
  if (
    hostname === "open.bigmodel.cn" &&
    pathStartsWith(pathname, "/api/coding/paas/v4")
  ) {
    return "glm-coding-plan";
  }
  if (
    hostname === "open.bigmodel.cn" &&
    pathStartsWith(pathname, "/api/paas/v4")
  ) {
    return "glm-payg";
  }
  return "custom";
}

export function resolveModelProvider(input: {
  readonly provider?: ModelProviderId;
  readonly baseUrl?: string;
}): {
  readonly provider: OpenAICompatibleModelProvider;
  readonly baseUrl: string;
  readonly credentialScope: string;
} {
  const providerId =
    input.provider ??
    inferModelProviderFromBaseUrl(input.baseUrl) ??
    DEFAULT_MODEL_PROVIDER_ID;
  const provider = getModelProvider(providerId);
  const requestedBaseUrl = input.baseUrl
    ? modelBaseUrlSchema.parse(input.baseUrl)
    : undefined;
  const baseUrl = modelBaseUrlSchema.parse(
    providerId === "custom"
      ? requestedBaseUrl ?? provider.baseUrl
      : requestedBaseUrl &&
          inferModelProviderFromBaseUrl(requestedBaseUrl) === providerId
        ? requestedBaseUrl
        : provider.baseUrl,
  );
  return {
    provider,
    baseUrl,
    credentialScope: credentialScopeForModelEndpoint(providerId, baseUrl),
  };
}

export function credentialScopeForModelEndpoint(
  providerId: ModelProviderId,
  baseUrl?: string,
): string {
  const provider = getModelProvider(providerId);
  const effectiveBaseUrl = modelBaseUrlSchema.parse(baseUrl ?? provider.baseUrl);
  if (effectiveBaseUrl === provider.baseUrl) return provider.credentialScope;

  const url = new URL(effectiveBaseUrl);
  if (
    providerId !== "custom" &&
    inferModelProviderFromBaseUrl(effectiveBaseUrl) === providerId
  ) {
    return `${provider.credentialScope}:${url.origin}${normalizedPathname(url.pathname)}`;
  }
  return `custom:${url.origin}${normalizedPathname(url.pathname)}`;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function normalizedPathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function pathStartsWith(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildProviderPromptCacheKey(
  provider: OpenAICompatibleModelProvider,
  scope: string | undefined,
): string | undefined {
  const normalizedScope = scope?.trim();
  if (!provider.promptCache || !normalizedScope) return undefined;
  const promptCacheKey = `${provider.promptCache.keyPrefix}:${normalizedScope}`;
  if (promptCacheKey.length > 256) {
    throw new RangeError("The model prompt-cache scope is too long.");
  }
  return promptCacheKey;
}
