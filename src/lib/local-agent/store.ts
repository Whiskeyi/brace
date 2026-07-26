import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { AgentEvent } from "../agent";
import { formatLocalRunStatusCompletion } from "./context";
import type {
  LocalAgentEventRecord,
  LocalAgentSnapshot,
  LocalApproval,
  LocalApprovalStatus,
  LocalExecutionMode,
  LocalMessage,
  LocalProject,
  LocalRun,
  LocalRunStatus,
  LocalThread,
  LocalThreadDetail,
  LocalThreadStatus,
} from "./types";

type SqlValue = null | number | string;
type SqlRow = Record<string, SqlValue>;

export class LocalAgentStore {
  readonly #database: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    }
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  recoverInterruptedRuns(now = new Date().toISOString()): void {
    const interrupted = this.#rows(
      this.#database.prepare(
        `SELECT id, thread_id
         FROM local_runs
         WHERE status IN ('running', 'waiting_for_approval')`,
      ),
    );
    this.#transaction(() => {
      this.#database
        .prepare(
          `UPDATE local_runs
           SET status = 'failed', finished_at = ?, error_message = ?
           WHERE status IN ('running', 'waiting_for_approval')`,
        )
        .run(now, "The desktop process stopped before the run completed.");
      this.#database
        .prepare(
          `UPDATE local_threads
           SET status = 'failed', updated_at = ?
           WHERE status IN ('running', 'waiting_for_approval')`,
        )
        .run(now);
      const latestMessage = this.#database.prepare(
        `SELECT role
         FROM local_messages
         WHERE thread_id = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      );
      const insertCompletion = this.#database.prepare(
        `INSERT INTO local_messages (id, thread_id, role, content, created_at)
         VALUES (?, ?, 'assistant', ?, ?)`,
      );
      const compactDeltas = this.#database.prepare(
        "DELETE FROM local_events WHERE run_id = ? AND event_type = 'delta'",
      );
      for (const row of interrupted) {
        const runId = stringValue(row.id);
        const threadId = stringValue(row.thread_id);
        const latest = this.#row(latestMessage, threadId);
        if (latest && latest.role === "user") {
          insertCompletion.run(
            `recovered-${runId}`,
            threadId,
            formatLocalRunStatusCompletion(
              "failed",
              "The desktop process stopped before the run completed.",
            ),
            now,
          );
        }
        compactDeltas.run(runId);
      }
      this.#database
        .prepare(
          `UPDATE local_approvals
           SET status = 'cancelled', decided_at = ?
           WHERE status = 'pending'`,
        )
        .run(now);
    });
  }

  upsertProject(project: LocalProject): LocalProject {
    this.#database
      .prepare(
        `INSERT INTO local_projects (
           id, name, root_path, created_at, last_opened_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(root_path) DO UPDATE SET
           name = excluded.name,
           last_opened_at = excluded.last_opened_at`,
      )
      .run(
        project.id,
        project.name,
        project.rootPath,
        project.createdAt,
        project.lastOpenedAt,
      );
    return this.getProjectByRoot(project.rootPath) as LocalProject;
  }

  getProject(id: string): LocalProject | null {
    return projectFromRow(
      this.#row(
        this.#database.prepare("SELECT * FROM local_projects WHERE id = ?"),
        id,
      ),
    );
  }

  getProjectByRoot(rootPath: string): LocalProject | null {
    return projectFromRow(
      this.#row(
        this.#database.prepare(
          "SELECT * FROM local_projects WHERE root_path = ?",
        ),
        rootPath,
      ),
    );
  }

  listProjects(): LocalProject[] {
    return this.#rows(
      this.#database.prepare(
        "SELECT * FROM local_projects ORDER BY last_opened_at DESC",
      ),
    ).map(requiredProject);
  }

  insertThread(thread: LocalThread): void {
    this.#insertThread(thread);
  }

  getThread(id: string): LocalThread | null {
    return threadFromRow(
      this.#row(
        this.#database.prepare("SELECT * FROM local_threads WHERE id = ?"),
        id,
      ),
    );
  }

  listThreads(projectId?: string): LocalThread[] {
    const statement = projectId
      ? this.#database.prepare(
          "SELECT * FROM local_threads WHERE project_id = ? ORDER BY updated_at DESC",
        )
      : this.#database.prepare(
          "SELECT * FROM local_threads ORDER BY updated_at DESC",
        );
    return this.#rows(statement, ...(projectId ? [projectId] : [])).map(
      requiredThread,
    );
  }

  setThreadStatus(
    threadId: string,
    status: LocalThreadStatus,
    now = new Date().toISOString(),
  ): LocalThread {
    this.#database
      .prepare(
        "UPDATE local_threads SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, threadId);
    return required(this.getThread(threadId), "Local thread not found.");
  }

  setThreadWorkspace(
    threadId: string,
    mode: LocalExecutionMode,
    workspacePath: string,
    now = new Date().toISOString(),
    worktreeCleanupCommit: string | null = null,
  ): LocalThread {
    this.#database
      .prepare(
        `UPDATE local_threads
         SET mode = ?, workspace_path = ?, worktree_cleanup_commit = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        mode,
        workspacePath,
        worktreeCleanupCommit,
        now,
        threadId,
      );
    return required(this.getThread(threadId), "Local thread not found.");
  }

  insertMessage(message: LocalMessage): void {
    this.#insertMessage(message);
    this.#database
      .prepare("UPDATE local_threads SET updated_at = ? WHERE id = ?")
      .run(message.createdAt, message.threadId);
  }

  listMessages(threadId: string): LocalMessage[] {
    return this.#rows(
      this.#database.prepare(
        "SELECT * FROM local_messages WHERE thread_id = ? ORDER BY created_at, rowid",
      ),
      threadId,
    ).map(requiredMessage);
  }

  listRecentMessages(threadId: string, limit: number): LocalMessage[] {
    assertPositiveSafeInteger(limit, "limit");
    return this.#rows(
      this.#database.prepare(
        `SELECT *
         FROM (
           SELECT *, rowid AS message_rowid
           FROM local_messages
           WHERE thread_id = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         )
         ORDER BY created_at, message_rowid`,
      ),
      threadId,
      limit,
    ).map(requiredMessage);
  }

  insertTaskStart(input: {
    readonly thread?: LocalThread;
    readonly message: LocalMessage;
    readonly run: LocalRun;
  }): void {
    if (input.message.threadId !== input.run.threadId) {
      throw new Error("Local task start records belong to different threads.");
    }
    if (input.thread && input.thread.id !== input.run.threadId) {
      throw new Error("Local task start thread does not match its run.");
    }
    this.#transaction(() => {
      if (input.thread) this.#insertThread(input.thread);
      this.#insertMessage(input.message);
      this.#insertRun(input.run);
    });
  }

  insertRun(run: LocalRun): void {
    this.#transaction(() => {
      this.#insertRun(run);
    });
  }

  getRun(id: string): LocalRun | null {
    return runFromRow(
      this.#row(
        this.#database.prepare("SELECT * FROM local_runs WHERE id = ?"),
        id,
      ),
    );
  }

  listRuns(threadId: string): LocalRun[] {
    return this.#rows(
      this.#database.prepare(
        "SELECT * FROM local_runs WHERE thread_id = ? ORDER BY started_at",
      ),
      threadId,
    ).map(requiredRun);
  }

  setRunStatus(
    runId: string,
    status: LocalRunStatus,
    options: {
      readonly now?: string;
      readonly errorMessage?: string | null;
      readonly assistantMessage?: LocalMessage;
    } = {},
  ): LocalRun {
    const current = required(this.getRun(runId), "Local run not found.");
    const now = options.now ?? new Date().toISOString();
    const terminal = ["completed", "failed", "cancelled"].includes(status);
    if (options.assistantMessage) {
      if (!terminal) {
        throw new Error("Only a terminal run can persist an assistant completion.");
      }
      if (options.assistantMessage.threadId !== current.threadId) {
        throw new Error("The assistant completion belongs to another thread.");
      }
    }
    this.#transaction(() => {
      if (options.assistantMessage) {
        this.#insertMessage(options.assistantMessage);
      }
      this.#database
        .prepare(
          `UPDATE local_runs
           SET status = ?, finished_at = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(
          status,
          terminal ? now : null,
          options.errorMessage ?? null,
          runId,
        );
      this.#database
        .prepare(
          "UPDATE local_threads SET status = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, now, current.threadId);
      if (terminal) {
        // The final assistant message is the durable transcript. Streaming
        // deltas are only needed while a run is live, so discard them once the
        // run terminates while retaining tool calls/results and audit events.
        this.#database
          .prepare(
            "DELETE FROM local_events WHERE run_id = ? AND event_type = 'delta'",
          )
          .run(runId);
      }
    });
    return required(this.getRun(runId), "Local run not found.");
  }

  appendAgentEvent(threadId: string, event: AgentEvent): void {
    this.appendAgentEvents(threadId, [event]);
  }

  appendAgentEvents(threadId: string, events: readonly AgentEvent[]): void {
    if (events.length === 0) return;
    const insert = this.#database.prepare(
      `INSERT INTO local_events (
         run_id, thread_id, sequence, event_type, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.#transaction(() => {
      for (const event of compactAgentEvents(events)) {
        insert.run(
          event.runId,
          threadId,
          event.sequence,
          event.type,
          JSON.stringify(event),
          event.timestamp,
        );
      }
    });
  }

  listAgentEvents(
    threadId: string,
    limit = 500,
  ): LocalAgentEventRecord[] {
    assertPositiveSafeInteger(limit, "limit");
    return this.#rows(
      this.#database.prepare(
        `SELECT run_id, thread_id, payload_json
         FROM (
           SELECT rowid AS event_rowid, run_id, thread_id, payload_json
           FROM local_events
           WHERE thread_id = ?
           ORDER BY rowid DESC
           LIMIT ?
         )
         ORDER BY event_rowid`,
      ),
      threadId,
      limit,
    ).map((row) => ({
      runId: stringValue(row.run_id),
      threadId: stringValue(row.thread_id),
      event: parseJson(stringValue(row.payload_json)) as AgentEvent,
    }));
  }

  insertApproval(approval: LocalApproval): void {
    this.#database
      .prepare(
        `INSERT INTO local_approvals (
           id, run_id, call_id, tool_name, effect, arguments_json,
           status, created_at, decided_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approval.id,
        approval.runId,
        approval.callId,
        approval.toolName,
        approval.effect,
        JSON.stringify(approval.arguments),
        approval.status,
        approval.createdAt,
        approval.decidedAt,
      );
  }

  getApproval(id: string): LocalApproval | null {
    return approvalFromRow(
      this.#row(
        this.#database.prepare("SELECT * FROM local_approvals WHERE id = ?"),
        id,
      ),
    );
  }

  setApprovalStatus(
    id: string,
    status: Exclude<LocalApprovalStatus, "pending">,
    decidedAt = new Date().toISOString(),
  ): LocalApproval {
    this.#database
      .prepare(
        `UPDATE local_approvals
         SET status = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, decidedAt, id);
    return required(this.getApproval(id), "Local approval not found.");
  }

  listApprovals(threadId: string): LocalApproval[] {
    return this.#rows(
      this.#database.prepare(
        `SELECT approval.*
         FROM local_approvals AS approval
         JOIN local_runs AS run ON run.id = approval.run_id
         WHERE run.thread_id = ?
         ORDER BY approval.created_at`,
      ),
      threadId,
    ).map(requiredApproval);
  }

  countPendingApprovals(runId: string): number {
    const row = this.#row(
      this.#database.prepare(
        "SELECT count(*) AS count FROM local_approvals WHERE run_id = ? AND status = 'pending'",
      ),
      runId,
    );
    return Number(row?.count ?? 0);
  }

  getThreadDetail(threadId: string): LocalThreadDetail | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    return {
      thread,
      messages: this.listMessages(threadId),
      runs: this.listRuns(threadId),
      events: this.listAgentEvents(threadId),
      approvals: this.listApprovals(threadId),
    };
  }

  getSnapshot(activeRunIds: readonly string[] = []): LocalAgentSnapshot {
    return {
      projects: this.listProjects(),
      threads: this.listThreads(),
      activeRunIds: [...activeRunIds],
    };
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS local_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES local_projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('local', 'worktree')),
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'idle', 'running', 'waiting_for_approval',
            'completed', 'failed', 'cancelled'
          )
        ),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        worktree_cleanup_commit TEXT
      );
      CREATE INDEX IF NOT EXISTS local_threads_project_updated
        ON local_threads(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS local_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES local_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_messages_thread_created
        ON local_messages(thread_id, created_at);

      CREATE TABLE IF NOT EXISTS local_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES local_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (
          status IN (
            'running', 'waiting_for_approval',
            'completed', 'failed', 'cancelled'
          )
        ),
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error_message TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS local_runs_one_active_thread
        ON local_runs(thread_id)
        WHERE status IN ('running', 'waiting_for_approval');

      CREATE TABLE IF NOT EXISTS local_events (
        run_id TEXT NOT NULL REFERENCES local_runs(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES local_threads(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS local_events_thread_created
        ON local_events(thread_id, created_at, sequence);

      CREATE TABLE IF NOT EXISTS local_approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES local_runs(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('write', 'execute', 'network')),
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'approved', 'denied', 'cancelled')
        ),
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS local_approvals_run_status
        ON local_approvals(run_id, status);
    `);
    const threadColumns = this.#rows(
      this.#database.prepare("PRAGMA table_info(local_threads)"),
    );
    if (
      !threadColumns.some(
        (column) => column.name === "worktree_cleanup_commit",
      )
    ) {
      this.#database.exec(
        "ALTER TABLE local_threads ADD COLUMN worktree_cleanup_commit TEXT",
      );
    }
  }

  #insertThread(thread: LocalThread): void {
    this.#database
      .prepare(
        `INSERT INTO local_threads (
           id, project_id, title, mode, workspace_path,
           worktree_cleanup_commit, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.mode,
        thread.workspacePath,
        thread.worktreeCleanupCommit ?? null,
        thread.status,
        thread.createdAt,
        thread.updatedAt,
      );
  }

  #insertMessage(message: LocalMessage): void {
    this.#database
      .prepare(
        `INSERT INTO local_messages (id, thread_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.threadId,
        message.role,
        message.content,
        message.createdAt,
      );
  }

  #insertRun(run: LocalRun): void {
    this.#database
      .prepare(
        `INSERT INTO local_runs (
           id, thread_id, status, model, started_at, finished_at, error_message
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.threadId,
        run.status,
        run.model,
        run.startedAt,
        run.finishedAt,
        run.errorMessage,
      );
    this.#database
      .prepare(
        "UPDATE local_threads SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(run.status, run.startedAt, run.threadId);
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #row(statement: StatementSync, ...values: SqlValue[]): SqlRow | null {
    return (statement.get(...values) as SqlRow | undefined) ?? null;
  }

  #rows(statement: StatementSync, ...values: SqlValue[]): SqlRow[] {
    return statement.all(...values) as SqlRow[];
  }
}

