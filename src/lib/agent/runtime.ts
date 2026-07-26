import { ToolRegistry } from "../tools/registry";
import type { AgentTool } from "../tools/types";
import { AgentModelFailure, AgentRuntimeFailure } from "./errors";
import { createOpenAICompatibleModel } from "./model";
import {
  executeToolBatch,
  prepareToolCall,
  ToolExecutor,
  type PreparedToolCall,
  type ToolExecutionOutcome,
} from "./tool-executor";
import {
  AGENT_EVENT_PROTOCOL_VERSION,
  MAX_AGENT_MODEL_OUTPUT_BYTES,
  MAX_AGENT_TOOL_ARGUMENT_BYTES,
  MAX_AGENT_TOOL_RESULT_BYTES,
  type Agent,
  type AgentConfig,
  type AgentErrorInfo,
  type AgentEvent,
  type AgentLimits,
  type AgentMessage,
  type AgentModel,
  type AgentRunInput,
  type AgentUsage,
  type ChatCompletionToolCall,
  type ToolPolicy,
} from "./types";

const EMPTY_USAGE: AgentUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};
// Supports the largest configured token allowance even for providers that emit
// roughly one token per chunk, while still bounding empty-chunk streams.
const MAX_MODEL_CHUNKS_PER_RUN = 131_072;

const DEFAULT_LIMITS: AgentLimits = {
  maxRounds: 8,
  maxToolCalls: 32,
  maxToolConcurrency: 4,
  maxModelOutputBytes: 1024 * 1024,
  toolTimeoutMs: 15_000,
  maxToolArgumentBytes: 32 * 1024,
  maxToolResultBytes: 64 * 1024,
};

interface ModelContextBudget {
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
}

interface NormalizedConfig {
  readonly model: AgentModel;
  readonly systemPrompt?: string;
  readonly tools: ToolRegistry;
  readonly limits: AgentLimits;
  readonly contextBudget?: ModelContextBudget;
  readonly toolPolicy?: ToolPolicy;
  readonly temperature?: number;
  readonly requestOptions: Readonly<Record<string, unknown>>;
  readonly idGenerator: () => string;
  readonly now: () => Date;
}

export class UniversalAgent implements Agent {
  readonly #config: NormalizedConfig;

  constructor(config: AgentConfig) {
    this.#config = normalizeConfig(config);
  }

