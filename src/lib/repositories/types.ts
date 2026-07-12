export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface AgentMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: MessageRole;
  content: JsonValue;
  toolName: string | null;
  toolCallId: string | null;
  metadata: JsonObject;
  createdAt: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "requires_action"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRun {
  id: string;
  conversationId: string | null;
  userId: string;
  idempotencyKey: string;
  status: RunStatus;
  model: string | null;
  input: JsonValue;
  output: JsonValue | null;
  error: JsonValue | null;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type RunStepStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentRunStep {
  id: string;
  runId: string;
  userId: string;
  position: number;
  kind: string;
  name: string | null;
  status: RunStepStatus;
  input: JsonValue;
  output: JsonValue | null;
  error: JsonValue | null;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface LongTermMemory {
  id: string;
  userId: string;
  namespace: string;
  key: string;
  content: string;
  summary: string | null;
  importance: number;
  metadata: JsonObject;
  expiresAt: string | null;
  lastAccessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: number;
  userId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: JsonObject;
  createdAt: string;
}
