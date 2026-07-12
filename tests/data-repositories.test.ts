import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { conversationRepository } from "@/lib/repositories/conversations";
import { messageRepository } from "@/lib/repositories/messages";

type Call = [string, ...unknown[]];

function fluentClient(data: unknown = []) {
  const calls: Call[] = [];
  const query: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => void) => resolve({ data, error: null });
        }
        return (...args: unknown[]) => {
          calls.push([String(property), ...args]);
          return query;
        };
      },
    },
  );
  const client = {
    from(table: string) {
      calls.push(["from", table]);
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe("tenant-safe repositories", () => {
  it("always scopes conversation reads by the explicit user id", async () => {
    const { client, calls } = fluentClient();
    await conversationRepository(client).list("user-a", { limit: 10 });
    expect(calls).toContainEqual(["from", "agent_conversations"]);
    expect(calls).toContainEqual(["eq", "user_id", "user-a"]);
  });

  it("writes the explicit user id into every message insert", async () => {
    const row = {
      id: "message-id",
      conversation_id: "conversation-id",
      user_id: "user-a",
      role: "user",
      content: "hello",
      tool_name: null,
      tool_call_id: null,
      metadata: {},
      created_at: new Date().toISOString(),
    };
    const { client, calls } = fluentClient(row);
    await messageRepository(client).append("user-a", {
      conversationId: "conversation-id",
      role: "user",
      content: "hello",
    });
    const insert = calls.find(([method]) => method === "insert");
    expect(insert?.[1]).toMatchObject({
      user_id: "user-a",
      conversation_id: "conversation-id",
    });
  });
});

describe("database security migration", () => {
  it("contains RLS, owner policies, audit triggers, and no platform mutations", async () => {
    const path = fileURLToPath(
      new URL("../supabase/migrations/001_agent_data.sql", import.meta.url),
    );
    const sql = await readFile(path, "utf8");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("auth.uid() = user_id");
    expect(sql).toContain("agent_write_audit_event");
    expect(sql).toContain("revoke all on table");
    expect(sql).not.toMatch(/drop\s+(database|schema|role|user)/i);
    expect(sql).not.toMatch(/alter\s+(database|role|user)/i);
  });
});
