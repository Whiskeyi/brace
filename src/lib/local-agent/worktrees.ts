import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const BRANCH_PREFIX = "brace";

export interface LocalWorktreeMetadata {
  projectId: string;
  threadId: string;
  projectRoot: string;
  workspacePath: string;
  branchName: string | null;
  expectedBranchName: string;
  baseCommit: string | null;
  headCommit: string;
  aheadBy: number | null;
  behindBy: number | null;
  dirty: boolean;
  status: string[];
}

export interface RemoveLocalWorktreeOptions {
  force?: boolean;
  deleteBranch?: boolean;
}

export interface RemoveLocalWorktreeResult {
  worktree: LocalWorktreeMetadata;
  branchDeleted: boolean;
}

export interface ApplyLocalWorktreeResult {
  worktree: LocalWorktreeMetadata;
  appliedCommit: string;
  patchBytes: number;
  cleanupPending: boolean;
}

export interface RetryApplyCleanupResult {
  branchName: string;
  workspacePath: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  cleanupPending: boolean;
}

export interface PruneLocalWorktreesResult {
  prunedPaths: string[];
}

export class LocalWorktreeManager {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  async create(
    projectRoot: string,
    projectId: string,
    threadId: string,
  ): Promise<string> {
    const canonicalProject = await realpath(projectRoot);
    const repositoryRoot = await this.#repositoryRoot(canonicalProject);
    if (repositoryRoot !== canonicalProject) {
      throw new Error(
        "Worktree mode requires selecting the Git repository root as the project.",
      );
    }

    const [initialHead, projectStatus] = await Promise.all([
      this.#git(canonicalProject, "rev-parse", "--verify", "HEAD"),
      this.#git(
        canonicalProject,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    ]);
    if (splitLines(projectStatus.stdout).length > 0) {
      throw new Error(
        "The project has local changes. Commit or stash them before creating a worktree.",
      );
    }

    const baseCommit = initialHead.stdout.trim();
    const [confirmedHeadResult, confirmedStatus] = await Promise.all([
      this.#git(canonicalProject, "rev-parse", "--verify", "HEAD"),
      this.#git(
        canonicalProject,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    ]);
    const confirmedHead = confirmedHeadResult.stdout.trim();
    if (confirmedHead !== baseCommit) {
      throw new Error(
        "The project HEAD changed while creating the worktree. Try again.",
      );
    }
    if (splitLines(confirmedStatus.stdout).length > 0) {
      throw new Error(
        "The project has local changes. Commit or stash them before creating a worktree.",
      );
    }

    const location = await this.#managedLocation(projectId, threadId, true);
    if (!location) {
      throw new Error("The managed worktree root is unavailable.");
    }
    const { target } = location;
    if (await exists(target)) {
      throw new Error("The managed worktree path already exists.");
    }

    const branchName = managedBranchName(projectId, threadId);

    await this.#git(
      canonicalProject,
      "worktree",
      "add",
      "-b",
      branchName,
      target,
      baseCommit,
    );

