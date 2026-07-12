import { NextResponse } from "next/server";
import { getServerConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getServerConfig();
    const checks = {
      configuration: true,
      supabase: true,
      model: Boolean(config.LLM_API_KEY),
    };
    const ready = checks.model;

    return NextResponse.json(
      {
        status: ready ? "ok" : "degraded",
        checks,
        capabilities: {
          rag: Boolean(
            config.ALIYUN_RAG_BASE_URL
            && config.ALIYUN_RAG_API_KEY
            && config.ALIYUN_RAG_DATASET_IDS?.length
          ),
          managedMemory: Boolean(config.MEM0_HOST && config.MEM0_API_KEY),
          webSearch: Boolean(config.TAVILY_API_KEY || config.BRAVE_SEARCH_API_KEY),
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: ready ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        checks: { configuration: false, supabase: false, model: false },
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
