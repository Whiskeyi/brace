export type SandboxErrorCode =
  | "ABORTED"
  | "EXECUTABLE_NOT_ALLOWED"
  | "INVALID_ARGUMENT"
  | "INVALID_PATH"
  | "INVALID_TIMEOUT"
  | "IO_ERROR"
  | "SPAWN_FAILED";

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxError";
  }
}

export interface SandboxRunInput {
  readonly executable: string;
  readonly args?: readonly string[];
  /** A path relative to the configured workspace root. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type SandboxTerminationReason =
  | "exit"
  | "timeout"
  | "aborted"
  | "output_limit";

export interface SandboxRunResult {
  /** The normalized workspace-relative working directory, never the host root. */
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Bytes observed before the process and its pipes closed. */
  readonly outputBytes: number;
  /** Bytes retained across stdout and stderr. This never exceeds the limit. */
  readonly capturedOutputBytes: number;
  /** True when output was cut at the byte limit and the process was terminated. */
  readonly truncated: boolean;
  readonly terminationReason: SandboxTerminationReason;
  readonly durationMs: number;
}

/**
 * Capability boundary used by command tools. Implementations must execute an
 * executable and argument vector directly; this contract has no shell-string API.
 */
export interface SandboxPort {
  run(input: SandboxRunInput): Promise<SandboxRunResult>;
}
