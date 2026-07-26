import "server-only";

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  AGENT_EVENT_PROTOCOL_VERSION,
  parseAgentEvent,
  type AgentEvent,
  type AgentLimits,
  type AgentMessage,
  type AgentUsage,
} from "@/lib/agent";
import type { ServerConfig } from "@/lib/config";
import {
  createRepositories,
  RepositoryError,
  type AgentRepositories,
  type AgentRun,
  type Conversation,
} from "@/lib/repositories";
import { SERVER_AGENT_SYSTEM_PROMPT } from "@/server/agent/prompt";

import { buildAgentContext, ContextWindowExceededError } from "./context";

const MAX_MESSAGE_LENGTH = 16_000;
const MAX_REPLAY_EVENTS = 10_000;
const MAX_REPLAY_BYTES = 32 * 1024 * 1024;
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const chatCommandSchema = z
  .object({
    conversationId: z.string().uuid(),
    message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();

export type ChatCommand = z.infer<typeof chatCommandSchema> & {
  readonly idempotencyKey: string;
};

export interface PrepareChatRunInput {
  readonly supabase: SupabaseClient;
  readonly userId: string;
  readonly config: ServerConfig;
  readonly command: ChatCommand;
  readonly requestId: string;
}

export interface ExecutableChatRun {
  readonly kind: "execute";
  readonly conversation: Conversation;
  readonly run: AgentRun;
  readonly messages: readonly AgentMessage[];
  readonly repositories: AgentRepositories;
  readonly requestHash: string;
}

export interface ReplayChatRun {
  readonly kind: "replay";
  readonly run: AgentRun;
  readonly events: readonly AgentEvent[];
}

export type PreparedChatRun = ExecutableChatRun | ReplayChatRun;

export class ChatCommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ChatCommandError";
  }
}

export function resolveChatCommand(
  body: unknown,
  headerKey: string | null,
): ChatCommand {
  const parsed = chatCommandSchema.parse(body);
  const normalizedHeader = headerKey?.trim() || undefined;
  const idempotencyKey = idempotencyKeySchema.parse(
    normalizedHeader ?? parsed.idempotencyKey,
  );
  if (
    normalizedHeader &&
    parsed.idempotencyKey &&
    normalizedHeader !== parsed.idempotencyKey
  ) {
    throw new ChatCommandError(400, "IDEMPOTENCY_MISMATCH", "幂等键不一致");
  }
  return { ...parsed, idempotencyKey };
}

