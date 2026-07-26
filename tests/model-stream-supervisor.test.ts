import { describe, expect, it, vi } from "vitest";

import {
  AgentModelFailure,
  createOpenAICompatibleModel,
  type AgentModelChunk,
  type AgentModelRequest,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionRequestOptions,
  type OpenAICompatibleClient,
} from "@/lib/agent";

const REQUEST: AgentModelRequest = {
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  options: {},
};

type AttemptFactory = (
  signal: AbortSignal | undefined,
) => AsyncIterable<ChatCompletionChunk>;

function fakeClient(attempts: readonly AttemptFactory[]) {
  const signals: Array<AbortSignal | undefined> = [];
  let attempt = 0;
  const create = vi.fn(
    (
      _request: ChatCompletionRequest,
      options?: ChatCompletionRequestOptions,
    ) => {
      signals.push(options?.signal);
      return attempts[attempt++]?.(options?.signal) ?? emptyStream();
    },
  );
  const client: OpenAICompatibleClient = {
    chat: { completions: { create } },
  };
  return { client, create, signals };
}

async function* emptyStream(): AsyncGenerator<ChatCompletionChunk> {}

async function collect(
  stream: AsyncIterable<AgentModelChunk>,
): Promise<AgentModelChunk[]> {
  const chunks: AgentModelChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function captureFailure(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected the model stream to fail.");
  } catch (error) {
    if (!(error instanceof AgentModelFailure)) throw error;
    return error;
  }
}

