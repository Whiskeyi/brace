import {
  AGENT_EVENT_PROTOCOL_VERSION,
  type AgentErrorInfo,
  type AgentEvent,
} from "@/lib/agent";
import type {
  JsonValue,
  runRepository,
  runStepRepository,
} from "@/lib/repositories";

import { RunEventBuffer } from "./run-event-buffer";

type Runs = Pick<ReturnType<typeof runRepository>, "finalize">;
type RunSteps = Pick<ReturnType<typeof runStepRepository>, "append" | "update">;

export interface RunRecorderOptions {
  readonly runs: Runs;
  readonly runSteps: RunSteps;
  readonly events: RunEventBuffer;
  readonly userId: string;
  readonly runId: string;
  readonly conversationId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

interface RecordedStep {
  readonly id: string;
  readonly callId: string;
  readonly round: number;
  completed: boolean;
}

export class RunRecorder {
  readonly #runs: Runs;
  readonly #runSteps: RunSteps;
  readonly #events: RunEventBuffer;
  readonly #userId: string;
  readonly #runId: string;
  readonly #conversationId: string;
  readonly #idempotencyKey: string;
  readonly #requestId: string;
  readonly #steps = new Map<string, RecordedStep>();
  #nextStepPosition = 0;
  #fullContent = "";
  #finalized = false;
  #lastSequence = 0;

  constructor(options: RunRecorderOptions) {
    this.#runs = options.runs;
    this.#runSteps = options.runSteps;
    this.#events = options.events;
    this.#userId = options.userId;
    this.#runId = options.runId;
    this.#conversationId = options.conversationId;
    this.#idempotencyKey = options.idempotencyKey;
    this.#requestId = options.requestId;
  }

  get fullContent(): string {
    return this.#fullContent;
  }

  get runId(): string {
    return this.#runId;
  }

  get finalized(): boolean {
    return this.#finalized;
  }

  get lastSequence(): number {
    return this.#lastSequence;
  }

  async record(event: AgentEvent): Promise<void> {
    if (this.#finalized) throw new Error("Cannot record an event after run finalization");
    this.#lastSequence = event.sequence;
    if (event.type !== "done" && event.type !== "error") {
      await this.#events.append(event);
    } else {
      await this.#events.flush();
    }

    if (event.type === "delta") {
      this.#fullContent += event.delta;
      return;
    }
    if (event.type === "tool_call") {
      const step = await this.#runSteps.append(this.#userId, {
        runId: this.#runId,
        position: this.#nextStepPosition,
        kind: "tool_call",
        name: event.name,
        status: "running",
        input: toJsonValue(event.arguments ?? event.rawArguments),
        metadata: { callId: event.callId, round: event.round },
      });
      this.#nextStepPosition += 1;
      this.#steps.set(stepKey(event.round, event.callId), {
        id: step.id,
        callId: event.callId,
        round: event.round,
        completed: false,
      });
      return;
    }
    if (event.type === "tool_result") {
      const step = this.#steps.get(stepKey(event.round, event.callId));
      if (!step) return;
      await this.#runSteps.update(this.#userId, step.id, {
        status: event.success ? "completed" : "failed",
        output: event.success ? toJsonValue(event.output) : null,
        error: event.error ? toJsonValue(event.error) : null,
        metadata: {
          callId: step.callId,
          round: step.round,
          durationMs: event.durationMs,
          outputBytes: event.outputBytes ?? 0,
          truncated: event.truncated ?? false,
        },
      });
      step.completed = true;
      return;
    }
    if (event.type === "done") {
      const content = event.content || this.#fullContent;
      await this.#runs.finalize(this.#userId, this.#runId, {
        conversationId: this.#conversationId,
        status: "completed",
        output: toJsonValue({
          content,
          rounds: event.rounds,
          usage: event.usage,
        }),
        error: null,
        assistantContent: content,
        assistantMetadata: {
          requestKey: this.#idempotencyKey,
          requestId: this.#requestId,
          status: "completed",
          rounds: event.rounds,
        },
        terminalEvent: terminalEvent(event),
      });
      this.#finalized = true;
      await this.#events.close();
      return;
    }
    if (event.type === "error") {
      await this.#finalizeFailure(event.error, event);
    }
  }

  async finalizeUnexpected(error: AgentErrorInfo): Promise<void> {
    if (this.#finalized) return;
    const event: AgentEvent = {
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      sequence: this.#lastSequence + 1,
      timestamp: new Date().toISOString(),
      runId: this.#runId,
      type: "error",
      error,
    };
    this.#lastSequence = event.sequence;
    await this.#events.flush();
    await this.#finalizeFailure(error, event);
  }

  async #finalizeFailure(
    error: AgentErrorInfo,
    event: Extract<AgentEvent, { readonly type: "error" }>,
  ): Promise<void> {
    const cancelled = error.code === "aborted";
    await this.#runs.finalize(this.#userId, this.#runId, {
      conversationId: this.#conversationId,
      status: cancelled ? "cancelled" : "failed",
      output: toJsonValue({ content: this.#fullContent }),
      error: toJsonValue(error),
      assistantContent: this.#fullContent,
      assistantMetadata: {
        requestKey: this.#idempotencyKey,
        requestId: this.#requestId,
        status: cancelled ? "stopped" : "failed",
      },
      terminalEvent: terminalEvent(event),
    });
    this.#finalized = true;
    await this.#events.close();
  }
}

function stepKey(round: number, callId: string): string {
  return `${round}:${callId}`;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function terminalEvent(
  event: Extract<AgentEvent, { readonly type: "done" | "error" }>,
) {
  return {
    sequence: event.sequence,
    type: event.type,
    event: toJsonValue(event) as Extract<JsonValue, Record<string, JsonValue>>,
  };
}