export async function prepareChatRun(
  input: PrepareChatRunInput,
): Promise<PreparedChatRun> {
  const repositories = createRepositories(input.supabase);
  const conversation = await repositories.conversations.get(
    input.userId,
    input.command.conversationId,
  );
  if (!conversation) {
    throw new ChatCommandError(404, "NOT_FOUND", "会话不存在");
  }

  const requestHash = hashRequest(input.command);
  const existing = await repositories.runs.getByIdempotencyKey(
    input.userId,
    input.command.idempotencyKey,
  );
  if (existing) {
    if (!sameRequest(existing, input.command, requestHash)) {
      throw new ChatCommandError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "同一幂等键已用于不同请求",
      );
    }
    if (existing.status === "completed") {
      return {
        kind: "replay",
        run: existing,
        events: await replayEvents(repositories, input.userId, existing, input.config),
      };
    }
    if (["queued", "running", "requires_action"].includes(existing.status)) {
      const recovered = await recoverStaleRun(
        repositories,
        input.userId,
        existing,
        input.config,
      );
      if (!recovered) {
        throw new ChatCommandError(
          409,
          "REQUEST_ALREADY_EXISTS",
          "相同消息正在处理中",
          { status: existing.status },
        );
      }
    }
    throw new ChatCommandError(
      409,
      "REQUEST_ALREADY_EXISTS",
      "该请求已经结束，请使用新的幂等键重试",
      { status: "failed" },
    );
  }

  const active = await repositories.runs.getActiveForConversation(
    input.userId,
    conversation.id,
  );
  if (active) {
    const recovered = await recoverStaleRun(
      repositories,
      input.userId,
      active,
      input.config,
    );
    if (!recovered) {
      throw new ChatCommandError(
        409,
        "CONVERSATION_BUSY",
        "该会话已有任务正在处理",
        { runId: active.id, status: active.status },
      );
    }
  }

  const history = await repositories.messages.list(input.userId, conversation.id, {
    limit: Math.min(input.config.AGENT_MAX_HISTORY_MESSAGES * 3, 500),
  });
  let context;
  try {
    context = buildAgentContext({
      history,
      userMessage: input.command.message,
      systemPrompt: SERVER_AGENT_SYSTEM_PROMPT,
      maxHistoryMessages: input.config.AGENT_MAX_HISTORY_MESSAGES,
      contextWindowTokens: input.config.AGENT_CONTEXT_WINDOW_TOKENS,
      reservedOutputTokens: Math.min(
        input.config.LLM_MAX_OUTPUT_TOKENS,
        Math.floor(input.config.AGENT_CONTEXT_WINDOW_TOKENS / 2),
      ),
    });
  } catch (error) {
    if (error instanceof ContextWindowExceededError) {
      throw new ChatCommandError(
        413,
        "CONTEXT_TOO_LARGE",
        "当前消息超过模型上下文窗口",
        {
          requiredTokens: error.requiredTokens,
          contextWindowTokens: error.contextWindowTokens,
        },
      );
    }
    throw error;
  }

  let run: AgentRun;
  try {
    run = await repositories.runs.begin(input.userId, {
      idempotencyKey: input.command.idempotencyKey,
      conversationId: conversation.id,
      input: { message: input.command.message, requestHash },
      model: input.config.LLM_MODEL,
      metadata: {
        requestId: input.requestId,
        requestHash,
        context: {
          estimatedTokens: context.estimatedTokens,
          includedHistoryMessages: context.includedHistoryMessages,
          droppedHistoryMessages: context.droppedHistoryMessages,
        },
      },
      userContent: input.command.message,
      userMetadata: {
        idempotencyKey: input.command.idempotencyKey,
        requestId: input.requestId,
        requestHash,
      },
    });
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "23505") {
      throw new ChatCommandError(
        409,
        "REQUEST_IN_PROGRESS",
        "该会话已有任务正在处理",
      );
    }
    throw error;
  }

  return {
    kind: "execute",
    conversation,
    run,
    messages: context.messages,
    repositories,
    requestHash,
  };
}

async function recoverStaleRun(
  repositories: AgentRepositories,
  userId: string,
  run: AgentRun,
  config: ServerConfig,
): Promise<boolean> {
  const staleAfterSeconds = Math.max(
    1,
    Math.ceil((config.AGENT_REQUEST_TIMEOUT_MS * 2) / 1_000),
  );
  const recovered = await repositories.runs.recoverStale(userId, run.id, {
    conversationId: run.conversationId ?? "",
    staleAfterSeconds,
    error: {
      code: "llm_error",
      message: "Run heartbeat expired before completion.",
      retryable: true,
    },
    assistantMetadata: {
      requestKey: run.idempotencyKey,
      status: "failed",
      recoveredFromStaleLease: true,
    },
  });
  return recovered !== null;
}

function hashRequest(command: Pick<ChatCommand, "conversationId" | "message">): string {
  return createHash("sha256")
    .update(command.conversationId)
    .update("\0")
    .update(command.message)
    .digest("hex");
}

function sameRequest(
  run: AgentRun,
  command: ChatCommand,
  requestHash: string,
): boolean {
  if (run.conversationId !== command.conversationId) return false;
  if (run.metadata.requestHash !== undefined) {
    return run.metadata.requestHash === requestHash;
  }
  return (
    run.input !== null &&
    typeof run.input === "object" &&
    !Array.isArray(run.input) &&
    run.input.message === command.message
  );
}

