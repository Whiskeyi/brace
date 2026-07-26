import { contextBridge, ipcRenderer } from "electron";

import type {
  DecideLocalApprovalInput,
  LocalClientEvent,
  LocalModelConnectionResult,
  LocalModelSettings,
  LocalWorktreeMetadata,
  LocalWorktreeResolution,
  SaveLocalModelSettingsInput,
  StartLocalTaskInput,
} from "../src/lib/local-agent";
import {
  tryNormalizeLocalPreviewUrl,
  type LocalPreviewUrlResult,
} from "./preview-url";
import {
  DEFAULT_DESKTOP_UI_PREFERENCES,
  type DesktopUiPreferences,
} from "./ui-preferences";

const IPC = Object.freeze({
  snapshot: "local-agent:snapshot",
  selectProject: "local-agent:select-project",
  getThread: "local-agent:get-thread",
  startTask: "local-agent:start-task",
  cancelTask: "local-agent:cancel-task",
  decideApproval: "local-agent:decide-approval",
  getDiff: "local-agent:get-diff",
  getWorktree: "local-agent:get-worktree",
  resolveWorktree: "local-agent:resolve-worktree",
  openWorkspace: "local-agent:open-workspace",
  getModelSettings: "local-agent:get-model-settings",
  testModelSettings: "local-agent:test-model-settings",
  saveModelSettings: "local-agent:save-model-settings",
  event: "local-agent:event",
  menuAction: "desktop:menu-action",
  previewStatus: "desktop:preview-status",
  setUiPreferences: "desktop:set-ui-preferences",
});

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

const previewStatusCodes = new Set<PreviewStatusCode>([
  "preview.blockedNavigation",
  "preview.blockedRedirect",
  "preview.cannotConnect",
  "preview.cannotResolve",
  "preview.noNetwork",
  "preview.loadFailedWithDescription",
  "preview.loadFailed",
]);

const desktopMenuActions = new Set<DesktopMenuAction>([
  "open-project",
  "new-task",
  "open-settings",
  "toggle-preview",
  "toggle-inspector",
]);

function isPreviewNavigationStatus(
  payload: unknown,
): payload is PreviewNavigationStatus {
  if (!payload || typeof payload !== "object") return false;
  const candidate = payload as Record<string, unknown>;
  return (
    (candidate.kind === "blocked" || candidate.kind === "failed") &&
    typeof candidate.url === "string" &&
    typeof candidate.code === "string" &&
    previewStatusCodes.has(candidate.code as PreviewStatusCode) &&
    (candidate.detail === undefined || typeof candidate.detail === "string") &&
    (candidate.kind !== "failed" || typeof candidate.errorCode === "number")
  );
}

function isDesktopUiPreferences(
  input: unknown,
): input is DesktopUiPreferences {
  if (!input || typeof input !== "object") return false;
  const candidate = input as Record<string, unknown>;
  return (
    (candidate.locale === "en" || candidate.locale === "zh-CN") &&
    (candidate.theme === "system" ||
      candidate.theme === "light" ||
      candidate.theme === "dark")
  );
}

function initialUiPreferences(): DesktopUiPreferences {
  const localeArgument = process.argv.find((value) =>
    value.startsWith("--base-agent-ui-locale="),
  );
  const themeArgument = process.argv.find((value) =>
    value.startsWith("--base-agent-ui-theme="),
  );
  const candidate = {
    locale: localeArgument?.slice(localeArgument.indexOf("=") + 1),
    theme: themeArgument?.slice(themeArgument.indexOf("=") + 1),
  };
  return isDesktopUiPreferences(candidate)
    ? candidate
    : DEFAULT_DESKTOP_UI_PREFERENCES;
}

contextBridge.exposeInMainWorld("baseAgent", {
  initialUiPreferences: initialUiPreferences(),
  snapshot: () => ipcRenderer.invoke(IPC.snapshot),
  selectProject: () => ipcRenderer.invoke(IPC.selectProject),
  getThread: (threadId: string) =>
    ipcRenderer.invoke(IPC.getThread, { threadId }),
  startTask: (input: StartLocalTaskInput) =>
    ipcRenderer.invoke(IPC.startTask, input),
  cancelTask: (runId: string) =>
    ipcRenderer.invoke(IPC.cancelTask, { runId }),
  decideApproval: (input: DecideLocalApprovalInput) =>
    ipcRenderer.invoke(IPC.decideApproval, input),
  getDiff: (threadId: string) =>
    ipcRenderer.invoke(IPC.getDiff, { threadId }),
  getWorktree: (threadId: string): Promise<LocalWorktreeMetadata | null> =>
    ipcRenderer.invoke(IPC.getWorktree, { threadId }),
  resolveWorktree: (
    threadId: string,
    action: "apply" | "discard" | "cleanup",
  ): Promise<LocalWorktreeResolution | null> => {
    if (
      action !== "apply" &&
      action !== "discard" &&
      action !== "cleanup"
    ) {
      return Promise.reject(new TypeError("Invalid worktree action."));
    }
    return ipcRenderer.invoke(IPC.resolveWorktree, { threadId, action });
  },
  openWorkspace: (threadId: string) =>
    ipcRenderer.invoke(IPC.openWorkspace, { threadId }),
  getModelSettings: (): Promise<LocalModelSettings> =>
    ipcRenderer.invoke(IPC.getModelSettings),
  testModelSettings: (
    input: SaveLocalModelSettingsInput,
  ): Promise<LocalModelConnectionResult> =>
    ipcRenderer.invoke(IPC.testModelSettings, input),
  saveModelSettings: (
    input: SaveLocalModelSettingsInput,
  ): Promise<LocalModelSettings> =>
    ipcRenderer.invoke(IPC.saveModelSettings, input),
  normalizePreviewUrl: (value: string): LocalPreviewUrlResult =>
    tryNormalizeLocalPreviewUrl(value),
  setUiPreferences: (
    input: DesktopUiPreferences,
  ): Promise<DesktopUiPreferences> => {
    if (!isDesktopUiPreferences(input)) {
      return Promise.reject(new TypeError("Invalid desktop UI preferences."));
    }
    return ipcRenderer.invoke(IPC.setUiPreferences, input);
  },
  onEvent: (listener: (event: LocalClientEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: LocalClientEvent) =>
      listener(payload);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.removeListener(IPC.event, handler);
  },
  onMenuAction: (listener: (action: DesktopMenuAction) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (
        typeof payload === "string" &&
        desktopMenuActions.has(payload as DesktopMenuAction)
      ) {
        listener(payload as DesktopMenuAction);
      }
    };
    ipcRenderer.on(IPC.menuAction, handler);
    return () => ipcRenderer.removeListener(IPC.menuAction, handler);
  },
  onPreviewStatus: (
    listener: (status: PreviewNavigationStatus) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (isPreviewNavigationStatus(payload)) listener(payload);
    };
    ipcRenderer.on(IPC.previewStatus, handler);
    return () => ipcRenderer.removeListener(IPC.previewStatus, handler);
  },
});
