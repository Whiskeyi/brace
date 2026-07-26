import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AGENT_EVENT_PROTOCOL_VERSION,
  createAgent,
  createOpenAICompatibleModel,
  MAX_AGENT_MODEL_OUTPUT_BYTES,
  MAX_AGENT_TOOL_ARGUMENT_BYTES,
  MAX_AGENT_TOOL_RESULT_BYTES,
  AgentRuntimeFailure,
  ToolExecutor,
  type AgentEvent,
  type AgentModel,
  type AgentModelChunk,
  type AgentModelRequest,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type OpenAICompatibleClient,
  type ToolPolicyRequest,
} from "@/lib/agent";
import { ToolRegistry } from "@/lib/tools";

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function fakeModel(
  rounds: readonly (readonly AgentModelChunk[])[],
  id = "provider-model",
) {
  const requests: AgentModelRequest[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  let index = 0;
  const model: AgentModel = {
    id,
    async stream(request, options) {
      requests.push(request);
      signals.push(options?.signal);
      const chunks = rounds[index++] ?? [];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
  return { model, requests, signals };
}

function fakeClient(rounds: readonly (readonly ChatCompletionChunk[])[]) {
  const requests: ChatCompletionRequest[] = [];
  let index = 0;
  const client: OpenAICompatibleClient = {
    chat: {
      completions: {
        create(request: ChatCompletionRequest) {
          requests.push(request);
          const chunks = rounds[index++] ?? [];
          return (async function* () {
            for (const chunk of chunks) yield chunk;
          })();
        },
      },
    },
  };
  return { client, requests };
}

function toolRound(
  calls: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  }[],
): readonly AgentModelChunk[] {
  return [
    {
      finishReason: "tool_calls",
      toolCalls: calls.map((call, index) => ({
        index,
        id: call.id,
        name: call.name,
        arguments: call.arguments ?? "{}",
      })),
    },
  ];
}

const finalRound: readonly AgentModelChunk[] = [
  { content: "finished", finishReason: "stop" },
];

describe("UniversalAgent runtime v2", () => {
  it("rejects event payload limits above the shared protocol ceiling", () => {
    const { model } = fakeModel([]);
    expect(() => createAgent({
      modelProvider: model,
      tools: [],
      maxModelOutputBytes: MAX_AGENT_MODEL_OUTPUT_BYTES + 1,
    })).toThrow(/maxModelOutputBytes must not exceed/);
    expect(() => createAgent({
      modelProvider: model,
      tools: [],
      maxToolArgumentBytes: MAX_AGENT_TOOL_ARGUMENT_BYTES + 1,
    })).toThrow(/maxToolArgumentBytes must not exceed/);
    expect(() => createAgent({
      modelProvider: model,
      tools: [],
      maxToolResultBytes: MAX_AGENT_TOOL_RESULT_BYTES + 1,
    })).toThrow(/maxToolResultBytes must not exceed/);
  });
  it("uses an injected model provider and stamps every event envelope in order", async () => {
    const { model, requests, signals } = fakeModel([
      [{ content: "hello", finishReason: "stop" }],
    ]);
    const controller = new AbortController();
    let clockTick = 0;
    const agent = createAgent({
      modelProvider: model,
      tools: [],
      systemPrompt: "system",
      temperature: 0.25,
      requestOptions: { reasoning: "low" },
      now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5 + clockTick++)),
    });

    const events = await collect(
      agent.run({
        messages: [{ role: "user", content: "hi" }],
        runId: "run_provider",
        signal: controller.signal,
      }),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "delta", "done"]);
    expect(events[0]).toMatchObject({ type: "start", model: "provider-model" });
    expect(events.map((event) => event.protocolVersion)).toEqual([
      AGENT_EVENT_PROTOCOL_VERSION,
      AGENT_EVENT_PROTOCOL_VERSION,
      AGENT_EVENT_PROTOCOL_VERSION,
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.timestamp)).toEqual([
      "2026-01-02T03:04:05.000Z",
      "2026-01-02T03:04:06.000Z",
      "2026-01-02T03:04:07.000Z",
    ]);
    expect(events.every((event) => event.runId === "run_provider")).toBe(true);
    expect(requests).toEqual([
      {
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hi" },
        ],
        tools: [],
        temperature: 0.25,
        options: { reasoning: "low" },
      },
    ]);
    expect(signals).toEqual([controller.signal]);
  });

  it("enforces maxToolCalls cumulatively across model rounds", async () => {
    const { model } = fakeModel([
      toolRound([{ id: "call_1", name: "echo" }]),
      toolRound([{ id: "call_2", name: "echo" }]),
    ]);
    const execute = vi.fn(() => "used once");
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "echo",
          description: "Echo",
          schema: z.object({}).strict(),
          execute,
        },
      ],
      maxToolCalls: 1,
    });

    const events = await collect(agent.run("go"));

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_call",
      "tool_result",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "tool_call_limit_exceeded",
        retryable: false,
        details: { completed: 1, requested: 1, limit: 1 },
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("preserves streamed reasoning across tool-call subturns", async () => {
    const { model, requests } = fakeModel([
      [
        { reasoningContent: "Inspect the " },
        {
          reasoningContent: "workspace.",
          content: "I will read it.",
          finishReason: "tool_calls",
          toolCalls: [
            {
              index: 0,
              id: "call_reasoning",
              name: "read",
              arguments: "{}",
            },
          ],
        },
      ],
      finalRound,
    ]);
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "read",
          description: "Read",
          schema: z.object({}).strict(),
          execute: () => "contents",
        },
      ],
    });

    const events = await collect(agent.run("go"));

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(requests[1].messages).toContainEqual({
      role: "assistant",
      content: "I will read it.",
      reasoning_content: "Inspect the workspace.",
      tool_calls: [
        {
          id: "call_reasoning",
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
      ],
    });
  });

  it("drops the oldest complete history turn before a model request", async () => {
    const { model, requests } = fakeModel([finalRound]);
    const agent = createAgent({
      modelProvider: model,
      tools: [],
      contextWindowTokens: 512,
      reservedOutputTokens: 64,
    });

    const events = await collect(
      agent.run({
        messages: [
          { role: "user", content: "old ".repeat(500) },
          {
            role: "assistant",
            content: null,
            reasoning_content: "reasoning ".repeat(300),
            tool_calls: [
              {
                id: "old_call",
                type: "function",
                function: { name: "old_tool", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "old_call",
            content: "old result ".repeat(300),
          },
          { role: "assistant", content: "Old turn completed." },
          { role: "user", content: "Recent question." },
          { role: "assistant", content: "Recent answer." },
          { role: "user", content: "Current question." },
        ],
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(requests[0].messages).toEqual([
      { role: "user", content: "Recent question." },
      { role: "assistant", content: "Recent answer." },
      { role: "user", content: "Current question." },
    ]);
  });

  it("counts tool schemas before sending a model request", async () => {
    const { model, requests } = fakeModel([finalRound]);
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "large_schema",
          description: "schema ".repeat(1_000),
          schema: z.object({}).strict(),
          execute: () => "unused",
        },
      ],
      contextWindowTokens: 256,
      reservedOutputTokens: 64,
    });

    const events = await collect(agent.run("current"));

    expect(requests).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "context_window_exceeded",
        retryable: false,
        details: {
          contextWindowTokens: 256,
          reservedOutputTokens: 64,
          maxInputTokens: 192,
          droppedHistoryTurns: 0,
        },
      },
    });
  });

  it("never drops or sends an oversized current tool-call subturn", async () => {
    const { model, requests } = fakeModel([
      toolRound([{ id: "large_result", name: "large_result" }]),
      finalRound,
    ]);
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "large_result",
          description: "Return a large result",
          schema: z.object({}).strict(),
          execute: () => "result ".repeat(1_000),
        },
      ],
      contextWindowTokens: 1_024,
      reservedOutputTokens: 128,
    });

    const events = await collect(agent.run("current"));

    expect(requests).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "tool_call",
      "tool_result",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "context_window_exceeded",
        retryable: false,
        details: { droppedHistoryTurns: 0 },
      },
    });
  });

  it("requires context and output-reserve budgets together", () => {
    const { model } = fakeModel([]);

    expect(() =>
      createAgent({
        modelProvider: model,
        contextWindowTokens: 1_024,
      }),
    ).toThrow(
      "contextWindowTokens and reservedOutputTokens must be configured together",
    );
    expect(() =>
      createAgent({
        modelProvider: model,
        contextWindowTokens: 1_024,
        reservedOutputTokens: 1_024,
      }),
    ).toThrow(
      "reservedOutputTokens must be smaller than contextWindowTokens",
    );
  });

  it("never runs more than maxToolConcurrency calls at once", async () => {
    const calls = Array.from({ length: 5 }, (_, index) => ({
      id: `call_${index}`,
      name: "work",
      arguments: JSON.stringify({ value: index }),
    }));
    const { model } = fakeModel([toolRound(calls), finalRound]);
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async ({ value }: { value: number }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active -= 1;
      return { value };
    });
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "work",
          description: "Work",
          schema: z.object({ value: z.number() }).strict(),
          execute,
        },
      ],
      maxToolConcurrency: 2,
    });

    const events = await collect(agent.run("go"));

    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(execute).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it("serializes calls that share a concurrencyKey", async () => {
    const calls = Array.from({ length: 3 }, (_, index) => ({
      id: `keyed_${index}`,
      name: "write",
      arguments: JSON.stringify({ value: index }),
    }));
    const { model } = fakeModel([toolRound(calls), finalRound]);
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async ({ value }: { value: number }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active -= 1;
      return { value };
    });
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "write",
          description: "Write",
          schema: z.object({ value: z.number() }).strict(),
          annotations: { effect: "write", concurrencyKey: "workspace" },
          execute,
        },
      ],
      maxToolConcurrency: 3,
    });

    await collect(agent.run("go"));

    expect(execute).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it("serializes restricted effects without an explicit concurrencyKey", async () => {
    const calls = Array.from({ length: 3 }, (_, index) => ({
      id: `restricted_${index}`,
      name: "write",
      arguments: JSON.stringify({ value: index }),
    }));
    const { model } = fakeModel([toolRound(calls), finalRound]);
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async ({ value }: { value: number }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active -= 1;
      return { value };
    });
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "write",
          description: "Write",
          schema: z.object({ value: z.number() }).strict(),
          annotations: { effect: "write" },
          execute,
        },
      ],
      maxToolConcurrency: 3,
    });

    await collect(agent.run("go"));

    expect(execute).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it("blocks later restricted calls after a timeout has an indeterminate outcome", async () => {
    const { model } = fakeModel([
      toolRound([
        { id: "timed_out", name: "write" },
        { id: "must_not_run", name: "write" },
      ]),
      finalRound,
    ]);
    const execute = vi.fn(() => new Promise<never>(() => undefined));
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "write",
          description: "Write",
          schema: z.object({}).strict(),
          annotations: { effect: "write" },
          execute,
        },
      ],
      maxToolConcurrency: 2,
      toolTimeoutMs: 5,
    });

    const events = await collect(agent.run("go"));
    const results = events.filter((event) => event.type === "tool_result");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      callId: "timed_out",
      error: {
        code: "tool_timeout",
        details: { outcome: "indeterminate" },
      },
    });
    expect(results[1]).toMatchObject({
      callId: "must_not_run",
      error: {
        code: "tool_execution_failed",
        retryable: false,
        details: { outcome: "blocked_by_indeterminate_call" },
      },
    });
  });

  it("isolates exceptions thrown by asynchronous tool argument validation", async () => {
    const { model } = fakeModel([
      toolRound([
        { id: "bad_validation", name: "bad_validation" },
        { id: "valid_call", name: "valid_call" },
      ]),
      finalRound,
    ]);
    const badExecute = vi.fn(() => "must not run");
    const validExecute = vi.fn(() => "ok");
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "bad_validation",
          description: "Throws while validating",
          schema: z.object({}).superRefine(async () => {
            throw new Error("validator failed");
          }),
          execute: badExecute,
        },
        {
          name: "valid_call",
          description: "Still runs",
          schema: z.object({}).strict(),
          execute: validExecute,
        },
      ],
      maxToolConcurrency: 2,
    });

    const events = await collect(agent.run("go"));
    const badResult = events.find(
      (event) =>
        event.type === "tool_result" && event.callId === "bad_validation",
    );
    const validResult = events.find(
      (event) => event.type === "tool_result" && event.callId === "valid_call",
    );

    expect(badResult).toMatchObject({
      success: false,
      error: {
        code: "tool_execution_failed",
        retryable: false,
        details: { phase: "validation" },
      },
    });
    expect(validResult).toMatchObject({ success: true, output: "ok" });
    expect(badExecute).not.toHaveBeenCalled();
    expect(validExecute).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("bounds asynchronous tool validation without marking effects indeterminate", async () => {
    const { model } = fakeModel([
      toolRound([{ id: "stalled_validation", name: "stalled_validation" }]),
      finalRound,
    ]);
    const execute = vi.fn(() => "must not run");
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "stalled_validation",
          description: "Never finishes validation",
          schema: z.object({}).superRefine(
            () => new Promise<never>(() => undefined),
          ),
          execute,
        },
      ],
      toolTimeoutMs: 5,
    });

    const events = await collect(agent.run("go"));
    const result = events.find((event) => event.type === "tool_result");

    expect(result).toMatchObject({
      callId: "stalled_validation",
      success: false,
      error: {
        code: "tool_timeout",
        retryable: false,
        details: {
          phase: "validation",
          outcome: "not_started",
        },
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("aborts promptly while asynchronous tool validation is pending", async () => {
    const { model } = fakeModel([
      toolRound([{ id: "pending_validation", name: "pending_validation" }]),
    ]);
    const controller = new AbortController();
    let markValidationStarted = () => {};
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "pending_validation",
          description: "Waits during validation",
          schema: z.object({}).superRefine(() => {
            markValidationStarted();
            return new Promise<never>(() => undefined);
          }),
          execute: vi.fn(),
        },
      ],
      toolTimeoutMs: 5_000,
    });

    const execution = collect(
      agent.run({
        messages: [{ role: "user", content: "go" }],
        signal: controller.signal,
      }),
    );
    await validationStarted;
    controller.abort(new Error("cancel validation"));
    const events = await execution;

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "aborted",
        message: "cancel validation",
      },
    });
  });

  it("fails closed when a tool requires approval and no policy is configured", async () => {
    const { model } = fakeModel([
      toolRound([{ id: "dangerous", name: "dangerous" }]),
      finalRound,
    ]);
    const execute = vi.fn(() => "changed");
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "dangerous",
          description: "Dangerous",
          schema: z.object({}).strict(),
          annotations: { effect: "write", requiresApproval: true },
          execute,
        },
      ],
    });

    const events = await collect(agent.run("go"));
    const result = events.find((event) => event.type === "tool_result");

    expect(result).toMatchObject({
      type: "tool_result",
      callId: "dangerous",
      success: false,
      error: {
        code: "tool_denied",
        message: 'Tool "dangerous" requires explicit approval.',
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("applies custom policy allow and deny decisions per call", async () => {
    const { model } = fakeModel([
      toolRound([
        {
          id: "allowed",
          name: "change",
          arguments: JSON.stringify({ approved: true }),
        },
        {
          id: "denied",
          name: "change",
          arguments: JSON.stringify({ approved: false }),
        },
      ]),
      finalRound,
    ]);
    const execute = vi.fn(({ approved }: { approved: boolean }) => ({ approved }));
    const evaluate = vi.fn((request: ToolPolicyRequest) =>
      (request.arguments as { approved: boolean }).approved
        ? { allowed: true as const }
        : { allowed: false as const, reason: "not approved" },
    );
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "change",
          description: "Change",
          schema: z.object({ approved: z.boolean() }).strict(),
          annotations: { effect: "write", requiresApproval: true },
          execute,
        },
      ],
      toolPolicy: { evaluate },
    });

    const events = await collect(
      agent.run({
        messages: [{ role: "user", content: "go" }],
        runId: "run_policy",
        metadata: { source: "test" },
      }),
    );
    const allowed = events.find(
      (event) => event.type === "tool_result" && event.callId === "allowed",
    );
    const denied = events.find(
      (event) => event.type === "tool_result" && event.callId === "denied",
    );

    expect(allowed).toMatchObject({ success: true, output: { approved: true } });
    expect(denied).toMatchObject({
      success: false,
      error: { code: "tool_denied", message: "not approved" },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(
      evaluate.mock.calls.map(([request]) => ({
        arguments: request.arguments,
        runId: request.context.runId,
        round: request.context.round,
        metadata: request.context.metadata,
      })),
    ).toEqual([
      {
        arguments: { approved: true },
        runId: "run_policy",
        round: 1,
        metadata: { source: "test" },
      },
      {
        arguments: { approved: false },
        runId: "run_policy",
        round: 1,
        metadata: { source: "test" },
      },
    ]);
  });

  it("starts the tool timeout only after interactive approval", async () => {
    const { model } = fakeModel([
      toolRound([{ id: "approved-late", name: "change" }]),
      finalRound,
    ]);
    const execute = vi.fn(() => "changed");
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "change",
          description: "Change",
          schema: z.object({}).strict(),
          annotations: { effect: "write", requiresApproval: true },
          execute,
        },
      ],
      toolPolicy: {
        async evaluate() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { allowed: true };
        },
      },
      toolTimeoutMs: 5,
    });

    const events = await collect(agent.run("go"));

    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      success: true,
      output: "changed",
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("does not execute when cancellation is observed while installing the post-approval listener", async () => {
    const execute = vi.fn(() => "changed");
    const executor = new ToolExecutor({
      registry: new ToolRegistry([
        {
          name: "change",
          description: "Change",
          schema: z.object({}).strict(),
          annotations: { effect: "write", requiresApproval: true },
          execute,
        },
      ]),
      timeoutMs: 1_000,
      maxResultBytes: 1_024,
      policy: { evaluate: () => ({ allowed: true }) },
    });
    const signal = signalThatMissesItsSecondAbortListener();

    await expect(
      executor.execute(
        {
          call: {
            id: "cancelled-after-approval",
            type: "function",
            function: { name: "change", arguments: "{}" },
          },
          arguments: {},
        },
        { runId: "run_cancel_race", round: 1, signal },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AgentRuntimeFailure &&
        error.info.code === "aborted",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("truncates oversized tool output in both events and model messages", async () => {
    const { model, requests } = fakeModel([
      toolRound([{ id: "large", name: "large" }]),
      finalRound,
    ]);
    const output = "汉".repeat(200);
    const maxToolResultBytes = 96;
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "large",
          description: "Large output",
          schema: z.object({}).strict(),
          execute: () => output,
        },
      ],
      maxToolResultBytes,
    });

    const events = await collect(agent.run("go"));
    const result = events.find((event) => event.type === "tool_result");
    const toolMessage = requests[1].messages.find((message) => message.role === "tool");

    expect(result).toMatchObject({
      success: true,
      outputBytes: new TextEncoder().encode(output).byteLength,
      truncated: true,
      output: {
        truncated: true,
        originalBytes: new TextEncoder().encode(output).byteLength,
      },
    });
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("Expected a tool message.");
    expect(new TextEncoder().encode(toolMessage.content).byteLength).toBeLessThanOrEqual(
      maxToolResultBytes,
    );
    expect(JSON.parse(toolMessage.content)).toEqual(
      result?.type === "tool_result" ? result.output : undefined,
    );
  });

  it("keeps the tool-message byte limit even when the configured limit is tiny", async () => {
    const { model, requests } = fakeModel([
      toolRound([{ id: "tiny", name: "large" }]),
      finalRound,
    ]);
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "large",
          description: "Large output",
          schema: z.object({}).strict(),
          execute: () => "汉字",
        },
      ],
      maxToolResultBytes: 1,
    });

    await collect(agent.run("go"));
    const toolMessage = requests[1].messages.find((message) => message.role === "tool");
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("Expected a tool message.");
    expect(new TextEncoder().encode(toolMessage.content).byteLength).toBeLessThanOrEqual(1);
  });

  it("stops consuming model content after the configured byte limit", async () => {
    const { model } = fakeModel([[{ content: "abc" }, { content: "def" }]]);
    const agent = createAgent({
      modelProvider: model,
      tools: [],
      maxModelOutputBytes: 5,
    });

    const events = await collect(agent.run("go"));
    expect(events.map((event) => event.type)).toEqual(["start", "delta", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "model_output_limit_exceeded" },
    });
  });

  it("counts hidden reasoning against the model output byte limit", async () => {
    const { model } = fakeModel([
      [{ reasoningContent: "abcdef", finishReason: "stop" }],
    ]);
    const agent = createAgent({
      modelProvider: model,
      tools: [],
      maxModelOutputBytes: 5,
    });

    const events = await collect(agent.run("go"));

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "model_output_limit_exceeded", retryable: false },
    });
  });

  it("does not report completion when the model stream ends unexpectedly", async () => {
    const { model } = fakeModel([[{ content: "partial" }]]);
    const agent = createAgent({ modelProvider: model, tools: [] });

    const events = await collect(agent.run("go"));

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "delta",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "llm_error",
        message: "The model stream ended before reporting completion.",
        retryable: true,
      },
    });
  });

  it.each([
    [
      "length",
      "The model stopped before completion because it reached its output token limit.",
    ],
    [
      "content_filter",
      "The model stopped before completion because its output was filtered.",
    ],
    [
      "insufficient_system_resource",
      "The model stopped before completion because the provider had insufficient system resources.",
    ],
  ])(
    "reports %s as an incomplete terminal error",
    async (finishReason, message) => {
      const { model } = fakeModel([
        [{ content: "partial", finishReason }],
      ]);
      const agent = createAgent({ modelProvider: model, tools: [] });

      const events = await collect(agent.run("go"));

      expect(events.map((event) => event.type)).toEqual([
        "start",
        "delta",
        "error",
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        error: {
          code: "llm_error",
          message,
          retryable: false,
          details: { finishReason, outcome: "incomplete" },
        },
      });
      expect(events.some((event) => event.type === "done")).toBe(false);
    },
  );

  it("rejects a tool-call finish reason without a tool call", async () => {
    const { model } = fakeModel([[{ finishReason: "tool_calls" }]]);
    const agent = createAgent({ modelProvider: model, tools: [] });

    const events = await collect(agent.run("go"));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "invalid_model_response",
        retryable: false,
        details: { finishReason: "tool_calls", hasToolCalls: false },
      },
    });
  });

  it("replaces duplicate model call ids before events, execution, and replay", async () => {
    const { model, requests } = fakeModel([
      toolRound([
        { id: "duplicate", name: "echo", arguments: '{"value":1}' },
        { id: "duplicate", name: "echo", arguments: '{"value":2}' },
      ]),
      finalRound,
    ]);
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "echo",
          description: "Echo",
          schema: z.object({ value: z.number() }).strict(),
          execute: ({ value }) => value,
        },
      ],
    });

    const events = await collect(agent.run("go"));
    const callIds = events
      .filter((event) => event.type === "tool_call")
      .map((event) => event.callId);
    const resultIds = events
      .filter((event) => event.type === "tool_result")
      .map((event) => event.callId)
      .sort();
    const assistantMessage = requests[1].messages.find(
      (message) => message.role === "assistant" && message.tool_calls,
    );
    const replayedIds = assistantMessage?.role === "assistant"
      ? assistantMessage.tool_calls?.map((call) => call.id)
      : undefined;

    expect(callIds).toEqual(["duplicate", "call_1_1"]);
    expect(new Set(callIds).size).toBe(2);
    expect(resultIds).toEqual([...callIds].sort());
    expect(replayedIds).toEqual(callIds);
  });

  it("does not let a generated fallback call id collide with a model id", async () => {
    const { model } = fakeModel([
      toolRound([
        { id: "call_1_1", name: "echo", arguments: '{"value":1}' },
        { id: "", name: "echo", arguments: '{"value":2}' },
      ]),
      finalRound,
    ]);
    const agent = createAgent({
      modelProvider: model,
      tools: [
        {
          name: "echo",
          description: "Echo",
          schema: z.object({ value: z.number() }).strict(),
          execute: ({ value }) => value,
        },
      ],
    });

    const events = await collect(agent.run("go"));
    expect(
      events.filter((event) => event.type === "tool_call").map((event) => event.callId),
    ).toEqual(["call_1_1", "call_1_1_2"]);
  });

  it("reports malformed provider tool-call indexes as invalid model responses", async () => {
    const { model } = fakeModel([
      [
        {
          toolCalls: [
            { index: -1, id: "bad", name: "echo", arguments: "{}" },
          ],
        },
      ],
    ]);
    const agent = createAgent({ modelProvider: model, tools: [] });

    const events = await collect(agent.run("go"));

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "invalid_model_response", retryable: false },
    });
  });
});