    try {
      await this.#git(
        canonicalProject,
        "config",
        `branch.${branchName}.baseAgentBase`,
        baseCommit,
      );
      await this.#git(
        canonicalProject,
        "config",
        `branch.${branchName}.baseAgentProjectId`,
        projectId,
      );
      await this.#git(
        canonicalProject,
        "config",
        `branch.${branchName}.baseAgentThreadId`,
        threadId,
      );
    } catch (error) {
      await this.#bestEffortCleanup(
        canonicalProject,
        target,
        branchName,
        baseCommit,
      );
      throw error;
    }

    return realpath(target);
  }

  async inspect(
    projectRoot: string,
    projectId: string,
    threadId: string,
  ): Promise<LocalWorktreeMetadata | null> {
    const canonicalProject = await realpath(projectRoot);
    const repositoryRoot = await this.#repositoryRoot(canonicalProject);
    if (repositoryRoot !== canonicalProject) {
      throw new Error(
        "Worktree mode requires selecting the Git repository root as the project.",
      );
    }

    const location = await this.#managedLocation(projectId, threadId, false);
    if (!location || !(await exists(location.target))) {
      return null;
    }

    const workspacePath = await realpath(location.target);
    assertBelow(location.root, workspacePath);
    await this.#assertSameRepository(canonicalProject, workspacePath);

    const expectedBranchName = managedBranchName(projectId, threadId);
    const branchResult = await this.#gitOptional(
      workspacePath,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    );
    const branchName = branchResult?.stdout.trim() || null;
    const headCommit = (
      await this.#git(workspacePath, "rev-parse", "--verify", "HEAD")
    ).stdout.trim();
    const baseCommit =
      branchName === expectedBranchName
        ? await this.#branchMetadata(
            canonicalProject,
            branchName,
            projectId,
            threadId,
          )
        : null;
    const status = splitLines(
      (
        await this.#git(
          workspacePath,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        )
      ).stdout,
    );
    const distance = baseCommit
      ? parseCommitDistance(
          (
            await this.#git(
              workspacePath,
              "rev-list",
              "--left-right",
              "--count",
              `${baseCommit}...HEAD`,
            )
          ).stdout,
        )
      : null;

    return {
      projectId,
      threadId,
      projectRoot: canonicalProject,
      workspacePath,
      branchName,
      expectedBranchName,
      baseCommit,
      headCommit,
      aheadBy: distance?.aheadBy ?? null,
      behindBy: distance?.behindBy ?? null,
      dirty: status.length > 0,
      status,
    };
  }

  async remove(
    projectRoot: string,
    projectId: string,
    threadId: string,
    options: RemoveLocalWorktreeOptions = {},
  ): Promise<RemoveLocalWorktreeResult> {
    const worktree = await this.inspect(projectRoot, projectId, threadId);
    if (!worktree) {
      throw new Error("The managed worktree does not exist.");
    }
    if (worktree.dirty && !options.force) {
      throw new Error(
        "The managed worktree has uncommitted changes. Pass force explicitly to discard them.",
      );
    }
    if (
      options.deleteBranch &&
      worktree.branchName !== worktree.expectedBranchName
    ) {
      throw new Error(
        "Refusing to delete a branch that is not the expected managed task branch.",
      );
    }

    if (options.deleteBranch && !options.force && worktree.branchName) {
      const merged = await this.#gitOptional(
        worktree.projectRoot,
        "merge-base",
        "--is-ancestor",
        worktree.branchName,
        "HEAD",
      );
      if (!merged) {
        throw new Error(
          "The managed task branch has unmerged commits. Pass force explicitly to discard them.",
        );
      }
    }

    await this.#git(
      worktree.projectRoot,
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      worktree.workspacePath,
    );

    let branchDeleted = false;
    if (options.deleteBranch && worktree.branchName) {
      const branchRef = await this.#branchRef(
        worktree.projectRoot,
        worktree.branchName,
      );
      if (!branchRef || branchRef.stdout.trim() !== worktree.headCommit) {
        throw new Error(
          "The managed task branch changed during removal. The branch was preserved.",
        );
      }
      await this.#git(
        worktree.projectRoot,
        "update-ref",
        "-d",
        `refs/heads/${worktree.branchName}`,
        worktree.headCommit,
      );
      await this.#clearBranchMetadata(
        worktree.projectRoot,
        worktree.branchName,
      );
      branchDeleted = true;
    }

    return { worktree, branchDeleted };
  }

  async apply(
    projectRoot: string,
    projectId: string,
    threadId: string,
  ): Promise<ApplyLocalWorktreeResult> {
    const worktree = await this.inspect(projectRoot, projectId, threadId);
    if (!worktree) {
      throw new Error("The managed worktree does not exist.");
    }
    if (
      worktree.branchName !== worktree.expectedBranchName ||
      !worktree.baseCommit
    ) {
      throw new Error("The managed worktree metadata is invalid.");
    }
    if (worktree.behindBy !== 0) {
      throw new Error(
        "The task branch no longer descends cleanly from its recorded base.",
      );
    }

    const [projectHead, projectStatus] = await Promise.all([
      this.#git(projectRoot, "rev-parse", "--verify", "HEAD"),
      this.#git(
        projectRoot,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    ]);
    if (projectHead.stdout.trim() !== worktree.baseCommit) {
      throw new Error(
        "The project HEAD changed after this task started. Reconcile it before applying the worktree.",
      );
    }
    if (splitLines(projectStatus.stdout).length > 0) {
      throw new Error(
        "The project has local changes. Commit or stash them before applying the worktree.",
      );
    }
    if (hasUnmergedEntries(worktree.status)) {
      throw new Error(
        "The managed worktree has unresolved merge conflicts.",
      );
    }
    await this.#assertNoIgnoredFiles(worktree.workspacePath);

    if (worktree.dirty) {
      await this.#git(worktree.workspacePath, "add", "--all");
      const stagedIsClean = await this.#gitOptional(
        worktree.workspacePath,
        "diff",
        "--cached",
        "--quiet",
      );
      if (!stagedIsClean) {
        await this.#git(
          worktree.workspacePath,
          "-c",
          "user.name=Brace",
          "-c",
          "user.email=brace@localhost",
          "commit",
          "--quiet",
          "--no-gpg-sign",
          "--no-verify",
          "-m",
          `Brace task ${threadId}`,
        );
      }
    }

    const appliedCommit = (
      await this.#git(worktree.workspacePath, "rev-parse", "--verify", "HEAD")
    ).stdout.trim();
    const patch = await this.#taskPatch(
      worktree.workspacePath,
      worktree.baseCommit,
      appliedCommit,
    );
    const patchBytes = Buffer.byteLength(patch);

    if (patchBytes > 0) {
      const [confirmedProjectHead, confirmedProjectStatus] =
        await Promise.all([
          this.#git(projectRoot, "rev-parse", "--verify", "HEAD"),
          this.#git(
            projectRoot,
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ),
        ]);
      if (
        confirmedProjectHead.stdout.trim() !== worktree.baseCommit ||
        splitLines(confirmedProjectStatus.stdout).length > 0
      ) {
        throw new Error(
          "The project changed while preparing the task patch. The worktree was preserved.",
        );
      }

      const temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "brace-apply-"),
      );
      const patchPath = path.join(temporaryDirectory, "task.patch");
      try {
        await writeFile(patchPath, patch, {
          encoding: "utf8",
          mode: 0o600,
        });
        await this.#git(projectRoot, "apply", "--check", "--", patchPath);
        await this.#git(projectRoot, "apply", "--", patchPath);
        await this.#git(
          projectRoot,
          "apply",
          "--reverse",
          "--check",
          "--",
          patchPath,
        );
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }

    let cleanupPending = false;
    try {
      const cleanup = await this.retryApplyCleanup(
        projectRoot,
        projectId,
        threadId,
        appliedCommit,
      );
      cleanupPending = cleanup.cleanupPending;
    } catch {
      // The project patch is already applied at this point. Report cleanup
      // separately so the caller never misrepresents a successful apply as a
      // failed operation that is safe to retry.
      cleanupPending = true;
    }
    return { worktree, appliedCommit, patchBytes, cleanupPending };
  }

  async retryApplyCleanup(
    projectRoot: string,
    projectId: string,
    threadId: string,
    appliedCommit: string,
  ): Promise<RetryApplyCleanupResult> {
    if (!/^[0-9a-f]{40,64}$/u.test(appliedCommit)) {
      throw new Error("The applied commit identifier is invalid.");
    }

    const canonicalProject = await realpath(projectRoot);
    const repositoryRoot = await this.#repositoryRoot(canonicalProject);
    if (repositoryRoot !== canonicalProject) {
      throw new Error(
        "Worktree mode requires selecting the Git repository root as the project.",
      );
    }

    const location = await this.#managedLocation(projectId, threadId, false);
    const branchName = managedBranchName(projectId, threadId);
    const workspacePath =
      location?.target ??
      path.join(this.#root, safeSegment(projectId), safeSegment(threadId));
    const entries = parseWorktreeList(
      (
        await this.#git(
          canonicalProject,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        )
      ).stdout,
    );
    const registered = entries.some(
      (entry) => path.resolve(entry.path) === path.resolve(workspacePath),
    );
    const workspaceExists = await exists(workspacePath);
    const branchRef = await this.#branchRef(canonicalProject, branchName);

    if (!branchRef) {
      if (registered || workspaceExists) {
        throw new Error(
          "The managed worktree still exists but its expected task branch is missing. It was preserved.",
        );
      }
      const metadata = await this.#branchMetadata(
        canonicalProject,
        branchName,
        projectId,
        threadId,
      );
      const cleanupPending = metadata
        ? !(await this.#clearBranchMetadata(canonicalProject, branchName))
        : false;
      return {
        branchName,
        workspacePath,
        worktreeRemoved: false,
        branchDeleted: false,
        cleanupPending,
      };
    }

    if (branchRef.stdout.trim() !== appliedCommit) {
      throw new Error(
        "The task branch changed after it was applied. Cleanup was refused to preserve the newer work.",
      );
    }
    const baseCommit = await this.#branchMetadata(
      canonicalProject,
      branchName,
      projectId,
      threadId,
    );
    if (!baseCommit) {
      throw new Error(
        "The managed task branch metadata is invalid. Cleanup was refused.",
      );
    }
    const appliedPatch = await this.#taskPatch(
      canonicalProject,
      baseCommit,
      appliedCommit,
    );
    if (Buffer.byteLength(appliedPatch) > 0) {
      const temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "brace-cleanup-"),
      );
      const patchPath = path.join(temporaryDirectory, "task.patch");
      try {
        await writeFile(patchPath, appliedPatch, {
          encoding: "utf8",
          mode: 0o600,
        });
        await this.#git(
          canonicalProject,
          "apply",
          "--reverse",
          "--check",
          "--",
          patchPath,
        );
      } catch {
        throw new Error(
          "The applied task changes are no longer present in the project. Cleanup was refused.",
        );
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }

    if (workspaceExists) {
      if (!registered) {
        throw new Error(
          "The managed path is no longer registered as a Git worktree. Cleanup was refused.",
        );
      }
      const current = await this.inspect(
        canonicalProject,
        projectId,
        threadId,
      );
      if (
        !current ||
        current.branchName !== branchName ||
        current.headCommit !== appliedCommit
      ) {
        throw new Error(
          "The managed worktree changed after it was applied. Cleanup was refused.",
        );
      }
      if (current.dirty) {
        throw new Error(
          "The managed worktree has new local changes. Cleanup was refused to preserve them.",
        );
      }
      await this.#assertNoIgnoredFiles(current.workspacePath);
    }

    let worktreeRemoved = false;
    if (registered) {
      try {
        await this.#git(
          canonicalProject,
          "worktree",
          "remove",
          workspacePath,
        );
        worktreeRemoved = true;
      } catch {
        return {
          branchName,
          workspacePath,
          worktreeRemoved: false,
          branchDeleted: false,
          cleanupPending: true,
        };
      }
    }

    const confirmedBranchRef = await this.#branchRef(
      canonicalProject,
      branchName,
    );
    if (!confirmedBranchRef) {
      const cleanupPending = !(await this.#clearBranchMetadata(
        canonicalProject,
        branchName,
      ));
      return {
        branchName,
        workspacePath,
        worktreeRemoved,
        branchDeleted: false,
        cleanupPending,
      };
    }
    if (confirmedBranchRef.stdout.trim() !== appliedCommit) {
      throw new Error(
        "The task branch changed during cleanup. The branch was preserved.",
      );
    }

    try {
      await this.#git(
        canonicalProject,
        "update-ref",
        "-d",
        `refs/heads/${branchName}`,
        appliedCommit,
      );
    } catch {
      return {
        branchName,
        workspacePath,
        worktreeRemoved,
        branchDeleted: false,
        cleanupPending: true,
      };
    }
    const metadataCleared = await this.#clearBranchMetadata(
      canonicalProject,
      branchName,
    );
    return {
      branchName,
      workspacePath,
      worktreeRemoved,
      branchDeleted: true,
      cleanupPending: !metadataCleared,
    };
  }

  async prune(projectRoot: string): Promise<PruneLocalWorktreesResult> {
    const canonicalProject = await realpath(projectRoot);
    const repositoryRoot = await this.#repositoryRoot(canonicalProject);
    if (repositoryRoot !== canonicalProject) {
      throw new Error(
        "Worktree mode requires selecting the Git repository root as the project.",
      );
    }

    const managedRoot = await this.#ensureManagedRoot();
    const entries = parseWorktreeList(
      (
        await this.#git(
          canonicalProject,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        )
      ).stdout,
    );
    const prunedPaths = entries
      .filter((entry) => entry.prunable)
      .map((entry) => path.resolve(entry.path));

    for (const target of prunedPaths) {
      assertBelow(managedRoot, target);
    }

    if (prunedPaths.length > 0) {
      await this.#git(
        canonicalProject,
        "worktree",
        "prune",
        "--expire",
        "now",
      );
    }
    return { prunedPaths };
  }

  async #managedLocation(
    projectId: string,
    threadId: string,
    createParent: boolean,
  ): Promise<{ root: string; target: string } | null> {
    const safeProjectId = safeSegment(projectId);
    const safeThreadId = safeSegment(threadId);
    if (!createParent && !(await exists(this.#root))) {
      return null;
    }

    const root = createParent
      ? await this.#ensureManagedRoot()
      : await realpath(this.#root);
    const requestedParent = path.join(root, safeProjectId);
    if (createParent) {
      await mkdir(requestedParent, { recursive: true });
    } else if (!(await exists(requestedParent))) {
      return { root, target: path.join(requestedParent, safeThreadId) };
    }

    const parent = await realpath(requestedParent);
    assertBelow(root, parent);
    const target = path.join(parent, safeThreadId);
    assertBelow(root, target);
    return { root, target };
  }

  async #ensureManagedRoot(): Promise<string> {
    await mkdir(this.#root, { recursive: true });
    return realpath(this.#root);
  }

  async #branchMetadata(
    projectRoot: string,
    branchName: string,
    projectId: string,
    threadId: string,
  ): Promise<string | null> {
    const [base, storedProject, storedThread] = await Promise.all([
      this.#gitOptional(
        projectRoot,
        "config",
        "--get",
        `branch.${branchName}.baseAgentBase`,
      ),
      this.#gitOptional(
        projectRoot,
        "config",
        "--get",
        `branch.${branchName}.baseAgentProjectId`,
      ),
      this.#gitOptional(
        projectRoot,
        "config",
        "--get",
        `branch.${branchName}.baseAgentThreadId`,
      ),
    ]);
    if (
      !base ||
      storedProject?.stdout.trim() !== projectId ||
      storedThread?.stdout.trim() !== threadId
    ) {
      return null;
    }
    return base.stdout.trim() || null;
  }

  async #branchRef(
    projectRoot: string,
    branchName: string,
  ): Promise<GitResult | null> {
    return this.#runGit(
      projectRoot,
      [
        "show-ref",
        "--verify",
        "--hash",
        `refs/heads/${branchName}`,
      ],
      [1, 128],
    );
  }

  async #clearBranchMetadata(
    projectRoot: string,
    branchName: string,
  ): Promise<boolean> {
    try {
      await this.#runGit(
        projectRoot,
        ["config", "--remove-section", `branch.${branchName}`],
        [5],
      );
      return true;
    } catch {
      return false;
    }
  }

  async #assertNoIgnoredFiles(workspacePath: string): Promise<void> {
    const ignored = (
      await this.#gitWithLimit(
        workspacePath,
        MAX_GIT_OUTPUT_BYTES,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      )
    ).stdout
      .split("\0")
      .filter(Boolean);
    if (ignored.length > 0) {
      throw new Error(
        `The managed worktree contains ignored files (for example ${JSON.stringify(ignored[0])}). Move or remove them before applying; the worktree was preserved.`,
      );
    }
  }

  async #taskPatch(
    repositoryPath: string,
    baseCommit: string,
    appliedCommit: string,
  ): Promise<string> {
    const rawChanges = (
      await this.#git(
        repositoryPath,
        "diff",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "-z",
        baseCommit,
        appliedCommit,
      )
    ).stdout;
    if (hasGitlinkChanges(rawChanges)) {
      throw new Error(
        "Applying task branches with submodule or gitlink changes is not supported. The worktree was preserved.",
      );
    }
    return (
      await this.#gitWithLimit(
        repositoryPath,
        MAX_PATCH_BYTES,
        "diff",
        "--binary",
        "--full-index",
        baseCommit,
        appliedCommit,
      )
    ).stdout;
  }

  async #assertSameRepository(
    projectRoot: string,
    workspacePath: string,
  ): Promise<void> {
    const [projectGitDir, workspaceGitDir] = await Promise.all([
      this.#commonGitDirectory(projectRoot),
      this.#commonGitDirectory(workspacePath),
    ]);
    if (projectGitDir !== workspaceGitDir) {
      throw new Error(
        "The managed worktree path does not belong to the selected repository.",
      );
    }
  }

  async #commonGitDirectory(cwd: string): Promise<string> {
    const output = (
      await this.#git(cwd, "rev-parse", "--git-common-dir")
    ).stdout.trim();
    return realpath(path.isAbsolute(output) ? output : path.resolve(cwd, output));
  }

  async #repositoryRoot(cwd: string): Promise<string> {
    const result = await this.#git(cwd, "rev-parse", "--show-toplevel");
    return realpath(result.stdout.trim());
  }

  async #git(cwd: string, ...args: string[]): Promise<GitResult> {
    const result = await this.#runGit(cwd, args);
    if (!result) {
      throw new Error("Git worktree operation failed.");
    }
    return result;
  }

  async #gitWithLimit(
    cwd: string,
    maxBuffer: number,
    ...args: string[]
  ): Promise<GitResult> {
    const result = await this.#runGit(cwd, args, [], maxBuffer);
    if (!result) {
      throw new Error("Git worktree operation failed.");
    }
    return result;
  }

  async #gitOptional(
    cwd: string,
    ...args: string[]
  ): Promise<GitResult | null> {
    return this.#runGit(cwd, args, [1]);
  }

  async #runGit(
    cwd: string,
    args: string[],
    allowedExitCodes: number[] = [],
    maxBuffer = MAX_GIT_OUTPUT_BYTES,
  ): Promise<GitResult | null> {
    try {
      const result = await execFileAsync(
        "git",
        [
          "--no-pager",
          "-c",
          "color.ui=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        {
          cwd,
          encoding: "utf8",
          maxBuffer,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
          env: {
            NODE_ENV: process.env.NODE_ENV ?? "production",
            PATH: process.env.PATH,
            LANG: "C",
            LC_ALL: "C",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        },
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (
        isExecFileError(error) &&
        typeof error.code === "number" &&
        allowedExitCodes.includes(error.code)
      ) {
        return null;
      }
      throw new Error("Git worktree operation failed.", { cause: error });
    }
  }

  async #bestEffortCleanup(
    projectRoot: string,
    target: string,
    branchName: string,
    baseCommit: string,
  ): Promise<void> {
    let worktreeRemoved = false;
    try {
      await this.#git(projectRoot, "worktree", "remove", target);
      worktreeRemoved = true;
    } catch {
      // Preserve the original setup error.
    }
    if (!worktreeRemoved) {
      return;
    }
    let branchDeleted = false;
    try {
      await this.#git(
        projectRoot,
        "update-ref",
        "-d",
        `refs/heads/${branchName}`,
        baseCommit,
      );
      branchDeleted = true;
    } catch {
      // Preserve the original setup error.
    }
    if (branchDeleted) {
      await this.#clearBranchMetadata(projectRoot, branchName);
    }
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Invalid managed worktree identifier.");
  }
  return value;
}

