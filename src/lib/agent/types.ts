import type {
  AgentTool,
  OpenAIToolDefinition,
  ToolExecutionContext,
} from "../tools/types";
import type { ToolRegistry } from "../tools/registry";

export interface OpenAICompatibleClient {
  readonly chat: {
    readonly completions: {
      readonly create: (
        request: ChatCompletionRequest,
        options?: ChatCompletionRequestOptions,
      ) => unknown;
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
      readonly reasoning_content?: string | null;
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

/** Raw wire shape accepted from an OpenAI-compatible chat-completions client. */
export interface ChatCompletionChunk {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
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

/** Provider-neutral request consumed by the agent core. */
export interface AgentModelRequest {
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly OpenAIToolDefinition[];
  readonly temperature?: number;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface AgentModelToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

/** Canonical streaming chunk emitted by a model adapter. */
export interface AgentModelChunk {
  readonly content?: string;
  readonly reasoningContent?: string;
  readonly finishReason?: string | null;
  readonly toolCalls?: readonly AgentModelToolCallDelta[];
  readonly usage?: AgentUsage;
}

export interface AgentModel {
  readonly id: string;
  stream(
    request: AgentModelRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AsyncIterable<AgentModelChunk>>;
}

/** Hard ceilings used by the runtime for model and tool payloads. */
export const MAX_AGENT_MODEL_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_AGENT_TOOL_ARGUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_AGENT_TOOL_RESULT_BYTES = 16 * 1024 * 1024;

export interface AgentLimits {
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  readonly maxToolConcurrency: number;
  readonly maxModelOutputBytes: number;
  readonly toolTimeoutMs: number;
  readonly maxToolArgumentBytes: number;
  readonly maxToolResultBytes: number;
}

export interface AgentErrorInfo {
  readonly code:
    | "aborted"
    | "context_window_exceeded"
    | "invalid_model_response"
    | "invalid_tool_arguments"
    | "llm_error"
    | "max_rounds_exceeded"
    | "model_output_limit_exceeded"
    | "tool_call_limit_exceeded"
    | "tool_denied"
    | "tool_execution_failed"
    | "tool_result_serialization_failed"
    | "tool_timeout"
    | "unknown_tool";
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: unknown;
}

export const AGENT_EVENT_PROTOCOL_VERSION = 1 as const;

interface AgentEventBase {
  readonly protocolVersion: typeof AGENT_EVENT_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly timestamp: string;
  readonly runId: string;
  readonly replayed?: boolean;
}

export interface AgentStartEvent extends AgentEventBase {
  readonly type: "start";
  readonly model: string;
  readonly maxRounds: number;
  readonly limits: AgentLimits;
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
  readonly outputBytes?: number;
  readonly truncated?: boolean;
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

export interface ToolPolicyRequest {
  readonly tool: AgentTool;
  readonly arguments: unknown;
  readonly context: ToolExecutionContext;
}

export type ToolPolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface ToolPolicy {
  evaluate(
    request: ToolPolicyRequest,
  ): ToolPolicyDecision | PromiseLike<ToolPolicyDecision>;
}

export interface AgentConfig {
  /** Use a model adapter for new integrations. */
  readonly modelProvider?: AgentModel;
  /** Backward-compatible OpenAI chat-completions composition. */
  readonly client?: OpenAICompatibleClient;
  readonly model?: string;
  readonly systemPrompt?: string;
  /** Tools are injected by the composition root; omission means no tools. */
  readonly tools?: ToolRegistry | readonly AgentTool[];
  readonly maxRounds?: number;
  readonly maxToolCalls?: number;
  readonly maxToolConcurrency?: number;
  readonly maxModelOutputBytes?: number;
  readonly toolTimeoutMs?: number;
  readonly maxToolArgumentBytes?: number;
  readonly maxToolResultBytes?: number;
  /**
   * Provider context capacity. Set together with reservedOutputTokens to make
   * the runtime trim complete historical turns before every model round.
   */
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly toolPolicy?: ToolPolicy;
  readonly temperature?: number;
  readonly requestOptions?: Readonly<Record<string, unknown>>;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
}

export interface Agent {
  run(input: AgentRunInput | string): AsyncGenerator<AgentEvent, void, void>;
}