function signalThatMissesItsSecondAbortListener(): AbortSignal {
  let listenerCount = 0;
  let aborted = false;
  const reason = new Error("Cancelled after approval.");
  return {
    get aborted() {
      return aborted;
    },
    get reason() {
      return aborted ? reason : undefined;
    },
    addEventListener(type: string) {
      if (type !== "abort") return;
      listenerCount += 1;
      if (listenerCount === 2) aborted = true;
    },
    removeEventListener() {},
  } as unknown as AbortSignal;
}

describe("OpenAI-compatible model adapter", () => {
  it("normalizes streamed reasoning_content into a semantic model chunk", async () => {
    const { client } = fakeClient([
      [
        {
          choices: [
            {
              delta: { reasoning_content: "Inspecting the repository." },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
        },
      ],
    ]);
    const model = createOpenAICompatibleModel(client, "openai-model");
    const chunks: AgentModelChunk[] = [];

    for await (const chunk of await model.stream({
      messages: [{ role: "user", content: "go" }],
      tools: [],
      options: {},
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { reasoningContent: "Inspecting the repository.", finishReason: null },
      { finishReason: "stop" },
    ]);
  });

  it("consumes only the first choice from a multi-choice chunk", async () => {
    const { client, requests } = fakeClient([
      [
        {
          choices: [
            { delta: { content: "primary" }, finish_reason: "stop" },
            { delta: { content: "ignored" }, finish_reason: "length" },
          ],
        },
      ],
    ]);
    const agent = createAgent({ client, model: "openai-model", tools: [] });

    const events = await collect(agent.run("go"));

    expect(events.filter((event) => event.type === "delta")).toEqual([
      expect.objectContaining({ delta: "primary" }),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      content: "primary",
      finishReason: "stop",
    });
    expect(requests).toHaveLength(1);
  });

  it("turns a non-stream client result into invalid_model_response", async () => {
    const client: OpenAICompatibleClient = {
      chat: { completions: { create: () => ({ choices: [] }) } },
    };
    const agent = createAgent({ client, model: "openai-model", tools: [] });

    const events = await collect(agent.run("go"));

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { code: "invalid_model_response", retryable: false },
    });
  });
});
