import { z } from "zod";

const httpUrl = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "must use http or https",
      });
    }
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        message: "must not contain credentials, query parameters, or fragments",
      });
    }
  })
  .transform((value) => value.replace(/\/+$/, ""));

const secret = z.string().trim().min(16);
const modelSecret = z.string().trim().min(8);
const emptyStringToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalSecret = z.preprocess(emptyStringToUndefined, secret.optional());
const optionalModelSecret = z.preprocess(
  emptyStringToUndefined,
  modelSecret.optional(),
);
const optionalHttpUrl = z.preprocess(
  emptyStringToUndefined,
  httpUrl.optional(),
);
const ragDatasetIds = z.preprocess(
  emptyStringToUndefined,
  z
    .string()
    .trim()
    .transform((value) => [
      ...new Set(value.split(",").map((item) => item.trim()).filter(Boolean)),
    ])
    .pipe(z.array(z.string().min(1).max(255)).min(1).max(10))
    .optional(),
);
const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean().default(false));

export const publicConfigSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: httpUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: secret,
});

export const serverConfigSchema = publicConfigSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
  LLM_BASE_URL: optionalHttpUrl,
  LLM_API_KEY: optionalModelSecret,
  LLM_MODEL: z.string().trim().min(1).max(200).default("qwen-plus"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(65_536).default(4096),
  AGENT_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(32).default(6),
  AGENT_TOOL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(120_000)
    .default(15_000),
  AGENT_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(120_000),
  AGENT_MAX_HISTORY_MESSAGES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000)
    .default(40),
  ALIYUN_RAG_BASE_URL: optionalHttpUrl,
  ALIYUN_RAG_API_KEY: optionalSecret,
  ALIYUN_RAG_DATASET_IDS: ragDatasetIds,
  ALIYUN_RAG_MODE: z
    .enum(["local", "global", "hybrid", "naive", "mix"])
    .default("mix"),
  MEM0_HOST: optionalHttpUrl,
  MEM0_API_KEY: optionalSecret,
  MEM0_ENABLE_GRAPH: booleanFromEnv,
  TAVILY_API_KEY: optionalSecret,
  BRAVE_SEARCH_API_KEY: optionalSecret,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type PublicConfig = z.infer<typeof publicConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export class ConfigurationError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(scope: "public" | "server", error: z.ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    super(`Invalid ${scope} configuration: ${details}`);
    this.name = "ConfigurationError";
    this.issues = error.issues;
  }
}

function parseConfig<T>(
  scope: "public" | "server",
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigurationError(scope, parsed.error);
  }
  return parsed.data;
}

/**
 * Reads only values that Next.js is allowed to inline into browser bundles.
 * Never add a server-side secret to this function.
 */
export function getPublicConfig(
  source: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
): PublicConfig {
  return parseConfig("public", publicConfigSchema, source);
}

/** Server-only environment parser. Call from server modules, never Client Components. */
export function getServerConfig(
  source: Record<string, string | undefined> = process.env,
): ServerConfig {
  if (typeof window !== "undefined") {
    throw new Error("Server configuration cannot be read in a browser");
  }
  // Canonical names win. Legacy names are read only here so callers never need
  // to scatter provider-specific process.env fallbacks across the codebase.
  const normalized = {
    ...source,
    LLM_API_KEY:
      source.LLM_API_KEY ?? source.DASHSCOPE_API_KEY ?? source.OPENAI_API_KEY,
    LLM_BASE_URL:
      source.LLM_BASE_URL ??
      source.AGENT_BASE_URL ??
      source.OPENAI_BASE_URL ??
      (source.DASHSCOPE_API_KEY
        ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
        : undefined),
    LLM_MODEL:
      source.LLM_MODEL ?? source.AGENT_MODEL ?? source.OPENAI_MODEL ?? "qwen-plus",
  };
  return parseConfig("server", serverConfigSchema, normalized);
}

export function requireServerConfig<K extends keyof ServerConfig>(
  key: K,
  source?: Record<string, string | undefined>,
): NonNullable<ServerConfig[K]> {
  const value = getServerConfig(source)[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required server configuration: ${key}`);
  }
  return value as NonNullable<ServerConfig[K]>;
}
