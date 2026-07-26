(() => {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    accent: "base-agent:accent",
  });
  const LOCALES = Object.freeze(["en", "zh-CN"]);
  const THEMES = Object.freeze(["system", "light", "dark"]);
  const ACCENTS = Object.freeze(["blue", "indigo", "purple", "teal", "orange"]);
  const DEFAULTS = Object.freeze({
    locale: "en",
    theme: "system",
    accent: "blue",
  });

  const messages = Object.freeze({
    en: Object.freeze({
      "sidebar.projects": "Projects",
      "sidebar.tasks": "Tasks",
      "action.openProject": "Open local project",
      "action.newTask": "New task",
      "action.settings": "Settings",
      "action.openWorkspace": "Open in Finder",
      "action.showDiff": "View workspace diff",
      "action.showPreview": "Show local web preview",
      "action.hidePreview": "Return to task (preview keeps running)",
      "action.hidePreviewAria": "Return to task; keep preview running",
      "action.toggleInspector": "Show or hide task details",
      "action.showInspector": "Show task details",
      "action.hideInspector": "Hide task details",
      "action.stopTask": "Stop current task",
      "action.stoppingTask": "Stopping task",
      "action.close": "Close",
      "action.open": "Open",
      "action.refresh": "Refresh preview",
      "action.stopPreview": "Stop and close preview",
      "action.retry": "Reload",
      "action.run": "Run",
      "action.connectModel": "Connect model",
      "action.reviewChanges": "Review changes",
      "action.continueTask": "Continue",
      "action.retryInstruction": "Retry instruction",
      "action.testConnection": "Test connection",
      "action.cancel": "Cancel",
      "action.saveSettings": "Save settings",
      "action.deny": "Deny",
      "action.allowOnce": "Allow once",
      "action.processing": "Working…",
      "mode.label": "Execution mode",
      "mode.tooltip": "Execution mode for new tasks",
      "mode.local": "Current directory",
      "mode.worktree": "Isolated Worktree",
      "mode.localShort": "Current directory",
      "mode.worktreeShort": "Isolated directory",
      "mode.worktreeCleanupShort": "Cleanup required",
      "project.none": "No project selected",
      "thread.start": "Start a coding task",
      "thread.openProject": "Open a local code project",
      "empty.ready.title": "What would you like to build?",
      "empty.ready.description":
        "Describe a goal. The agent will understand the project, plan the change, and ask before sensitive actions.",
      "empty.connectModel.title": "Connect a model to begin",
      "empty.connectModel.description":
        "Choose a provider and add its API key. Brace keeps credentials in your system's secure storage.",
      "empty.noProject.title": "Open a local project",
      "empty.noProject.description":
        "Choose a code directory. Brace will read its context and run tasks on this device.",
      "suggestion.fix.prompt":
        "Inspect this project, fix the failing tests, and explain the root cause.",
      "suggestion.fix.title": "Fix failing tests",
      "suggestion.fix.subtitle": "Find the cause and verify the fix",
      "suggestion.architecture.prompt":
        "Analyze this codebase's architecture, main modules, and the complete path from instruction to execution.",
      "suggestion.architecture.title": "Understand the architecture",
      "suggestion.architecture.subtitle": "Map modules and runtime flow",
      "suggestion.refactor.prompt":
        "Refactor this project while preserving behavior, improve maintainability, and add the necessary tests.",
      "suggestion.refactor.title": "Refactor safely",
      "suggestion.refactor.subtitle": "Preserve behavior and add tests",
      "preview.region": "Local web preview",
      "preview.addressForm": "Open local preview address",
      "preview.address": "Local preview address",
      "preview.empty.title": "Preview a local app",
      "preview.empty.description":
        "Start the project's development server, then enter its localhost address.",
      "preview.empty.example": "Use localhost:3000",
      "preview.connecting.title": "Connecting to local service",
      "preview.connecting.description": "This usually takes only a few seconds.",
      "preview.frameTitle": "Local app preview",
      "preview.restricted": "Only localhost and 127.0.0.1 are allowed",
      "preview.refreshing": "Refreshing local preview…",
      "preview.reconnecting": "Reconnecting to local service…",
      "preview.connectingHost": "Connecting to {host}…",
      "preview.invalidAddress": "Enter a valid local preview address",
      "preview.emptyAddress": "Enter a local preview address.",
      "preview.untrustedAddress":
        "Preview only allows http://localhost or http://127.0.0.1.",
      "preview.blockedNavigation":
        "Preview blocked navigation to a non-local address.",
      "preview.blockedRedirect":
        "Preview blocked a redirect to a non-local address.",
      "preview.cannotConnect":
        "Unable to connect to the local service. Confirm that the development server is running.",
      "preview.cannotResolve":
        "Unable to resolve the local address. Check the address and port.",
      "preview.noNetwork": "No network is available on this device.",
      "preview.loadFailedWithDescription":
        "Local preview failed to load: {description}",
      "preview.loadFailed": "Local preview failed to load.",
      "preview.timeout":
        "The connection is taking too long. Confirm that the development server is running and the port is correct.",
      "preview.ready": "Previewing {host}",
      "preview.errorTitle": "Unable to open local preview",
      "preview.stopped": "Preview stopped · address saved for this project",
      "preview.saved":
        "{host} is saved. Reopen it after the development server starts.",
      "preview.openSaved": "Open saved preview",
      "composer.task": "Coding task",
      "composer.readyPlaceholder": "Describe a coding task…",
      "composer.connectModelPlaceholder": "Connect a model before writing a task…",
      "composer.noProjectPlaceholder": "Open a local project first…",
      "composer.activePlaceholder":
        "Write the next instruction; send it when the current task finishes…",
      "composer.cleanupPlaceholder":
        "Finish isolated cleanup before continuing this task…",
      "runtime.waitingForProject": "Waiting for a project",
      "runtime.connectModel": "Connect a model to run tasks",
      "runtime.creatingTask": "Creating task…",
      "runtime.waitingForApproval": "Waiting for your approval",
      "runtime.runningWithDraft": "Task running · draft your next instruction",
      "runtime.newLocalTask": "New local task",
      "runtime.continueTask": "Continue this task",
      "runtime.cleanupRequired": "Isolated cleanup required",
      "outcome.completed.title": "Agent response finished",
      "outcome.completed.description":
        "The model stopped normally. Review the workspace diff and run relevant checks before keeping the result.",
      "outcome.failed.title": "Task needs attention",
      "outcome.failed.description": "The run stopped with an error: {message}",
      "outcome.failed.descriptionFallback":
        "The run stopped with an error. Review the details and any partial workspace changes.",
      "outcome.cancelled.title": "Task stopped",
      "outcome.cancelled.description":
        "Any partial workspace changes were kept. Review them before continuing.",
      "outcome.cleanupRequired":
        "Finish isolated cleanup in Task details before continuing.",
      "outcome.retryPrompt":
        "Continue from the current workspace state. Inspect existing changes first, resolve the remaining issue, and verify the result.",
      "outcome.draftPreserved":
        "Your draft was preserved. Edit it before retrying.",
      "inspector.close": "Close task details",
      "inspector.label": "Task details",
      "inspector.status": "Run status",
      "inspector.notRun": "Not run",
      "inspector.notRunDescription":
        "Live progress appears after you submit a task.",
      "worktree.title": "Isolated worktree",
      "worktree.loading": "Reading worktree status…",
      "worktree.unavailable": "Worktree metadata is unavailable.",
      "worktree.dirty": "Uncommitted changes",
      "worktree.clean": "Clean",
      "worktree.ahead": "{count} commits ahead",
      "worktree.apply": "Apply",
      "worktree.discard": "Discard",
      "worktree.retryCleanup": "Retry cleanup",
      "worktree.applied": "Changes applied to the main project.",
      "worktree.discarded": "Isolated changes discarded.",
      "worktree.cleanupComplete": "Isolated cleanup completed.",
      "worktree.cleanupStatus":
        "Changes applied · isolated cleanup required",
      "worktree.cleanupPending":
        "Changes were applied. Use Retry cleanup to remove the isolated branch and directory safely.",
      "inspector.approvals": "Pending approvals",
      "inspector.noApprovals": "No pending approvals",
      "inspector.diff": "Workspace diff",
      "diff.afterRun": "Run a task to inspect uncommitted changes.",
      "diff.select": "Choose “View diff” to read workspace changes.",
      "diff.loading": "Reading diff…",
      "diff.lines": "{count} lines",
      "diff.noChangesShort": "No changes",
      "diff.noChanges": "The workspace has no uncommitted changes.",
      "diff.unavailable":
        "The workspace diff is temporarily unavailable. Try Review changes again.",
      "settings.title": "Settings",
      "settings.appearance.title": "Appearance",
      "settings.appearance.description":
        "Changes apply immediately and are saved on this device.",
      "settings.language": "Language",
      "settings.language.en": "English",
      "settings.language.zh": "简体中文",
      "settings.theme": "Theme",
      "settings.theme.system": "System",
      "settings.theme.light": "Light",
      "settings.theme.dark": "Dark",
      "settings.accent": "Accent color",
      "settings.accent.blue": "Blue",
      "settings.accent.indigo": "Indigo",
      "settings.accent.purple": "Purple",
      "settings.accent.teal": "Teal",
      "settings.accent.orange": "Orange",
      "settings.model.title": "Model",
      "settings.provider": "Provider",
      "settings.baseUrl": "Endpoint",
      "settings.baseUrl.preset":
        "Preset endpoints are fixed and validated by Brace.",
      "settings.baseUrl.custom":
        "Custom endpoints must use HTTPS; localhost and 127.0.0.1 may use HTTP.",
      "settings.baseUrl.regional":
        "Official regional endpoints are accepted when they match this provider; credentials stay isolated per endpoint.",
      "settings.model": "Model",
      "settings.model.note":
        "Suggestions are optional; you can enter any model ID supported by the provider.",
      "settings.apiKey": "API key",
      "settings.apiKey.placeholder": "Leave blank to keep the existing key",
      "settings.apiKey.none": "No key configured.",
      "settings.apiKey.remove": "Remove the saved API key",
      "settings.apiKey.secure":
        "Key saved securely; leave blank to keep it unchanged.",
      "settings.apiKey.environment": "Using the LLM_API_KEY environment variable.",
      "settings.apiKey.environmentMatched":
        "Using the environment key matched to this endpoint.",
      "settings.apiKey.changed":
        "The provider or endpoint changed. Enter its key; the existing key will not be sent to the new endpoint.",
      "settings.apiKey.prompt": "Enter the API key for this endpoint.",
      "settings.security.secure":
        "The API key is encrypted by system secure storage in the main process. The page and local task history never read the plaintext.",
      "settings.security.environment":
        "The key comes from the process environment and is never exposed to the page. Saving a new key will switch to system secure storage.",
      "settings.security.unavailable":
        "System secure storage is unavailable. Provide credentials through LLM_API_KEY.",
      "settings.checking": "Checking configuration…",
      "settings.noKey": "No key",
      "settings.connectionSuccess":
        "Model and tool calling are ready · {model} · {latency} ms",
      "settings.saved": "Model settings saved securely.",
      "settings.saveFailed": "Unable to save settings",
      "settings.activeTask":
        "Finish or stop the active task in this project first.",
      "thread.activeApproval":
        "This project has an action waiting for approval. It is now open.",
      "thread.activeRun": "This project's task is still running. It is now open.",
      "thread.none": "This project has no tasks yet",
      "thread.openFirst": "Open a project first",
      "thread.pendingCount": "{count} pending",
      "timeline.callingTool": "Calling {tool}",
      "timeline.toolFailed": "Tool failed",
      "timeline.runFailed": "Run failed: {message}",
      "timeline.olderHidden":
        "{count} older timeline items are hidden for performance.",
      "approval.details": "View full arguments",
      "approval.effect.write": "Will modify project files",
      "approval.effect.execute": "Will run a local command",
      "approval.effect.network": "Will access the network",
      "approval.effect.default": "Needs your confirmation",
      "approval.target.file": "File · {path}",
      "approval.target.move": "Move · {from} → {to}",
      "approval.target.command": "Command · {command}",
      "approval.target.default": "Review the full arguments before deciding",
      "tool.list_files": "List files",
      "tool.search_code": "Search code",
      "tool.read_file": "Read file",
      "tool.apply_patch": "Modify files",
      "tool.delete_file": "Delete file",
      "tool.move_file": "Move file",
      "tool.run_command": "Run command",
      "tool.git_status": "Check Git status",
      "tool.git_diff": "Read Git diff",
      "tool.calculator": "Calculate",
      "tool.get_current_time": "Read current time",
      "status.idle": "Waiting",
      "status.running": "Running",
      "status.waiting_for_approval": "Waiting for approval",
      "status.completed": "Completed",
      "status.failed": "Failed",
      "status.cancelled": "Stopped",
      "error.unknown": "Unknown error",
      "provider.bailian-payg.label": "Bailian / Qwen (pay-as-you-go)",
      "provider.bailian-payg.description":
        "Alibaba Cloud Model Studio's OpenAI-compatible endpoint in China.",
      "provider.bailian-payg.apiKeyHint":
        "Use a pay-as-you-go Model Studio API key (usually starts with sk-)",
      "provider.bailian-coding-plan.label": "Bailian Coding Plan",
      "provider.bailian-coding-plan.description":
        "Alibaba Cloud Model Studio's OpenAI-compatible Coding Plan endpoint.",
      "provider.bailian-coding-plan.apiKeyHint":
        "Use a Coding Plan key (starts with sk-sp-)",
      "provider.bailian-coding-plan.notice":
        "For interactive coding tools only; not for backend or batch workloads.",
      "provider.minimax-cn-token-plan.label": "MiniMax Token Plan (China)",
      "provider.minimax-cn-token-plan.description":
        "MiniMax China's OpenAI-compatible Token Plan endpoint.",
      "provider.minimax-cn-token-plan.apiKeyHint":
        "Use a MiniMax China Token Plan subscription key",
      "provider.minimax-global-token-plan.label": "MiniMax Token Plan (Global)",
      "provider.minimax-global-token-plan.description":
        "MiniMax Global's OpenAI-compatible Token Plan endpoint.",
      "provider.minimax-global-token-plan.apiKeyHint":
        "Use a MiniMax Global Token Plan subscription key",
      "provider.kimi-code.label": "Kimi Code",
      "provider.kimi-code.description":
        "The OpenAI-compatible endpoint included with a Kimi Code membership.",
      "provider.kimi-code.apiKeyHint":
        "Use a membership API key generated in the Kimi Code console",
      "provider.kimi-code.notice":
        "Brace keeps its real client identity and does not impersonate another coding tool.",
      "provider.deepseek.label": "DeepSeek",
      "provider.deepseek.description":
        "DeepSeek's official OpenAI-compatible endpoint.",
      "provider.deepseek.apiKeyHint": "Use a DeepSeek Platform API key",
      "provider.glm-payg.label": "GLM (pay-as-you-go)",
      "provider.glm-payg.description":
        "Zhipu AI's standard OpenAI-compatible endpoint.",
      "provider.glm-payg.apiKeyHint": "Use a standard Zhipu AI Platform API key",
      "provider.glm-coding-plan.label": "GLM Coding Plan",
      "provider.glm-coding-plan.description":
        "GLM Coding Plan's OpenAI-compatible endpoint for coding tools.",
      "provider.glm-coding-plan.apiKeyHint":
        "Use an API key with GLM Coding Plan access",
      "provider.glm-coding-plan.notice":
        "The plan is limited to tools officially supported by Zhipu AI; Brace cannot guarantee plan-credit eligibility.",
      "provider.custom.label": "Custom OpenAI-compatible endpoint",
      "provider.custom.description":
        "OpenAI or another service compatible with Chat Completions.",
      "provider.custom.apiKeyHint": "Use the API key for this endpoint",
    }),
    "zh-CN": Object.freeze({
      "sidebar.projects": "项目",
      "sidebar.tasks": "任务",
      "action.openProject": "打开本地项目",
      "action.newTask": "新任务",
      "action.settings": "设置",
      "action.openWorkspace": "在 Finder 中打开",
      "action.showDiff": "查看工作区 Diff",
      "action.showPreview": "显示本地 Web 预览",
      "action.hidePreview": "返回任务（预览保持运行）",
      "action.hidePreviewAria": "返回任务，预览保持运行",
      "action.toggleInspector": "显示或隐藏任务详情",
      "action.showInspector": "显示任务详情",
      "action.hideInspector": "隐藏任务详情",
      "action.stopTask": "停止当前任务",
      "action.stoppingTask": "正在停止任务",
      "action.close": "关闭",
      "action.open": "打开",
      "action.refresh": "刷新预览",
      "action.stopPreview": "停止并关闭预览",
      "action.retry": "重新加载",
      "action.run": "运行",
      "action.connectModel": "连接模型",
      "action.reviewChanges": "审查变更",
      "action.continueTask": "继续",
      "action.retryInstruction": "重试指令",
      "action.testConnection": "测试连接",
      "action.cancel": "取消",
      "action.saveSettings": "保存设置",
      "action.deny": "拒绝",
      "action.allowOnce": "允许一次",
      "action.processing": "处理中…",
      "mode.label": "执行模式",
      "mode.tooltip": "新任务执行模式",
      "mode.local": "当前目录",
      "mode.worktree": "隔离 Worktree",
      "mode.localShort": "当前目录",
      "mode.worktreeShort": "隔离目录",
      "mode.worktreeCleanupShort": "需要清理",
      "project.none": "尚未选择项目",
      "thread.start": "开始一个编码任务",
      "thread.openProject": "打开本地代码项目",
      "empty.ready.title": "今天想构建什么？",
      "empty.ready.description":
        "描述一个目标，Agent 会理解项目、规划修改，并在执行敏感操作前征求你的确认。",
      "empty.connectModel.title": "连接模型后开始",
      "empty.connectModel.description":
        "选择供应商并添加 API Key。Brace 会使用系统安全存储保护凭据。",
      "empty.noProject.title": "打开一个本地项目",
      "empty.noProject.description":
        "选择一个代码目录，Brace 会在你的设备上读取上下文并执行任务。",
      "suggestion.fix.prompt":
        "检查这个项目，修复失败的测试并说明根本原因。",
      "suggestion.fix.title": "修复失败的测试",
      "suggestion.fix.subtitle": "定位根因并验证修复",
      "suggestion.architecture.prompt":
        "分析这个代码库的架构、主要模块和从指令到执行的完整流程。",
      "suggestion.architecture.title": "理解代码架构",
      "suggestion.architecture.subtitle": "梳理模块与运行链路",
      "suggestion.refactor.prompt":
        "在保持现有行为的前提下重构当前项目，改善可维护性并补齐必要测试。",
      "suggestion.refactor.title": "安全重构项目",
      "suggestion.refactor.subtitle": "保留行为并补充测试",
      "preview.region": "本地 Web 预览",
      "preview.addressForm": "打开本地预览地址",
      "preview.address": "本地预览地址",
      "preview.empty.title": "预览本地应用",
      "preview.empty.description":
        "启动项目的开发服务器，然后输入 localhost 地址。",
      "preview.empty.example": "使用 localhost:3000",
      "preview.connecting.title": "正在连接本地服务",
      "preview.connecting.description": "这通常只需要几秒钟。",
      "preview.frameTitle": "本地应用预览",
      "preview.restricted": "仅允许 localhost 与 127.0.0.1",
      "preview.refreshing": "正在刷新本地预览…",
      "preview.reconnecting": "正在重新连接本地服务…",
      "preview.connectingHost": "正在连接 {host}…",
      "preview.invalidAddress": "请输入有效的本地预览地址",
      "preview.emptyAddress": "请输入本地预览地址。",
      "preview.untrustedAddress":
        "预览仅允许 http://localhost 或 http://127.0.0.1。",
      "preview.blockedNavigation": "预览已阻止跳转到非本地地址。",
      "preview.blockedRedirect": "预览已阻止重定向到非本地地址。",
      "preview.cannotConnect":
        "无法连接本地服务。请确认开发服务器已经启动。",
      "preview.cannotResolve": "无法解析本地地址。请检查地址和端口。",
      "preview.noNetwork": "当前设备没有可用网络。",
      "preview.loadFailedWithDescription": "本地预览加载失败：{description}",
      "preview.loadFailed": "本地预览加载失败。",
      "preview.timeout":
        "连接时间过长。请确认开发服务器已启动，并检查端口是否正确。",
      "preview.ready": "正在预览 {host}",
      "preview.errorTitle": "无法打开本地预览",
      "preview.stopped": "预览已停止 · 地址已为此项目保留",
      "preview.saved": "已保留 {host}，开发服务器启动后即可重新打开。",
      "preview.openSaved": "打开上次预览",
      "composer.task": "编码任务",
      "composer.readyPlaceholder": "描述一个编码任务…",
      "composer.connectModelPlaceholder": "连接模型后即可编写任务…",
      "composer.noProjectPlaceholder": "先打开一个本地项目…",
      "composer.activePlaceholder": "可先写下一条指令，当前任务结束后发送…",
      "composer.cleanupPlaceholder": "请先完成隔离目录清理，再继续此任务…",
      "runtime.waitingForProject": "等待选择项目",
      "runtime.connectModel": "连接模型后即可运行任务",
      "runtime.creatingTask": "正在创建任务…",
      "runtime.waitingForApproval": "等待你审批操作",
      "runtime.runningWithDraft": "任务执行中 · 可先写下一条指令",
      "runtime.newLocalTask": "新建本地任务",
      "runtime.continueTask": "继续这个任务",
      "runtime.cleanupRequired": "需要清理隔离目录",
      "outcome.completed.title": "Agent 已结束本次响应",
      "outcome.completed.description":
        "模型已正常停止。请审查工作区 Diff，并运行相关验证后再保留结果。",
      "outcome.failed.title": "任务需要处理",
      "outcome.failed.description": "本轮运行因错误而停止：{message}",
      "outcome.failed.descriptionFallback":
        "本轮运行因错误而停止。请检查详情和可能已产生的部分变更。",
      "outcome.cancelled.title": "任务已停止",
      "outcome.cancelled.description":
        "可能产生的部分工作区变更已保留，请审查后再继续。",
      "outcome.cleanupRequired":
        "请先在任务详情中完成隔离目录清理，再继续任务。",
      "outcome.retryPrompt":
        "请从当前工作区状态继续：先检查已有变更，解决剩余问题，并验证结果。",
      "outcome.draftPreserved": "已保留当前草稿，请编辑后再重试。",
      "inspector.close": "关闭任务详情",
      "inspector.label": "任务详情",
      "inspector.status": "运行状态",
      "inspector.notRun": "未运行",
      "inspector.notRunDescription": "提交任务后会显示实时进度。",
      "worktree.title": "隔离 Worktree",
      "worktree.loading": "正在读取 Worktree 状态…",
      "worktree.unavailable": "暂时无法读取 Worktree 信息。",
      "worktree.dirty": "存在未提交变更",
      "worktree.clean": "工作区干净",
      "worktree.ahead": "领先 {count} 个提交",
      "worktree.apply": "应用",
      "worktree.discard": "丢弃",
      "worktree.retryCleanup": "重试清理",
      "worktree.applied": "变更已应用到主项目。",
      "worktree.discarded": "隔离变更已丢弃。",
      "worktree.cleanupComplete": "隔离目录清理完成。",
      "worktree.cleanupStatus": "变更已应用 · 需要清理隔离目录",
      "worktree.cleanupPending":
        "变更已成功应用。请使用“重试清理”安全移除隔离分支和目录。",
      "inspector.approvals": "待审批操作",
      "inspector.noApprovals": "暂无待审批操作",
      "inspector.diff": "工作区 Diff",
      "diff.afterRun": "运行任务后可检查未提交变更。",
      "diff.select": "选择“查看 Diff”以读取工作区变更。",
      "diff.loading": "正在读取 Diff…",
      "diff.lines": "{count} 行",
      "diff.noChangesShort": "无变更",
      "diff.noChanges": "当前工作区没有未提交变更。",
      "diff.unavailable": "暂时无法读取工作区 Diff，请再次选择“审查变更”。",
      "settings.title": "设置",
      "settings.appearance.title": "外观",
      "settings.appearance.description": "更改会立即生效，并保存在此设备上。",
      "settings.language": "语言",
      "settings.language.en": "English",
      "settings.language.zh": "简体中文",
      "settings.theme": "主题",
      "settings.theme.system": "跟随系统",
      "settings.theme.light": "浅色",
      "settings.theme.dark": "深色",
      "settings.accent": "主题色",
      "settings.accent.blue": "蓝色",
      "settings.accent.indigo": "靛青",
      "settings.accent.purple": "紫色",
      "settings.accent.teal": "青色",
      "settings.accent.orange": "橙色",
      "settings.model.title": "模型",
      "settings.provider": "供应商",
      "settings.baseUrl": "接口地址",
      "settings.baseUrl.preset": "预设地址由 Brace 固定校验。",
      "settings.baseUrl.custom":
        "自定义接口必须使用 HTTPS；本机 localhost / 127.0.0.1 可使用 HTTP。",
      "settings.baseUrl.regional":
        "可填写该供应商的官方地区地址；不同地址的凭据会严格隔离。",
      "settings.model": "模型",
      "settings.model.note":
        "推荐值仅作提示，也可以输入供应商支持的其他模型 ID。",
      "settings.apiKey": "API Key",
      "settings.apiKey.placeholder": "留空则保留现有 Key",
      "settings.apiKey.none": "尚未配置 Key。",
      "settings.apiKey.remove": "移除已保存的 API Key",
      "settings.apiKey.secure": "已安全保存 Key；留空将保持不变。",
      "settings.apiKey.environment": "正在使用 LLM_API_KEY 环境变量。",
      "settings.apiKey.environmentMatched":
        "正在使用与当前接口匹配的环境变量 Key。",
      "settings.apiKey.changed":
        "供应商或地址已变更，请输入对应的新 Key；现有 Key 不会发送到新地址。",
      "settings.apiKey.prompt": "请输入该接口对应的 API Key。",
      "settings.security.secure":
        "API Key 仅在主进程中使用系统安全存储加密；页面和本地任务记录不会读取明文。",
      "settings.security.environment":
        "Key 由进程环境提供，页面不会读取明文。保存新 Key 后将改用系统安全存储。",
      "settings.security.unavailable":
        "系统安全存储当前不可用。请通过 LLM_API_KEY 环境变量提供凭据。",
      "settings.checking": "检查配置…",
      "settings.noKey": "未配置 Key",
      "settings.connectionSuccess":
        "模型与工具调用已就绪 · {model} · {latency} ms",
      "settings.saved": "模型设置已安全保存。",
      "settings.saveFailed": "保存设置失败",
      "settings.activeTask": "请先完成或停止当前项目正在运行的任务。",
      "thread.activeApproval": "这个项目有操作等待审批，已为你打开。",
      "thread.activeRun": "这个项目的任务仍在执行，已为你打开。",
      "thread.none": "这个项目还没有任务",
      "thread.openFirst": "先打开一个项目",
      "thread.pendingCount": "{count} 待处理",
      "timeline.callingTool": "调用 {tool}",
      "timeline.toolFailed": "工具执行失败",
      "timeline.runFailed": "运行失败：{message}",
      "timeline.olderHidden": "为保持流畅，已隐藏较早的 {count} 条时间线内容。",
      "approval.details": "查看完整参数",
      "approval.effect.write": "将修改项目文件",
      "approval.effect.execute": "将执行本地命令",
      "approval.effect.network": "将访问网络",
      "approval.effect.default": "需要你的确认",
      "approval.target.file": "文件 · {path}",
      "approval.target.move": "移动 · {from} → {to}",
      "approval.target.command": "命令 · {command}",
      "approval.target.default": "请检查完整参数后决定",
      "tool.list_files": "查看文件",
      "tool.search_code": "搜索代码",
      "tool.read_file": "读取文件",
      "tool.apply_patch": "修改文件",
      "tool.delete_file": "删除文件",
      "tool.move_file": "移动文件",
      "tool.run_command": "执行命令",
      "tool.git_status": "检查 Git 状态",
      "tool.git_diff": "读取 Git Diff",
      "tool.calculator": "计算",
      "tool.get_current_time": "读取当前时间",
      "status.idle": "等待运行",
      "status.running": "正在执行",
      "status.waiting_for_approval": "等待审批",
      "status.completed": "已完成",
      "status.failed": "失败",
      "status.cancelled": "已停止",
      "error.unknown": "未知错误",
      "provider.bailian-payg.label": "百炼 / Qwen（按量）",
      "provider.bailian-payg.description": "阿里云百炼中国站 OpenAI 兼容接口。",
      "provider.bailian-payg.apiKeyHint":
        "使用百炼按量 API Key（通常以 sk- 开头）",
      "provider.bailian-coding-plan.label": "百炼 Coding Plan",
      "provider.bailian-coding-plan.description":
        "阿里云百炼 Coding Plan 的 OpenAI 兼容接口。",
      "provider.bailian-coding-plan.apiKeyHint":
        "必须使用 Coding Plan 专用 Key（以 sk-sp- 开头）",
      "provider.bailian-coding-plan.notice":
        "仅用于交互式编码工具，不可用于后端或批处理任务。",
      "provider.minimax-cn-token-plan.label": "MiniMax Token Plan（中国）",
      "provider.minimax-cn-token-plan.description":
        "MiniMax 中国站 Token Plan 的 OpenAI 兼容接口。",
      "provider.minimax-cn-token-plan.apiKeyHint":
        "使用 MiniMax 中国站 Token Plan 订阅 Key",
      "provider.minimax-global-token-plan.label": "MiniMax Token Plan（全球）",
      "provider.minimax-global-token-plan.description":
        "MiniMax 全球站 Token Plan 的 OpenAI 兼容接口。",
      "provider.minimax-global-token-plan.apiKeyHint":
        "使用 MiniMax 全球站 Token Plan 订阅 Key",
      "provider.kimi-code.label": "Kimi Code",
      "provider.kimi-code.description": "Kimi Code 会员订阅的 OpenAI 兼容接口。",
      "provider.kimi-code.apiKeyHint":
        "使用 Kimi Code 控制台生成的会员 API Key",
      "provider.kimi-code.notice":
        "保留 Brace 的真实客户端身份，不模拟其他编码工具。",
      "provider.deepseek.label": "DeepSeek",
      "provider.deepseek.description": "DeepSeek 官方 OpenAI 兼容接口。",
      "provider.deepseek.apiKeyHint": "使用 DeepSeek 开放平台 API Key",
      "provider.glm-payg.label": "GLM（按量）",
      "provider.glm-payg.description": "智谱开放平台标准 OpenAI 兼容接口。",
      "provider.glm-payg.apiKeyHint": "使用智谱开放平台标准 API Key",
      "provider.glm-coding-plan.label": "GLM Coding Plan",
      "provider.glm-coding-plan.description":
        "GLM Coding Plan 面向编码工具的 OpenAI 兼容接口。",
      "provider.glm-coding-plan.apiKeyHint":
        "使用具备 GLM Coding Plan 权益的 API Key",
      "provider.glm-coding-plan.notice":
        "套餐仅限智谱官方支持的指定工具；Brace 不保证能够抵扣套餐额度。",
      "provider.custom.label": "自定义 OpenAI 兼容接口",
      "provider.custom.description":
        "OpenAI 或其他兼容 Chat Completions 的服务。",
      "provider.custom.apiKeyHint": "使用该接口地址对应的 API Key",
    }),
  });

  function readStored(key, allowedValues, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return allowedValues.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // The preference still applies for this session if storage is unavailable.
    }
  }

  const initialPreferences = window.baseAgent?.initialUiPreferences ?? DEFAULTS;
  let locale = LOCALES.includes(initialPreferences.locale)
    ? initialPreferences.locale
    : DEFAULTS.locale;
  let theme = THEMES.includes(initialPreferences.theme)
    ? initialPreferences.theme
    : DEFAULTS.theme;
  let accent = readStored(STORAGE_KEYS.accent, ACCENTS, DEFAULTS.accent);

  function interpolate(value, parameters) {
    return value.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
      Object.hasOwn(parameters, name) ? String(parameters[name]) : match,
    );
  }

  function t(key, parameters = {}, fallback = key) {
    const value = messages[locale]?.[key] ?? messages.en[key] ?? fallback;
    return interpolate(value, parameters);
  }

  function applyDocumentTranslations(root = document) {
    for (const element of root.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n);
    }
    const attributeBindings = [
      ["data-i18n-title", "title"],
      ["data-i18n-aria-label", "aria-label"],
      ["data-i18n-placeholder", "placeholder"],
      ["data-i18n-prompt", "data-prompt"],
    ];
    for (const [selector, attribute] of attributeBindings) {
      for (const element of root.querySelectorAll(`[${selector}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(selector)));
      }
    }
    document.documentElement.lang = locale;
  }

  function applyAppearance() {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.accent = accent;
  }

  function setLocale(value) {
    if (!LOCALES.includes(value)) return false;
    locale = value;
    applyDocumentTranslations();
    return true;
  }

  function setTheme(value) {
    if (!THEMES.includes(value)) return false;
    theme = value;
    applyAppearance();
    return true;
  }

  function setAccent(value, { persist = true } = {}) {
    if (!ACCENTS.includes(value)) return false;
    accent = value;
    if (persist) writeStored(STORAGE_KEYS.accent, accent);
    applyAppearance();
    return true;
  }

  document.documentElement.lang = locale;
  applyAppearance();

  Object.defineProperty(window, "baseAgentPreferences", {
    configurable: false,
    enumerable: true,
    value: Object.freeze({
      get locale() {
        return locale;
      },
      get theme() {
        return theme;
      },
      get accent() {
        return accent;
      },
      locales: LOCALES,
      themes: THEMES,
      accents: ACCENTS,
      t,
      applyDocumentTranslations,
      setLocale,
      setTheme,
      setAccent,
    }),
    writable: false,
  });
})();
