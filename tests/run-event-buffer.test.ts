import { describe, expect, it, vi } from "vitest";

import { RunEventBuffer } from "@/server/chat/run-event-buffer";
import type { AgentEvent } from "@/lib/agent";

const base = {
  protocolVersion: 1 as const,
  timestamp: "2026-07-19T00:00:00.000Z",
  runId: "run_1",
};

describe("RunEventBuffer", () => {
  it("batches deltas and flushes lifecycle boundaries in order", async () => {
    const appendBatch = vi.fn().mockResolvedValue([]);
    const buffer = new RunEventBuffer({
      repository: { appendBatch },
      userId: "user_1",
      runId: "run_1",
      maxBatchSize: 3,
    });
    const events: AgentEvent[] = [
      {
        ...base,
        sequence: 1,
        type: "start",
        model: "model",
        maxRounds: 2,
        limits: {
          maxRounds: 2,
          maxToolCalls: 4,
          maxToolConcurrency: 2,
          maxModelOutputBytes: 4_096,
          toolTimeoutMs: 100,
          maxToolArgumentBytes: 1_024,
          maxToolResultBytes: 1_024,
        },
      },
      { ...base, sequence: 2, type: "delta", round: 1, delta: "a" },
      { ...base, sequence: 3, type: "delta", round: 1, delta: "b" },
      { ...base, sequence: 4, type: "delta", round: 1, delta: "c" },
      {
        ...base,
        sequence: 5,
        type: "done",
        content: "abc",
        finishReason: "stop",
        rounds: 1,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ];

    for (const event of events) await buffer.append(event);
    await buffer.close();

    expect(appendBatch).toHaveBeenCalledTimes(2);
    expect(appendBatch.mock.calls.flatMap((call) => call[2]).map((event) => event.sequence))
      .toEqual([1, 4, 5]);
    expect(appendBatch.mock.calls.flatMap((call) => call[2]).find((event) =>
      event.type === "delta"
    )?.event).toMatchObject({ sequence: 4, delta: "abc" });
  });

  it("rejects events from another run or with a repeated sequence", async () => {
    const buffer = new RunEventBuffer({
      repository: { appendBatch: vi.fn().mockResolvedValue([]) },
      userId: "user_1",
      runId: "run_1",
    });
    const first = { ...base, sequence: 1, type: "delta", round: 1, delta: "a" } as const;
    await buffer.append(first);
    await expect(buffer.append(first)).rejects.toThrow(/strictly increasing/);
    await expect(
      buffer.append({ ...first, runId: "other", sequence: 2 }),
    ).rejects.toThrow(/another run/);
  });
});
