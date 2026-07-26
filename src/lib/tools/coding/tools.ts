import { z } from "zod";

import type { AgentTool, ToolAnnotations } from "../types";
import type {
  ApplyWorkspacePatchResult,
  DeleteWorkspaceFileResult,
  ListWorkspaceFilesResult,
  MoveWorkspaceFileResult,
  ReadWorkspaceFileResult,
  SearchWorkspaceResult,
  WorkspacePort,
} from "../../workspace/types";

const toolPath = z.string().min(1).max(4_096);
const listFilesSchema = z
  .object({
    path: toolPath.default("."),
    maxDepth: z.number().int().min(1).max(32).default(4),
    maxEntries: z.number().int().min(1).max(1_000).default(200),
  })
  .strict();
const searchCodeSchema = z
  .object({
    query: z.string().min(1).max(1_000),
    path: toolPath.default("."),
    caseSensitive: z.boolean().default(false),
    maxResults: z.number().int().min(1).max(500).default(50),
  })
  .strict();
const readFileSchema = z.object({ path: toolPath }).strict();
const applyPatchSchema = z
  .object({
    path: toolPath,
    expectedContent: z.string().max(2_000_000).nullable(),
    newContent: z.string().max(2_000_000),
  })
  .strict();
const deleteFileSchema = z
  .object({
    path: toolPath,
    expectedContent: z.string().max(2_000_000),
  })
  .strict();
const moveFileSchema = z
  .object({
    fromPath: toolPath,
    toPath: toolPath,
    expectedContent: z.string().max(2_000_000),
  })
  .strict();

export type CodingTool<TInput = unknown, TOutput = unknown> = AgentTool<
  TInput,
  TOutput
> & {
  readonly annotations: ToolAnnotations;
};

const READ_ANNOTATIONS: ToolAnnotations = Object.freeze({
  effect: "read",
  idempotent: true,
});
const WRITE_ANNOTATIONS: ToolAnnotations = Object.freeze({
  effect: "write",
  idempotent: false,
  requiresApproval: true,
  concurrencyKey: "coding-workspace",
});

export function createListFilesTool(
  workspace: WorkspacePort,
): CodingTool<z.infer<typeof listFilesSchema>, ListWorkspaceFilesResult> {
  return {
    name: "list_files",
    description:
      "List files and directories below a workspace-relative path. Absolute paths, parent traversal, and symbolic-link traversal are rejected.",
    schema: listFilesSchema,
    annotations: READ_ANNOTATIONS,
    execute(input, context) {
      return workspace.listFiles({ ...input, signal: context.signal });
    },
  };
}

export function createSearchCodeTool(
  workspace: WorkspacePort,
): CodingTool<z.infer<typeof searchCodeSchema>, SearchWorkspaceResult> {
  return {
    name: "search_code",
    description:
      "Search UTF-8 text files for a literal string inside the workspace. Results contain workspace-relative paths and line/column positions.",
    schema: searchCodeSchema,
    annotations: READ_ANNOTATIONS,
    execute(input, context) {
      return workspace.search({ ...input, signal: context.signal });
    },
  };
}

export function createReadFileTool(
  workspace: WorkspacePort,
): CodingTool<z.infer<typeof readFileSchema>, ReadWorkspaceFileResult> {
  return {
    name: "read_file",
    description:
      "Read one UTF-8 text file using a workspace-relative path. Binary, oversized, absolute, escaping, and symbolic-link paths are rejected.",
    schema: readFileSchema,
    annotations: READ_ANNOTATIONS,
    execute(input, context) {
      return workspace.readFile({ ...input, signal: context.signal });
    },
  };
}

export function createApplyPatchTool(
  workspace: WorkspacePort,
): CodingTool<z.infer<typeof applyPatchSchema>, ApplyWorkspacePatchResult> {
  return {
    name: "apply_patch",
    description:
      "Atomically replace a UTF-8 text file. expectedContent must exactly match the current file; use null only to create a file that does not exist.",
    schema: applyPatchSchema,
    annotations: WRITE_ANNOTATIONS,
    execute(input, context) {
      return workspace.applyPatch({ ...input, signal: context.signal });
    },
  };
}

export function createDeleteFileTool(
  workspace: WorkspacePort,
): CodingTool<z.infer<typeof deleteFileSchema>, DeleteWorkspaceFileResult> {
  return {
    name: "delete_file",
    description:
      "Delete one UTF-8 text file after expectedContent exactly matches its current content. Directories, symbolic links, and sensitive paths are rejected.",
    schema: deleteFileSchema,
    annotations: WRITE_ANNOTATIONS,
    execute(input, context) {
      return workspace.deleteFile({ ...input, signal: context.signal });
    },
  };
}

export function createMoveFileTool(
  workspace: WorkspacePort,
): CodingTool<z.infer<typeof moveFileSchema>, MoveWorkspaceFileResult> {
  return {
    name: "move_file",
    description:
      "Move or rename one UTF-8 text file after expectedContent exactly matches its current content. The destination must not exist.",
    schema: moveFileSchema,
    annotations: WRITE_ANNOTATIONS,
    execute(input, context) {
      return workspace.moveFile({ ...input, signal: context.signal });
    },
  };
}

export function createCodingTools(workspace: WorkspacePort): readonly CodingTool[] {
  return [
    createListFilesTool(workspace),
    createSearchCodeTool(workspace),
    createReadFileTool(workspace),
    createApplyPatchTool(workspace),
    createDeleteFileTool(workspace),
    createMoveFileTool(workspace),
  ];
}
