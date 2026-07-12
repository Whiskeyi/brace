import type { SupabaseClient } from "@supabase/supabase-js";

import { mapRun, mapRunStep } from "./mappers";
import { assertUserId, boundedLimit, throwIfError } from "./shared";
import type {
  AgentRun,
  AgentRunStep,
  JsonObject,
  JsonValue,
  RunStatus,
  RunStepStatus,
} from "./types";

const runStatuses = new Set<RunStatus>([
  "queued",
  "running",
  "requires_action",
  "completed",
  "failed",
  "cancelled",
]);
const stepStatuses = new Set<RunStepStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export interface CreateRunInput {
  idempotencyKey: string;
  conversationId?: string | null;
  input: JsonValue;
  model?: string | null;
  metadata?: JsonObject;
}

export interface UpdateRunInput {
  status?: RunStatus;
  output?: JsonValue | null;
  error?: JsonValue | null;
  metadata?: JsonObject;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface AppendRunStepInput {
  runId: string;
  position: number;
  kind: string;
  name?: string | null;
  input?: JsonValue;
  status?: RunStepStatus;
  metadata?: JsonObject;
}

export interface UpdateRunStepInput {
  status?: RunStepStatus;
  output?: JsonValue | null;
  error?: JsonValue | null;
  metadata?: JsonObject;
  startedAt?: string | null;
  completedAt?: string | null;
}

export function runRepository(client: SupabaseClient) {
  return {
    async create(userId: string, input: CreateRunInput): Promise<AgentRun> {
      const owner = assertUserId(userId);
      const idempotencyKey = input.idempotencyKey.trim();
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) {
        throw new Error("Invalid idempotency key");
      }
      const { data, error } = await client
        .from("agent_runs")
        .insert({
          user_id: owner,
          idempotency_key: idempotencyKey,
          conversation_id: input.conversationId ?? null,
          status: "queued",
          input: input.input,
          model: input.model ?? null,
          metadata: input.metadata ?? {},
        })
        .select("*")
        .single();
      throwIfError("runs.create", error);
      return mapRun(data);
    },

    async getByIdempotencyKey(
      userId: string,
      idempotencyKeyValue: string,
    ): Promise<AgentRun | null> {
      const owner = assertUserId(userId);
      const idempotencyKey = idempotencyKeyValue.trim();
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) {
        throw new Error("Invalid idempotency key");
      }
      const { data, error } = await client
        .from("agent_runs")
        .select("*")
        .eq("user_id", owner)
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      throwIfError("runs.getByIdempotencyKey", error);
      return data ? mapRun(data) : null;
    },

    async get(userId: string, id: string): Promise<AgentRun | null> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_runs")
        .select("*")
        .eq("user_id", owner)
        .eq("id", id)
        .maybeSingle();
      throwIfError("runs.get", error);
      return data ? mapRun(data) : null;
    },

    async listForConversation(
      userId: string,
      conversationId: string,
      limitValue?: number,
    ): Promise<AgentRun[]> {
      const owner = assertUserId(userId);
      const limit = boundedLimit(limitValue, 20, 100);
      const { data, error } = await client
        .from("agent_runs")
        .select("*")
        .eq("user_id", owner)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(limit);
      throwIfError("runs.listForConversation", error);
      return (data ?? []).map(mapRun);
    },

    async update(
      userId: string,
      id: string,
      input: UpdateRunInput,
    ): Promise<AgentRun | null> {
      const owner = assertUserId(userId);
      if (input.status && !runStatuses.has(input.status)) {
        throw new Error("Unsupported run status");
      }
      const patch: Record<string, unknown> = {};
      if (input.status !== undefined) patch.status = input.status;
      if (input.output !== undefined) patch.output = input.output;
      if (input.error !== undefined) patch.error = input.error;
      if (input.metadata !== undefined) patch.metadata = input.metadata;
      if (input.startedAt !== undefined) patch.started_at = input.startedAt;
      if (input.completedAt !== undefined) patch.completed_at = input.completedAt;
      if (input.status === "running" && input.startedAt === undefined) {
        patch.started_at = new Date().toISOString();
      }
      if (
        input.status &&
        ["completed", "failed", "cancelled"].includes(input.status) &&
        input.completedAt === undefined
      ) {
        patch.completed_at = new Date().toISOString();
      }
      if (Object.keys(patch).length === 0) return this.get(userId, id);
      const { data, error } = await client
        .from("agent_runs")
        .update(patch)
        .eq("user_id", owner)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      throwIfError("runs.update", error);
      return data ? mapRun(data) : null;
    },
  };
}

export function runStepRepository(client: SupabaseClient) {
  return {
    async list(userId: string, runId: string): Promise<AgentRunStep[]> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_run_steps")
        .select("*")
        .eq("user_id", owner)
        .eq("run_id", runId)
        .order("position", { ascending: true });
      throwIfError("runSteps.list", error);
      return (data ?? []).map(mapRunStep);
    },

    async append(userId: string, input: AppendRunStepInput): Promise<AgentRunStep> {
      const owner = assertUserId(userId);
      if (!Number.isInteger(input.position) || input.position < 0) {
        throw new Error("position must be a non-negative integer");
      }
      if (input.status && !stepStatuses.has(input.status)) {
        throw new Error("Unsupported run step status");
      }
      const kind = input.kind.trim();
      if (!kind || kind.length > 100) throw new Error("Invalid run step kind");
      const { data, error } = await client
        .from("agent_run_steps")
        .insert({
          user_id: owner,
          run_id: input.runId,
          position: input.position,
          kind,
          name: input.name ?? null,
          status: input.status ?? "queued",
          input: input.input ?? {},
          metadata: input.metadata ?? {},
        })
        .select("*")
        .single();
      throwIfError("runSteps.append", error);
      return mapRunStep(data);
    },

    async update(
      userId: string,
      id: string,
      input: UpdateRunStepInput,
    ): Promise<AgentRunStep | null> {
      const owner = assertUserId(userId);
      if (input.status && !stepStatuses.has(input.status)) {
        throw new Error("Unsupported run step status");
      }
      const patch: Record<string, unknown> = {};
      if (input.status !== undefined) patch.status = input.status;
      if (input.output !== undefined) patch.output = input.output;
      if (input.error !== undefined) patch.error = input.error;
      if (input.metadata !== undefined) patch.metadata = input.metadata;
      if (input.startedAt !== undefined) patch.started_at = input.startedAt;
      if (input.completedAt !== undefined) patch.completed_at = input.completedAt;
      if (input.status === "running" && input.startedAt === undefined) {
        patch.started_at = new Date().toISOString();
      }
      if (
        input.status &&
        ["completed", "failed", "cancelled"].includes(input.status) &&
        input.completedAt === undefined
      ) {
        patch.completed_at = new Date().toISOString();
      }
      const { data, error } = await client
        .from("agent_run_steps")
        .update(patch)
        .eq("user_id", owner)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      throwIfError("runSteps.update", error);
      return data ? mapRunStep(data) : null;
    },
  };
}

export const createRunRepository = runRepository;
export const createRunStepRepository = runStepRepository;
