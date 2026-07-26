import { NextResponse } from "next/server";

import { getServerConfig } from "@/lib/config";
import { probeReadiness } from "@/server/health/probes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const config = getServerConfig();
    const result = await probeReadiness(config);
    return NextResponse.json(
      {
        status: result.ready ? "ok" : "degraded",
        checks: result.checks,
        capabilities: {
          rag: Boolean(
            config.ALIYUN_RAG_BASE_URL &&
              config.ALIYUN_RAG_API_KEY &&
              config.ALIYUN_RAG_DATASET_IDS?.length
          ),
          managedMemory: Boolean(config.MEM0_HOST && config.MEM0_API_KEY),
          webSearch: Boolean(config.TAVILY_API_KEY || config.BRAVE_SEARCH_API_KEY),
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: result.ready ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        checks: {
          configuration: false,
          supabase: null,
          dataPlane: null,
          model: null,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
