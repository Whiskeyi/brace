import type { SupabaseClient } from "@supabase/supabase-js";

import { mapAuditEvent } from "./mappers";
import { assertUserId, boundedLimit, throwIfError } from "./shared";
import type { AuditEvent } from "./types";

export interface ListAuditEventsOptions {
  limit?: number;
  beforeId?: number;
  resourceType?: string;
}

export function auditRepository(client: SupabaseClient) {
  return {
    /** Audit rows are database-triggered and intentionally read-only to users. */
    async list(
      userId: string,
      options: ListAuditEventsOptions = {},
    ): Promise<AuditEvent[]> {
      const owner = assertUserId(userId);
      const limit = boundedLimit(options.limit, 50, 200);
      let query = client
        .from("agent_audit_events")
        .select("*")
        .eq("user_id", owner);
      if (options.beforeId !== undefined) query = query.lt("id", options.beforeId);
      if (options.resourceType) {
        query = query.eq("resource_type", options.resourceType);
      }
      const { data, error } = await query
        .order("id", { ascending: false })
        .limit(limit);
      throwIfError("audit.list", error);
      return (data ?? []).map(mapAuditEvent);
    },
  };
}

export const createAuditRepository = auditRepository;
