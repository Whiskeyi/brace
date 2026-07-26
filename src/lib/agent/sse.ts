import {
  MAX_AGENT_MODEL_OUTPUT_BYTES,
  MAX_AGENT_TOOL_ARGUMENT_BYTES,
  MAX_AGENT_TOOL_RESULT_BYTES,
  type AgentEvent,
} from "./types";

/**
 * JSON can expand a raw model string by up to six times when control bytes are
 * escaped. Eight times the runtime ceiling leaves bounded room for envelopes,
 * tool arguments/results, and replay metadata.
 */
export const MAX_AGENT_SSE_FRAME_BYTES = Math.max(
  MAX_AGENT_MODEL_OUTPUT_BYTES,
  MAX_AGENT_TOOL_ARGUMENT_BYTES,
  MAX_AGENT_TOOL_RESULT_BYTES,
) * 8;

export class AgentEventProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentEventProtocolError";
  }
}

export function encodeAgentEvent(event: AgentEvent): string {
  const frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (utf8ByteLength(frame) > MAX_AGENT_SSE_FRAME_BYTES) {
    throw new AgentEventProtocolError("Agent SSE frame exceeded the byte limit.");
  }
  return frame;
}

export function encodeAgentStreamEnd(): string {
  return "data: [DONE]\n\n";
}

export function encodeAgentHeartbeat(): string {
  return `: heartbeat ${Date.now()}\n\n`;
}

export async function* encodeAgentEvents(
  events: AsyncIterable<AgentEvent>,
): AsyncGenerator<string, void, void> {
  for await (const event of events) yield encodeAgentEvent(event);
}

export async function* decodeAgentEvents(
  stream: ReadableStream<Uint8Array>,
  options: { readonly maxFrameBytes?: number } = {},
): AsyncGenerator<AgentEvent, void, void> {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_AGENT_SSE_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new RangeError("maxFrameBytes must be a positive safe integer.");
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bufferBytes = 0;
  let runId: string | undefined;
  let lastSequence = 0;
  let terminal = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      bufferBytes = utf8ByteLength(buffer);
      if (bufferBytes > maxFrameBytes) {
        throw new AgentEventProtocolError("Agent SSE frame exceeded the byte limit.");
      }
      for (const frame of frames) {
        if (utf8ByteLength(frame) > maxFrameBytes) {
          throw new AgentEventProtocolError("Agent SSE frame exceeded the byte limit.");
        }
        const event = decodeFrame(frame);
        if (event) {
          validateStreamOrder(event, runId, lastSequence, terminal);
          runId = event.runId;
          lastSequence = event.sequence;
          terminal = event.type === "done" || event.type === "error";
          yield event;
        }
      }
      if (done) break;
    }

    if (buffer.trim()) {
      const event = decodeFrame(buffer);
      if (event) {
        validateStreamOrder(event, runId, lastSequence, terminal);
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function agentEventsToSSE(
  events: AsyncIterable<AgentEvent>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = encodeAgentEvents(events)[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.enqueue(encoder.encode(encodeAgentStreamEnd()));
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function decodeFrame(frame: string): AgentEvent | null {
  if (!frame.trim() || frame.startsWith(":")) return null;
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new AgentEventProtocolError("Agent SSE contained invalid JSON.", {
      cause: error,
    });
  }
  return parseAgentEvent(parsed);
}

export function parseAgentEvent(value: unknown): AgentEvent {
  if (!isAgentEvent(value)) {
    throw new AgentEventProtocolError("Agent SSE contained an invalid event.");
  }
  return value;
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const validBase = (
    event.protocolVersion === 1 &&
    Number.isSafeInteger(event.sequence) &&
    (event.sequence as number) > 0 &&
    typeof event.timestamp === "string" &&
    !Number.isNaN(Date.parse(event.timestamp)) &&
    typeof event.runId === "string" &&
    event.runId.length > 0 &&
    typeof event.type === "string" &&
    (event.replayed === undefined || typeof event.replayed === "boolean")
  );
  if (!validBase) return false;

  switch (event.type) {
    case "start":
      return (
        typeof event.model === "string" &&
        isPositiveInteger(event.maxRounds) &&
        isLimits(event.limits)
      );
    case "delta":
      return isPositiveInteger(event.round) && typeof event.delta === "string";
    case "tool_call":
      return (
        isPositiveInteger(event.round) &&
        typeof event.callId === "string" &&
        typeof event.name === "string" &&
        typeof event.rawArguments === "string"
      );
    case "tool_result":
      return (
        isPositiveInteger(event.round) &&
        typeof event.callId === "string" &&
        typeof event.name === "string" &&
        typeof event.success === "boolean" &&
        typeof event.durationMs === "number" &&
        Number.isFinite(event.durationMs) &&
        event.durationMs >= 0 &&
        (event.outputBytes === undefined || isNonNegativeInteger(event.outputBytes)) &&
        (event.truncated === undefined || typeof event.truncated === "boolean") &&
        (event.success
          ? event.error === undefined
          : event.error !== undefined && isAgentError(event.error))
      );
    case "usage":
      return (
        isPositiveInteger(event.round) &&
        isUsage(event.usage) &&
        isUsage(event.cumulativeUsage)
      );
    case "done":
      return (
        typeof event.content === "string" &&
        (event.finishReason === null || typeof event.finishReason === "string") &&
        isPositiveInteger(event.rounds) &&
        isUsage(event.usage)
      );
    case "error":
      return (
        (event.round === undefined || isPositiveInteger(event.round)) &&
        isAgentError(event.error)
      );
    default:
      return false;
  }
}

function isLimits(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "maxRounds",
    "maxToolCalls",
    "maxToolConcurrency",
    "maxModelOutputBytes",
    "toolTimeoutMs",
    "maxToolArgumentBytes",
    "maxToolResultBytes",
  ].every((key) => isPositiveInteger(value[key]));
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["promptTokens", "completionTokens", "totalTokens"].every(
    (key) =>
      typeof value[key] === "number" &&
      Number.isSafeInteger(value[key]) &&
      (value[key] as number) >= 0,
  );
}

function isAgentError(value: unknown): boolean {
  return (
    isRecord(value) &&
    AGENT_ERROR_CODES.has(value.code as string) &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean"
  );
}

const AGENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "aborted",
  "context_window_exceeded",
  "invalid_model_response",
  "invalid_tool_arguments",
  "llm_error",
  "max_rounds_exceeded",
  "model_output_limit_exceeded",
  "tool_call_limit_exceeded",
  "tool_denied",
  "tool_execution_failed",
  "tool_result_serialization_failed",
  "tool_timeout",
  "unknown_tool",
]);

function validateStreamOrder(
  event: AgentEvent,
  runId: string | undefined,
  lastSequence: number,
  terminal: boolean,
): void {
  if (terminal) {
    throw new AgentEventProtocolError("Agent SSE continued after a terminal event.");
  }
  if (lastSequence === 0 && (event.type !== "start" || event.sequence !== 1)) {
    throw new AgentEventProtocolError("Agent SSE must begin with start sequence 1.");
  }
  if (runId !== undefined && event.runId !== runId) {
    throw new AgentEventProtocolError("Agent SSE mixed events from different runs.");
  }
  if (event.sequence <= lastSequence) {
    throw new AgentEventProtocolError("Agent SSE event sequence is not increasing.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
