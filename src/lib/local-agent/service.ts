import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  createOpenAICompatibleModel,
  createOpenAISdkClient,
  probeAgentModelToolCalling,
  type AgentEvent,
  type AgentModel,
  type AgentModelToolProbeOptions,
} from "../agent";
import {
  buildCodingAgentSystemPrompt,
  createCodingAgent,
  loadProjectInstructions,
} from "../coding-agent";
import { createNodeProcessSandbox } from "../sandbox";
import { readGitWorkspaceDiff } from "../tools";
import { createNodeWorkspace } from "../workspace";
import { LocalApprovalCoordinator } from "./approvals";
import type { LocalAgentConfig } from "./config";
import {
  buildLocalAgentContext,
  formatLocalRunStatusCompletion,
} from "./context";
import {
  buildProviderRequestOptions,
  getModelCapabilityProbeProfile,
  getModelProvider,
} from "../model-providers";
import {
  decideLocalApprovalSchema,
  localRunRequestSchema,
  localThreadRequestSchema,
  resolveLocalWorktreeSchema,
  startLocalTaskSchema,
} from "./protocol";
import type { LocalAgentStore } from "./store";
import type {
  LocalAgentSnapshot,
  LocalClientEvent,
  LocalExecutionMode,
  LocalMessage,
  LocalProject,
  LocalRun,
  LocalThread,
  LocalThreadDetail,
  LocalWorktreeResolution,
} from "./types";
import {
  LocalWorktreeManager,
  type LocalWorktreeMetadata,
} from "./worktrees";

export interface LocalCodingServiceOptions {
  readonly store: LocalAgentStore;
  readonly config: LocalAgentConfig;
  readonly worktreeRoot: string;
  readonly onEvent?: (event: LocalClientEvent) => void;
  readonly modelFactory?: (config: LocalAgentConfig) => AgentModel;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
}

interface ActiveRun {
  readonly threadId: string;
  readonly controller: AbortController;
}

const LOCAL_EVENT_BATCH_SIZE = 32;
const MIN_LOCAL_TOOL_RESULT_BYTES = 256;
const MAX_LOCAL_TOOL_RESULT_BYTES = 64 * 1024;

export class LocalCodingService {
  readonly #store: LocalAgentStore;
  readonly #config: LocalAgentConfig;
  readonly #worktrees: LocalWorktreeManager;
  readonly #onEvent: (event: LocalClientEvent) => void;
  readonly #modelFactory: (config: LocalAgentConfig) => AgentModel;
  readonly #idGenerator: () => string;
  readonly #now: () => Date;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #reservedProjectIds = new Set<string>();
  readonly #idleWaiters = new Set<() => void>();
  readonly #approvals: LocalApprovalCoordinator;
  #disposed = false;
  #disposePromise: Promise<void> | null = null;

