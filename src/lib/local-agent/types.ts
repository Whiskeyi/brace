import type { AgentEvent, AgentMessage } from "../agent";
import type { ToolEffect } from "../tools";
import type { ModelProviderId } from "../model-providers";

export type LocalExecutionMode = "local" | "worktree";
export type LocalRunStatus =
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";
export type LocalThreadStatus = "idle" | LocalRunStatus;
export type LocalApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled";

export interface LocalProject {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
}

export interface LocalThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly mode: LocalExecutionMode;
  readonly workspacePath: string;
  readonly worktreeCleanupCommit?: string | null;
  readonly status: LocalThreadStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalMessage {
  readonly id: string;
  readonly threadId: string;
  readonly role: Extract<AgentMessage["role"], "user" | "assistant">;
  readonly content: string;
  readonly createdAt: string;
}

export interface LocalRun {
  readonly id: string;
  readonly threadId: string;
  readonly status: LocalRunStatus;
  readonly model: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly errorMessage: string | null;
}

export interface LocalApproval {
  readonly id: string;
  readonly runId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly effect: Exclude<ToolEffect, "read">;
  readonly arguments: unknown;
  readonly status: LocalApprovalStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface LocalAgentEventRecord {
  readonly runId: string;
  readonly threadId: string;
  readonly event: AgentEvent;
}

export interface LocalThreadDetail {
  readonly thread: LocalThread;
  readonly messages: readonly LocalMessage[];
  readonly runs: readonly LocalRun[];
  readonly events: readonly LocalAgentEventRecord[];
  readonly approvals: readonly LocalApproval[];
}

export interface LocalAgentSnapshot {
  readonly projects: readonly LocalProject[];
  readonly threads: readonly LocalThread[];
  readonly activeRunIds: readonly string[];
}

export interface LocalModelSettings {
  readonly provider: ModelProviderId;
  readonly providers: readonly LocalModelProviderOption[];
  readonly baseUrl: string;
  readonly model: string;
  readonly hasApiKey: boolean;
  readonly apiKeySource: "secure_storage" | "environment" | "none";
  readonly secureStorageAvailable: boolean;
}

export interface LocalModelProviderOption {
  readonly id: ModelProviderId;
  readonly label: string;
  readonly description: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly recommendedModels: readonly string[];
  readonly apiKeyHint: string;
  readonly notice?: string;
}

export interface LocalModelConnectionResult {
  readonly provider: ModelProviderId;
  readonly baseUrl: string;
  readonly model: string;
  readonly latencyMs: number;
}

export interface LocalWorktreeResolution {
  readonly action: "apply" | "discard" | "cleanup";
  readonly thread: LocalThread;
  readonly branchName: string;
  readonly patchBytes: number | null;
  readonly cleanupPending: boolean;
}

export type LocalClientEvent =
  | {
      readonly type: "project.changed";
      readonly project: LocalProject;
    }
  | {
      readonly type: "thread.changed";
      readonly thread: LocalThread;
    }
  | {
      readonly type: "run.changed";
      readonly run: LocalRun;
    }
  | {
      readonly type: "agent.event";
      readonly record: LocalAgentEventRecord;
    }
  | {
      readonly type: "approval.changed";
      readonly approval: LocalApproval;
    };
