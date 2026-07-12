import "server-only";

export class IntegrationError extends Error {
  readonly service: string;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    service: string,
    message: string,
    options: {
      status?: number;
      retryAfterSeconds?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(`${service}: ${message}`, { cause: options.cause });
    this.name = "IntegrationError";
    this.service = service;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function createRequestSignal(
  timeoutMs: number,
  callerSignal?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Request timed out")),
    timeoutMs,
  );
  const forwardAbort = () => controller.abort(callerSignal?.reason);

  if (callerSignal) {
    if (callerSignal.aborted) {
      forwardAbort();
    } else {
      callerSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function responseErrorMessage(body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const value = record.message ?? record.error ?? record.detail;
    if (typeof value === "string" && value.trim()) {
      return value.slice(0, 500);
    }
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim().slice(0, 500);
  }
  return "request failed";
}

export function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
