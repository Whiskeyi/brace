import type { AgentMessage as RuntimeMessage } from "@/lib/agent";
import type { AgentMessage as StoredMessage, JsonValue } from "@/lib/repositories";

export interface BuildAgentContextInput {
  readonly history: readonly StoredMessage[];
  readonly userMessage: string;
  readonly systemPrompt?: string;
  readonly maxHistoryMessages: number;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
}

export interface BuiltAgentContext {
  readonly messages: readonly RuntimeMessage[];
  readonly estimatedTokens: number;
  readonly includedHistoryMessages: number;
  readonly droppedHistoryMessages: number;
}

export class ContextWindowExceededError extends RangeError {
  constructor(
    readonly requiredTokens: number,
    readonly contextWindowTokens: number,
  ) {
    super("The system prompt, current message, and output reserve exceed the context window.");
    this.name = "ContextWindowExceededError";
  }
}

interface CompletedTurn {
  readonly user: RuntimeMessage;
  readonly assistant: RuntimeMessage;
  readonly estimatedTokens: number;
}

/**
 * Builds complete user/assistant turns newest-first within a conservative token
 * budget. Failed, stopped, orphaned, tool, and system rows never leak into a
 * subsequent model attempt.
 */
export function buildAgentContext(
  input: BuildAgentContextInput,
): BuiltAgentContext {
  assertPositiveInteger(input.maxHistoryMessages, "maxHistoryMessages");
  assertPositiveInteger(input.contextWindowTokens, "contextWindowTokens");
  if (!Number.isSafeInteger(input.reservedOutputTokens) || input.reservedOutputTokens < 0) {
    throw new RangeError("reservedOutputTokens must be a non-negative integer.");
  }

  const turns = completedTurns(input.history);
  const user: RuntimeMessage = { role: "user", content: input.userMessage };
  const fixedTokens =
    (input.systemPrompt ? estimateTextTokens(input.systemPrompt) + 4 : 0) +
    estimateMessageTokens(user) +
    input.reservedOutputTokens;
  if (fixedTokens > input.contextWindowTokens) {
    throw new ContextWindowExceededError(fixedTokens, input.contextWindowTokens);
  }
  let remainingTokens = Math.max(0, input.contextWindowTokens - fixedTokens);
  const maxTurnMessages = input.maxHistoryMessages - (input.maxHistoryMessages % 2);
  const selected: CompletedTurn[] = [];
  let selectedMessages = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      selectedMessages + 2 > maxTurnMessages ||
      turn.estimatedTokens > remainingTokens
    ) {
      break;
    }
    selected.unshift(turn);
    selectedMessages += 2;
    remainingTokens -= turn.estimatedTokens;
  }

  const messages: RuntimeMessage[] = [];
  for (const turn of selected) messages.push(turn.user, turn.assistant);
  messages.push(user);
  const estimatedTokens =
    (input.systemPrompt ? estimateTextTokens(input.systemPrompt) + 4 : 0) +
    messages.reduce((total, message) => total + estimateMessageTokens(message), 0);

  return {
    messages,
    estimatedTokens,
    includedHistoryMessages: selectedMessages,
    droppedHistoryMessages: input.history.length - selectedMessages,
  };
}

export function estimateTextTokens(value: string): number {
  if (!value) return 0;
  // A conservative mixed Chinese/code estimate without coupling core code to a
  // provider-specific tokenizer. Provider adapters may replace this later.
  return Math.ceil(new TextEncoder().encode(value).byteLength / 3);
}

function completedTurns(history: readonly StoredMessage[]): CompletedTurn[] {
  const turns: CompletedTurn[] = [];
  let pendingUser: RuntimeMessage | null = null;

  for (const message of history) {
    if (message.role === "user") {
      pendingUser = { role: "user", content: stringContent(message.content) };
      continue;
    }
    if (message.role !== "assistant" || !pendingUser) continue;

    const status = message.metadata.status;
    if (status === undefined || status === "completed") {
      const assistant: RuntimeMessage = {
        role: "assistant",
        content: stringContent(message.content),
      };
      turns.push({
        user: pendingUser,
        assistant,
        estimatedTokens:
          estimateMessageTokens(pendingUser) + estimateMessageTokens(assistant),
      });
    }
    pendingUser = null;
  }
  return turns;
}

function estimateMessageTokens(message: RuntimeMessage): number {
  if (message.role === "tool") return estimateTextTokens(message.content) + 8;
  const content = message.content ?? "";
  return estimateTextTokens(content) + 4;
}

function stringContent(content: JsonValue): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}