describe("OpenAI-compatible model stream supervision", () => {
  it("retries a transport failure before any semantic chunk is emitted", async () => {
    const { client, create } = fakeClient([
      () =>
        (async function* () {
          throw new Error("error decoding response body");
        })(),
      () =>
        (async function* () {
          yield {
            choices: [
              { delta: { content: "recovered" }, finish_reason: "stop" },
            ],
          };
        })(),
    ]);
    const model = createOpenAICompatibleModel(client, "test-model", {
      maxRetries: 1,
      idleTimeoutMs: 1_000,
    });

    await expect(collect(await model.stream(REQUEST))).resolves.toEqual([
      { content: "recovered", finishReason: "stop" },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable HTTP error before streaming starts", async () => {
    const unauthorized = Object.assign(new Error("Unauthorized"), {
      status: 401,
    });
    const { client, create } = fakeClient([
      () =>
        (async function* () {
          throw unauthorized;
        })(),
      () => emptyStream(),
    ]);
    const model = createOpenAICompatibleModel(client, "test-model", {
      maxRetries: 1,
    });

    const failure = await captureFailure(
      collect(await model.stream(REQUEST)),
    );

    expect(failure).toMatchObject({ code: "llm_error", retryable: false });
    expect(failure.cause).toBe(unauthorized);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not retry after partial text has been emitted", async () => {
    const { client, create } = fakeClient([
      () =>
        (async function* () {
          yield {
            choices: [
              { delta: { content: "partial" }, finish_reason: null },
            ],
          };
          throw new Error("stream disconnected");
        })(),
      () => emptyStream(),
    ]);
    const model = createOpenAICompatibleModel(client, "test-model", {
      maxRetries: 1,
    });
    const iterator = (await model.stream(REQUEST))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { content: "partial" },
      done: false,
    });
    const failure = await captureFailure(iterator.next());

    expect(failure).toMatchObject({ code: "llm_error", retryable: false });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries after hidden reasoning and discards the failed attempt", async () => {
    const { client, create } = fakeClient([
      () =>
        (async function* () {
          yield {
            choices: [
              {
                delta: { reasoning_content: "Inspecting..." },
                finish_reason: null,
              },
            ],
          };
          throw new Error("stream disconnected");
        })(),
      () =>
        (async function* () {
          yield {
            choices: [
              {
                delta: { reasoning_content: "Trying again..." },
                finish_reason: null,
              },
            ],
          };
          yield {
            choices: [
              { delta: { content: "recovered" }, finish_reason: "stop" },
            ],
          };
        })(),
    ]);
    const model = createOpenAICompatibleModel(client, "test-model", {
      maxRetries: 1,
    });

    await expect(collect(await model.stream(REQUEST))).resolves.toEqual([
      { reasoningContent: "Trying again...", finishReason: null },
      { content: "recovered", finishReason: "stop" },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries after a tool-call fragment and discards the failed attempt", async () => {
    const { client, create } = fakeClient([
      () =>
        (async function* () {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: { name: "read_file", arguments: "{\"path\":" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
          throw new Error("stream disconnected");
        })(),
      () =>
        (async function* () {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_2",
                      function: {
                        name: "read_file",
                        arguments: "{\"path\":\"README.md\"}",
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          };
        })(),
    ]);
    const model = createOpenAICompatibleModel(client, "test-model", {
      maxRetries: 1,
    });

    await expect(collect(await model.stream(REQUEST))).resolves.toEqual([
      {
        finishReason: "tool_calls",
        toolCalls: [
          {
            index: 0,
            id: "call_2",
            name: "read_file",
            arguments: "{\"path\":\"README.md\"}",
          },
        ],
      },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("rejects a stream that ends without a non-empty finish reason", async () => {
    const { client, create } = fakeClient([
      () =>
        (async function* () {
          yield {
            choices: [{ delta: { content: "unfinished" }, finish_reason: null }],
          };
        })(),
    ]);
    const model = createOpenAICompatibleModel(client, "test-model", {
      maxRetries: 1,
    });
    const iterator = (await model.stream(REQUEST))[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      value: { content: "unfinished" },
      done: false,
    });
    const failure = await captureFailure(iterator.next());

    expect(failure).toMatchObject({
      code: "llm_error",
      retryable: false,
      message: "The model stream ended before reporting completion.",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("aborts the active iterator without retrying", async () => {
    let markNextStarted!: () => void;
    const nextStarted = new Promise<void>((resolve) => {
      markNextStarted = resolve;
    });
    const returnIterator = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }));
    const { client, create, signals } = fakeClient([
      () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              markNextStarted();
              return new Promise<IteratorResult<ChatCompletionChunk>>(() => {});
            },
            return: returnIterator,
          };
        },
      }),
    ]);
    const model = createOpenAICompatibleModel(client, "test-model", {
      maxRetries: 1,
      idleTimeoutMs: 1_000,
    });
    const controller = new AbortController();
    const pending = collect(
      await model.stream(REQUEST, { signal: controller.signal }),
    );
    const failurePromise = captureFailure(pending);
    await nextStarted;

    controller.abort(new Error("cancelled"));
    const failure = await failurePromise;

    expect(failure).toMatchObject({ code: "llm_error", retryable: false });
    expect(failure.message).toMatch(/aborted/i);
    expect(create).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(returnIterator).toHaveBeenCalled();
  });

  it("aborts and returns an iterator that exceeds the idle timeout", async () => {
    vi.useFakeTimers();
    try {
      let markNextStarted!: () => void;
      const nextStarted = new Promise<void>((resolve) => {
        markNextStarted = resolve;
      });
      const returnIterator = vi.fn(async () => ({
        done: true as const,
        value: undefined,
      }));
      const { client, create, signals } = fakeClient([
        () => ({
          [Symbol.asyncIterator]() {
            return {
              next: () => {
                markNextStarted();
                return new Promise<IteratorResult<ChatCompletionChunk>>(
                  () => {},
                );
              },
              return: returnIterator,
            };
          },
        }),
      ]);
      const model = createOpenAICompatibleModel(client, "test-model", {
        maxRetries: 0,
        idleTimeoutMs: 25,
      });
      const pending = collect(await model.stream(REQUEST));
      const failurePromise = captureFailure(pending);
      await nextStarted;

      await vi.advanceTimersByTimeAsync(25);
      const failure = await failurePromise;

      expect(failure).toMatchObject({ code: "llm_error", retryable: true });
      expect(failure.message).toMatch(/idle/i);
      expect(create).toHaveBeenCalledTimes(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(returnIterator).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
