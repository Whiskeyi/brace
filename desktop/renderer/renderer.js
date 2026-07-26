const preferences = window.baseAgentPreferences;
const richText = window.baseAgentRichText;
const t = (key, parameters = {}, fallback = key) =>
  preferences.t(key, parameters, fallback);
const MAX_RENDERED_TIMELINE_ITEMS = 400;

const elements = {
  workspace: document.querySelector("#workspace"),
  openProject: document.querySelector("#open-project"),
  newTask: document.querySelector("#new-task"),
  modelSettings: document.querySelector("#model-settings"),
  modelStatus: document.querySelector("#model-status"),
  projectList: document.querySelector("#project-list"),
  threadList: document.querySelector("#thread-list"),
  pendingApprovalCount: document.querySelector("#pending-approval-count"),
  projectPath: document.querySelector("#project-path"),
  threadTitle: document.querySelector("#thread-title"),
  mode: document.querySelector("#execution-mode"),
  openWorkspace: document.querySelector("#open-workspace"),
  showDiff: document.querySelector("#show-diff"),
  togglePreview: document.querySelector("#toggle-preview"),
  toggleInspector: document.querySelector("#toggle-inspector"),
  inspector: document.querySelector("#inspector"),
  inspectorClose: document.querySelector("#inspector-close"),
  inspectorScrim: document.querySelector("#inspector-scrim"),
  cancelRun: document.querySelector("#cancel-run"),
  empty: document.querySelector("#empty-panel"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyDescription: document.querySelector("#empty-description"),
  connectModel: document.querySelector("#connect-model"),
  emptyOpenProject: document.querySelector("#empty-open-project"),
  suggestionList: document.querySelector("#suggestion-list"),
  timeline: document.querySelector("#timeline"),
  previewPanel: document.querySelector("#preview-panel"),
  previewForm: document.querySelector("#preview-form"),
  previewUrl: document.querySelector("#preview-url"),
  previewFrame: document.querySelector("#preview-frame"),
  previewViewport: document.querySelector(".preview-viewport"),
  previewEmpty: document.querySelector("#preview-empty"),
  previewEmptyCopy: document.querySelector("#preview-empty-copy"),
  previewExample: document.querySelector("#preview-example"),
  previewFeedback: document.querySelector("#preview-feedback"),
  previewFeedbackTitle: document.querySelector("#preview-feedback-title"),
  previewFeedbackMessage: document.querySelector("#preview-feedback-message"),
  previewRetry: document.querySelector("#preview-retry"),
  previewRefresh: document.querySelector("#preview-refresh"),
  previewClose: document.querySelector("#preview-close"),
  previewStatus: document.querySelector("#preview-status"),
  previewStatusDot: document.querySelector("#preview-status-dot"),
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  sendTask: document.querySelector("#send-task"),
  runtimeStatus: document.querySelector("#runtime-status"),
  composerStatusDot: document.querySelector(".composer-status-dot"),
  keyboardHint: document.querySelector("#keyboard-hint"),
  taskOutcome: document.querySelector("#task-outcome"),
  outcomeIndicator: document.querySelector("#outcome-indicator"),
  outcomeTitle: document.querySelector("#outcome-title"),
  outcomeDescription: document.querySelector("#outcome-description"),
  outcomeReview: document.querySelector("#outcome-review"),
  outcomeNext: document.querySelector("#outcome-next"),
  runCard: document.querySelector("#run-card"),
  worktreeSection: document.querySelector("#worktree-section"),
  worktreeBranch: document.querySelector("#worktree-branch"),
  worktreeStatus: document.querySelector("#worktree-status"),
  worktreeApply: document.querySelector("#worktree-apply"),
  worktreeDiscard: document.querySelector("#worktree-discard"),
  approvals: document.querySelector("#approval-list"),
  diff: document.querySelector("#diff-output"),
  diffMeta: document.querySelector("#diff-meta"),
  settingsDialog: document.querySelector("#settings-dialog"),
  settingsForm: document.querySelector("#settings-form"),
  settingsCancel: document.querySelector("#settings-cancel"),
  settingsDismiss: document.querySelector("#settings-dismiss"),
  settingsLanguage: document.querySelector("#settings-language"),
  settingsTheme: document.querySelector("#settings-theme"),
  accentOptions: [
    ...document.querySelectorAll("[data-accent-value]"),
  ],
  settingsProvider: document.querySelector("#settings-provider"),
  settingsProviderNote: document.querySelector("#settings-provider-note"),
  settingsBaseUrl: document.querySelector("#settings-base-url"),
  settingsBaseUrlNote: document.querySelector("#settings-base-url-note"),
  settingsModel: document.querySelector("#settings-model"),
  settingsModelOptions: document.querySelector("#settings-model-options"),
  settingsApiKey: document.querySelector("#settings-api-key"),
  settingsKeyStatus: document.querySelector("#settings-key-status"),
  settingsClearKey: document.querySelector("#settings-clear-key"),
  clearKeyField: document.querySelector("#clear-key-field"),
  settingsSecurityNote: document.querySelector("#settings-security-note"),
  settingsError: document.querySelector("#settings-error"),
  settingsConnectionResult: document.querySelector(
    "#settings-connection-result",
  ),
  settingsTest: document.querySelector("#settings-test"),
  suggestions: [...document.querySelectorAll(".suggestion")],
  toast: document.querySelector("#toast"),
};

let snapshot = { projects: [], threads: [], activeRunIds: [] };
let selectedProjectId = null;
let selectedThreadId = null;
let detail = null;
let modelSettings = null;
let inspectorVisible = false;
let previewVisible = false;
let previewContextKey = null;
let previewLoadedUrl = null;
let previewLoadState = "idle";
let previewNavigationId = 0;
let previewLoadTimer = null;
let previewPreviousFocus = null;
let previewShouldFollowTimeline = true;
let previewTimelineScrollTop = 0;
let toastTimer = null;
let submitInFlight = false;
let settingsSaving = false;
let settingsTesting = false;
let cancelInFlight = false;
let worktreeMetadata = null;
let worktreeLoaded = false;
let worktreeBusy = false;
let threadRequestGeneration = 0;
let worktreeRequestGeneration = 0;
let diffRequestGeneration = 0;
let diffPreparedForRunId = null;
let snapshotRequestGeneration = 0;
let inspectorPreviousFocus = null;
const approvalBusy = new Set();
const drafts = new Map();
const runThreadIds = new Map();
const eventRecordKeys = new Set();
const liveMessageNodes = new Map();
let currentDraftKey = "none:new";
const compactInspectorQuery = window.matchMedia("(max-width: 1240px)");

async function initialize() {
  preferences.applyDocumentTranslations();
  syncPreferenceControls();
  bindActions();
  setInspectorVisible(localStorage.getItem("base-agent:inspector") === "visible");
  setPreviewVisible(false);
  window.baseAgent.onEvent(handleEvent);
  window.baseAgent.onMenuAction(handleMenuAction);
  window.baseAgent.onPreviewStatus(handlePreviewStatus);
  elements.keyboardHint.textContent = navigator.platform
    .toLowerCase()
    .includes("mac")
    ? "⌘ ↵"
    : "Ctrl ↵";
  await Promise.all([refreshSnapshot(), refreshModelSettings()]);
  await restoreProjectContext();
}

function syncPreferenceControls() {
  elements.settingsLanguage.value = preferences.locale;
  elements.settingsTheme.value = preferences.theme;
  for (const option of elements.accentOptions) {
    option.setAttribute(
      "aria-pressed",
      String(option.dataset.accentValue === preferences.accent),
    );
  }
}

async function updateDesktopPreferences(nextPreferences) {
  try {
    const saved = await window.baseAgent.setUiPreferences(nextPreferences);
    preferences.setLocale(saved.locale);
    preferences.setTheme(saved.theme);
    syncPreferenceControls();
    renderLocalizedState();
  } catch (error) {
    syncPreferenceControls();
    showError(error);
  }
}

function renderLocalizedState() {
  const providerId = elements.settingsProvider.value;
  preferences.applyDocumentTranslations();
  if (modelSettings && elements.settingsProvider.options.length > 0) {
    populateModelProviders();
    elements.settingsProvider.value = providerId || modelSettings.provider;
    syncProviderFields();
  }
  render();
  setInspectorVisible(inspectorVisible);
  setPreviewVisible(previewVisible);
  syncPreviewEmptyState();
  if (previewLoadState === "idle") {
    setPreviewStatus("neutral", t("preview.restricted"));
  } else if (previewLoadState === "loading") {
    showPreviewFeedback(
      "loading",
      t("preview.connecting.title"),
      t("preview.connecting.description"),
    );
    if (previewLoadedUrl) {
      setPreviewStatus(
        "loading",
        t("preview.connectingHost", { host: new URL(previewLoadedUrl).host }),
      );
    }
  } else if (previewLoadState === "ready" && previewLoadedUrl) {
    setPreviewStatus(
      "ready",
      t("preview.ready", { host: new URL(previewLoadedUrl).host }),
    );
  } else if (previewLoadState === "error") {
    elements.previewFeedbackTitle.textContent = t("preview.errorTitle");
  }
}

function bindActions() {
  elements.openProject.addEventListener("click", async () => {
    await runUiAction(async () => {
      const project = await window.baseAgent.selectProject();
      if (!project) return;
      saveCurrentDraft();
      selectedProjectId = project.id;
      selectedThreadId = null;
      setDetail(null);
      await refreshSnapshot();
      await restoreProjectContext();
    });
  });

  elements.newTask.addEventListener("click", () => {
    const runningThread = activeThreadForProject();
    if (runningThread) {
      showToast(
        runningThread.status === "waiting_for_approval"
          ? t("thread.activeApproval")
          : t("thread.activeRun"),
        "info",
      );
      void runUiAction(() => openThread(runningThread.id));
      return;
    }
    saveCurrentDraft();
    selectedThreadId = null;
    setDetail(null);
    localStorage.removeItem("base-agent:thread");
    setInspectorVisible(false);
    restoreDraft();
    elements.prompt.focus();
    render();
  });

  elements.toggleInspector.addEventListener("click", () => {
    setInspectorVisible(!inspectorVisible, { persist: true });
  });
  elements.inspectorClose.addEventListener("click", () => {
    setInspectorVisible(false, { restoreFocus: true, persist: true });
  });
  elements.inspectorScrim.addEventListener("click", () => {
    setInspectorVisible(false, { restoreFocus: true, persist: true });
  });
  elements.togglePreview.addEventListener("click", () => {
    const opening = !previewVisible;
    setPreviewVisible(opening, {
      focusAddress: opening,
      restoreFocus: !opening,
    });
  });
  elements.previewClose.addEventListener("click", () => {
    stopPreview();
    setPreviewVisible(false, { restoreFocus: true });
  });
  elements.previewExample.addEventListener("click", () => {
    elements.previewUrl.value =
      elements.previewExample.dataset.url ?? "http://localhost:3000";
    elements.previewForm.requestSubmit();
  });
  elements.previewForm.addEventListener("submit", (event) => {
    event.preventDefault();
    openPreview(elements.previewUrl.value);
  });
  elements.previewRefresh.addEventListener("click", () => {
    if (!previewLoadedUrl) return;
    beginPreviewNavigation(previewLoadedUrl, t("preview.refreshing"));
  });
  elements.previewRetry.addEventListener("click", () => {
    if (!previewLoadedUrl) return;
    beginPreviewNavigation(previewLoadedUrl, t("preview.reconnecting"));
  });
  elements.previewFrame.addEventListener("load", () => {
    if (!previewLoadedUrl || previewLoadState !== "loading") return;
    markPreviewReady();
  });
  compactInspectorQuery.addEventListener("change", syncInspectorModality);

  for (const suggestion of elements.suggestions) {
    suggestion.addEventListener("click", () => {
      if (suggestion.disabled) return;
      elements.prompt.value = suggestion.dataset.prompt ?? "";
      resizePrompt();
      renderComposer();
      elements.prompt.focus();
    });
  }

  elements.modelSettings.addEventListener("click", () => {
    void openSettings();
  });
  elements.connectModel.addEventListener("click", () => {
    void openSettings({ focusModel: true });
  });
  elements.emptyOpenProject.addEventListener("click", () => {
    elements.openProject.click();
  });
  elements.outcomeReview.addEventListener("click", () => {
    if (!detail) return;
    setInspectorVisible(true, { focusPanel: true, persist: true });
    void loadDiff();
  });
  elements.outcomeNext.addEventListener("click", continueFromOutcome);

  for (const button of [elements.settingsCancel, elements.settingsDismiss]) {
    button.addEventListener("click", () => elements.settingsDialog.close());
  }
  elements.settingsDialog.addEventListener("click", (event) => {
    if (event.target === elements.settingsDialog) {
      elements.settingsDialog.close();
    }
  });
  elements.settingsDialog.addEventListener("close", resetSensitiveSettingsFields);

  elements.settingsLanguage.addEventListener("change", () => {
    void updateDesktopPreferences({
      locale: elements.settingsLanguage.value,
      theme: preferences.theme,
    });
  });
  elements.settingsTheme.addEventListener("change", () => {
    void updateDesktopPreferences({
      locale: preferences.locale,
      theme: elements.settingsTheme.value,
    });
  });
  for (const option of elements.accentOptions) {
    option.addEventListener("click", () => {
      if (!preferences.setAccent(option.dataset.accentValue)) return;
      syncPreferenceControls();
    });
  }

  elements.settingsClearKey.addEventListener("change", () => {
    syncKeyControls();
    clearSettingsConnectionResult();
  });
  elements.settingsProvider.addEventListener("change", () => {
    const provider = selectedModelProvider();
    if (!provider) return;
    elements.settingsBaseUrl.value = provider.baseUrl;
    elements.settingsModel.value = provider.defaultModel;
    elements.settingsApiKey.value = "";
    elements.settingsClearKey.checked = false;
    syncProviderFields();
    clearSettingsConnectionResult();
  });
  elements.settingsBaseUrl.addEventListener("input", () => {
    syncKeyControls();
    clearSettingsConnectionResult();
  });
  elements.settingsModel.addEventListener(
    "input",
    clearSettingsConnectionResult,
  );
  elements.settingsApiKey.addEventListener(
    "input",
    clearSettingsConnectionResult,
  );

  elements.settingsTest.addEventListener("click", async () => {
    if (settingsSaving || settingsTesting) return;
    if (!elements.settingsForm.reportValidity()) return;
    settingsTesting = true;
    setSettingsBusy(true);
    clearSettingsError();
    clearSettingsConnectionResult();
    try {
      const result = await window.baseAgent.testModelSettings(
        currentModelSettingsInput(),
      );
      elements.settingsConnectionResult.textContent =
        t("settings.connectionSuccess", {
          model: result.model,
          latency: result.latencyMs,
        });
      elements.settingsConnectionResult.classList.remove("hidden");
    } catch (error) {
      showSettingsError(error);
    } finally {
      settingsTesting = false;
      setSettingsBusy(false);
    }
  });

  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (settingsSaving || settingsTesting) return;
    settingsSaving = true;
    setSettingsBusy(true);
    clearSettingsError();
    try {
      modelSettings = await window.baseAgent.saveModelSettings(
        currentModelSettingsInput(),
      );
      elements.settingsApiKey.value = "";
      elements.settingsDialog.close();
      render();
      showToast(t("settings.saved"), "success");
      await refreshSnapshot();
      if (selectedThreadId) await openThread(selectedThreadId);
    } catch (error) {
      showSettingsError(error);
    } finally {
      settingsSaving = false;
      setSettingsBusy(false);
    }
  });

  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitInFlight) return;
    if (modelSettings?.hasApiKey !== true) {
      showToast(t("runtime.connectModel"), "info");
      await openSettings({ focusModel: true });
      return;
    }
    const prompt = elements.prompt.value.trim();
    if (!selectedProjectId || !prompt) return;
    if (detail?.thread.worktreeCleanupCommit) {
      setInspectorVisible(true, { focusPanel: true });
      showToast(t("runtime.cleanupRequired"), "info");
      return;
    }
    const runningThread = activeThreadForProject();
    if (runningThread) {
      await runUiAction(() => openThread(runningThread.id));
      showToast(t("settings.activeTask"), "info");
      return;
    }
    const projectIdAtSubmit = selectedProjectId;
    const threadIdAtSubmit = selectedThreadId;
    submitInFlight = true;
    elements.prompt.readOnly = true;
    elements.composer.classList.add("submitting");
    renderComposer();
    try {
      const result = await window.baseAgent.startTask({
        projectId: projectIdAtSubmit,
        ...(threadIdAtSubmit ? { threadId: threadIdAtSubmit } : {}),
        prompt,
        mode: elements.mode.value,
      });
      drafts.delete(currentDraftKey);
      elements.prompt.value = "";
      resizePrompt();
      selectedThreadId = result.thread.id;
      currentDraftKey = draftKey();
      await refreshSnapshot();
      await openThread(result.thread.id);
    } catch (error) {
      showError(error);
    } finally {
      submitInFlight = false;
      elements.prompt.readOnly = false;
      elements.composer.classList.remove("submitting");
      renderComposer();
    }
  });

  elements.cancelRun.addEventListener("click", async () => {
    const run = activeRun();
    if (!run || cancelInFlight) return;
    cancelInFlight = true;
    renderRun();
    try {
      await window.baseAgent.cancelTask(run.id);
      await refreshSnapshot();
      if (selectedThreadId) await openThread(selectedThreadId);
    } catch (error) {
      showError(error);
    } finally {
      cancelInFlight = false;
      renderRun();
    }
  });
  elements.worktreeApply.addEventListener("click", () => {
    void resolveWorktree(
      detail?.thread.worktreeCleanupCommit ? "cleanup" : "apply",
    );
  });
  elements.worktreeDiscard.addEventListener("click", () => {
    void resolveWorktree("discard");
  });

  elements.showDiff.addEventListener("click", () => {
    setInspectorVisible(true);
    void loadDiff();
  });
  elements.openWorkspace.addEventListener("click", async () => {
    if (!selectedThreadId) return;
    await runUiAction(() => window.baseAgent.openWorkspace(selectedThreadId));
  });

  elements.prompt.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (submitInFlight) return;
      elements.composer.requestSubmit();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.repeat) return;
    if (event.key !== "Escape" || elements.settingsDialog.open) return;
    if (inspectorVisible) {
      event.preventDefault();
      setInspectorVisible(false, { restoreFocus: true, persist: true });
    } else if (previewVisible) {
      event.preventDefault();
      setPreviewVisible(false, { restoreFocus: true });
    }
  });
}

