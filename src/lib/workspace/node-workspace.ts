import { constants, type Stats } from "node:fs";
import {
  lstat,
  link,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  ApplyWorkspacePatchInput,
  ApplyWorkspacePatchResult,
  DeleteWorkspaceFileInput,
  DeleteWorkspaceFileResult,
  ListWorkspaceFilesInput,
  ListWorkspaceFilesResult,
  MoveWorkspaceFileInput,
  MoveWorkspaceFileResult,
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  SearchWorkspaceInput,
  SearchWorkspaceResult,
  WorkspaceEntry,
  WorkspacePort,
  WorkspaceSearchMatch,
} from "./types";
import { WorkspaceError } from "./types";

const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_SEARCH_FILES = 2_000;
const DEFAULT_IGNORED_DIRECTORIES = new Set([".git", ".next", "node_modules"]);
const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".aws",
  ".azure",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
]);
const SENSITIVE_FILE_NAMES = new Set([".netrc", ".npmrc", ".pypirc"]);

export interface NodeWorkspaceOptions {
  readonly root: string;
  readonly maxFileBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxEntries?: number;
  readonly maxSearchFiles?: number;
  readonly ignoredDirectories?: readonly string[];
  /** Trusted local opt-in. Never enable for an untrusted or remote model. */
  readonly allowSensitivePaths?: boolean;
}

interface ResolvedWorkspacePath {
  readonly absolute: string;
  readonly relative: string;
  readonly stats: Stats | null;
}

interface NormalizedWorkspacePath {
  readonly relative: string;
  readonly segments: readonly string[];
}

export class NodeWorkspace implements WorkspacePort {
  readonly root: string;
  readonly #maxFileBytes: number;
  readonly #maxOutputBytes: number;
  readonly #maxEntries: number;
  readonly #maxSearchFiles: number;
  readonly #ignoredDirectories: ReadonlySet<string>;
  readonly #allowSensitivePaths: boolean;
  readonly #writeLocks = new Map<string, Promise<void>>();

