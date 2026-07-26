import type {
  DecideLocalApprovalInput,
  LocalAgentSnapshot,
  LocalApproval,
  LocalClientEvent,
  LocalModelConnectionResult,
  LocalModelSettings,
  LocalProject,
  LocalRun,
  LocalThreadDetail,
  LocalWorktreeMetadata,
  LocalWorktreeResolution,
  StartLocalTaskInput,
  SaveLocalModelSettingsInput,
} from "../src/lib/local-agent";
import type {
  LocalPreviewUrlResult,
} from "./preview-url";
import type {
  DesktopUiPreferences,
} from "./ui-preferences";

type DesktopMenuAction =
  | "open-project"
  | "new-task"
  | "open-settings"
  | "toggle-preview"
  | "toggle-inspector";

type PreviewStatusCode =
  | "preview.blockedNavigation"
  | "preview.blockedRedirect"
  | "preview.cannotConnect"
  | "preview.cannotResolve"
  | "preview.noNetwork"
  | "preview.loadFailedWithDescription"
  | "preview.loadFailed";

type PreviewNavigationStatus =
  | {
      readonly kind: "blocked";
      readonly url: string;
      readonly code: PreviewStatusCode;
    }
  | {
      readonly kind: "failed";
      readonly url: string;
      readonly code: PreviewStatusCode;
      readonly detail?: string;
      readonly errorCode: number;
    };

declare global {
  interface Window {
    readonly baseAgent: {
      readonly initialUiPreferences: DesktopUiPreferences;
      snapshot(): Promise<LocalAgentSnapshot>;
      selectProject(): Promise<LocalProject | null>;
      getThread(threadId: string): Promise<LocalThreadDetail>;
      startTask(
        input: StartLocalTaskInput,
      ): Promise<{ readonly thread: LocalThreadDetail["thread"]; readonly run: LocalRun }>;
      cancelTask(runId: string): Promise<LocalRun>;
      decideApproval(input: DecideLocalApprovalInput): Promise<LocalApproval>;
      getDiff(threadId: string): Promise<string>;
      getWorktree(threadId: string): Promise<LocalWorktreeMetadata | null>;
      resolveWorktree(
        threadId: string,
        action: "apply" | "discard" | "cleanup",
      ): Promise<LocalWorktreeResolution | null>;
      openWorkspace(threadId: string): Promise<boolean>;
      getModelSettings(): Promise<LocalModelSettings>;
      testModelSettings(
        input: SaveLocalModelSettingsInput,
      ): Promise<LocalModelConnectionResult>;
      saveModelSettings(
        input: SaveLocalModelSettingsInput,
      ): Promise<LocalModelSettings>;
      normalizePreviewUrl(value: string): LocalPreviewUrlResult;
      setUiPreferences(
        input: DesktopUiPreferences,
      ): Promise<DesktopUiPreferences>;
      onEvent(listener: (event: LocalClientEvent) => void): () => void;
      onMenuAction(
        listener: (action: DesktopMenuAction) => void,
      ): () => void;
      onPreviewStatus(
        listener: (status: PreviewNavigationStatus) => void,
      ): () => void;
    };
  }
}

export {};