async function refreshSnapshot() {
  const generation = ++snapshotRequestGeneration;
  const nextSnapshot = await window.baseAgent.snapshot();
  if (generation !== snapshotRequestGeneration) return;
  snapshot = nextSnapshot;
  if (
    selectedProjectId &&
    !snapshot.projects.some((project) => project.id === selectedProjectId)
  ) {
    saveCurrentDraft();
    selectedProjectId = null;
    selectedThreadId = null;
    setDetail(null);
    restoreDraft();
  }
  if (!selectedProjectId && snapshot.projects.length > 0) {
    saveCurrentDraft();
    const resumableThread =
      snapshot.threads.find(
        (thread) => thread.status === "waiting_for_approval",
      ) ??
      snapshot.threads.find((thread) => thread.status === "running");
    const savedProjectId = localStorage.getItem("base-agent:project");
    const savedProject = snapshot.projects.find(
      (project) => project.id === savedProjectId,
    );
    selectedProjectId =
      resumableThread?.projectId ?? savedProject?.id ?? snapshot.projects[0].id;
    restoreDraft();
  }
  render();
}

async function refreshModelSettings() {
  modelSettings = await window.baseAgent.getModelSettings();
  render();
}

function setDetail(nextDetail) {
  detail = nextDetail;
  worktreeMetadata = null;
  worktreeLoaded = false;
  worktreeRequestGeneration += 1;
  eventRecordKeys.clear();
  liveMessageNodes.clear();
  for (const record of detail?.events ?? []) {
    eventRecordKeys.add(eventRecordKey(record));
  }
}

