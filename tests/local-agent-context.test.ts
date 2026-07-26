import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentEvent,
  AgentModel,
  AgentModelRequest,
} from "@/lib/agent";
import {
  buildLocalAgentContext,
  LocalAgentStore,
  LocalCodingService,
  LocalContextWindowExceededError,
  localAgentConfigSchema,
  type LocalMessage,
  type LocalProject,
  type LocalRun,
  type LocalThread,
} from "@/lib/local-agent";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("buildLocalAgentContext", () => {
  it("keeps only newest complete turns and the current prompt", () => {
    const history = [
      message(1, "user", "old user"),
      message(2, "assistant", "old assistant"),
      message(3, "user", "failed orphan"),
      message(4, "user", "recent user"),
      message(5, "assistant", "recent assistant"),
      message(6, "user", "cancelled orphan"),
      message(7, "user", "current"),
    ];

    const context = buildLocalAgentContext({
      history,
      currentMessageId: "message-7",
      maxHistoryMessages: 3,
      contextWindowTokens: 2_048,
      reservedOutputTokens: 256,
    });

    expect(context.messages).toEqual([
      { role: "user", content: "recent user" },
      { role: "assistant", content: "recent assistant" },
      { role: "user", content: "current" },
    ]);
    expect(context.includedHistoryMessages).toBe(2);
    expect(context.droppedHistoryMessages).toBe(4);
  });

  it("drops older complete turns at the token boundary", () => {
    const context = buildLocalAgentContext({
      history: [
        message(1, "user", "a".repeat(300)),
        message(2, "assistant", "b".repeat(300)),
        message(3, "user", "short"),
        message(4, "assistant", "recent"),
        message(5, "user", "current"),
      ],
      currentMessageId: "message-5",
      systemPrompt: "system",
      maxHistoryMessages: 10,
      contextWindowTokens: 80,
      reservedOutputTokens: 20,
    });

    expect(context.messages).toEqual([
      { role: "user", content: "short" },
      { role: "assistant", content: "recent" },
      { role: "user", content: "current" },
    ]);
    expect(context.estimatedTokens).toBeLessThanOrEqual(60);
  });

  it("rejects a current prompt that cannot fit beside the output reserve", () => {
    expect(() =>
      buildLocalAgentContext({
        history: [message(1, "user", "x".repeat(300))],
        currentMessageId: "message-1",
        systemPrompt: "system",
        maxHistoryMessages: 10,
        contextWindowTokens: 50,
        reservedOutputTokens: 20,
      }),
    ).toThrow(LocalContextWindowExceededError);
  });
});

describe("LocalCodingService context integration", () => {
  it("applies desktop limits and retains a failed instruction with a synthetic completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-context-"));
    temporaryDirectories.push(root);
    const requests: AgentModelRequest[] = [];
    let attempt = 0;
    const model: AgentModel = {
      id: "context-capture-model",
      async stream(request) {
        requests.push(request);
        attempt += 1;
        if (attempt === 1) throw new Error("Intentional model failure.");
        const content = attempt === 2 ? "second complete" : "third complete";
        return (async function* () {
          yield { content, finishReason: "stop" };
        })();
      },
    };
    const store = new LocalAgentStore(":memory:");
    let terminal = withResolvers<LocalRun>();
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({
        LLM_API_KEY: "local-context-key",
        LLM_MODEL: model.id,
        LLM_MAX_OUTPUT_TOKENS: 1_024,
        AGENT_MAX_HISTORY_MESSAGES: 4,
        AGENT_CONTEXT_WINDOW_TOKENS: 4_096,
      }),
      worktreeRoot: path.join(root, ".worktrees"),
      modelFactory: () => model,
      onEvent(event) {
        if (
          event.type === "run.changed" &&
          ["completed", "failed", "cancelled"].includes(event.run.status)
        ) {
          terminal.resolve(event.run);
        }
      },
    });
    const project = await service.addProject(root);

    const first = await service.startTask({
      projectId: project.id,
      prompt: "failed prompt",
      mode: "local",
    });
    expect((await terminal.promise).status).toBe("failed");

    terminal = withResolvers<LocalRun>();
    const second = await service.startTask({
      projectId: project.id,
      threadId: first.thread.id,
      prompt: "second prompt",
      mode: "local",
    });
    expect((await terminal.promise).status).toBe("completed");

    terminal = withResolvers<LocalRun>();
    await service.startTask({
      projectId: project.id,
      threadId: second.thread.id,
      prompt: "third prompt",
      mode: "local",
    });
    expect((await terminal.promise).status).toBe("completed");

    expect(requests[1].messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "failed prompt" },
      {
        role: "assistant",
        content: expect.stringContaining("[Run failed before completion]"),
      },
      { role: "user", content: "second prompt" },
    ]);
    expect(requests[2].messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "failed prompt" },
      {
        role: "assistant",
        content: expect.stringContaining("[Run failed before completion]"),
      },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second complete" },
      { role: "user", content: "third prompt" },
    ]);
    expect(requests[2].options).toMatchObject({ max_tokens: 1_024 });
    const start = store
      .listAgentEvents(first.thread.id)
      .find(({ event: item }) => item.type === "start")?.event;
    expect(start).toMatchObject({
      type: "start",
      limits: { maxToolResultBytes: 256 },
    });
    await service.dispose();
  });
});