  private constructor(root: string, options: NodeWorkspaceOptions) {
    this.root = root;
    this.#maxFileBytes = positiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    );
    this.#maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.#maxEntries = positiveInteger(
      options.maxEntries ?? DEFAULT_MAX_ENTRIES,
      "maxEntries",
    );
    this.#maxSearchFiles = positiveInteger(
      options.maxSearchFiles ?? DEFAULT_MAX_SEARCH_FILES,
      "maxSearchFiles",
    );
    this.#ignoredDirectories = new Set(
      options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES,
    );
    this.#allowSensitivePaths = options.allowSensitivePaths ?? false;
  }

  static async create(options: NodeWorkspaceOptions): Promise<NodeWorkspace> {
    const configuredRoot = path.resolve(options.root);
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(configuredRoot);
      const rootStats = await stat(canonicalRoot);
      if (!rootStats.isDirectory()) {
        throw new WorkspaceError(
          "NOT_DIRECTORY",
          "Workspace root must be a directory.",
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw filesystemError(error, ".", "Workspace root is not available.");
    }
    return new NodeWorkspace(canonicalRoot, options);
  }

  async listFiles(
    input: ListWorkspaceFilesInput = {},
  ): Promise<ListWorkspaceFilesResult> {
    const signal = input.signal;
    throwIfAborted(signal);
    const start = await this.#resolve(input.path ?? ".", {
      allowRoot: true,
      allowMissingLeaf: false,
    });
    if (!start.stats?.isDirectory()) {
      throw new WorkspaceError(
        "NOT_DIRECTORY",
        `Workspace path is not a directory: ${start.relative}`,
        start.relative,
      );
    }

    const maxDepth = boundedInteger(input.maxDepth, 4, 1, 32, "maxDepth");
    const maxEntries = Math.min(
      boundedInteger(
        input.maxEntries,
        Math.min(200, this.#maxEntries),
        1,
        this.#maxEntries,
        "maxEntries",
      ),
      this.#maxEntries,
    );
    const entries: WorkspaceEntry[] = [];
    let truncated = false;
    this.#assertOutputSize(
      { path: start.relative, entries: [], truncated: false },
      start.relative,
    );

    const visit = async (absoluteDirectory: string, depth: number): Promise<void> => {
      if (truncated || depth > maxDepth) return;
      throwIfAborted(signal);
      let children;
      try {
        children = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        throw filesystemError(error, this.#displayPath(absoluteDirectory));
      }
      children.sort((left, right) => left.name.localeCompare(right.name));

      for (const child of children) {
        throwIfAborted(signal);
        const absoluteChild = path.join(absoluteDirectory, child.name);
        const relativeChild = this.#displayPath(absoluteChild);
        if (this.#isSensitivePath(relativeChild)) continue;
        let childStats: Stats;
        try {
          childStats = await lstat(absoluteChild);
        } catch (error) {
          throw filesystemError(error, relativeChild);
        }

        const entry: WorkspaceEntry = childStats.isSymbolicLink()
          ? { path: relativeChild, kind: "symlink" }
          : childStats.isDirectory()
            ? { path: relativeChild, kind: "directory" }
            : childStats.isFile()
              ? { path: relativeChild, kind: "file", size: childStats.size }
              : { path: relativeChild, kind: "file", size: childStats.size };
        if (
          entries.length >= maxEntries
          || serializedBytes({
            path: start.relative,
            entries: [...entries, entry],
            truncated: false,
          }) > this.#maxOutputBytes
        ) {
          truncated = true;
          return;
        }
        entries.push(entry);

        if (
          childStats.isDirectory()
          && depth < maxDepth
          && !this.#ignoredDirectories.has(child.name)
        ) {
          await visit(absoluteChild, depth + 1);
          if (truncated) return;
        }
      }
    };

    await visit(start.absolute, 1);
    const result = { path: start.relative, entries, truncated };
    this.#assertOutputSize(result, start.relative);
    return result;
  }

  async readFile(input: ReadWorkspaceFileInput): Promise<ReadWorkspaceFileResult> {
    throwIfAborted(input.signal);
    const resolved = await this.#resolve(input.path, {
      allowRoot: false,
      allowMissingLeaf: false,
    });
    const buffer = await this.#readRegularFile(resolved, input.signal);
    if (buffer.byteLength > this.#maxOutputBytes) {
      throw new WorkspaceError(
        "OUTPUT_TOO_LARGE",
        `Workspace file exceeds the ${this.#maxOutputBytes}-byte output limit: ${resolved.relative}`,
        resolved.relative,
      );
    }
    const result = {
      path: resolved.relative,
      content: decodeText(buffer, resolved.relative),
      size: buffer.byteLength,
    };
    this.#assertOutputSize(result, resolved.relative);
    return result;
  }

  async search(input: SearchWorkspaceInput): Promise<SearchWorkspaceResult> {
    const signal = input.signal;
    throwIfAborted(signal);
    const query = input.query;
    if (!query) {
      throw new WorkspaceError("INVALID_PATH", "Search query must not be empty.");
    }
    const start = await this.#resolve(input.path ?? ".", {
      allowRoot: true,
      allowMissingLeaf: false,
    });
    const maxResults = boundedInteger(input.maxResults, 50, 1, 500, "maxResults");
    const needle = input.caseSensitive ? query : query.toLocaleLowerCase();
    const matches: WorkspaceSearchMatch[] = [];
    let filesScanned = 0;
    let truncated = false;
    this.#assertOutputSize(
      {
        path: start.relative,
        query,
        matches: [],
        filesScanned: this.#maxSearchFiles,
        truncated: false,
      },
      start.relative,
    );

    for await (const file of this.#walkFiles(start, signal)) {
      throwIfAborted(signal);
      if (filesScanned >= this.#maxSearchFiles) {
        truncated = true;
        break;
      }
      filesScanned += 1;
      if (!file.stats || file.stats.size > this.#maxFileBytes) continue;

      let buffer: Buffer;
      try {
        buffer = await this.#readRegularFile(file, signal);
      } catch (error) {
        if (
          error instanceof WorkspaceError
          && (error.code === "FILE_TOO_LARGE" || error.code === "UNSUPPORTED_FILE")
        ) {
          continue;
        }
        throw error;
      }
      if (isProbablyBinary(buffer)) continue;

      let content: string;
      try {
        content = decodeText(buffer, file.relative);
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "UNSUPPORTED_FILE") continue;
        throw error;
      }
      const lines = content.split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const haystack = input.caseSensitive
          ? lines[lineIndex]
          : lines[lineIndex].toLocaleLowerCase();
        let from = 0;
        while (from <= haystack.length) {
          const column = haystack.indexOf(needle, from);
          if (column < 0) break;
          const match: WorkspaceSearchMatch = {
            path: file.relative,
            line: lineIndex + 1,
            column: column + 1,
            preview: previewLine(lines[lineIndex]),
          };
          if (
            matches.length >= maxResults
            || serializedBytes({
              path: start.relative,
              query,
              matches: [...matches, match],
              filesScanned: this.#maxSearchFiles,
              truncated: false,
            }) > this.#maxOutputBytes
          ) {
            truncated = true;
            break;
          }
          matches.push(match);
          from = column + Math.max(needle.length, 1);
        }
        if (truncated) break;
      }
      if (truncated) break;
    }

    const result = {
      path: start.relative,
      query,
      matches,
      filesScanned,
      truncated,
    };
    this.#assertOutputSize(result, start.relative);
    return result;
  }

  async applyPatch(input: ApplyWorkspacePatchInput): Promise<ApplyWorkspacePatchResult> {
    throwIfAborted(input.signal);
    const normalized = normalizeWorkspacePath(input.path, false);
    const absolute = this.#absolutePath(normalized);
    return this.#withWriteLock(absolute, async () => {
      throwIfAborted(input.signal);
      const resolved = await this.#resolve(input.path, {
        allowRoot: false,
        allowMissingLeaf: true,
      });
      const newContentBytes = Buffer.byteLength(input.newContent, "utf8");
      if (newContentBytes > this.#maxFileBytes) {
        throw new WorkspaceError(
          "FILE_TOO_LARGE",
          `Replacement exceeds the ${this.#maxFileBytes}-byte file limit: ${resolved.relative}`,
          resolved.relative,
        );
      }

      const created = resolved.stats === null;
      if (created) {
        if (input.expectedContent !== null) {
          throw conflict(resolved.relative, "Target does not exist.");
        }
      } else {
        const current = decodeText(
          await this.#readRegularFile(resolved, input.signal),
          resolved.relative,
        );
        if (input.expectedContent === null || current !== input.expectedContent) {
          throw conflict(resolved.relative, "File content changed since it was read.");
        }
      }

      throwIfAborted(input.signal);
      const result = {
        path: resolved.relative,
        created,
        bytesWritten: newContentBytes,
      };
      this.#assertOutputSize(result, resolved.relative);
      await this.#atomicWrite(
        resolved,
        input.newContent,
        input.expectedContent,
        created,
        input.signal,
      );
      return result;
    });
  }

  async deleteFile(
    input: DeleteWorkspaceFileInput,
  ): Promise<DeleteWorkspaceFileResult> {
    throwIfAborted(input.signal);
    const normalized = normalizeWorkspacePath(input.path, false);
    const absolute = this.#absolutePath(normalized);
    return this.#withWriteLock(absolute, async () => {
      await this.#resolveExpectedFile(
        input.path,
        input.expectedContent,
        input.signal,
        "delete",
      );
      const result = {
        path: normalized.relative,
        deleted: true as const,
      };
      this.#assertOutputSize(result, normalized.relative);

      throwIfAborted(input.signal);
      const latest = await this.#resolveExpectedFile(
        input.path,
        input.expectedContent,
        input.signal,
        "delete",
      );
      throwIfAborted(input.signal);
      await this.#assertCurrentFileIdentity(latest, "delete");
      try {
        await unlink(latest.absolute);
      } catch (error) {
        throw filesystemError(
          error,
          latest.relative,
          "Workspace file deletion failed.",
        );
      }
      return result;
    });
  }

  async moveFile(input: MoveWorkspaceFileInput): Promise<MoveWorkspaceFileResult> {
    throwIfAborted(input.signal);
    const from = normalizeWorkspacePath(input.fromPath, false);
    const to = normalizeWorkspacePath(input.toPath, false);
    const fromAbsolute = this.#absolutePath(from);
    const toAbsolute = this.#absolutePath(to);

    return this.#withWriteLocks([fromAbsolute, toAbsolute], async () => {
      const source = await this.#resolveExpectedFile(
        input.fromPath,
        input.expectedContent,
        input.signal,
        "move",
      );
      if (fromAbsolute === toAbsolute) {
        throw conflict(
          source.relative,
          "Source and target must be different paths.",
          "move",
        );
      }
      const target = await this.#resolve(input.toPath, {
        allowRoot: false,
        allowMissingLeaf: true,
      });
      if (target.stats !== null) {
        throw conflict(target.relative, "Target already exists.", "move");
      }

      const result = {
        fromPath: source.relative,
        toPath: target.relative,
      };
      this.#assertOutputSize(result, source.relative);

      throwIfAborted(input.signal);
      const latestSource = await this.#resolveExpectedFile(
        input.fromPath,
        input.expectedContent,
        input.signal,
        "move",
      );
      const latestTarget = await this.#resolve(input.toPath, {
        allowRoot: false,
        allowMissingLeaf: true,
      });
      if (latestTarget.stats !== null) {
        throw conflict(latestTarget.relative, "Target was created concurrently.", "move");
      }
      await this.#moveWithoutOverwrite(
        latestSource,
        latestTarget,
        input.expectedContent,
        input.signal,
      );
      return result;
    });
  }

  async #resolve(
    workspacePath: string,
    options: { readonly allowRoot: boolean; readonly allowMissingLeaf: boolean },
  ): Promise<ResolvedWorkspacePath> {
    const normalized = normalizeWorkspacePath(workspacePath, options.allowRoot);
    if (this.#isSensitivePath(normalized.relative)) {
      throw new WorkspaceError(
        "ACCESS_DENIED",
        `Workspace path is protected by the sensitive-file policy: ${normalized.relative}`,
        normalized.relative,
      );
    }
    const absolute = this.#absolutePath(normalized);
    let current = this.root;
    let leafStats: Stats | null = null;

    for (let index = 0; index < normalized.segments.length; index += 1) {
      current = path.join(current, normalized.segments[index]);
      const isLeaf = index === normalized.segments.length - 1;
      try {
        const currentStats = await lstat(current);
        if (currentStats.isSymbolicLink()) {
          throw new WorkspaceError(
            "SYMLINK_NOT_ALLOWED",
            `Symbolic links are not allowed in workspace paths: ${normalized.relative}`,
            normalized.relative,
          );
        }
        if (!isLeaf && !currentStats.isDirectory()) {
          throw new WorkspaceError(
            "NOT_DIRECTORY",
            `Workspace path component is not a directory: ${normalized.relative}`,
            normalized.relative,
          );
        }
        if (isLeaf) leafStats = currentStats;
      } catch (error) {
        if (
          isLeaf
          && options.allowMissingLeaf
          && isNodeError(error, "ENOENT")
        ) {
          leafStats = null;
          break;
        }
        if (error instanceof WorkspaceError) throw error;
        throw filesystemError(error, normalized.relative);
      }
    }

    if (normalized.segments.length === 0) {
      leafStats = await stat(this.root);
    }
    return { absolute, relative: normalized.relative, stats: leafStats };
  }

  async #resolveExpectedFile(
    workspacePath: string,
    expectedContent: string,
    signal: AbortSignal | undefined,
    operation: "delete" | "move",
  ): Promise<ResolvedWorkspacePath> {
    const resolved = await this.#resolve(workspacePath, {
      allowRoot: false,
      allowMissingLeaf: false,
    });
    const current = decodeText(
      await this.#readRegularFile(resolved, signal),
      resolved.relative,
    );
    if (current !== expectedContent) {
      throw conflict(
        resolved.relative,
        "File content changed since it was read.",
        operation,
      );
    }
    return resolved;
  }

  #absolutePath(normalized: NormalizedWorkspacePath): string {
    const absolute = path.resolve(this.root, ...normalized.segments);
    const relativeToRoot = path.relative(this.root, absolute);
    if (
      relativeToRoot === ".."
      || relativeToRoot.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeToRoot)
    ) {
      throw new WorkspaceError(
        "INVALID_PATH",
        `Workspace path escapes the configured root: ${normalized.relative}`,
        normalized.relative,
      );
    }
    return absolute;
  }

  async #readRegularFile(
    resolved: ResolvedWorkspacePath,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    throwIfAborted(signal);
    if (!resolved.stats) {
      throw new WorkspaceError(
        "NOT_FOUND",
        `Workspace path not found: ${resolved.relative}`,
        resolved.relative,
      );
    }
    if (!resolved.stats.isFile()) {
      throw new WorkspaceError(
        "NOT_FILE",
        `Workspace path is not a regular file: ${resolved.relative}`,
        resolved.relative,
      );
    }
    if (resolved.stats.size > this.#maxFileBytes) {
      throw new WorkspaceError(
        "FILE_TOO_LARGE",
        `Workspace file exceeds the ${this.#maxFileBytes}-byte file limit: ${resolved.relative}`,
        resolved.relative,
      );
    }

    let handle;
    try {
      handle = await open(resolved.absolute, constants.O_RDONLY | noFollowFlag());
      const openedStats = await handle.stat();
      if (!openedStats.isFile()) {
        throw new WorkspaceError(
          "NOT_FILE",
          `Workspace path is not a regular file: ${resolved.relative}`,
          resolved.relative,
        );
      }
      if (openedStats.size > this.#maxFileBytes) {
        throw new WorkspaceError(
          "FILE_TOO_LARGE",
          `Workspace file exceeds the ${this.#maxFileBytes}-byte file limit: ${resolved.relative}`,
          resolved.relative,
        );
      }
      const buffer = await handle.readFile();
      throwIfAborted(signal);
      return buffer;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (isNodeError(error, "ELOOP")) {
        throw new WorkspaceError(
          "SYMLINK_NOT_ALLOWED",
          `Symbolic links are not allowed in workspace paths: ${resolved.relative}`,
          resolved.relative,
        );
      }
      throw filesystemError(error, resolved.relative);
    } finally {
      await handle?.close();
    }
  }

  async *#walkFiles(
    start: ResolvedWorkspacePath,
    signal?: AbortSignal,
  ): AsyncGenerator<ResolvedWorkspacePath, void, void> {
    throwIfAborted(signal);
    if (start.stats?.isFile()) {
      yield start;
      return;
    }
    if (!start.stats?.isDirectory()) {
      throw new WorkspaceError(
        "NOT_DIRECTORY",
        `Workspace search path is not a file or directory: ${start.relative}`,
        start.relative,
      );
    }

    const walk = async function* (
      workspace: NodeWorkspace,
      absoluteDirectory: string,
    ): AsyncGenerator<ResolvedWorkspacePath, void, void> {
      throwIfAborted(signal);
      let children;
      try {
        children = await readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        throw filesystemError(error, workspace.#displayPath(absoluteDirectory));
      }
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        throwIfAborted(signal);
        if (child.isSymbolicLink()) continue;
        const absoluteChild = path.join(absoluteDirectory, child.name);
        const relativeChild = workspace.#displayPath(absoluteChild);
        if (workspace.#isSensitivePath(relativeChild)) continue;
        let childStats: Stats;
        try {
          childStats = await lstat(absoluteChild);
        } catch (error) {
          throw filesystemError(error, relativeChild);
        }
        if (childStats.isSymbolicLink()) continue;
        if (childStats.isDirectory()) {
          if (!workspace.#ignoredDirectories.has(child.name)) {
            yield* walk(workspace, absoluteChild);
          }
        } else if (childStats.isFile()) {
          yield { absolute: absoluteChild, relative: relativeChild, stats: childStats };
        }
      }
    };

    yield* walk(this, start.absolute);
  }

  async #atomicWrite(
    resolved: ResolvedWorkspacePath,
    content: string,
    expectedContent: string | null,
    createOnly: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const parent = path.dirname(resolved.absolute);
    const parentRelative = this.#displayPath(parent);
    const verifiedParent = await this.#resolve(parentRelative, {
      allowRoot: true,
      allowMissingLeaf: false,
    });
    if (!verifiedParent.stats?.isDirectory()) {
      throw new WorkspaceError(
        "NOT_DIRECTORY",
        `Workspace parent is not a directory: ${parentRelative}`,
        parentRelative,
      );
    }

    const temporary = path.join(
      parent,
      `.${path.basename(resolved.absolute)}.codex-${randomUUID()}.tmp`,
    );
    const mode = resolved.stats ? resolved.stats.mode & 0o777 : 0o644;
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
        mode,
      );
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      throwIfAborted(signal);

      if (createOnly) {
        try {
          await link(temporary, resolved.absolute);
        } catch (error) {
          if (isNodeError(error, "EEXIST")) {
            throw conflict(resolved.relative, "Target was created concurrently.");
          }
          throw error;
        }
        await unlink(temporary);
      } else {
        const current = await this.#resolve(resolved.relative, {
          allowRoot: false,
          allowMissingLeaf: false,
        });
        if (!current.stats?.isFile()) {
          throw conflict(resolved.relative, "Target changed before replacement.");
        }
        const latestContent = decodeText(
          await this.#readRegularFile(current, signal),
          current.relative,
        );
        if (expectedContent === null || latestContent !== expectedContent) {
          throw conflict(resolved.relative, "Target changed before replacement.");
        }
        await rename(temporary, resolved.absolute);
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw filesystemError(error, resolved.relative, "Atomic workspace write failed.");
    } finally {
      await handle?.close();
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          // Cleanup failure must not mask the operation's primary outcome.
        }
      }
    }
  }

  async #moveWithoutOverwrite(
    source: ResolvedWorkspacePath,
    target: ResolvedWorkspacePath,
    expectedContent: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let targetCreated = false;
    try {
      throwIfAborted(signal);
      await link(source.absolute, target.absolute);
      targetCreated = true;

      const linkedTarget = await this.#resolve(target.relative, {
        allowRoot: false,
        allowMissingLeaf: false,
      });
      if (!sameFileIdentity(source.stats, linkedTarget.stats)) {
        throw conflict(target.relative, "Target changed during the move.", "move");
      }
      const linkedContent = decodeText(
        await this.#readRegularFile(linkedTarget, signal),
        linkedTarget.relative,
      );
      if (linkedContent !== expectedContent) {
        throw conflict(source.relative, "Source changed during the move.", "move");
      }

      const currentSource = await this.#resolve(source.relative, {
        allowRoot: false,
        allowMissingLeaf: false,
      });
      if (!sameFileIdentity(currentSource.stats, linkedTarget.stats)) {
        throw conflict(source.relative, "Source changed during the move.", "move");
      }
      const currentContent = decodeText(
        await this.#readRegularFile(currentSource, signal),
        currentSource.relative,
      );
      if (currentContent !== expectedContent) {
        throw conflict(source.relative, "Source changed during the move.", "move");
      }

      throwIfAborted(signal);
      await this.#assertCurrentFileIdentity(currentSource, "move");
      await unlink(currentSource.absolute);
    } catch (error) {
      if (targetCreated) {
        let cleanupFailure: unknown;
        let cleanupFailureReason: string | undefined;
        try {
          const currentTarget = await lstat(target.absolute);
          if (sameFileIdentity(currentTarget, source.stats)) {
            await unlink(target.absolute);
          } else {
            cleanupFailureReason =
              "the destination identity could not be verified";
          }
        } catch (cleanupError) {
          if (!isNodeError(cleanupError, "ENOENT")) {
            cleanupFailure = cleanupError;
            cleanupFailureReason = "the destination could not be removed";
          }
        }
        if (cleanupFailureReason) {
          throw partialMoveError(
            source,
            target,
            cleanupFailureReason,
            error,
            cleanupFailure,
          );
        }
      }
      if (error instanceof WorkspaceError) throw error;
      if (isNodeError(error, "EEXIST")) {
        throw conflict(target.relative, "Target was created concurrently.", "move");
      }
      throw filesystemError(
        error,
        source.relative,
        "Workspace file move failed.",
      );
    }
  }

  async #assertCurrentFileIdentity(
    resolved: ResolvedWorkspacePath,
    operation: "delete" | "move",
  ): Promise<void> {
    let currentStats: Stats;
    try {
      currentStats = await lstat(resolved.absolute);
    } catch (error) {
      if (
        isNodeError(error, "ENOENT")
        || isNodeError(error, "ENOTDIR")
        || isNodeError(error, "ELOOP")
      ) {
        throw conflict(
          resolved.relative,
          "File identity changed before the final removal.",
          operation,
        );
      }
      throw filesystemError(error, resolved.relative);
    }
    if (!sameFileIdentity(resolved.stats, currentStats)) {
      throw conflict(
        resolved.relative,
        "File identity changed before the final removal.",
        operation,
      );
    }
  }

  async #withWriteLocks<T>(
    keys: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const orderedKeys = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> => {
      const key = orderedKeys[index];
      return key === undefined
        ? operation()
        : this.#withWriteLock(key, () => acquire(index + 1));
    };
    return acquire(0);
  }

  async #withWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#writeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#writeLocks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#writeLocks.get(key) === queued) this.#writeLocks.delete(key);
    }
  }

  #displayPath(absolute: string): string {
    const relative = path.relative(this.root, absolute);
    if (
      relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)
    ) {
      throw new WorkspaceError("INVALID_PATH", "Workspace path escaped its root.");
    }
    return relative ? relative.split(path.sep).join("/") : ".";
  }

  #isSensitivePath(workspacePath: string): boolean {
    if (this.#allowSensitivePaths || workspacePath === ".") return false;
    const segments = workspacePath.toLowerCase().split("/");
    if (segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) {
      return true;
    }
    const basename = segments.at(-1) ?? "";
    if (SENSITIVE_FILE_NAMES.has(basename)) return true;
    if (
      (basename === ".env" || basename.startsWith(".env.")) &&
      !basename.endsWith(".example")
    ) {
      return true;
    }
    return [".key", ".p12", ".pem", ".pfx"].some((suffix) =>
      basename.endsWith(suffix)
    );
  }

  #assertOutputSize(value: unknown, workspacePath: string): void {
    if (serializedBytes(value) > this.#maxOutputBytes) {
      throw new WorkspaceError(
        "OUTPUT_TOO_LARGE",
        `Workspace result exceeds the ${this.#maxOutputBytes}-byte output limit: ${workspacePath}`,
        workspacePath,
      );
    }
  }
}

