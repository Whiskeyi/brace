import "server-only";

import { NextResponse } from "next/server";

import {
  encodeAgentEvent,
  encodeAgentStreamEnd,
  type AgentEvent,
} from "@/lib/agent";

export const AGENT_SSE_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  "Content-Type": "text/event-stream; charset=utf-8",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "X-Agent-Protocol-Version": "1",
} as const;

export function chatJsonError(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        requestId,
        ...(details === undefined ? {} : { details }),
      },
    },
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Request-ID": requestId },
    },
  );
}

export function replayResponse(
  events: readonly AgentEvent[],
  requestId: string,
): Response {
  const body = `${events.map(encodeAgentEvent).join("")}${encodeAgentStreamEnd()}`;
  return new Response(body, {
    headers: {
      ...AGENT_SSE_HEADERS,
      "X-Request-ID": requestId,
      "X-Idempotent-Replay": "true",
    },
  });
}
