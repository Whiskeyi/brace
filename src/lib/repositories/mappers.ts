import type {
  AgentMessage,
  AgentRun,
  AgentRunStep,
  AuditEvent,
  Conversation,
  JsonObject,
  JsonValue,
  LongTermMemory,
  MessageRole,
  RunStatus,
  RunStepStatus,
} from "./types";

type Row = Record<string, unknown>;

const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

export const mapConversation = (row: Row): Conversation => ({
  id: row.id as string,
  userId: row.user_id as string,
  title: row.title as string,
  metadata: object(row.metadata),
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
  archivedAt: (row.archived_at as string | null) ?? null,
});

export const mapMessage = (row: Row): AgentMessage => ({
  id: row.id as string,
  conversationId: row.conversation_id as string,
  userId: row.user_id as string,
  role: row.role as MessageRole,
  content: row.content as JsonValue,
  toolName: (row.tool_name as string | null) ?? null,
  toolCallId: (row.tool_call_id as string | null) ?? null,
  metadata: object(row.metadata),
  createdAt: row.created_at as string,
});

export const mapRun = (row: Row): AgentRun => ({
  id: row.id as string,
  conversationId: (row.conversation_id as string | null) ?? null,
  userId: row.user_id as string,
  idempotencyKey: row.idempotency_key as string,
  status: row.status as RunStatus,
  model: (row.model as string | null) ?? null,
  input: row.input as JsonValue,
  output: (row.output as JsonValue | null) ?? null,
  error: (row.error as JsonValue | null) ?? null,
  metadata: object(row.metadata),
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
  startedAt: (row.started_at as string | null) ?? null,
  heartbeatAt: (row.heartbeat_at as string | null) ?? null,
  completedAt: (row.completed_at as string | null) ?? null,
});

export const mapRunStep = (row: Row): AgentRunStep => ({
  id: row.id as string,
  runId: row.run_id as string,
  userId: row.user_id as string,
  position: row.position as number,
  kind: row.kind as string,
  name: (row.name as string | null) ?? null,
  status: row.status as RunStepStatus,
  input: row.input as JsonValue,
  output: (row.output as JsonValue | null) ?? null,
  error: (row.error as JsonValue | null) ?? null,
  metadata: object(row.metadata),
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
  startedAt: (row.started_at as string | null) ?? null,
  completedAt: (row.completed_at as string | null) ?? null,
});

export const mapMemory = (row: Row): LongTermMemory => ({
  id: row.id as string,
  userId: row.user_id as string,
  namespace: row.namespace as string,
  key: row.key as string,
  content: row.content as string,
  summary: (row.summary as string | null) ?? null,
  importance: row.importance as number,
  metadata: object(row.metadata),
  expiresAt: (row.expires_at as string | null) ?? null,
  lastAccessedAt: (row.last_accessed_at as string | null) ?? null,
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
});

export const mapAuditEvent = (row: Row): AuditEvent => ({
  id: Number(row.id),
  userId: (row.user_id as string | null) ?? null,
  actorUserId: (row.actor_user_id as string | null) ?? null,
  action: row.action as string,
  resourceType: row.resource_type as string,
  resourceId: (row.resource_id as string | null) ?? null,
  details: object(row.details),
  createdAt: row.created_at as string,
});
