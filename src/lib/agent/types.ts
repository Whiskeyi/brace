import type { AgentTool, OpenAIToolDefinition, ToolRegistry } from "../tools";

export interface OpenAICompatibleClient {
  readonly chat: {
    readonly completions: {
      readonly create: (...args: never[]) => unknown;
    };
  };
}

export interface ChatCompletionToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export type AgentMessage =
  | {
      readonly role: "system";
      readonly content: string;
    }
  | {
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly ChatCompletionToolCall[];
    }
  | {
      readonly role: "tool";
      readonly tool_call_id: string;
      readonly content: string;
    };

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly AgentMessage[];
  readonly stream: true;
  readonly stream_options?: {
    readonly include_usage: boolean;
  };
  readonly tools?: readonly OpenAIToolDefinition[];
  readonly temperature?: number;
  readonly [key: string]: unknown;
}

export interface ChatCompletionRequestOptions {
  readonly signal?: AbortSignal;
}

export interface ChatCompletionChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly {
        readonly index: number;
        readonly id?: string;
        readonly type?: "function";
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  } | null;
}

export interface AgentUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface AgentErrorInfo {
  readonly code:
    | "aborted"
    | "invalid_tool_arguments"
    | "llm_error"
    | "max_rounds_exceeded"
    | "tool_execution_failed"
    | "tool_result_serialization_failed"
    | "tool_timeout"
    | "unknown_tool";
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

interface AgentEventBase {
  readonly runId: string;
}

export interface AgentStartEvent extends AgentEventBase {
  readonly type: "start";
  readonly model: string;
  readonly maxRounds: number;
}

export interface AgentDeltaEvent extends AgentEventBase {
  readonly type: "delta";
  readonly round: number;
  readonly delta: string;
}

export interface AgentToolCallEvent extends AgentEventBase {
  readonly type: "tool_call";
  readonly round: number;
  readonly callId: string;
  readonly name: string;
  readonly rawArguments: string;
  readonly arguments?: unknown;
}

export interface AgentToolResultEvent extends AgentEventBase {
  readonly type: "tool_result";
  readonly round: number;
  readonly callId: string;
  readonly name: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly output?: unknown;
  readonly error?: AgentErrorInfo;
}

export interface AgentUsageEvent extends AgentEventBase {
  readonly type: "usage";
  readonly round: number;
  readonly usage: AgentUsage;
  readonly cumulativeUsage: AgentUsage;
}

export interface AgentDoneEvent extends AgentEventBase {
  readonly type: "done";
  readonly content: string;
  readonly finishReason: string | null;
  readonly rounds: number;
  readonly usage: AgentUsage;
}

export interface AgentErrorEvent extends AgentEventBase {
  readonly type: "error";
  readonly round?: number;
  readonly error: AgentErrorInfo;
}

export type AgentEvent =
  | AgentStartEvent
  | AgentDeltaEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentUsageEvent
  | AgentDoneEvent
  | AgentErrorEvent;

export interface AgentRunInput {
  readonly messages: readonly AgentMessage[];
  readonly signal?: AbortSignal;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly runId?: string;
}

export interface AgentConfig {
  readonly client: OpenAICompatibleClient;
  readonly model: string;
  readonly systemPrompt?: string;
  /** Omit to use the built-in time and calculator tools; pass [] to disable tools. */
  readonly tools?: ToolRegistry | readonly AgentTool[];
  readonly maxRounds?: number;
  readonly toolTimeoutMs?: number;
  readonly temperature?: number;
  readonly requestOptions?: Readonly<Record<string, unknown>>;
  readonly idGenerator?: () => string;
}

export interface Agent {
  run(input: AgentRunInput | string): AsyncGenerator<AgentEvent, void, void>;
}