describe("LocalAgentStore event compaction", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "batches adjacent deltas and removes them after a %s run",
    (terminalStatus) => {
    const { store, thread, run } = localRunFixture();
    store.appendAgentEvents(thread.id, [
      event({
        sequence: 1,
        type: "delta",
        round: 1,
        delta: "streamed ",
      }),
      event({
        sequence: 2,
        type: "delta",
        round: 1,
        delta: "text",
      }),
      event({
        sequence: 3,
        type: "tool_call",
        round: 1,
        callId: "call-1",
        name: "read_file",
        rawArguments: '{"path":"src/index.ts"}',
        arguments: { path: "src/index.ts" },
      }),
    ]);
    expect(store.listAgentEvents(thread.id)).toMatchObject([
      { event: { type: "delta", sequence: 2, delta: "streamed text" } },
      { event: { type: "tool_call", sequence: 3 } },
    ]);

    store.setRunStatus(run.id, terminalStatus);

    expect(
      store.listAgentEvents(thread.id).map(({ event: item }) => item.type),
    ).toEqual(["tool_call"]);
    store.close();
    },
  );

  it("limits detail event reads to the newest audit window", () => {
    const { store, thread } = localRunFixture();
    store.appendAgentEvents(
      thread.id,
      Array.from({ length: 505 }, (_, index) =>
        event({
          sequence: index + 1,
          type: "tool_call",
          round: 1,
          callId: `call-${index + 1}`,
          name: "read_file",
          rawArguments: "{}",
          arguments: {},
        }),
      ),
    );

    const events = store.getThreadDetail(thread.id)?.events ?? [];
    expect(events).toHaveLength(500);
    expect(events[0]?.event.sequence).toBe(6);
    expect(events.at(-1)?.event.sequence).toBe(505);
    expect(store.listAgentEvents(thread.id, 2).map(({ event: item }) => item.sequence))
      .toEqual([504, 505]);
    store.close();
  });
});

function localRunFixture(): {
  readonly store: LocalAgentStore;
  readonly thread: LocalThread;
  readonly run: LocalRun;
} {
  const store = new LocalAgentStore(":memory:");
  const project: LocalProject = {
    id: "project-1",
    name: "project",
    rootPath: "/tmp/project",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  };
  const thread: LocalThread = {
    id: "thread-1",
    projectId: project.id,
    title: "Compact events",
    mode: "local",
    workspacePath: project.rootPath,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const run: LocalRun = {
    id: "run-1",
    threadId: thread.id,
    status: "running",
    model: "fake",
    startedAt: "2026-01-01T00:00:01.000Z",
    finishedAt: null,
    errorMessage: null,
  };
  store.upsertProject(project);
  store.insertThread(thread);
  store.insertRun(run);
  return { store, thread, run };
}

function message(
  index: number,
  role: LocalMessage["role"],
  content: string,
): LocalMessage {
  return {
    id: `message-${index}`,
    threadId: "thread-1",
    role,
    content,
    createdAt: new Date(index * 1_000).toISOString(),
  };
}

function event(
  value:
    | Pick<Extract<AgentEvent, { type: "delta" }>, "sequence" | "type" | "round" | "delta">
    | Pick<
        Extract<AgentEvent, { type: "tool_call" }>,
        | "sequence"
        | "type"
        | "round"
        | "callId"
        | "name"
        | "rawArguments"
        | "arguments"
      >,
): AgentEvent {
  return {
    protocolVersion: 1,
    timestamp: `2026-01-01T00:00:0${value.sequence}.000Z`,
    runId: "run-1",
    ...value,
  };
}

function withResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
