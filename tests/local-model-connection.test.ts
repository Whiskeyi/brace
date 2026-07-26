import { describe, expect, it } from "vitest";

import type {
  AgentModel,
  AgentModelChunk,
  AgentModelRequest,
} from "@/lib/agent";
import { probeLocalModelCapabilities } from "@/lib/local-agent";

function fakeModel(
  chunks: readonly AgentModelChunk[],
  requests: AgentModelRequest[],
): AgentModel {
  return {
    id: "capability-probe-model",
    async stream(request) {
      requests.push(request);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

describe("local model capability probe", () => {
  it("verifies a fragmented tool call without executing any local tool", async () => {
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

    await expect(probeLocalModelCapabilities(model, 1_000)).resolves.toEqual({
      latencyMs: expect.any(Number),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      tools: [
        {
          function: { name: "base_agent_connection_probe" },
        },
      ],
      options: { max_tokens: 1_024 },
    });
    expect(requests[0].temperature).toBeUndefined();
  });

  it("rejects endpoints that answer text but cannot call tools", async () => {
    const model = fakeModel(
      [{ content: "OK", finishReason: "stop" }],
      [],
    );

    await expect(
      probeLocalModelCapabilities(model, 1_000),
    ).rejects.toThrow('finish reason "stop" instead of "tool_calls"');
  });

  it("aborts a stalled capability probe at its bounded timeout", async () => {
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

    await expect(probeLocalModelCapabilities(model, 5)).rejects.toThrow(
      "timed out after 5ms",
    );
  });
});