export function createNodeWorkspace(options: NodeWorkspaceOptions): Promise<NodeWorkspace> {
  return NodeWorkspace.create(options);
}

function normalizeWorkspacePath(
  workspacePath: string,
  allowRoot: boolean,
): NormalizedWorkspacePath {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) {
    throw new WorkspaceError("INVALID_PATH", "Workspace path must not be empty.");
  }
  if (workspacePath.includes("\0")) {
    throw new WorkspaceError("INVALID_PATH", "Workspace path contains a null byte.");
  }
  if (path.isAbsolute(workspacePath) || path.win32.isAbsolute(workspacePath)) {
    throw new WorkspaceError("INVALID_PATH", "Workspace path must be relative.");
  }

  const segments = workspacePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new WorkspaceError("INVALID_PATH", "Parent path segments are not allowed.");
  }
  if (segments.length === 0 && !allowRoot) {
    throw new WorkspaceError("INVALID_PATH", "A file path is required.");
  }
  return { relative: segments.join("/") || ".", segments };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return candidate;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorkspaceError("ABORTED", "Workspace operation was aborted.");
  }
}

function conflict(
  workspacePath: string,
  reason: string,
  operation = "patch",
): WorkspaceError {
  return new WorkspaceError(
    "CONFLICT",
    `Workspace ${operation} conflict for ${workspacePath}: ${reason}`,
    workspacePath,
  );
}

