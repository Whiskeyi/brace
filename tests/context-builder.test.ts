import { describe, expect, it } from "vitest";

import {
  buildAgentContext,
  ContextWindowExceededError,
} from "@/server/chat/context";
import type { AgentMessage } from "@/lib/repositories";

function stored(
  index: number,
  role: AgentMessage["role"],
  content: string,
  status?: string,
): AgentMessage {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    conversationId: "10000000-0000-4000-8000-000000000000",
    userId: "20000000-0000-4000-8000-000000000000",
    role,
    content,
    toolName: null,
    toolCallId: role === "tool" ? `call_${index}` : null,
    metadata: status ? { status } : {},
    createdAt: new Date(index * 1_000).toISOString(),
  };
}

describe("buildAgentContext", () => {
  it("keeps complete turns and excludes failed, stopped, orphaned, and tool rows", () => {
    const result = buildAgentContext({
      history: [
        stored(1, "user", "u1"),
        stored(2, "assistant", "a1", "completed"),
        stored(3, "tool", "hidden"),
        stored(4, "user", "failed user"),
        stored(5, "assistant", "partial", "failed"),
        stored(6, "user", "u2"),
        stored(7, "assistant", "a2"),
        stored(8, "assistant", "orphan"),
        stored(9, "user", "unfinished"),
      ],
      userMessage: "current",
      maxHistoryMessages: 20,
      contextWindowTokens: 1_000,
      reservedOutputTokens: 100,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "current" },
    ]);
    expect(result.includedHistoryMessages).toBe(4);
    expect(result.droppedHistoryMessages).toBe(5);
  });

  it("never starts context in the middle of a turn", () => {
    const result = buildAgentContext({
      history: [
        stored(1, "user", "old user"),
        stored(2, "assistant", "old assistant"),
        stored(3, "user", "new user"),
        stored(4, "assistant", "new assistant"),
      ],
      userMessage: "current",
      maxHistoryMessages: 3,
      contextWindowTokens: 1_000,
      reservedOutputTokens: 100,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "new user" },
      { role: "assistant", content: "new assistant" },
      { role: "user", content: "current" },
    ]);
  });

  it("drops older history when the token budget is exhausted", () => {
    const result = buildAgentContext({
      history: [
        stored(1, "user", "a".repeat(300)),
        stored(2, "assistant", "b".repeat(300)),
        stored(3, "user", "short"),
        stored(4, "assistant", "recent"),
      ],
      userMessage: "current",
      systemPrompt: "system",
      maxHistoryMessages: 10,
      contextWindowTokens: 80,
      reservedOutputTokens: 20,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "short" },
      { role: "assistant", content: "recent" },
      { role: "user", content: "current" },
    ]);
    expect(result.estimatedTokens).toBeLessThanOrEqual(60);
  });

  it("rejects a current request that cannot fit with the output reserve", () => {
    expect(() =>
      buildAgentContext({
        history: [],
        userMessage: "x".repeat(300),
        systemPrompt: "system",
        maxHistoryMessages: 10,
        contextWindowTokens: 50,
        reservedOutputTokens: 20,
      })
    ).toThrow(ContextWindowExceededError);
  });
});
