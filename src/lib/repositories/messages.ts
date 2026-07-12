import type { SupabaseClient } from "@supabase/supabase-js";

import { mapMessage } from "./mappers";
import {
  assertTimestamp,
  assertUserId,
  boundedLimit,
  throwIfError,
} from "./shared";
import type {
  AgentMessage,
  JsonObject,
  JsonValue,
  MessageRole,
} from "./types";

export interface ListMessagesOptions {
  limit?: number;
  /** Exclusive created_at cursor. */
  before?: string;
}

export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  content: JsonValue;
  toolName?: string | null;
  toolCallId?: string | null;
  metadata?: JsonObject;
}

const roles = new Set<MessageRole>(["system", "user", "assistant", "tool"]);

export function messageRepository(client: SupabaseClient) {
  return {
    async list(
      userId: string,
      conversationId: string,
      options: ListMessagesOptions = {},
    ): Promise<AgentMessage[]> {
      const owner = assertUserId(userId);
      const limit = boundedLimit(options.limit, 100, 500);
      const before = assertTimestamp(options.before, "before");
      let query = client
        .from("agent_messages")
        .select("*")
        .eq("user_id", owner)
        .eq("conversation_id", conversationId);
      if (before) query = query.lt("created_at", before);
      const { data, error } = await query
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      throwIfError("messages.list", error);
      return (data ?? []).map(mapMessage).reverse();
    },

    async append(userId: string, input: AppendMessageInput): Promise<AgentMessage> {
      const owner = assertUserId(userId);
      if (!roles.has(input.role)) throw new Error("Unsupported message role");
      if (input.role === "tool" && !input.toolCallId) {
        throw new Error("toolCallId is required for tool messages");
      }
      const { data, error } = await client
        .from("agent_messages")
        .insert({
          user_id: owner,
          conversation_id: input.conversationId,
          role: input.role,
          content: input.content,
          tool_name: input.toolName ?? null,
          tool_call_id: input.toolCallId ?? null,
          metadata: input.metadata ?? {},
        })
        .select("*")
        .single();
      throwIfError("messages.append", error);
      return mapMessage(data);
    },

    async remove(userId: string, id: string): Promise<boolean> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_messages")
        .delete()
        .eq("user_id", owner)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      throwIfError("messages.remove", error);
      return Boolean(data);
    },
  };
}

export const createMessageRepository = messageRepository;