function projectFromRow(row: SqlRow | null): LocalProject | null {
  if (!row) return null;
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    rootPath: stringValue(row.root_path),
    createdAt: stringValue(row.created_at),
    lastOpenedAt: stringValue(row.last_opened_at),
  };
}

function threadFromRow(row: SqlRow | null): LocalThread | null {
  if (!row) return null;
  return {
    id: stringValue(row.id),
    projectId: stringValue(row.project_id),
    title: stringValue(row.title),
    mode: stringValue(row.mode) as LocalExecutionMode,
    workspacePath: stringValue(row.workspace_path),
    worktreeCleanupCommit: nullableString(row.worktree_cleanup_commit),
    status: stringValue(row.status) as LocalThreadStatus,
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function messageFromRow(row: SqlRow | null): LocalMessage | null {
  if (!row) return null;
  return {
    id: stringValue(row.id),
    threadId: stringValue(row.thread_id),
    role: stringValue(row.role) as LocalMessage["role"],
    content: stringValue(row.content),
    createdAt: stringValue(row.created_at),
  };
}

function runFromRow(row: SqlRow | null): LocalRun | null {
  if (!row) return null;
  return {
    id: stringValue(row.id),
    threadId: stringValue(row.thread_id),
    status: stringValue(row.status) as LocalRunStatus,
    model: stringValue(row.model),
    startedAt: stringValue(row.started_at),
    finishedAt: nullableString(row.finished_at),
    errorMessage: nullableString(row.error_message),
  };
}

function approvalFromRow(row: SqlRow | null): LocalApproval | null {
  if (!row) return null;
  return {
    id: stringValue(row.id),
    runId: stringValue(row.run_id),
    callId: stringValue(row.call_id),
    toolName: stringValue(row.tool_name),
    effect: stringValue(row.effect) as LocalApproval["effect"],
    arguments: parseJson(stringValue(row.arguments_json)),
    status: stringValue(row.status) as LocalApprovalStatus,
    createdAt: stringValue(row.created_at),
    decidedAt: nullableString(row.decided_at),
  };
}

const requiredProject = (row: SqlRow) =>
  required(projectFromRow(row), "Invalid local project row.");
const requiredThread = (row: SqlRow) =>
  required(threadFromRow(row), "Invalid local thread row.");
const requiredMessage = (row: SqlRow) =>
  required(messageFromRow(row), "Invalid local message row.");
const requiredRun = (row: SqlRow) =>
  required(runFromRow(row), "Invalid local run row.");
const requiredApproval = (row: SqlRow) =>
  required(approvalFromRow(row), "Invalid local approval row.");

function stringValue(value: SqlValue | undefined): string {
  if (typeof value !== "string") throw new Error("Invalid local database row.");
  return value;
}

function nullableString(value: SqlValue | undefined): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function compactAgentEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const compacted: AgentEvent[] = [];
  for (const event of events) {
    const previous = compacted.at(-1);
    if (
      previous?.type === "delta" &&
      event.type === "delta" &&
      previous.runId === event.runId &&
      previous.round === event.round
    ) {
      compacted[compacted.length - 1] = {
        ...event,
        delta: previous.delta + event.delta,
      };
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function required<T>(value: T | null, message: string): T {
  if (value === null) throw new Error(message);
  return value;
}
