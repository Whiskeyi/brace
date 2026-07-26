import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Process liveness only. Dependency readiness lives at /api/health/ready. */
export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      checks: { process: true },
      timestamp: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
