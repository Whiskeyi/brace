import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ToolRegistry,
} from "@/lib/tools";

describe("ToolRegistry", () => {
  it("registers tools and exposes OpenAI function schemas", () => {
    const tool = {
      name: "echo",
      description: "Echo text",
      schema: z.object({ text: z.string() }).strict(),
      execute: ({ text }: { text: string }) => text,
    };
    const registry = new ToolRegistry([tool]);

    expect(registry.get("echo")).toBe(tool);
    expect(registry.toOpenAITools()).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "echo",
          parameters: expect.objectContaining({ type: "object" }),
        }),
      }),
    ]);
    expect(() => registry.register(tool)).toThrow(/already registered/);
  });
});