  async *run(input: AgentRunInput | string): AsyncGenerator<AgentEvent, void, void> {
    const normalizedInput: AgentRunInput =
      typeof input === "string"
        ? { messages: [{ role: "user", content: input }] }
        : input;
    const runId = normalizedInput.runId ?? this.#config.idGenerator();
    let round = 0;
    let sequence = 0;
    let cumulativeUsage = EMPTY_USAGE;
    const nextMeta = () => ({
      protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
      sequence: (sequence += 1),
      timestamp: this.#config.now().toISOString(),
      runId,
    });

    yield {
      ...nextMeta(),
      type: "start",
      model: this.#config.model.id,
      maxRounds: this.#config.limits.maxRounds,
      limits: this.#config.limits,
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
      const toolExecutor = new ToolExecutor({
        registry: this.#config.tools,
        timeoutMs: this.#config.limits.toolTimeoutMs,
        maxResultBytes: this.#config.limits.maxToolResultBytes,
        policy: this.#config.toolPolicy,
      });
      let fullContent = "";
      let modelOutputBytes = 0;
      let modelChunkCount = 0;
      let toolCallCount = 0;

      for (round = 1; round <= this.#config.limits.maxRounds; round += 1) {
        throwIfAborted(normalizedInput.signal);
        const requestMessages = fitModelRequestContext({
          messages,
          tools: openAITools,
          model: this.#config.model.id,
          temperature: this.#config.temperature,
          options: this.#config.requestOptions,
          budget: this.#config.contextBudget,
        });
        if (requestMessages.length !== messages.length) {
          messages.splice(0, messages.length, ...requestMessages);
        }
        const stream = await this.#config.model.stream(
          {
            messages: [...messages],
            tools: openAITools,
            temperature: this.#config.temperature,
            options: this.#config.requestOptions,
          },
          { signal: normalizedInput.signal },
        );
        const toolCallParts = new Map<
          number,
          {
            id: string;
            name: string;
            arguments: string;
            argumentBytes: number;
            oversized: boolean;
          }
        >();
        let roundContent = "";
        let roundReasoningContent = "";
        let finishReason: string | null = null;
        let roundUsage: AgentUsage | undefined;

        for await (const chunk of stream) {
          throwIfAborted(normalizedInput.signal);
          modelChunkCount += 1;
          if (modelChunkCount > MAX_MODEL_CHUNKS_PER_RUN) {
            throw new AgentRuntimeFailure({
              code: "model_output_limit_exceeded",
              message: `The model exceeded the ${MAX_MODEL_CHUNKS_PER_RUN}-chunk stream limit.`,
              retryable: false,
            });
          }
          if (chunk.usage) roundUsage = chunk.usage;
          if (chunk.finishReason !== undefined && chunk.finishReason !== null) {
            finishReason = chunk.finishReason;
          }
          if (chunk.reasoningContent) {
            modelOutputBytes += byteLength(chunk.reasoningContent);
            assertModelOutputWithinLimit(
              modelOutputBytes,
              this.#config.limits.maxModelOutputBytes,
            );
            roundReasoningContent += chunk.reasoningContent;
          }
          if (chunk.content) {
            modelOutputBytes += byteLength(chunk.content);
            assertModelOutputWithinLimit(
              modelOutputBytes,
              this.#config.limits.maxModelOutputBytes,
            );
            roundContent += chunk.content;
            fullContent += chunk.content;
            yield {
              ...nextMeta(),
              type: "delta",
              round,
              delta: chunk.content,
            };
          }
          for (const part of chunk.toolCalls ?? []) {
            if (!Number.isSafeInteger(part.index) || part.index < 0) {
              throw new AgentRuntimeFailure({
                code: "invalid_model_response",
                message: "The model returned an invalid tool-call index.",
                retryable: false,
              });
            }
            const current = toolCallParts.get(part.index) ?? {
              id: "",
              name: "",
              arguments: "",
              argumentBytes: 0,
              oversized: false,
            };
            if (!toolCallParts.has(part.index)) {
              const remainingCalls = this.#config.limits.maxToolCalls - toolCallCount;
              if (toolCallParts.size >= remainingCalls) {
                throw new AgentRuntimeFailure({
                  code: "tool_call_limit_exceeded",
                  message: `The agent exceeded the maximum of ${this.#config.limits.maxToolCalls} tool calls.`,
                  retryable: false,
                  details: {
                    completed: toolCallCount,
                    requested: toolCallParts.size + 1,
                    limit: this.#config.limits.maxToolCalls,
                  },
                });
              }
            }
            const nextId = part.id ?? current.id;
            const nextName = current.name + (part.name ?? "");
            if (byteLength(nextId) > 256 || byteLength(nextName) > 256) {
              throw new AgentRuntimeFailure({
                code: "invalid_model_response",
                message: "The model returned an oversized tool-call identifier or name.",
                retryable: false,
              });
            }
            const argumentDelta = part.arguments ?? "";
            const argumentBytes = current.argumentBytes + byteLength(argumentDelta);
            const oversized =
              current.oversized ||
              argumentBytes > this.#config.limits.maxToolArgumentBytes;
            toolCallParts.set(part.index, {
              id: nextId,
              name: nextName,
              arguments: oversized ? "" : current.arguments + argumentDelta,
              argumentBytes,
              oversized,
            });
          }
        }

        if (finishReason === null) {
          throw new AgentModelFailure(
            "llm_error",
            "The model stream ended before reporting completion.",
            true,
          );
        }

        if (roundUsage) {
          cumulativeUsage = addUsage(cumulativeUsage, roundUsage);
          yield {
            ...nextMeta(),
            type: "usage",
            round,
            usage: roundUsage,
            cumulativeUsage,
          };
        }

        const preparedCalls = normalizeToolCalls(
          toolCallParts,
          round,
          this.#config.limits.maxToolArgumentBytes,
        );
        assertFinishReasonMatchesOutput(finishReason, preparedCalls.length > 0);
        if (preparedCalls.length === 0) {
          yield {
            ...nextMeta(),
            type: "done",
            content: fullContent,
            finishReason,
            rounds: round,
            usage: cumulativeUsage,
          };
          return;
        }

        if (
          toolCallCount + preparedCalls.length >
          this.#config.limits.maxToolCalls
        ) {
          throw new AgentRuntimeFailure({
            code: "tool_call_limit_exceeded",
            message: `The agent exceeded the maximum of ${this.#config.limits.maxToolCalls} tool calls.`,
            retryable: false,
            details: {
              completed: toolCallCount,
              requested: preparedCalls.length,
              limit: this.#config.limits.maxToolCalls,
            },
          });
        }
        toolCallCount += preparedCalls.length;

        messages.push({
          role: "assistant",
          content: roundContent || null,
          ...(roundReasoningContent
            ? { reasoning_content: roundReasoningContent }
            : {}),
          tool_calls: preparedCalls.map(({ call }) => call),
        });
        for (const prepared of preparedCalls) {
          yield {
            ...nextMeta(),
            type: "tool_call",
            round,
            callId: prepared.call.id,
            name: prepared.call.function.name,
            rawArguments: prepared.call.function.arguments,
            ...(prepared.arguments === undefined
              ? {}
              : { arguments: prepared.arguments }),
          };
        }

        const outcomes: Array<ToolExecutionOutcome | undefined> = new Array(
          preparedCalls.length,
        );
        for await (const completed of executeToolBatch(
          toolExecutor,
          preparedCalls,
          {
            runId,
            round,
            signal: normalizedInput.signal,
            metadata: normalizedInput.metadata,
          },
          this.#config.limits.maxToolConcurrency,
        )) {
          outcomes[completed.index] = completed.outcome;
          yield { ...nextMeta(), ...completed.outcome.result };
        }
        throwIfAborted(normalizedInput.signal);
        for (const outcome of outcomes) {
          if (!outcome) {
            throw new AgentRuntimeFailure({
              code: "tool_execution_failed",
              message: "A tool call completed without a result.",
              retryable: false,
            });
          }
          messages.push(outcome.message);
        }

        if (round === this.#config.limits.maxRounds) {
          throw new AgentRuntimeFailure({
            code: "max_rounds_exceeded",
            message: `The agent exceeded the maximum of ${this.#config.limits.maxRounds} model rounds.`,
            retryable: false,
          });
        }
      }
    } catch (error) {
      yield {
        ...nextMeta(),
        type: "error",
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

function normalizeToolCalls(
  parts: ReadonlyMap<
    number,
    { readonly id: string; readonly name: string; readonly arguments: string }
    & { readonly oversized?: boolean }
  >,
  round: number,
  maxArgumentBytes: number,
): PreparedToolCall[] {
  const seenIds = new Set<string>();
  return [...parts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, part]) => {
      const candidate = part.id.trim();
      const fallback = `call_${round}_${index}`;
      let id = candidate && !seenIds.has(candidate) ? candidate : fallback;
      let suffix = 2;
      while (seenIds.has(id)) {
        id = `${fallback}_${suffix}`;
        suffix += 1;
      }
      seenIds.add(id);
      const oversized =
        part.oversized === true || byteLength(part.arguments) > maxArgumentBytes;
      const call: ChatCompletionToolCall = {
        id,
        type: "function",
        function: { name: part.name, arguments: oversized ? "{}" : part.arguments },
      };
      if (oversized) {
        return {
          call,
          parseError: {
            code: "invalid_tool_arguments" as const,
            message: `Arguments for tool "${part.name}" exceed the ${maxArgumentBytes}-byte limit.`,
            retryable: false,
          },
        };
      }
      return prepareToolCall(call);
    });
}

function fitModelRequestContext(input: {
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly unknown[];
  readonly model: string;
  readonly temperature?: number;
  readonly options: Readonly<Record<string, unknown>>;
  readonly budget?: ModelContextBudget;
}): AgentMessage[] {
  const messages = [...input.messages];
  if (!input.budget) return messages;

  const maxInputTokens =
    input.budget.contextWindowTokens - input.budget.reservedOutputTokens;
  let estimate = estimateModelRequest(messages, input);
  let droppedHistoryTurns = 0;

  while (estimate.estimatedTokens > maxInputTokens) {
    const oldestTurn = findOldestDroppableTurn(messages);
    if (!oldestTurn) break;
    messages.splice(oldestTurn.start, oldestTurn.length);
    droppedHistoryTurns += 1;
    estimate = estimateModelRequest(messages, input);
  }

  if (estimate.estimatedTokens <= maxInputTokens) return messages;
  throw new AgentRuntimeFailure({
    code: "context_window_exceeded",
    message:
      "The current model request exceeds the configured context window after dropping all complete historical turns.",
    retryable: false,
    details: {
      contextWindowTokens: input.budget.contextWindowTokens,
      reservedOutputTokens: input.budget.reservedOutputTokens,
      maxInputTokens,
      estimatedInputTokens: estimate.estimatedTokens,
      estimatedInputBytes: estimate.serializedBytes,
      droppedHistoryTurns,
    },
  });
}

function estimateModelRequest(
  messages: readonly AgentMessage[],
  input: {
    readonly tools: readonly unknown[];
    readonly model: string;
    readonly temperature?: number;
    readonly options: Readonly<Record<string, unknown>>;
  },
): { readonly estimatedTokens: number; readonly serializedBytes: number } {
  let serialized: string;
  try {
    serialized = JSON.stringify({
      ...input.options,
      model: input.model,
      messages,
      stream: true,
      ...(input.tools.length > 0 ? { tools: input.tools } : {}),
      ...(input.temperature === undefined
        ? {}
        : { temperature: input.temperature }),
    });
  } catch (error) {
    throw new AgentRuntimeFailure({
      code: "llm_error",
      message: "The model request could not be serialized for context budgeting.",
      retryable: false,
      details: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  const serializedBytes = byteLength(serialized);
  return {
    // Three UTF-8 bytes per token is intentionally conservative for mixed
    // Chinese, source code, JSON schemas, reasoning, and tool-result payloads.
    estimatedTokens: Math.ceil(serializedBytes / 3) + 16,
    serializedBytes,
  };
}

function findOldestDroppableTurn(
  messages: readonly AgentMessage[],
): { readonly start: number; readonly length: number } | undefined {
  const userIndexes: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") userIndexes.push(index);
  }
  if (userIndexes.length < 2) return undefined;

  const currentTurnStart = userIndexes.at(-1) as number;
  for (let index = 0; index < userIndexes.length - 1; index += 1) {
    const start = userIndexes[index];
    const end = userIndexes[index + 1];
    if (end > currentTurnStart) break;
    const turn = messages.slice(start, end);
    if (
      turn.some((message) => message.role === "system") ||
      !turn.some((message) => message.role === "assistant")
    ) {
      continue;
    }
    return { start, length: end - start };
  }
  return undefined;
}

function assertModelOutputWithinLimit(
  outputBytes: number,
  maxOutputBytes: number,
): void {
  if (outputBytes <= maxOutputBytes) return;
  throw new AgentRuntimeFailure({
    code: "model_output_limit_exceeded",
    message: `The model exceeded the ${maxOutputBytes}-byte output limit.`,
    retryable: false,
  });
}

function assertFinishReasonMatchesOutput(
  finishReason: string,
  hasToolCalls: boolean,
): void {
  if (finishReason !== "stop" && finishReason !== "tool_calls") {
    throw new AgentRuntimeFailure({
      code: "llm_error",
      message: describeIncompleteFinish(finishReason),
      retryable: false,
      details: { finishReason, outcome: "incomplete" },
    });
  }
  if (hasToolCalls === (finishReason === "tool_calls")) return;
  throw new AgentRuntimeFailure({
    code: "invalid_model_response",
    message: hasToolCalls
      ? `The model emitted tool calls but reported finish reason "${finishReason}".`
      : 'The model reported finish reason "tool_calls" without emitting a tool call.',
    retryable: false,
    details: { finishReason, hasToolCalls },
  });
}

function describeIncompleteFinish(finishReason: string): string {
  switch (finishReason) {
    case "length":
      return "The model stopped before completion because it reached its output token limit.";
    case "content_filter":
      return "The model stopped before completion because its output was filtered.";
    case "insufficient_system_resource":
      return "The model stopped before completion because the provider had insufficient system resources.";
    default:
      return `The model stopped with unsupported finish reason "${finishReason}".`;
  }
}

function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortFailure(signal);
}

function abortFailure(signal?: AbortSignal): AgentRuntimeFailure {
  return new AgentRuntimeFailure({
    code: "aborted",
    message:
      signal?.reason instanceof Error
        ? signal.reason.message
        : "The agent run was aborted.",
    retryable: false,
  });
}

function normalizeRuntimeError(
  error: unknown,
  signal?: AbortSignal,
): AgentErrorInfo {
  if (signal?.aborted) return abortFailure(signal).info;
  if (error instanceof AgentRuntimeFailure) return error.info;
  if (error instanceof AgentModelFailure) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "llm_error",
    message: "The model request failed.",
    retryable: true,
  };
}

function normalizeConfig(config: AgentConfig): NormalizedConfig {
  const model = config.modelProvider ??
    (config.client && config.model
      ? createOpenAICompatibleModel(config.client, config.model)
      : undefined);
  if (!model) {
    throw new Error("Provide modelProvider or both client and model.");
  }

  const limits: AgentLimits = {
    maxRounds: config.maxRounds ?? DEFAULT_LIMITS.maxRounds,
    maxToolCalls: config.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
    maxToolConcurrency:
      config.maxToolConcurrency ?? DEFAULT_LIMITS.maxToolConcurrency,
    maxModelOutputBytes:
      config.maxModelOutputBytes ?? DEFAULT_LIMITS.maxModelOutputBytes,
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_LIMITS.toolTimeoutMs,
    maxToolArgumentBytes:
      config.maxToolArgumentBytes ?? DEFAULT_LIMITS.maxToolArgumentBytes,
    maxToolResultBytes:
      config.maxToolResultBytes ?? DEFAULT_LIMITS.maxToolResultBytes,
  };
  for (const [name, value] of Object.entries(limits)) {
    assertPositiveSafeInteger(value, name);
  }
  if (limits.maxModelOutputBytes > MAX_AGENT_MODEL_OUTPUT_BYTES) {
    throw new RangeError(
      `maxModelOutputBytes must not exceed ${MAX_AGENT_MODEL_OUTPUT_BYTES}.`,
    );
  }
  if (limits.maxToolArgumentBytes > MAX_AGENT_TOOL_ARGUMENT_BYTES) {
    throw new RangeError(
      `maxToolArgumentBytes must not exceed ${MAX_AGENT_TOOL_ARGUMENT_BYTES}.`,
    );
  }
  if (limits.maxToolResultBytes > MAX_AGENT_TOOL_RESULT_BYTES) {
    throw new RangeError(
      `maxToolResultBytes must not exceed ${MAX_AGENT_TOOL_RESULT_BYTES}.`,
    );
  }

  const tools = config.tools instanceof ToolRegistry
    ? new ToolRegistry(config.tools.list())
    : new ToolRegistry((config.tools ?? []) as readonly AgentTool[]);
  return {
    model,
    systemPrompt: config.systemPrompt,
    tools,
    limits,
    contextBudget: normalizeContextBudget(config),
    toolPolicy: config.toolPolicy,
    temperature: config.temperature,
    requestOptions: config.requestOptions ?? {},
    idGenerator: config.idGenerator ?? defaultIdGenerator,
    now: config.now ?? (() => new Date()),
  };
}

function normalizeContextBudget(
  config: Pick<AgentConfig, "contextWindowTokens" | "reservedOutputTokens">,
): ModelContextBudget | undefined {
  const contextWindowTokens = config.contextWindowTokens;
  const reservedOutputTokens = config.reservedOutputTokens;
  if (contextWindowTokens === undefined && reservedOutputTokens === undefined) {
    return undefined;
  }
  if (
    contextWindowTokens === undefined ||
    reservedOutputTokens === undefined
  ) {
    throw new RangeError(
      "contextWindowTokens and reservedOutputTokens must be configured together.",
    );
  }
  assertPositiveSafeInteger(contextWindowTokens, "contextWindowTokens");
  if (
    !Number.isSafeInteger(reservedOutputTokens) ||
    reservedOutputTokens < 0
  ) {
    throw new RangeError(
      "reservedOutputTokens must be a non-negative safe integer.",
    );
  }
  if (reservedOutputTokens >= contextWindowTokens) {
    throw new RangeError(
      "reservedOutputTokens must be smaller than contextWindowTokens.",
    );
  }
  return { contextWindowTokens, reservedOutputTokens };
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