  constructor(options: LocalCodingServiceOptions) {
    this.#store = options.store;
    this.#config = options.config;
    this.#worktrees = new LocalWorktreeManager(options.worktreeRoot);
    this.#onEvent = options.onEvent ?? (() => {});
    this.#modelFactory = options.modelFactory ?? createLocalModel;
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
    this.#store.recoverInterruptedRuns(this.#now().toISOString());
    this.#approvals = new LocalApprovalCoordinator({
      store: this.#store,
      idGenerator: this.#idGenerator,
      now: this.#now,
      onApprovalChanged: (approval) =>
        this.#emit({ type: "approval.changed", approval }),
      onWaitingChanged: (runId, waiting) =>
        this.#setWaitingState(runId, waiting),
    });
  }

  snapshot(): LocalAgentSnapshot {
    return this.#store.getSnapshot([...this.#activeRuns.keys()]);
  }

  hasInFlightOperations(): boolean {
    return this.#reservedProjectIds.size > 0 || this.#activeRuns.size > 0;
  }

  async addProject(rootPath: string): Promise<LocalProject> {
    const canonicalRoot = await realpath(path.resolve(rootPath));
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new Error("The selected project path is not a directory.");
    }
    const now = this.#now().toISOString();
    const project = this.#store.upsertProject({
      id: this.#idGenerator(),
      name: path.basename(canonicalRoot),
      rootPath: canonicalRoot,
      createdAt: now,
      lastOpenedAt: now,
    });
    this.#emit({ type: "project.changed", project });
    return project;
  }

  getThread(input: unknown): LocalThreadDetail {
    const { threadId } = localThreadRequestSchema.parse(input);
    const detail = this.#store.getThreadDetail(threadId);
    if (!detail) throw new Error("Local task thread not found.");
    return detail;
  }

  async startTask(rawInput: unknown): Promise<{
    readonly thread: LocalThread;
    readonly run: LocalRun;
  }> {
    if (this.#disposed) {
      throw new Error("The local coding service is shutting down.");
    }
    const input = startLocalTaskSchema.parse(rawInput);
    if (!this.#config.LLM_API_KEY) {
      throw new Error(
        "Model API key is not configured. Open Settings and add an API key before starting a task.",
      );
    }
    const project = this.#store.getProject(input.projectId);
    if (!project) throw new Error("Local project not found.");
    let thread = input.threadId
      ? this.#store.getThread(input.threadId)
      : null;
    if (input.threadId && !thread) throw new Error("Local task thread not found.");
    if (thread && thread.projectId !== project.id) {
      throw new Error("The task thread does not belong to this project.");
    }
    if (thread?.worktreeCleanupCommit) {
      throw new Error(
        "Finish the pending worktree cleanup before continuing this task.",
      );
    }

    if (this.#reservedProjectIds.has(project.id)) {
      throw new Error(
        "Parallel tasks in the same project are not supported. Stop the active task or wait for it to finish.",
      );
    }
    this.#reservedProjectIds.add(project.id);

    let createdWorktreeThreadId: string | null = null;
    let persistedStart = false;
    try {
      const now = this.#now().toISOString();
      let newThread: LocalThread | undefined;
      if (!thread) {
        const threadId = this.#idGenerator();
        const workspacePath = await this.#workspaceForMode(
          project,
          input.mode,
          threadId,
        );
        if (input.mode === "worktree") {
          createdWorktreeThreadId = threadId;
        }
        if (this.#disposed) {
          throw new Error("The local coding service is shutting down.");
        }
        newThread = {
          id: threadId,
          projectId: project.id,
          title: titleFromPrompt(input.prompt),
          mode: input.mode,
          workspacePath,
          worktreeCleanupCommit: null,
          status: "idle",
          createdAt: now,
          updatedAt: now,
        };
        thread = newThread;
      }

      const message: LocalMessage = {
        id: this.#idGenerator(),
        threadId: thread.id,
        role: "user",
        content: input.prompt,
        createdAt: now,
      };
      const run: LocalRun = {
        id: this.#idGenerator(),
        threadId: thread.id,
        status: "running",
        model: this.#config.LLM_MODEL,
        startedAt: now,
        finishedAt: null,
        errorMessage: null,
      };
      this.#store.insertTaskStart({
        ...(newThread ? { thread: newThread } : {}),
        message,
        run,
      });
      persistedStart = true;
      thread = { ...thread, status: "running", updatedAt: now };
      const controller = new AbortController();
      this.#activeRuns.set(run.id, {
        threadId: thread.id,
        controller,
      });
      this.#emit({ type: "thread.changed", thread });
      this.#emit({ type: "run.changed", run });
      void this.#execute(run, thread, message.id, controller).catch(() => {});
      return { thread, run };
    } catch (error) {
      if (createdWorktreeThreadId && !persistedStart) {
        await this.#worktrees
          .remove(project.rootPath, project.id, createdWorktreeThreadId, {
            force: true,
            deleteBranch: true,
          })
          .catch(() => undefined);
      }
      this.#reservedProjectIds.delete(project.id);
      throw error;
    } finally {
      this.#notifyIdle();
    }
  }

  cancelTask(rawInput: unknown): LocalRun {
    const { runId } = localRunRequestSchema.parse(rawInput);
    const active = this.#activeRuns.get(runId);
    if (!active) {
      const run = this.#store.getRun(runId);
      if (!run) throw new Error("Local run not found.");
      return run;
    }
    active.controller.abort(new Error("Cancelled by the user."));
    this.#approvals.cancelRun(runId);
    return this.#store.getRun(runId) as LocalRun;
  }

  decideApproval(rawInput: unknown) {
    const input = decideLocalApprovalSchema.parse(rawInput);
    return this.#approvals.decide(input.approvalId, input.decision);
  }

  async getDiff(rawInput: unknown): Promise<string> {
    const { threadId } = localThreadRequestSchema.parse(rawInput);
    const thread = this.#store.getThread(threadId);
    if (!thread) throw new Error("Local task thread not found.");
    const sandbox = await createNodeProcessSandbox({
      root: thread.workspacePath,
      allowedExecutables: ["git"],
      environmentVariableAllowlist: this.#config.DESKTOP_ENV_ALLOWLIST,
      maxOutputBytes: 2 * 1024 * 1024,
    });
    try {
      const result = await readGitWorkspaceDiff(sandbox, ".");
      return result.diff;
    } catch (error) {
      throw new Error("Unable to read the Git diff for this task.", {
        cause: error,
      });
    }
  }

  async getWorktree(rawInput: unknown): Promise<LocalWorktreeMetadata | null> {
    const { threadId } = localThreadRequestSchema.parse(rawInput);
    const thread = this.#store.getThread(threadId);
    if (!thread) throw new Error("Local task thread not found.");
    if (thread.mode !== "worktree" && !thread.worktreeCleanupCommit) {
      return null;
    }
    const project = this.#store.getProject(thread.projectId);
    if (!project) throw new Error("Local project not found.");
    return this.#worktrees.inspect(project.rootPath, project.id, thread.id);
  }

  async resolveWorktree(
    rawInput: unknown,
  ): Promise<LocalWorktreeResolution> {
    if (this.#disposed) {
      throw new Error("The local coding service is shutting down.");
    }
    const input = resolveLocalWorktreeSchema.parse(rawInput);
    const thread = this.#store.getThread(input.threadId);
    if (!thread) throw new Error("Local task thread not found.");
    const project = this.#store.getProject(thread.projectId);
    if (!project) throw new Error("Local project not found.");
    if (input.action === "cleanup") {
      if (
        thread.mode !== "local" ||
        thread.workspacePath !== project.rootPath ||
        !thread.worktreeCleanupCommit
      ) {
        throw new Error(
          "This task does not have a pending worktree cleanup.",
        );
      }
    } else if (
      thread.mode !== "worktree" ||
      thread.worktreeCleanupCommit
    ) {
      throw new Error(
        "The worktree action does not match the task's current state.",
      );
    }
    if (this.#reservedProjectIds.has(project.id)) {
      throw new Error(
        "Stop the active task before resolving its isolated worktree.",
      );
    }

    this.#reservedProjectIds.add(project.id);
    try {
      if (input.action === "cleanup") {
        const cleanup = await this.#worktrees.retryApplyCleanup(
          project.rootPath,
          project.id,
          thread.id,
          thread.worktreeCleanupCommit as string,
        );
        const updatedThread = this.#store.setThreadWorkspace(
          thread.id,
          "local",
          project.rootPath,
          this.#now().toISOString(),
          cleanup.cleanupPending
            ? thread.worktreeCleanupCommit
            : null,
        );
        this.#emit({ type: "thread.changed", thread: updatedThread });
        return {
          action: input.action,
          thread: updatedThread,
          branchName: cleanup.branchName,
          patchBytes: null,
          cleanupPending: cleanup.cleanupPending,
        };
      }

      const result =
        input.action === "apply"
          ? await this.#worktrees.apply(project.rootPath, project.id, thread.id)
          : await this.#worktrees.remove(
              project.rootPath,
              project.id,
              thread.id,
              { force: true, deleteBranch: true },
            );
      const cleanupCommit =
        "appliedCommit" in result && result.cleanupPending
          ? result.appliedCommit
          : null;
      const updatedThread = this.#store.setThreadWorkspace(
        thread.id,
        "local",
        project.rootPath,
        this.#now().toISOString(),
        cleanupCommit,
      );
      this.#emit({ type: "thread.changed", thread: updatedThread });
      return {
        action: input.action,
        thread: updatedThread,
        branchName:
          result.worktree.branchName ?? result.worktree.expectedBranchName,
        patchBytes: "patchBytes" in result ? result.patchBytes : null,
        cleanupPending:
          "cleanupPending" in result ? result.cleanupPending : false,
      };
    } finally {
      this.#reservedProjectIds.delete(project.id);
      this.#notifyIdle();
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    for (const [runId, active] of this.#activeRuns) {
      active.controller.abort(new Error("Desktop application is shutting down."));
      this.#approvals.cancelRun(runId);
    }
    this.#disposePromise = (async () => {
      await this.#waitForIdle();
      this.#reservedProjectIds.clear();
      this.#store.close();
    })();
    return this.#disposePromise;
  }

  async #execute(
    run: LocalRun,
    thread: LocalThread,
    currentMessageId: string,
    controller: AbortController,
  ): Promise<void> {
    let terminal: "completed" | "failed" | "cancelled" = "failed";
    let errorMessage: string | null = "The run ended without a terminal event.";
    let assistantContent: string | null = null;
    const pendingEvents: AgentEvent[] = [];
    const flushEvents = () => {
      if (pendingEvents.length === 0) return;
      this.#store.appendAgentEvents(thread.id, pendingEvents);
      pendingEvents.length = 0;
    };
    try {
      const workspace = await createNodeWorkspace({ root: thread.workspacePath });
      const projectInstructions = await loadProjectInstructions(workspace);
      const systemPrompt = buildCodingAgentSystemPrompt(
        projectInstructions?.content,
      );
      const sandbox = await createNodeProcessSandbox({
        root: thread.workspacePath,
        allowedExecutables: this.#config.DESKTOP_ALLOWED_EXECUTABLES,
        environmentVariableAllowlist: this.#config.DESKTOP_ENV_ALLOWLIST,
        defaultTimeoutMs: this.#config.AGENT_TOOL_TIMEOUT_MS,
        maxTimeoutMs: 120_000,
      });
      const maxOutputTokens = Math.min(
        this.#config.LLM_MAX_OUTPUT_TOKENS,
        Math.floor(this.#config.AGENT_CONTEXT_WINDOW_TOKENS / 2),
      );
      const messageQueryLimit = Math.min(
        this.#config.AGENT_MAX_HISTORY_MESSAGES * 3 + 1,
        3_001,
      );
      const context = buildLocalAgentContext({
        history: this.#store.listRecentMessages(
          thread.id,
          messageQueryLimit,
        ),
        currentMessageId,
        systemPrompt,
        maxHistoryMessages: this.#config.AGENT_MAX_HISTORY_MESSAGES,
        contextWindowTokens: this.#config.AGENT_CONTEXT_WINDOW_TOKENS,
        reservedOutputTokens: maxOutputTokens,
      });
      const agent = createCodingAgent({
        modelProvider: this.#modelFactory(this.#config),
        workspace,
        sandbox,
        interactiveToolPolicy: this.#approvals.policy,
        maxRounds: this.#config.AGENT_MAX_TOOL_ROUNDS,
        maxToolCalls: this.#config.AGENT_MAX_TOOL_CALLS,
        maxToolConcurrency: this.#config.AGENT_MAX_TOOL_CONCURRENCY,
        toolTimeoutMs: this.#config.AGENT_TOOL_TIMEOUT_MS,
        contextWindowTokens: this.#config.AGENT_CONTEXT_WINDOW_TOKENS,
        reservedOutputTokens: maxOutputTokens,
        maxToolResultBytes: localToolResultByteLimit(
          this.#config,
          maxOutputTokens,
          context.estimatedTokens,
        ),
        projectInstructions: projectInstructions?.content,
        temperature: this.#config.LLM_TEMPERATURE,
        requestOptions: buildProviderRequestOptions(
          this.#config.LLM_PROVIDER,
          {
            maxOutputTokens,
            promptCacheScope: `desktop:${thread.id}`,
          },
        ),
      });

      for await (const event of agent.run({
        runId: run.id,
        messages: context.messages,
        signal: controller.signal,
        metadata: {
          localExecution: true,
          projectId: thread.projectId,
          threadId: thread.id,
        },
      })) {
        pendingEvents.push(event);
        if (
          event.type !== "delta" ||
          pendingEvents.length >= LOCAL_EVENT_BATCH_SIZE
        ) {
          flushEvents();
        }
        this.#emit({
          type: "agent.event",
          record: { runId: run.id, threadId: thread.id, event },
        });
        if (event.type === "done") {
          terminal = "completed";
          errorMessage = null;
          assistantContent = event.content || null;
        } else if (event.type === "error") {
          terminal = event.error.code === "aborted" ? "cancelled" : "failed";
          errorMessage = event.error.message;
        }
      }
    } catch (error) {
      terminal = controller.signal.aborted ? "cancelled" : "failed";
      errorMessage = publicError(error);
    } finally {
      try {
        try {
          flushEvents();
        } catch (error) {
          if (terminal !== "cancelled") {
            terminal = "failed";
            errorMessage = publicError(error);
          }
        }
        this.#approvals.cancelRun(run.id);
        const finishedAt = this.#now().toISOString();
        const completion =
          terminal === "completed" && assistantContent
            ? assistantContent
            : formatLocalRunStatusCompletion(terminal, errorMessage);
        const updatedRun = this.#store.setRunStatus(run.id, terminal, {
          now: finishedAt,
          errorMessage,
          assistantMessage: {
            id: this.#idGenerator(),
            threadId: thread.id,
            role: "assistant",
            content: completion,
            createdAt: finishedAt,
          },
        });
        const updatedThread = this.#store.getThread(thread.id) as LocalThread;
        this.#emit({ type: "run.changed", run: updatedRun });
        this.#emit({ type: "thread.changed", thread: updatedThread });
      } finally {
        this.#activeRuns.delete(run.id);
        this.#reservedProjectIds.delete(thread.projectId);
        this.#notifyIdle();
      }
    }
  }

  async #workspaceForMode(
    project: LocalProject,
    mode: LocalExecutionMode,
    threadId: string,
  ): Promise<string> {
    return mode === "local"
      ? project.rootPath
      : this.#worktrees.create(project.rootPath, project.id, threadId);
  }

  #setWaitingState(runId: string, waiting: boolean): void {
    const active = this.#activeRuns.get(runId);
    if (!active || active.controller.signal.aborted) return;
    const current = this.#store.getRun(runId);
    if (!current || !["running", "waiting_for_approval"].includes(current.status)) {
      return;
    }
    const updatedRun = this.#store.setRunStatus(
      runId,
      waiting ? "waiting_for_approval" : "running",
      { now: this.#now().toISOString() },
    );
    const thread = this.#store.getThread(active.threadId) as LocalThread;
    this.#emit({ type: "run.changed", run: updatedRun });
    this.#emit({ type: "thread.changed", thread });
  }

  #emit(event: LocalClientEvent): void {
    try {
      const result = this.#onEvent(event) as unknown;
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        "then" in result
      ) {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Renderer event sinks are observational and must never affect the
      // durable run/worktree state machine.
    }
  }

  #waitForIdle(): Promise<void> {
    if (!this.hasInFlightOperations()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #notifyIdle(): void {
    if (this.hasInFlightOperations()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

export function createLocalModel(config: LocalAgentConfig): AgentModel {
  if (!config.LLM_API_KEY) throw new Error("LLM_API_KEY is not configured.");
  const provider = getModelProvider(config.LLM_PROVIDER);
  const client = createOpenAISdkClient({
    apiKey: config.LLM_API_KEY,
    baseUrl: config.LLM_BASE_URL,
    timeoutMs: config.AGENT_REQUEST_TIMEOUT_MS,
  });
  return createOpenAICompatibleModel(
    client,
    config.LLM_MODEL,
    { requestProfile: provider.requestProfile },
  );
}

export async function testLocalModelConnection(
  config: LocalAgentConfig,
): Promise<{ readonly latencyMs: number }> {
  const profile = getModelCapabilityProbeProfile(
    config.LLM_PROVIDER,
    `${config.LLM_PROVIDER}:${config.LLM_MODEL}`,
  );
  return probeLocalModelCapabilities(
    createLocalModel(config),
    Math.min(config.AGENT_REQUEST_TIMEOUT_MS, 30_000),
    profile,
  );
}

export async function probeLocalModelCapabilities(
  model: AgentModel,
  timeoutMs: number,
  options: Omit<AgentModelToolProbeOptions, "timeoutMs"> = {},
): Promise<{ readonly latencyMs: number }> {
  return probeAgentModelToolCalling(model, { timeoutMs, ...options });
}

function titleFromPrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();
  return singleLine.length <= 80 ? singleLine : `${singleLine.slice(0, 77)}…`;
}

function publicError(error: unknown): string {
  return error instanceof Error ? error.message : "The local task failed.";
}

function localToolResultByteLimit(
  config: LocalAgentConfig,
  reservedOutputTokens: number,
  initialInputTokens: number,
): number {
  const availableInputTokens = Math.max(
    1,
    config.AGENT_CONTEXT_WINDOW_TOKENS -
      reservedOutputTokens -
      initialInputTokens,
  );
  const bytesPerCall = Math.floor(
    (availableInputTokens * 3) / config.AGENT_MAX_TOOL_CALLS,
  );
  return Math.min(
    MAX_LOCAL_TOOL_RESULT_BYTES,
    Math.max(MIN_LOCAL_TOOL_RESULT_BYTES, bytesPerCall),
  );
}
