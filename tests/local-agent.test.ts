import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type {
  AgentModel,
  AgentModelChunk,
} from "@/lib/agent";
import {
  LocalApprovalCoordinator,
  LocalAgentStore,
  LocalCodingService,
  localAgentConfigSchema,
  saveLocalModelSettingsSchema,
} from "@/lib/local-agent";
import type {
  LocalClientEvent,
  LocalProject,
  LocalRun,
  LocalThread,
} from "@/lib/local-agent";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LocalAgentStore", () => {
  it("migrates and persists pending worktree cleanup markers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-store-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "legacy.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE local_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
      CREATE TABLE local_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES local_projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('local', 'worktree')),
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const timestamp = "2026-01-01T00:00:00.000Z";
    legacy
      .prepare(
        `INSERT INTO local_projects
         (id, name, root_path, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("project-legacy", "legacy", root, timestamp, timestamp);
    legacy
      .prepare(
        `INSERT INTO local_threads
         (id, project_id, title, mode, workspace_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "thread-legacy",
        "project-legacy",
        "Legacy thread",
        "worktree",
        path.join(root, "worktree"),
        "completed",
        timestamp,
        timestamp,
      );
    legacy.close();

    const marker = "a".repeat(40);
    const migrated = new LocalAgentStore(databasePath);
    expect(migrated.getThread("thread-legacy")?.worktreeCleanupCommit).toBeNull();
    expect(
      migrated.setThreadWorkspace(
        "thread-legacy",
        "local",
        root,
        timestamp,
        marker,
      ).worktreeCleanupCommit,
    ).toBe(marker);
    migrated.close();

    const reopened = new LocalAgentStore(databasePath);
    expect(reopened.getThread("thread-legacy")).toMatchObject({
      mode: "local",
      workspacePath: root,
      worktreeCleanupCommit: marker,
    });
    reopened.close();
  });

  it("persists local projects, threads, runs, messages, and crash recovery", () => {
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
      title: "Fix the test",
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
    store.insertMessage({
      id: "message-1",
      threadId: thread.id,
      role: "user",
      content: "Fix it",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    store.insertRun(run);
    store.recoverInterruptedRuns("2026-01-01T00:01:00.000Z");

    expect(store.getThreadDetail(thread.id)).toMatchObject({
      thread: { status: "failed" },
      messages: [
        { role: "user", content: "Fix it" },
        {
          role: "assistant",
          content: expect.stringContaining(
            "[Run failed before completion] The desktop process stopped",
          ),
        },
      ],
      runs: [{
        status: "failed",
        finishedAt: "2026-01-01T00:01:00.000Z",
      }],
    });
    store.close();
  });

  it("returns bounded recent messages in chronological order", () => {
    const store = new LocalAgentStore(":memory:");
    const project: LocalProject = {
      id: "project-recent",
      name: "project",
      rootPath: "/tmp/project-recent",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:00.000Z",
    };
    const thread: LocalThread = {
      id: "thread-recent",
      projectId: project.id,
      title: "Recent messages",
      mode: "local",
      workspacePath: project.rootPath,
      status: "idle",
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    };
    store.upsertProject(project);
    store.insertThread(thread);
    for (let index = 1; index <= 5; index += 1) {
      store.insertMessage({
        id: `message-${index}`,
        threadId: thread.id,
        role: index % 2 === 0 ? "assistant" : "user",
        content: `message ${index}`,
        createdAt: `2026-01-01T00:00:0${index}.000Z`,
      });
    }

    expect(
      store.listRecentMessages(thread.id, 3).map((message) => message.content),
    ).toEqual(["message 3", "message 4", "message 5"]);
    store.close();
  });
});

