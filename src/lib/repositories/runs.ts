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

export interface BeginRunInput extends CreateRunInput {
  readonly userContent: JsonValue;
  readonly userMetadata?: JsonObject;
}

export interface FinalizeRunInput {
  readonly conversationId: string;
  readonly status: Extract<RunStatus, "completed" | "failed" | "cancelled">;
  readonly output: JsonValue | null;
  readonly error: JsonValue | null;
  readonly assistantContent: JsonValue;
  readonly assistantMetadata?: JsonObject;
  readonly terminalEvent: {
    readonly sequence: number;
    readonly type: "done" | "error";
    readonly event: JsonObject;
  };
}

export interface UpdateRunInput {
  status?: RunStatus;
  output?: JsonValue | null;
  error?: JsonValue | null;
  metadata?: JsonObject;
  startedAt?: string | null;
  heartbeatAt?: string | null;
  completedAt?: string | null;
}

export interface TransitionRunInput extends Omit<UpdateRunInput, "status"> {
  readonly from: readonly RunStatus[];
  readonly to: RunStatus;
}

export interface RecoverStaleRunInput {
  readonly conversationId: string;
  readonly staleAfterSeconds: number;
  readonly error: JsonObject;
  readonly assistantMetadata?: JsonObject;
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
    async begin(userId: string, input: BeginRunInput): Promise<AgentRun> {
      const owner = assertUserId(userId);
      const idempotencyKey = input.idempotencyKey.trim();
      if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(idempotencyKey)) {
        throw new Error("Invalid idempotency key");
      }
      if (!input.conversationId) throw new Error("conversationId is required");
      const { data, error } = await client
        .rpc("agent_begin_run", {
          p_user_id: owner,
          p_idempotency_key: idempotencyKey,
          p_conversation_id: input.conversationId,
          p_input: input.input,
          p_model: input.model ?? null,
          p_run_metadata: input.metadata ?? {},
          p_user_content: input.userContent,
          p_user_metadata: input.userMetadata ?? {},
        })
        .single();
      throwIfError("runs.begin", error);
      return mapRun(data as Record<string, unknown>);
    },

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
      return mapRun(data as Record<string, unknown>);
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

    async getActiveForConversation(
      userId: string,
      conversationId: string,
    ): Promise<AgentRun | null> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_runs")
        .select("*")
        .eq("user_id", owner)
        .eq("conversation_id", conversationId)
        .in("status", ["queued", "running", "requires_action"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      throwIfError("runs.getActiveForConversation", error);
      return data ? mapRun(data) : null;
    },

    async heartbeat(userId: string, id: string): Promise<boolean> {
      const owner = assertUserId(userId);
      const { data, error } = await client
        .from("agent_runs")
        .update({ heartbeat_at: new Date().toISOString() })
        .eq("user_id", owner)
        .eq("id", id)
        .eq("status", "running")
        .select("id")
        .maybeSingle();
      throwIfError("runs.heartbeat", error);
      return Boolean(data);
    },

    async recoverStale(
      userId: string,
      id: string,
      input: RecoverStaleRunInput,
    ): Promise<AgentRun | null> {
      const owner = assertUserId(userId);
      if (!Number.isSafeInteger(input.staleAfterSeconds) || input.staleAfterSeconds < 1) {
        throw new Error("staleAfterSeconds must be a positive integer");
      }
      const { data, error } = await client
        .rpc("agent_recover_stale_run", {
          p_user_id: owner,
          p_run_id: id,
          p_conversation_id: input.conversationId,
          p_stale_after_seconds: input.staleAfterSeconds,
          p_error: input.error,
          p_assistant_metadata: input.assistantMetadata ?? {},
        })
        .maybeSingle();
      throwIfError("runs.recoverStale", error);
      return data ? mapRun(data as Record<string, unknown>) : null;
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
      const patch = runPatch(input);
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

    async transition(
      userId: string,
      id: string,
      input: TransitionRunInput,
    ): Promise<AgentRun | null> {
      const owner = assertUserId(userId);
      if (!runStatuses.has(input.to)) throw new Error("Unsupported run status");
      if (input.from.length === 0) throw new Error("At least one expected run status is required");
      const from = [...new Set(input.from)];
      for (const status of from) {
        if (!runStatuses.has(status)) throw new Error("Unsupported expected run status");
        if (!canTransitionRun(status, input.to)) {
          throw new Error(`Invalid run transition: ${status} -> ${input.to}`);
        }
      }
      const patch = runPatch({ ...input, status: input.to });
      const { data, error } = await client
        .from("agent_runs")
        .update(patch)
        .eq("user_id", owner)
        .eq("id", id)
        .in("status", from)
        .select("*")
        .maybeSingle();
      throwIfError("runs.transition", error);
      return data ? mapRun(data) : null;
    },

    async finalize(
      userId: string,
      id: string,
      input: FinalizeRunInput,
    ): Promise<AgentRun> {
      const owner = assertUserId(userId);
      const parameters = {
          p_user_id: owner,
          p_run_id: id,
          p_conversation_id: input.conversationId,
          p_status: input.status,
          p_output: input.output,
          p_error: input.error,
          p_assistant_content: input.assistantContent,
          p_assistant_metadata: input.assistantMetadata ?? {},
          p_terminal_sequence: input.terminalEvent.sequence,
          p_terminal_type: input.terminalEvent.type,
          p_terminal_event: input.terminalEvent.event,
        };
      const invoke = () => client.rpc("agent_finalize_run", parameters).single();
      let { data, error } = await invoke();
      if (error) {
        // The RPC is idempotent for an identical terminal event and projection,
        // so retrying the same payload safely resolves a committed transaction
        // whose response was lost in transit.
        ({ data, error } = await invoke());
      }
      throwIfError("runs.finalize", error);
      return mapRun(data as Record<string, unknown>);
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

const runTransitions: Readonly<Record<RunStatus, ReadonlySet<RunStatus>>> = {
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["requires_action", "completed", "failed", "cancelled"]),
  requires_action: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return runTransitions[from].has(to);
}

function runPatch(input: UpdateRunInput): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.output !== undefined) patch.output = input.output;
  if (input.error !== undefined) patch.error = input.error;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  if (input.startedAt !== undefined) patch.started_at = input.startedAt;
  if (input.heartbeatAt !== undefined) patch.heartbeat_at = input.heartbeatAt;
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
  return patch;
}
