import { z } from "zod";

import type {
  SandboxPort,
  SandboxRunResult,
} from "../../sandbox/types";
import { AgentToolError } from "../types";
import type { CodingTool } from "./tools";

const gitCwdSchema = z
  .object({ cwd: z.string().min(1).max(4_096).default(".") })
  .strict();
const GIT_STATUS_ARGS = Object.freeze([
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "status",
  "--short",
  "--branch",
  "--untracked-files=all",
]);
const GIT_DIFF_ARGS = Object.freeze([
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--",
]);
const GIT_STAGED_DIFF_ARGS = Object.freeze([
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "diff",
  "--cached",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--",
]);
const GIT_UNTRACKED_ARGS = Object.freeze([
  "--no-pager",
  "--no-optional-locks",
  "-c",
  "color.ui=false",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--",
]);

export interface GitStatusResult {
  readonly cwd: string;
  readonly status: string;
  readonly stderr: string;
}

export interface GitDiffResult {
  readonly cwd: string;
  readonly diff: string;
  readonly stderr: string;
}

export function createGitStatusTool(
  sandbox: SandboxPort,
): CodingTool<z.infer<typeof gitCwdSchema>, GitStatusResult> {
  return {
    name: "git_status",
    description:
      "Read concise Git working-tree status in a workspace-relative directory. The Git subcommand and options are fixed; arbitrary arguments and revisions are not accepted.",
    schema: gitCwdSchema,
    annotations: Object.freeze({
      effect: "execute",
      idempotent: true,
      requiresApproval: true,
      concurrencyKey: "coding-workspace",
    }),
    async execute(input, context) {
      const result = await runFixedGit(
        sandbox,
        "git_status",
        GIT_STATUS_ARGS,
        input.cwd,
        context.signal,
      );
      return { cwd: result.cwd, status: result.stdout, stderr: result.stderr };
    },
  };
}

export function createGitDiffTool(
  sandbox: SandboxPort,
): CodingTool<z.infer<typeof gitCwdSchema>, GitDiffResult> {
  return {
    name: "git_diff",
    description:
      "Read all unstaged, staged, and untracked Git working-tree changes in a workspace-relative directory. The Git subcommands and options are fixed; arbitrary arguments, paths, and revisions are not accepted.",
    schema: gitCwdSchema,
    annotations: Object.freeze({
      effect: "execute",
      idempotent: true,
      requiresApproval: true,
      concurrencyKey: "coding-workspace",
    }),
    async execute(input, context) {
      return readGitWorkspaceDiff(sandbox, input.cwd, context.signal);
    },
  };
}

export function createGitTools(sandbox: SandboxPort): readonly CodingTool[] {
  return [createGitStatusTool(sandbox), createGitDiffTool(sandbox)];
}

export async function readGitWorkspaceDiff(
  sandbox: SandboxPort,
  cwd: string,
  signal?: AbortSignal,
): Promise<GitDiffResult> {
  const [unstaged, staged, untracked] = await Promise.all([
    runFixedGit(sandbox, "git_diff", GIT_DIFF_ARGS, cwd, signal),
    runFixedGit(sandbox, "git_diff", GIT_STAGED_DIFF_ARGS, cwd, signal),
    runFixedGit(sandbox, "git_diff", GIT_UNTRACKED_ARGS, cwd, signal),
  ]);
  const sections: string[] = [];
  appendSection(sections, "Unstaged changes", unstaged.stdout);
  appendSection(sections, "Staged changes", staged.stdout);

  const untrackedPaths = untracked.stdout
    .split("\0")
    .filter((entry) => entry.length > 0);
  if (untrackedPaths.length > 0) {
    sections.push(
      `### Untracked files\n${untrackedPaths
        .map((entry) => `?? ${formatGitPath(entry)}`)
        .join("\n")}`,
    );
  }

  return {
    cwd: unstaged.cwd,
    diff: sections.join("\n\n"),
    stderr: [unstaged.stderr, staged.stderr, untracked.stderr]
      .filter((entry) => entry.length > 0)
      .join("\n"),
  };
}

async function runFixedGit(
  sandbox: SandboxPort,
  toolName: "git_status" | "git_diff",
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<SandboxRunResult> {
  const result = await sandbox.run({
    executable: "git",
    args,
    cwd,
    signal,
  });
  if (result.terminationReason !== "exit") {
    throw new AgentToolError(
      `${toolName} was terminated: ${result.terminationReason}.`,
      result.terminationReason === "timeout",
      { terminationReason: result.terminationReason },
    );
  }
  if (result.exitCode !== 0) {
    throw new AgentToolError(
      `${toolName} requires a valid Git working tree.`,
      false,
      { exitCode: result.exitCode },
    );
  }
  return result;
}

function appendSection(
  sections: string[],
  title: string,
  content: string,
): void {
  const normalized = content.trimEnd();
  if (normalized) sections.push(`### ${title}\n${normalized}`);
}

function formatGitPath(value: string): string {
  return /^[^\u0000-\u001f\u007f]+$/.test(value)
    ? value
    : JSON.stringify(value);
}
