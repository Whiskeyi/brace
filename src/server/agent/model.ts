import "server-only";

import {
  createOpenAISdkClient,
  type OpenAICompatibleClient,
} from "@/lib/agent";
import type { ServerConfig } from "@/lib/config";

export function createAgentModelClient(
  config: ServerConfig,
): OpenAICompatibleClient {
  if (!config.LLM_API_KEY) throw new Error("MODEL_NOT_CONFIGURED");

  return createOpenAISdkClient({
    apiKey: config.LLM_API_KEY,
    baseUrl: config.LLM_BASE_URL,
    timeoutMs: config.AGENT_REQUEST_TIMEOUT_MS,
  });
}
