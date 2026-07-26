import { describe, expect, it, vi } from "vitest";

const openAISdkMock = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  create: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    readonly chat = {
      completions: {
        create: openAISdkMock.create,
      },
    };

    constructor(options: unknown) {
      openAISdkMock.constructorOptions.push(options);
    }
  },
}));

import {
  createOpenAICompatibleModel,
  createOpenAISdkClient,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type OpenAICompatibleClient,
} from "@/lib/agent";
import {
  buildProviderRequestOptions,
  getModelCapabilityProbeProfile,
  getModelProvider,
} from "@/lib/local-agent";

describe("OpenAI-compatible request profiles", () => {
  it("adapts the official SDK with transport retries disabled", async () => {
    openAISdkMock.constructorOptions.length = 0;
    openAISdkMock.create.mockReset();
    openAISdkMock.create.mockReturnValue(
      (async function* () {
        yield {
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        };
      })(),
    );
    const client = createOpenAISdkClient({
      apiKey: "test-key",
      baseUrl: "https://models.example.test/v1",
      timeoutMs: 12_345,
    });
    const model = createOpenAICompatibleModel(client, "sdk-model");

    await drain(
      await model.stream({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        options: { max_tokens: 128 },
      }),
    );

    expect(openAISdkMock.constructorOptions).toEqual([
      {
        apiKey: "test-key",
        baseURL: "https://models.example.test/v1",
        timeout: 12_345,
        maxRetries: 0,
      },
    ]);
    expect(openAISdkMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "sdk-model",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("uses the current MiniMax token parameter without truncating output", async () => {
    const { client, requests } = fakeClient();
    const model = createOpenAICompatibleModel(client, "MiniMax-M2.7", {
      requestProfile: getModelProvider("minimax-cn-token-plan").requestProfile,
    });

    await drain(
      await model.stream({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        temperature: 0,
        options: { max_tokens: 4_096 },
      }),
    );

    expect(requests).toEqual([
      expect.objectContaining({
        model: "MiniMax-M2.7",
        max_completion_tokens: 4_096,
        stream_options: { include_usage: true },
        temperature: 0,
      }),
    ]);
    expect(requests[0]).not.toHaveProperty("max_tokens");
  });

  it("keeps the default OpenAI request behavior", async () => {
    const { client, requests } = fakeClient();
    const model = createOpenAICompatibleModel(client, "gpt-compatible");

    await drain(
      await model.stream({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        temperature: 0.2,
        options: { max_tokens: 512 },
      }),
    );

    expect(requests).toEqual([
      expect.objectContaining({
        max_tokens: 512,
        stream_options: { include_usage: true },
        temperature: 0.2,
      }),
    ]);
    expect(requests[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("uses max_completion_tokens for Kimi Code", async () => {
    const { client, requests } = fakeClient();
    const model = createOpenAICompatibleModel(client, "kimi-for-coding", {
      requestProfile: getModelProvider("kimi-code").requestProfile,
    });

    await drain(
      await model.stream({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        options: buildProviderRequestOptions("kimi-code", {
          maxOutputTokens: 1_024,
          promptCacheScope: "desktop:task-42",
        }),
      }),
    );

    expect(requests[0]).toMatchObject({
      max_completion_tokens: 1_024,
      prompt_cache_key: "base-agent:desktop:task-42",
    });
    expect(requests[0]).not.toHaveProperty("max_tokens");
  });

  it("preserves Kimi's stable prompt cache key on capability probes", async () => {
    const { client, requests } = fakeClient();
    const model = createOpenAICompatibleModel(client, "kimi-for-coding", {
      requestProfile: getModelProvider("kimi-code").requestProfile,
    });
    const probe = getModelCapabilityProbeProfile("kimi-code", "task-42");

    await drain(
      await model.stream({
        messages: [{ role: "user", content: "probe" }],
        tools: [],
        options: {
          max_tokens: probe.maxOutputTokens,
          prompt_cache_key: probe.promptCacheKey,
        },
      }),
    );

    expect(requests[0]).toMatchObject({
      max_completion_tokens: 4_096,
      prompt_cache_key: "base-agent:model-capability-probe:task-42",
    });
    expect(requests[0]).not.toHaveProperty("tool_choice");
  });

  it.each(["glm-payg", "glm-coding-plan"] as const)(
    "enables streamed tool calls for %s",
    async (providerId) => {
      const { client, requests } = fakeClient();
      const model = createOpenAICompatibleModel(client, "glm-5.2", {
        requestProfile: getModelProvider(providerId).requestProfile,
      });

      await drain(
        await model.stream({
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          options: { tool_stream: false },
        }),
      );

      expect(requests[0]).toMatchObject({ tool_stream: true });
    },
  );

  it("keeps custom endpoints on the smallest compatible request surface", async () => {
    const { client, requests } = fakeClient();
    const model = createOpenAICompatibleModel(client, "custom-model", {
      requestProfile: getModelProvider("custom").requestProfile,
    });

    await drain(
      await model.stream({
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        options: { max_tokens: 128 },
      }),
    );

    expect(requests[0]).toMatchObject({ max_tokens: 128 });
    expect(requests[0]).not.toHaveProperty("stream_options");
  });
});

function fakeClient() {
  const requests: ChatCompletionRequest[] = [];
  const chunks: readonly ChatCompletionChunk[] = [
    {
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
    },
  ];
  const client: OpenAICompatibleClient = {
    chat: {
      completions: {
        create(request: ChatCompletionRequest) {
          requests.push(request);
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  };
  return { client, requests };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const chunk of stream) void chunk;
}
