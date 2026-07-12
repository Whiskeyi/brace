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

const ragQuerySchema = z.object({
  query: z.string().trim().min(1).max(20_000),
  datasetIds: z.array(z.string().trim().min(1).max(255)).min(1).max(10),
  mode: z.enum(["local", "global", "hybrid", "naive", "mix"]).default("mix"),
  topK: z.number().int().min(1).max(100).optional(),
  chunkTopK: z.number().int().min(1).max(100).optional(),
  enableRerank: z.boolean().optional(),
  maxResultsPerDataset: z.number().int().min(1).max(100).optional(),
  documentFilters: z.record(z.string(), z.array(z.string())).optional(),
});

export type RagQueryInput = z.input<typeof ragQuerySchema> & {
  signal?: AbortSignal;
};

export interface AliyunRagClientOptions {
  baseUrl?: string;
  apiKey?: string;
  /** RAG Agent access token when apiKey is an anon key. */
  accessToken?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RagContextResult {
  datasetIds: string[];
  /** Context payload returned by RAG Agent. No generated answer is exposed. */
  context: unknown;
}

function ragApiRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.search || url.hash || url.username || url.password) {
    throw new Error("RAG base URL must not contain credentials, query, or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/rag/v1")) {
    url.pathname = path;
  } else if (path.endsWith("/rag")) {
    url.pathname = `${path}/v1`;
  } else {
    url.pathname = `${path}/rag/v1`.replace(/\/{2,}/g, "/");
  }
  return url.toString().replace(/\/$/, "");
}

function extractContext(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if ("context" in record) return record.context;
  if ("contexts" in record) return record.contexts;
  if ("results" in record) return record.results;
  if ("data" in record) return extractContext(record.data);
  return body;
}

export class AliyunRagClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly accessToken?: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: AliyunRagClientOptions = {}) {
    // Complete dependency injection must remain independent from process.env so
    // tests and isolated workers can construct this adapter safely.
    const config = options.baseUrl && options.apiKey ? undefined : getServerConfig();
    const baseUrl = options.baseUrl ?? config?.ALIYUN_RAG_BASE_URL;
    const apiKey = options.apiKey ?? config?.ALIYUN_RAG_API_KEY;
    if (!baseUrl) throw new Error("ALIYUN_RAG_BASE_URL is not configured");
    if (!apiKey) throw new Error("ALIYUN_RAG_API_KEY is not configured");
    this.baseUrl = ragApiRoot(baseUrl);
    this.apiKey = apiKey;
    this.accessToken = options.accessToken?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetcher = options.fetch ?? globalThis.fetch;

    if (!this.apiKey.trim() || /[\r\n]/.test(this.apiKey)) {
      throw new Error("A valid RAG API key is required");
    }
    if (this.accessToken && /[\r\n]/.test(this.accessToken)) {
      throw new Error("Invalid RAG access token");
    }
  }

  async queryContext(input: RagQueryInput): Promise<RagContextResult> {
    const { signal: callerSignal, ...candidate } = input;
    const parsed = ragQuerySchema.parse(candidate);
    const datasetIds = [...new Set(parsed.datasetIds)];
    const isCrossDataset = datasetIds.length > 1;
    const path = isCrossDataset
      ? "/datasets/cross-query/context"
      : `/datasets/${encodeURIComponent(datasetIds[0])}/query`;

    const body = {
      query: parsed.query,
      ...(isCrossDataset ? { dataset_ids: datasetIds } : {}),
      mode: parsed.mode,
      only_need_context: true,
      ...(parsed.topK === undefined ? {} : { top_k: parsed.topK }),
      ...(parsed.chunkTopK === undefined
        ? {}
        : { chunk_top_k: parsed.chunkTopK }),
      ...(parsed.enableRerank === undefined
        ? {}
        : { enable_rerank: parsed.enableRerank }),
      ...(isCrossDataset && parsed.maxResultsPerDataset !== undefined
        ? { max_results_per_dataset: parsed.maxResultsPerDataset }
        : {}),
      ...(isCrossDataset && parsed.documentFilters
        ? { document_filters: parsed.documentFilters }
        : {}),
    };
    const request = createRequestSignal(this.timeoutMs, callerSignal);

    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          // Alibaba Cloud documents this exact header. Never put the key in a URL.
          apikey: this.apiKey,
          ...(this.accessToken
            ? { Authorization: `Bearer ${this.accessToken}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      const payload = await readResponseBody(response);
      if (!response.ok) {
        throw new IntegrationError(
          "Alibaba Cloud RAG",
          responseErrorMessage(payload),
          {
            status: response.status,
            retryAfterSeconds: retryAfterSeconds(response),
          },
        );
      }
      return { datasetIds, context: extractContext(payload) };
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError("Alibaba Cloud RAG", "request failed", {
        cause: error,
      });
    } finally {
      request.cleanup();
    }
  }
}

export function createAliyunRagClient(
  options?: AliyunRagClientOptions,
): AliyunRagClient {
  return new AliyunRagClient(options);
}
