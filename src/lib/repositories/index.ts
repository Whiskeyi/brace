import type { SupabaseClient } from "@supabase/supabase-js";

import { auditRepository } from "./audit";
import { conversationRepository } from "./conversations";
import { memoryRepository } from "./memories";
import { messageRepository } from "./messages";
import { runRepository, runStepRepository } from "./runs";
import { runEventRepository } from "./run-events";

export * from "./audit";
export * from "./conversations";
export * from "./memories";
export * from "./messages";
export * from "./runs";
export * from "./run-events";
export * from "./shared";
export * from "./types";

export function createRepositories(client: SupabaseClient) {
  return {
    conversations: conversationRepository(client),
    messages: messageRepository(client),
    runs: runRepository(client),
    runSteps: runStepRepository(client),
    runEvents: runEventRepository(client),
    memories: memoryRepository(client),
    audit: auditRepository(client),
  };
}

export type AgentRepositories = ReturnType<typeof createRepositories>;
