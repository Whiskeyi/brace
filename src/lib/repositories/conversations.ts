import type { SupabaseClient } from "@supabase/supabase-js";

import { mapConversation } from "./mappers";
import {
  assertTimestamp,
  assertUserId,
  boundedLimit,
  throwIfError,
} from "./shared";
import type { Conversation, JsonObject } from "./types";

export interface ListConversationsOptions {
  limit?: number;
  /** Exclusive updated_at cursor. */
  cursor?: string;
  includeArchived?: boolean;
}

export interface CreateConversationInput {
  title?: string;
  metadata?: JsonObject;
}

export interface UpdateConversationInput {
  title?: string;
  metadata?: JsonObject;
  archivedAt?: string | null;
}

export function conversationRepository(client: SupabaseClient) {
  return {
    async list(
      userId: string,
      options: ListConversationsOptions = {},
    ): Promise<Conversation[]> {
      const owner = assertUserId(userId);
      const limit = boundedLimit(options.limit, 50, 200);
      const cursor = assertTimestamp(options.cursor, "cursor");
      let query = client
        .from("agent_conversations")
        .select("*")
        .eq("user_id", owner);
      if (!options.includeArchived) query = query.is("archived_at", null);
      if (cursor) query = query.lt("updated_at", cursor);
      const { data, error } = await query
        .order("updated_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      throwIfError("conversations.list", error);
      return (data ?? []).map(mapConversation);
    },

    async get(userId: string, id: string): Promise<Conversation | null> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_conversations")
        .select("*")
        .eq("user_id", owner)
        .eq("id", id)
        .maybeSingle();
      throwIfError("conversations.get", error);
      return data ? mapConversation(data) : null;
    },

    async create(
      userId: string,
      input: CreateConversationInput = {},
    ): Promise<Conversation> {
      const owner = assertUserId(userId);
      const title = input.title?.trim() || "新会话";
      if (title.length > 300) throw new Error("title must be at most 300 characters");
      const { data, error } = await client
        .from("agent_conversations")
        .insert({
          user_id: owner,
          title,
          metadata: input.metadata ?? {},
        })
        .select("*")
        .single();
      throwIfError("conversations.create", error);
      return mapConversation(data);
    },

    async update(
      userId: string,
      id: string,
      input: UpdateConversationInput,
    ): Promise<Conversation | null> {
      const owner = assertUserId(userId);
      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title || title.length > 300) {
          throw new Error("title must contain 1 to 300 characters");
        }
        patch.title = title;
      }
      if (input.metadata !== undefined) patch.metadata = input.metadata;
      if (input.archivedAt !== undefined) {
        patch.archived_at =
          input.archivedAt === null
            ? null
            : assertTimestamp(input.archivedAt, "archivedAt");
      }
      if (Object.keys(patch).length === 0) return this.get(userId, id);

      const { data, error } = await client
        .from("agent_conversations")
        .update(patch)
        .eq("user_id", owner)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      throwIfError("conversations.update", error);
      return data ? mapConversation(data) : null;
    },

    async remove(userId: string, id: string): Promise<boolean> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_conversations")
        .delete()
        .eq("user_id", owner)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      throwIfError("conversations.remove", error);
      return Boolean(data);
    },
  };
}

export const createConversationRepository = conversationRepository;
