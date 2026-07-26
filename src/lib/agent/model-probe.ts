import type { AgentModel, AgentModelRequest } from "./types";

export const MIN_AGENT_MODEL_PROBE_OUTPUT_TOKENS = 1_024;

export interface AgentModelToolProbeOptions {
  readonly timeoutMs: number;
  readonly maxOutputTokens?: number;
  readonly promptCacheKey?: string;
  readonly requestOptions?: Readonly<Record<string, unknown>>;
}

export async function probeAgentModelToolCalling(
  model: AgentModel,
  options: AgentModelToolProbeOptions,
): Promise<{ readonly latencyMs: number }> {
  assertPositiveSafeInteger(options.timeoutMs, "timeoutMs");
  const maxOutputTokens =
    options.maxOutputTokens ?? MIN_AGENT_MODEL_PROBE_OUTPUT_TOKENS;
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < MIN_AGENT_MODEL_PROBE_OUTPUT_TOKENS
  ) {
    throw new RangeError(
      `maxOutputTokens must be at least ${MIN_AGENT_MODEL_PROBE_OUTPUT_TOKENS}.`,
    );
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Model connection test timed out.")),
    options.timeoutMs,
  );
  try {
    const stream = await model.stream(
      createProbeRequest(options, maxOutputTokens),
      { signal: controller.signal },
    );
    let finishReason: string | null = null;
    const calls = new Map<number, { name: string; arguments: string }>();
    for await (const chunk of stream) {
      if (chunk.finishReason !== undefined) {
        finishReason = chunk.finishReason;
      }
      for (const part of chunk.toolCalls ?? []) {
        if (!Number.isSafeInteger(part.index) || part.index < 0) {
          throw new Error("The model returned an invalid tool-call index.");
        }
        if (!calls.has(part.index) && calls.size >= 8) {
          throw new Error("The model returned too many tool-call probes.");
        }
        const current = calls.get(part.index) ?? { name: "", arguments: "" };
        current.name += part.name ?? "";
        current.arguments += part.arguments ?? "";
        if (current.name.length > 256) {
          throw new Error("The model returned an oversized tool-call name.");
        }
        if (current.arguments.length > 4_096) {
          throw new Error("The model returned an oversized tool-call probe.");
        }
        calls.set(part.index, current);
      }
    }

    if (finishReason !== "tool_calls") {
      throw new Error(
        finishReason === null
          ? "The model stream ended before reporting completion."
          : `The model capability probe ended with finish reason "${finishReason}" instead of "tool_calls".`,
      );
    }
    if (calls.size !== 1) {
      throw new Error(
        "The model endpoint responded, but did not produce the required tool call.",
      );
    }
    const [call] = calls.values();
    assertValidProbeCall(call);
    return { latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Model connection test timed out after ${options.timeoutMs}ms.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function createProbeRequest(
  options: AgentModelToolProbeOptions,
  maxOutputTokens: number,
): AgentModelRequest {
  const requestOptions: Record<string, unknown> = {
    ...options.requestOptions,
  };
  delete requestOptions.max_tokens;
  delete requestOptions.max_completion_tokens;
  delete requestOptions.tool_choice;
  delete requestOptions.prompt_cache_key;
  return {
    messages: [
      {
        role: "user",
        content:
          'Call base_agent_connection_probe exactly once with {"status":"ok"}. Do not reply with text.',
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "base_agent_connection_probe",
          description:
            "Confirm that this model endpoint supports coding-agent tool calls.",
          parameters: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
            },
            required: ["status"],
            additionalProperties: false,
          },
        },
      },
    ],
    options: {
      ...requestOptions,
      max_tokens: maxOutputTokens,
      ...(options.promptCacheKey
        ? { prompt_cache_key: normalizePromptCacheKey(options.promptCacheKey) }
        : {}),
    },
  };
}

function assertValidProbeCall(call: {
  readonly name: string;
  readonly arguments: string;
}): void {
  if (call.name !== "base_agent_connection_probe") {
    throw new Error(
      `The model called an unexpected tool: ${call.name || "(missing name)"}.`,
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(call.arguments);
  } catch {
    throw new Error("The model returned malformed tool-call arguments.");
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input as Record<string, unknown>).status !== "ok" ||
    Object.keys(input).length !== 1
  ) {
    throw new Error(
      "The model returned invalid arguments for the tool-call probe.",
    );
  }
}

function normalizePromptCacheKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new RangeError(
      "promptCacheKey must contain between 1 and 256 characters.",
    );
  }
  return normalized;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}
