import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createCalculatorTool,
  createDefaultToolRegistry,
  createGetCurrentTimeTool,
  ToolRegistry,
  type ToolExecutionContext,
} from "@/lib/tools";

const context: ToolExecutionContext = {
  callId: "call_test",
  runId: "run_test",
  round: 1,
  signal: new AbortController().signal,
};

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

  it("ships isolated registry instances with the two base tools", () => {
    const first = createDefaultToolRegistry();
    const second = createDefaultToolRegistry();

    expect(first.list().map((tool) => tool.name)).toEqual([
      "get_current_time",
      "calculator",
    ]);
    first.unregister("calculator");
    expect(second.has("calculator")).toBe(true);
  });
});

describe("base tools", () => {
  it("evaluates arithmetic without evaluating JavaScript", async () => {
    const calculator = createCalculatorTool();

    await expect(
      Promise.resolve(
        calculator.execute(
          { expression: "sqrt(x^2 + 9)", variables: { x: 4 } },
          context,
        ),
      ),
    ).resolves.toEqual({ expression: "sqrt(x^2 + 9)", value: 5 });
    await expect(
      Promise.resolve().then(() =>
        calculator.execute(
          { expression: "constructor.constructor('return process')()" },
          context,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() =>
        calculator.execute(
          { expression: "__proto__.polluted" },
          context,
        ),
      ),
    ).rejects.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns deterministic current-time data with an injected clock", async () => {
    const tool = createGetCurrentTimeTool({
      now: () => new Date("2026-07-10T12:34:56.000Z"),
      defaultTimeZone: "UTC",
      defaultLocale: "en-US",
    });

    await expect(Promise.resolve(tool.execute({}, context))).resolves.toEqual(
      expect.objectContaining({
        iso: "2026-07-10T12:34:56.000Z",
        timeZone: "UTC",
      }),
    );
  });
});