async function openThread(threadId) {
  const switchingThread = selectedThreadId !== threadId;
  const shouldFollow = switchingThread || isTimelineNearBottom();
  if (switchingThread) {
    saveCurrentDraft();
    selectedThreadId = threadId;
    setDetail(null);
    diffRequestGeneration += 1;
    elements.diff.textContent = t("diff.select");
    elements.diffMeta.textContent = "";
    render();
  }
  const generation = ++threadRequestGeneration;
  selectedThreadId = threadId;
  const nextDetail = await window.baseAgent.getThread(threadId);
  if (generation !== threadRequestGeneration || selectedThreadId !== threadId) return;
  setDetail(nextDetail);
  selectedProjectId = nextDetail.thread.projectId;
  for (const run of nextDetail.runs) {
    runThreadIds.set(run.id, run.threadId);
  }
  if (switchingThread) restoreDraft();
  render();
  prepareTerminalDiff();
  if (
    nextDetail.thread.mode === "worktree" ||
    nextDetail.thread.worktreeCleanupCommit
  ) {
    void refreshWorktree(nextDetail.thread.id).catch(showError);
  }
  if (shouldFollow) scrollTimelineToLatest();
}

async function handleEvent(event) {
  try {
    if (event.type === "project.changed") {
      await refreshSnapshot();
      return;
    }
    if (event.type === "thread.changed" || event.type === "run.changed") {
      if (event.type === "run.changed") {
        runThreadIds.set(event.run.id, event.run.threadId);
      }
      await refreshSnapshot();
      if (
        selectedThreadId &&
        (event.type === "thread.changed"
          ? event.thread.id === selectedThreadId
          : event.run.threadId === selectedThreadId)
      ) {
        await openThread(selectedThreadId);
      }
      return;
    }
    if (event.type === "approval.changed") {
      await refreshSnapshot();
      const targetThreadId =
        runThreadIds.get(event.approval.runId) ??
        detail?.runs.find((run) => run.id === event.approval.runId)?.threadId ??
        snapshot.threads.find(
          (thread) => thread.status === "waiting_for_approval",
        )?.id;
      if (event.approval.status === "pending") {
        if (targetThreadId) await openThread(targetThreadId);
        setInspectorVisible(true, { focusPanel: true });
      } else if (selectedThreadId === targetThreadId) {
        await openThread(selectedThreadId);
      }
      return;
    }
    if (
      event.type === "agent.event" &&
      event.record.threadId === selectedThreadId
    ) {
      const eventThreadId = selectedThreadId;
      const shouldFollow = isTimelineNearBottom();
      const hadDetail = Boolean(detail);
      if (!detail) {
        const nextDetail = await window.baseAgent.getThread(eventThreadId);
        if (selectedThreadId !== eventThreadId) return;
        setDetail(nextDetail);
      }
      const recordKey = eventRecordKey(event.record);
      const alreadyRecorded = eventRecordKeys.has(recordKey);
      if (!alreadyRecorded) {
        detail.events.push(event.record);
        eventRecordKeys.add(recordKey);
      }
      runThreadIds.set(event.record.runId, event.record.threadId);
      if (
        !hadDetail ||
        (!alreadyRecorded && !appendTimelineRecord(event.record))
      ) {
        renderTimeline();
      }
      renderRun();
      if (shouldFollow) scrollTimelineToLatest();
    }
  } catch (error) {
    showError(error);
  }
}

function render() {
  if (selectedProjectId) {
    localStorage.setItem("base-agent:project", selectedProjectId);
  } else {
    localStorage.removeItem("base-agent:project");
  }
  if (selectedThreadId) {
    localStorage.setItem("base-agent:thread", selectedThreadId);
  }
  syncPreviewContext();
  renderProjects();
  renderThreads();
  renderHeader();
  renderEmptyState();
  renderTimeline();
  renderRun();
  renderOutcome();
  renderWorktree();
  renderApprovals();
  renderComposer();
  renderModelStatus();
}

function renderModelStatus() {
  if (!modelSettings) {
    elements.modelStatus.textContent = t("settings.checking");
    return;
  }
  const provider = modelProviderOption(modelSettings.provider);
  elements.modelStatus.textContent = modelSettings.hasApiKey
    ? modelSettings.model
    : t("settings.noKey");
  elements.modelStatus.title = provider
    ? `${localizedProviderText(provider, "label")} · ${modelSettings.model}`
    : modelSettings.model;
  elements.settingsKeyStatus.textContent =
    modelSettings.apiKeySource === "secure_storage"
      ? t("settings.apiKey.secure")
      : modelSettings.apiKeySource === "environment"
        ? t("settings.apiKey.environment")
        : t("settings.apiKey.none");
  elements.settingsSecurityNote.textContent =
    modelSettings.apiKeySource === "environment"
      ? t("settings.security.environment")
      : modelSettings.secureStorageAvailable
        ? t("settings.security.secure")
        : t("settings.security.unavailable");
  elements.clearKeyField.classList.toggle(
    "hidden",
    modelSettings.apiKeySource !== "secure_storage",
  );
  syncKeyControls();
}

function populateModelProviders() {
  elements.settingsProvider.replaceChildren(
    ...modelSettings.providers.map((provider) => {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = localizedProviderText(provider, "label");
      return option;
    }),
  );
}

function modelProviderOption(providerId) {
  return modelSettings?.providers.find(
    (provider) => provider.id === providerId,
  );
}

function selectedModelProvider() {
  return modelProviderOption(elements.settingsProvider.value);
}

function localizedProviderText(provider, field) {
  return t(
    `provider.${provider.id}.${field}`,
    {},
    typeof provider[field] === "string" ? provider[field] : "",
  );
}

function syncProviderFields() {
  const provider = selectedModelProvider();
  if (!provider) return;
  const custom = provider.id === "custom";
  const editableEndpoint = isEditableProviderEndpoint(provider);
  if (!editableEndpoint) elements.settingsBaseUrl.value = provider.baseUrl;
  elements.settingsBaseUrl.readOnly = !editableEndpoint;
  elements.settingsBaseUrl.required = custom;
  elements.settingsProviderNote.textContent = provider.notice
    ? localizedProviderText(provider, "notice")
    : localizedProviderText(provider, "description");
  elements.settingsBaseUrlNote.textContent = custom
    ? t("settings.baseUrl.custom")
    : editableEndpoint
      ? t("settings.baseUrl.regional")
      : t("settings.baseUrl.preset");
  elements.settingsModelOptions.replaceChildren(
    ...provider.recommendedModels.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      return option;
    }),
  );
  syncKeyControls();
}

