import { describe, expect, it } from "vitest";

import { hasExplicitMemoryWriteIntent } from "@/server/agent/memory-intent";

describe("hasExplicitMemoryWriteIntent", () => {
  it("accepts direct Chinese and English memory requests", () => {
    expect(
      hasExplicitMemoryWriteIntent("请务必帮我记住：这个项目使用 pnpm。"),
    ).toBe(true);
    expect(
      hasExplicitMemoryWriteIntent(
        "I explicitly want you to remember this preference.",
      ),
    ).toBe(true);
  });

  it("keeps negated and ambiguous requests read-only", () => {
    expect(
      hasExplicitMemoryWriteIntent("请不要帮我记住：这只是临时信息。"),
    ).toBe(false);
    expect(hasExplicitMemoryWriteIntent("你能记住这件事吗？")).toBe(false);
  });

  it("handles repeated Chinese prefixes without catastrophic backtracking", () => {
    const repeatedPrefixes = `\n请${"帮我请".repeat(10_000)}记住：安全偏好`;

    expect(hasExplicitMemoryWriteIntent(repeatedPrefixes)).toBe(true);
  });
});
