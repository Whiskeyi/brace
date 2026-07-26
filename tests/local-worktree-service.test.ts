import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalAgentStore,
  LocalCodingService,
  LocalWorktreeManager,
  localAgentConfigSchema,
  resolveLocalWorktreeSchema,
  type LocalThread,
} from "@/lib/local-agent";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local worktree service lifecycle", () => {
  it("persists cleanupPending across restart and retries it explicitly", async () => {
    const fixture = await createFixture();
    const databasePath = path.join(fixture.root, "agent.sqlite");
    const store = new LocalAgentStore(databasePath);
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({}),
      worktreeRoot: fixture.worktreeRoot,
    });
    const project = await service.addProject(fixture.repository);
    const thread = await insertWorktreeThread(
      store,
      fixture,
      project.id,
      "thread-retry-cleanup",
    );
    await writeFile(path.join(thread.workspacePath, "result.txt"), "done\n");
    await git(
      fixture.repository,
      "worktree",
      "lock",
      "--reason",
      "test pending cleanup",
      thread.workspacePath,
    );

    const applied = await service.resolveWorktree({
      threadId: thread.id,
      action: "apply",
      confirmed: true,
    });
    expect(applied).toMatchObject({
      action: "apply",
      cleanupPending: true,
      thread: {
        mode: "local",
        workspacePath: fixture.repository,
        worktreeCleanupCommit: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
      },
    });
    const marker = applied.thread.worktreeCleanupCommit as string;
    await expect(access(thread.workspacePath)).resolves.toBeUndefined();
    await service.dispose();

    await git(
      fixture.repository,
      "worktree",
      "unlock",
      thread.workspacePath,
    );
    const reopenedStore = new LocalAgentStore(databasePath);
    const reopenedService = new LocalCodingService({
      store: reopenedStore,
      config: localAgentConfigSchema.parse({}),
      worktreeRoot: fixture.worktreeRoot,
    });
    expect(reopenedStore.getThread(thread.id)).toMatchObject({
      mode: "local",
      worktreeCleanupCommit: marker,
    });
    await expect(
      reopenedService.getWorktree({ threadId: thread.id }),
    ).resolves.toMatchObject({
      workspacePath: thread.workspacePath,
    });
    await expect(
      reopenedService.resolveWorktree({
        threadId: thread.id,
        action: "apply",
        confirmed: true,
      }),
    ).rejects.toThrow("does not match the task's current state");
    await expect(
      reopenedService.resolveWorktree({
        threadId: thread.id,
        action: "discard",
        confirmed: true,
      }),
    ).rejects.toThrow("does not match the task's current state");

    const cleaned = await reopenedService.resolveWorktree({
      threadId: thread.id,
      action: "cleanup",
      confirmed: true,
    });
    expect(cleaned).toMatchObject({
      action: "cleanup",
      patchBytes: null,
      cleanupPending: false,
      thread: {
        mode: "local",
        worktreeCleanupCommit: null,
      },
    });
    await expect(access(thread.workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      reopenedStore.getThread(thread.id)?.worktreeCleanupCommit,
    ).toBeNull();
    await reopenedService.dispose();
  });

  it("refuses cleanup with a missing or forged persisted marker", async () => {
    const fixture = await createFixture();
    const store = new LocalAgentStore(":memory:");
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({}),
      worktreeRoot: fixture.worktreeRoot,
    });
    const project = await service.addProject(fixture.repository);
    const thread = await insertWorktreeThread(
      store,
      fixture,
      project.id,
      "thread-forged-cleanup",
    );
    const marker = "f".repeat(40);
    store.setThreadWorkspace(
      thread.id,
      "local",
      fixture.repository,
      new Date().toISOString(),
      marker,
    );

    await expect(
      service.resolveWorktree({
        threadId: thread.id,
        action: "cleanup",
        confirmed: true,
      }),
    ).rejects.toThrow("changed after it was applied");
    expect(store.getThread(thread.id)?.worktreeCleanupCommit).toBe(marker);
    await expect(access(thread.workspacePath)).resolves.toBeUndefined();

    store.setThreadWorkspace(
      thread.id,
      "local",
      fixture.repository,
      new Date().toISOString(),
      null,
    );
    await expect(
      service.resolveWorktree({
        threadId: thread.id,
        action: "cleanup",
        confirmed: true,
      }),
    ).rejects.toThrow("does not have a pending worktree cleanup");
    await expect(access(thread.workspacePath)).resolves.toBeUndefined();
    await service.dispose();
  });

  it("requires explicit confirmation and applies changes back as an unstaged diff", async () => {
    const fixture = await createFixture();
    const store = new LocalAgentStore(":memory:");
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({}),
      worktreeRoot: fixture.worktreeRoot,
    });
    const project = await service.addProject(fixture.repository);
    const thread = await insertWorktreeThread(
      store,
      fixture,
      project.id,
      "thread-apply",
    );
    await writeFile(path.join(thread.workspacePath, "result.txt"), "done\n");

    expect(() =>
      resolveLocalWorktreeSchema.parse({
        threadId: thread.id,
        action: "apply",
        confirmed: false,
      }),
    ).toThrow();
    await expect(service.getWorktree({ threadId: thread.id })).resolves
      .toMatchObject({
        dirty: true,
        branchName: `brace/${project.id}/${thread.id}`,
      });

    const result = await service.resolveWorktree({
      threadId: thread.id,
      action: "apply",
      confirmed: true,
    });

    expect(result).toMatchObject({
      action: "apply",
      patchBytes: expect.any(Number),
      cleanupPending: false,
      thread: {
        id: thread.id,
        mode: "local",
        workspacePath: fixture.repository,
      },
    });
    expect(await readFile(path.join(fixture.repository, "result.txt"), "utf8"))
      .toBe("done\n");
    expect(await git(fixture.repository, "status", "--short")).toContain(
      "?? result.txt",
    );
    await expect(access(thread.workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await service.dispose();
  });

  it("discards a dirty task only after the confirmed action", async () => {
    const fixture = await createFixture();
    const store = new LocalAgentStore(":memory:");
    const service = new LocalCodingService({
      store,
      config: localAgentConfigSchema.parse({}),
      worktreeRoot: fixture.worktreeRoot,
    });
    const project = await service.addProject(fixture.repository);
    const thread = await insertWorktreeThread(
      store,
      fixture,
      project.id,
      "thread-discard",
    );
    await writeFile(path.join(thread.workspacePath, "discarded.txt"), "gone\n");

    const result = await service.resolveWorktree({
      threadId: thread.id,
      action: "discard",
      confirmed: true,
    });

    expect(result).toMatchObject({
      action: "discard",
      patchBytes: null,
      cleanupPending: false,
      thread: { mode: "local", workspacePath: fixture.repository },
    });
    await expect(access(thread.workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(path.join(fixture.repository, "discarded.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await service.dispose();
  });
});

async function insertWorktreeThread(
  store: LocalAgentStore,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  projectId: string,
  threadId: string,
): Promise<LocalThread> {
  const manager = new LocalWorktreeManager(fixture.worktreeRoot);
  const workspacePath = await manager.create(
    fixture.repository,
    projectId,
    threadId,
  );
  const now = new Date().toISOString();
  const thread: LocalThread = {
    id: threadId,
    projectId,
    title: "Worktree lifecycle",
    mode: "worktree",
    workspacePath,
    status: "completed",
    createdAt: now,
    updatedAt: now,
  };
  store.insertThread(thread);
  return thread;
}

async function createFixture(): Promise<{
  root: string;
  repository: string;
  worktreeRoot: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "base-agent-service-worktree-"));
  temporaryDirectories.push(root);
  const repositoryPath = path.join(root, "repository");
  const worktreeRoot = path.join(root, "managed");
  await mkdir(repositoryPath);
  const repository = await realpath(repositoryPath);
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
  await writeFile(path.join(repository, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Agent Test",
      "-c",
      "user.email=agent@example.test",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: repository },
  );
  return { root, repository, worktreeRoot };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execFileAsync("git", args, { cwd, encoding: "utf8" })
  ).stdout.trim();
}
