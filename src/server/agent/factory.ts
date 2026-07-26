import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createAgent,
  createOpenAICompatibleModel,
} from "@/lib/agent";
import type { ServerConfig } from "@/lib/config";
import {
  buildProviderRequestOptions,
  getModelProvider,
} from "@/lib/model-providers";
import { createAgentModelClient } from "@/server/agent/model";
import { SERVER_AGENT_SYSTEM_PROMPT } from "@/server/agent/prompt";
import {
  createToolRegistry,
  serverAgentToolPolicy,
} from "@/server/agent/tools";

export interface CreateServerAgentOptions {
  readonly config: ServerConfig;
  readonly supabase: SupabaseClient;
  readonly userId: string;
  readonly conversationId: string;
}

export function createServerAgent({
  config,
  supabase,
  userId,
  conversationId,
}: CreateServerAgentOptions) {
  const provider = getModelProvider(config.LLM_PROVIDER);
  const maxOutputTokens = Math.min(
    config.LLM_MAX_OUTPUT_TOKENS,
    Math.floor(config.AGENT_CONTEXT_WINDOW_TOKENS / 2),
  );
  return createAgent({
    modelProvider: createOpenAICompatibleModel(
      createAgentModelClient(config),
      config.LLM_MODEL,
      { requestProfile: provider.requestProfile },
    ),
    systemPrompt: SERVER_AGENT_SYSTEM_PROMPT,
    tools: createToolRegistry({ supabase, userId, config }),
    toolPolicy: serverAgentToolPolicy,
    maxRounds: config.AGENT_MAX_TOOL_ROUNDS,
    maxToolCalls: config.AGENT_MAX_TOOL_CALLS,
    maxToolConcurrency: config.AGENT_MAX_TOOL_CONCURRENCY,
    maxModelOutputBytes: config.AGENT_MAX_MODEL_OUTPUT_BYTES,
    maxToolArgumentBytes: config.AGENT_MAX_TOOL_ARGUMENT_BYTES,
    toolTimeoutMs: config.AGENT_TOOL_TIMEOUT_MS,
    maxToolResultBytes: config.AGENT_MAX_TOOL_RESULT_BYTES,
    contextWindowTokens: config.AGENT_CONTEXT_WINDOW_TOKENS,
    reservedOutputTokens: maxOutputTokens,
    temperature: config.LLM_TEMPERATURE,
    requestOptions: buildProviderRequestOptions(config.LLM_PROVIDER, {
      maxOutputTokens,
      promptCacheScope: `web:${conversationId}`,
    }),
  });
}
