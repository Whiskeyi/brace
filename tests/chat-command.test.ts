import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const repositoryModule = vi.hoisted(() => ({
  createRepositories: vi.fn(),
}));

vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  return { ...actual, createRepositories: repositoryModule.createRepositories };
});

import type { AgentEvent } from "@/lib/agent";
import { serverConfigSchema } from "@/lib/config";
import type {
  AgentRepositories,
  AgentRun,
  AgentRunEvent,
  Conversation,
  JsonObject,
} from "@/lib/repositories";
import {
  ChatCommandError,
  prepareChatRun,
  resolveChatCommand,
  type ChatCommand,
} from "@/server/chat/command";

const conversationId = "10000000-0000-4000-8000-000000000000";
const userId = "user_1";
const timestamp = "2026-07-19T00:00:00.000Z";
const config = serverConfigSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: "https://example.com",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-at-least-16-characters",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-at-least-16-characters",
});

const conversation: Conversation = {
  id: conversationId,
  userId,
  title: "Conversation",
  metadata: {},
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
};

function completedRun(message: string): AgentRun {
  return {
    id: "run_1",
    conversationId,
    userId,
    idempotencyKey: "request-key-1",
    status: "completed",
    model: "model-1",
    input: { message },
    output: {
      content: "answer",
      rounds: 1,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    },
    error: null,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    heartbeatAt: timestamp,
    completedAt: timestamp,
  };
}

function storedEvent(event: AgentEvent): AgentRunEvent {
  return {
    runId: event.runId,
    userId,
    sequence: event.sequence,
    type: event.type,
    event: JSON.parse(JSON.stringify(event)) as JsonObject,
    createdAt: timestamp,
  };
}

function fakeRepositories(run: AgentRun, events: readonly AgentRunEvent[] = []) {
  const repositories = {
    conversations: { get: vi.fn().mockResolvedValue(conversation) },
    runs: { getByIdempotencyKey: vi.fn().mockResolvedValue(run) },
    runEvents: { list: vi.fn().mockResolvedValue(events) },
    messages: { list: vi.fn() },
  } as unknown as AgentRepositories;
  repositoryModule.createRepositories.mockReturnValue(repositories);
  return repositories;
}

function command(message = "hello"): ChatCommand {
  return { conversationId, message, idempotencyKey: "request-key-1" };
}

beforeEach(() => {
  repositoryModule.createRepositories.mockReset();
});

describe("resolveChatCommand", () => {
  it("accepts matching body and header keys after normalization", () => {
    const resolved = resolveChatCommand(
      {
        conversationId,
        message: "  hello  ",
        idempotencyKey: " request-key-1 ",
      },
      " request-key-1 ",
    );

    expect(resolved).toEqual({
      conversationId,
      message: "hello",
      idempotencyKey: "request-key-1",
    });
  });

  it("rejects conflicting body and header keys", () => {
    expect(() =>
      resolveChatCommand(
        { conversationId, message: "hello", idempotencyKey: "request-key-1" },
        "request-key-2",
      ),
    ).toThrow(
      expect.objectContaining<Partial<ChatCommandError>>({
        status: 400,
        code: "IDEMPOTENCY_MISMATCH",
      }),
    );
  });
});

describe("prepareChatRun idempotency", () => {
  it("rejects the same key when it is reused for a different payload", async () => {
    const repositories = fakeRepositories(completedRun("original message"));

    await expect(
      prepareChatRun({
        supabase: {} as SupabaseClient,
        userId,
        config,
        command: command("different message"),
        requestId: "request_1",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
    expect(repositories.runEvents.list).not.toHaveBeenCalled();
    expect(repositories.messages.list).not.toHaveBeenCalled();
  });

  it("replays a completed run with the same key and payload", async () => {
    const run = completedRun("hello");
    const events: AgentEvent[] = [
      {
        protocolVersion: 1,
        sequence: 1,
        timestamp,
        runId: run.id,
        type: "start",
        model: "model-1",
        maxRounds: 2,
        limits: {
          maxRounds: 2,
          maxToolCalls: 4,
          maxToolConcurrency: 2,
          maxModelOutputBytes: 4_096,
          toolTimeoutMs: 1_000,
          maxToolArgumentBytes: 1_024,
          maxToolResultBytes: 1_024,
        },
      },
      {
        protocolVersion: 1,
        sequence: 2,
        timestamp,
        runId: run.id,
        type: "delta",
        round: 1,
        delta: "answer",
      },
      {
        protocolVersion: 1,
        sequence: 3,
        timestamp,
        runId: run.id,
        type: "done",
        content: "answer",
        finishReason: "stop",
        rounds: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ];
    const repositories = fakeRepositories(run, events.map(storedEvent));

    const prepared = await prepareChatRun({
      supabase: {} as SupabaseClient,
      userId,
      config,
      command: command("hello"),
      requestId: "request_1",
    });

    expect(prepared).toMatchObject({ kind: "replay", run });
    expect(prepared.kind).toBe("replay");
    if (prepared.kind !== "replay") throw new Error("Expected replay.");
    expect(prepared.events).toEqual(
      events.map((event) => ({ ...event, replayed: true })),
    );
    expect(repositories.runEvents.list).toHaveBeenCalledWith(userId, run.id, {
      afterSequence: 0,
      limit: 2_000,
    });
    expect(repositories.messages.list).not.toHaveBeenCalled();
  });
});