function syncKeyControls() {
  const clear = elements.settingsClearKey.checked;
  const providerChanged =
    elements.settingsProvider.value !== modelSettings?.provider ||
    normalizedSettingsUrl(elements.settingsBaseUrl.value) !==
      normalizedSettingsUrl(modelSettings?.baseUrl ?? "");
  elements.settingsApiKey.disabled =
    clear || modelSettings?.secureStorageAvailable === false;
  if (clear) elements.settingsApiKey.value = "";
  if (providerChanged && modelSettings?.hasApiKey) {
    elements.settingsKeyStatus.textContent = t("settings.apiKey.changed");
  } else if (providerChanged) {
    elements.settingsKeyStatus.textContent =
      (selectedModelProvider()
        ? localizedProviderText(selectedModelProvider(), "apiKeyHint")
        : "") || t("settings.apiKey.prompt");
  } else {
    elements.settingsKeyStatus.textContent =
      modelSettings?.apiKeySource === "secure_storage"
        ? t("settings.apiKey.secure")
        : modelSettings?.apiKeySource === "environment"
          ? t("settings.apiKey.environmentMatched")
          : (selectedModelProvider()
                ? localizedProviderText(selectedModelProvider(), "apiKeyHint")
                : "") || t("settings.apiKey.none");
  }
}

function currentModelSettingsInput() {
  const apiKey = elements.settingsApiKey.value.trim();
  return {
    provider: elements.settingsProvider.value,
    baseUrl: elements.settingsBaseUrl.value.trim(),
    model: elements.settingsModel.value.trim(),
    clearApiKey: elements.settingsClearKey.checked,
    ...(apiKey ? { apiKey } : {}),
  };
}

function isEditableProviderEndpoint(provider) {
  return provider.id === "custom" || provider.id.startsWith("bailian-");
}

function normalizedSettingsUrl(value) {
  return value.trim().replace(/\/+$/, "");
}

function clearSettingsConnectionResult() {
  elements.settingsConnectionResult.textContent = "";
  elements.settingsConnectionResult.classList.add("hidden");
}

function renderProjects() {
  const focusedProjectId =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.projectId
      : null;
  const projectButtons = snapshot.projects.map((project) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.projectId = project.id;
      button.className = `nav-item${project.id === selectedProjectId ? " active" : ""}`;
      button.setAttribute(
        "aria-pressed",
        String(project.id === selectedProjectId),
      );
      const dot = document.createElement("span");
      dot.className = "status-pill";
      const copy = document.createElement("span");
      copy.className = "nav-copy";
      const name = document.createElement("strong");
      name.textContent = project.name;
      const path = document.createElement("span");
      path.textContent = project.rootPath;
      button.title = project.rootPath;
      copy.append(name, path);
      button.append(dot, copy);
      button.addEventListener("click", () => {
        if (project.id === selectedProjectId) return;
        saveCurrentDraft();
        selectedProjectId = project.id;
        selectedThreadId = null;
        setDetail(null);
        restoreDraft();
        void runUiAction(restoreProjectContext);
      });
      return button;
    });
  elements.projectList.replaceChildren(...projectButtons);
  if (focusedProjectId) {
    projectButtons
      .find((button) => button.dataset.projectId === focusedProjectId)
      ?.focus({ preventScroll: true });
  }
}

function renderThreads() {
  const focusedThreadId =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.threadId
      : null;
  const threads = snapshot.threads.filter(
    (thread) => thread.projectId === selectedProjectId,
  );
  const waitingCount = threads.filter(
    (thread) => thread.status === "waiting_for_approval",
  ).length;
  elements.pendingApprovalCount.textContent = t("thread.pendingCount", {
    count: waitingCount,
  });
  elements.pendingApprovalCount.classList.toggle("hidden", waitingCount === 0);
  if (threads.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted-card";
    empty.textContent = selectedProjectId
      ? t("thread.none")
      : t("thread.openFirst");
    elements.threadList.replaceChildren(empty);
    return;
  }
  const threadButtons = threads.map((thread) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.threadId = thread.id;
      button.className = `nav-item${thread.id === selectedThreadId ? " active" : ""}`;
      if (thread.id === selectedThreadId) {
        button.setAttribute("aria-current", "page");
      }
      const dot = document.createElement("span");
      dot.className = `status-pill ${thread.status}`;
      const copy = document.createElement("span");
      copy.className = "nav-copy";
      const title = document.createElement("strong");
      title.textContent = thread.title;
      const meta = document.createElement("span");
      meta.textContent = `${
        thread.worktreeCleanupCommit
          ? t("mode.worktreeCleanupShort")
          : thread.mode === "worktree"
          ? t("mode.worktreeShort")
          : t("mode.localShort")
      } · ${statusLabel(thread.status)}`;
      button.title = `${thread.title}\n${thread.workspacePath}`;
      copy.append(title, meta);
      button.append(dot, copy);
      button.addEventListener("click", () => {
        void runUiAction(() => openThread(thread.id));
      });
      return button;
    });
  elements.threadList.replaceChildren(...threadButtons);
  if (focusedThreadId) {
    threadButtons
      .find((button) => button.dataset.threadId === focusedThreadId)
      ?.focus({ preventScroll: true });
  }
}

function renderHeader() {
  const project = snapshot.projects.find(
    (candidate) => candidate.id === selectedProjectId,
  );
  const workspacePath =
    detail?.thread.workspacePath ?? project?.rootPath ?? t("project.none");
  elements.projectPath.textContent = workspacePath;
  elements.projectPath.title = workspacePath;
  elements.threadTitle.textContent =
    detail?.thread.title ??
    (project ? t("thread.start") : t("thread.openProject"));
  elements.mode.disabled = Boolean(detail);
  if (detail) elements.mode.value = detail.thread.mode;
  elements.openWorkspace.disabled = !detail;
  elements.showDiff.disabled = !detail;
}

function renderEmptyState() {
  const hasProject = Boolean(selectedProjectId);
  const modelReady = modelSettings?.hasApiKey === true;
  const modelMissing = modelSettings !== null && !modelReady;
  elements.emptyTitle.textContent = modelMissing
    ? t("empty.connectModel.title")
    : hasProject
      ? t("empty.ready.title")
      : t("empty.noProject.title");
  elements.emptyDescription.textContent = modelMissing
    ? t("empty.connectModel.description")
    : hasProject
      ? t("empty.ready.description")
      : t("empty.noProject.description");
  elements.connectModel.classList.toggle("hidden", !modelMissing);
  elements.emptyOpenProject.classList.toggle(
    "hidden",
    modelMissing || hasProject || modelSettings === null,
  );
  elements.suggestionList.classList.toggle(
    "hidden",
    !hasProject || !modelReady,
  );
}

function renderTimeline() {
  if (previewVisible) {
    elements.previewPanel.classList.remove("hidden");
    elements.timeline.classList.add("hidden");
    elements.empty.classList.add("hidden");
    return;
  }
  elements.previewPanel.classList.add("hidden");
  if (!detail) {
    elements.timeline.classList.add("hidden");
    elements.empty.classList.remove("hidden");
    return;
  }
  elements.timeline.classList.remove("hidden");
  elements.empty.classList.add("hidden");
  const openEventKeys = new Set(
    [...elements.timeline.querySelectorAll("details[open][data-event-key]")].map(
      (node) => node.dataset.eventKey,
    ),
  );
  const entries = detail.messages.map((message, index) => ({
    timestamp: message.createdAt,
    order: index,
    node: messageNode(message.role, message.content),
  }));
  const activeRunIds = new Set(
    detail.runs
      .filter((run) =>
        ["running", "waiting_for_approval"].includes(run.status),
      )
      .map((run) => run.id),
  );
  const liveBlocks = new Map();
  for (const record of detail.events) {
    const event = record.event;
    if (event.type === "delta") {
      if (!activeRunIds.has(record.runId)) continue;
      const blockKey = `${record.runId}:${event.round}`;
      const existing = liveBlocks.get(blockKey);
      if (existing) {
        existing.content += event.delta;
      } else {
        liveBlocks.set(blockKey, {
          runId: record.runId,
          round: event.round,
          timestamp: event.timestamp,
          sequence: event.sequence,
          content: event.delta,
        });
      }
      continue;
    }
    const node = eventTimelineNode(record, openEventKeys);
    if (node) {
      entries.push({
        timestamp: event.timestamp,
        order: event.sequence,
        node,
      });
    }
  }

  for (const block of liveBlocks.values()) {
    const node = messageNode("assistant", block.content, { streaming: true });
    node.dataset.liveRun = block.runId;
    node.dataset.liveRound = String(block.round);
    entries.push({
      timestamp: block.timestamp,
      order: block.sequence,
      node,
    });
  }
  entries.sort(
    (left, right) =>
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime() ||
      left.order - right.order,
  );
  const omittedCount = Math.max(
    0,
    entries.length - MAX_RENDERED_TIMELINE_ITEMS,
  );
  const visibleEntries =
    omittedCount > 0 ? entries.slice(omittedCount) : entries;
  elements.timeline.replaceChildren(
    ...(omittedCount > 0 ? [timelineLimitNode(omittedCount)] : []),
    ...visibleEntries.map((entry) => entry.node),
  );
  reindexLiveMessageNodes();
}

