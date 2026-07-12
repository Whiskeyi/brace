import type { PostgrestError } from "@supabase/supabase-js";

export class RepositoryError extends Error {
  readonly operation: string;
  readonly code: string | null;
  readonly details: string | null;

  constructor(operation: string, error: PostgrestError) {
    super(`Repository operation failed: ${operation}`, { cause: error });
    this.name = "RepositoryError";
    this.operation = operation;
    this.code = error.code ?? null;
    this.details = error.details ?? null;
  }
}

export function assertUserId(userId: string): string {
  const value = userId.trim();
  if (!value) throw new Error("userId is required");
  return value;
}

export function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`limit must be an integer between 1 and ${max}`);
  }
  return value;
}

export function throwIfError(
  operation: string,
  error: PostgrestError | null,
): void {
  if (error) throw new RepositoryError(operation, error);
}

export function assertTimestamp(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return value;
}
