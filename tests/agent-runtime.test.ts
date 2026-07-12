import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { z } from "zod";

import {
  createAgent,
  encodeAgentEvent,
  type AgentEvent,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type OpenAICompatibleClient,
} from "@/lib/agent";
import { ToolRegistry } from "@/lib/tools";

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
            for (const chunk of chunks) {
              yield chunk;
            }
          })();
        },
      },
    },
  };
  return { client, requests };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe("UniversalAgent", () => {
  it("accepts the official OpenAI client structurally", () => {
    const build = (client: OpenAI) => createAgent({ client, model: "fake-model" });
    expect(build).toBeTypeOf("function");
  });

  it("streams text, assembles fragmented calls, executes tools, and accumulates usage", async () => {
    const { client, requests } = fakeClient([
      [
        {
          choices: [
            {
              delta: {
                content: "Checking ",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_echo",
                    function: { name: "echo", arguments: "{\"text\":" },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: "\"hello\"}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ],
      [
        {
          choices: [
            { delta: { content: "complete" }, finish_reason: "stop" },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 },
        },
      ],
    ]);
    const registry = new ToolRegistry([
      {
        name: "echo",
        description: "Echo text",
        schema: z.object({ text: z.string() }).strict(),
        execute: ({ text }) => ({ echoed: text }),
      },
    ]);
    const agent = createAgent({
      client,
      model: "fake-model",
      tools: registry,
      idGenerator: () => "run_1",
    });

    const events = await collect(agent.run("hello"));

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "delta",
      "usage",
      "tool_call",
      "tool_result",
      "delta",
      "usage",
      "done",
    ]);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      callId: "call_echo",
      name: "echo",
      arguments: { text: "hello" },
    });
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      success: true,
      output: { echoed: "hello" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      content: "Checking complete",
      rounds: 2,
      usage: { promptTokens: 25, completionTokens: 5, totalTokens: 30 },
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      model: "fake-model",
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(requests[1].messages.at(-1)).toMatchObject({
      role: "tool",
      tool_call_id: "call_echo",
      content: "{\"echoed\":\"hello\"}",
    });
  });

  it("isolates invalid, unknown, and failed tool calls before continuing", async () => {
    const { client, requests } = fakeClient([
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "missing",
                    function: { name: "not_registered", arguments: "{}" },
                  },
                  {
                    index: 1,
                    id: "invalid",
                    function: { name: "fails", arguments: "{\"count\":\"no\"}" },
                  },
                  {
                    index: 2,
                    id: "throws",
                    function: { name: "fails", arguments: "{\"count\":1}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
      [{ choices: [{ delta: { content: "recovered" }, finish_reason: "stop" }] }],
    ]);
    const agent = createAgent({
      client,
      model: "fake-model",
      tools: [
        {
          name: "fails",
          description: "Always fail",
          schema: z.object({ count: z.number() }).strict(),
          execute: () => {
            throw new Error("boom");
          },
        },
      ],
      idGenerator: () => "run_errors",
    });

    const events = await collect(agent.run("go"));
    const results = events.filter((event) => event.type === "tool_result");

    expect(results).toHaveLength(3);
    expect(results.map((event) => event.error?.code)).toEqual([
      "unknown_tool",
      "invalid_tool_arguments",
      "tool_execution_failed",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", content: "recovered" });
    expect(requests[1].messages.filter((message) => message.role === "tool")).toHaveLength(3);
  });

  it("times out one tool without terminating the run", async () => {
    const { client } = fakeClient([
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "slow",
                    function: { name: "slow", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
      [{ choices: [{ delta: { content: "after timeout" }, finish_reason: "stop" }] }],
    ]);
    const agent = createAgent({
      client,
      model: "fake-model",
      tools: [
        {
          name: "slow",
          description: "Never resolves",
          schema: z.object({}).strict(),
          execute: () => new Promise(() => undefined),
        },
      ],
      toolTimeoutMs: 5,
    });

    const events = await collect(agent.run("go"));
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      success: false,
      error: { code: "tool_timeout" },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", content: "after timeout" });
  });

  it("emits a terminal abort error without calling the model", async () => {
    const { client, requests } = fakeClient([]);
    const controller = new AbortController();
    controller.abort(new Error("request disconnected"));
    const agent = createAgent({ client, model: "fake-model", tools: [] });

    const events = await collect(
      agent.run({ messages: [{ role: "user", content: "hello" }], signal: controller.signal }),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    expect(events[1]).toMatchObject({ error: { code: "aborted" } });
    expect(requests).toHaveLength(0);
  });

  it("returns max-round and SSE events in typed form", async () => {
    const { client } = fakeClient([
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "again",
                    function: { name: "again", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ],
    ]);
    const agent = createAgent({
      client,
      model: "fake-model",
      tools: [
        {
          name: "again",
          description: "Continue",
          schema: z.object({}).strict(),
          execute: () => "again",
        },
      ],
      maxRounds: 1,
      idGenerator: () => "run_limit",
    });

    const events = await collect(agent.run("loop"));
    const error = events.at(-1);
    expect(error).toMatchObject({
      type: "error",
      error: { code: "max_rounds_exceeded" },
    });
    expect(encodeAgentEvent(error!)).toBe(
      `event: error\ndata: ${JSON.stringify(error)}\n\n`,
    );
  });
});
