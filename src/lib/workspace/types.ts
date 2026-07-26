export type WorkspaceErrorCode =
  | "ABORTED"
  | "ACCESS_DENIED"
  | "CONFLICT"
  | "FILE_TOO_LARGE"
  | "INVALID_PATH"
  | "IO_ERROR"
  | "NOT_DIRECTORY"
  | "NOT_FILE"
  | "NOT_FOUND"
  | "OUTPUT_TOO_LARGE"
  | "SYMLINK_NOT_ALLOWED"
  | "UNSUPPORTED_FILE";

export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
    readonly workspacePath?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceError";
  }
}

export type WorkspaceEntryKind = "directory" | "file" | "symlink";

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  readonly size?: number;
}

export interface ListWorkspaceFilesInput {
  readonly path?: string;
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly signal?: AbortSignal;
}

export interface ListWorkspaceFilesResult {
  readonly path: string;
  readonly entries: readonly WorkspaceEntry[];
  readonly truncated: boolean;
}

export interface ReadWorkspaceFileInput {
  readonly path: string;
  readonly signal?: AbortSignal;
}

export interface ReadWorkspaceFileResult {
  readonly path: string;
  readonly content: string;
  readonly size: number;
}

export interface SearchWorkspaceInput {
  readonly path?: string;
  readonly query: string;
  readonly caseSensitive?: boolean;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceSearchMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export interface SearchWorkspaceResult {
  readonly path: string;
  readonly query: string;
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly filesScanned: number;
  readonly truncated: boolean;
}

export interface ApplyWorkspacePatchInput {
  readonly path: string;
  /** Null means that the target must not exist. Otherwise it must match exactly. */
  readonly expectedContent: string | null;
  readonly newContent: string;
  readonly signal?: AbortSignal;
}

export interface ApplyWorkspacePatchResult {
  readonly path: string;
  readonly created: boolean;
  readonly bytesWritten: number;
}

export interface DeleteWorkspaceFileInput {
  readonly path: string;
  readonly expectedContent: string;
  readonly signal?: AbortSignal;
}

export interface DeleteWorkspaceFileResult {
  readonly path: string;
  readonly deleted: true;
}

export interface MoveWorkspaceFileInput {
  readonly fromPath: string;
  readonly toPath: string;
  readonly expectedContent: string;
  readonly signal?: AbortSignal;
}

export interface MoveWorkspaceFileResult {
  readonly fromPath: string;
  readonly toPath: string;
}

/**
 * Environment-neutral workspace capability used by coding tools. Implementations
 * own path confinement, file limits, atomicity, and cancellation semantics.
 */
export interface WorkspacePort {
  /** Canonical server-side root. Tools must never expose this value to the model. */
  readonly root: string;
  listFiles(input?: ListWorkspaceFilesInput): Promise<ListWorkspaceFilesResult>;
  readFile(input: ReadWorkspaceFileInput): Promise<ReadWorkspaceFileResult>;
  search(input: SearchWorkspaceInput): Promise<SearchWorkspaceResult>;
  applyPatch(input: ApplyWorkspacePatchInput): Promise<ApplyWorkspacePatchResult>;
  deleteFile(input: DeleteWorkspaceFileInput): Promise<DeleteWorkspaceFileResult>;
  moveFile(input: MoveWorkspaceFileInput): Promise<MoveWorkspaceFileResult>;
}
