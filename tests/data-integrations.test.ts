import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AliyunRagClient,
  BraveWebSearch,
  RdsMem0Client,
  TavilyWebSearch,
} from "@/lib/integrations";

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Alibaba Cloud RAG context adapter", () => {
  it("uses the single-dataset path, context-only body, and header API key", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ context: ["chunk"] }));
    const client = new AliyunRagClient({
      baseUrl: "https://rds.example.com",
      apiKey: "service-key-never-in-the-url",
      fetch: fetcher,
    });

    const result = await client.queryContext({
      query: "退款规则",
      datasetIds: ["dataset-one"],
      mode: "hybrid",
      topK: 5,
    });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://rds.example.com/rag/v1/datasets/dataset-one/query",
    );
    expect(url).not.toContain("service-key-never-in-the-url");
    expect(new Headers(init.headers).get("apikey")).toBe(
      "service-key-never-in-the-url",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      query: "退款规则",
      mode: "hybrid",
      only_need_context: true,
      top_k: 5,
    });
    expect(result.context).toEqual(["chunk"]);
  });

  it("uses the dedicated cross-dataset context endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ data: { contexts: [{ dataset_id: "one", text: "A" }] } }),
    );
    const client = new AliyunRagClient({
      baseUrl: "https://rds.example.com/rag",
      apiKey: "anon-key-with-enough-length",
      accessToken: "rag-user-access-token",
      fetch: fetcher,
    });

    const result = await client.queryContext({
      query: "对比规则",
      datasetIds: ["one", "two", "one"],
      maxResultsPerDataset: 6,
    });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://rds.example.com/rag/v1/datasets/cross-query/context",
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer rag-user-access-token",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      query: "对比规则",
      dataset_ids: ["one", "two"],
      only_need_context: true,
      max_results_per_dataset: 6,
    });
    expect(result.datasetIds).toEqual(["one", "two"]);
    expect(result.context).toEqual([{ dataset_id: "one", text: "A" }]);
  });
});

describe("optional web search adapters", () => {
  it("keeps Tavily credentials in the Authorization header", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        results: [
          { title: "Result", url: "https://example.com", content: "Snippet", score: 0.9 },
        ],
      }),
    );
    const provider = new TavilyWebSearch({
      apiKey: "tavily-secret-key-value",
      fetch: fetcher,
    });
    const results = await provider.search({ query: "latest docs", maxResults: 3 });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("tavily-secret-key-value");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer tavily-secret-key-value",
    );
    expect(results[0]).toMatchObject({ title: "Result", snippet: "Snippet" });
  });

  it("keeps Brave credentials in X-Subscription-Token", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        web: { results: [{ title: "Result", url: "https://example.com", description: "Snippet" }] },
      }),
    );
    const provider = new BraveWebSearch({
      apiKey: "brave-secret-key-value",
      fetch: fetcher,
    });
    await provider.search({ query: "RDS AI" });
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).not.toContain("brave-secret-key-value");
    expect(new Headers(init.headers).get("x-subscription-token")).toBe(
      "brave-secret-key-value",
    );
  });
});

describe("RDS Long-Term Memory adapter", () => {
  it("normalizes the host and sends add/search with explicit user isolation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: "memory-1" }] }))
      .mockResolvedValueOnce(jsonResponse({ results: [{ memory: "likes tea" }] }));
    const client = new RdsMem0Client({
      host: "http://memory.example.com:80/",
      apiKey: "mem0-service-key-value",
      enableGraph: true,
      fetch: fetcher,
    });

    await client.add({
      userId: "user-001",
      agentId: "universal-agent",
      messages: [{ role: "user", content: "I like tea" }],
    });
    await client.search({ userId: "user-001", query: "drink preference", limit: 5 });

    const [addUrl, addInit] = fetcher.mock.calls[0] as [string, RequestInit];
    const [searchUrl, searchInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(addUrl).toBe("http://memory.example.com/memory/v1/memories/");
    expect(searchUrl).toBe(
      "http://memory.example.com/memory/v2/memories/search/",
    );
    expect(addUrl).not.toContain("mem0-service-key-value");
    expect(new Headers(addInit.headers).get("authorization")).toBe(
      "Token mem0-service-key-value",
    );
    expect(JSON.parse(addInit.body as string)).toMatchObject({
      user_id: "user-001",
      agent_id: "universal-agent",
      enable_graph: true,
    });
    expect(JSON.parse(searchInit.body as string)).toMatchObject({
      user_id: "user-001",
      query: "drink preference",
      limit: 5,
      enable_graph: true,
    });
  });

  it("rejects caller attempts to override model selection", async () => {
    const client = new RdsMem0Client({
      host: "https://memory.example.com/memory",
      apiKey: "mem0-service-key-value",
      fetch: vi.fn(),
    });
    await expect(
      client.search({
        userId: "user-001",
        query: "preference",
        model: "caller-controlled-model",
      } as never),
    ).rejects.toThrow();
  });
});
