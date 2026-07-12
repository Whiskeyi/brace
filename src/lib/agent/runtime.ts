import { createDefaultToolRegistry, ToolRegistry } from "../tools";
import type { AgentTool } from "../tools";
import type {
  Agent,
  AgentConfig,
  AgentErrorInfo,
  AgentEvent,
  AgentMessage,
  AgentRunInput,
  AgentUsage,
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionRequestOptions,
  ChatCompletionToolCall,
  OpenAICompatibleClient,
} from "./types";

const EMPTY_USAGE: AgentUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

interface NormalizedConfig {
  readonly client: OpenAICompatibleClient;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly tools: ToolRegistry;
  readonly maxRounds: number;
  readonly toolTimeoutMs: number;
  readonly temperature?: number;
  readonly requestOptions: Readonly<Record<string, unknown>>;
  readonly idGenerator: () => string;
}

interface PreparedToolCall {
  readonly call: ChatCompletionToolCall;
  readonly arguments?: unknown;
  readonly parseError?: AgentErrorInfo;
}

interface ToolExecutionOutcome {
  readonly event: Extract<AgentEvent, { readonly type: "tool_result" }>;
  readonly message: Extract<AgentMessage, { readonly role: "tool" }>;
}

class AgentRuntimeFailure extends Error {
  constructor(readonly info: AgentErrorInfo) {
    super(info.message);
    this.name = "AgentRuntimeFailure";
  }
}

export class UniversalAgent implements Agent {
  readonly #config: NormalizedConfig;

  constructor(config: AgentConfig) {
    this.#config = normalizeConfig(config);
  }

