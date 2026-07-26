import {
  AGENT_EVENT_PROTOCOL_VERSION,
  encodeAgentEvent,
  encodeAgentHeartbeat,
  encodeAgentStreamEnd,
  type AgentErrorInfo,
  type AgentEvent,
} from "@/lib/agent";

import type { RunRecorder } from "./run-recorder";

export interface RecordedAgentStreamOptions {
  readonly events: AsyncIterable<AgentEvent>;
  readonly recorder: RunRecorder;
  readonly controller: AbortController;
  readonly heartbeatMs?: number;
  readonly maxQueuedFrames?: number;
  readonly onHeartbeat?: () => void | Promise<void>;
  readonly onSettled?: () => void;
}

const DEFAULT_MAX_QUEUED_FRAMES = 64;

export function createRecordedAgentStream(
  options: RecordedAgentStreamOptions,
): ReadableStream<Uint8Array> {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1_000) {
    throw new RangeError("heartbeatMs must be an integer of at least 1000ms");
  }
  const maxQueuedFrames =
    options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
  if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames < 1) {
    throw new RangeError("maxQueuedFrames must be a positive integer");
  }

  const encoder = new TextEncoder();
  const iterator = options.events[Symbol.asyncIterator]();
  let cancelled = false;
  let finishing = false;
  let settled = false;
  let fatalInfo: AgentErrorInfo | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeCapacity: (() => void) | undefined;
  let producerDone: Promise<void> | undefined;
  let abortListener: () => void = () => {};
  let wakeAbort: () => void = () => {};
  const abortWake = new Promise<void>((resolve) => {
    wakeAbort = resolve;
  });
  const aborted = abortWake.then(() => ({ kind: "abort" as const }));

  const stopHeartbeat = () => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  };
  const settle = () => {
    if (settled) return;
    settled = true;
    stopHeartbeat();
    options.controller.signal.removeEventListener("abort", abortListener);
    options.onSettled?.();
  };

  const runFailure = (error: unknown): AgentErrorInfo => ({
    code: "llm_error",
    message: "Agent 运行失败",
    retryable: true,
    ...(error instanceof Error ? { details: { name: error.name } } : {}),
  });
  const abortedRun = (error: unknown): AgentErrorInfo => ({
    code: "aborted",
    message: "回答已停止",
    retryable: false,
    ...(error instanceof Error ? { details: { name: error.name } } : {}),
  });

  const fallbackEvent = (error: AgentErrorInfo): AgentEvent => ({
    protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
    sequence: options.recorder.lastSequence + 1,
    timestamp: new Date().toISOString(),
    runId: options.recorder.runId,
    type: "error",
    error,
  });

  const waitForCapacity = async (
    streamController: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<boolean> => {
    while (
      !cancelled &&
      !options.controller.signal.aborted &&
      (streamController.desiredSize ?? 0) <= 0
    ) {
      await Promise.race([
        new Promise<void>((resolve) => {
          resumeCapacity = resolve;
        }),
        abortWake,
      ]);
      resumeCapacity = undefined;
    }
    return !cancelled && !options.controller.signal.aborted;
  };

  const returnSource = () => {
    try {
      const returned = iterator.return?.();
      if (returned) void Promise.resolve(returned).catch(() => undefined);
    } catch {
      // Iterator cleanup is best effort after the run has already terminated.
    }
  };

  const closeTransport = (
    streamController: ReadableStreamDefaultController<Uint8Array>,
    terminalEvent?: AgentEvent,
  ) => {
    if (cancelled) return;
    try {
      if (terminalEvent) {
        streamController.enqueue(
          encoder.encode(encodeAgentEvent(terminalEvent)),
        );
      }
      streamController.enqueue(encoder.encode(encodeAgentStreamEnd()));
      streamController.close();
    } catch {
      // The consumer may detach between persistence and transport delivery.
    }
  };

  abortListener = () => {
    wakeAbort();
    const resume = resumeCapacity;
    resumeCapacity = undefined;
    resume?.();
  };
  options.controller.signal.addEventListener("abort", abortListener, { once: true });
  if (options.controller.signal.aborted) abortListener();

  const produce = async (
    streamController: ReadableStreamDefaultController<Uint8Array>,
  ) => {
    let terminalEvent: AgentEvent | undefined;
    try {
      while (true) {
        const result = await Promise.race([
          Promise.resolve(iterator.next()).then((next) => ({
            kind: "event" as const,
            next,
          })),
          aborted,
        ]);
        if (result.kind === "abort") {
          fatalInfo ??= abortedRun(options.controller.signal.reason);
          break;
        }
        if (result.next.done) {
          fatalInfo ??= {
            code: "llm_error",
            message: "Agent 事件流未发送终止事件。",
            retryable: true,
          };
          break;
        }

        const event = result.next.value;
        if (event.type === "done" || event.type === "error") {
          finishing = true;
          stopHeartbeat();
        }
        await options.recorder.record(event);
        if (event.type === "done" || event.type === "error") {
          terminalEvent = event;
          break;
        }
        if (
          !(await waitForCapacity(streamController)) ||
          cancelled ||
          options.controller.signal.aborted
        ) {
          fatalInfo ??= abortedRun(options.controller.signal.reason);
          break;
        }
        streamController.enqueue(
          encoder.encode(encodeAgentEvent(event)),
        );
      }
    } catch (error) {
      fatalInfo ??= options.controller.signal.aborted
        ? abortedRun(options.controller.signal.reason)
        : runFailure(error);
      if (!options.controller.signal.aborted) options.controller.abort(error);
    } finally {
      finishing = true;
      stopHeartbeat();
      returnSource();

      if (!terminalEvent) {
        const info =
          fatalInfo ??
          runFailure(new Error("Agent event stream ended unexpectedly."));
        if (!options.recorder.finalized) {
          const fallback = fallbackEvent(info);
          try {
            await options.recorder.record(fallback);
            terminalEvent = fallback;
          } catch {
            try {
              await options.recorder.finalizeUnexpected(info);
            } catch {
              // The durable store may be unavailable; the public stream still ends.
            }
          }
        }
      }

      settle();
      closeTransport(streamController, terminalEvent);
    }
  };

  const scheduleHeartbeat = (
    streamController: ReadableStreamDefaultController<Uint8Array>,
  ) => {
    if (
      finishing ||
      cancelled ||
      options.controller.signal.aborted
    ) {
      return;
    }
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = undefined;
      void (async () => {
        if (
          finishing ||
          cancelled ||
          options.controller.signal.aborted
        ) {
          return;
        }
        try {
          await options.onHeartbeat?.();
        } catch (error) {
          if (finishing || cancelled) return;
          fatalInfo ??= runFailure(error);
          if (!options.controller.signal.aborted) {
            options.controller.abort(error);
          }
          return;
        }
        if (
          finishing ||
          cancelled ||
          options.controller.signal.aborted
        ) {
          return;
        }
        if ((streamController.desiredSize ?? 0) > 0) {
          try {
            streamController.enqueue(
              encoder.encode(encodeAgentHeartbeat()),
            );
          } catch (error) {
            fatalInfo ??= runFailure(error);
            if (!options.controller.signal.aborted) {
              options.controller.abort(error);
            }
            return;
          }
        }
        scheduleHeartbeat(streamController);
      })();
    }, heartbeatMs);
  };

  return new ReadableStream<Uint8Array>(
    {
      start(streamController) {
        producerDone = produce(streamController);
        scheduleHeartbeat(streamController);
      },
      pull() {
        const resume = resumeCapacity;
        resumeCapacity = undefined;
        resume?.();
      },
      async cancel(reason) {
        if (cancelled) return producerDone;
        cancelled = true;
        const cancellationReason = reason ?? "client disconnected";
        if (!options.controller.signal.aborted) {
          options.controller.abort(cancellationReason);
        }
        wakeAbort();
        const resume = resumeCapacity;
        resumeCapacity = undefined;
        resume?.();
        await producerDone;
      },
    },
    {
      highWaterMark: maxQueuedFrames,
      size: () => 1,
    },
  );
}
