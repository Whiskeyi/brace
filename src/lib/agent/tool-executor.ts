import { ToolRegistry } from "../tools/registry";
import {
  AgentToolError,
  type ToolExecutionContext,
} from "../tools/types";
import { AgentRuntimeFailure } from "./errors";
import type {
  AgentErrorInfo,
  AgentMessage,
  AgentToolResultEvent,
  ChatCompletionToolCall,
  ToolPolicy,
  ToolPolicyDecision,
} from "./types";

export interface PreparedToolCall {
  readonly call: ChatCompletionToolCall;
  readonly arguments?: unknown;
  readonly parseError?: AgentErrorInfo;
}

export interface ToolExecutionOutcome {
  readonly result: Omit<
    AgentToolResultEvent,
    "protocolVersion" | "sequence" | "timestamp" | "runId"
  >;
  readonly message: Extract<AgentMessage, { readonly role: "tool" }>;
}

export interface ToolExecutionOptions {
  readonly runId: string;
  readonly round: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface ToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly policy?: ToolPolicy;
}

type RegisteredTool = NonNullable<ReturnType<ToolRegistry["get"]>>;

type ToolValidationResult =
  | {
      readonly success: true;
      readonly data: unknown;
    }
  | {
      readonly success: false;
      readonly error: {
        readonly issues: unknown;
      };
    };

