import type { z } from "zod";

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
  readonly parameters?: Readonly<Record<string, unknown>>;
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
