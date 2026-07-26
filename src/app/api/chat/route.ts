import { NextRequest } from "next/server";
import { z } from "zod";

import { AGENT_EVENT_PROTOCOL_VERSION } from "@/lib/agent";
import { authenticateRequest, AuthenticationError } from "@/lib/auth";
import { ConfigurationError, getServerConfig } from "@/lib/config";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { createServerAgent } from "@/server/agent/factory";
import { hasExplicitMemoryWriteIntent } from "@/server/agent/tools";
import {
  ChatCommandError,
  prepareChatRun,
  resolveChatCommand,
} from "@/server/chat/command";
import {
  AGENT_SSE_HEADERS,
  chatJsonError,
  replayResponse,
} from "@/server/chat/http";
import { RunEventBuffer } from "@/server/chat/run-event-buffer";
import { RunRecorder } from "@/server/chat/run-recorder";
import { createRecordedAgentStream } from "@/server/chat/stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  try {
    const auth = await authenticateRequest(request);
    const command = resolveChatCommand(
      await request.json(),
      request.headers.get("idempotency-key"),
    );
    const config = getServerConfig();
    if (!config.LLM_API_KEY) {
      return chatJsonError(
        503,
        "MODEL_NOT_CONFIGURED",
        "模型服务尚未配置",
        requestId,
      );
    }
    const dataClient = createServiceRoleSupabaseClient();

    const prepared = await prepareChatRun({
      supabase: dataClient,
      userId: auth.userId,
      config,
      command,
      requestId,
    });
    if (prepared.kind === "replay") {
      return replayResponse(prepared.events, requestId);
    }

    const runController = new AbortController();
    const abortRun = () => runController.abort(request.signal.reason);
    if (request.signal.aborted) abortRun();
    else request.signal.addEventListener("abort", abortRun, { once: true });
    const timeout = setTimeout(
      () => runController.abort(new Error("Agent request timeout")),
      config.AGENT_REQUEST_TIMEOUT_MS,
    );
    const release = () => {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abortRun);
    };

    try {
      const agent = createServerAgent({
        config,
        supabase: dataClient,
        userId: auth.userId,
        conversationId: prepared.conversation.id,
      });
      const eventBuffer = new RunEventBuffer({
        repository: prepared.repositories.runEvents,
        userId: auth.userId,
        runId: prepared.run.id,
      });
      const recorder = new RunRecorder({
        runs: prepared.repositories.runs,
        runSteps: prepared.repositories.runSteps,
        events: eventBuffer,
        userId: auth.userId,
        runId: prepared.run.id,
        conversationId: prepared.conversation.id,
        idempotencyKey: command.idempotencyKey,
        requestId,
      });
      const events = agent.run({
        messages: prepared.messages,
        signal: runController.signal,
        runId: prepared.run.id,
        metadata: {
          userId: auth.userId,
          conversationId: prepared.conversation.id,
          requestHash: prepared.requestHash,
          allowMemoryWrite: hasExplicitMemoryWriteIntent(command.message),
        },
      });
      const stream = createRecordedAgentStream({
        events,
        recorder,
        controller: runController,
        onHeartbeat: async () => {
          const leaseActive = await prepared.repositories.runs.heartbeat(
            auth.userId,
            prepared.run.id,
          );
          if (!leaseActive) {
            const error = new Error("Agent run lease is no longer active");
            runController.abort(error);
            throw error;
          }
        },
        onSettled: release,
      });

      return new Response(stream, {
        headers: { ...AGENT_SSE_HEADERS, "X-Request-ID": requestId },
      });
    } catch (error) {
      release();
      try {
        const timestamp = new Date().toISOString();
        await prepared.repositories.runs.finalize(auth.userId, prepared.run.id, {
          conversationId: prepared.conversation.id,
          status: "failed",
          output: { content: "" },
          error: { code: "initialization_failed" },
          assistantContent: "",
          assistantMetadata: {
            requestKey: command.idempotencyKey,
            requestId,
            status: "failed",
          },
          terminalEvent: {
            sequence: 1,
            type: "error",
            event: {
              protocolVersion: AGENT_EVENT_PROTOCOL_VERSION,
              sequence: 1,
              timestamp,
              runId: prepared.run.id,
              type: "error",
              error: {
                code: "llm_error",
                message: "Agent initialization failed.",
                retryable: true,
              },
            },
          },
        });
      } catch (finalizeError) {
        console.error("chat run initialization finalization failed", {
          requestId,
          error: finalizeError,
        });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return chatJsonError(
        401,
        "UNAUTHORIZED",
        "登录已过期，请重新登录",
        requestId,
      );
    }
    if (error instanceof ChatCommandError) {
      return chatJsonError(
        error.status,
        error.code,
        error.message,
        requestId,
        error.details,
      );
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return chatJsonError(
        400,
        "INVALID_REQUEST",
        "请求参数不正确",
        requestId,
        error instanceof z.ZodError ? error.flatten() : undefined,
      );
    }
    if (error instanceof ConfigurationError) {
      console.error("chat configuration invalid", { requestId, error });
      return chatJsonError(
        503,
        "SERVICE_NOT_CONFIGURED",
        "Agent 服务配置不完整",
        requestId,
      );
    }
    console.error("chat API failed", { requestId, error });
    return chatJsonError(
      500,
      "INTERNAL_ERROR",
      "Agent 服务暂时不可用",
      requestId,
    );
  }
}
