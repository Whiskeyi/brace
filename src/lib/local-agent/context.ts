import type { AgentMessage } from "../agent";
import type { LocalMessage, LocalRunStatus } from "./types";

export interface BuildLocalAgentContextInput {
  readonly history: readonly LocalMessage[];
  readonly currentMessageId: string;
  readonly systemPrompt?: string;
  readonly maxHistoryMessages: number;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
}

export interface BuiltLocalAgentContext {
  readonly messages: readonly AgentMessage[];
  readonly estimatedTokens: number;
  readonly includedHistoryMessages: number;
  readonly droppedHistoryMessages: number;
}

export class LocalContextWindowExceededError extends RangeError {
  constructor(
    readonly requiredTokens: number,
    readonly contextWindowTokens: number,
  ) {
    super(
      "The coding instructions and output reserve exceed the configured context window.",
    );
    this.name = "LocalContextWindowExceededError";
  }
}

interface CompletedTurn {
  readonly user: AgentMessage;
  readonly assistant: AgentMessage;
  readonly estimatedTokens: number;
}

export function formatLocalRunStatusCompletion(
  status: Extract<LocalRunStatus, "completed" | "failed" | "cancelled">,
  errorMessage?: string | null,
): string {
  if (status === "completed") {
    return "[Run completed without a final response.]";
  }
  const label = status === "cancelled" ? "cancelled" : "failed";
  const reason = errorMessage?.trim();
  return reason
    ? `[Run ${label} before completion] ${reason.slice(0, 500)}`
    : `[Run ${label} before completion]`;
}

/**
 * Selects newest complete user/assistant turns plus the current prompt.
 *
 * Every durable run has an assistant completion row. Failed, cancelled, and
 * interrupted runs use an explicit synthetic status completion so the next
 * request retains the instruction without implying that it succeeded.
 * Pairing still ignores legacy unpaired rows from older databases.
 */
export function buildLocalAgentContext(
  input: BuildLocalAgentContextInput,
): BuiltLocalAgentContext {
  assertPositiveInteger(input.maxHistoryMessages, "maxHistoryMessages");
  assertPositiveInteger(input.contextWindowTokens, "contextWindowTokens");
  if (
    !Number.isSafeInteger(input.reservedOutputTokens) ||
    input.reservedOutputTokens < 0
  ) {
    throw new RangeError("reservedOutputTokens must be a non-negative integer.");
  }

  const current = input.history.find(
    (message) => message.id === input.currentMessageId,
  );
  if (!current || current.role !== "user") {
    throw new Error("The current local user message was not found.");
  }

  const historicalMessages = input.history.filter(
    (message) => message.id !== current.id,
  );
  const turns = completedTurns(historicalMessages);
  const user: AgentMessage = { role: "user", content: current.content };
  const systemTokens = input.systemPrompt
    ? estimateLocalTextTokens(input.systemPrompt) + 4
    : 0;
  const fixedTokens =
    systemTokens + estimateMessageTokens(user) + input.reservedOutputTokens;
  if (fixedTokens > input.contextWindowTokens) {
    throw new LocalContextWindowExceededError(
      fixedTokens,
      input.contextWindowTokens,
    );
  }

  let remainingTokens = input.contextWindowTokens - fixedTokens;
  const maxTurnMessages =
    input.maxHistoryMessages - (input.maxHistoryMessages % 2);
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

  const messages: AgentMessage[] = [];
  for (const turn of selected) messages.push(turn.user, turn.assistant);
  messages.push(user);

  return {
    messages,
    estimatedTokens:
      systemTokens +
      messages.reduce(
        (total, message) => total + estimateMessageTokens(message),
        0,
      ),
    includedHistoryMessages: selectedMessages,
    droppedHistoryMessages: historicalMessages.length - selectedMessages,
  };
}

export function estimateLocalTextTokens(value: string): number {
  if (!value) return 0;
  // Conservative mixed Chinese/code estimate without coupling the desktop
  // runtime to one provider's tokenizer.
  return Math.ceil(new TextEncoder().encode(value).byteLength / 3);
}

function completedTurns(
  history: readonly LocalMessage[],
): CompletedTurn[] {
  const turns: CompletedTurn[] = [];
  let pendingUser: AgentMessage | null = null;

  for (const message of history) {
    if (message.role === "user") {
      // A newer user row supersedes a legacy unpaired prompt.
      pendingUser = { role: "user", content: message.content };
      continue;
    }
    if (!pendingUser) continue;

    const assistant: AgentMessage = {
      role: "assistant",
      content: message.content,
    };
    turns.push({
      user: pendingUser,
      assistant,
      estimatedTokens:
        estimateMessageTokens(pendingUser) + estimateMessageTokens(assistant),
    });
    pendingUser = null;
  }

  return turns;
}

function estimateMessageTokens(message: AgentMessage): number {
  if (message.role === "tool") {
    return estimateLocalTextTokens(message.content) + 8;
  }
  return estimateLocalTextTokens(message.content ?? "") + 4;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}