function sameFileIdentity(left: Stats | null, right: Stats | null): boolean {
  return Boolean(
    left
    && right
    && left.dev === right.dev
    && left.ino === right.ino,
  );
}

function partialMoveError(
  source: ResolvedWorkspacePath,
  target: ResolvedWorkspacePath,
  reason: string,
  primaryError: unknown,
  cleanupError?: unknown,
): WorkspaceError {
  const cause = cleanupError === undefined
    ? primaryError
    : new AggregateError([primaryError, cleanupError]);
  return new WorkspaceError(
    "IO_ERROR",
    `Workspace move entered a partial state for ${source.relative} -> ${target.relative}: ${reason}. Manual review is required.`,
    target.relative,
    { cause },
  );
}

function filesystemError(
  error: unknown,
  workspacePath: string,
  fallback = "Workspace I/O operation failed.",
): WorkspaceError {
  if (isNodeError(error, "ENOENT")) {
    return new WorkspaceError(
      "NOT_FOUND",
      `Workspace path not found: ${workspacePath}`,
      workspacePath,
      { cause: error },
    );
  }
  if (isNodeError(error, "ENOTDIR")) {
    return new WorkspaceError(
      "NOT_DIRECTORY",
      `Workspace path component is not a directory: ${workspacePath}`,
      workspacePath,
      { cause: error },
    );
  }
  return new WorkspaceError("IO_ERROR", fallback, workspacePath, { cause: error });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function decodeText(buffer: Buffer, workspacePath: string): string {
  if (isProbablyBinary(buffer)) {
    throw new WorkspaceError(
      "UNSUPPORTED_FILE",
      `Workspace file is binary: ${workspacePath}`,
      workspacePath,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new WorkspaceError(
      "UNSUPPORTED_FILE",
      `Workspace file is not valid UTF-8 text: ${workspacePath}`,
      workspacePath,
      { cause: error },
    );
  }
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
}

function previewLine(line: string): string {
  const normalized = line.trim().replace(/\s+/g, " ");
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
