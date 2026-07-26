import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest, AuthenticationError } from "@/lib/auth";
import { conversationRepository } from "@/lib/repositories/conversations";
import { messageRepository } from "@/lib/repositories/messages";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const createSchema = z.object({ title: z.string().trim().min(1).max(120).default("新对话") }).strict();

function errorResponse(error: unknown, requestId: string) {
  if (error instanceof AuthenticationError) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "登录已过期，请重新登录", requestId } }, { status: 401 });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "请求参数不正确", requestId, details: error.flatten() } }, { status: 400 });
  }
  console.error("conversations API failed", { requestId, error });
  return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "会话服务暂时不可用", requestId } }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID();
  try {
    const auth = await authenticateRequest(request);
    const dataClient = createServiceRoleSupabaseClient();
    const conversations = conversationRepository(dataClient);
    const idValue = request.nextUrl.searchParams.get("id");
    if (!idValue) {
      const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
      const items = await conversations.list(auth.userId, { limit: 100, cursor });
      return NextResponse.json({ conversations: items }, { headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
    }

    const id = idSchema.parse(idValue);
    const conversation = await conversations.get(auth.userId, id);
    if (!conversation) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "会话不存在", requestId } }, { status: 404 });
    }
    const messages = await messageRepository(dataClient).list(auth.userId, id, { limit: 500 });
    return NextResponse.json({ conversation, messages }, { headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  try {
    const auth = await authenticateRequest(request);
    const dataClient = createServiceRoleSupabaseClient();
    const input = createSchema.parse(await request.json());
    const conversation = await conversationRepository(dataClient).create(auth.userId, input);
    return NextResponse.json({ conversation }, { status: 201, headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}

export async function DELETE(request: NextRequest) {
  const requestId = crypto.randomUUID();
  try {
    const auth = await authenticateRequest(request);
    const dataClient = createServiceRoleSupabaseClient();
    const id = idSchema.parse(request.nextUrl.searchParams.get("id"));
    const removed = await conversationRepository(dataClient).remove(auth.userId, id);
    if (!removed) {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "会话不存在", requestId } }, { status: 404 });
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store", "X-Request-ID": requestId } });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
