import { describe, expect, it, vi } from "vitest";

import type { AgentErrorInfo, AgentEvent } from "@/lib/agent";
import type {
  AgentRun,
  AgentRunEvent,
  AgentRunStep,
  AppendRunEventInput,
  AppendRunStepInput,
  FinalizeRunInput,
  UpdateRunStepInput,
} from "@/lib/repositories";
import { RunEventBuffer } from "@/server/chat/run-event-buffer";
import { RunRecorder } from "@/server/chat/run-recorder";

const timestamp = "2026-07-19T00:00:00.000Z";
const base = {
  protocolVersion: 1 as const,
  timestamp,
  runId: "run_1",
};

function run(status: AgentRun["status"]): AgentRun {
  return {
    id: "run_1",
    conversationId: "conversation_1",
    userId: "user_1",
    idempotencyKey: "request-key-1",
    status,
    model: "model-1",
    input: {},
    output: null,
    error: null,
    metadata: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    heartbeatAt: timestamp,
    completedAt: status === "running" ? null : timestamp,
  };
}

function step(input: AppendRunStepInput, id: string): AgentRunStep {
  return {
    id,
    runId: input.runId,
    userId: "user_1",
    position: input.position,
    kind: input.kind,
    name: input.name ?? null,
    status: input.status ?? "queued",
    input: input.input ?? {},
    output: null,
    error: null,
    metadata: input.metadata ?? {},
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: null,
  };
}

function harness() {
  const appendBatch = vi.fn(
    async (
      userId: string,
      runId: string,
      events: readonly AppendRunEventInput[],
    ): Promise<AgentRunEvent[]> => {
      void userId;
      void runId;
      void events;
      return [];
    },
  );
  const eventBuffer = new RunEventBuffer({
    repository: { appendBatch },
    userId: "user_1",
    runId: "run_1",
  });
  const append = vi.fn(
    async (_userId: string, input: AppendRunStepInput): Promise<AgentRunStep> =>
      step(input, `step_${input.position}`),
  );
  const update = vi.fn(
    async (
      userId: string,
      id: string,
      input: UpdateRunStepInput,
    ): Promise<AgentRunStep | null> => {
      void userId;
      void id;
      void input;
      return null;
    },
  );
  const finalize = vi.fn(
    async (
      _userId: string,
      _runId: string,
      input: FinalizeRunInput,
    ): Promise<AgentRun> => run(input.status),
  );
  const recorder = new RunRecorder({
    runs: { finalize },
    runSteps: { append, update },
    events: eventBuffer,
    userId: "user_1",
    runId: "run_1",
    conversationId: "conversation_1",
    idempotencyKey: "request-key-1",
    requestId: "request_1",
  });
  return { recorder, appendBatch, append, update, finalize };
}

function toolCall(sequence: number, round: number, callId: string): AgentEvent {
  return {
    ...base,
    sequence,
    type: "tool_call",
    round,
    callId,
    name: "work",
    rawArguments: "{}",
    arguments: { round },
  };
}

function toolResult(sequence: number, round: number, callId: string): AgentEvent {
  return {
    ...base,
    sequence,
    type: "tool_result",
    round,
    callId,
    name: "work",
    success: true,
    durationMs: round,
    output: { round },
    outputBytes: round * 10,
  };
}

describe("RunRecorder", () => {
  it("keys tool steps by round and callId without cross-round collisions", async () => {
    const { recorder, append, update } = harness();

    await recorder.record(toolCall(1, 1, "reused"));
    await recorder.record(toolCall(2, 2, "reused"));
    await recorder.record(toolResult(3, 2, "reused"));
    await recorder.record(toolResult(4, 1, "reused"));

    expect(
      append.mock.calls.map(([, input]) => ({
        position: input.position,
        metadata: input.metadata,
      })),
    ).toEqual([
      { position: 0, metadata: { callId: "reused", round: 1 } },
      { position: 1, metadata: { callId: "reused", round: 2 } },
    ]);
    expect(
      update.mock.calls.map(([, id, input]) => ({ id, input })),
    ).toEqual([
      {
        id: "step_1",
        input: {
          status: "completed",
          output: { round: 2 },
          error: null,
          metadata: {
            callId: "reused",
            round: 2,
            durationMs: 2,
            outputBytes: 20,
            truncated: false,
          },
        },
      },
      {
        id: "step_0",
        input: {
          status: "completed",
          output: { round: 1 },
          error: null,
          metadata: {
            callId: "reused",
            round: 1,
            durationMs: 1,
            outputBytes: 10,
            truncated: false,
          },
        },
      },
    ]);
  });

  it("finalizes done runs and delegates outstanding-step closure to the RPC", async () => {
    const { recorder, appendBatch, update, finalize } = harness();
    await recorder.record({ ...base, sequence: 1, type: "delta", round: 1, delta: "partial" });
    await recorder.record(toolCall(2, 1, "pending"));

    await recorder.record({
      ...base,
      sequence: 3,
      type: "done",
      content: "",
      finishReason: "stop",
      rounds: 1,
      usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
    });

    expect(update).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith("user_1", "run_1", {
      conversationId: "conversation_1",
      status: "completed",
      output: {
        content: "partial",
        rounds: 1,
        usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      },
      error: null,
      assistantContent: "partial",
      assistantMetadata: {
        requestKey: "request-key-1",
        requestId: "request_1",
        status: "completed",
        rounds: 1,
      },
      terminalEvent: {
        sequence: 3,
        type: "done",
        event: expect.objectContaining({ sequence: 3, type: "done", runId: "run_1" }),
      },
    });
    expect(recorder.finalized).toBe(true);
    expect(recorder.fullContent).toBe("partial");
    expect(recorder.lastSequence).toBe(3);
    expect(appendBatch.mock.calls.flatMap((call) => call[2]).some((event) =>
      event.type === "done"
    )).toBe(false);
    await expect(
      recorder.record({ ...base, sequence: 4, type: "delta", round: 1, delta: "late" }),
    ).rejects.toThrow(/after run finalization/);
  });

  it("finalizes error runs and delegates unfinished-step closure to the RPC", async () => {
    const { recorder, update, finalize } = harness();
    await recorder.record({ ...base, sequence: 1, type: "delta", round: 1, delta: "partial" });
    await recorder.record(toolCall(2, 1, "pending"));
    const error: AgentErrorInfo = {
      code: "llm_error",
      message: "model failed",
      retryable: true,
    };

    await recorder.record({ ...base, sequence: 3, type: "error", round: 1, error });

    expect(update).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith("user_1", "run_1", {
      conversationId: "conversation_1",
      status: "failed",
      output: { content: "partial" },
      error,
      assistantContent: "partial",
      assistantMetadata: {
        requestKey: "request-key-1",
        requestId: "request_1",
        status: "failed",
      },
      terminalEvent: {
        sequence: 3,
        type: "error",
        event: expect.objectContaining({ sequence: 3, type: "error", runId: "run_1" }),
      },
    });
    expect(recorder.finalized).toBe(true);
  });
});