async function replayEvents(
  repositories: AgentRepositories,
  userId: string,
  run: AgentRun,
  config: ServerConfig,
): Promise<AgentEvent[]> {
  const stored: Awaited<ReturnType<AgentRepositories["runEvents"]["list"]>> = [];
  let afterSequence = 0;
  let replayBytes = 0;
  while (true) {
    const page = await repositories.runEvents.list(userId, run.id, {
      afterSequence,
      limit: 2_000,
    });
    for (const row of page) {
      replayBytes += new TextEncoder().encode(JSON.stringify(row.event)).byteLength;
      if (stored.length >= MAX_REPLAY_EVENTS || replayBytes > MAX_REPLAY_BYTES) {
        return syntheticReplayEvents(run, config);
      }
      stored.push(row);
    }
    if (page.length < 2_000) break;
    afterSequence = page.at(-1)?.sequence ?? afterSequence;
  }

  try {
    const events = stored.map((row) => parseAgentEvent(row.event));
    const ordered = events.every(
      (event, index) =>
        event.runId === run.id &&
        stored[index]?.sequence === event.sequence &&
        stored[index]?.type === event.type &&
        (index !== 0 || (event.type === "start" && event.sequence === 1)) &&
        (index === events.length - 1 || (event.type !== "done" && event.type !== "error")) &&
        (index === 0 || event.sequence > events[index - 1].sequence),
    );
    if (
      ordered &&
      events[0]?.type === "start" &&
      events.at(-1)?.type === "done"
    ) {
      return events.map((event) => ({ ...event, replayed: true }));
    }
  } catch {
    // Old or corrupt event logs fall back to the completed run projection.
  }

  return syntheticReplayEvents(run, config);
}

function syntheticReplayEvents(run: AgentRun, config: ServerConfig): AgentEvent[] {
  const output = run.output && typeof run.output === "object" && !Array.isArray(run.output)
    ? run.output
    : {};
  const content = typeof output.content === "string" ? output.content : "";
  const usage = isUsage(output.usage) ? output.usage : emptyUsage();
  const rounds = typeof output.rounds === "number" && output.rounds > 0
    ? Math.floor(output.rounds)
    : 1;
  const timestamp = run.completedAt ?? run.updatedAt;
  const limits: AgentLimits = {
    maxRounds: config.AGENT_MAX_TOOL_ROUNDS,
    maxToolCalls: config.AGENT_MAX_TOOL_CALLS,
    maxToolConcurrency: config.AGENT_MAX_TOOL_CONCURRENCY,
    maxModelOutputBytes: config.AGENT_MAX_MODEL_OUTPUT_BYTES,
    toolTimeoutMs: config.AGENT_TOOL_TIMEOUT_MS,
    maxToolArgumentBytes: config.AGENT_MAX_TOOL_ARGUMENT_BYTES,
    maxToolResultBytes: config.AGENT_MAX_TOOL_RESULT_BYTES,
  };
  return [
    {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      sequence: 1,
      timestamp,
      runId: run.id,
      replayed: true,
      type: "start",
      model: run.model ?? config.LLM_MODEL,
      maxRounds: limits.maxRounds,
      limits,
    },
    ...(content
      ? [{
          protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
          sequence: 2,
          timestamp,
          runId: run.id,
          replayed: true as const,
          type: "delta" as const,
          round: rounds,
          delta: content,
        }]
      : []),
    {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      sequence: content ? 3 : 2,
      timestamp,
      runId: run.id,
      replayed: true,
      type: "done",
      content,
      finishReason: "replay",
      rounds,
      usage,
    },
  ];
}

function isUsage(value: unknown): value is AgentUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return ["promptTokens", "completionTokens", "totalTokens"].every(
    (key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0,
  );
}

function emptyUsage(): AgentUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}
