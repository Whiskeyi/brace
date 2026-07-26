import { describe, expect, it, vi } from "vitest";

import {
  encodeAgentEvent,
  encodeAgentHeartbeat,
  encodeAgentStreamEnd,
  type AgentErrorInfo,
  type AgentEvent,
} from "@/lib/agent";
import type { RunRecorder } from "@/server/chat/run-recorder";
import { createRecordedAgentStream } from "@/server/chat/stream";

const timestamp = "2026-07-19T00:00:00.000Z";
const deltaEvent = {
  protocolVersion: 1,
  sequence: 1,
  timestamp,
  runId: "run_stream",
  type: "delta",
  round: 1,
  delta: "hello",
} satisfies AgentEvent;
const doneEvent = {
  protocolVersion: 1,
  sequence: 2,
  timestamp,
  runId: "run_stream",
  type: "done",
  content: "hello",
  finishReason: "stop",
  rounds: 1,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
} satisfies AgentEvent;

function fakeRecorder(initialSequence = 0) {
  let lastSequence = initialSequence;
  let finalized = false;
  const record = vi.fn(async (event: AgentEvent) => {
    lastSequence = event.sequence;
    if (event.type === "done" || event.type === "error") finalized = true;
  });
  const finalizeUnexpected = vi.fn(async (error: AgentErrorInfo) => {
    void error;
    if (!finalized) finalized = true;
  });
  const recorder = {
    get lastSequence() {
      return lastSequence;
    },
    get runId() {
      return "run_stream";
    },
    get finalized() {
      return finalized;
    },
    record,
    finalizeUnexpected,
  } as unknown as RunRecorder;
  return { recorder, record, finalizeUnexpected };
}

function controlledEvents(
  next: () => Promise<IteratorResult<AgentEvent>>,
  returnIterator?: () => Promise<IteratorResult<AgentEvent>>,
): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator]() {
      return { next, return: returnIterator };
    },
  };
}

async function* eventsOf(...events: readonly AgentEvent[]) {
  for (const event of events) yield event;
}

function text(chunk: Uint8Array | undefined): string {
  return new TextDecoder().decode(chunk);
}