describe("LocalApprovalCoordinator", () => {
  it("cancels an approval aborted while its listener is registered", async () => {
    const store = new LocalAgentStore(":memory:");
    const timestamp = "2026-01-01T00:00:00.000Z";
    store.upsertProject({
      id: "project-approval-abort",
      name: "project",
      rootPath: "/tmp/project-approval-abort",
      createdAt: timestamp,
      lastOpenedAt: timestamp,
    });
    store.insertThread({
      id: "thread-approval-abort",
      projectId: "project-approval-abort",
      title: "Abort approval",
      mode: "local",
      workspacePath: "/tmp/project-approval-abort",
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.insertRun({
      id: "run-approval-abort",
      threadId: "thread-approval-abort",
      status: "running",
      model: "test-model",
      startedAt: timestamp,
      finishedAt: null,
      errorMessage: null,
    });

    const approvalChanges: LocalClientEvent[] = [];
    const waitingStates: boolean[] = [];
    const coordinator = new LocalApprovalCoordinator({
      store,
      idGenerator: () => "approval-abort",
      now: () => new Date(timestamp),
      onApprovalChanged: (approval) =>
        approvalChanges.push({ type: "approval.changed", approval }),
      onWaitingChanged: (_runId, waiting) => waitingStates.push(waiting),
    });
    const controller = new AbortController();
    const addEventListener =
      controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(
      (type, listener, options) => {
        controller.abort(new Error("Cancelled during approval setup."));
        addEventListener(type, listener, options);
      },
    );

    await expect(
      coordinator.policy.evaluate({
        tool: {
          name: "write_file",
          description: "Write a file.",
          schema: z.object({}),
          annotations: { effect: "write" },
          execute: () => undefined,
        },
        arguments: {},
        context: {
          runId: "run-approval-abort",
          callId: "call-approval-abort",
          round: 1,
          signal: controller.signal,
        },
      }),
    ).resolves.toMatchObject({ allowed: false });
    expect(store.getApproval("approval-abort")).toMatchObject({
      status: "cancelled",
    });
    expect(approvalChanges).toEqual([
      expect.objectContaining({
        type: "approval.changed",
        approval: expect.objectContaining({ status: "cancelled" }),
      }),
    ]);
    expect(waitingStates).toEqual([false]);
    store.close();
  });
});

describe("local model settings protocol", () => {
  it("normalizes settings and defaults to preserving the saved key", () => {
    expect(saveLocalModelSettingsSchema.parse({
      baseUrl: " https://models.example.com/v1 ",
      model: " test-model ",
    })).toEqual({
      baseUrl: "https://models.example.com/v1",
      model: "test-model",
      clearApiKey: false,
    });
  });

  it("rejects credential-bearing URLs and conflicting key operations", () => {
    expect(() =>
      saveLocalModelSettingsSchema.parse({
        baseUrl: "https://user:pass@models.example.com/v1",
        model: "test-model",
      }),
    ).toThrow();
    expect(() =>
      saveLocalModelSettingsSchema.parse({
        baseUrl: "",
        model: "test-model",
        apiKey: "replacement-key",
        clearApiKey: true,
      }),
    ).toThrow();
  });
});

describe("LocalCodingService", () => {
  it("treats renderer event callbacks as non-fatal observers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-events-"));
    temporaryDirectories.push(root);
    const model: AgentModel = {
      id: "event-sink-model",
      async stream() {
        return (async function* () {
          yield { content: "Done.", finishReason: "stop" };
        })();
      },
    };
    const store = new LocalAgentStore(":memory:");
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({
        LLM_API_KEY: "test-key-123",
        LLM_MODEL: model.id,
      }),
      worktreeRoot: path.join(root, ".worktrees"),
      modelFactory: () => model,
      onEvent() {
        throw new Error("Renderer listener failed.");
      },
    });

    const project = await service.addProject(root);
    const started = await service.startTask({
      projectId: project.id,
      prompt: "Finish despite event errors",
      mode: "local",
    });
    await vi.waitFor(() => {
      expect(store.getRun(started.run.id)?.status).toBe("completed");
    });
    expect(service.snapshot().activeRunIds).toEqual([]);
    expect(store.getThreadDetail(started.thread.id)?.messages).toMatchObject([
      { role: "user", content: "Finish despite event errors" },
      { role: "assistant", content: "Done." },
    ]);
    await service.dispose();
  });

  it("reserves a project before async setup and releases failed reservations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-reservation-"));
    temporaryDirectories.push(root);
    const modelGate = withResolvers<void>();
    const completed = withResolvers<LocalRun>();
    const model: AgentModel = {
      id: "blocking-local-model",
      async stream() {
        return (async function* () {
          await modelGate.promise;
          yield { content: "Done.", finishReason: "stop" };
        })();
      },
    };
    const store = new LocalAgentStore(":memory:");
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({
        LLM_API_KEY: "test-key-123",
        LLM_MODEL: model.id,
      }),
      worktreeRoot: path.join(root, ".worktrees"),
      modelFactory: () => model,
      onEvent(event) {
        if (event.type === "run.changed" && event.run.status === "completed") {
          completed.resolve(event.run);
        }
      },
    });
    const project = await service.addProject(root);

    await expect(
      service.startTask({
        projectId: project.id,
        prompt: "This setup should fail",
        mode: "worktree",
      }),
    ).rejects.toThrow("Git worktree operation failed.");
    expect(service.hasInFlightOperations()).toBe(false);

    const firstStart = service.startTask({
      projectId: project.id,
      prompt: "Keep this task active",
      mode: "local",
    });
    expect(service.hasInFlightOperations()).toBe(true);
    expect(service.snapshot().activeRunIds).toEqual([]);
    await expect(
      service.startTask({
        projectId: project.id,
        prompt: "Do not start this in parallel",
        mode: "local",
      }),
    ).rejects.toThrow(
      "Parallel tasks in the same project are not supported. Stop the active task or wait for it to finish.",
    );
    const started = await firstStart;
    expect(service.hasInFlightOperations()).toBe(true);
    expect(service.snapshot().activeRunIds).toEqual([started.run.id]);

    modelGate.resolve();
    const finished = await completed.promise;
    expect(finished.id).toBe(started.run.id);
    await vi.waitFor(() => {
      expect(service.hasInFlightOperations()).toBe(false);
    });
    expect(store.listThreads(project.id)).toHaveLength(1);
    await service.dispose();
  });

  it("reports unstaged, staged, and untracked workspace changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-diff-"));
    temporaryDirectories.push(root);
    await execFileAsync("git", ["init", "--quiet"], { cwd: root });
    await execFileAsync(
      "git",
      ["config", "user.email", "agent@example.test"],
      { cwd: root },
    );
    await execFileAsync("git", ["config", "user.name", "Agent Test"], {
      cwd: root,
    });
    const trackedPath = path.join(root, "tracked.txt");
    await writeFile(trackedPath, "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: root,
    });
    await writeFile(trackedPath, "staged\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await writeFile(trackedPath, "working\n", "utf8");
    await writeFile(path.join(root, "untracked.txt"), "new\n", "utf8");

    const store = new LocalAgentStore(":memory:");
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({}),
      worktreeRoot: path.join(root, ".worktrees"),
    });
    const project = await service.addProject(root);
    const now = new Date().toISOString();
    const thread: LocalThread = {
      id: "diff-thread",
      projectId: project.id,
      title: "Inspect changes",
      mode: "local",
      workspacePath: project.rootPath,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    store.insertThread(thread);

    const diff = await service.getDiff({ threadId: thread.id });
    expect(diff).toContain("### Unstaged changes");
    expect(diff).toContain("-staged");
    expect(diff).toContain("+working");
    expect(diff).toContain("### Staged changes");
    expect(diff).toContain("-before");
    expect(diff).toContain("+staged");
    expect(diff).toContain("### Untracked files");
    expect(diff).toContain("?? untracked.txt");
    await service.dispose();
  });

  it("persists cancellation before closing the database during disposal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-dispose-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "agent.sqlite");
    const model: AgentModel = {
      id: "blocking-dispose-model",
      async stream(_request, options) {
        return (async function* () {
          await new Promise<never>((_, reject) => {
            const signal = options?.signal;
            const rejectAbort = () =>
              reject(signal?.reason ?? new Error("Aborted."));
            if (signal?.aborted) rejectAbort();
            else signal?.addEventListener("abort", rejectAbort, { once: true });
          });
        })();
      },
    };
    const store = new LocalAgentStore(databasePath);
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({
        LLM_API_KEY: "test-key-123",
        LLM_MODEL: model.id,
      }),
      worktreeRoot: path.join(root, ".worktrees"),
      modelFactory: () => model,
    });
    const project = await service.addProject(root);
    const started = await service.startTask({
      projectId: project.id,
      prompt: "Keep running until shutdown",
      mode: "local",
    });

    await service.dispose();

    const reopened = new LocalAgentStore(databasePath);
    expect(reopened.getRun(started.run.id)).toMatchObject({
      status: "cancelled",
      errorMessage: "Desktop application is shutting down.",
    });
    expect(reopened.getThread(started.thread.id)).toMatchObject({
      status: "cancelled",
    });
    expect(reopened.listMessages(started.thread.id)).toMatchObject([
      { role: "user", content: "Keep running until shutdown" },
      {
        role: "assistant",
        content: expect.stringContaining("[Run cancelled before completion]"),
      },
    ]);
    reopened.close();
  });

  it("runs a coding task and resumes after an interactive write approval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "base-agent-local-"));
    temporaryDirectories.push(root);
    const sourcePath = path.join(root, "greeting.ts");
    const original = 'export const greeting = "hello";\n';
    const updated = 'export const greeting = "hi";\n';
    await writeFile(sourcePath, original, "utf8");

    let modelRound = 0;
    const model: AgentModel = {
      id: "fake-local-model",
      async stream() {
        const chunks: readonly AgentModelChunk[] = modelRound++ === 0
          ? [{
              finishReason: "tool_calls",
              toolCalls: [{
                index: 0,
                id: "patch-call",
                name: "apply_patch",
                arguments: JSON.stringify({
                  path: "greeting.ts",
                  expectedContent: original,
                  newContent: updated,
                }),
              }],
            }]
          : [{ content: "Updated greeting.ts.", finishReason: "stop" }];
        return (async function* () {
          for (const chunk of chunks) yield chunk;
        })();
      },
    };

    const store = new LocalAgentStore(":memory:");
    const completed = withResolvers<LocalRun>();
    const events: LocalClientEvent[] = [];
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({
        LLM_API_KEY: "test-key-123",
        LLM_MODEL: model.id,
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
      prompt: "Update greeting.ts",
      mode: "local",
    });
    const finished = await Promise.race([
      completed.promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Local task timed out.")), 5_000),
      ),
    ]);

    expect(finished.id).toBe(started.run.id);
    expect(await readFile(sourcePath, "utf8")).toBe(updated);
    expect(events).toContainEqual(expect.objectContaining({
      type: "approval.changed",
      approval: expect.objectContaining({
        toolName: "apply_patch",
        status: "approved",
      }),
    }));
    expect(store.getThreadDetail(started.thread.id)).toMatchObject({
      messages: [
        { role: "user", content: "Update greeting.ts" },
        { role: "assistant", content: "Updated greeting.ts." },
      ],
      runs: [{ status: "completed" }],
    });
    await service.dispose();
  });
});

function withResolvers<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
