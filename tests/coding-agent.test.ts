import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createCodingAgent,
  type CreateCodingAgentOptions,
} from "@/lib/coding-agent";
import type {
  AgentEvent,
  AgentModel,
  AgentModelChunk,
  AgentModelRequest,
} from "@/lib/agent";
import type { SandboxPort } from "@/lib/sandbox";
import { createNodeWorkspace } from "@/lib/workspace";

const temporaryDirectories: string[] = [];
const originalContent = 'export const greeting = "hello";\n';
const updatedContent = 'export const greeting = "hi";\n';

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "base-agent-coding-agent-"));
  temporaryDirectories.push(root);
  await writeFile(path.join(root, "greeting.ts"), originalContent, "utf8");
  return { root, workspace: await createNodeWorkspace({ root }) };
}

function fakeModel(rounds: readonly (readonly AgentModelChunk[])[]) {
  const requests: AgentModelRequest[] = [];
  let round = 0;
  const model: AgentModel = {
    id: "fake-coding-model",
    async stream(request) {
      requests.push(request);
      const chunks = rounds[round++] ?? [];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
  return { model, requests };
}

function toolCall(
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): readonly AgentModelChunk[] {
  return [
    {
      finishReason: "tool_calls",
      toolCalls: [
        { index: 0, id, name, arguments: JSON.stringify(args) },
      ],
    },
  ];
}

const finalRound: readonly AgentModelChunk[] = [
  { content: "done", finishReason: "stop" },
];

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("createCodingAgent", () => {
  it("allows reads but denies apply_patch without an exact per-run approval", async () => {
    const { root, workspace } = await fixture();
    const { model, requests } = fakeModel([
      toolCall("read", "read_file", { path: "greeting.ts" }),
      toolCall("patch", "apply_patch", {
        path: "greeting.ts",
        expectedContent: originalContent,
        newContent: updatedContent,
      }),
      finalRound,
    ]);
    const agent = createCodingAgent({
      workspace,
      modelProvider: model,
      idGenerator: () => "run_denied",
      tools: [],
      toolPolicy: { evaluate: () => ({ allowed: true }) },
    } as unknown as CreateCodingAgentOptions);

    const events = await collect(
      agent.run({
        messages: [{ role: "user", content: "Inspect and update greeting.ts" }],
        metadata: { approvedTools: true, allowWrites: true },
      }),
    );
    const results = events.filter((event) => event.type === "tool_result");

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ name: "read_file", success: true });
    expect(results[1]).toMatchObject({
      name: "apply_patch",
      success: false,
      error: { code: "tool_denied" },
    });
    expect(await readFile(path.join(root, "greeting.ts"), "utf8")).toBe(
      originalContent,
    );
    expect(requests[0].messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("headless coding agent"),
    });
  });

  it("applies a patch when approvedTools names apply_patch exactly", async () => {
    const { root, workspace } = await fixture();
    const { model } = fakeModel([
      toolCall("read", "read_file", { path: "greeting.ts" }),
      toolCall("patch", "apply_patch", {
        path: "greeting.ts",
        expectedContent: originalContent,
        newContent: updatedContent,
      }),
      finalRound,
    ]);
    const agent = createCodingAgent({
      workspace,
      modelProvider: model,
      maxRounds: 4,
      maxToolCalls: 4,
      maxToolConcurrency: 1,
      maxToolArgumentBytes: 8_192,
      maxToolResultBytes: 8_192,
      toolTimeoutMs: 1_000,
    });

    const events = await collect(
      agent.run({
        messages: [{ role: "user", content: "Update greeting.ts" }],
        metadata: { approvedTools: ["apply_patch"] },
      }),
    );

    expect(events.find((event) =>
      event.type === "tool_result" && event.name === "apply_patch"
    )).toMatchObject({ success: true });
    expect(await readFile(path.join(root, "greeting.ts"), "utf8")).toBe(
      updatedContent,
    );
    expect(events[0]).toMatchObject({
      type: "start",
      limits: {
        maxRounds: 4,
        maxToolCalls: 4,
        maxToolConcurrency: 1,
        maxToolArgumentBytes: 8_192,
        maxToolResultBytes: 8_192,
        toolTimeoutMs: 1_000,
      },
    });
  });

  it("delegates restricted tools to a trusted interactive host policy", async () => {
    const { root, workspace } = await fixture();
    const { model } = fakeModel([
      toolCall("patch", "apply_patch", {
        path: "greeting.ts",
        expectedContent: originalContent,
        newContent: updatedContent,
      }),
      finalRound,
    ]);
    const approvals: string[] = [];
    const agent = createCodingAgent({
      workspace,
      modelProvider: model,
      interactiveToolPolicy: {
        async evaluate({ tool }) {
          approvals.push(tool.name);
          return { allowed: true };
        },
      },
    });

    const events = await collect(
      agent.run({
        messages: [{ role: "user", content: "Update greeting.ts" }],
      }),
    );

    expect(approvals).toEqual(["apply_patch"]);
    expect(events.find((event) =>
      event.type === "tool_result" && event.name === "apply_patch"
    )).toMatchObject({ success: true });
    expect(await readFile(path.join(root, "greeting.ts"), "utf8")).toBe(
      updatedContent,
    );
  });

  it("never delegates an unannotated tool to an interactive policy", async () => {
    const { workspace } = await fixture();
    const { model } = fakeModel([
      toolCall("unsafe", "unsafe_tool", {}),
      finalRound,
    ]);
    let approvalCalls = 0;
    const agent = createCodingAgent({
      workspace,
      modelProvider: model,
      extraTools: [{
        name: "unsafe_tool",
        description: "Missing a trusted effect annotation.",
        schema: z.object({}).strict(),
        execute: () => ({ unsafe: true }),
      }],
      interactiveToolPolicy: {
        evaluate() {
          approvalCalls += 1;
          return { allowed: true };
        },
      },
    });

    const events = await collect(agent.run("Try the unsafe tool"));

    expect(approvalCalls).toBe(0);
    expect(events.find((event) =>
      event.type === "tool_result" && event.name === "unsafe_tool"
    )).toMatchObject({
      success: false,
      error: { code: "tool_denied" },
    });
  });

  it("adds sandbox tools and authorizes execution only by exact tool name", async () => {
    const { workspace } = await fixture();
    const calls: Parameters<SandboxPort["run"]>[0][] = [];
    const sandbox: SandboxPort = {
      async run(input) {
        calls.push(input);
        return {
          cwd: input.cwd ?? ".",
          exitCode: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          outputBytes: 2,
          capturedOutputBytes: 2,
          truncated: false,
          terminationReason: "exit",
          durationMs: 1,
        };
      },
    };
    const { model, requests } = fakeModel([
      toolCall("command", "run_command", {
        executable: "node",
        args: ["--version"],
        cwd: ".",
      }),
      toolCall("status", "git_status", { cwd: "." }),
      finalRound,
    ]);
    const agent = createCodingAgent({
      workspace,
      sandbox,
      modelProvider: model,
      extraTools: [
        {
          name: "inspect_context",
          description: "Return deterministic test context.",
          schema: z.object({}).strict(),
          annotations: { effect: "read", idempotent: true },
          execute: () => ({ ready: true }),
        },
      ],
    });

    const events = await collect(
      agent.run({
        messages: [{ role: "user", content: "Check Node" }],
        metadata: { approvedTools: ["run_command"] },
      }),
    );

    expect(requests[0].tools.map((tool) => tool.function.name)).toEqual([
      "list_files",
      "search_code",
      "read_file",
      "apply_patch",
      "delete_file",
      "move_file",
      "run_command",
      "git_status",
      "git_diff",
      "inspect_context",
    ]);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      name: "run_command",
      success: true,
    });
    expect(events.find((event) =>
      event.type === "tool_result" && event.name === "git_status"
    )).toMatchObject({
      success: false,
      error: { code: "tool_denied" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: "node",
      args: ["--version"],
      cwd: ".",
    });
  });
});
