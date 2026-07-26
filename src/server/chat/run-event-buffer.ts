import type { AgentEvent } from "@/lib/agent";
import type {
  AppendRunEventInput,
  JsonObject,
  runEventRepository,
} from "@/lib/repositories";

type RunEventRepository = ReturnType<typeof runEventRepository>;

export interface RunEventBufferOptions {
  readonly repository: Pick<RunEventRepository, "appendBatch">;
  readonly userId: string;
  readonly runId: string;
  readonly maxBatchSize?: number;
}

/** Batches high-frequency delta events while flushing every lifecycle boundary. */
export class RunEventBuffer {
  readonly #repository: Pick<RunEventRepository, "appendBatch">;
  readonly #userId: string;
  readonly #runId: string;
  readonly #maxBatchSize: number;
  #pending: AppendRunEventInput[] = [];
  #lastSequence = 0;
  #closed = false;

  constructor(options: RunEventBufferOptions) {
    this.#repository = options.repository;
    this.#userId = options.userId;
    this.#runId = options.runId;
    this.#maxBatchSize = options.maxBatchSize ?? 20;
    if (!Number.isSafeInteger(this.#maxBatchSize) || this.#maxBatchSize < 1) {
      throw new RangeError("maxBatchSize must be a positive integer");
    }
  }

  async append(event: AgentEvent): Promise<void> {
    if (this.#closed) throw new Error("RunEventBuffer is closed");
    if (event.runId !== this.#runId) throw new Error("Run event belongs to another run");
    if (event.sequence <= this.#lastSequence) {
      throw new Error("Run-event sequences must be strictly increasing");
    }
    this.#lastSequence = event.sequence;
    const serialized = {
      sequence: event.sequence,
      type: event.type,
      event: toJsonObject(event),
    };
    const previous = this.#pending.at(-1);
    if (
      event.type === "delta" &&
      previous?.type === "delta" &&
      previous.event.round === event.round &&
      typeof previous.event.delta === "string"
    ) {
      this.#pending[this.#pending.length - 1] = {
        ...serialized,
        event: {
          ...serialized.event,
          delta: previous.event.delta + event.delta,
        },
      };
    } else {
      this.#pending.push(serialized);
    }
    if (event.type !== "delta" || this.#pending.length >= this.#maxBatchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.#pending.length === 0) return;
    const batch = this.#pending;
    this.#pending = [];
    try {
      await this.#repository.appendBatch(this.#userId, this.#runId, batch);
    } catch (error) {
      this.#pending = [...batch, ...this.#pending];
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.flush();
    this.#closed = true;
  }
}

function toJsonObject(value: unknown): JsonObject {
  const serialized = JSON.stringify(value);
  if (!serialized) throw new Error("Run event is not JSON serializable");
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Run event must serialize to an object");
  }
  return parsed as JsonObject;
}
