import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import type {
  AgentMessage,
  ChatCompletionRequest,
  OpenAICompatibleClient,
} from "./types";

export interface OpenAISdkClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs: number;
}

export function createOpenAISdkClient(
  options: OpenAISdkClientOptions,
): OpenAICompatibleClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl,
    timeout: options.timeoutMs,
    maxRetries: 0,
  });

  return {
    chat: {
      completions: {
        async create(request, requestOptions) {
          return client.chat.completions.create(
            toOpenAIRequest(request),
            requestOptions,
          );
        },
      },
    },
  };
}

function toOpenAIRequest(
  request: ChatCompletionRequest,
): ChatCompletionCreateParamsStreaming {
  return {
    ...request,
    messages: request.messages.map(toOpenAIMessage),
    tools: request.tools?.map(toOpenAITool),
    stream: true,
  };
}

function toOpenAIMessage(message: AgentMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        content: message.content,
      };
    case "assistant": {
      const normalized = {
        role: "assistant" as const,
        content: message.content,
        ...(message.tool_calls ? { tool_calls: [...message.tool_calls] } : {}),
      };
      return message.reasoning_content === undefined
        ? normalized
        : Object.assign(normalized, {
            reasoning_content: message.reasoning_content,
          });
    }
  }
}

function toOpenAITool(
  tool: NonNullable<ChatCompletionRequest["tools"]>[number],
): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  };
}
