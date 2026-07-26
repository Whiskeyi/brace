import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  SandboxPort,
  SandboxRunInput,
  SandboxRunResult,
  SandboxTerminationReason,
} from "./types";
import { SandboxError } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1_024;
const DEFAULT_KILL_GRACE_MS = 100;
const DEFAULT_ENVIRONMENT_VARIABLE_ALLOWLIST = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
]);

export interface NodeProcessSandboxOptions {
  readonly root: string;
  /** Exact executable names or paths. The default is empty and denies all. */
  readonly allowedExecutables?: readonly string[];
  /** Only these variables are copied from the host process. */
  readonly environmentVariableAllowlist?: readonly string[];
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  /** Combined stdout and stderr bytes retained before terminating the process. */
  readonly maxOutputBytes?: number;
  readonly killGraceMs?: number;
}

interface NormalizedNodeProcessSandboxOptions {
  readonly allowedExecutables: ReadonlySet<string>;
  readonly environmentVariableAllowlist: readonly string[];
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly killGraceMs: number;
}

/**
 * Trusted local/development adapter backed by the host Node.js process API.
 * It constrains paths, executables, environment, time, and output, but it is not
 * tenant isolation and must not replace a container or managed production sandbox.
 */
export class NodeProcessSandbox implements SandboxPort {
  readonly #root: string;
  readonly #allowedExecutables: ReadonlySet<string>;
  readonly #environmentVariableAllowlist: readonly string[];
  readonly #defaultTimeoutMs: number;
  readonly #maxTimeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #killGraceMs: number;

  private constructor(
    root: string,
    options: NormalizedNodeProcessSandboxOptions,
  ) {
    this.#root = root;
    this.#allowedExecutables = options.allowedExecutables;
    this.#environmentVariableAllowlist = options.environmentVariableAllowlist;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    this.#maxTimeoutMs = options.maxTimeoutMs;
    this.#maxOutputBytes = options.maxOutputBytes;
    this.#killGraceMs = options.killGraceMs;
  }

  static async create(
    options: NodeProcessSandboxOptions,
  ): Promise<NodeProcessSandbox> {
    if (typeof options.root !== "string" || options.root.length === 0) {
      throw new SandboxError("INVALID_PATH", "Sandbox root must be a directory.");
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(path.resolve(options.root));
      if (!(await stat(canonicalRoot)).isDirectory()) {
        throw new SandboxError(
          "INVALID_PATH",
          "Sandbox root must be a directory.",
        );
      }
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        "IO_ERROR",
        "Sandbox root is not available.",
        { cause: error },
      );
    }

    const defaultTimeoutMs = positiveTimeout(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      "defaultTimeoutMs",
    );
    const maxTimeoutMs = positiveTimeout(
      options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS,
      "maxTimeoutMs",
    );
    if (defaultTimeoutMs > maxTimeoutMs) {
      throw new SandboxError(
        "INVALID_TIMEOUT",
        "defaultTimeoutMs must not exceed maxTimeoutMs.",
      );
    }