function eventTimelineNode(record, openEventKeys = new Set()) {
  const event = record.event;
  if (event.type === "tool_call") {
    return eventCard(
      t("timeline.callingTool", { tool: toolLabel(event.name) }),
      "",
      formatToolValue(event.arguments, event.rawArguments),
      eventRecordKey(record),
      openEventKeys,
    );
  }
  if (event.type === "tool_result") {
    return eventCard(
      `${toolLabel(event.name)} · ${event.durationMs}ms${
        event.success
          ? ""
          : ` · ${event.error?.message ?? t("timeline.toolFailed")}`
      }`,
      event.success ? "success" : "error",
      event.output === undefined ? "" : formatJson(event.output),
      eventRecordKey(record),
      openEventKeys,
    );
  }
  if (event.type === "error") {
    return eventCard(
      t("timeline.runFailed", { message: event.error.message }),
      "error",
      "",
      eventRecordKey(record),
      openEventKeys,
    );
  }
  return null;
}

function appendTimelineRecord(record) {
  const event = record.event;
  if (event.type === "delta") {
    if (appendLiveDelta(record)) return true;
    const node = messageNode("assistant", event.delta, { streaming: true });
    node.dataset.liveRun = record.runId;
    node.dataset.liveRound = String(event.round);
    liveMessageNodes.set(`${record.runId}:${event.round}`, node);
    appendTimelineItem(node);
    return true;
  }
  const node = eventTimelineNode(record);
  if (node) appendTimelineItem(node);
  return true;
}

function appendTimelineItem(node) {
  elements.timeline.append(node);
  const renderedItems = elements.timeline.querySelectorAll(".timeline-item");
  const removeCount = Math.max(
    0,
    renderedItems.length - MAX_RENDERED_TIMELINE_ITEMS,
  );
  if (removeCount === 0) return;
  for (const item of [...renderedItems].slice(0, removeCount)) item.remove();
  const previousCount = Number(
    elements.timeline.querySelector(".timeline-limit")?.dataset.omitted ?? 0,
  );
  elements.timeline.querySelector(".timeline-limit")?.remove();
  elements.timeline.prepend(timelineLimitNode(previousCount + removeCount));
  reindexLiveMessageNodes();
}

function timelineLimitNode(count) {
  const notice = document.createElement("p");
  notice.className = "timeline-limit";
  notice.dataset.omitted = String(count);
  notice.textContent = t("timeline.olderHidden", { count });
  return notice;
}

function eventRecordKey(record) {
  return `${record.runId}:${record.event.sequence}`;
}

function reindexLiveMessageNodes() {
  liveMessageNodes.clear();
  for (const node of elements.timeline.querySelectorAll("[data-live-run]")) {
    liveMessageNodes.set(
      `${node.dataset.liveRun}:${node.dataset.liveRound}`,
      node,
    );
  }
}

function renderRun() {
  const run = detail?.runs.at(-1);
  const cancellable =
    run && ["running", "waiting_for_approval"].includes(run.status);
  elements.cancelRun.disabled = !cancellable || cancelInFlight;
  elements.cancelRun.classList.toggle("hidden", !cancellable);
  elements.cancelRun.title = cancelInFlight
    ? t("action.stoppingTask")
    : t("action.stopTask");
  if (!run) {
    elements.runCard.replaceChildren(
      runIndicator("idle"),
      runCopy(t("inspector.notRun"), t("inspector.notRunDescription")),
    );
    return;
  }
  const meta =
    `${run.model} · ${formatDate(run.startedAt)}${
      run.errorMessage ? `\n${run.errorMessage}` : ""
    }`;
  elements.runCard.replaceChildren(
    runIndicator(run.status),
    runCopy(statusLabel(run.status), meta),
  );
  elements.runtimeStatus.textContent =
    run.status === "waiting_for_approval"
      ? t("runtime.waitingForApproval")
      : statusLabel(run.status);
}

function renderOutcome() {
  const run = detail?.runs.at(-1);
  const terminal =
    run && ["completed", "failed", "cancelled"].includes(run.status);
  elements.taskOutcome.classList.toggle("hidden", !terminal);
  if (!terminal) {
    elements.taskOutcome.removeAttribute("data-state");
    return;
  }

  const cleanupPending = Boolean(detail.thread.worktreeCleanupCommit);
  elements.taskOutcome.dataset.state = run.status;
  elements.outcomeIndicator.className =
    `task-outcome-indicator ${run.status}`;
  elements.outcomeReview.textContent = t("action.reviewChanges");
  elements.outcomeNext.textContent = t(
    run.status === "completed"
      ? "action.continueTask"
      : "action.retryInstruction",
  );
  elements.outcomeNext.disabled = cleanupPending;
  elements.outcomeNext.title = cleanupPending
    ? t("outcome.cleanupRequired")
    : "";

  if (run.status === "completed") {
    elements.outcomeTitle.textContent = t("outcome.completed.title");
    elements.outcomeDescription.textContent = cleanupPending
      ? t("outcome.cleanupRequired")
      : t("outcome.completed.description");
    return;
  }
  if (run.status === "failed") {
    const message = compactOutcomeError(run.errorMessage);
    elements.outcomeTitle.textContent = t("outcome.failed.title");
    elements.outcomeDescription.textContent = cleanupPending
      ? t("outcome.cleanupRequired")
      : message
        ? t("outcome.failed.description", { message })
        : t("outcome.failed.descriptionFallback");
    return;
  }
  elements.outcomeTitle.textContent = t("outcome.cancelled.title");
  elements.outcomeDescription.textContent = cleanupPending
    ? t("outcome.cleanupRequired")
    : t("outcome.cancelled.description");
}

function continueFromOutcome() {
  const run = detail?.runs.at(-1);
  if (!run || !["completed", "failed", "cancelled"].includes(run.status)) {
    return;
  }
  if (detail.thread.worktreeCleanupCommit) {
    setInspectorVisible(true, { focusPanel: true, persist: true });
    showToast(t("outcome.cleanupRequired"), "info");
    return;
  }
  if (modelSettings?.hasApiKey !== true) {
    void openSettings({ focusModel: true });
    return;
  }
  if (
    run.status !== "completed" &&
    !elements.prompt.value.trim()
  ) {
    const previousInstruction = detail.messages
      .slice()
      .reverse()
      .find((message) => message.role === "user")?.content;
    elements.prompt.value =
      previousInstruction ?? t("outcome.retryPrompt");
    drafts.set(currentDraftKey, elements.prompt.value);
    resizePrompt();
    renderComposer();
  } else if (
    run.status !== "completed" &&
    elements.prompt.value.trim()
  ) {
    showToast(t("outcome.draftPreserved"), "info");
  }
  elements.prompt.focus();
}

function compactOutcomeError(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 260
    ? `${normalized.slice(0, 259).trimEnd()}…`
    : normalized;
}

async function refreshWorktree(threadId) {
  const generation = ++worktreeRequestGeneration;
  try {
    const metadata = await window.baseAgent.getWorktree(threadId);
    if (
      generation !== worktreeRequestGeneration ||
      detail?.thread.id !== threadId
    ) {
      return;
    }
    worktreeMetadata = metadata;
    worktreeLoaded = true;
    renderWorktree();
  } catch (error) {
    if (
      generation === worktreeRequestGeneration &&
      detail?.thread.id === threadId
    ) {
      worktreeMetadata = null;
      worktreeLoaded = true;
      renderWorktree();
    }
    throw error;
  }
}

async function resolveWorktree(action) {
  const threadId = detail?.thread.id;
  const cleanupPending = Boolean(detail?.thread.worktreeCleanupCommit);
  const actionMatchesState =
    action === "cleanup"
      ? cleanupPending && detail?.thread.mode === "local"
      : !cleanupPending &&
        detail?.thread.mode === "worktree" &&
        (action === "apply" || action === "discard");
  if (
    !threadId ||
    !actionMatchesState ||
    activeRun() ||
    worktreeBusy
  ) {
    return;
  }
  worktreeBusy = true;
  renderWorktree();
  try {
    const result = await window.baseAgent.resolveWorktree(threadId, action);
    if (!result) return;
    await refreshSnapshot();
    if (selectedThreadId === threadId) await openThread(threadId);
    showToast(
      result.cleanupPending
        ? t("worktree.cleanupPending")
        : t(
            result.action === "apply"
              ? "worktree.applied"
              : result.action === "cleanup"
                ? "worktree.cleanupComplete"
                : "worktree.discarded",
          ),
      result.cleanupPending ? "info" : "success",
    );
  } catch (error) {
    showError(error);
  } finally {
    worktreeBusy = false;
    renderWorktree();
  }
}

