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

const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(400),
  maxResults: z.number().int().min(1).max(20).default(8),
  topic: z.enum(["general", "news"]).default("general"),
});

export interface WebSearchInput extends z.input<typeof searchInputSchema> {
  signal?: AbortSignal;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
  publishedAt?: string;
}

export interface WebSearchProvider {
  readonly name: "tavily" | "brave";
  search(input: WebSearchInput): Promise<WebSearchResult[]>;
}

interface ProviderOptions {
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

function validKey(apiKey: string): string {
  const key = apiKey.trim();
  if (!key || /[\r\n]/.test(key)) throw new Error("Invalid web search API key");
  return key;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class TavilyWebSearch implements WebSearchProvider {
  readonly name = "tavily" as const;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: ProviderOptions) {
    this.apiKey = validKey(options.apiKey);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async search(input: WebSearchInput): Promise<WebSearchResult[]> {
    const { signal: callerSignal, ...candidate } = input;
    const parsed = searchInputSchema.parse(candidate);
    const request = createRequestSignal(this.timeoutMs, callerSignal);
    try {
      const response = await this.fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query: parsed.query,
          max_results: parsed.maxResults,
          topic: parsed.topic,
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }),
        signal: request.signal,
      });
      const payload = await readResponseBody(response);
      if (!response.ok) {
        throw new IntegrationError("Tavily", responseErrorMessage(payload), {
          status: response.status,
          retryAfterSeconds: retryAfterSeconds(response),
        });
      }
      const results = asRecord(payload)?.results;
      if (!Array.isArray(results)) return [];
      return results.flatMap((value): WebSearchResult[] => {
        const row = asRecord(value);
        if (!row || typeof row.title !== "string" || typeof row.url !== "string") {
          return [];
        }
        return [
          {
            title: row.title,
            url: row.url,
            snippet: typeof row.content === "string" ? row.content : "",
            ...(typeof row.score === "number" ? { score: row.score } : {}),
            ...(typeof row.published_date === "string"
              ? { publishedAt: row.published_date }
              : {}),
          },
        ];
      });
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError("Tavily", "request failed", { cause: error });
    } finally {
      request.cleanup();
    }
  }
}

export class BraveWebSearch implements WebSearchProvider {
  readonly name = "brave" as const;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: ProviderOptions) {
    this.apiKey = validKey(options.apiKey);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async search(input: WebSearchInput): Promise<WebSearchResult[]> {
    const { signal: callerSignal, ...candidate } = input;
    const parsed = searchInputSchema.parse(candidate);
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", parsed.query);
    url.searchParams.set("count", String(parsed.maxResults));
    url.searchParams.set("safesearch", "moderate");
    if (parsed.topic === "news") url.searchParams.set("freshness", "pw");

    const request = createRequestSignal(this.timeoutMs, callerSignal);
    try {
      const response = await this.fetcher(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": this.apiKey,
        },
        signal: request.signal,
      });
      const payload = await readResponseBody(response);
      if (!response.ok) {
        throw new IntegrationError("Brave Search", responseErrorMessage(payload), {
          status: response.status,
          retryAfterSeconds: retryAfterSeconds(response),
        });
      }
      const web = asRecord(asRecord(payload)?.web);
      const results = web?.results;
      if (!Array.isArray(results)) return [];
      return results.flatMap((value): WebSearchResult[] => {
        const row = asRecord(value);
        if (!row || typeof row.title !== "string" || typeof row.url !== "string") {
          return [];
        }
        return [
          {
            title: row.title,
            url: row.url,
            snippet: typeof row.description === "string" ? row.description : "",
            ...(typeof row.age === "string" ? { publishedAt: row.age } : {}),
          },
        ];
      });
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError("Brave Search", "request failed", {
        cause: error,
      });
    } finally {
      request.cleanup();
    }
  }
}

/** Returns null when web search is intentionally not configured. */
export function createConfiguredWebSearch(
  preferred?: "tavily" | "brave",
): WebSearchProvider | null {
  const config = getServerConfig();
  if (preferred === "tavily") {
    if (!config.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is not configured");
    return new TavilyWebSearch({ apiKey: config.TAVILY_API_KEY });
  }
  if (preferred === "brave") {
    if (!config.BRAVE_SEARCH_API_KEY) {
      throw new Error("BRAVE_SEARCH_API_KEY is not configured");
    }
    return new BraveWebSearch({ apiKey: config.BRAVE_SEARCH_API_KEY });
  }
  if (config.TAVILY_API_KEY) {
    return new TavilyWebSearch({ apiKey: config.TAVILY_API_KEY });
  }
  if (config.BRAVE_SEARCH_API_KEY) {
    return new BraveWebSearch({ apiKey: config.BRAVE_SEARCH_API_KEY });
  }
  return null;
}