  async *run(input: AgentRunInput | string): AsyncGenerator<AgentEvent, void, void> {
    const normalizedInput: AgentRunInput =
      typeof input === "string" ? { messages: [{ role: "user", content: input }] } : input;
    const runId = normalizedInput.runId ?? this.#config.idGenerator();
    let round = 0;
    let cumulativeUsage = EMPTY_USAGE;

    yield {
      type: "start",
      runId,
      model: this.#config.model,
      maxRounds: this.#config.maxRounds,
    };

    try {
      throwIfAborted(normalizedInput.signal);

      const messages: AgentMessage[] = [
        ...(this.#config.systemPrompt
          ? [{ role: "system" as const, content: this.#config.systemPrompt }]
          : []),
        ...normalizedInput.messages,
      ];
      const openAITools = this.#config.tools.toOpenAITools();
      let fullContent = "";

      for (round = 1; round <= this.#config.maxRounds; round += 1) {
        throwIfAborted(normalizedInput.signal);

        const request: ChatCompletionRequest = {
          ...this.#config.requestOptions,
          model: this.#config.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(openAITools.length > 0 ? { tools: openAITools } : {}),
          ...(this.#config.temperature === undefined
            ? {}
            : { temperature: this.#config.temperature }),
        };
        const stream = await createCompletionStream(
          this.#config.client,
          request,
          normalizedInput.signal,
        );
        const toolCallParts = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();
        let roundContent = "";
        let finishReason: string | null = null;
        let roundUsage: AgentUsage | undefined;

        for await (const chunk of stream) {
          throwIfAborted(normalizedInput.signal);

          if (chunk.usage) {
            roundUsage = normalizeUsage(chunk.usage);
          }

          for (const choice of chunk.choices ?? []) {
            if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
              finishReason = choice.finish_reason;
            }

            const content = choice.delta?.content;
            if (content) {
              roundContent += content;
              fullContent += content;
              yield { type: "delta", runId, round, delta: content };
            }

            for (const part of choice.delta?.tool_calls ?? []) {
              const current = toolCallParts.get(part.index) ?? {
                id: "",
                name: "",
                arguments: "",
              };
              toolCallParts.set(part.index, {
                id: part.id ?? current.id,
                name: current.name + (part.function?.name ?? ""),
                arguments: current.arguments + (part.function?.arguments ?? ""),
              });
            }
          }
        }

        if (roundUsage) {
          cumulativeUsage = addUsage(cumulativeUsage, roundUsage);
          yield {
            type: "usage",
            runId,
            round,
            usage: roundUsage,
            cumulativeUsage,
          };
        }

        const preparedCalls = [...toolCallParts.entries()]
          .sort(([left], [right]) => left - right)
          .map(([index, part]) =>
            prepareToolCall(
              {
                id: part.id || `call_${round}_${index}`,
                type: "function",
                function: {
                  name: part.name,
                  arguments: part.arguments,
                },
              },
            ),
          );

        if (preparedCalls.length === 0) {
          yield {
            type: "done",
            runId,
            content: fullContent,
            finishReason,
            rounds: round,
            usage: cumulativeUsage,
          };
          return;
        }

        messages.push({
          role: "assistant",
          content: roundContent || null,
          tool_calls: preparedCalls.map(({ call }) => call),
        });

        for (const prepared of preparedCalls) {
          yield {
            type: "tool_call",
            runId,
            round,
            callId: prepared.call.id,
            name: prepared.call.function.name,
            rawArguments: prepared.call.function.arguments,
            ...(prepared.arguments === undefined
              ? {}
              : { arguments: prepared.arguments }),
          };
        }

        const outcomes = await Promise.all(
          preparedCalls.map((prepared) =>
            executeToolCall({
              prepared,
              registry: this.#config.tools,
              runId,
              round,
              timeoutMs: this.#config.toolTimeoutMs,
              signal: normalizedInput.signal,
              metadata: normalizedInput.metadata,
            }),
          ),
        );
        throwIfAborted(normalizedInput.signal);

        for (const outcome of outcomes) {
          yield outcome.event;
          messages.push(outcome.message);
        }

        if (round === this.#config.maxRounds) {
          throw new AgentRuntimeFailure({
            code: "max_rounds_exceeded",
            message: `The agent exceeded the maximum of ${this.#config.maxRounds} model rounds.`,
            retryable: false,
          });
        }
      }
    } catch (error) {
      yield {
        type: "error",
        runId,
        ...(round > 0 ? { round } : {}),
        error: normalizeRuntimeError(error, normalizedInput.signal),
      };
    }
  }
}

export function createAgent(config: AgentConfig): Agent {
  return new UniversalAgent(config);
}

export function runAgent(
  config: AgentConfig,
  input: AgentRunInput | string,
): AsyncGenerator<AgentEvent, void, void> {
  return createAgent(config).run(input);
}

async function createCompletionStream(
  client: OpenAICompatibleClient,
  request: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<AsyncIterable<ChatCompletionChunk>> {
  const endpoint = client.chat.completions;
  const create = endpoint.create as unknown as (
    request: ChatCompletionRequest,
    options?: ChatCompletionRequestOptions,
  ) => unknown;
  const result = await create.call(endpoint, request, { signal });

  if (!isAsyncIterable(result)) {
    throw new AgentRuntimeFailure({
      code: "llm_error",
      message: "The chat completions client did not return an async iterable stream.",
      retryable: false,
    });
  }
  return result;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ChatCompletionChunk> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function prepareToolCall(call: ChatCompletionToolCall): PreparedToolCall {
  try {
    return {
      call,
      arguments: call.function.arguments.trim()
        ? JSON.parse(call.function.arguments)
        : {},
    };
  } catch {
    return {
      call,
      parseError: {
        code: "invalid_tool_arguments",
        message: `Tool "${call.function.name}" received malformed JSON arguments.`,
        retryable: false,
      },
    };
  }
}

async function executeToolCall(options: {
  readonly prepared: PreparedToolCall;
  readonly registry: ToolRegistry;
  readonly runId: string;
  readonly round: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): Promise<ToolExecutionOutcome> {
  const startedAt = Date.now();
  const { call } = options.prepared;

  if (options.prepared.parseError) {
    return failedToolOutcome(
      options,
      options.prepared.parseError,
      Date.now() - startedAt,
    );
  }

  const tool = options.registry.get(call.function.name);
  if (!tool) {
    return failedToolOutcome(
      options,
      {
        code: "unknown_tool",
        message: `Tool "${call.function.name}" is not registered.`,
        retryable: false,
      },
      Date.now() - startedAt,
    );
  }

  const validation = await tool.schema.safeParseAsync(options.prepared.arguments);
  if (!validation.success) {
    return failedToolOutcome(
      options,
      {
        code: "invalid_tool_arguments",
        message: `Arguments for tool "${call.function.name}" failed validation.`,
        retryable: false,
        details: validation.error.issues,
      },
      Date.now() - startedAt,
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    throw abortFailure(options.signal);
  }
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Tool timed out after ${options.timeoutMs}ms.`));
  }, options.timeoutMs);
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(
          timedOut
            ? new AgentRuntimeFailure({
                code: "tool_timeout",
                message: `Tool "${call.function.name}" timed out after ${options.timeoutMs}ms.`,
                retryable: true,
              })
            : abortFailure(options.signal),
        );
      },
      { once: true },
    );
  });

  try {
    const execution = Promise.resolve(
      tool.execute(validation.data, {
        callId: call.id,
        runId: options.runId,
        round: options.round,
        signal: controller.signal,
        metadata: options.metadata,
      }),
    );
    const output = await Promise.race([execution, aborted]);
    const serialized = serializeToolOutput(output);
    return {
      event: {
        type: "tool_result",
        runId: options.runId,
        round: options.round,
        callId: call.id,
        name: call.function.name,
        success: true,
        durationMs: Date.now() - startedAt,
        output: serialized.output,
      },
      message: {
        role: "tool",
        tool_call_id: call.id,
        content: serialized.content,
      },
    };
  } catch (error) {
    if (error instanceof AgentRuntimeFailure) {
      if (error.info.code === "aborted") {
        throw error;
      }
      return failedToolOutcome(options, error.info, Date.now() - startedAt);
    }
    return failedToolOutcome(
      options,
      {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : "Tool execution failed.",
        retryable: false,
      },
      Date.now() - startedAt,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

function failedToolOutcome(
  options: Pick<ToolExecutionOutcomeOptions, "prepared" | "runId" | "round">,
  error: AgentErrorInfo,
  durationMs: number,
): ToolExecutionOutcome {
  const call = options.prepared.call;
  return {
    event: {
      type: "tool_result",
      runId: options.runId,
      round: options.round,
      callId: call.id,
      name: call.function.name,
      success: false,
      durationMs,
      error,
    },
    message: {
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify({ ok: false, error }),
    },
  };
}

interface ToolExecutionOutcomeOptions {
  readonly prepared: PreparedToolCall;
  readonly runId: string;
  readonly round: number;
}

function serializeToolOutput(value: unknown): { readonly output: unknown; readonly content: string } {
  try {
    if (typeof value === "string") {
      return { output: value, content: value };
    }
    if (value === undefined) {
      return { output: null, content: "null" };
    }
    const content = JSON.stringify(value);
    if (content === undefined) {
      throw new Error("Result cannot be represented as JSON.");
    }
    return { output: JSON.parse(content), content };
  } catch (error) {
    throw new AgentRuntimeFailure({
      code: "tool_result_serialization_failed",
      message:
        error instanceof Error
          ? `Tool result could not be serialized: ${error.message}`
          : "Tool result could not be serialized.",
      retryable: false,
    });
  }
}

function normalizeUsage(usage: NonNullable<ChatCompletionChunk["usage"]>): AgentUsage {
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
  };
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortFailure(signal);
  }
}

function abortFailure(signal?: AbortSignal): AgentRuntimeFailure {
  return new AgentRuntimeFailure({
    code: "aborted",
    message:
      signal?.reason instanceof Error ? signal.reason.message : "The agent run was aborted.",
    retryable: false,
  });
}

function normalizeRuntimeError(error: unknown, signal?: AbortSignal): AgentErrorInfo {
  if (signal?.aborted) {
    return abortFailure(signal).info;
  }
  if (error instanceof AgentRuntimeFailure) {
    return error.info;
  }
  return {
    code: "llm_error",
    message: error instanceof Error ? error.message : "The model request failed.",
    retryable: true,
  };
}

function normalizeConfig(config: AgentConfig): NormalizedConfig {
  if (!config.model.trim()) {
    throw new Error("model must be a non-empty string.");
  }
  if (
    typeof config.client?.chat?.completions?.create !== "function"
  ) {
    throw new Error("client must expose chat.completions.create().");
  }

  const maxRounds = config.maxRounds ?? 8;
  const toolTimeoutMs = config.toolTimeoutMs ?? 15_000;
  assertPositiveSafeInteger(maxRounds, "maxRounds");
  assertPositiveSafeInteger(toolTimeoutMs, "toolTimeoutMs");

  return {
    client: config.client,
    model: config.model,
    systemPrompt: config.systemPrompt,
    tools:
      config.tools instanceof ToolRegistry
        ? config.tools
        : config.tools === undefined
          ? createDefaultToolRegistry()
          : new ToolRegistry(config.tools as readonly AgentTool[]),
    maxRounds,
    toolTimeoutMs,
    temperature: config.temperature,
    requestOptions: config.requestOptions ?? {},
    idGenerator: config.idGenerator ?? defaultIdGenerator,
  };
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

function defaultIdGenerator(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
