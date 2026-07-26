import type { SupabaseClient } from "@supabase/supabase-js";

import { assertUserId, boundedLimit, throwIfError } from "./shared";
import type { AgentRunEvent, JsonObject } from "./types";

export interface AppendRunEventInput {
  readonly sequence: number;
  readonly type: string;
  readonly event: JsonObject;
}

export interface ListRunEventsOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export function runEventRepository(client: SupabaseClient) {
  return {
    async appendBatch(
      userId: string,
      runId: string,
      events: readonly AppendRunEventInput[],
    ): Promise<AgentRunEvent[]> {
      const owner = assertUserId(userId);
      if (events.length === 0) return [];
      if (events.length > 100) throw new Error("A run-event batch may contain at most 100 events");
      const seen = new Set<number>();
      const rows = events.map((event) => {
        if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
          throw new Error("Run-event sequence must be a positive integer");
        }
        if (seen.has(event.sequence)) throw new Error("Duplicate run-event sequence");
        seen.add(event.sequence);
        const type = event.type.trim();
        if (!type || type.length > 64) throw new Error("Invalid run-event type");
        return {
          user_id: owner,
          run_id: runId,
          sequence: event.sequence,
          type,
          event: event.event,
        };
      });
      const { data: stored, error } = await client.rpc("agent_append_run_events", {
        p_user_id: owner,
        p_run_id: runId,
        p_events: events,
      });
      throwIfError("runEvents.appendBatch", error);
      const mapped: AgentRunEvent[] = ((stored ?? []) as Record<string, unknown>[])
        .map(mapRunEvent);
      const expected = new Map(rows.map((row) => [row.sequence, row]));
      if (
        mapped.length !== rows.length ||
        mapped.some((row) => {
          const candidate = expected.get(row.sequence);
          return !candidate ||
            candidate.type !== row.type ||
            stableJson(candidate.event) !== stableJson(row.event);
        })
      ) {
        throw new Error("Run-event idempotency conflict");
      }
      return mapped.sort((left, right) => left.sequence - right.sequence);
    },

    async list(
      userId: string,
      runId: string,
      options: ListRunEventsOptions = {},
    ): Promise<AgentRunEvent[]> {
      const owner = assertUserId(userId);
      const limit = boundedLimit(options.limit, 500, 2_000);
      const after = options.afterSequence ?? 0;
      if (!Number.isSafeInteger(after) || after < 0) {
        throw new Error("afterSequence must be a non-negative integer");
      }
      const { data, error } = await client
        .from("agent_run_events")
        .select("*")
        .eq("user_id", owner)
        .eq("run_id", runId)
        .gt("sequence", after)
        .order("sequence", { ascending: true })
        .limit(limit);
      throwIfError("runEvents.list", error);
      return (data ?? []).map(mapRunEvent);
    },
  };
}

function mapRunEvent(row: Record<string, unknown>): AgentRunEvent {
  return {
    runId: row.run_id as string,
    userId: row.user_id as string,
    sequence: row.sequence as number,
    type: row.type as string,
    event: row.event as JsonObject,
    createdAt: row.created_at as string,
  };
}

export const createRunEventRepository = runEventRepository;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
