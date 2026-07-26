export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolActivity = {
  id: string;
  callId: string;
  round: number;
  name: string;
  status: "running" | "complete" | "error";
  input?: unknown;
  output?: unknown;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status?: "streaming" | "complete" | "stopped" | "error";
  tools?: ToolActivity[];
  requestKey?: string;
};

export type StreamEvent = AgentEvent;
import type { AgentEvent } from "@/lib/agent/types";