function renderWorktree() {
  const cleanupPending = Boolean(detail?.thread.worktreeCleanupCommit);
  const visible = detail?.thread.mode === "worktree" || cleanupPending;
  elements.worktreeSection.classList.toggle("hidden", !visible);
  if (!visible) return;
  const blocked =
    Boolean(activeRun()) ||
    worktreeBusy ||
    (!cleanupPending && !worktreeMetadata);
  elements.worktreeApply.textContent = t(
    cleanupPending ? "worktree.retryCleanup" : "worktree.apply",
  );
  elements.worktreeDiscard.classList.toggle("hidden", cleanupPending);
  elements.worktreeApply.disabled = blocked;
  elements.worktreeDiscard.disabled = blocked || cleanupPending;
  if (cleanupPending) {
    elements.worktreeBranch.textContent =
      worktreeMetadata?.branchName ??
      worktreeMetadata?.expectedBranchName ??
      t("mode.worktreeCleanupShort");
    elements.worktreeStatus.textContent = t("worktree.cleanupStatus");
    return;
  }
  if (!worktreeMetadata) {
    elements.worktreeBranch.textContent = "—";
    elements.worktreeStatus.textContent = t(
      worktreeLoaded ? "worktree.unavailable" : "worktree.loading",
    );
    return;
  }
  elements.worktreeBranch.textContent =
    worktreeMetadata.branchName ?? worktreeMetadata.expectedBranchName;
  elements.worktreeStatus.textContent = `${
    worktreeMetadata.dirty ? t("worktree.dirty") : t("worktree.clean")
  } · ${t("worktree.ahead", {
    count: worktreeMetadata.aheadBy ?? 0,
  })}`;
}

function renderApprovals() {
  const pending =
    detail?.approvals.filter((approval) => approval.status === "pending") ?? [];
  if (pending.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted-card";
    empty.textContent = t("inspector.noApprovals");
    elements.approvals.replaceChildren(empty);
    return;
  }
  elements.approvals.replaceChildren(
    ...pending.map((approval) => {
      const card = document.createElement("div");
      card.className = "approval-card";
      const title = textElement("strong", toolLabel(approval.toolName));
      const effect = textElement("div", approvalEffectLabel(approval.effect));
      effect.className = "section-label";
      const target = textElement(
        "div",
        approvalTargetLabel(approval.toolName, approval.arguments),
      );
      target.className = "approval-target";
      const details = document.createElement("details");
      details.className = "approval-details";
      const detailsSummary = textElement("summary", t("approval.details"));
      const args = document.createElement("pre");
      args.textContent = formatJson(approval.arguments);
      details.append(detailsSummary, args);
      const actions = document.createElement("div");
      actions.className = "approval-actions";
      const deny = textElement("button", t("action.deny"));
      deny.type = "button";
      deny.className = "danger";
      const approve = textElement("button", t("action.allowOnce"));
      approve.type = "button";
      approve.className = "primary";
      const busy = approvalBusy.has(approval.id);
      deny.disabled = busy;
      approve.disabled = busy;
      if (busy) approve.textContent = t("action.processing");
      deny.addEventListener("click", () => {
        void decideApproval(approval.id, "deny");
      });
      approve.addEventListener("click", () => {
        void decideApproval(approval.id, "allow_once");
      });
      actions.append(deny, approve);
      card.append(title, effect, target, details, actions);
      return card;
    }),
  );
}

function renderComposer() {
  const hasProject = Boolean(selectedProjectId);
  const modelReady = modelSettings?.hasApiKey === true;
  const cleanupPending = Boolean(detail?.thread.worktreeCleanupCommit);
  const run = activeRun();
  const projectActiveThread = activeThreadForProject();
  const activeStatus = run?.status ?? projectActiveThread?.status;
  const active = Boolean(activeStatus);
  elements.prompt.disabled = !hasProject || !modelReady || cleanupPending;
  elements.prompt.readOnly = submitInFlight;
  elements.sendTask.disabled =
    submitInFlight ||
    !hasProject ||
    !modelReady ||
    active ||
    cleanupPending ||
    !elements.prompt.value.trim();
  elements.newTask.disabled = !hasProject;
  for (const suggestion of elements.suggestions) {
    suggestion.disabled =
      !hasProject || !modelReady || active || cleanupPending;
  }
  elements.composerStatusDot.className = `composer-status-dot${
    activeStatus ? ` ${activeStatus}` : ""
  }`;
  if (modelSettings === null) {
    elements.runtimeStatus.textContent = t("settings.checking");
  } else if (!modelReady) {
    elements.runtimeStatus.textContent = t("runtime.connectModel");
  } else if (!hasProject) {
    elements.runtimeStatus.textContent = t("runtime.waitingForProject");
  } else if (submitInFlight) {
    elements.runtimeStatus.textContent = t("runtime.creatingTask");
  } else if (activeStatus === "waiting_for_approval") {
    elements.runtimeStatus.textContent = t("runtime.waitingForApproval");
  } else if (activeStatus === "running") {
    elements.runtimeStatus.textContent = t("runtime.runningWithDraft");
  } else if (cleanupPending) {
    elements.runtimeStatus.textContent = t("runtime.cleanupRequired");
  } else if (!active && !detail) {
    elements.runtimeStatus.textContent = t("runtime.newLocalTask");
  } else if (!active) {
    elements.runtimeStatus.textContent = t("runtime.continueTask");
  }
  elements.prompt.placeholder = !modelReady
    ? t("composer.connectModelPlaceholder")
    : !hasProject
    ? t("composer.noProjectPlaceholder")
    : cleanupPending
      ? t("composer.cleanupPlaceholder")
      : active
      ? t("composer.activePlaceholder")
      : t("composer.readyPlaceholder");
}

async function decideApproval(approvalId, decision) {
  if (approvalBusy.has(approvalId)) return;
  approvalBusy.add(approvalId);
  renderApprovals();
  try {
    await window.baseAgent.decideApproval({ approvalId, decision });
    if (selectedThreadId) await openThread(selectedThreadId);
  } catch (error) {
    showError(error);
  } finally {
    approvalBusy.delete(approvalId);
    renderApprovals();
  }
}

function prepareTerminalDiff() {
  const run = detail?.runs.at(-1);
  if (
    !run ||
    !["completed", "failed", "cancelled"].includes(run.status) ||
    diffPreparedForRunId === run.id
  ) {
    return;
  }
  diffPreparedForRunId = run.id;
  void loadDiff({ silent: true });
}

async function loadDiff({ silent = false } = {}) {
  if (!selectedThreadId) return;
  const threadId = selectedThreadId;
  const generation = ++diffRequestGeneration;
  const readDiff = async () => {
    elements.diff.textContent = t("diff.loading");
    elements.diffMeta.textContent = "";
    let diff;
    try {
      diff = await window.baseAgent.getDiff(threadId);
    } catch (error) {
      if (
        generation === diffRequestGeneration &&
        selectedThreadId === threadId
      ) {
        elements.diff.textContent = t("diff.unavailable");
      }
      throw error;
    }
    if (
      generation !== diffRequestGeneration ||
      selectedThreadId !== threadId
    ) {
      return;
    }
    renderDiffOutput(diff);
    const lines = diff ? diff.replace(/\n$/, "").split("\n").length : 0;
    elements.diffMeta.textContent = diff
      ? t("diff.lines", { count: lines })
      : t("diff.noChangesShort");
  };
  if (silent) {
    try {
      await readDiff();
    } catch {
      // The persistent Review action retries visibly if preparation failed.
    }
    return;
  }
  await runUiAction(readDiff);
}

function renderDiffOutput(diff) {
  if (!diff) {
    elements.diff.textContent = t("diff.noChanges");
    return;
  }
  elements.diff.replaceChildren(
    ...diff.split("\n").map((line) => {
      const row = document.createElement("span");
      row.className = "diff-line";
      if (line.startsWith("### ")) row.classList.add("section");
      else if (line.startsWith("@@")) row.classList.add("hunk");
      else if (line.startsWith("?? ")) row.classList.add("untracked");
      else if (line.startsWith("+") && !line.startsWith("+++")) {
        row.classList.add("addition");
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        row.classList.add("deletion");
      }
      row.textContent = line || "\u00a0";
      return row;
    }),
  );
}

