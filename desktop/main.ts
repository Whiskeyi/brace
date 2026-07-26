import path from "node:path";

import { config as loadEnvironment } from "dotenv";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  session,
  shell,
  type MenuItemConstructorOptions,
  webFrameMain,
} from "electron";

import {
  getLocalAgentConfig,
  LocalAgentStore,
  LocalCodingService,
  OPENAI_COMPATIBLE_MODEL_PROVIDERS,
  testLocalModelConnection,
  type LocalAgentConfig,
} from "../src/lib/local-agent";
import {
  resolveDesktopRuntimeConfig,
  type DesktopApiKeySource,
} from "./model-runtime";
import { isAllowedPreviewNavigation } from "./preview-url";
import {
  desktopSettingsErrorCode,
  DesktopSettingsStore,
} from "./settings";
import {
  DesktopUiPreferencesStore,
  parseDesktopUiPreferences,
  type DesktopLocale,
  type DesktopTheme,
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

const PRODUCT_NAME = "Brace";

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

const MAIN_MESSAGES: Record<
  DesktopLocale,
  Readonly<Record<string, string>>
> = {
  en: {
    "close.title": "Task still running",
    "close.message": "Keep the task running in the background?",
    "close.detail":
      "The task can continue locally after this window closes. Reopen Brace from the Dock to restore its progress.",
    "close.keepRunning": "Keep running in background",
    "close.stopAndClose": "Stop task and close",
    "action.cancel": "Cancel",
    "menu.settings": "Settings…",
    "menu.file": "File",
    "menu.openProject": "Open Project…",
    "menu.newTask": "New Task",
    "menu.edit": "Edit",
    "menu.speech": "Speech",
    "menu.view": "View",
    "menu.togglePreview": "Toggle Local Preview",
    "menu.toggleInspector": "Toggle Inspector",
    "menu.window": "Window",
    "role.about": "About {app}",
    "role.services": "Services",
    "role.hide": "Hide {app}",
    "role.hideOthers": "Hide Others",
    "role.unhide": "Show All",
    "role.quit": "Quit {app}",
    "role.close": "Close Window",
    "role.undo": "Undo",
    "role.redo": "Redo",
    "role.cut": "Cut",
    "role.copy": "Copy",
    "role.paste": "Paste",
    "role.pasteAndMatchStyle": "Paste and Match Style",
    "role.delete": "Delete",
    "role.selectAll": "Select All",
    "role.startSpeaking": "Start Speaking",
    "role.stopSpeaking": "Stop Speaking",
    "role.resetZoom": "Actual Size",
    "role.zoomIn": "Zoom In",
    "role.zoomOut": "Zoom Out",
    "role.togglefullscreen": "Toggle Full Screen",
    "role.minimize": "Minimize",
    "role.zoom": "Zoom",
    "role.front": "Bring All to Front",
    "dialog.openProject": "Open Local Code Project",
    "worktree.apply.title": "Apply isolated changes?",
    "worktree.apply.message":
      "Apply this task's changes to the main project?",
    "worktree.apply.detail":
      "The changes will become an uncommitted diff in the main project. The isolated branch and directory will then be removed.",
    "worktree.apply.confirm": "Apply changes",
    "worktree.discard.title": "Discard isolated changes?",
    "worktree.discard.message":
      "Permanently discard this task's isolated changes?",
    "worktree.discard.detail":
      "The isolated branch and directory will be removed. This cannot be undone.",
    "worktree.discard.confirm": "Discard changes",
    "worktree.cleanup.title": "Finish isolated cleanup?",
    "worktree.cleanup.message":
      "Remove the already-applied task's isolated branch and directory?",
    "worktree.cleanup.detail":
      "Brace will first verify that the exact task patch is present in the main project. Main-project changes will not be modified.",
    "worktree.cleanup.confirm": "Retry cleanup",
    "model.keyRequired":
      "Enter an API key that matches the current provider and endpoint.",
    "model.401":
      "The API key is invalid or does not match the selected provider or product.",
    "model.403":
      "This key cannot use the selected model or Coding Plan.",
    "model.404": "The endpoint or model ID does not exist.",
    "model.429":
      "Too many requests, or the current plan has exhausted its quota.",
    "model.connectionFailedWithMessage":
      "Model connection failed: {message}",
    "model.connectionFailed":
      "Model connection failed. Check the network, endpoint, model, and API key.",
    "model.settingsNotReady": "Model settings are not ready.",
    "model.stopActive":
      "Stop active tasks before changing model settings.",
    "model.configNotReady": "Local model configuration is not ready.",
    "settingsError.secure_storage_unavailable":
      "System secure storage is unavailable. Use LLM_API_KEY from the process environment instead.",
    "settingsError.credential_scope_changed":
      "The saved API key belongs to another provider or endpoint. Enter a new key or remove the saved key.",
    "settingsError.settings_read_failed":
      "Unable to read desktop model settings.",
    "settingsError.settings_write_failed":
      "Unable to save desktop model settings.",
    "settingsError.settings_input_invalid":
      "The model settings are invalid. Check the endpoint, model, and API key.",
    "settingsError.credential_scope_invalid":
      "Stored model credentials do not match the configured provider endpoint.",
    "settingsError.custom_endpoint_invalid":
      "The stored custom model endpoint is invalid.",
    "settingsError.provider_endpoint_invalid":
      "This endpoint does not belong to the selected provider or plan.",
    "settingsError.credential_decryption_unavailable":
      "System secure storage is unavailable, so the saved model key cannot be decrypted.",
    "settingsError.credential_decryption_failed":
      "Unable to decrypt the saved model key.",
    "service.notReady": "The local coding service is not ready.",
    "notification.approvalTitle": "Brace needs confirmation",
    "notification.approvalBody": "{tool} is waiting for your approval.",
    "notification.completedTitle": "Agent response finished",
    "notification.completedBody":
      "Review the workspace diff and run relevant checks before keeping the result.",
    "notification.failedTitle": "Brace needs attention",
    "notification.failedBody":
      "The task stopped with an error. Review the error and any existing changes.",
    "startup.title": "Brace failed to start",
    "startup.unknown": "Unknown startup error.",
    "startup.iconUnavailable": "The Brace application icon is unavailable.",
  },
  "zh-CN": {
    "close.title": "任务仍在运行",
    "close.message": "要让任务继续在后台运行吗？",
    "close.detail":
      "关闭窗口后，任务仍会在本机运行。你可以从 Dock 重新打开 Brace 并恢复进度。",
    "close.keepRunning": "继续在后台运行",
    "close.stopAndClose": "停止任务并关闭",
    "action.cancel": "取消",
    "menu.settings": "设置…",
    "menu.file": "文件",
    "menu.openProject": "打开项目…",
    "menu.newTask": "新建任务",
    "menu.edit": "编辑",
    "menu.speech": "语音",
    "menu.view": "显示",
    "menu.togglePreview": "切换本地预览",
    "menu.toggleInspector": "切换检查器",
    "menu.window": "窗口",
    "role.about": "关于 {app}",
    "role.services": "服务",
    "role.hide": "隐藏 {app}",
    "role.hideOthers": "隐藏其他",
    "role.unhide": "全部显示",
    "role.quit": "退出 {app}",
    "role.close": "关闭窗口",
    "role.undo": "撤销",
    "role.redo": "重做",
    "role.cut": "剪切",
    "role.copy": "复制",
    "role.paste": "粘贴",
    "role.pasteAndMatchStyle": "粘贴并匹配样式",
    "role.delete": "删除",
    "role.selectAll": "全选",
    "role.startSpeaking": "开始朗读",
    "role.stopSpeaking": "停止朗读",
    "role.resetZoom": "实际大小",
    "role.zoomIn": "放大",
    "role.zoomOut": "缩小",
    "role.togglefullscreen": "切换全屏",
    "role.minimize": "最小化",
    "role.zoom": "缩放",
    "role.front": "前置全部窗口",
    "dialog.openProject": "打开本地代码项目",
    "worktree.apply.title": "应用隔离变更？",
    "worktree.apply.message": "要把这个任务的变更应用到主项目吗？",
    "worktree.apply.detail":
      "这些变更会成为主项目中的未提交 Diff，随后删除隔离分支和目录。",
    "worktree.apply.confirm": "应用变更",
    "worktree.discard.title": "丢弃隔离变更？",
    "worktree.discard.message": "要永久丢弃这个任务的隔离变更吗？",
    "worktree.discard.detail":
      "隔离分支和目录会被删除，且无法撤销。",
    "worktree.discard.confirm": "丢弃变更",
    "worktree.cleanup.title": "完成隔离目录清理？",
    "worktree.cleanup.message":
      "要移除这个已应用任务残留的隔离分支和目录吗？",
    "worktree.cleanup.detail":
      "Brace 会先确认该任务的精确 Patch 已存在于主项目，不会改动主项目中的变更。",
    "worktree.cleanup.confirm": "重试清理",
    "model.keyRequired": "请输入与当前供应商和接口地址匹配的 API Key。",
    "model.401": "API Key 无效，或与当前供应商/产品不匹配。",
    "model.403": "当前 Key 无权使用该模型或 Coding Plan。",
    "model.404": "接口地址或模型 ID 不存在。",
    "model.429": "请求过于频繁，或当前套餐额度已经用尽。",
    "model.connectionFailedWithMessage": "模型连接失败：{message}",
    "model.connectionFailed":
      "模型连接失败，请检查网络、接口地址、模型和 API Key。",
    "model.settingsNotReady": "模型设置尚未就绪。",
    "model.stopActive": "请先停止正在运行的任务，再更改模型设置。",
    "model.configNotReady": "本地模型配置尚未就绪。",
    "settingsError.secure_storage_unavailable":
      "系统安全存储当前不可用。请改用进程环境变量 LLM_API_KEY。",
    "settingsError.credential_scope_changed":
      "已保存的 API Key 属于其他供应商或接口。请输入新 Key，或先移除已保存的 Key。",
    "settingsError.settings_read_failed": "无法读取桌面模型设置。",
    "settingsError.settings_write_failed": "无法保存桌面模型设置。",
    "settingsError.settings_input_invalid":
      "模型设置无效，请检查接口地址、模型和 API Key。",
    "settingsError.credential_scope_invalid":
      "已保存的模型凭据与当前供应商接口不匹配。",
    "settingsError.custom_endpoint_invalid":
      "已保存的自定义模型接口无效。",
    "settingsError.provider_endpoint_invalid":
      "该接口地址与所选供应商或套餐不匹配。",
    "settingsError.credential_decryption_unavailable":
      "系统安全存储当前不可用，无法解密已保存的模型 Key。",
    "settingsError.credential_decryption_failed":
      "无法解密已保存的模型 Key。",
    "service.notReady": "本地编码服务尚未就绪。",
    "notification.approvalTitle": "Brace 需要确认",
    "notification.approvalBody": "{tool} 正在等待你的审批。",
    "notification.completedTitle": "Agent 已结束本次响应",
    "notification.completedBody":
      "请审查工作区 Diff，并运行相关验证后再决定是否保留结果。",
    "notification.failedTitle": "Brace 需要处理",
    "notification.failedBody":
      "任务因错误而结束。请检查错误信息和已经产生的变更。",
    "startup.title": "Brace 启动失败",
    "startup.unknown": "未知启动错误。",
    "startup.iconUnavailable": "Brace 应用图标不可用。",
  },
};

let mainWindow: BrowserWindow | null = null;
let service: LocalCodingService | null = null;
let settingsStore: DesktopSettingsStore | null = null;
let uiPreferencesStore: DesktopUiPreferencesStore | null = null;
let currentConfig: LocalAgentConfig | null = null;
let environmentConfig: LocalAgentConfig | null = null;
let apiKeySource: DesktopApiKeySource = "none";
let userDataPath = "";
let disposed = false;
let forceWindowClose = false;
let closePromptOpen = false;
let desktopLocale: DesktopLocale = "en";
let desktopTheme: DesktopTheme = "system";

function mainText(
  key: string,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const template = MAIN_MESSAGES[desktopLocale][key] ?? MAIN_MESSAGES.en[key] ?? key;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) =>
    Object.hasOwn(parameters, name) ? String(parameters[name]) : match,
  );
}

