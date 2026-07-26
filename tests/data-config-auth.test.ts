import type { SupabaseClient, User } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  getPublicConfig,
  getServerConfig,
} from "@/lib/config";

vi.mock("server-only", () => ({}));

describe("environment configuration", () => {
  const publicEnv = {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.com/",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-with-enough-length",
  };
  const serviceRoleEnv = {
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-with-enough-length",
  };

  it("validates and normalizes public values", () => {
    expect(getPublicConfig(publicEnv)).toEqual({
      ...publicEnv,
      NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.com",
    });
  });

  it("rejects missing values and URLs containing query secrets", () => {
    expect(() => getPublicConfig({})).toThrow(ConfigurationError);
    expect(() =>
      getServerConfig({
        ...publicEnv,
        ...serviceRoleEnv,
        ALIYUN_RAG_BASE_URL: "https://rds.example.com?apikey=must-not-be-here",
      }),
    ).toThrow(/must not contain credentials, query parameters, or fragments/);
  });

  it("parses bounded agent settings and de-duplicates RAG datasets", () => {
    const config = getServerConfig({
      ...publicEnv,
      ...serviceRoleEnv,
      LLM_API_KEY: "model-api-key-value",
      LLM_TEMPERATURE: "0.2",
      AGENT_MAX_TOOL_ROUNDS: "6",
      ALIYUN_RAG_DATASET_IDS: "one, two,one",
      ALIYUN_RAG_MODE: "hybrid",
      MEM0_HOST: "http://memory.example.com:80",
      MEM0_API_KEY: "mem0-service-key-value",
      MEM0_ENABLE_GRAPH: "true",
    });
    expect(config).toMatchObject({
      LLM_PROVIDER: "bailian-payg",
      LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      LLM_MODEL: "qwen-plus",
      LLM_TEMPERATURE: 0.2,
      LLM_MAX_OUTPUT_TOKENS: 4096,
      AGENT_MAX_TOOL_ROUNDS: 6,
      AGENT_MAX_TOOL_CALLS: 32,
      AGENT_MAX_TOOL_CONCURRENCY: 4,
      AGENT_MAX_MODEL_OUTPUT_BYTES: 1_048_576,
      AGENT_MAX_TOOL_ARGUMENT_BYTES: 32_768,
      AGENT_MAX_TOOL_RESULT_BYTES: 65_536,
      AGENT_TOOL_TIMEOUT_MS: 15_000,
      AGENT_REQUEST_TIMEOUT_MS: 120_000,
      AGENT_MAX_HISTORY_MESSAGES: 40,
      AGENT_CONTEXT_WINDOW_TOKENS: 32_768,
      ALIYUN_RAG_DATASET_IDS: ["one", "two"],
      ALIYUN_RAG_MODE: "hybrid",
      MEM0_ENABLE_GRAPH: true,
      LOG_LEVEL: "info",
    });
    expect(() =>
      getServerConfig({
        ...publicEnv,
        ...serviceRoleEnv,
        AGENT_MAX_TOOL_ROUNDS: "0",
      }),
    ).toThrow(ConfigurationError);
  });

  it("infers and pins the web model provider profile", () => {
    expect(
      getServerConfig({
        ...publicEnv,
        ...serviceRoleEnv,
        LLM_BASE_URL: "https://api.deepseek.com/",
        LLM_API_KEY: "deepseek-model-key",
      }),
    ).toMatchObject({
      LLM_PROVIDER: "deepseek",
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_MODEL: "deepseek-v4-flash",
    });

    expect(
      getServerConfig({
        ...publicEnv,
        ...serviceRoleEnv,
        LLM_PROVIDER: "kimi-code",
        LLM_BASE_URL: "https://untrusted.example.com/v1",
        LLM_API_KEY: "kimi-membership-key",
      }),
    ).toMatchObject({
      LLM_PROVIDER: "kimi-code",
      LLM_BASE_URL: "https://api.kimi.com/coding/v1",
      LLM_MODEL: "kimi-for-coding",
    });
  });

  it("treats blank optional integration values as unset", () => {
    const config = getServerConfig({
      ...publicEnv,
      ...serviceRoleEnv,
      ALIYUN_RAG_BASE_URL: "  ",
      ALIYUN_RAG_API_KEY: "",
      ALIYUN_RAG_DATASET_IDS: " ",
      MEM0_HOST: "",
      MEM0_API_KEY: "  ",
      TAVILY_API_KEY: "",
      BRAVE_SEARCH_API_KEY: " ",
    });
    expect(config.ALIYUN_RAG_BASE_URL).toBeUndefined();
    expect(config.ALIYUN_RAG_API_KEY).toBeUndefined();
    expect(config.ALIYUN_RAG_DATASET_IDS).toBeUndefined();
    expect(config.MEM0_HOST).toBeUndefined();
    expect(config.MEM0_API_KEY).toBeUndefined();
    expect(config.TAVILY_API_KEY).toBeUndefined();
    expect(config.BRAVE_SEARCH_API_KEY).toBeUndefined();
  });
});

describe("Supabase token verification", () => {
  it("verifies with Auth instead of trusting decoded JWT claims", async () => {
    const user = {
      id: "10000000-0000-4000-8000-000000000001",
      email: "agent@example.com",
    } as User;
    const getUser = vi.fn().mockResolvedValue({ data: { user }, error: null });
    const client = { auth: { getUser } } as unknown as SupabaseClient;
    const { verifyAccessToken } = await import("@/lib/auth");

    const verified = await verifyAccessToken("signed-access-token", client);

    expect(getUser).toHaveBeenCalledWith("signed-access-token");
    expect(verified.userId).toBe(user.id);
    expect(verified.supabase).toBe(client);
  });

  it("rejects malformed Authorization headers", async () => {
    const { extractBearerToken, AuthenticationError } = await import("@/lib/auth");
    expect(() => extractBearerToken(new Headers())).toThrow(AuthenticationError);
    expect(() =>
      extractBearerToken(new Headers({ authorization: "Basic abc" })),
    ).toThrow(AuthenticationError);
    expect(
      extractBearerToken(new Headers({ authorization: "Bearer token-value" })),
    ).toBe("token-value");
  });
});