function managedBranchName(projectId: string, threadId: string): string {
  return `${BRANCH_PREFIX}/${safeSegment(projectId)}/${safeSegment(threadId)}`;
}

function assertBelow(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Managed worktree path escapes the configured root.");
  }
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function hasUnmergedEntries(status: readonly string[]): boolean {
  return status.some((entry) => {
    const code = entry.slice(0, 2);
    return (
      code === "DD" ||
      code === "AU" ||
      code === "UD" ||
      code === "UA" ||
      code === "DU" ||
      code === "AA" ||
      code === "UU"
    );
  });
}

function hasGitlinkChanges(rawChanges: string): boolean {
  return rawChanges.split("\0").some((record) => {
    const modes = /^:(\d{6}) (\d{6}) /u.exec(record);
    return modes?.[1] === "160000" || modes?.[2] === "160000";
  });
}

function parseCommitDistance(value: string): {
  aheadBy: number;
  behindBy: number;
} {
  const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(value);
  if (!match) {
    throw new Error("Git returned an invalid worktree commit distance.");
  }
  return {
    behindBy: Number(match[1]),
    aheadBy: Number(match[2]),
  };
}

function parseWorktreeList(
  value: string,
): Array<{ path: string; prunable: boolean }> {
  return value
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\0");
      const worktree = fields.find((field) => field.startsWith("worktree "));
      if (!worktree) {
        throw new Error("Git returned an invalid worktree list.");
      }
      return {
        path: worktree.slice("worktree ".length),
        prunable: fields.some(
          (field) => field === "prunable" || field.startsWith("prunable "),
        ),
      };
    });
}

interface GitResult {
  stdout: string;
  stderr: string;
}

function isExecFileError(
  error: unknown,
): error is Error & { code?: number | string } {
  return error instanceof Error && "code" in error;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