function setPreviewVisible(
  visible,
  { focusAddress = false, restoreFocus = false } = {},
) {
  const wasVisible = previewVisible;
  if (visible && !wasVisible) {
    previewPreviousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    previewShouldFollowTimeline = isTimelineNearBottom();
    previewTimelineScrollTop = elements.timeline.scrollTop;
  }
  previewVisible = visible;
  elements.togglePreview.classList.toggle("active", visible);
  elements.togglePreview.setAttribute("aria-pressed", String(visible));
  elements.togglePreview.setAttribute("aria-expanded", String(visible));
  elements.togglePreview.title = visible
    ? t("action.hidePreview")
    : t("action.showPreview");
  elements.togglePreview.setAttribute(
    "aria-label",
    visible ? t("action.hidePreviewAria") : t("action.showPreview"),
  );
  elements.previewPanel.setAttribute("aria-hidden", String(!visible));
  elements.previewPanel.inert = !visible;
  syncPreviewContext();
  renderTimeline();
  if (visible && focusAddress) {
    requestAnimationFrame(() => {
      elements.previewUrl.focus();
      elements.previewUrl.select();
    });
  } else if (!visible && wasVisible) {
    requestAnimationFrame(() => {
      elements.timeline.scrollTop = previewShouldFollowTimeline
        ? elements.timeline.scrollHeight
        : previewTimelineScrollTop;
      if (restoreFocus && previewPreviousFocus?.isConnected) {
        previewPreviousFocus.focus();
      }
    });
  }
}

function syncPreviewContext() {
  const nextContextKey = selectedProjectId ?? "global";
  if (previewContextKey === nextContextKey) return;
  clearPreviewLoadTimer();
  previewNavigationId += 1;
  previewContextKey = nextContextKey;
  previewLoadedUrl = null;
  previewLoadState = "idle";
  const savedValue = localStorage.getItem(previewStorageKey()) ?? "";
  let savedUrl = "";
  if (savedValue) {
    const normalized = window.baseAgent.normalizePreviewUrl(savedValue);
    if (normalized.ok) {
      savedUrl = normalized.url;
    } else {
      localStorage.removeItem(previewStorageKey());
    }
  }
  elements.previewUrl.value = savedUrl;
  elements.previewUrl.setAttribute("aria-invalid", "false");
  elements.previewFrame.removeAttribute("src");
  elements.previewFrame.classList.add("hidden");
  elements.previewFrame.tabIndex = -1;
  elements.previewEmpty.classList.remove("hidden");
  hidePreviewFeedback();
  elements.previewRefresh.disabled = true;
  elements.previewViewport.dataset.state = "idle";
  syncPreviewEmptyState();
  setPreviewStatus("neutral", t("preview.restricted"));
}

function previewStorageKey() {
  return `base-agent:preview:${previewContextKey ?? selectedProjectId ?? "global"}`;
}

function openPreview(rawUrl) {
  const normalized = window.baseAgent.normalizePreviewUrl(rawUrl);
  if (!normalized.ok) {
    elements.previewUrl.setAttribute("aria-invalid", "true");
    setPreviewStatus("error", t("preview.invalidAddress"));
    showToast(t(normalized.errorCode));
    elements.previewUrl.focus();
    return;
  }
  const url = normalized.url;
  previewLoadedUrl = url;
  elements.previewUrl.value = url;
  elements.previewUrl.setAttribute("aria-invalid", "false");
  localStorage.setItem(previewStorageKey(), url);
  syncPreviewEmptyState();
  beginPreviewNavigation(
    url,
    t("preview.connectingHost", { host: new URL(url).host }),
  );
}

function beginPreviewNavigation(url, message) {
  clearPreviewLoadTimer();
  const navigationId = ++previewNavigationId;
  previewLoadState = "loading";
  elements.previewUrl.setAttribute("aria-invalid", "false");
  elements.previewEmpty.classList.add("hidden");
  elements.previewFrame.classList.remove("hidden");
  elements.previewFrame.tabIndex = -1;
  elements.previewRefresh.disabled = true;
  elements.previewViewport.dataset.state = "loading";
  showPreviewFeedback(
    "loading",
    t("preview.connecting.title"),
    t("preview.connecting.description"),
  );
  setPreviewStatus("loading", message);
  elements.previewFrame.src = url;
  previewLoadTimer = window.setTimeout(() => {
    if (
      navigationId !== previewNavigationId ||
      previewLoadState !== "loading"
    ) {
      return;
    }
    showPreviewLoadError(t("preview.timeout"));
  }, 12_000);
}

function markPreviewReady() {
  clearPreviewLoadTimer();
  previewLoadState = "ready";
  elements.previewFrame.tabIndex = 0;
  elements.previewRefresh.disabled = false;
  elements.previewViewport.dataset.state = "ready";
  hidePreviewFeedback();
  setPreviewStatus(
    "ready",
    t("preview.ready", { host: new URL(previewLoadedUrl).host }),
  );
}

function handlePreviewStatus(status) {
  if (!previewLoadedUrl || previewLoadState === "idle") return;
  if (status.kind === "failed" || status.kind === "blocked") {
    showPreviewLoadError(
      t(status.code, { description: status.detail ?? "" }),
    );
  }
}

function showPreviewLoadError(message) {
  clearPreviewLoadTimer();
  previewNavigationId += 1;
  previewLoadState = "error";
  elements.previewFrame.tabIndex = -1;
  elements.previewRefresh.disabled = false;
  elements.previewViewport.dataset.state = "error";
  showPreviewFeedback(
    "error",
    t("preview.errorTitle"),
    message,
  );
  setPreviewStatus("error", message);
}

function showPreviewFeedback(state, title, message) {
  elements.previewFeedback.dataset.state = state;
  elements.previewFeedbackTitle.textContent = title;
  elements.previewFeedbackMessage.textContent = message;
  elements.previewRetry.classList.toggle("hidden", state !== "error");
  elements.previewFeedback.classList.remove("hidden");
}

function hidePreviewFeedback() {
  elements.previewFeedback.classList.add("hidden");
  elements.previewFeedback.removeAttribute("data-state");
}

function clearPreviewLoadTimer() {
  if (previewLoadTimer !== null) {
    window.clearTimeout(previewLoadTimer);
    previewLoadTimer = null;
  }
}

function stopPreview() {
  clearPreviewLoadTimer();
  previewNavigationId += 1;
  previewLoadedUrl = null;
  previewLoadState = "idle";
  elements.previewFrame.removeAttribute("src");
  elements.previewFrame.classList.add("hidden");
  elements.previewFrame.tabIndex = -1;
  elements.previewEmpty.classList.remove("hidden");
  elements.previewRefresh.disabled = true;
  elements.previewViewport.dataset.state = "idle";
  hidePreviewFeedback();
  syncPreviewEmptyState();
  setPreviewStatus("neutral", t("preview.stopped"));
}

function syncPreviewEmptyState() {
  const savedUrl = elements.previewUrl.value.trim();
  if (savedUrl) {
    let host = savedUrl;
    try {
      host = new URL(savedUrl).host;
    } catch {
      // The value is validated before it is stored; keep the raw value as fallback.
    }
    elements.previewEmptyCopy.textContent = t("preview.saved", { host });
    elements.previewExample.textContent = t("preview.openSaved");
    elements.previewExample.dataset.url = savedUrl;
    return;
  }
  elements.previewEmptyCopy.textContent = t("preview.empty.description");
  elements.previewExample.textContent = t("preview.empty.example");
  elements.previewExample.dataset.url = "http://localhost:3000";
}

function setPreviewStatus(state, message) {
  elements.previewStatusDot.className = `preview-status-dot ${state}`;
  elements.previewStatus.textContent = message;
}

function setInspectorVisible(
  visible,
  { focusPanel = false, restoreFocus = false, persist = false } = {},
) {
  if (visible && !inspectorVisible) {
    inspectorPreviousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }
  inspectorVisible = visible;
  document.body.classList.toggle("inspector-hidden", !visible);
  elements.toggleInspector.classList.toggle("active", visible);
  elements.toggleInspector.setAttribute("aria-pressed", String(visible));
  elements.toggleInspector.setAttribute("aria-expanded", String(visible));
  elements.toggleInspector.title = visible
    ? t("action.hideInspector")
    : t("action.showInspector");
  elements.toggleInspector.setAttribute(
    "aria-label",
    visible ? t("action.hideInspector") : t("action.showInspector"),
  );
  elements.inspector.setAttribute("aria-hidden", String(!visible));
  elements.inspector.inert = !visible;
  elements.inspectorScrim.setAttribute("aria-hidden", String(!visible));
  elements.inspectorScrim.tabIndex = -1;
  syncInspectorModality();
  if (persist) {
    localStorage.setItem(
      "base-agent:inspector",
      visible ? "visible" : "hidden",
    );
  }
  if (visible && (focusPanel || compactInspectorQuery.matches)) {
    requestAnimationFrame(() => elements.inspectorClose.focus());
  } else if (!visible && restoreFocus && inspectorPreviousFocus?.isConnected) {
    requestAnimationFrame(() => inspectorPreviousFocus.focus());
  }
}

function syncInspectorModality() {
  const isModal = inspectorVisible && compactInspectorQuery.matches;
  elements.workspace.inert = isModal;
  if (
    isModal &&
    document.activeElement instanceof HTMLElement &&
    !elements.inspector.contains(document.activeElement)
  ) {
    requestAnimationFrame(() => elements.inspectorClose.focus());
  }
}

