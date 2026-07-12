import type { SupabaseClient } from "@supabase/supabase-js";

import { mapMemory } from "./mappers";
import { assertUserId, boundedLimit, throwIfError } from "./shared";
import type { JsonObject, LongTermMemory } from "./types";

export interface UpsertMemoryInput {
  namespace?: string;
  key: string;
  content: string;
  summary?: string | null;
  importance?: number;
  metadata?: JsonObject;
  expiresAt?: string | null;
}

export interface ListMemoriesOptions {
  namespace?: string;
  limit?: number;
  minImportance?: number;
  includeExpired?: boolean;
}

function namespaceValue(value?: string): string {
  const namespace = value?.trim() || "default";
  if (namespace.length > 100) throw new Error("namespace is too long");
  return namespace;
}

export function memoryRepository(client: SupabaseClient) {
  return {
    async list(
      userId: string,
      options: ListMemoriesOptions = {},
    ): Promise<LongTermMemory[]> {
      const owner = assertUserId(userId);
      const limit = boundedLimit(options.limit, 50, 200);
      let query = client
        .from("agent_memories")
        .select("*")
        .eq("user_id", owner);
      if (options.namespace) query = query.eq("namespace", namespaceValue(options.namespace));
      if (options.minImportance !== undefined) {
        query = query.gte("importance", options.minImportance);
      }
      if (!options.includeExpired) {
        query = query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
      }
      const { data, error } = await query
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(limit);
      throwIfError("memories.list", error);
      return (data ?? []).map(mapMemory);
    },

    async search(
      userId: string,
      queryText: string,
      options: ListMemoriesOptions = {},
    ): Promise<LongTermMemory[]> {
      const owner = assertUserId(userId);
      const query = queryText.trim();
      if (!query) return [];
      const limit = boundedLimit(options.limit, 10, 50);
      let builder = client
        .from("agent_memories")
        .select("*")
        .eq("user_id", owner)
        .textSearch("search_document", query, {
          config: "simple",
          type: "websearch",
        });
      if (options.namespace) {
        builder = builder.eq("namespace", namespaceValue(options.namespace));
      }
      if (!options.includeExpired) {
        builder = builder.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
      }
      const { data, error } = await builder
        .order("importance", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(limit);
      throwIfError("memories.search", error);
      return (data ?? []).map(mapMemory);
    },

    async upsert(userId: string, input: UpsertMemoryInput): Promise<LongTermMemory> {
      const owner = assertUserId(userId);
      const key = input.key.trim();
      const content = input.content.trim();
      if (!key || key.length > 300) throw new Error("Invalid memory key");
      if (!content) throw new Error("Memory content is required");
      const importance = input.importance ?? 50;
      if (!Number.isInteger(importance) || importance < 0 || importance > 100) {
        throw new Error("importance must be an integer between 0 and 100");
      }
      const { data, error } = await client
        .from("agent_memories")
        .upsert(
          {
            user_id: owner,
            namespace: namespaceValue(input.namespace),
            key,
            content,
            summary: input.summary ?? null,
            importance,
            metadata: input.metadata ?? {},
            expires_at: input.expiresAt ?? null,
          },
          { onConflict: "user_id,namespace,key" },
        )
        .select("*")
        .single();
      throwIfError("memories.upsert", error);
      return mapMemory(data);
    },

    async markAccessed(userId: string, id: string): Promise<boolean> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_memories")
        .update({ last_accessed_at: new Date().toISOString() })
        .eq("user_id", owner)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      throwIfError("memories.markAccessed", error);
      return Boolean(data);
    },

    async remove(userId: string, id: string): Promise<boolean> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_memories")
        .delete()
        .eq("user_id", owner)
        .eq("id", id)
        .select("id")
        .maybeSingle();
      throwIfError("memories.remove", error);
      return Boolean(data);
    },
  };
}

export const createMemoryRepository = memoryRepository;
