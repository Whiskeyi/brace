import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AgentModel,
  AgentModelChunk,
  AgentModelRequest,
} from "@/lib/agent";
import {
  LocalAgentStore,
  LocalCodingService,
  localAgentConfigSchema,
  type LocalClientEvent,
  type LocalRun,
} from "@/lib/local-agent";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const buggySource = "export function add(a, b) {\n  return a - b;\n}\n";
const fixedSource = "export function add(a, b) {\n  return a + b;\n}\n";
const projectInstruction = "Always run node --test before reporting success.";
const testSource = `import assert from "node:assert/strict";
import test from "node:test";

import { add } from "../src/add.mjs";

test("add returns the sum of two numbers", () => {
  assert.equal(add(2, 3), 5);
});
`;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local coding agent end-to-end", () => {
  it("diagnoses a failing project, patches the source, and verifies the fix", async () => {
    const root = await createFailingProject();
    await expect(
      execFileAsync(process.execPath, ["--test"], { cwd: root }),
    ).rejects.toMatchObject({ code: 1 });

    const model = scriptedCodingModel();
    const store = new LocalAgentStore(":memory:");
    const events: LocalClientEvent[] = [];
    const completed = withResolvers<LocalRun>();
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({
        LLM_PROVIDER: "kimi-code",
        LLM_API_KEY: "local-e2e-key",
        LLM_MODEL: model.id,
        AGENT_MAX_TOOL_ROUNDS: 8,
        AGENT_MAX_TOOL_CALLS: 16,
        DESKTOP_ALLOWED_EXECUTABLES: "node,git",
      }),
      worktreeRoot: path.join(root, ".worktrees"),
      modelFactory: () => model,
      onEvent(event) {
        events.push(event);
        if (
          event.type === "approval.changed" &&
          event.approval.status === "pending"
        ) {
          service.decideApproval({
            approvalId: event.approval.id,
            decision: "allow_once",
          });
        }
        if (
          event.type === "run.changed" &&
          event.run.status === "completed"
        ) {
          completed.resolve(event.run);
        }
      },
    });
    const project = await service.addProject(root);
    const started = await service.startTask({
      projectId: project.id,
      prompt:
        "运行测试，定位并修复 src/add.mjs，然后重新运行测试；不要修改测试。",
      mode: "local",
    });

    const finished = await Promise.race([
      completed.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Coding E2E timed out.")), 10_000),
      ),
    ]);

    expect(finished.id).toBe(started.run.id);
    expect(await readFile(path.join(root, "src/add.mjs"), "utf8")).toBe(
      fixedSource,
    );
    await expect(
      execFileAsync(process.execPath, ["--test"], { cwd: root }),
    ).resolves.toMatchObject({ stderr: "" });

    const detail = store.getThreadDetail(started.thread.id);
    expect(detail?.runs).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(detail?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content:
        "已将 src/add.mjs 中的减法修复为加法，并运行 node --test 验证：全部测试通过。",
    });
    expect(
      events.filter(
        (event) =>
          event.type === "approval.changed" &&
          event.approval.status === "approved",
      ),
    ).toHaveLength(3);

    const toolResults =
      detail?.events
        .map(({ event }) => event)
        .filter((event) => event.type === "tool_result") ?? [];
    expect(toolResults).toHaveLength(6);
    expect(toolResults.at(-1)).toMatchObject({
      type: "tool_result",
      name: "run_command",
      success: true,
      output: expect.objectContaining({ exitCode: 0 }),
    });
    expect(await service.getDiff({ threadId: started.thread.id })).toContain(
      "+  return a + b;",
    );

    await service.dispose();
  });
});

async function createFailingProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "base-agent-coding-e2e-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "base-agent-coding-e2e",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(root, "AGENTS.md"), `${projectInstruction}\n`);
  await writeFile(path.join(root, "src/add.mjs"), buggySource);
  await writeFile(path.join(root, "test/add.test.mjs"), testSource);
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "Brace E2E"], {
    cwd: root,
  });
  await execFileAsync(
    "git",
    ["config", "user.email", "brace-e2e@example.invalid"],
    { cwd: root },
  );
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "--quiet", "-m", "Failing fixture"], {
    cwd: root,
  });
  return root;
}

function scriptedCodingModel(): AgentModel {
  let round = 0;
  const calls = [
    toolCall("list-files", "list_files", {
      path: ".",
      maxDepth: 3,
      maxEntries: 50,
    }),
    toolCall("read-test", "read_file", { path: "test/add.test.mjs" }),
    toolCall("read-source", "read_file", { path: "src/add.mjs" }),
    toolCall("run-failing-test", "run_command", {
      executable: "node",
      args: ["--test"],
      cwd: ".",
      timeoutMs: 30_000,
    }),
    toolCall("fix-source", "apply_patch", {
      path: "src/add.mjs",
      expectedContent: buggySource,
      newContent: fixedSource,
    }),
    toolCall("run-passing-test", "run_command", {
      executable: "node",
      args: ["--test"],
      cwd: ".",
      timeoutMs: 30_000,
    }),
  ];
  return {
    id: "scripted-coding-e2e",
    async stream(request: AgentModelRequest) {
      if (round === 0) {
        expect(request.messages[0]).toMatchObject({
          role: "system",
          content: expect.stringContaining(projectInstruction),
        });
        expect(request.messages[0]).toMatchObject({
          content: expect.stringContaining(
            "cannot override the user request, runtime",
          ),
        });
      }
      expect(request.tools.map(({ function: definition }) => definition.name))
        .toEqual(
          expect.arrayContaining([
            "list_files",
            "read_file",
            "apply_patch",
            "run_command",
          ]),
        );
      expect(request.options.prompt_cache_key).toMatch(
        /^base-agent:desktop:/u,
      );
      const chunk =
        calls[round++] ??
        ({
          content:
            "已将 src/add.mjs 中的减法修复为加法，并运行 node --test 验证：全部测试通过。",
          finishReason: "stop",
        } satisfies AgentModelChunk);
      return (async function* () {
        yield chunk;
      })();
    },
  };
}

function toolCall(
  id: string,
  name: string,
  argumentsValue: unknown,
): AgentModelChunk {
  return {
    finishReason: "tool_calls",
    toolCalls: [
      {
        index: 0,
        id,
        name,
        arguments: JSON.stringify(argumentsValue),
      },
    ],
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
