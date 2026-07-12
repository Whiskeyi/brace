"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { AuthPanel } from "./auth-panel";
import { Composer } from "./composer";
import { EmptyState } from "./empty-state";
import { MenuIcon, SparkIcon } from "./icons";
import { MessageList } from "./message-list";
import { Sidebar } from "./sidebar";
import type { ChatMessage, Conversation, StreamEvent, ToolActivity } from "./types";

function makeId(prefix: string) {
  return `${prefix}_${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}_${Math.random()}`}`;
}

function normalizeConversation(value: Record<string, unknown>): Conversation {
  return {
    id: String(value.id),
    title: String(value.title || "新对话"),
    createdAt: String(value.createdAt || value.created_at || new Date().toISOString()),
    updatedAt: String(value.updatedAt || value.updated_at || value.createdAt || value.created_at || new Date().toISOString()),
  };
}

function normalizeMessage(value: Record<string, unknown>): ChatMessage | null {
  const role = value.role;
  if (role !== "user" && role !== "assistant") return null;
  return {
    id: String(value.id),
    role,
    content: String(value.content || ""),
    createdAt: String(value.createdAt || value.created_at || new Date().toISOString()),
    status: "complete",
  };
}

async function apiFetch<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const data = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
  if (!response.ok) {
    const error = typeof data?.error === "string" ? data.error : data?.error?.message;
    throw new Error(error || `请求失败（${response.status}）`);
  }
  return data as T;
}

function eventText(event: StreamEvent) {
  for (const key of ["delta", "content", "text"]) {
    if (typeof event[key] === "string") return event[key] as string;
  }
  return "";
}

function toolFromEvent(event: StreamEvent): ToolActivity {
  return {
    id: String(event.toolCallId || event.callId || event.id || makeId("tool")),
    name: String(event.toolName || event.name || "工具"),
    status: "running",
    input: event.input ?? event.arguments ?? event.args,
  };
}

function SplashScreen() {
  return <main className="splash-screen"><span className="splash-mark"><SparkIcon size={27} /></span><span className="splash-line" /></main>;
}

export function AgentWorkspace() {
  const auth = useAuth();
  const token = auth.session?.access_token ?? null;
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [draftPrompt, setDraftPrompt] = useState<{ id: string; value: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loadedUserIdRef = useRef<string | null>(null);

  const loadConversations = useCallback(async (accessToken: string, resetWorkspace: boolean) => {
    setLoadingConversations(true);
    try {
      const result = await apiFetch<{ conversations: Array<Record<string, unknown>> }>("/api/conversations", accessToken);
      setConversations((result.conversations || []).map(normalizeConversation));
      if (resetWorkspace) {
        setCurrentId(null);
        setMessages([]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法加载历史会话");
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  useEffect(() => {
    if (!token || !auth.user) return;
    const resetWorkspace = loadedUserIdRef.current !== auth.user.id;
    loadedUserIdRef.current = auth.user.id;
    void loadConversations(token, resetWorkspace);
  }, [auth.user, loadConversations, token]);

  const selectConversation = useCallback(async (id: string) => {
    if (!token || id === currentId || busy) return;
    setCurrentId(id);
    setLoadingMessages(true);
    setNotice(null);
    try {
      const result = await apiFetch<{ messages: Array<Record<string, unknown>> }>(`/api/conversations?id=${encodeURIComponent(id)}`, token);
      setMessages((result.messages || []).map(normalizeMessage).filter((item): item is ChatMessage => item !== null));
    } catch (error) {
      setMessages([]);
      setNotice(error instanceof Error ? error.message : "无法加载会话消息");
    } finally {
      setLoadingMessages(false);
    }
  }, [busy, currentId, token]);

  const createConversation = useCallback(() => {
    if (busy) return;
    setCurrentId(null);
    setMessages([]);
    setNotice(null);
  }, [busy]);

  const deleteConversation = useCallback(async (id: string) => {
    if (!token || busy) return;
    if (!window.confirm("确定删除这个会话吗？此操作无法撤销。")) return;
    try {
      await apiFetch<{ ok: boolean }>(`/api/conversations?id=${encodeURIComponent(id)}`, token, { method: "DELETE" });
      setConversations((items) => items.filter((item) => item.id !== id));
      if (currentId === id) createConversation();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败");
    }
  }, [busy, createConversation, currentId, token]);

  const sendMessage = useCallback(async (content: string) => {
    if (!token || busy) return;
    setNotice(null);
    setBusy(true);

    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: makeId("user"), role: "user", content, createdAt: now, status: "complete" };
    const assistantId = makeId("assistant");
    const assistantMessage: ChatMessage = { id: assistantId, role: "assistant", content: "", createdAt: now, status: "streaming", tools: [] };
    setMessages((items) => [...items, userMessage, assistantMessage]);

    let conversationId = currentId;
    try {
      if (!conversationId) {
        const title = content.replace(/\s+/g, " ").slice(0, 32) || "新对话";
        const created = await apiFetch<{ conversation: Record<string, unknown> }>("/api/conversations", token, {
          method: "POST",
          body: JSON.stringify({ title }),
        });
        const conversation = normalizeConversation(created.conversation);
        conversationId = conversation.id;
        setCurrentId(conversation.id);
        setConversations((items) => [conversation, ...items]);
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const idempotencyKey = makeId("msg");
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ conversationId, message: content, idempotencyKey }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
        const message = typeof detail?.error === "string" ? detail.error : detail?.error?.message;
        throw new Error(message || `Agent 请求失败（${response.status}）`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const applyEvent = (event: StreamEvent) => {
        setMessages((items) => items.map((item) => {
          if (item.id !== assistantId) return item;
          if (event.type === "delta") return { ...item, content: item.content + eventText(event) };
          if (event.type === "tool_call") return { ...item, tools: [...(item.tools || []), toolFromEvent(event)] };
          if (event.type === "tool_result") {
            const id = String(event.toolCallId || event.callId || event.id || "");
            const tools = (item.tools || []).map((tool) => tool.id === id || (!id && tool.status === "running") ? { ...tool, status: event.error ? "error" as const : "complete" as const, output: event.output ?? event.result ?? event.error } : tool);
            return { ...item, tools };
          }
          if (event.type === "done") return { ...item, status: "complete" as const };
          if (event.type === "error") return { ...item, status: "error" as const };
          return item;
        }));
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const payload = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!payload || payload === "[DONE]") continue;
          try { applyEvent(JSON.parse(payload) as StreamEvent); } catch { /* Ignore malformed server heartbeats. */ }
        }
        if (done) break;
      }

      setMessages((items) => items.map((item) => item.id === assistantId && item.status === "streaming" ? { ...item, status: "complete" } : item));
      setConversations((items) => items.map((item) => item.id === conversationId ? { ...item, updatedAt: new Date().toISOString() } : item));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, status: "stopped" } : item));
      } else {
        setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, status: "error" } : item));
        setNotice(error instanceof Error ? error.message : "生成回答时发生错误");
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, [busy, currentId, token]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const retry = useCallback(() => {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser || busy) return;
    setMessages((items) => items.filter((item) => item.status !== "error"));
    void sendMessage(lastUser.content);
  }, [busy, messages, sendMessage]);

  if (auth.loading) return <SplashScreen />;
  if (!auth.user || !auth.session) {
    return <AuthPanel configured={auth.configured} configurationError={auth.error} onSignIn={auth.signIn} onSignUp={auth.signUp} />;
  }

  return (
    <main className="app-shell">
      <Sidebar
        conversations={conversations}
        currentId={currentId}
        email={auth.user.email || "用户"}
        loading={loadingConversations}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
        onCreate={createConversation}
        onDelete={deleteConversation}
        onSelect={selectConversation}
        onSignOut={() => {
          abortRef.current?.abort();
          loadedUserIdRef.current = null;
          setConversations([]);
          setCurrentId(null);
          setMessages([]);
          setNotice(null);
          void auth.signOut().catch((error) => setNotice(error instanceof Error ? error.message : "退出登录失败"));
        }}
      />
      <section className="chat-panel">
        <header className="chat-header">
          <button className="icon-button mobile-menu" aria-label="打开会话列表" onClick={() => setMobileOpen(true)} type="button"><MenuIcon /></button>
          <div className="chat-title"><strong>{currentId ? conversations.find((item) => item.id === currentId)?.title || "对话" : "新对话"}</strong><span><i /> Agent 在线</span></div>
          <div className="model-badge"><SparkIcon size={13} /><span>通用 Agent</span></div>
        </header>

        <div className="chat-content">
          {notice ? <div className="global-notice" role="alert"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice(null)} type="button">×</button></div> : null}
          {messages.length === 0 && !loadingMessages ? <EmptyState onPrompt={(prompt) => setDraftPrompt({ id: makeId("draft"), value: `${prompt} ` })} /> : <MessageList loading={loadingMessages} messages={messages} onRetry={retry} />}
        </div>
        <Composer busy={busy} initialValue={draftPrompt?.value} key={draftPrompt?.id || "composer"} onSend={(content) => { setDraftPrompt(null); void sendMessage(content); }} onStop={stop} />
      </section>
    </main>
  );
}
