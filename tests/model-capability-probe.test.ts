import { describe, expect, it } from "vitest";

import {
  probeAgentModelToolCalling,
  type AgentModel,
  type AgentModelChunk,
  type AgentModelRequest,
} from "@/lib/agent";

function fakeModel(
  chunks: readonly AgentModelChunk[],
  requests: AgentModelRequest[],
): AgentModel {
  return {
    id: "probe-model",
    async stream(request) {
      requests.push(request);
      return (async function* () {
        yield* chunks;
      })();
    },
  };
}

describe("agent model tool-call capability probe", () => {
  it("uses a safe output budget and never forces a concrete tool choice", async () => {
    const requests: AgentModelRequest[] = [];
    const model = fakeModel(
      [
        {
          toolCalls: [
            {
              index: 0,
              name: "base_agent_",
              arguments: '{"status":',
            },
          ],
        },
        {
          toolCalls: [
            {
              index: 0,
              name: "connection_probe",
              arguments: '"ok"}',
            },
          ],
          finishReason: "tool_calls",
        },
      ],
      requests,
    );

    await expect(
      probeAgentModelToolCalling(model, {
        timeoutMs: 1_000,
        promptCacheKey: "base-agent:model-capability-probe:thread-1",
        requestOptions: {
          max_tokens: 64,
          max_completion_tokens: 64,
          tool_choice: {
            type: "function",
            function: { name: "base_agent_connection_probe" },
          },
          thinking: { type: "disabled" },
        },
      }),
    ).resolves.toEqual({ latencyMs: expect.any(Number) });

    expect(requests[0].options).toEqual({
      thinking: { type: "disabled" },
      max_tokens: 1_024,
      prompt_cache_key: "base-agent:model-capability-probe:thread-1",
    });
    expect(requests[0].options).not.toHaveProperty("tool_choice");
  });

  it("requires tool_calls as the terminal finish reason", async () => {
    const model = fakeModel(
      [
        {
          toolCalls: [
            {
              index: 0,
              name: "base_agent_connection_probe",
              arguments: '{"status":"ok"}',
            },
          ],
          finishReason: "stop",
        },
      ],
      [],
    );

    await expect(
      probeAgentModelToolCalling(model, { timeoutMs: 1_000 }),
    ).rejects.toThrow('finish reason "stop" instead of "tool_calls"');
  });

  it("rejects probe budgets that can truncate thinking before tool use", async () => {
    await expect(
      probeAgentModelToolCalling(fakeModel([], []), {
        timeoutMs: 1_000,
        maxOutputTokens: 64,
      }),
    ).rejects.toThrow("maxOutputTokens must be at least 1024");
  });

  it("aborts a stalled probe at its bounded timeout", async () => {
    const model: AgentModel = {
      id: "stalled-model",
      async stream(_request, options) {
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason),
              { once: true },
            );
          });
          yield { finishReason: "stop" };
        })();
      },
    };

    await expect(
      probeAgentModelToolCalling(model, { timeoutMs: 5 }),
    ).rejects.toThrow("timed out after 5ms");
  });
});
