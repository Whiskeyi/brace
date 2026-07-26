import {
  WorkspaceError,
  type WorkspacePort,
} from "../workspace/types";

const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const DEFAULT_MAX_INSTRUCTION_BYTES = 32 * 1024;

export interface ProjectInstructions {
  readonly content: string;
  readonly files: readonly string[];
  readonly truncated: boolean;
}

/**
 * Loads root-scoped conventions used by Codex- and Claude-style repositories.
 * The caller still labels this repository-owned text below the host prompt and
 * user request; it never becomes an authority over the runtime policy.
 */
export async function loadProjectInstructions(
  workspace: WorkspacePort,
  maxBytes = DEFAULT_MAX_INSTRUCTION_BYTES,
): Promise<ProjectInstructions | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }

  const sections: string[] = [];
  const files: string[] = [];
  let remainingBytes = maxBytes;
  let truncated = false;

  for (const file of PROJECT_INSTRUCTION_FILES) {
    let content: string;
    try {
      content = (await workspace.readFile({ path: file })).content.trim();
    } catch (error) {
      if (isOptionalInstructionError(error)) continue;
      throw error;
    }
    if (!content) continue;

    const header = `### ${file}\n`;
    const headerBytes = utf8Bytes(header);
    if (headerBytes >= remainingBytes) {
      truncated = true;
      break;
    }
    const availableContentBytes = remainingBytes - headerBytes;
    const bounded = takeUtf8Prefix(content, availableContentBytes);
    sections.push(`${header}${bounded.value}`);
    files.push(file);
    remainingBytes -= headerBytes + bounded.bytes;
    if (bounded.truncated) {
      truncated = true;
      break;
    }
  }

  if (sections.length === 0) return null;
  return {
    content: sections.join("\n\n"),
    files,
    truncated,
  };
}

function isOptionalInstructionError(error: unknown): boolean {
  return (
    error instanceof WorkspaceError &&
    ["NOT_FOUND", "ACCESS_DENIED", "SYMLINK_NOT_ALLOWED"].includes(error.code)
  );
}

function takeUtf8Prefix(
  value: string,
  maxBytes: number,
): { value: string; bytes: number; truncated: boolean } {
  if (utf8Bytes(value) <= maxBytes) {
    return { value, bytes: utf8Bytes(value), truncated: false };
  }
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) lower = middle;
    else upper = middle - 1;
  }
  const prefix = value.slice(0, lower);
  return { value: prefix, bytes: utf8Bytes(prefix), truncated: true };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
