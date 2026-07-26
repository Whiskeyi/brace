import { AgentModelFailure } from "./errors";
import type { AgentModelChunk } from "./types";

export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 90_000;
export const DEFAULT_MODEL_STREAM_MAX_RETRIES = 1;
// Crossing either bound commits the attempt in order instead of risking
// unbounded memory while waiting for visible output.
const MAX_UNCOMMITTED_STREAM_BYTES = 1024 * 1024;
const MAX_UNCOMMITTED_STREAM_CHUNKS = 4_096;
const textEncoder = new TextEncoder();

export interface ModelStreamSupervisorOptions {
  readonly idleTimeoutMs?: number;
  readonly maxRetries?: number;
}

type StartModelStreamAttempt = (
  signal: AbortSignal,
) =>
  | AsyncIterable<AgentModelChunk>
  | PromiseLike<AsyncIterable<AgentModelChunk>>;

interface ResolvedModelStreamSupervisorOptions {
  readonly idleTimeoutMs: number;
  readonly maxRetries: number;
}

class IncompleteModelStreamError extends Error {
  constructor() {
    super("The model stream ended before reporting completion.");
    this.name = "IncompleteModelStreamError";
  }
}

class ModelStreamIdleTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The model stream was idle for ${timeoutMs}ms.`);
    this.name = "ModelStreamIdleTimeoutError";
  }
}

class ModelStreamAbortedError extends Error {
  constructor(reason: unknown) {
    super("The model request was aborted.", { cause: reason });
    this.name = "ModelStreamAbortedError";
  }
}

export class ModelStreamSupervisor {
  readonly #options: ResolvedModelStreamSupervisorOptions;

  constructor(options: ModelStreamSupervisorOptions = {}) {
    this.#options = resolveOptions(options);
  }

  supervise(
    startAttempt: StartModelStreamAttempt,
    signal?: AbortSignal,
  ): AsyncIterable<AgentModelChunk> {
    return this.#run(startAttempt, signal);
  }

  async *#run(
    startAttempt: StartModelStreamAttempt,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentModelChunk, void, void> {
    let committedAttempt = false;

    for (
      let attempt = 0;
      attempt <= this.#options.maxRetries;
      attempt += 1
    ) {
      if (signal?.aborted) {
        throw abortedFailure(signal.reason);
      }

      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      let iterator: AsyncIterator<AgentModelChunk> | undefined;
      let cleanedUp = false;
      const pendingChunks: AgentModelChunk[] = [];
      let pendingBytes = 0;
      const cleanup = async (reason?: unknown) => {
        if (cleanedUp) return;
        cleanedUp = true;
        signal?.removeEventListener("abort", forwardAbort);
        if (reason === undefined) return;
        if (!controller.signal.aborted) controller.abort(reason);
        await returnIterator(iterator);
      };

      try {
        const stream = await waitForActivity(
          Promise.resolve(startAttempt(controller.signal)),
          controller,
          this.#options.idleTimeoutMs,
        );
        iterator = stream[Symbol.asyncIterator]();
        let hasFinishReason = false;

        while (true) {
          const next = await waitForActivity(
            Promise.resolve(iterator.next()),
            controller,
            this.#options.idleTimeoutMs,
          );
          if (next.done) break;

          const chunk = next.value;
          if (hasNonEmptyFinishReason(chunk)) hasFinishReason = true;
          if (committedAttempt) {
            yield chunk;
            continue;
          }
          if (!hasVisibleContent(chunk)) {
            pendingChunks.push(chunk);
            pendingBytes += serializedBytes(chunk);
            if (
              pendingChunks.length >= MAX_UNCOMMITTED_STREAM_CHUNKS ||
              pendingBytes >= MAX_UNCOMMITTED_STREAM_BYTES
            ) {
              committedAttempt = true;
              yield* pendingChunks;
              pendingChunks.length = 0;
            }
            continue;
          }

          committedAttempt = true;
          yield* pendingChunks;
          pendingChunks.length = 0;
          yield chunk;
        }

        if (!hasFinishReason) throw new IncompleteModelStreamError();
        if (!committedAttempt) {
          committedAttempt = true;
          yield* pendingChunks;
        }
        await cleanup();
        return;
      } catch (error) {
        await cleanup(error);
        const failure = normalizeFailure(
          error,
          signal?.aborted === true,
          committedAttempt,
        );
        const canRetry =
          !committedAttempt &&
          failure.retryable &&
          attempt < this.#options.maxRetries;
        if (canRetry) continue;
        throw failure;
      } finally {
        await cleanup(new Error("The model stream attempt was closed."));
      }
    }
  }
}

function resolveOptions(
  options: ModelStreamSupervisorOptions,
): ResolvedModelStreamSupervisorOptions {
  const idleTimeoutMs =
    options.idleTimeoutMs ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS;
  const maxRetries =
    options.maxRetries ?? DEFAULT_MODEL_STREAM_MAX_RETRIES;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new RangeError("idleTimeoutMs must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError("maxRetries must be a non-negative safe integer.");
  }
  return { idleTimeoutMs, maxRetries };
}

function waitForActivity<T>(
  activity: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", handleAbort);
      callback();
    };
    const handleAbort = () => {
      finish(() => reject(new ModelStreamAbortedError(controller.signal.reason)));
    };
    const timeout = setTimeout(() => {
      finish(() => {
        const error = new ModelStreamIdleTimeoutError(timeoutMs);
        controller.abort(error);
        reject(error);
      });
    }, timeoutMs);

    controller.signal.addEventListener("abort", handleAbort, { once: true });
    if (controller.signal.aborted) {
      handleAbort();
      return;
    }
    activity.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function hasVisibleContent(chunk: AgentModelChunk): boolean {
  return typeof chunk.content === "string" && chunk.content.length > 0;
}

function serializedBytes(chunk: AgentModelChunk): number {
  try {
    return textEncoder.encode(JSON.stringify(chunk)).byteLength;
  } catch {
    return MAX_UNCOMMITTED_STREAM_BYTES;
  }
}

function hasNonEmptyFinishReason(chunk: AgentModelChunk): boolean {
  return (
    typeof chunk.finishReason === "string" &&
    chunk.finishReason.trim().length > 0
  );
}

function normalizeFailure(
  error: unknown,
  abortedByCaller: boolean,
  committedAttempt: boolean,
): AgentModelFailure {
  if (abortedByCaller || error instanceof ModelStreamAbortedError) {
    return abortedFailure(
      error instanceof ModelStreamAbortedError ? error.cause : error,
    );
  }

  const safeToRetry = !committedAttempt;
  if (error instanceof AgentModelFailure) {
    const retryable = error.retryable && safeToRetry;
    return retryable === error.retryable
      ? error
      : new AgentModelFailure(error.code, error.message, retryable, {
          cause: error,
        });
  }
  if (error instanceof IncompleteModelStreamError) {
    return new AgentModelFailure(
      "llm_error",
      error.message,
      safeToRetry,
      { cause: error },
    );
  }
  if (error instanceof ModelStreamIdleTimeoutError) {
    return new AgentModelFailure(
      "llm_error",
      error.message,
      safeToRetry,
      { cause: error },
    );
  }
  const status = errorStatus(error);
  const retryableStatus =
    status === null ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500;
  return new AgentModelFailure(
    "llm_error",
    "The model stream was interrupted before completion.",
    safeToRetry && retryableStatus,
    { cause: error },
  );
}

function abortedFailure(reason: unknown): AgentModelFailure {
  return new AgentModelFailure(
    "llm_error",
    "The model request was aborted.",
    false,
    { cause: reason },
  );
}

async function returnIterator(
  iterator: AsyncIterator<AgentModelChunk> | undefined,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const returned = iterator?.return?.();
    if (!returned) return;
    await Promise.race([
      Promise.resolve(returned).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 1_000);
      }),
    ]);
  } catch {
    return;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorStatus(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return null;
    if ("status" in current && typeof current.status === "number") {
      return current.status;
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}
