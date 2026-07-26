import { z } from "zod";

import {
  DEFAULT_MODEL_PROVIDER_ID,
  getModelProvider,
  inferModelProviderFromBaseUrl,
  modelBaseUrlSchema,
  modelProviderIdSchema,
  resolveModelProvider,
} from "../model-providers";

const optionalModelBaseUrl = z.preprocess(
  emptyToUndefined,
  modelBaseUrlSchema.optional(),
);

const commaSeparated = (fallback: readonly string[]) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string" || !value.trim()) return [...fallback];
      return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
    },
    z.array(z.string().min(1).max(255)).min(1).max(64),
  );

export const localAgentConfigSchema = z
  .object({
    LLM_PROVIDER: modelProviderIdSchema.optional(),
    LLM_BASE_URL: optionalModelBaseUrl,
    LLM_API_KEY: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(8).optional(),
    ),
    LLM_MODEL: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(1).max(200).optional(),
    ),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
    LLM_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_536)
      .default(4096),
    AGENT_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(32).default(8),
    AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(256).default(48),
    AGENT_MAX_TOOL_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(16)
      .default(4),
    AGENT_TOOL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(120_000)
      .default(30_000),
    AGENT_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(600_000),
    // Desktop threads use the same bounded-history contract as the web
    // runtime. The current user message is always included in addition to
    // these completed history messages.
    AGENT_MAX_HISTORY_MESSAGES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(40),
    // Conservative input + reserved-output budget used before opening a model
    // stream. This is intentionally provider-neutral rather than a tokenizer-
    // specific hard dependency in the local runtime.
    AGENT_CONTEXT_WINDOW_TOKENS: z.coerce
      .number()
      .int()
      .min(2_048)
      .max(2_000_000)
      .default(32_768),
    DESKTOP_ALLOWED_EXECUTABLES: commaSeparated([
      "git",
      "node",
      "npm",
      "pnpm",
      "npx",
      "yarn",
      "bun",
      "python",
      "python3",
      "pytest",
      "cargo",
      "go",
      "make",
    ]),
    DESKTOP_ENV_ALLOWLIST: commaSeparated(["PATH", "LANG", "LC_ALL"]),
  })
  .transform((value) => {
    const providerId =
      value.LLM_PROVIDER ??
      inferModelProviderFromBaseUrl(value.LLM_BASE_URL) ??
      DEFAULT_MODEL_PROVIDER_ID;
    const provider = getModelProvider(providerId);
    const endpoint = resolveModelProvider({
      provider: providerId,
      ...(value.LLM_BASE_URL ? { baseUrl: value.LLM_BASE_URL } : {}),
    });
    return {
      ...value,
      LLM_PROVIDER: providerId,
      LLM_BASE_URL: endpoint.baseUrl,
      LLM_MODEL: value.LLM_MODEL ?? provider.defaultModel,
    };
  });

export type LocalAgentConfig = z.infer<typeof localAgentConfigSchema>;

export function getLocalAgentConfig(
  source: Record<string, string | undefined> = process.env,
): LocalAgentConfig {
  const baseUrl = firstNonEmpty(
    source.LLM_BASE_URL,
    source.AGENT_BASE_URL,
    source.OPENAI_BASE_URL,
  );
  const explicitProvider = firstNonEmpty(
    source.LLM_PROVIDER,
    source.AGENT_PROVIDER,
  );
  const inferredProvider = inferModelProviderFromBaseUrl(baseUrl);
  const provider =
    explicitProvider ??
    inferredProvider ??
    (firstNonEmpty(
      source.OPENAI_API_KEY,
      source.OPENAI_MODEL,
      source.OPENAI_BASE_URL,
    )
      ? "custom"
      : source.DASHSCOPE_API_KEY
        ? "bailian-payg"
        : undefined);
  const apiKey =
    firstNonEmpty(source.LLM_API_KEY) ??
    (provider?.startsWith("bailian")
      ? firstNonEmpty(source.DASHSCOPE_API_KEY, source.OPENAI_API_KEY)
      : firstNonEmpty(source.OPENAI_API_KEY, source.DASHSCOPE_API_KEY));
  const normalized = {
    ...source,
    LLM_PROVIDER: provider,
    LLM_API_KEY: apiKey,
    LLM_BASE_URL: baseUrl,
    LLM_MODEL: firstNonEmpty(
      source.LLM_MODEL,
      source.AGENT_MODEL,
      source.OPENAI_MODEL,
    ),
  };
  return localAgentConfigSchema.parse(normalized);
}

function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function firstNonEmpty(
  ...values: readonly (string | undefined)[]
): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim())?.trim();
}
