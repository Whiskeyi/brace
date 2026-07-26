import { AgentModelFailure } from "./errors";
import {
  ModelStreamSupervisor,
  type ModelStreamSupervisorOptions,
} from "./stream-supervisor";
import type {
  AgentModel,
  AgentModelChunk,
  AgentModelRequest,
  AgentUsage,
  ChatCompletionChunk,
  ChatCompletionRequest,
  OpenAICompatibleClient,
} from "./types";

export interface OpenAICompatibleRequestProfile {
  readonly includeStreamUsage?: boolean;
  readonly outputTokenParameter?: "max_tokens" | "max_completion_tokens";
  readonly maxOutputTokens?: number;
  readonly temperatureRange?: {
    readonly minimumExclusive?: number;
    readonly maximumInclusive?: number;
  };
  readonly requestOverrides?: Readonly<Record<string, unknown>>;
}

export interface OpenAICompatibleModelOptions
  extends ModelStreamSupervisorOptions {
  readonly requestProfile?: OpenAICompatibleRequestProfile;
}

type ResolvedRequestProfile = Omit<
  OpenAICompatibleRequestProfile,
  "includeStreamUsage" | "outputTokenParameter"
> &
  Required<
    Pick<
      OpenAICompatibleRequestProfile,
      "includeStreamUsage" | "outputTokenParameter"
    >
  >;

export class OpenAICompatibleModel implements AgentModel {
  readonly id: string;
  readonly #client: OpenAICompatibleClient;
  readonly #streamSupervisor: ModelStreamSupervisor;
  readonly #requestProfile: ResolvedRequestProfile;

  constructor(
    client: OpenAICompatibleClient,
    model: string,
    options: OpenAICompatibleModelOptions = {},
  ) {
    if (typeof client?.chat?.completions?.create !== "function") {
      throw new Error("client must expose chat.completions.create().");
    }
    if (!model.trim()) {
      throw new Error("model must be a non-empty string.");
    }
    this.#client = client;
    this.id = model.trim();
    const { requestProfile, ...streamOptions } = options;
    this.#requestProfile = {
      ...requestProfile,
      includeStreamUsage: requestProfile?.includeStreamUsage ?? true,
      outputTokenParameter:
        requestProfile?.outputTokenParameter ?? "max_tokens",
    };
    this.#streamSupervisor = new ModelStreamSupervisor(streamOptions);
  }

  async stream(
    input: AgentModelRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AsyncIterable<AgentModelChunk>> {
    const requestOptions = normalizeRequestOptions(
      input.options,
      this.#requestProfile,
    );
    const temperature = normalizeTemperature(
      input.temperature,
      this.#requestProfile.temperatureRange,
    );
    const request: ChatCompletionRequest = {
      ...requestOptions,
      ...this.#requestProfile.requestOverrides,
      model: this.id,
      messages: input.messages,
      stream: true,
      ...(this.#requestProfile.includeStreamUsage
        ? { stream_options: { include_usage: true } }
        : {}),
      ...(input.tools.length > 0 ? { tools: input.tools } : {}),
      ...(temperature === undefined ? {} : { temperature }),
    };
    const endpoint = this.#client.chat.completions;

    return this.#streamSupervisor.supervise(async (signal) => {
      const result = await endpoint.create(request, { signal });
      if (!isAsyncIterable(result)) {
        throw new AgentModelFailure(
          "invalid_model_response",
          "The chat-completions client did not return an async iterable stream.",
          false,
        );
      }
      return normalizeOpenAIStream(result);
    }, options?.signal);
  }
}

export function createOpenAICompatibleModel(
  client: OpenAICompatibleClient,
  model: string,
  options: OpenAICompatibleModelOptions = {},
): AgentModel {
  return new OpenAICompatibleModel(client, model, options);
}

function normalizeRequestOptions(
  input: Readonly<Record<string, unknown>>,
  profile: OpenAICompatibleRequestProfile,
): Record<string, unknown> {
  const normalized = { ...input };
  const source =
    normalized[profile.outputTokenParameter ?? "max_tokens"] ??
    normalized[
      profile.outputTokenParameter === "max_completion_tokens"
        ? "max_tokens"
        : "max_completion_tokens"
    ];
  delete normalized.max_tokens;
  delete normalized.max_completion_tokens;
  if (source !== undefined) {
    normalized[profile.outputTokenParameter ?? "max_tokens"] =
      capOutputTokens(source, profile.maxOutputTokens);
  }
  return normalized;
}

function capOutputTokens(value: unknown, maximum: number | undefined): unknown {
  return maximum !== undefined &&
    typeof value === "number" &&
    Number.isFinite(value)
    ? Math.min(value, maximum)
    : value;
}

function normalizeTemperature(
  value: number | undefined,
  range: OpenAICompatibleRequestProfile["temperatureRange"],
): number | undefined {
  if (value === undefined || range === undefined) return value;
  if (
    (range.minimumExclusive !== undefined &&
      value <= range.minimumExclusive) ||
    (range.maximumInclusive !== undefined && value > range.maximumInclusive)
  ) {
    return undefined;
  }
  return value;
}

function normalizeOpenAIStream(
  stream: AsyncIterable<ChatCompletionChunk>,
): AsyncIterable<AgentModelChunk> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<AgentModelChunk>> {
          while (true) {
            const next = await iterator.next();
            if (next.done) return { done: true, value: undefined };
            const chunk = normalizeOpenAIChunk(next.value);
            if (chunk) return { done: false, value: chunk };
          }
        },
        async return(): Promise<IteratorResult<AgentModelChunk>> {
          await iterator.return?.();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function normalizeOpenAIChunk(
  chunk: ChatCompletionChunk,
): AgentModelChunk | undefined {
  if (!chunk || typeof chunk !== "object") {
    throw new AgentModelFailure(
      "invalid_model_response",
      "The model stream contained an invalid chunk.",
      false,
    );
  }

  const usage = chunk.usage ? normalizeUsage(chunk.usage) : undefined;
  const choices = chunk.choices ?? [];
  if (choices.length === 0) {
    return usage ? { usage } : undefined;
  }

  const choice = choices[0];
  const content = choice.delta?.content || undefined;
  const reasoningContent = choice.delta?.reasoning_content || undefined;
  const toolCalls = choice.delta?.tool_calls?.map((part) => ({
    index: part.index,
    ...(part.id === undefined ? {} : { id: part.id }),
    ...(part.function?.name === undefined
      ? {}
      : { name: part.function.name }),
    ...(part.function?.arguments === undefined
      ? {}
      : { arguments: part.function.arguments }),
  }));
  return {
    ...(content === undefined ? {} : { content }),
    ...(reasoningContent === undefined ? {} : { reasoningContent }),
    ...(choice.finish_reason === undefined
      ? {}
      : { finishReason: choice.finish_reason }),
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(usage === undefined ? {} : { usage }),
  };
}

function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<ChatCompletionChunk> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function normalizeUsage(
  usage: NonNullable<ChatCompletionChunk["usage"]>,
): AgentUsage {
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}