function localService(): LocalCodingService {
  if (!service) throw new Error(mainText("service.notReady"));
  return service;
}

function assertTrustedIpcSender(event: Electron.IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    !event.senderFrame ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("Rejected IPC call from an untrusted frame.");
  }
}

function desktopWindowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#111216" : "#f7f7f9";
}

function applyDesktopTheme(theme: DesktopTheme): void {
  desktopTheme = theme;
  nativeTheme.themeSource = theme;
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    process.platform !== "darwin"
  ) {
    mainWindow.setBackgroundColor(desktopWindowBackground());
  }
}

function desktopIconPath(): string {
  return path.join(__dirname, "assets", "base-agent-icon.png");
}

function createWindow(): BrowserWindow {
  const platformMaterial =
    process.platform === "darwin"
      ? {
          backgroundColor: "#00000000",
          hasShadow: true,
          roundedCorners: true,
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 15 },
          transparent: true,
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : process.platform === "win32"
        ? {
            backgroundColor: desktopWindowBackground(),
            backgroundMaterial: "mica" as const,
          }
        : { backgroundColor: desktopWindowBackground() };
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 680,
    title: PRODUCT_NAME,
    icon: desktopIconPath(),
    show: false,
    ...platformMaterial,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [
        `--base-agent-ui-locale=${desktopLocale}`,
        `--base-agent-ui-theme=${desktopTheme}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (details) => {
    if (!isAllowedPreviewNavigation(details.url, details.isMainFrame)) {
      if (isDirectPreviewFrame(window, details.frame)) {
        sendPreviewStatus(window, {
          kind: "blocked",
          url: details.url,
          code: "preview.blockedNavigation",
        });
      }
      details.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (details) => {
    if (!isAllowedPreviewNavigation(details.url, details.isMainFrame)) {
      if (isDirectPreviewFrame(window, details.frame)) {
        sendPreviewStatus(window, {
          kind: "blocked",
          url: details.url,
          code: "preview.blockedRedirect",
        });
      }
      details.preventDefault();
    }
  });
  window.webContents.on(
    "did-fail-load",
    (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      if (isMainFrame || errorCode === -3) return;
      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!isDirectPreviewFrame(window, frame ?? null)) return;
      sendPreviewStatus(window, {
        kind: "failed",
        url: validatedURL,
        ...previewErrorStatus(errorCode, errorDescription),
        errorCode,
      });
    },
  );
  window.once("ready-to-show", () => window.show());
  void window.loadFile(path.join(__dirname, "renderer", "index.html"));
  return window;
}

function isDirectPreviewFrame(
  window: BrowserWindow,
  frame: Electron.WebFrameMain | null,
): boolean {
  return frame?.parent === window.webContents.mainFrame;
}

function sendPreviewStatus(
  window: BrowserWindow,
  status: PreviewNavigationStatus,
): void {
  if (window.isDestroyed()) return;
  window.webContents.send(IPC.previewStatus, status);
}

function previewErrorStatus(
  errorCode: number,
  fallback: string,
): Pick<Extract<PreviewNavigationStatus, { kind: "failed" }>, "code" | "detail"> {
  if (errorCode === -102) {
    return { code: "preview.cannotConnect" };
  }
  if (errorCode === -105) {
    return { code: "preview.cannotResolve" };
  }
  if (errorCode === -106) {
    return { code: "preview.noNetwork" };
  }
  return fallback
    ? { code: "preview.loadFailedWithDescription", detail: fallback }
    : { code: "preview.loadFailed" };
}

function createMainWindow(): BrowserWindow {
  const window = createWindow();
  mainWindow = window;
  window.on("close", (event) => {
    const activeService = service;
    if (
      disposed ||
      forceWindowClose ||
      !activeService?.hasInFlightOperations()
    ) {
      return;
    }
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    void dialog
      .showMessageBox(window, {
        type: "question",
        title: mainText("close.title"),
        message: mainText("close.message"),
        detail: mainText("close.detail"),
        buttons: [
          mainText("close.keepRunning"),
          mainText("close.stopAndClose"),
          mainText("action.cancel"),
        ],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      .then(async ({ response }) => {
        closePromptOpen = false;
        if (response === 2 || window.isDestroyed()) return;
        if (response === 1) {
          await rebuildLocalService(activeService);
        }
        if (window.isDestroyed()) return;
        forceWindowClose = true;
        window.close();
        forceWindowClose = false;
      });
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function sendMenuAction(action: DesktopMenuAction): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC.menuAction, action);
}

function registerApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const appName = { app: PRODUCT_NAME };
  const settingsItem: MenuItemConstructorOptions = {
    label: mainText("menu.settings"),
    accelerator: "CmdOrCtrl+,",
    click: () => sendMenuAction("open-settings"),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: PRODUCT_NAME,
            submenu: [
              {
                role: "about" as const,
                label: mainText("role.about", appName),
              },
              { type: "separator" as const },
              settingsItem,
              { type: "separator" as const },
              {
                role: "services" as const,
                label: mainText("role.services"),
              },
              { type: "separator" as const },
              {
                role: "hide" as const,
                label: mainText("role.hide", appName),
              },
              {
                role: "hideOthers" as const,
                label: mainText("role.hideOthers"),
              },
              {
                role: "unhide" as const,
                label: mainText("role.unhide"),
              },
              { type: "separator" as const },
              {
                role: "quit" as const,
                label: mainText("role.quit", appName),
              },
            ],
          },
        ]
      : []),
    {
      label: mainText("menu.file"),
      submenu: [
        {
          label: mainText("menu.openProject"),
          accelerator: "CmdOrCtrl+O",
          click: () => sendMenuAction("open-project"),
        },
        {
          label: mainText("menu.newTask"),
          accelerator: "CmdOrCtrl+N",
          click: () => sendMenuAction("new-task"),
        },
        ...(!isMac
          ? [
              { type: "separator" as const },
              settingsItem,
              { type: "separator" as const },
              {
                role: "quit" as const,
                label: mainText("role.quit", appName),
              },
            ]
          : [
              { type: "separator" as const },
              {
                role: "close" as const,
                label: mainText("role.close"),
              },
            ]),
      ],
    },
    {
      label: mainText("menu.edit"),
      submenu: [
        { role: "undo", label: mainText("role.undo") },
        { role: "redo", label: mainText("role.redo") },
        { type: "separator" },
        { role: "cut", label: mainText("role.cut") },
        { role: "copy", label: mainText("role.copy") },
        { role: "paste", label: mainText("role.paste") },
        ...(isMac
          ? [
              {
                role: "pasteAndMatchStyle" as const,
                label: mainText("role.pasteAndMatchStyle"),
              },
              {
                role: "delete" as const,
                label: mainText("role.delete"),
              },
              {
                role: "selectAll" as const,
                label: mainText("role.selectAll"),
              },
              { type: "separator" as const },
              {
                label: mainText("menu.speech"),
                submenu: [
                  {
                    role: "startSpeaking" as const,
                    label: mainText("role.startSpeaking"),
                  },
                  {
                    role: "stopSpeaking" as const,
                    label: mainText("role.stopSpeaking"),
                  },
                ],
              },
            ]
          : [
              {
                role: "delete" as const,
                label: mainText("role.delete"),
              },
              {
                role: "selectAll" as const,
                label: mainText("role.selectAll"),
              },
            ]),
      ],
    },
    {
      label: mainText("menu.view"),
      submenu: [
        {
          label: mainText("menu.togglePreview"),
          accelerator: "CmdOrCtrl+Shift+P",
          click: () => sendMenuAction("toggle-preview"),
        },
        {
          label: mainText("menu.toggleInspector"),
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => sendMenuAction("toggle-inspector"),
        },
        { type: "separator" },
        { role: "resetZoom", label: mainText("role.resetZoom") },
        { role: "zoomIn", label: mainText("role.zoomIn") },
        { role: "zoomOut", label: mainText("role.zoomOut") },
        { type: "separator" },
        {
          role: "togglefullscreen",
          label: mainText("role.togglefullscreen"),
        },
      ],
    },
    {
      label: mainText("menu.window"),
      submenu: isMac
        ? [
            { role: "minimize", label: mainText("role.minimize") },
            { role: "zoom", label: mainText("role.zoom") },
            { type: "separator" },
            { role: "front", label: mainText("role.front") },
          ]
        : [
            { role: "minimize", label: mainText("role.minimize") },
            { role: "close", label: mainText("role.close") },
          ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.setUiPreferences, async (event, input: unknown) => {
    assertTrustedIpcSender(event);
    const preferences = parseDesktopUiPreferences(input);
    if (!uiPreferencesStore) {
      throw new Error(mainText("service.notReady"));
    }
    await uiPreferencesStore.save(preferences);
    const localeChanged = desktopLocale !== preferences.locale;
    desktopLocale = preferences.locale;
    applyDesktopTheme(preferences.theme);
    if (localeChanged) registerApplicationMenu();
    return preferences;
  });
  ipcMain.handle(IPC.snapshot, (event) => {
    assertTrustedIpcSender(event);
    return localService().snapshot();
  });
  ipcMain.handle(IPC.selectProject, async (event) => {
    assertTrustedIpcSender(event);
    const options: Electron.OpenDialogOptions = {
      title: mainText("dialog.openProject"),
      properties: ["openDirectory", "createDirectory"],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || selection.filePaths.length === 0) return null;
    return localService().addProject(selection.filePaths[0]);
  });
  ipcMain.handle(IPC.getThread, (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return localService().getThread(input);
  });
  ipcMain.handle(IPC.startTask, (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return localService().startTask(input);
  });
  ipcMain.handle(IPC.cancelTask, (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return localService().cancelTask(input);
  });
  ipcMain.handle(IPC.decideApproval, (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return localService().decideApproval(input);
  });
  ipcMain.handle(IPC.getDiff, (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return localService().getDiff(input);
  });
  ipcMain.handle(IPC.getWorktree, (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return localService().getWorktree(input);
  });
  ipcMain.handle(IPC.resolveWorktree, async (event, input: unknown) => {
    assertTrustedIpcSender(event);
    const request = parseWorktreeResolutionRequest(input);
    const prefix = `worktree.${request.action}`;
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: mainText(`${prefix}.title`),
      message: mainText(`${prefix}.message`),
      detail: mainText(`${prefix}.detail`),
      buttons: [
        mainText(`${prefix}.confirm`),
        mainText("action.cancel"),
      ],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const confirmation = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (confirmation.response !== 0) return null;
    return localService().resolveWorktree({
      ...request,
      confirmed: true,
    });
  });
  ipcMain.handle(IPC.openWorkspace, async (event, input: unknown) => {
    assertTrustedIpcSender(event);
    const detail = localService().getThread(input);
    const error = await shell.openPath(detail.thread.workspacePath);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle(IPC.getModelSettings, (event) => {
    assertTrustedIpcSender(event);
    return currentModelSettingsSnapshot();
  });
  ipcMain.handle(IPC.testModelSettings, async (event, input: unknown) => {
    assertTrustedIpcSender(event);
    if (!settingsStore) throw new Error(mainText("model.settingsNotReady"));
    const candidate = await resolveDesktopSettings(input);
    const resolved = resolveDesktopRuntimeConfig(
      candidate,
      environmentConfig,
      process.env,
    );
    if (!resolved.config.LLM_API_KEY) {
      throw new Error(mainText("model.keyRequired"));
    }
    try {
      const result = await testLocalModelConnection(resolved.config);
      return {
        provider: resolved.config.LLM_PROVIDER,
        baseUrl: resolved.config.LLM_BASE_URL,
        model: resolved.config.LLM_MODEL,
        latencyMs: result.latencyMs,
      };
    } catch (error) {
      throw modelConnectionError(error);
    }
  });
  ipcMain.handle(IPC.saveModelSettings, async (event, input: unknown) => {
    assertTrustedIpcSender(event);
    if (!settingsStore) throw new Error(mainText("model.settingsNotReady"));
    const activeService = localService();
    if (activeService.hasInFlightOperations()) {
      throw new Error(mainText("model.stopActive"));
    }
    await rebuildLocalService(activeService, async () => {
      const saved = await saveDesktopSettings(input);
      const resolved = resolveDesktopRuntimeConfig(
        saved,
        environmentConfig,
        process.env,
      );
      currentConfig = resolved.config;
      apiKeySource = resolved.apiKeySource;
    });
    return currentModelSettingsSnapshot();
  });
}

function parseWorktreeResolutionRequest(input: unknown): {
  readonly threadId: string;
  readonly action: "apply" | "discard" | "cleanup";
} {
  if (!input || typeof input !== "object") {
    throw new TypeError("Invalid worktree resolution request.");
  }
  const candidate = input as Record<string, unknown>;
  const threadId =
    typeof candidate.threadId === "string" ? candidate.threadId.trim() : "";
  if (
    threadId.length === 0 ||
    threadId.length > 128 ||
    candidate.action !== "apply" &&
    candidate.action !== "discard" &&
    candidate.action !== "cleanup"
  ) {
    throw new TypeError("Invalid worktree resolution request.");
  }
  return {
    threadId,
    action: candidate.action,
  };
}

function currentModelSettingsSnapshot() {
  if (!currentConfig) throw new Error(mainText("model.settingsNotReady"));
  return {
    provider: currentConfig.LLM_PROVIDER,
    providers: OPENAI_COMPATIBLE_MODEL_PROVIDERS.map(
      ({
        id,
        label,
        description,
        baseUrl,
        defaultModel,
        recommendedModels,
        apiKeyHint,
        notice,
      }) => ({
        id,
        label,
        description,
        baseUrl,
        defaultModel,
        recommendedModels,
        apiKeyHint,
        ...(notice ? { notice } : {}),
      }),
    ),
    baseUrl: currentConfig.LLM_BASE_URL,
    model: currentConfig.LLM_MODEL,
    hasApiKey: Boolean(currentConfig.LLM_API_KEY),
    apiKeySource,
    // macOS always uses Keychain for safeStorage. Querying it during ordinary
    // renderer refresh can itself wake Keychain UI in unsigned development
    // builds, so defer actual access until the user saves or loads a key.
    secureStorageAvailable:
      process.platform === "darwin" || safeStorage.isEncryptionAvailable(),
  };
}

async function resolveDesktopSettings(input: unknown) {
  if (!settingsStore) throw new Error(mainText("model.settingsNotReady"));
  try {
    return await settingsStore.resolve(input);
  } catch (error) {
    throw localizedDesktopSettingsError(error);
  }
}

async function saveDesktopSettings(input: unknown) {
  if (!settingsStore) throw new Error(mainText("model.settingsNotReady"));
  try {
    return await settingsStore.save(input);
  } catch (error) {
    throw localizedDesktopSettingsError(error);
  }
}

function localizedDesktopSettingsError(error: unknown): Error {
  const code = desktopSettingsErrorCode(error);
  return code
    ? new Error(mainText(`settingsError.${code}`), { cause: error })
    : error instanceof Error
      ? error
      : new Error(mainText("startup.unknown"));
}

function modelConnectionError(error: unknown): Error {
  const status = errorStatus(error);
  const messages = new Map<number, string>([
    [401, mainText("model.401")],
    [403, mainText("model.403")],
    [404, mainText("model.404")],
    [429, mainText("model.429")],
  ]);
  return new Error(
    messages.get(status ?? 0) ??
      (error instanceof Error
        ? mainText("model.connectionFailedWithMessage", {
            message: error.message,
          })
        : mainText("model.connectionFailed")),
    { cause: error },
  );
}

function errorStatus(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return null;
    if ("status" in current && typeof current.status === "number") {
      return current.status;
    }
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

function createLocalService(): LocalCodingService {
  if (!currentConfig) throw new Error(mainText("model.configNotReady"));
  const store = new LocalAgentStore(
    path.join(userDataPath, "base-agent.sqlite"),
  );
  return new LocalCodingService({
    store,
    config: currentConfig,
    worktreeRoot: path.join(userDataPath, "worktrees"),
    onEvent(event) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.event, event);
      }
      if (
        event.type === "approval.changed" &&
        event.approval.status === "pending"
      ) {
        showDesktopNotification(
          mainText("notification.approvalTitle"),
          mainText("notification.approvalBody", {
            tool: event.approval.toolName,
          }),
        );
      }
      if (
        event.type === "run.changed" &&
        (event.run.status === "completed" || event.run.status === "failed")
      ) {
        const prefix =
          event.run.status === "completed"
            ? "notification.completed"
            : "notification.failed";
        showDesktopNotification(
          mainText(`${prefix}Title`),
          mainText(`${prefix}Body`),
        );
      }
    },
  });
}

function showDesktopNotification(title: string, body: string): void {
  if (
    (mainWindow && mainWindow.isFocused()) ||
    !Notification.isSupported()
  ) {
    return;
  }
  const notification = new Notification({ title, body });
  notification.on("click", () => {
    const window = mainWindow ?? createMainWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  notification.show();
}

async function rebuildLocalService(
  activeService: LocalCodingService,
  beforeCreate?: () => void | Promise<void>,
): Promise<void> {
  const replacesCurrentService = service === activeService;
  if (replacesCurrentService) service = null;
  try {
    await activeService.dispose();
    await beforeCreate?.();
  } finally {
    if (replacesCurrentService && !disposed && !service) {
      service = createLocalService();
    }
  }
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  const activeService = service;
  service = null;
  await activeService?.dispose();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!service) return;
    const window = mainWindow ?? createMainWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.whenReady().then(async () => {
    userDataPath = app.getPath("userData");
    uiPreferencesStore = new DesktopUiPreferencesStore(userDataPath);
    const uiPreferences = await uiPreferencesStore.load();
    desktopLocale = uiPreferences.locale;
    applyDesktopTheme(uiPreferences.theme);
    app.setAboutPanelOptions({ applicationName: PRODUCT_NAME });
    if (process.platform === "darwin" && app.dock) {
      const dockIcon = nativeImage.createFromPath(desktopIconPath());
      if (dockIcon.isEmpty()) {
        throw new Error(mainText("startup.iconUnavailable"));
      }
      app.dock.setIcon(dockIcon);
    }
    loadEnvironment({
      path: [
        path.join(userDataPath, ".env"),
        path.join(process.cwd(), ".env.local"),
        path.join(process.cwd(), ".env"),
      ],
      quiet: true,
    });
    environmentConfig = getLocalAgentConfig(process.env);
    settingsStore = new DesktopSettingsStore(userDataPath);
    const saved = await settingsStore.load().catch((error: unknown) => {
      throw localizedDesktopSettingsError(error);
    });
    const hasSavedSettings = saved.model !== null;
    if (hasSavedSettings) {
      const resolved = resolveDesktopRuntimeConfig(
        saved,
        environmentConfig,
        process.env,
      );
      currentConfig = resolved.config;
      apiKeySource = resolved.apiKeySource;
    } else {
      currentConfig = environmentConfig;
      apiKeySource = currentConfig.LLM_API_KEY ? "environment" : "none";
    }
    service = createLocalService();

    session.defaultSession.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    registerIpcHandlers();
    mainWindow = createMainWindow();
    registerApplicationMenu();

    app.on("activate", () => {
      if (!mainWindow) createMainWindow();
    });
  }).catch((error: unknown) => {
    dialog.showErrorBox(
      mainText("startup.title"),
      localizedDesktopSettingsError(error).message,
    );
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (disposed) return;
    event.preventDefault();
    void dispose().finally(() => app.quit());
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
