import type { z } from "zod";

export type ToolEffect = "read" | "write" | "execute" | "network";

/**
 * Machine-readable behavior used by the runtime policy and scheduler.
 * Descriptions are for the model; annotations are the trusted control plane.
 */
export interface ToolAnnotations {
  readonly effect: ToolEffect;
  readonly idempotent?: boolean;
  readonly requiresApproval?: boolean;
  /** Calls with the same key must not execute concurrently. */
  readonly concurrencyKey?: string;
}

/** A tool may throw this error when a message is safe to expose to the model. */
export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentToolError";
  }
}

export interface ToolExecutionContext {
  readonly callId: string;
  readonly runId: string;
  readonly round: number;
  readonly signal: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<TInput>;
  readonly annotations?: ToolAnnotations;
  execute(
    input: TInput,
    context: ToolExecutionContext,
  ): TOutput | PromiseLike<TOutput>;
}

export interface OpenAIToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}
