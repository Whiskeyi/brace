import "server-only";

import type { ServerConfig } from "@/lib/config";

export interface DependencyProbe {
  readonly ok: boolean;
  readonly status: number | null;
  readonly latencyMs: number;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly checks: {
    readonly configuration: true;
    readonly supabase: DependencyProbe;
    readonly dataPlane: DependencyProbe;
    readonly model: DependencyProbe;
  };
}

export async function probeReadiness(
  config: ServerConfig,
  options: {
    readonly fetcher?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): Promise<ReadinessResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const modelBase = config.LLM_BASE_URL ?? "https://api.openai.com/v1";
  const [supabase, dataPlane, model] = await Promise.all([
    probe(
      `${config.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health`,
      {
        apikey: config.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${config.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
      fetcher,
      timeoutMs,
    ),
    probe(
      `${config.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/agent_run_events?select=run_id&limit=1`,
      {
        apikey: config.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      fetcher,
      timeoutMs,
    ),
    config.LLM_API_KEY
      ? probe(
          `${modelBase}/models`,
          { Authorization: `Bearer ${config.LLM_API_KEY}` },
          fetcher,
          timeoutMs,
        )
      : Promise.resolve({ ok: false, status: null, latencyMs: 0 }),
  ]);
  return {
    ready: supabase.ok && dataPlane.ok && model.ok,
    checks: { configuration: true, supabase, dataPlane, model },
  };
}

async function probe(
  url: string,
  headers: Readonly<Record<string, string>>,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<DependencyProbe> {
  const startedAt = performance.now();
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch {
    return {
      ok: false,
      status: null,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}
