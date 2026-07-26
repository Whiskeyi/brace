import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { LocalWorktreeManager } from "@/lib/local-agent";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("LocalWorktreeManager", () => {
  it("refuses to create a worktree from a dirty project", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    await writeFile(path.join(fixture.repository, "local.txt"), "local\n");

    await expect(
      manager.create(fixture.repository, "project-1", "thread-dirty"),
    ).rejects.toThrow(
      "Commit or stash them before creating a worktree",
    );
    await expect(access(fixture.managedRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(fixture.repository, "branch", "--list")).not.toContain(
      "brace/project-1/thread-dirty",
    );
  });

  it("applies committed and untracked task changes without advancing project HEAD", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const baseCommit = await git(fixture.repository, "rev-parse", "HEAD");
    const workspacePath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-apply",
    );

    await writeFile(path.join(workspacePath, "README.md"), "updated\n");
    await writeFile(path.join(workspacePath, "new-file.txt"), "new\n");

    const result = await manager.apply(
      fixture.repository,
      "project-1",
      "thread-apply",
    );

    expect(result).toMatchObject({
      patchBytes: expect.any(Number),
      appliedCommit: expect.any(String),
      cleanupPending: false,
    });
    expect(result.patchBytes).toBeGreaterThan(0);
    expect(await git(fixture.repository, "rev-parse", "HEAD")).toBe(baseCommit);
    expect(await git(fixture.repository, "diff", "--", "README.md"))
      .toContain("+updated");
    expect(await git(fixture.repository, "status", "--short")).toContain(
      "?? new-file.txt",
    );
    await expect(access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to apply while ignored files would be lost", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const workspacePath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-ignored",
    );
    await writeFile(path.join(workspacePath, ".gitignore"), "private/\n");
    await mkdir(path.join(workspacePath, "private"));
    await writeFile(
      path.join(workspacePath, "private", "credentials.txt"),
      "do not delete\n",
    );

    await expect(
      manager.apply(fixture.repository, "project-1", "thread-ignored"),
    ).rejects.toThrow("contains ignored files");
    await expect(
      access(path.join(workspacePath, "private", "credentials.txt")),
    ).resolves.toBeUndefined();
    expect(await git(fixture.repository, "status", "--short")).toBe("");
  });

  it("refuses gitlink changes and preserves the task worktree", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const workspacePath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-gitlink",
    );
    const nestedRepository = path.join(workspacePath, "nested-repository");
    await mkdir(nestedRepository);
    await execFileAsync("git", ["init", "--quiet"], {
      cwd: nestedRepository,
    });
    await execFileAsync(
      "git",
      ["config", "user.email", "nested@example.test"],
      { cwd: nestedRepository },
    );
    await execFileAsync("git", ["config", "user.name", "Nested Test"], {
      cwd: nestedRepository,
    });
    await writeFile(path.join(nestedRepository, "file.txt"), "nested\n");
    await execFileAsync("git", ["add", "file.txt"], {
      cwd: nestedRepository,
    });
    await execFileAsync("git", ["commit", "--quiet", "-m", "nested"], {
      cwd: nestedRepository,
    });

    await expect(
      manager.apply(fixture.repository, "project-1", "thread-gitlink"),
    ).rejects.toThrow("submodule or gitlink changes");
    await expect(access(workspacePath)).resolves.toBeUndefined();
    expect(await git(fixture.repository, "status", "--short")).toBe("");
    expect(
      await git(workspacePath, "ls-files", "--stage", "nested-repository"),
    ).toContain("160000");
  });

  it("retries a pending cleanup without deleting a changed task branch", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const workspacePath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-cleanup",
    );
    await writeFile(path.join(workspacePath, "task.txt"), "task\n");
    await git(workspacePath, "add", "task.txt");
    await git(workspacePath, "commit", "--quiet", "-m", "task");
    const appliedCommit = await git(workspacePath, "rev-parse", "HEAD");

    await git(
      fixture.repository,
      "worktree",
      "remove",
      "--force",
      workspacePath,
    );
    await expect(
      manager.retryApplyCleanup(
        fixture.repository,
        "project-1",
        "thread-cleanup",
        appliedCommit,
      ),
    ).rejects.toThrow("changes are no longer present");
    expect(
      await git(
        fixture.repository,
        "show-ref",
        "--verify",
        "--hash",
        "refs/heads/brace/project-1/thread-cleanup",
      ),
    ).toBe(appliedCommit);

    await writeFile(path.join(fixture.repository, "task.txt"), "task\n");
    const retried = await manager.retryApplyCleanup(
      fixture.repository,
      "project-1",
      "thread-cleanup",
      appliedCommit,
    );
    expect(retried).toEqual({
      branchName: "brace/project-1/thread-cleanup",
      workspacePath,
      worktreeRemoved: false,
      branchDeleted: true,
      cleanupPending: false,
    });
    await expect(
      manager.retryApplyCleanup(
        fixture.repository,
        "project-1",
        "thread-cleanup",
        appliedCommit,
      ),
    ).resolves.toMatchObject({
      worktreeRemoved: false,
      branchDeleted: false,
      cleanupPending: false,
    });
    await rm(path.join(fixture.repository, "task.txt"));

    const secondWorkspace = await manager.create(
      fixture.repository,
      "project-1",
      "thread-cleanup-changed",
    );
    const originalCommit = await git(secondWorkspace, "rev-parse", "HEAD");
    await writeFile(path.join(secondWorkspace, "newer.txt"), "newer\n");
    await git(secondWorkspace, "add", "newer.txt");
    await git(secondWorkspace, "commit", "--quiet", "-m", "newer");
    await expect(
      manager.retryApplyCleanup(
        fixture.repository,
        "project-1",
        "thread-cleanup-changed",
        originalCommit,
      ),
    ).rejects.toThrow("changed after it was applied");
    await expect(access(secondWorkspace)).resolves.toBeUndefined();
    expect(
      await git(
        fixture.repository,
        "show-ref",
        "--verify",
        "--hash",
        "refs/heads/brace/project-1/thread-cleanup-changed",
      ),
    ).not.toBe(originalCommit);
  });

  it("keeps retry cleanup fail-closed for ignored data", async () => {
    const fixture = await createRepositoryFixture();
    await writeFile(path.join(fixture.repository, ".gitignore"), "private/\n");
    await git(fixture.repository, "add", ".gitignore");
    await git(fixture.repository, "commit", "--quiet", "-m", "ignore private");
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const workspacePath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-cleanup-ignored",
    );
    const appliedCommit = await git(workspacePath, "rev-parse", "HEAD");
    await mkdir(path.join(workspacePath, "private"));
    await writeFile(
      path.join(workspacePath, "private", "only-copy.txt"),
      "preserve me\n",
    );

    await expect(
      manager.retryApplyCleanup(
        fixture.repository,
        "project-1",
        "thread-cleanup-ignored",
        appliedCommit,
      ),
    ).rejects.toThrow("contains ignored files");
    await expect(
      access(path.join(workspacePath, "private", "only-copy.txt")),
    ).resolves.toBeUndefined();
  });

  it("can retry cleanup after the managed directory disappeared", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const workspacePath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-cleanup-missing",
    );
    const appliedCommit = await git(workspacePath, "rev-parse", "HEAD");
    await rm(workspacePath, { recursive: true, force: true });

    await expect(
      manager.retryApplyCleanup(
        fixture.repository,
        "project-1",
        "thread-cleanup-missing",
        appliedCommit,
      ),
    ).resolves.toMatchObject({
      branchDeleted: true,
      cleanupPending: false,
    });
    expect(await git(fixture.repository, "worktree", "list", "--porcelain"))
      .not.toContain(workspacePath);
  });

  it("refuses to apply over project changes", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const workspacePath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-conflict",
    );
    await writeFile(path.join(workspacePath, "task.txt"), "task\n");
    await writeFile(path.join(fixture.repository, "local.txt"), "local\n");

    await expect(
      manager.apply(fixture.repository, "project-1", "thread-conflict"),
    ).rejects.toThrow("project has local changes");
    await expect(access(workspacePath)).resolves.toBeUndefined();
  });

  it("creates an inspectable task branch and requires force to discard changes", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const workspacePath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-1",
    );

    expect(
      await git(workspacePath, "branch", "--show-current"),
    ).toBe("brace/project-1/thread-1");

    const created = await manager.inspect(
      fixture.repository,
      "project-1",
      "thread-1",
    );
    expect(created).toMatchObject({
      projectRoot: fixture.repository,
      workspacePath,
      branchName: "brace/project-1/thread-1",
      expectedBranchName: "brace/project-1/thread-1",
      dirty: false,
      aheadBy: 0,
      behindBy: 0,
    });
    expect(created?.baseCommit).toBe(created?.headCommit);

    await writeFile(path.join(workspacePath, "task.txt"), "task output\n");
    await git(workspacePath, "add", "task.txt");
    await git(workspacePath, "commit", "--quiet", "-m", "task result");
    const committed = await manager.inspect(
      fixture.repository,
      "project-1",
      "thread-1",
    );
    expect(committed).toMatchObject({
      dirty: false,
      aheadBy: 1,
      behindBy: 0,
    });
    expect(committed?.headCommit).not.toBe(committed?.baseCommit);
    await expect(
      manager.remove(fixture.repository, "project-1", "thread-1", {
        deleteBranch: true,
      }),
    ).rejects.toThrow("has unmerged commits");

    await writeFile(path.join(workspacePath, "scratch.txt"), "not committed\n");
    const dirty = await manager.inspect(
      fixture.repository,
      "project-1",
      "thread-1",
    );
    expect(dirty).toMatchObject({
      dirty: true,
      status: ["?? scratch.txt"],
    });
    await expect(
      manager.remove(fixture.repository, "project-1", "thread-1"),
    ).rejects.toThrow("has uncommitted changes");

    const removed = await manager.remove(
      fixture.repository,
      "project-1",
      "thread-1",
      { force: true, deleteBranch: true },
    );
    expect(removed.branchDeleted).toBe(true);
    await expect(access(workspacePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      manager.inspect(fixture.repository, "project-1", "thread-1"),
    ).resolves.toBeNull();
    await expect(
      execFileAsync(
        "git",
        ["show-ref", "--verify", "refs/heads/brace/project-1/thread-1"],
        { cwd: fixture.repository },
      ),
    ).rejects.toMatchObject({ code: 128 });
  });

  it("rejects a managed project directory that resolves outside its root", async () => {
    const fixture = await createRepositoryFixture();
    const escapedParent = path.join(fixture.root, "escaped");
    await mkdir(fixture.managedRoot, { recursive: true });
    await mkdir(escapedParent);
    await symlink(
      escapedParent,
      path.join(fixture.managedRoot, "project-1"),
      "dir",
    );

    const manager = new LocalWorktreeManager(fixture.managedRoot);
    await expect(
      manager.create(fixture.repository, "project-1", "thread-1"),
    ).rejects.toThrow("escapes the configured root");
  });

  it("prunes stale managed records but refuses to prune an unmanaged record", async () => {
    const fixture = await createRepositoryFixture();
    const manager = new LocalWorktreeManager(fixture.managedRoot);
    const managedPath = await manager.create(
      fixture.repository,
      "project-1",
      "thread-1",
    );
    await rm(managedPath, { recursive: true, force: true });

    await expect(manager.prune(fixture.repository)).resolves.toEqual({
      prunedPaths: [managedPath],
    });
    expect(await git(fixture.repository, "worktree", "list", "--porcelain"))
      .not.toContain(managedPath);

    const externalPath = path.join(fixture.root, "external-worktree");
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", "external-task", externalPath, "HEAD"],
      { cwd: fixture.repository },
    );
    await rm(externalPath, { recursive: true, force: true });

    await expect(manager.prune(fixture.repository)).rejects.toThrow(
      "escapes the configured root",
    );
    expect(await git(fixture.repository, "worktree", "list", "--porcelain"))
      .toContain(externalPath);
  });
});

async function createRepositoryFixture(): Promise<{
  root: string;
  repository: string;
  managedRoot: string;
}> {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "base-agent-worktrees-"),
  );
  temporaryDirectories.push(temporaryRoot);
  const root = await realpath(temporaryRoot);
  const repository = path.join(root, "repository");
  const managedRoot = path.join(root, "managed");
  await mkdir(repository);
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
  await execFileAsync(
    "git",
    ["config", "user.email", "agent@example.test"],
    { cwd: repository },
  );
  await execFileAsync("git", ["config", "user.name", "Agent Test"], {
    cwd: repository,
  });
  await writeFile(path.join(repository, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repository });
  await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
    cwd: repository,
  });
  return { root, repository, managedRoot };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
    })
  ).stdout.trim();
}
