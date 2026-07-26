import { describe, expect, it, vi } from "vitest";

import { getServerConfig } from "@/lib/config";
import { probeReadiness } from "@/server/health/probes";

vi.mock("server-only", () => ({}));

const config = getServerConfig({
  NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.com",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anonymous-key-with-enough-length",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-with-enough-length",
  LLM_BASE_URL: "https://model.example.com/v1",
  LLM_API_KEY: "model-key-value",
});

describe("dependency readiness probes", () => {
  it("checks auth, the Service Role data plane, and the model without exposing credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const result = await probeReadiness(config, { fetcher });

    expect(result.ready).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://supabase.example.com/auth/v1/health",
      "https://supabase.example.com/rest/v1/agent_run_events?select=run_id&limit=1",
      "https://model.example.com/v1/models",
    ]);
    expect(JSON.stringify(result)).not.toContain("model-key-value");
    expect(JSON.stringify(result)).not.toContain("anonymous-key-with-enough-length");
    expect(JSON.stringify(result)).not.toContain("service-role-key-with-enough-length");
  });

  it("reports degraded when either dependency is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));

    await expect(probeReadiness(config, { fetcher })).resolves.toMatchObject({
      ready: false,
      checks: {
        supabase: { ok: true },
        dataPlane: { ok: true },
        model: { ok: false, status: 503 },
      },
    });
  });

  it("fails readiness when migration 003 or Service Role access is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(probeReadiness(config, { fetcher })).resolves.toMatchObject({
      ready: false,
      checks: { dataPlane: { ok: false, status: 404 } },
    });
  });
});
