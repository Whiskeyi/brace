import type {
  ToolPolicy,
  ToolPolicyDecision,
  ToolPolicyRequest,
} from "../agent";
import type { LocalAgentStore } from "./store";
import type { LocalApproval } from "./types";

interface PendingApproval {
  readonly approval: LocalApproval;
  readonly resolve: (decision: ToolPolicyDecision) => void;
  readonly removeAbortListener: () => void;
}

export interface LocalApprovalCoordinatorOptions {
  readonly store: LocalAgentStore;
  readonly onApprovalChanged: (approval: LocalApproval) => void;
  readonly onWaitingChanged: (runId: string, waiting: boolean) => void;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
}

export class LocalApprovalCoordinator {
  readonly policy: ToolPolicy;
  readonly #store: LocalAgentStore;
  readonly #onApprovalChanged: (approval: LocalApproval) => void;
  readonly #onWaitingChanged: (runId: string, waiting: boolean) => void;
  readonly #idGenerator: () => string;
  readonly #now: () => Date;
  readonly #pending = new Map<string, PendingApproval>();

  constructor(options: LocalApprovalCoordinatorOptions) {
    this.#store = options.store;
    this.#onApprovalChanged = options.onApprovalChanged;
    this.#onWaitingChanged = options.onWaitingChanged;
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
    this.policy = Object.freeze({
      evaluate: (request: ToolPolicyRequest) => this.#request(request),
    });
  }

  decide(
    approvalId: string,
    decision: "allow_once" | "deny",
  ): LocalApproval {
    const pending = this.#pending.get(approvalId);
    if (!pending) {
      const existing = this.#store.getApproval(approvalId);
      if (!existing) throw new Error("Approval request not found.");
      if (existing.status !== "pending") return existing;
      throw new Error("Approval request is no longer attached to a live run.");
    }

    const status = decision === "allow_once" ? "approved" : "denied";
    const approval = this.#store.setApprovalStatus(
      approvalId,
      status,
      this.#now().toISOString(),
    );
    this.#pending.delete(approvalId);
    pending.removeAbortListener();
    pending.resolve(
      decision === "allow_once"
        ? { allowed: true }
        : {
            allowed: false,
            reason: `Tool "${approval.toolName}" was denied by the user.`,
          },
    );
    this.#onApprovalChanged(approval);
    this.#notifyWaiting(approval.runId);
    return approval;
  }

  cancelRun(runId: string): void {
    for (const [approvalId, pending] of this.#pending) {
      if (pending.approval.runId !== runId) continue;
      const approval = this.#store.setApprovalStatus(
        approvalId,
        "cancelled",
        this.#now().toISOString(),
      );
      this.#pending.delete(approvalId);
      pending.removeAbortListener();
      pending.resolve({
        allowed: false,
        reason: `Tool "${approval.toolName}" was cancelled with its run.`,
      });
      this.#onApprovalChanged(approval);
    }
    this.#notifyWaiting(runId);
  }

  async #request(request: ToolPolicyRequest): Promise<ToolPolicyDecision> {
    const effect = request.tool.annotations?.effect;
    if (!effect || effect === "read") {
      return {
        allowed: false,
        reason: `Tool "${request.tool.name}" did not provide a restricted effect for approval.`,
      };
    }
    if (request.context.signal.aborted) {
      return {
        allowed: false,
        reason: `Tool "${request.tool.name}" was cancelled before approval.`,
      };
    }

    const approval: LocalApproval = {
      id: this.#idGenerator(),
      runId: request.context.runId,
      callId: request.context.callId,
      toolName: request.tool.name,
      effect,
      arguments: request.arguments,
      status: "pending",
      createdAt: this.#now().toISOString(),
      decidedAt: null,
    };
    this.#store.insertApproval(approval);

    return new Promise<ToolPolicyDecision>((resolve) => {
      const onAbort = () => {
        const pending = this.#pending.get(approval.id);
        if (!pending) return;
        pending.removeAbortListener();
        const cancelled = this.#store.setApprovalStatus(
          approval.id,
          "cancelled",
          this.#now().toISOString(),
        );
        this.#pending.delete(approval.id);
        resolve({
          allowed: false,
          reason: `Tool "${approval.toolName}" was cancelled before approval.`,
        });
        this.#onApprovalChanged(cancelled);
        this.#notifyWaiting(approval.runId);
      };
      this.#pending.set(approval.id, {
        approval,
        resolve,
        removeAbortListener: () =>
          request.context.signal.removeEventListener("abort", onAbort),
      });
      request.context.signal.addEventListener("abort", onAbort, { once: true });
      if (request.context.signal.aborted) {
        onAbort();
        return;
      }
      this.#onApprovalChanged(approval);
      this.#onWaitingChanged(approval.runId, true);
    });
  }

  #notifyWaiting(runId: string): void {
    this.#onWaitingChanged(
      runId,
      this.#store.countPendingApprovals(runId) > 0,
    );
  }
}