    return new NodeProcessSandbox(canonicalRoot, {
      allowedExecutables: new Set(
        validateExecutableAllowlist(options.allowedExecutables ?? []),
      ),
      environmentVariableAllowlist: validateEnvironmentVariableAllowlist(
        options.environmentVariableAllowlist ??
          DEFAULT_ENVIRONMENT_VARIABLE_ALLOWLIST,
      ),
      defaultTimeoutMs,
      maxTimeoutMs,
      maxOutputBytes: positiveSafeInteger(
        options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        "maxOutputBytes",
      ),
      killGraceMs: nonNegativeSafeInteger(
        options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
        "killGraceMs",
      ),
    });
  }

  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    throwIfAborted(input.signal);
    const executable = validateExecutable(input.executable);
    if (!this.#allowedExecutables.has(executable)) {
      throw new SandboxError(
        "EXECUTABLE_NOT_ALLOWED",
        "Executable is not allowed.",
      );
    }
    const args = validateArguments(input.args ?? []);
    const timeoutMs = this.#normalizeTimeout(input.timeoutMs);
    const cwd = normalizeWorkspaceRelativePath(input.cwd ?? ".");
    const absoluteCwd = await this.#resolveCwd(cwd);
    throwIfAborted(input.signal);

    return this.#spawn({
      executable,
      args,
      cwd,
      absoluteCwd,
      timeoutMs,
      signal: input.signal,
    });
  }

  #normalizeTimeout(configuredTimeout?: number): number {
    const timeoutMs = configuredTimeout === undefined
      ? this.#defaultTimeoutMs
      : positiveTimeout(configuredTimeout, "timeoutMs");
    if (timeoutMs > this.#maxTimeoutMs) {
      throw new SandboxError(
        "INVALID_TIMEOUT",
        `timeoutMs must not exceed ${this.#maxTimeoutMs}.`,
      );
    }
    return timeoutMs;
  }

  async #resolveCwd(relativeCwd: string): Promise<string> {
    const candidate = relativeCwd === "."
      ? this.#root
      : path.join(this.#root, ...relativeCwd.split("/"));
    let canonicalCwd: string;
    try {
      canonicalCwd = await realpath(candidate);
      if (!(await stat(canonicalCwd)).isDirectory()) {
        throw new SandboxError(
          "INVALID_PATH",
          `Sandbox cwd is not a directory: ${relativeCwd}`,
        );
      }
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      throw new SandboxError(
        "INVALID_PATH",
        `Sandbox cwd is not available: ${relativeCwd}`,
        { cause: error },
      );
    }

    const relativeFromRoot = path.relative(this.#root, canonicalCwd);
    if (
      relativeFromRoot === ".."
      || relativeFromRoot.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeFromRoot)
    ) {
      throw new SandboxError(
        "INVALID_PATH",
        `Sandbox cwd escapes the workspace: ${relativeCwd}`,
      );
    }
    return canonicalCwd;
  }

  #spawn(input: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly absoluteCwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<SandboxRunResult> {
    const startedAt = Date.now();
    const environment = Object.create(null) as NodeJS.ProcessEnv;
    for (const name of this.#environmentVariableAllowlist) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(input.executable, [...input.args], {
          cwd: input.absoluteCwd,
          detached: process.platform !== "win32",
          env: environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (error) {
        reject(
          new SandboxError("SPAWN_FAILED", "Executable could not be started.", {
            cause: error,
          }),
        );
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let observedOutputBytes = 0;
      let capturedOutputBytes = 0;
      let outputTruncated = false;
      let terminationReason: SandboxTerminationReason | undefined;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const terminate = (reason: Exclude<SandboxTerminationReason, "exit">) => {
        if (terminationReason) return;
        terminationReason = reason;
        signalProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => {
          signalProcessTree(child, "SIGKILL");
        }, this.#killGraceMs);
      };

      const capture = (target: Buffer[], chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        observedOutputBytes += buffer.byteLength;
        const remaining = this.#maxOutputBytes - capturedOutputBytes;
        if (remaining > 0) {
          const retained = buffer.subarray(0, remaining);
          target.push(retained);
          capturedOutputBytes += retained.byteLength;
        }
        if (buffer.byteLength > remaining) {
          outputTruncated = true;
          terminate("output_limit");
        }
      };

      child.stdout?.on("data", (chunk: Buffer | string) => capture(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => capture(stderr, chunk));

      const abort = () => terminate("aborted");
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) abort();
      const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        if (killTimer !== undefined) clearTimeout(killTimer);
        input.signal?.removeEventListener("abort", abort);
      };

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new SandboxError("SPAWN_FAILED", "Executable could not be started.", {
            cause: error,
          }),
        );
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          cwd: input.cwd,
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          outputBytes: observedOutputBytes,
          capturedOutputBytes,
          truncated: outputTruncated,
          terminationReason: terminationReason ?? "exit",
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

export function createNodeProcessSandbox(
  options: NodeProcessSandboxOptions,
): Promise<NodeProcessSandbox> {
  return NodeProcessSandbox.create(options);
}

function normalizeWorkspaceRelativePath(candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new SandboxError("INVALID_PATH", "Sandbox cwd must not be empty.");
  }
  if (candidate.includes("\0")) {
    throw new SandboxError("INVALID_PATH", "Sandbox cwd contains a null byte.");
  }
  if (path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    throw new SandboxError("INVALID_PATH", "Sandbox cwd must be relative.");
  }

  const segments = candidate.replaceAll("\\", "/").split("/");
  if (segments.includes("..")) {
    throw new SandboxError(
      "INVALID_PATH",
      "Parent path segments are not allowed in sandbox cwd.",
    );
  }
  const normalized = segments.filter((segment) => segment && segment !== ".");
  return normalized.length === 0 ? "." : normalized.join("/");
}

function validateExecutable(executable: string): string {
  if (
    typeof executable !== "string"
    || executable.length === 0
    || executable.includes("\0")
  ) {
    throw new SandboxError(
      "INVALID_ARGUMENT",
      "Executable must be a non-empty string without null bytes.",
    );
  }
  return executable;
}

function validateExecutableAllowlist(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new SandboxError(
      "INVALID_ARGUMENT",
      "allowedExecutables must be an array.",
    );
  }
  return values.map(validateExecutable);
}

function validateArguments(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new SandboxError("INVALID_ARGUMENT", "args must be an array.");
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.includes("\0")) {
      throw new SandboxError(
        "INVALID_ARGUMENT",
        "Command arguments must be strings without null bytes.",
      );
    }
    return value;
  });
}

function validateEnvironmentVariableAllowlist(
  values: readonly string[],
): readonly string[] {
  if (!Array.isArray(values)) {
    throw new SandboxError(
      "INVALID_ARGUMENT",
      "environmentVariableAllowlist must be an array.",
    );
  }
  return [...new Set(values.map((value) => {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new SandboxError(
        "INVALID_ARGUMENT",
        "Environment variable allowlist contains an invalid name.",
      );
    }
    return value;
  }))];
}

function positiveTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SandboxError(
      "INVALID_TIMEOUT",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SandboxError(
      "INVALID_ARGUMENT",
      `${name} must be a positive safe integer.`,
    );
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SandboxError(
      "INVALID_ARGUMENT",
      `${name} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new SandboxError("ABORTED", "Command execution was aborted.");
  }
}

function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the close check and signal delivery.
  }
}