function resizePrompt() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(
    Math.max(elements.prompt.scrollHeight, 52),
    148,
  )}px`;
}

function activeRun() {
  return detail?.runs
    .slice()
    .reverse()
    .find((run) => ["running", "waiting_for_approval"].includes(run.status));
}

function activeThreadForProject(projectId = selectedProjectId) {
  if (!projectId) return null;
  return (
    snapshot.threads.find(
      (thread) =>
        thread.projectId === projectId &&
        ["running", "waiting_for_approval"].includes(thread.status),
    ) ?? null
  );
}

function messageNode(role, content, { streaming = false } = {}) {
  const item = document.createElement("article");
  item.className = "timeline-item";
  const bubble = document.createElement("div");
  bubble.className = `message ${role}`;
  if (role === "assistant" && !streaming) {
    richText.renderAssistantContent(bubble, content);
  } else {
    bubble.textContent = content;
  }
  item.append(bubble);
  return item;
}

function appendLiveDelta(record) {
  const event = record.event;
  if (event.type !== "delta") return false;
  const node = liveMessageNodes.get(`${record.runId}:${event.round}`);
  const bubble = node?.querySelector(".message.assistant");
  if (!bubble) return false;
  bubble.append(document.createTextNode(event.delta));
  return true;
}

function eventCard(
  title,
  state = "",
  detailContent = "",
  eventKey = "",
  openEventKeys = new Set(),
) {
  const item = document.createElement("article");
  item.className = "timeline-item";
  const card = document.createElement(detailContent ? "details" : "div");
  card.className = `event-card${detailContent ? "" : " event-result"} ${state}`;
  if (eventKey) card.dataset.eventKey = eventKey;
  if (detailContent) {
    card.open = openEventKeys.has(eventKey);
    const summary = document.createElement("summary");
    summary.textContent = title;
    const content = document.createElement("pre");
    content.textContent = detailContent;
    card.append(summary, content);
  } else {
    card.textContent = title;
  }
  item.append(card);
  return item;
}

function isTimelineNearBottom() {
  if (previewVisible) return previewShouldFollowTimeline;
  if (elements.timeline.classList.contains("hidden")) return true;
  return (
    elements.timeline.scrollHeight -
      elements.timeline.scrollTop -
      elements.timeline.clientHeight <
    96
  );
}

function scrollTimelineToLatest() {
  requestAnimationFrame(() => {
    elements.timeline.scrollTop = elements.timeline.scrollHeight;
  });
}

function draftKey() {
  return `${selectedProjectId ?? "none"}:${selectedThreadId ?? "new"}`;
}

function saveCurrentDraft() {
  const value = elements.prompt.value;
  if (value) drafts.set(currentDraftKey, value);
  else drafts.delete(currentDraftKey);
}

function restoreDraft() {
  currentDraftKey = draftKey();
  elements.prompt.value = drafts.get(currentDraftKey) ?? "";
  resizePrompt();
  renderComposer();
}

async function restoreProjectContext() {
  const runningThread = activeThreadForProject();
  if (runningThread) {
    await openThread(runningThread.id);
    if (runningThread.status === "waiting_for_approval") {
      setInspectorVisible(true);
    }
    return;
  }
  const savedThreadId = localStorage.getItem("base-agent:thread");
  const savedThread = snapshot.threads.find(
    (thread) =>
      thread.id === savedThreadId && thread.projectId === selectedProjectId,
  );
  if (savedThread) {
    await openThread(savedThread.id);
    return;
  }
  localStorage.removeItem("base-agent:thread");
  restoreDraft();
  render();
}

async function openSettings({ focusModel = false } = {}) {
  if (elements.settingsDialog.open) return;
  clearSettingsError();
  try {
    await refreshModelSettings();
    populateModelProviders();
    elements.settingsProvider.value = modelSettings.provider;
    elements.settingsBaseUrl.value = modelSettings.baseUrl;
    elements.settingsModel.value = modelSettings.model;
    elements.settingsApiKey.value = "";
    elements.settingsClearKey.checked = false;
    clearSettingsConnectionResult();
    syncProviderFields();
    elements.settingsDialog.showModal();
    (focusModel && !modelSettings.hasApiKey
      ? elements.settingsApiKey
      : elements.settingsLanguage
    ).focus();
  } catch (error) {
    showError(error);
  }
}

function resetSensitiveSettingsFields() {
  elements.settingsApiKey.value = "";
  elements.settingsClearKey.checked = false;
  clearSettingsError();
  clearSettingsConnectionResult();
}

function setSettingsBusy(busy) {
  elements.settingsForm.setAttribute("aria-busy", String(busy));
  for (const control of elements.settingsForm.querySelectorAll(
    "button, input, select",
  )) {
    control.disabled = busy;
  }
  if (!busy) syncProviderFields();
}

function clearSettingsError() {
  elements.settingsError.textContent = "";
  elements.settingsError.classList.add("hidden");
}

function showSettingsError(error) {
  const message =
    error instanceof Error
      ? error.message
      : String(error ?? t("settings.saveFailed"));
  elements.settingsError.textContent = message.replace(
    /^Error invoking remote method.*?: /,
    "",
  );
  elements.settingsError.classList.remove("hidden");
}

function handleMenuAction(action) {
  if (elements.settingsDialog.open && action !== "open-settings") return;
  const actions = {
    "open-project": () => elements.openProject.click(),
    "new-task": () => elements.newTask.click(),
    "open-settings": () => elements.modelSettings.click(),
    "toggle-preview": () => elements.togglePreview.click(),
    "toggle-inspector": () => elements.toggleInspector.click(),
  };
  actions[action]?.();
}

function runIndicator(status) {
  const indicator = document.createElement("span");
  indicator.className = `run-state-indicator ${status}`;
  indicator.setAttribute("aria-hidden", "true");
  return indicator;
}

function runCopy(title, meta) {
  const copy = document.createElement("div");
  copy.append(textElement("strong", title), textElement("span", meta));
  return copy;
}

function textElement(tagName, content) {
  const element = document.createElement(tagName);
  element.textContent = content;
  return element;
}

function formatJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolValue(value, rawValue = "") {
  if (value !== undefined) return formatJson(value);
  try {
    return formatJson(JSON.parse(rawValue));
  } catch {
    return rawValue;
  }
}

function toolLabel(name) {
  const knownTools = new Set([
    "list_files",
    "search_code",
    "read_file",
    "apply_patch",
    "delete_file",
    "move_file",
    "run_command",
    "git_status",
    "git_diff",
    "calculator",
    "get_current_time",
  ]);
  return knownTools.has(name) ? t(`tool.${name}`) : name;
}

function approvalEffectLabel(effect) {
  return ["write", "execute", "network"].includes(effect)
    ? t(`approval.effect.${effect}`)
    : t("approval.effect.default");
}

function approvalTargetLabel(toolName, value) {
  if (!value || typeof value !== "object") {
    return t("approval.target.default");
  }
  if (
    (toolName === "apply_patch" || toolName === "delete_file") &&
    "path" in value
  ) {
    return t("approval.target.file", { path: String(value.path) });
  }
  if (
    toolName === "move_file" &&
    "fromPath" in value &&
    "toPath" in value
  ) {
    return t("approval.target.move", {
      from: String(value.fromPath),
      to: String(value.toPath),
    });
  }
  if (toolName === "run_command" && "executable" in value) {
    const args =
      "args" in value && Array.isArray(value.args)
        ? value.args.map(String).join(" ")
        : "";
    return t("approval.target.command", {
      command: `${String(value.executable)}${args ? ` ${args}` : ""}`,
    });
  }
  return t("approval.target.default");
}

function formatDate(value) {
  return new Intl.DateTimeFormat(preferences.locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status) {
  return [
    "idle",
    "running",
    "waiting_for_approval",
    "completed",
    "failed",
    "cancelled",
  ].includes(status)
    ? t(`status.${status}`)
    : status;
}

async function runUiAction(action) {
  try {
    return await action();
  } catch (error) {
    showError(error);
    return undefined;
  } finally {
    renderComposer();
  }
}

function showError(error) {
  const message =
    error instanceof Error ? error.message : String(error ?? t("error.unknown"));
  showToast(message.replace(/^Error invoking remote method.*?: /, ""));
}

function showToast(message, state = "error") {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("success", state === "success");
  elements.toast.classList.toggle("info", state === "info");
  elements.toast.setAttribute("role", state === "error" ? "alert" : "status");
  elements.toast.classList.remove("hidden");
  elements.toast.setAttribute("aria-hidden", "false");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.add("hidden");
    elements.toast.setAttribute("aria-hidden", "true");
  }, 6000);
}

elements.prompt.addEventListener("input", () => {
  if (elements.prompt.value) drafts.set(currentDraftKey, elements.prompt.value);
  else drafts.delete(currentDraftKey);
  resizePrompt();
  renderComposer();
});
void initialize().catch(showError);