describe("createRecordedAgentStream", () => {
  it("records normal events and appends a DONE frame", async () => {
    const { recorder, record, finalizeUnexpected } = fakeRecorder();
    const onSettled = vi.fn();
    const controller = new AbortController();

    const body = await new Response(
      createRecordedAgentStream({
        events: eventsOf(deltaEvent, doneEvent),
        recorder,
        controller,
        onSettled,
      }),
    ).text();

    expect(body).toBe(
      `${encodeAgentEvent(deltaEvent)}${encodeAgentEvent(doneEvent)}${encodeAgentStreamEnd()}`,
    );
    expect(record.mock.calls.map(([event]) => event)).toEqual([deltaEvent, doneEvent]);
    expect(finalizeUnexpected).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("advances and persists the run before the client pulls", async () => {
    const { recorder, record } = fakeRecorder();
    const onSettled = vi.fn();
    const stream = createRecordedAgentStream({
      events: eventsOf(deltaEvent, doneEvent),
      recorder,
      controller: new AbortController(),
      onSettled,
    });

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(2));
    expect(record.mock.calls.map(([event]) => event)).toEqual([
      deltaEvent,
      doneEvent,
    ]);
    expect(onSettled).toHaveBeenCalledTimes(1);

    await expect(new Response(stream).text()).resolves.toBe(
      `${encodeAgentEvent(deltaEvent)}${encodeAgentEvent(doneEvent)}${encodeAgentStreamEnd()}`,
    );
  });

  it("emits heartbeats without advancing the pending iterator", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T01:02:03.000Z"));
    try {
      let resolveFirst!: (result: IteratorResult<AgentEvent>) => void;
      const first = new Promise<IteratorResult<AgentEvent>>((resolve) => {
        resolveFirst = resolve;
      });
      let nextIndex = 0;
      const next = vi.fn((): Promise<IteratorResult<AgentEvent>> => {
        nextIndex += 1;
        return nextIndex === 1
          ? first
          : Promise.resolve({ done: true, value: undefined });
      });
      const { recorder, record } = fakeRecorder();
      const onHeartbeat = vi.fn().mockResolvedValue(undefined);
      const stream = createRecordedAgentStream({
        events: controlledEvents(next),
        recorder,
        controller: new AbortController(),
        heartbeatMs: 1_000,
        onHeartbeat,
      });
      const reader = stream.getReader();

      const heartbeatRead = reader.read();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(text((await heartbeatRead).value)).toBe(encodeAgentHeartbeat());
      expect(next).toHaveBeenCalledTimes(1);
      expect(record).not.toHaveBeenCalled();
      expect(onHeartbeat).toHaveBeenCalledTimes(1);

      resolveFirst({ done: false, value: doneEvent });
      expect(text((await reader.read()).value)).toBe(encodeAgentEvent(doneEvent));
      expect(text((await reader.read()).value)).toBe(encodeAgentStreamEnd());
      expect(next).toHaveBeenCalledTimes(1);
      reader.releaseLock();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the lease on schedule while deltas are continuously produced", async () => {
    vi.useFakeTimers();
    try {
      let sequence = 0;
      const next = vi.fn(
        () =>
          new Promise<IteratorResult<AgentEvent>>((resolve) => {
            setTimeout(() => {
              sequence += 1;
              resolve({
                done: false,
                value: {
                  ...deltaEvent,
                  sequence,
                  delta: `chunk-${sequence}`,
                },
              });
            }, 100);
          }),
      );
      const { recorder, record } = fakeRecorder();
      const onHeartbeat = vi.fn().mockResolvedValue(undefined);
      const stream = createRecordedAgentStream({
        events: controlledEvents(next),
        recorder,
        controller: new AbortController(),
        heartbeatMs: 1_000,
        onHeartbeat,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(record.mock.calls.length).toBeGreaterThanOrEqual(9);
      expect(onHeartbeat).toHaveBeenCalledTimes(1);
      await stream.cancel("test complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits and records a fallback error when the source throws", async () => {
    const sourceError = new TypeError("stream failed");
    const next = vi.fn(async (): Promise<IteratorResult<AgentEvent>> => {
      throw sourceError;
    });
    const { recorder, record } = fakeRecorder(4);
    const controller = new AbortController();
    const onSettled = vi.fn();

    const body = await new Response(
      createRecordedAgentStream({
        events: controlledEvents(next),
        recorder,
        controller,
        onSettled,
      }),
    ).text();
    const fallback = record.mock.calls[0]?.[0];

    expect(fallback).toMatchObject({
      protocolVersion: 1,
      sequence: 5,
      runId: "run_stream",
      type: "error",
      error: {
        code: "llm_error",
        message: "Agent 运行失败",
        retryable: true,
        details: { name: "TypeError" },
      },
    });
    expect(body).toBe(`${encodeAgentEvent(fallback!)}${encodeAgentStreamEnd()}`);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(sourceError);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("records an aborted terminal event when the client cancels", async () => {
    const pending = new Promise<IteratorResult<AgentEvent>>(() => undefined);
    const next = vi.fn(() => pending);
    const returnIterator = vi.fn(
      async (): Promise<IteratorResult<AgentEvent>> => ({
        done: true,
        value: undefined,
      }),
    );
    const { recorder, record, finalizeUnexpected } = fakeRecorder(2);
    const controller = new AbortController();
    const onSettled = vi.fn();
    const reader = createRecordedAgentStream({
      events: controlledEvents(next, returnIterator),
      recorder,
      controller,
      onSettled,
    }).getReader();
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));

    await reader.cancel("client disconnected");
    await reader.cancel("duplicate cancellation");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("client disconnected");
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        sequence: 3,
        type: "error",
        error: {
          code: "aborted",
          message: "回答已停止",
          retryable: false,
        },
      }),
    );
    expect(finalizeUnexpected).not.toHaveBeenCalled();
    expect(returnIterator).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("durably terminates when the request controller aborts without another pull", async () => {
    const pending = new Promise<IteratorResult<AgentEvent>>(() => undefined);
    const { recorder, record } = fakeRecorder(2);
    const controller = new AbortController();
    const onSettled = vi.fn();
    const reader = createRecordedAgentStream({
      events: controlledEvents(() => pending),
      recorder,
      controller,
      onSettled,
    }).getReader();
    const firstRead = reader.read();

    controller.abort(new Error("request timeout"));

    const terminalFrame = text((await firstRead).value);
    const terminal = record.mock.calls[0]?.[0];
    expect(terminal).toMatchObject({
      sequence: 3,
      type: "error",
      error: { code: "aborted", retryable: false },
    });
    expect(terminalFrame).toBe(encodeAgentEvent(terminal!));
    expect(text((await reader.read()).value)).toBe(encodeAgentStreamEnd());
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("bounds a slow consumer without reverting to pull-driven production", async () => {
    let index = 0;
    const deltas = [1, 2, 3, 4].map(
      (sequence) =>
        ({
          ...deltaEvent,
          sequence,
          delta: `chunk-${sequence}`,
        }) satisfies AgentEvent,
    );
    const terminal = {
      ...doneEvent,
      sequence: 5,
      content: "chunk-1chunk-2chunk-3chunk-4",
    } satisfies AgentEvent;
    const results: IteratorResult<AgentEvent>[] = [
      ...deltas.map((value) => ({ done: false as const, value })),
      { done: false, value: terminal },
      { done: true, value: undefined },
    ];
    const next = vi.fn(async (): Promise<IteratorResult<AgentEvent>> =>
      results[index++] ?? { done: true, value: undefined },
    );
    const { recorder, record } = fakeRecorder();
    const stream = createRecordedAgentStream({
      events: controlledEvents(next),
      recorder,
      controller: new AbortController(),
      heartbeatMs: 60_000,
      maxQueuedFrames: 2,
    });

    await vi.waitFor(() => expect(record).toHaveBeenCalledTimes(3));
    expect(next).toHaveBeenCalledTimes(3);

    const reader = stream.getReader();
    let body = "";
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      body += text(result.value);
    }

    expect(body).toBe(
      `${deltas.map(encodeAgentEvent).join("")}${encodeAgentEvent(terminal)}${encodeAgentStreamEnd()}`,
    );
    expect(record).toHaveBeenCalledTimes(5);
    expect(next).toHaveBeenCalledTimes(5);
  });
});
