import "server-only";

import { z } from "zod";

import { getServerConfig } from "@/lib/config";
import {
  createRequestSignal,
  IntegrationError,
  readResponseBody,
  responseErrorMessage,
  retryAfterSeconds,
} from "@/lib/integrations/http";

const userId = z.string().trim().min(1).max(255);
const messageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().trim().min(1).max(100_000),
  })
  .strict();
const searchSchema = z
  .object({
    userId,
    query: z.string().trim().min(1).max(20_000),
    limit: z.number().int().min(1).max(100).default(10),
    agentId: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
const addSchema = z
  .object({
    userId,
    messages: z.array(messageSchema).min(1).max(200),
    agentId: z.string().trim().min(1).max(255).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type Mem0SearchInput = z.input<typeof searchSchema> & {
  signal?: AbortSignal;
};
export type Mem0AddInput = z.input<typeof addSchema> & {
  signal?: AbortSignal;
};

export interface Mem0ClientOptions {
  host?: string;
  apiKey?: string;
  enableGraph?: boolean;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

function memoryRoot(host: string): string {
  const url = new URL(host);
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("MEM0_HOST must not contain credentials, query, or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/memory")
    ? path
    : `${path}/memory`.replace(/\/{2,}/g, "/");
  return url.toString().replace(/\/$/, "");
}

export class RdsMem0Client {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly enableGraph: boolean;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: Mem0ClientOptions = {}) {
    // Complete dependency injection is intentionally independent of env.
    const config = options.host && options.apiKey ? undefined : getServerConfig();
    const host = options.host ?? config?.MEM0_HOST;
    const apiKey = options.apiKey ?? config?.MEM0_API_KEY;
    if (!host) throw new Error("MEM0_HOST is not configured");
    if (!apiKey) throw new Error("MEM0_API_KEY is not configured");
    if (!apiKey.trim() || /[\r\n]/.test(apiKey)) {
      throw new Error("A valid MEM0_API_KEY is required");
    }
    this.baseUrl = memoryRoot(host);
    this.apiKey = apiKey;
    this.enableGraph = options.enableGraph ?? config?.MEM0_ENABLE_GRAPH ?? false;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async search(input: Mem0SearchInput): Promise<unknown> {
    const { signal, ...candidate } = input;
    const parsed = searchSchema.parse(candidate);
    return this.post(
      "/v2/memories/search/",
      {
        query: parsed.query,
        user_id: parsed.userId,
        limit: parsed.limit,
        enable_graph: this.enableGraph,
        ...(parsed.agentId ? { agent_id: parsed.agentId } : {}),
      },
      signal,
    );
  }

  async add(input: Mem0AddInput): Promise<unknown> {
    const { signal, ...candidate } = input;
    const parsed = addSchema.parse(candidate);
    return this.post(
      "/v1/memories/",
      {
        messages: parsed.messages,
        user_id: parsed.userId,
        enable_graph: this.enableGraph,
        ...(parsed.agentId ? { agent_id: parsed.agentId } : {}),
        ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
      },
      signal,
    );
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const request = createRequestSignal(this.timeoutMs, callerSignal);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Token ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      const payload = await readResponseBody(response);
      if (!response.ok) {
        throw new IntegrationError("RDS Long-Term Memory", responseErrorMessage(payload), {
          status: response.status,
          retryAfterSeconds: retryAfterSeconds(response),
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError("RDS Long-Term Memory", "request failed", {
        cause: error,
      });
    } finally {
      request.cleanup();
    }
  }
}

export function createRdsMem0Client(options?: Mem0ClientOptions): RdsMem0Client {
  return new RdsMem0Client(options);
}
