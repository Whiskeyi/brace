import { describe, expect, it } from "vitest";

import {
  AgentEventProtocolError,
  agentEventsToSSE,
  decodeAgentEvents,
  encodeAgentEvent,
  encodeAgentStreamEnd,
  MAX_AGENT_MODEL_OUTPUT_BYTES,
  MAX_AGENT_SSE_FRAME_BYTES,
  type AgentEvent,
} from "@/lib/agent";

const startEvent = {
  protocolVersion: 1,
  sequence: 1,
  timestamp: "2026-01-02T03:04:05.000Z",
  runId: "run_sse",
  type: "start",
  model: "model",
  maxRounds: 2,
  limits: {
    maxRounds: 2,
    maxToolCalls: 4,
    maxToolConcurrency: 2,
    maxModelOutputBytes: 4_096,
    toolTimeoutMs: 1_000,
    maxToolArgumentBytes: 1_024,
    maxToolResultBytes: 1_024,
  },
} satisfies AgentEvent;

const deltaEvent = {
  protocolVersion: 1,
  sequence: 2,
  timestamp: "2026-01-02T03:04:06.000Z",
  runId: "run_sse",
  type: "delta",
  round: 1,
  delta: "你好",
} satisfies AgentEvent;

const doneEvent = {
  protocolVersion: 1,
  sequence: 3,
  timestamp: "2026-01-02T03:04:07.000Z",
  runId: "run_sse",
  type: "done",
  content: "你好",
  finishReason: "stop",
  rounds: 1,
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
} satisfies AgentEvent;

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function streamFromBytes(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

function streamFromText(value: string): ReadableStream<Uint8Array> {
  return streamFromBytes([new TextEncoder().encode(value)]);
}

async function* eventsOf(...events: readonly AgentEvent[]) {
  for (const event of events) yield event;
}

describe("agent SSE protocol", () => {
  it("budgets the default wire frame for worst-case JSON escaping", () => {
    expect(MAX_AGENT_SSE_FRAME_BYTES).toBeGreaterThan(
      MAX_AGENT_MODEL_OUTPUT_BYTES * 6,
    );
  });
  it("decodes byte-fragmented UTF-8 and CRLF frames", async () => {
    const wire = [
      encodeAgentEvent(startEvent),
      encodeAgentEvent(deltaEvent),
      ": heartbeat 1\n\n",
      encodeAgentEvent(doneEvent),
      encodeAgentStreamEnd(),
    ].join("").replace(/\n/g, "\r\n");
    const bytes = new TextEncoder().encode(wire);
    const oneByteChunks = Array.from(bytes, (byte) => Uint8Array.of(byte));

    const decoded = await collect(decodeAgentEvents(streamFromBytes(oneByteChunks)));

    expect(decoded).toEqual([startEvent, deltaEvent, doneEvent]);
  });

  it("appends [DONE] when encoding and ignores it when decoding", async () => {
    const encoded = await new Response(
      agentEventsToSSE(eventsOf(startEvent, deltaEvent)),
    ).text();

    expect(encoded).toBe(
      `${encodeAgentEvent(startEvent)}${encodeAgentEvent(deltaEvent)}${encodeAgentStreamEnd()}`,
    );
    await expect(collect(decodeAgentEvents(streamFromText(encoded)))).resolves.toEqual([
      startEvent,
      deltaEvent,
    ]);
  });

  it.each([
    ["invalid JSON", "data: {not-json}\n\n", "Agent SSE contained invalid JSON."],
    [
      "invalid event envelope",
      `data: ${JSON.stringify({ ...deltaEvent, sequence: 0 })}\n\n`,
      "Agent SSE contained an invalid event.",
    ],
  ])("rejects an %s frame", async (_label, wire, message) => {
    const decoding = collect(decodeAgentEvents(streamFromText(wire)));

    await expect(decoding).rejects.toThrow(AgentEventProtocolError);
    await expect(decoding).rejects.toThrow(message);
  });

  it("rejects mixed-run, non-increasing, and post-terminal events", async () => {
    const cases = [
      `${encodeAgentEvent(startEvent)}${encodeAgentEvent({
        ...deltaEvent,
        runId: "other_run",
      })}`,
      `${encodeAgentEvent(startEvent)}${encodeAgentEvent({
        ...deltaEvent,
        sequence: 1,
      })}`,
      `${encodeAgentEvent(startEvent)}${encodeAgentEvent(doneEvent)}${encodeAgentEvent({
        ...deltaEvent,
        sequence: 4,
      })}`,
    ];

    for (const wire of cases) {
      await expect(
        collect(decodeAgentEvents(streamFromText(wire))),
      ).rejects.toThrow(AgentEventProtocolError);
    }
  });

  it("rejects a fragmented frame above the configured byte limit", async () => {
    const wire = encodeAgentEvent({ ...startEvent, model: "x".repeat(200) });
    const bytes = new TextEncoder().encode(wire);
    const chunks = [bytes.subarray(0, 40), bytes.subarray(40)];

    await expect(
      collect(decodeAgentEvents(streamFromBytes(chunks), { maxFrameBytes: 64 })),
    ).rejects.toThrow(/byte limit/);
  });
});