export class ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #timeoutMs: number;
  readonly #maxResultBytes: number;
  readonly #policy?: ToolPolicy;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #indeterminateLocks = new Set<string>();

  constructor(options: ToolExecutorOptions) {
    assertPositiveSafeInteger(options.timeoutMs, "timeoutMs");
    assertPositiveSafeInteger(options.maxResultBytes, "maxResultBytes");
    this.#registry = options.registry;
    this.#timeoutMs = options.timeoutMs;
    this.#maxResultBytes = options.maxResultBytes;
    this.#policy = options.policy;
  }

  async execute(
    prepared: PreparedToolCall,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionOutcome> {
    const startedAt = Date.now();
    const { call } = prepared;

    if (prepared.parseError) {
      return failedToolOutcome(
        call,
        options,
        prepared.parseError,
        Date.now() - startedAt,
      );
    }

    const tool = this.#registry.get(call.function.name);
    if (!tool) {
      return failedToolOutcome(
        call,
        options,
        {
          code: "unknown_tool",
          message: `Tool "${call.function.name}" is not registered.`,
          retryable: false,
        },
        Date.now() - startedAt,
      );
    }

    const signal = options.signal ?? new AbortController().signal;
    let validation: ToolValidationResult;
    try {
      validation = await awaitWithAbortAndTimeout(
        Promise.resolve().then(() =>
          tool.schema.safeParseAsync(prepared.arguments),
        ),
        signal,
        this.#timeoutMs,
        () =>
          new AgentRuntimeFailure({
            code: "tool_timeout",
            message:
              `Tool "${call.function.name}" argument validation timed out ` +
              `after ${this.#timeoutMs}ms.`,
            retryable: false,
            details: {
              phase: "validation",
              outcome: "not_started",
            },
          }),
      );
    } catch (error) {
      if (
        error instanceof AgentRuntimeFailure &&
        error.info.code === "aborted"
      ) {
        throw error;
      }
      return failedToolOutcome(
        call,
        options,
        normalizeToolPhaseError(error, call.function.name, "validation"),
        Date.now() - startedAt,
      );
    }
    if (!validation.success) {
      return failedToolOutcome(
        call,
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

    const context: ToolExecutionContext = {
      callId: call.id,
      runId: options.runId,
      round: options.round,
      signal,
      metadata: options.metadata,
    };
    const effect = tool.annotations?.effect;
    const concurrencyKey =
      tool.annotations?.concurrencyKey ??
      (effect === "write" || effect === "execute" || effect === "network"
        ? "restricted-effects"
        : undefined);
    const execute = () =>
      this.#executeAuthorized(
        tool,
        validation.data,
        context,
        startedAt,
      );

    if (!concurrencyKey) return execute();
    return this.#withLock(concurrencyKey, async () => {
      if (this.#indeterminateLocks.has(concurrencyKey)) {
        return failedToolOutcome(
          call,
          options,
          {
            code: "tool_execution_failed",
            message:
              `Tool "${tool.name}" was not executed because an earlier ` +
              "restricted call timed out with an indeterminate outcome.",
            retryable: false,
            details: { outcome: "blocked_by_indeterminate_call" },
          },
          Date.now() - startedAt,
        );
      }
      const outcome = await execute();
      if (
        outcome.result.error?.code === "tool_timeout" &&
        isIndeterminateToolFailure(outcome.result.error.details)
      ) {
        this.#indeterminateLocks.add(concurrencyKey);
      }
      return outcome;
    });
  }

  async #executeAuthorized(
    tool: RegisteredTool,
    input: unknown,
    context: ToolExecutionContext,
    startedAt: number,
  ): Promise<ToolExecutionOutcome> {
    if (context.signal.aborted) throw abortFailure(context.signal);
    const decision = await awaitWithAbort(
      this.#authorize(tool, input, context),
      context.signal,
    );
    // Authorization can settle in the same turn as cancellation. Re-check
    // before observing the decision or constructing any side-effecting call.
    if (context.signal.aborted) throw abortFailure(context.signal);
    if (!decision.allowed) {
      return failedToolOutcome(
        {
          id: context.callId,
          type: "function",
          function: { name: tool.name, arguments: "" },
        },
        context,
        {
          code: "tool_denied",
          message: decision.reason,
          retryable: false,
        },
        Date.now() - startedAt,
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort(context.signal.reason);
    const callContext = { ...context, signal: controller.signal };
    context.signal.addEventListener("abort", forwardAbort, { once: true });
    if (context.signal.aborted) forwardAbort();
    if (controller.signal.aborted) {
      context.signal.removeEventListener("abort", forwardAbort);
      throw abortFailure(context.signal);
    }
    const aborted = new Promise<never>((_, reject) => {
      const rejectAbort = () =>
        reject(
          timedOut
            ? new AgentRuntimeFailure({
                code: "tool_timeout",
                message: `Tool "${tool.name}" timed out after ${this.#timeoutMs}ms.`,
                retryable: false,
                details: { outcome: "indeterminate" },
              })
            : abortFailure(context.signal),
        );
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      if (controller.signal.aborted) rejectAbort();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Tool timed out after ${this.#timeoutMs}ms.`));
    }, this.#timeoutMs);

    try {
      const execution = Promise.resolve().then(() =>
        tool.execute(input, callContext),
      );
      const output = await Promise.race([execution, aborted]);
      const serialized = serializeToolOutput(output, this.#maxResultBytes);
      return {
        result: {
          type: "tool_result",
          round: context.round,
          callId: context.callId,
          name: tool.name,
          success: true,
          durationMs: Date.now() - startedAt,
          output: serialized.output,
          outputBytes: serialized.originalBytes,
          ...(serialized.truncated ? { truncated: true } : {}),
        },
        message: {
          role: "tool",
          tool_call_id: context.callId,
          content: serialized.content,
        },
      };
    } catch (error) {
      if (error instanceof AgentRuntimeFailure) {
        if (error.info.code === "aborted") throw error;
        return failedToolOutcome(
          {
            id: context.callId,
            type: "function",
            function: { name: tool.name, arguments: "" },
          },
          context,
          error.info,
          Date.now() - startedAt,
        );
      }
      const info: AgentErrorInfo =
        error instanceof AgentToolError
          ? {
              code: "tool_execution_failed",
              message: error.message,
              retryable: error.retryable,
              ...(error.details === undefined ? {} : { details: error.details }),
            }
          : {
              code: "tool_execution_failed",
              message: `Tool "${tool.name}" failed.`,
              retryable: false,
            };
      return failedToolOutcome(
        {
          id: context.callId,
          type: "function",
          function: { name: tool.name, arguments: "" },
        },
        context,
        info,
        Date.now() - startedAt,
      );
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", forwardAbort);
    }
  }

  async #authorize(
    tool: RegisteredTool,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolPolicyDecision> {
    if (!this.#policy) {
      return tool.annotations?.requiresApproval
        ? {
            allowed: false,
            reason: `Tool "${tool.name}" requires explicit approval.`,
          }
        : { allowed: true };
    }
    try {
      return await this.#policy.evaluate({ tool, arguments: input, context });
    } catch {
      return {
        allowed: false,
        reason: `Tool "${tool.name}" was denied because policy evaluation failed.`,
      };
    }
  }

  async #withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => released);
    this.#locks.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.#locks.get(key) === current) this.#locks.delete(key);
    }
  }
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortFailure(signal);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortFailure(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function awaitWithAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutFailure: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutFailure()), timeoutMs);
  });
  try {
    return await awaitWithAbort(Promise.race([promise, timedOut]), signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeToolPhaseError(
  error: unknown,
  toolName: string,
  phase: "validation",
): AgentErrorInfo {
  if (error instanceof AgentRuntimeFailure) {
    return error.info;
  }
  if (error instanceof AgentToolError) {
    return {
      code: "tool_execution_failed",
      message: error.message,
      retryable: error.retryable,
      details: {
        phase,
        ...(error.details === undefined ? {} : { cause: error.details }),
      },
    };
  }
  return {
    code: "tool_execution_failed",
    message: `Tool "${toolName}" argument validation failed unexpectedly.`,
    retryable: false,
    details: { phase },
  };
}

function isIndeterminateToolFailure(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    "outcome" in details &&
    details.outcome === "indeterminate"
  );
}

export function prepareToolCall(call: ChatCompletionToolCall): PreparedToolCall {
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

export async function* executeToolBatch(
  executor: ToolExecutor,
  calls: readonly PreparedToolCall[],
  options: ToolExecutionOptions,
  concurrency: number,
): AsyncGenerator<
  { readonly index: number; readonly outcome: ToolExecutionOutcome },
  void,
  void
> {
  assertPositiveSafeInteger(concurrency, "concurrency");
  let nextIndex = 0;
  type Settled =
    | { readonly index: number; readonly outcome: ToolExecutionOutcome }
    | { readonly index: number; readonly error: unknown };
  const pending = new Map<number, Promise<Settled>>();

  const startNext = () => {
    if (nextIndex >= calls.length) return;
    const index = nextIndex;
    nextIndex += 1;
    pending.set(
      index,
      executor.execute(calls[index], options).then(
        (outcome): Settled => ({ index, outcome }),
        (error): Settled => ({ index, error }),
      ),
    );
  };

  while (pending.size < Math.min(concurrency, calls.length)) startNext();
  while (pending.size > 0) {
    const completed = await Promise.race(pending.values());
    pending.delete(completed.index);
    if ("error" in completed) {
      await Promise.allSettled(pending.values());
      throw completed.error;
    }
    startNext();
    yield completed;
  }
}

function failedToolOutcome(
  call: ChatCompletionToolCall,
  options: Pick<ToolExecutionContext, "runId" | "round">,
  error: AgentErrorInfo,
  durationMs: number,
): ToolExecutionOutcome {
  const publicError = sanitizeAgentError(error);
  return {
    result: {
      type: "tool_result",
      round: options.round,
      callId: call.id,
      name: call.function.name,
      success: false,
      durationMs,
      error: publicError,
    },
    message: {
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify({ ok: false, error: publicError }),
    },
  };
}

function sanitizeAgentError(error: AgentErrorInfo): AgentErrorInfo {
  let details = error.details;
  if (details !== undefined) {
    try {
      const serialized = JSON.stringify(details);
      if (serialized === undefined) details = undefined;
      else if (byteLength(serialized) > 4_096) {
        details = {
          truncated: true,
          preview: takeUtf8Prefix(serialized, 3_800),
        };
      } else {
        details = JSON.parse(serialized);
      }
    } catch {
      details = { unavailable: true };
    }
  }
  return {
    ...error,
    message: error.message.length <= 500
      ? error.message
      : `${error.message.slice(0, 499)}…`,
    ...(details === undefined ? { details: undefined } : { details }),
  };
}

function serializeToolOutput(
  value: unknown,
  maxBytes: number,
): {
  readonly output: unknown;
  readonly content: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
} {
  let content: string;
  try {
    if (typeof value === "string") content = value;
    else if (value === undefined) content = "null";
    else {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error("Result cannot be represented as JSON.");
      content = json;
    }
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

  const originalBytes = byteLength(content);
  if (originalBytes <= maxBytes) {
    return {
      output: typeof value === "string" ? value : JSON.parse(content),
      content,
      originalBytes,
      truncated: false,
    };
  }

  const emptyEnvelope = JSON.stringify({
    truncated: true,
    originalBytes,
    preview: "",
  });
  if (byteLength(emptyEnvelope) > maxBytes) {
    const preview = takeUtf8Prefix(content, maxBytes);
    return {
      output: preview,
      content: preview,
      originalBytes,
      truncated: true,
    };
  }
  const previewBudget = Math.max(0, maxBytes - byteLength(emptyEnvelope) - 16);
  let preview = takeUtf8Prefix(content, previewBudget);
  let envelope = JSON.stringify({ truncated: true, originalBytes, preview });
  while (byteLength(envelope) > maxBytes && preview.length > 0) {
    preview = preview.slice(0, Math.floor(preview.length * 0.9));
    envelope = JSON.stringify({ truncated: true, originalBytes, preview });
  }
  return {
    output: JSON.parse(envelope),
    content: envelope,
    originalBytes,
    truncated: true,
  };
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}
