const MAX_COMPOSER_ATTACHMENTS = 3;
const MAX_COMPOSER_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const AUTO_COMPACT_CONTEXT_PERCENT = 85;

const BACKEND_OPTIONS = [
  { value: "", label: "桌面默认" }
];

const MODEL_OPTIONS = [
  { value: "", label: "桌面默认" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { value: "gpt-5.2-codex", label: "GPT-5.2-Codex" }
];

const REASONING_OPTIONS = [
  { value: "", label: "桌面默认" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最大" }
];

const PERMISSION_MODE_OPTIONS = [
  { value: "", label: "默认" },
  { value: "strict", label: "严格" },
  { value: "approve", label: "批准" },
  { value: "full", label: "全权限" }
];

export function createAppContext(windowRef = window, documentRef = document) {
  const params = new URLSearchParams(windowRef.location.search);
  const tokenFromUrl = params.get("token");
  if (tokenFromUrl) {
    windowRef.localStorage.setItem("echoToken", tokenFromUrl);
    windowRef.history.replaceState({}, "", windowRef.location.pathname);
  }
  const storedUser = readStoredUser(windowRef.localStorage);

  return {
    window: windowRef,
    document: documentRef,
    navigator: windowRef.navigator,
    localStorage: windowRef.localStorage,
    crypto: windowRef.crypto,
    constants: {
      BACKEND_OPTIONS,
      MAX_COMPOSER_ATTACHMENTS,
      MAX_COMPOSER_ATTACHMENT_BYTES,
      MODEL_OPTIONS,
      REASONING_OPTIONS,
      PERMISSION_MODE_OPTIONS
    },
    elements: queryElements(documentRef),
    state: {
      token: tokenFromUrl || readStoredEchoToken(windowRef.localStorage, storedUser) || "",
      sessionToken: windowRef.localStorage.getItem("echoSession") || "",
      currentUser: storedUser,
      authEnabled: true,
      themeMode: windowRef.localStorage.getItem("echoTheme") === "dark" ? "dark" : "light",
      worktreePreferenceEnabled: readStoredWorktreePreference(windowRef.localStorage),
      codexTimer: null,
      codexRefreshPromise: null,
      pairingStream: null,
      pairingScanActive: false,
      pairingScanBusy: false,
      selectedCodexJobId: "",
      selectedCodexSession: null,
      sessionEventSource: null,
      sessionEventSourceId: "",
      sessionEventReconnectTimer: null,
      sessionEventReconnectAttempts: 0,
      sessionLastEventIds: new Map(),
      sessionListRefreshTimer: null,
      sessionStreamRenderFrame: 0,
      pendingSessionStreamRender: null,
      composingNewSession: false,
      codexWorkspaces: readStoredCodexWorkspaces(windowRef.localStorage, storedUser),
      codexAvailableWorkspaceKeys: [],
      codexHiddenWorkspaceKeys: [],
      codexAgents: [],
      selectedAgentId: readStoredSelectedAgentId(windowRef.localStorage, storedUser),
      topbarContextTitle: "Echo",
      codexAgentOnline: false,
      codexAgentAvailable: false,
      codexLastAgentSeenAt: "",
      codexConnectionState: "connecting",
      codexStatusUpdatedAt: "",
      codexWorkspacesUpdatedAt: "",
      codexRuntimeUpdatedAt: "",
      codexStatusVersion: "",
      projectCreateBusy: false,
      projectImportBusy: false,
      projectImportRootId: "",
      projectImportPath: "",
      projectImportTree: null,
      projectImportError: "",
      expandedProjectConversationKeys: new Set(),
      expandedToolDisclosureKeys: new Set(),
      showArchivedSessions: false,
      composerBusy: false,
      codexAgentRuntime: {},
      codexBackendRuntimes: [],
      codexModelCatalog: [],
      codexUnsupportedModels: [],
      codexSupportedModels: [],
      codexAllowedPermissionModes: [],
      codexSupportedPermissionModes: [],
      runtimePreferences: readStoredRuntimePreferences(windowRef.localStorage),
      runtimeMigrationCandidate: readStoredRuntimePreferences(windowRef.localStorage),
      runtimePreferenceScopeKey: "",
      runtimePreferenceVersion: 0,
      runtimePreferenceLoading: false,
      runtimePreferenceSaving: false,
      runtimePreferenceError: "",
      runtimePreferenceLoadPromise: null,
      runtimePreferenceSavePromise: null,
      runtimePreferencePendingSave: null,
      runtimePreferenceRetries: new Map(),
      runtimeDirty: false,
      runtimeSelectControls: [],
      runtimeSelectControlsInstalled: false,
      runtimeSelectPopover: null,
      runtimeSelectPopoverPanel: null,
      mcpSnapshot: null,
      mcpProfiles: [],
      mcpServers: [],
      mcpClients: [],
      mcpSelectedProfileId: "",
      mcpSelectedServerId: "",
      mcpAddOpen: false,
      mcpTargetClients: readStoredMcpTargetClients(windowRef.localStorage),
      mcpBusy: false,
      mcpApplyCommandId: "",
      lastTopbarScrollY: 0,
      topbarScrollAccumulator: 0,
      topbarCollapsed: false,
      viewportStableHeight: 0,
      viewportStableWidth: 0,
      viewportKeyboardActive: false,
      viewportPromptFocused: false,
      viewportFinalSyncTimer: null,
      viewportFinalSyncToken: null,
      renderedCodexSessionId: "",
      renderedCodexSessionSignature: "",
      composerAttachments: [],
      composerAttachmentPendingCount: 0,
      composerAttachmentPendingKind: "",
      composerPlanMode: readStoredComposerMode(windowRef.localStorage, storedUser) === "plan",
      quickSkills: [],
      quickSkillsLoadedProjectId: null,
      quickSkillsBusy: false,
      quickSkillEditingId: "",
      installedAgentSkills: [],
      agentSkillSnapshot: null,
      agentSkillSelectedId: "",
      agentSkillBusy: false,
      agentSkillCommandId: "",
      desktopPluginSnapshot: null,
      desktopPluginBusy: false,
      gitDetailsOpenSessionId: "",
      contextUsageDetailsOpen: false,
      autoCompactionRequestSessionIds: new Set(),
      openSpecProjectId: "",
      openSpecSummary: null,
      openSpecSummariesByProject: {},
      openSpecBusy: false,
      openSpecError: "",
      openSpecStale: false,
      openSpecRequestSeq: 0,
      openSpecMode: "browse",
      orchestrationSelectedIds: new Set(),
      orchestrationOrder: [],
      orchestrationRun: null,
      orchestrationBusy: false,
      orchestrationError: "",
      orchestrationEventSource: null,
      orchestrationPollTimer: null,
      fileBrowserProjectId: "",
      fileBrowserPath: "",
      fileBrowserTree: null,
      fileBrowserTreesByProject: {},
      fileBrowserStale: false,
      filePreview: null,
      fileBrowserBusy: false,
      fileBrowserError: "",
      fileBrowserRequestSeq: 0,
      fileBrowserContext: null,
      fileBrowserReturnPoint: null,
      filePreviewLine: 0,
      filePreviewLineNotice: "",
      adminSummary: null,
      adminBusy: false,
      adminSelectedUsername: "",
      adminGeneratedPairing: null,
      adminLoaded: false,
      confirmDismiss: null
    }
  };
}

export function installCore(app) {
  const { document, elements, localStorage, state, window } = app;
  const {
    BACKEND_OPTIONS: backendOptions,
    MODEL_OPTIONS: modelOptions,
    PERMISSION_MODE_OPTIONS: permissionOptions,
    REASONING_OPTIONS: reasoningOptions
  } = app.constants;

  app.storageUserKey = function storageUserKey(user = state.currentUser) {
    return normalizeStorageUserKey(user);
  };

  app.scopedStorageKey = function scopedStorageKey(baseKey, user = state.currentUser) {
    const userKey = app.storageUserKey(user);
    return userKey ? `${baseKey}:${userKey}` : baseKey;
  };

  app.readScopedStorage = function readScopedStorage(baseKey, user = state.currentUser, options = {}) {
    const scopedKey = app.scopedStorageKey(baseKey, user);
    const scopedValue = localStorage.getItem(scopedKey);
    if (scopedValue) return scopedValue;
    if (options.fallbackLegacy === false || scopedKey === baseKey) return "";
    return localStorage.getItem(baseKey) || "";
  };

  app.writeScopedStorage = function writeScopedStorage(baseKey, value, user = state.currentUser) {
    const scopedKey = app.scopedStorageKey(baseKey, user);
    localStorage.setItem(scopedKey, String(value || ""));
    if (scopedKey !== baseKey) localStorage.removeItem(baseKey);
  };

  app.removeScopedStorage = function removeScopedStorage(baseKey, user = state.currentUser) {
    const scopedKey = app.scopedStorageKey(baseKey, user);
    localStorage.removeItem(scopedKey);
    if (scopedKey !== baseKey) localStorage.removeItem(baseKey);
  };

  app.storedEchoToken = function storedEchoToken(user = state.currentUser, options = {}) {
    return app.readScopedStorage("echoToken", user, options);
  };

  app.persistEchoToken = function persistEchoToken(token, user = state.currentUser) {
    app.writeScopedStorage("echoToken", token, user);
  };

  app.clearEchoToken = function clearEchoToken(user = state.currentUser) {
    app.removeScopedStorage("echoToken", user);
  };

  app.readStoredCodexWorkspaces = function readStoredCodexWorkspacesForUser(user = state.currentUser, options = {}) {
    return readStoredCodexWorkspaces(localStorage, user, options);
  };

  app.storedCodexProjectKey = function storedCodexProjectKey(user = state.currentUser, options = {}) {
    const fallbackLegacy = options.fallbackLegacy ?? !app.storageUserKey(user);
    return app.readScopedStorage("echoCodexProject", user, { ...options, fallbackLegacy });
  };

  app.persistCodexProjectKey = function persistCodexProjectKey(projectKey, user = state.currentUser) {
    app.writeScopedStorage("echoCodexProject", projectKey, user);
  };

  app.storedSelectedAgentId = function storedSelectedAgentId(user = state.currentUser, options = {}) {
    const fallbackLegacy = options.fallbackLegacy ?? !app.storageUserKey(user);
    return app.readScopedStorage("echoSelectedAgent", user, { ...options, fallbackLegacy });
  };

  app.persistSelectedAgentId = function persistSelectedAgentId(agentId, user = state.currentUser) {
    const normalized = String(agentId || "").trim();
    if (normalized) app.writeScopedStorage("echoSelectedAgent", normalized, user);
    else app.removeScopedStorage("echoSelectedAgent", user);
  };

  app.clearCodexClientState = function clearCodexClientState(options = {}) {
    const user = options.user || state.currentUser;
    if (options.clearStorage !== false) {
      app.removeScopedStorage("echoCodexProject", user);
      app.removeScopedStorage("echoCodexWorkspaces", user);
    }
    if (options.clearPairing) {
      app.clearEchoToken(user);
      state.token = "";
    }
    state.codexWorkspaces = [];
    state.codexAvailableWorkspaceKeys = [];
    state.codexHiddenWorkspaceKeys = [];
    state.codexAgents = [];
    state.selectedAgentId = "";
    state.codexAgentOnline = false;
    state.codexAgentAvailable = false;
    state.codexLastAgentSeenAt = "";
    state.codexConnectionState = "connecting";
    state.codexStatusUpdatedAt = "";
    state.codexWorkspacesUpdatedAt = "";
    state.codexRuntimeUpdatedAt = "";
    state.codexStatusVersion = "";
    state.selectedCodexJobId = "";
    state.selectedCodexSession = null;
    state.composingNewSession = false;
    state.runtimePreferences = { backendId: "", permissionMode: "", model: "", reasoningEffort: "", mcpProfileId: "", worktreeMode: "off" };
    state.runtimeMigrationCandidate = null;
    state.runtimePreferenceScopeKey = "";
    state.runtimePreferenceVersion = 0;
    state.runtimePreferenceLoading = false;
    state.runtimePreferenceError = "";
    state.runtimePreferenceLoadPromise = null;
    state.runtimePreferencePendingSave = null;
    state.runtimePreferenceRetries?.clear?.();
    state.projectImportBusy = false;
    state.projectImportRootId = "";
    state.projectImportPath = "";
    state.projectImportTree = null;
    state.projectImportError = "";
    state.desktopPluginSnapshot = null;
    state.desktopPluginBusy = false;
    state.openSpecSummary = null;
    state.openSpecProjectId = "";
    state.expandedProjectConversationKeys?.clear?.();
    if (elements.codexProject) elements.codexProject.value = "";
  };

  app.bindViewportMetrics = function bindViewportMetrics() {
    app.syncViewportMetrics();
    window.addEventListener("resize", app.syncViewportMetrics, { passive: true });
    window.visualViewport?.addEventListener("resize", app.syncViewportMetrics, { passive: true });
    window.visualViewport?.addEventListener("scroll", app.syncViewportMetrics, { passive: true });
    elements.codexPrompt?.addEventListener("focus", () => {
      app.cancelViewportFinalSync();
      state.viewportPromptFocused = true;
      app.queueViewportSync();
    });
    elements.codexPrompt?.addEventListener("blur", () => {
      state.viewportPromptFocused = false;
      app.queueViewportSync({ final: true });
    });
  };

  app.ensureComposerModeSwitchPlacement = function ensureComposerModeSwitchPlacement() {
    const button = elements.composerPlanModeButton;
    const meta = document.querySelector?.(".composer-status-meta");
    if (!button || !meta) return;
    if (button.parentElement === meta && meta.firstElementChild === button) return;
    meta.insertBefore?.(button, meta.firstElementChild || null);
  };

  app.syncViewportMetrics = function syncViewportMetrics() {
    app.ensureComposerModeSwitchPlacement?.();
    const keepConversationBottom = app.shouldKeepConversationAtBottom();
    const viewport = window.visualViewport;
    const compactMode = app.usesCompactTopbarMode();
    const visualHeight = Math.round(viewport?.height || window.innerHeight || 0);
    const visualWidth = Math.round(viewport?.width || window.innerWidth || 0);
    const layoutHeight = Math.round(window.innerHeight || visualHeight || 0);
    const layoutWidth = Math.round(window.innerWidth || visualWidth || 0);
    const baseHeight = Math.max(layoutHeight, visualHeight);
    const baseWidth = Math.max(layoutWidth, visualWidth);
    const widthChanged = Boolean(state.viewportStableWidth && Math.abs(baseWidth - state.viewportStableWidth) > 24);
    if (!state.viewportStableHeight || widthChanged || !compactMode) {
      state.viewportStableHeight = baseHeight;
      state.viewportStableWidth = baseWidth;
      if (widthChanged) state.viewportKeyboardActive = false;
    }

    let stableHeight = state.viewportStableHeight || baseHeight;
    const keyboardHeight = Math.max(0, stableHeight - visualHeight);
    const keyboardLikely = compactMode && keyboardHeight >= 96;
    const promptFocused = state.viewportPromptFocused || document.activeElement === elements.codexPrompt;
    const keyboardActive = keyboardLikely && (promptFocused || state.viewportKeyboardActive);
    state.viewportKeyboardActive = keyboardActive;
    if (!keyboardActive) {
      app.cancelViewportFinalSync();
      state.viewportStableHeight = baseHeight;
      state.viewportStableWidth = baseWidth;
      stableHeight = baseHeight;
    }

    const nextHeight = keyboardActive ? visualHeight : state.viewportStableHeight || baseHeight;
    const viewportTop = keyboardActive ? Math.max(0, Math.round(viewport?.offsetTop || 0)) : 0;
    const viewportBottom = keyboardActive ? Math.max(0, Math.round(stableHeight - visualHeight - viewportTop)) : 0;
    if (nextHeight > 0) {
      document.documentElement.style.setProperty("--app-height", `${nextHeight}px`);
    }
    document.documentElement.style.setProperty("--visual-viewport-top", `${viewportTop}px`);
    document.documentElement.style.setProperty("--visual-viewport-bottom", `${viewportBottom}px`);
    document.body.classList.toggle("mobile-ui", compactMode);
    document.body.classList.toggle("desktop-ui", !compactMode);
    document.body.classList.toggle("mobile-keyboard-open", keyboardActive);
    if (compactMode && !keyboardActive && Math.abs(window.scrollY || 0) > 0) {
      window.scrollTo(0, 0);
    }
    if (elements.topbar) {
      document.documentElement.style.setProperty("--topbar-height", `${Math.round(elements.topbar.offsetHeight || 0)}px`);
    }
    app.syncComposerInputHeight();
    app.syncComposerMetrics();
    app.restoreConversationBottomIfNeeded(keepConversationBottom);
  };

  app.scheduleViewportFinalSync = function scheduleViewportFinalSync(delay = 640) {
    if (state.viewportFinalSyncTimer || state.viewportFinalSyncToken) return;
    const token = {};
    state.viewportFinalSyncToken = token;
    const run = () => {
      if (state.viewportFinalSyncToken !== token) return;
      state.viewportFinalSyncTimer = null;
      state.viewportFinalSyncToken = null;
      app.syncViewportMetrics();
    };
    const timer = window.setTimeout(run, delay);
    if (state.viewportFinalSyncToken === token) {
      state.viewportFinalSyncTimer = timer;
    }
  };

  app.cancelViewportFinalSync = function cancelViewportFinalSync() {
    state.viewportFinalSyncToken = null;
    if (state.viewportFinalSyncTimer) {
      window.clearTimeout?.(state.viewportFinalSyncTimer);
      state.viewportFinalSyncTimer = null;
    }
  };

  app.queueViewportSync = function queueViewportSync(options = {}) {
    window.requestAnimationFrame(() => {
      app.syncViewportMetrics();
    });
    window.setTimeout(app.syncViewportMetrics, 120);
    window.setTimeout(app.syncViewportMetrics, 320);
    if (options.final) {
      app.scheduleViewportFinalSync();
    }
  };

  app.applyThemeMode = function applyThemeMode(themeMode, options = {}) {
    const mode = themeMode === "dark" ? "dark" : "light";
    const isDark = mode === "dark";
    state.themeMode = mode;
    if (isDark) {
      document.documentElement.dataset.theme = "dark";
    } else {
      delete document.documentElement.dataset.theme;
    }
    document.body.classList.toggle("theme-dark", isDark);
    if (elements.themeModeToggle) {
      elements.themeModeToggle.checked = isDark;
      elements.themeModeToggle.setAttribute("aria-checked", isDark ? "true" : "false");
    }
    if (elements.themeColorMeta) {
      elements.themeColorMeta.setAttribute("content", isDark ? "#0d1014" : "#f5f6f8");
    }
    if (elements.appleStatusBarMeta) {
      elements.appleStatusBarMeta.setAttribute("content", isDark ? "black-translucent" : "default");
    }
    if (options.persist !== false) {
      localStorage.setItem("echoTheme", mode);
    }
  };

  app.toggleThemeMode = function toggleThemeMode() {
    app.applyThemeMode(elements.themeModeToggle?.checked ? "dark" : "light");
  };

  app.toggleWorktreeModePreference = function toggleWorktreeModePreference() {
    app.applyWorktreeModePreference(elements.worktreeModeToggle?.checked !== false);
  };

  app.bindTopbarScrollState = function bindTopbarScrollState() {
    app.resetTopbarScrollTracking({ forceVisible: true });
    elements.codexScrollSurface?.addEventListener(
      "scroll",
      () => {
        app.syncTopbarVisibility();
      },
      { passive: true }
    );
    window.addEventListener(
      "scroll",
      () => {
        app.syncTopbarVisibility();
      },
      { passive: true }
    );
    window.addEventListener(
      "resize",
      () => {
        app.resetTopbarScrollTracking({ forceVisible: true });
      },
      { passive: true }
    );
  };

  app.resetTopbarScrollTracking = function resetTopbarScrollTracking(options = {}) {
    state.lastTopbarScrollY = app.currentTopbarScrollY();
    state.topbarScrollAccumulator = 0;
    if (options.forceVisible) {
      app.setTopbarCollapsed(false);
    }
  };

  app.syncTopbarVisibility = function syncTopbarVisibility(options = {}) {
    if (!app.usesCompactTopbarMode()) {
      app.resetTopbarScrollTracking({ forceVisible: true });
      return;
    }

    const currentY = app.currentTopbarScrollY();
    const delta = currentY - state.lastTopbarScrollY;
    state.lastTopbarScrollY = currentY;
    if (
      options.forceVisible ||
      currentY <= 8 ||
      elements.codexView.classList.contains("sessions-open") ||
      elements.codexView.classList.contains("files-open") ||
      elements.codexView.classList.contains("open-spec-open")
    ) {
      state.topbarScrollAccumulator = 0;
      app.setTopbarCollapsed(false);
      return;
    }
    if (app.isConversationScrolledToBottom()) {
      state.topbarScrollAccumulator = 0;
      return;
    }
    if (Math.abs(delta) < 1) return;
    if (state.topbarScrollAccumulator && Math.sign(state.topbarScrollAccumulator) !== Math.sign(delta)) {
      state.topbarScrollAccumulator = delta;
    } else {
      state.topbarScrollAccumulator += delta;
    }
    if (state.topbarScrollAccumulator >= 18) {
      state.topbarScrollAccumulator = 0;
      app.setTopbarCollapsed(true);
    } else if (state.topbarScrollAccumulator <= -10) {
      state.topbarScrollAccumulator = 0;
      app.setTopbarCollapsed(false);
    }
  };

  app.currentTopbarScrollY = function currentTopbarScrollY() {
    if (app.usesCompactTopbarMode()) {
      return Math.max(window.scrollY || 0, elements.codexScrollSurface?.scrollTop || 0, 0);
    }
    return Math.max(window.scrollY || 0, 0);
  };

  app.isConversationScrolledToBottom = function isConversationScrolledToBottom() {
    if (!app.usesCompactTopbarMode()) return false;
    const surface = elements.codexScrollSurface;
    if (!surface || surface.hidden) return false;
    const distanceToBottom = surface.scrollHeight - surface.clientHeight - surface.scrollTop;
    return distanceToBottom <= 32;
  };

  app.usesCompactTopbarMode = function usesCompactTopbarMode() {
    return window.matchMedia("(max-width: 760px)").matches && !elements.codexView.hidden;
  };

  app.setTopbarCollapsed = function setTopbarCollapsed(collapsed) {
    if (state.topbarCollapsed === collapsed) return;
    state.topbarCollapsed = collapsed;
    document.body.classList.toggle("topbar-collapsed", collapsed);
  };

  app.syncComposerMetrics = function syncComposerMetrics() {
    const composerRectHeight = elements.composer?.getBoundingClientRect?.().height || 0;
    const composerHeight = Math.ceil(composerRectHeight || elements.composer?.offsetHeight || 0);
    if (composerHeight > 0) {
      document.documentElement.style.setProperty("--composer-height", `${composerHeight}px`);
    }
  };

  app.syncComposerInputHeight = function syncComposerInputHeight() {
    const textarea = elements.codexPrompt;
    if (!textarea) return;
    const keepConversationBottom = app.shouldKeepConversationAtBottom();
    const maxHeight = app.usesCompactTopbarMode() ? 132 : 168;
    const minHeight = app.usesCompactTopbarMode() ? 56 : 52;
    textarea.style.height = "auto";
    const nextHeight = Math.max(textarea.scrollHeight, minHeight);
    textarea.style.height = `${Math.min(nextHeight, maxHeight)}px`;
    textarea.style.overflowY = nextHeight > maxHeight ? "auto" : "hidden";
    app.syncComposerMetrics();
    app.restoreConversationBottomIfNeeded(keepConversationBottom);
  };

  app.shouldKeepConversationAtBottom = function shouldKeepConversationAtBottom() {
    return Boolean(
      app.usesCompactTopbarMode() &&
        app.conversationScrollSnapshot &&
        app.wasConversationNearBottom &&
        app.wasConversationNearBottom(app.conversationScrollSnapshot())
    );
  };

  app.restoreConversationBottomIfNeeded = function restoreConversationBottomIfNeeded(shouldRestore) {
    if (!shouldRestore || !app.scrollConversationToBottom) return;
    app.scrollConversationToBottom({ forceTopbarVisible: false });
  };

  app.composerAttachmentPendingText = function composerAttachmentPendingText() {
    const count = Number(state.composerAttachmentPendingCount || 0);
    const kind = String(state.composerAttachmentPendingKind || "").trim();
    if (count <= 0) return "";
    if (kind === "image") return count === 1 ? "正在处理 1 张图片…" : `正在处理 ${count} 张图片…`;
    if (kind === "file") return count === 1 ? "正在处理 1 个文件…" : `正在处理 ${count} 个文件…`;
    return count === 1 ? "正在处理 1 个附件…" : `正在处理 ${count} 个附件…`;
  };

  app.composerAttachmentPendingActionLabel = function composerAttachmentPendingActionLabel() {
    const kind = String(state.composerAttachmentPendingKind || "").trim();
    if (kind === "image") return "处理图片";
    if (kind === "file") return "处理文件";
    return "处理附件";
  };

  app.refreshComposerStatusBar = function refreshComposerStatusBar() {
    if (!elements.composerStatusText) return;

    const session = state.composingNewSession ? null : state.selectedCodexSession;
    let status = "";
    if (state.composerBusy) {
      status = "正在发送…";
    } else if (state.composerAttachmentPendingCount > 0) {
      status = app.composerAttachmentPendingText();
    } else if (state.codexConnectionState === "error") {
      status = "连接中断，可继续浏览";
    } else if (app.sessionCancelRequested?.(session)) {
      status = "正在中断";
    } else if (session?.pendingInteractionCount > 0) {
      status = "等待你的选择";
    } else if (session?.pendingApprovalCount > 0) {
      status = "等待你的审批";
    } else if (session?.status === "starting") {
      status = `${app.activeAgentLabel(session)} 正在启动`;
    } else if (session?.status === "running") {
      status = app.runningSessionStatusText?.(session) || `${app.activeAgentLabel(session)} 正在处理`;
    } else if (session?.pendingCommandCount > 0) {
      status = app.turnActivityForSession?.(session)?.text || "等待桌面接收任务";
    } else if (session?.status === "failed" && app.sessionCanRecoverFailure(session)) {
      status = "上一轮失败，可继续";
    } else if (session && !app.sessionCanAcceptFollowUp(session)) {
      status = "当前会话不可继续";
    } else if (session?.execution?.mode === "worktree") {
      status = "继续将在当前隔离 worktree 中运行";
    } else if (!state.codexAgentAvailable) {
      status = "等待桌面 agent";
    } else if (!app.currentProjectId()) {
      status = "先选择工程";
    } else if (state.codexConnectionState === "syncing") {
      status = "桌面状态同步中";
    }
    elements.composerStatusText.textContent = status;
    elements.composerStatusText.classList.toggle("is-empty", !status);
    app.refreshContextUsageIndicator();
  };

  app.refreshContextUsageIndicator = function refreshContextUsageIndicator() {
    const indicator = elements.contextUsageIndicator;
    if (!indicator) return;

    const detailsAvailable = Boolean(!state.composingNewSession && state.selectedCodexSession?.id);
    if (!detailsAvailable) state.contextUsageDetailsOpen = false;
    indicator.disabled = !detailsAvailable;
    indicator.classList.toggle("is-clickable", detailsAvailable);
    indicator.setAttribute("aria-expanded", detailsAvailable && state.contextUsageDetailsOpen ? "true" : "false");

    const usage = app.currentContextUsage();
    if (!usage) {
      const label = detailsAvailable && !app.sessionBackendSupports(state.selectedCodexSession, "contextUsage")
        ? "当前后端暂未提供上下文用量"
        : "上下文使用暂未同步";
      indicator.style.setProperty("--context-used", "0%");
      indicator.dataset.state = "unknown";
      indicator.title = detailsAvailable ? `${label}\n点击查看会话负载详情` : label;
      indicator.setAttribute("aria-label", detailsAvailable ? `${label}，点击查看会话负载详情` : label);
      app.refreshContextUsageDetails?.();
      return;
    }

    const hasLimit = usage.limitTokens > 0;
    const rawPercent = hasLimit ? Math.round((usage.usedTokens / usage.limitTokens) * 100) : 0;
    const percent = Math.max(0, Math.min(100, rawPercent));
    const visiblePercent = hasLimit && usage.usedTokens > 0 ? Math.max(1, percent) : 0;
    const stateName = !hasLimit ? "unknown" : percent >= AUTO_COMPACT_CONTEXT_PERCENT ? "full" : percent >= 65 ? "warn" : "normal";
    const usedLabel = usage.usedTokens.toLocaleString("zh-CN");
    const label = hasLimit
      ? `上下文使用 ${percent}% · 窗口 ${usedLabel} / ${usage.limitTokens.toLocaleString("zh-CN")} tokens`
      : `上下文使用已同步 · 窗口 ${usedLabel} tokens · 模型窗口未知`;

    indicator.style.setProperty("--context-used", `${visiblePercent}%`);
    indicator.dataset.state = stateName;
    indicator.title = detailsAvailable ? `${label}\n点击查看会话负载详情` : label;
    indicator.setAttribute("aria-label", detailsAvailable ? `${label}，点击查看会话负载详情` : label);
    app.refreshContextUsageDetails?.();
    if (hasLimit) app.maybeAutoCompactContext?.(usage, percent);
  };

  app.currentContextUsage = function currentContextUsage() {
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    return app.normalizeContextUsage(session?.contextUsage) || app.latestContextUsageFromEvents(session?.events || []);
  };

  app.latestContextUsageFromEvents = function latestContextUsageFromEvents(events) {
    for (const event of [...(events || [])].reverse()) {
      const raw = event?.raw || {};
      const method = raw.method || event?.type || "";
      if (method !== "thread/tokenUsage/updated" && method !== "context.usage.updated" && method !== "context/usage/updated") continue;
      const params = raw.params && typeof raw.params === "object" ? raw.params : {};
      const usage = app.normalizeContextUsage({
        source: raw.source || params.source || (method === "thread/tokenUsage/updated" ? "codex-app-server" : "backend"),
        at: event.at || "",
        threadId: params.threadId || raw.threadId || "",
        turnId: params.turnId || params.turn?.id || raw.turnId || "",
        tokenUsage: params.tokenUsage,
        usage: params.usage || raw.usage || raw.contextUsage
      });
      if (usage) return usage;
    }
    return null;
  };

  app.normalizeContextUsage = function normalizeContextUsage(value) {
    if (!value || typeof value !== "object") return null;
    const officialUsage =
      value.tokenUsage && typeof value.tokenUsage === "object"
        ? value.tokenUsage
        : value.usage && typeof value.usage === "object"
          ? value.usage
          : value;
    const flatUsage = app.normalizeTokenUsageBreakdown(officialUsage);
    const hasUsage = officialUsage.total || officialUsage.last || flatUsage.totalTokens;
    if (!hasUsage) return null;
    const total = officialUsage.total ? app.normalizeTokenUsageBreakdown(officialUsage.total) : flatUsage;
    const last = officialUsage.last ? app.normalizeTokenUsageBreakdown(officialUsage.last) : flatUsage;
    return {
      source: String(value.source || officialUsage.source || "backend"),
      at: String(value.at || ""),
      threadId: String(value.threadId || ""),
      turnId: String(value.turnId || ""),
      totalTokens: total.totalTokens,
      usedTokens: last.totalTokens,
      inputTokens: last.inputTokens,
      cachedInputTokens: last.cachedInputTokens,
      outputTokens: last.outputTokens,
      reasoningOutputTokens: last.reasoningOutputTokens,
      limitTokens: app.tokenCount(
        officialUsage.modelContextWindow ?? officialUsage.model_context_window ?? officialUsage.contextWindowTokens
      )
    };
  };

  app.normalizeTokenUsageBreakdown = function normalizeTokenUsageBreakdown(value = {}) {
    const usage = value && typeof value === "object" ? value : {};
    return {
      totalTokens: app.tokenCount(usage.totalTokens ?? usage.total_tokens),
      inputTokens: app.tokenCount(usage.inputTokens ?? usage.input_tokens),
      cachedInputTokens: app.tokenCount(
        usage.cachedInputTokens ??
          usage.cached_input_tokens ??
          usage.cacheReadInputTokens ??
          usage.cache_read_input_tokens ??
          usage.cacheCreationInputTokens ??
          usage.cache_creation_input_tokens
      ),
      outputTokens: app.tokenCount(usage.outputTokens ?? usage.output_tokens),
      reasoningOutputTokens: app.tokenCount(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens)
    };
  };

  app.tokenCount = function tokenCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
  };

  app.setTopbarStatus = function setTopbarStatus(label, indicatorState = "idle") {
    const text = String(label || "");
    if (elements.statusText) {
      elements.statusText.textContent = text;
    }
    if (elements.topbarEnvironmentAvatar) {
      elements.topbarEnvironmentAvatar.dataset.state = indicatorState;
    }
    if (elements.mobileStatusIndicator) {
      elements.mobileStatusIndicator.dataset.state = indicatorState;
      elements.mobileStatusIndicator.title = text;
      elements.mobileStatusIndicator.setAttribute("aria-hidden", indicatorState === "online" ? "true" : "false");
      elements.mobileStatusIndicator.setAttribute("aria-label", text);
    }
  };

  app.setTopbarContextTitle = function setTopbarContextTitle(label = "") {
    const selectedProject = String(elements.codexProject?.value || app.storedCodexProjectKey?.() || "").trim();
    const fallback = app.canUseWorkbench?.() || selectedProject ? "等待桌面" : "Echo";
    const text = String(label || "").trim() || fallback;
    state.topbarContextTitle = text;
    if (elements.topbarContextTitle) {
      elements.topbarContextTitle.textContent = app.compactTopbarContextLabel(text);
      elements.topbarContextTitle.title = text;
    }
    if (elements.topbarEnvironmentAvatar) {
      elements.topbarEnvironmentAvatar.textContent = app.topbarContextInitial(text);
      elements.topbarEnvironmentAvatar.title = text;
      elements.topbarEnvironmentAvatar.hidden = !text;
    }
  };

  app.compactTopbarContextLabel = function compactTopbarContextLabel(label = "") {
    const text = String(label || "").trim();
    if (!text) return "";
    const hostLike = /\.local/i.test(text) || /[-_][a-f0-9]{8,}(?:[-_][a-f0-9]{4,})*/i.test(text);
    let compact = text
      .replace(/\.local.*$/i, "")
      .replace(/[-_][a-f0-9]{8,}(?:[-_][a-f0-9]{4,})*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (hostLike || (compact.length > 12 && compact.includes("-"))) return "";
    compact = compact.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    return compact || text;
  };

  app.topbarContextInitial = function topbarContextInitial(label = "") {
    const text = String(label || "").trim() || app.compactTopbarContextLabel(label);
    const match = Array.from(text).find((char) => /[\p{L}\p{N}]/u.test(char));
    return (match || "E").toLocaleUpperCase("zh-CN");
  };

  app.initRuntimeControls = function initRuntimeControls() {
    app.populateRuntimeSelect(elements.codexBackend, backendOptions);
    app.populateRuntimeSelect(elements.codexPermissionMode, permissionOptions);
    app.populateRuntimeSelect(elements.codexModel, modelOptions);
    app.populateRuntimeSelect(elements.codexReasoningEffort, reasoningOptions);
    if (elements.codexMcpProfile) {
      app.populateRuntimeSelect(elements.codexMcpProfile, [{ value: "", label: "桌面默认" }]);
    }
    app.installRuntimeSelectControls();
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    app.refreshRuntimeDefaultOptions();
  };

  app.populateRuntimeSelect = function populateRuntimeSelect(select, options) {
    select.innerHTML = "";
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value;
      node.textContent = option.label;
      node.dataset.baseLabel = option.label;
      select.append(node);
    }
    app.syncRuntimeSelectControl?.(select);
  };

  app.installRuntimeSelectControls = function installRuntimeSelectControls() {
    if (state.runtimeSelectControlsInstalled) return;
    const configs = [
      { select: elements.codexBackend, label: "后端" },
      { select: elements.codexPermissionMode, label: "权限" },
      { select: elements.codexModel, label: "模型" },
      { select: elements.codexReasoningEffort, label: "推理" },
      { select: elements.codexMcpProfile, label: "MCP" }
    ];

    state.runtimeSelectControls = configs
      .map((config) => app.createRuntimeSelectControl(config))
      .filter(Boolean);
    state.runtimeSelectControlsInstalled = true;
    if (document.addEventListener) {
      document.addEventListener("pointerdown", app.handleRuntimeSelectOutsidePointer);
      document.addEventListener("keydown", app.handleRuntimeSelectGlobalKeydown);
    }
    window.addEventListener?.("resize", () => app.closeRuntimeSelectPopover());
  };

  app.createRuntimeSelectControl = function createRuntimeSelectControl({ select, label }) {
    const host = select?.closest?.(".composer-inline-select");
    if (!select || !host || host.querySelector?.(".runtime-select-button")) return null;

    host.removeAttribute("for");
    select.classList.add("runtime-native-select");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "runtime-select-button";
    button.dataset.runtimeSelectFor = select.id || "";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", select.getAttribute("aria-label") || `选择${label}`);
    button.innerHTML = '<span class="runtime-select-button-text"></span>';
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      app.toggleRuntimeSelectPopover(select, button);
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      app.openRuntimeSelectPopover(select, button, { focusSelected: true });
    });
    host.append(button);
    app.syncRuntimeSelectControl(select);
    return { select, button };
  };

  app.refreshRuntimeSelectControls = function refreshRuntimeSelectControls() {
    for (const control of state.runtimeSelectControls || []) {
      app.syncRuntimeSelectControl(control.select);
    }
  };

  app.syncRuntimeSelectControl = function syncRuntimeSelectControl(select) {
    const control = (state.runtimeSelectControls || []).find((item) => item.select === select);
    const button = control?.button || select?.closest?.(".composer-inline-select")?.querySelector?.(".runtime-select-button");
    if (!button || !select) return;
    const selectedOption = app.selectedRuntimeOption(select);
    const text = selectedOption?.textContent || select.value || "默认";
    button.querySelector(".runtime-select-button-text").textContent = text;
    button.disabled = Boolean(select.disabled);
    button.setAttribute("aria-disabled", select.disabled ? "true" : "false");
    button.title = text;
    if (select.disabled && state.runtimeSelectPopover?.select === select) {
      app.closeRuntimeSelectPopover();
      return;
    }
    if (state.runtimeSelectPopover?.select === select) {
      app.renderRuntimeSelectOptions(select, button);
    }
  };

  app.selectedRuntimeOption = function selectedRuntimeOption(select) {
    return (
      Array.from(select?.options || []).find((option) => option.value === select.value) ||
      Array.from(select?.options || [])[0] ||
      null
    );
  };

  app.toggleRuntimeSelectPopover = function toggleRuntimeSelectPopover(select, button) {
    if (state.runtimeSelectPopover?.select === select) {
      app.closeRuntimeSelectPopover();
      return;
    }
    app.openRuntimeSelectPopover(select, button);
  };

  app.openRuntimeSelectPopover = function openRuntimeSelectPopover(select, button, options = {}) {
    if (!select || !button || select.disabled) return;
    const panel = app.runtimeSelectPopoverPanel();
    state.runtimeSelectPopover = { select, button, panel };
    app.renderRuntimeSelectOptions(select, button);
    app.positionRuntimeSelectPopover(select, button, panel);
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (options.focusSelected) {
      window.requestAnimationFrame?.(() => {
        const selected = panel.querySelector(".runtime-select-option.is-selected:not(:disabled)");
        const first = panel.querySelector(".runtime-select-option:not(:disabled)");
        (selected || first)?.focus?.({ preventScroll: true });
      });
    }
  };

  app.runtimeSelectPopoverPanel = function runtimeSelectPopoverPanel() {
    if (state.runtimeSelectPopoverPanel) return state.runtimeSelectPopoverPanel;
    const panel = document.createElement("div");
    panel.className = "runtime-select-popover";
    panel.hidden = true;
    panel.setAttribute("role", "listbox");
    panel.addEventListener("click", app.handleRuntimeSelectOptionClick);
    panel.addEventListener("keydown", app.handleRuntimeSelectOptionKeydown);
    document.body.append(panel);
    state.runtimeSelectPopoverPanel = panel;
    return panel;
  };

  app.renderRuntimeSelectOptions = function renderRuntimeSelectOptions(select, button) {
    const panel = state.runtimeSelectPopoverPanel || app.runtimeSelectPopoverPanel();
    const selectedValue = String(select.value || "");
    const label = button.getAttribute("aria-label") || "选择";
    panel.setAttribute("aria-label", label);
    panel.innerHTML = "";
    for (const option of app.runtimeSelectOptionsForPopover(select)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "runtime-select-option";
      item.dataset.value = option.value;
      item.disabled = Boolean(option.disabled);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", option.value === selectedValue ? "true" : "false");
      item.classList.toggle("is-selected", option.value === selectedValue);
      item.textContent = option.textContent || option.value || "默认";
      panel.append(item);
    }
  };

  app.runtimeSelectOptionsForPopover = function runtimeSelectOptionsForPopover(select) {
    const options = Array.from(select?.options || []);
    if (select?.id === "codexBackend") {
      const concreteOptions = options.filter((option) => String(option.value || "").trim());
      return concreteOptions.length > 0 ? concreteOptions : options;
    }
    if (!["codexModel", "codexPermissionMode", "codexReasoningEffort"].includes(select?.id)) return options;
    const inherited = options.find((option) => !String(option.value || "").trim());
    if (!inherited) return options;
    const inheritedLabel = String(inherited.textContent || "").trim();
    return options.filter((option) => {
      if (option === inherited) return true;
      return String(option.textContent || "").trim() !== inheritedLabel;
    });
  };

  app.positionRuntimeSelectPopover = function positionRuntimeSelectPopover(select, button, panel) {
    const rect = button.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || rect.right;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || rect.bottom;
    const safeGap = 8;
    const width = app.runtimeSelectPopoverWidth(select, rect, viewportWidth, safeGap);
    const left = Math.max(safeGap, Math.min(Math.round(rect.left), Math.max(safeGap, viewportWidth - width - safeGap)));
    const preferBelow = Boolean(select?.closest?.(".quick-skill-form"));
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - safeGap * 2);
    const openBelow = preferBelow && spaceBelow >= 96;
    panel.style.left = `${left}px`;
    panel.style.width = `${width}px`;
    if (openBelow) {
      panel.style.top = `${Math.round(rect.bottom + safeGap)}px`;
      panel.style.maxHeight = `${Math.max(96, Math.round(spaceBelow))}px`;
      panel.style.transform = "none";
      return;
    }
    const maxHeight = Math.max(120, Math.round(rect.top - safeGap * 2));
    panel.style.top = `${Math.max(safeGap, Math.round(rect.top - safeGap))}px`;
    panel.style.maxHeight = `${maxHeight}px`;
    panel.style.transform = "translateY(-100%)";
  };

  app.runtimeSelectPopoverWidth = function runtimeSelectPopoverWidth(select, rect, viewportWidth, safeGap = 8) {
    const maxWidth = Math.max(72, Math.round((viewportWidth || 0) - safeGap * 2));
    const labels = app.runtimeSelectOptionsForPopover(select).map((option) => String(option.textContent || option.value || ""));
    const maxLabelLength = Math.max(0, ...labels.map((label) => label.length));
    const estimatedTextWidth = Math.ceil(Math.min(maxLabelLength, 32) * 7.2 + 48);
    const minPreferred = select?.id === "codexModel" ? 224 : select?.id === "codexBackend" ? 168 : 136;
    const cap = select?.id === "codexModel" ? 292 : 230;
    return Math.min(maxWidth, Math.max(Math.round(rect.width), minPreferred, Math.min(estimatedTextWidth, cap)));
  };

  app.handleRuntimeSelectOptionClick = function handleRuntimeSelectOptionClick(event) {
    event.stopPropagation?.();
    const target = event.target instanceof Element ? event.target : null;
    const item = target?.closest?.(".runtime-select-option");
    if (!item || item.disabled) return;
    app.chooseRuntimeSelectValue(item.dataset.value || "");
  };

  app.handleRuntimeSelectOptionKeydown = function handleRuntimeSelectOptionKeydown(event) {
    const panel = state.runtimeSelectPopover?.panel;
    if (!panel) return;
    if (event.key === "Escape") {
      event.preventDefault();
      const button = state.runtimeSelectPopover?.button;
      app.closeRuntimeSelectPopover();
      button?.focus?.({ preventScroll: true });
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const target = event.target instanceof Element ? event.target : null;
      target?.closest?.(".runtime-select-option")?.click?.();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(panel.querySelectorAll(".runtime-select-option:not(:disabled)"));
    if (items.length === 0) return;
    const current = document.activeElement;
    const index = Math.max(0, items.indexOf(current));
    const nextIndex = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
    items[nextIndex]?.focus?.({ preventScroll: true });
  };

  app.chooseRuntimeSelectValue = function chooseRuntimeSelectValue(value) {
    const popover = state.runtimeSelectPopover;
    const select = popover?.select;
    const button = popover?.button;
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    app.closeRuntimeSelectPopover();
    button?.focus?.({ preventScroll: true });
  };

  app.closeRuntimeSelectPopover = function closeRuntimeSelectPopover() {
    const popover = state.runtimeSelectPopover;
    if (!popover) return;
    popover.button?.setAttribute("aria-expanded", "false");
    if (popover.panel) popover.panel.hidden = true;
    state.runtimeSelectPopover = null;
  };

  app.handleRuntimeSelectOutsidePointer = function handleRuntimeSelectOutsidePointer(event) {
    const popover = state.runtimeSelectPopover;
    const target = event.target instanceof Element ? event.target : null;
    if (!popover || !target) return;
    if (popover.panel?.contains(target) || popover.button?.contains(target)) return;
    app.closeRuntimeSelectPopover();
  };

  app.handleRuntimeSelectGlobalKeydown = function handleRuntimeSelectGlobalKeydown(event) {
    if (event.key !== "Escape" || !state.runtimeSelectPopover) return;
    const button = state.runtimeSelectPopover.button;
    app.closeRuntimeSelectPopover();
    button?.focus?.({ preventScroll: true });
  };

  app.handleRuntimeControlChange = function handleRuntimeControlChange() {
    const requestedBackendId = String(elements.codexBackend.value || "").trim();
    const selectedBackend = app.backendRuntimeById(requestedBackendId) || state.codexAgentRuntime || {};
    const requestedModel = String(elements.codexModel.value || "").trim();
    const requestedPermissionMode = String(elements.codexPermissionMode.value || "").trim();
    const requestedMcpProfileId = String(elements.codexMcpProfile?.value || "").trim();
    const modelSupportedBySelectedBackend = !requestedModel || app.backendRuntimeSupportsModel(selectedBackend, requestedModel);
    const permissionMode = app.normalizePermissionMode(requestedPermissionMode);
    const resolved = app.runtimeChoiceWithFallback(
      {
        backendId: requestedBackendId,
        model: modelSupportedBySelectedBackend ? requestedModel : "",
        permissionMode,
        reasoningEffort: elements.codexReasoningEffort.value,
        mcpProfileId: requestedMcpProfileId,
        worktreeMode: app.requestedWorktreeMode()
      },
      state.runtimePreferences
    );
    resolved.backendId = requestedBackendId || resolved.backendId;
    resolved.model = modelSupportedBySelectedBackend ? requestedModel : "";
    resolved.permissionMode = permissionMode;
    resolved.reasoningEffort = String(elements.codexReasoningEffort.value || "").trim();
    resolved.mcpProfileId = requestedMcpProfileId;
    resolved.worktreeMode = app.requestedWorktreeMode();
    app.applyRuntimeDraft(resolved, { dirty: true });
    app.refreshRuntimeSelectControls();
    if (app.installedAgentSkillsForRuntime) {
      state.installedAgentSkills = app.installedAgentSkillsForRuntime(state.codexAgentRuntime || {});
      app.renderAgentSkills?.();
    }
    app.refreshActiveSessionHeader();
    app.refreshComposerMeta();
  };

  app.applyWorktreeModePreference = function applyWorktreeModePreference(enabled, options = {}) {
    state.worktreePreferenceEnabled = enabled !== false;
    state.runtimeDirty = true;
    state.runtimePreferences = app.currentRuntimeDraft();
    app.writeStoredRuntimePreferences(state.runtimePreferences);
    if (options.persist !== false) app.queueWorkspaceRuntimePreferenceSave?.(state.runtimePreferences);
    app.refreshWorktreeModeControls();
    app.refreshActiveSessionHeader();
    app.refreshComposerMeta();
  };

  app.currentRuntimeDraft = function currentRuntimeDraft() {
    const next = app.resolveRuntimeBackendChoice({
      backendId: elements.codexBackend.value,
      permissionMode: elements.codexPermissionMode.value,
      model: elements.codexModel.value,
      reasoningEffort: elements.codexReasoningEffort.value,
      mcpProfileId: elements.codexMcpProfile?.value || "",
      worktreeMode: app.requestedWorktreeMode()
    });
    const preset = app.permissionRuntimeForMode(next.permissionMode);
    return {
      ...next,
      backendId: next.backendId,
      profile: next.permissionMode || "",
      sandbox: next.permissionMode ? preset.sandbox : "",
      approvalPolicy: next.permissionMode ? preset.approvalPolicy : ""
    };
  };

  app.runtimeChoiceWithFallback = function runtimeChoiceWithFallback(runtime = {}, fallback = state.runtimePreferences) {
    const next = app.resolveRuntimeBackendChoice(runtime, fallback);
    const base = app.resolveRuntimeBackendChoice(fallback, fallback);
    const backendId = next.backendId || base.backendId;
    const permissionMode = next.permissionMode || base.permissionMode;
    const preset = app.permissionRuntimeForMode(permissionMode);
    return {
      backendId,
      permissionMode,
      sandbox: permissionMode ? preset.sandbox : next.sandbox || base.sandbox,
      approvalPolicy: permissionMode ? preset.approvalPolicy : next.approvalPolicy || base.approvalPolicy,
      model: next.model || base.model,
      reasoningEffort: next.reasoningEffort || base.reasoningEffort,
      mcpProfileId: next.mcpProfileId || base.mcpProfileId,
      worktreeMode: next.worktreeMode || base.worktreeMode || app.requestedWorktreeMode()
    };
  };

  app.applyRuntimeDraft = function applyRuntimeDraft(runtime = {}, options = {}) {
    const next = app.resolveRuntimeBackendChoice(runtime);
    app.ensureRuntimeOption(elements.codexBackend, backendOptions, next.backendId, app.backendDisplayName(next.backendId));
    elements.codexBackend.value = next.backendId;
    app.refreshSelectedBackendRuntime(next.backendId);
    app.ensureRuntimeOption(
      elements.codexPermissionMode,
      permissionOptions,
      next.permissionMode,
      app.permissionModeDisplayName(next.permissionMode)
    );
    app.ensureRuntimeOption(
      elements.codexReasoningEffort,
      reasoningOptions,
      next.reasoningEffort,
      app.reasoningDisplayName(next.reasoningEffort)
    );
    app.refreshRuntimeDefaultOptions({ selectedModel: next.model, selectedReasoningEffort: next.reasoningEffort });
    elements.codexPermissionMode.value = next.permissionMode;
    elements.codexModel.value = app.selectHasEnabledOption(elements.codexModel, next.model) ? next.model : "";
    elements.codexReasoningEffort.value = app.selectHasEnabledOption(elements.codexReasoningEffort, next.reasoningEffort)
      ? next.reasoningEffort
      : "";
    next.model = elements.codexModel.value;
    next.reasoningEffort = elements.codexReasoningEffort.value;
    if (elements.codexMcpProfile) {
      app.ensureMcpProfileOption?.(next.mcpProfileId);
      elements.codexMcpProfile.value = app.selectHasEnabledOption(elements.codexMcpProfile, next.mcpProfileId) ? next.mcpProfileId : "";
    }
    app.refreshRuntimeSelectControls();
    if (next.worktreeMode) {
      state.worktreePreferenceEnabled = next.worktreeMode !== "off";
    }
    app.refreshMcpPreferenceSummary?.();
    state.runtimeDirty = Boolean(options.dirty);
    if (options.persist !== false) {
      state.runtimePreferences = next;
      app.writeStoredRuntimePreferences(next);
      if (options.remote !== false) app.queueWorkspaceRuntimePreferenceSave?.(next);
    }
    app.refreshWorktreeModeControls();
  };

  app.refreshRuntimeDefaultOptions = function refreshRuntimeDefaultOptions(options = {}) {
    const backendOption = elements.codexBackend.querySelector('option[value=""]');
    const permissionOption = elements.codexPermissionMode.querySelector('option[value=""]');
    if (backendOption) {
      backendOption.textContent = app.backendDisplayName(
        state.codexAgentRuntime.backendId || state.codexAgentRuntime.provider || state.codexAgentRuntime.backendName || "codex"
      );
      backendOption.dataset.baseLabel = backendOption.textContent;
    }
    if (permissionOption) {
      permissionOption.textContent = state.codexAgentRuntime.permissionMode
        ? app.permissionModeDisplayName(state.codexAgentRuntime.permissionMode)
        : app.permissionModeDisplayName(app.permissionModeFromRuntime(state.codexAgentRuntime)) || "桌面配置";
      permissionOption.dataset.baseLabel = permissionOption.textContent;
    }
    const mcpOption = elements.codexMcpProfile?.querySelector('option[value=""]');
    if (mcpOption) {
      mcpOption.textContent = app.defaultMcpProfileSelectLabel?.() || "桌面默认";
      mcpOption.dataset.baseLabel = mcpOption.textContent;
    }
    for (const backend of state.codexBackendRuntimes || []) {
      app.ensureRuntimeOption(
        elements.codexBackend,
        backendOptions,
        backend.backendId,
        app.backendDisplayName(backend.backendId || backend.provider || backend.backendName || "")
      );
    }
    app.refreshModelOptionAvailability(options.selectedModel);
    const requestedReasoningEffort = String(
      options.selectedReasoningEffort ?? elements.codexReasoningEffort.value ?? ""
    ).trim();
    app.populateRuntimeSelect(
      elements.codexReasoningEffort,
      app.reasoningOptionsForSelectedModel(elements.codexModel.value)
    );
    elements.codexReasoningEffort.value = app.selectHasEnabledOption(elements.codexReasoningEffort, requestedReasoningEffort)
      ? requestedReasoningEffort
      : "";
    const reasoningOption = elements.codexReasoningEffort.querySelector('option[value=""]');
    if (reasoningOption) {
      const defaultReasoningEffort = app.defaultReasoningEffortForSelectedModel(elements.codexModel.value);
      reasoningOption.textContent = defaultReasoningEffort
        ? app.reasoningDisplayName(defaultReasoningEffort)
        : "桌面配置";
      reasoningOption.dataset.baseLabel = reasoningOption.textContent;
    }
    const modelOption = elements.codexModel.querySelector('option[value=""]');
    if (modelOption) {
      modelOption.textContent = state.codexAgentRuntime.model
        ? app.modelDisplayName(state.codexAgentRuntime.model)
        : "桌面配置";
      modelOption.dataset.baseLabel = modelOption.textContent;
    }
    app.refreshPermissionModeAvailability();
    app.refreshRuntimeSelectControls();
  };

  app.refreshModelOptionAvailability = function refreshModelOptionAvailability(selectedModel = undefined) {
    const requestedModel = String(selectedModel ?? elements.codexModel.value ?? "").trim();
    app.populateRuntimeSelect(elements.codexModel, app.modelOptionsForSelectedBackend(requestedModel));
    for (const option of Array.from(elements.codexModel.options || [])) {
      const value = String(option.value || "").trim();
      if (!value) continue;
      const unavailable = app.modelUnavailableAcrossBackends(value);
      const baseLabel = option.dataset.baseLabel || option.textContent;
      option.dataset.baseLabel = baseLabel;
      option.disabled = unavailable;
      option.textContent = unavailable ? `${baseLabel} · 当前桌面不可用` : baseLabel;
    }
    elements.codexModel.value = app.selectHasEnabledOption(elements.codexModel, requestedModel) ? requestedModel : "";
  };

  app.modelOptionsForSelectedBackend = function modelOptionsForSelectedBackend(selectedModel = "") {
    const defaultOption = modelOptions.find((option) => option.value === "") || { value: "", label: "桌面默认" };
    const selectedBackendId = app.selectedRuntimeBackendId();
    const selectedBackend = app.backendRuntimeById(selectedBackendId) || state.codexAgentRuntime || {};
    const catalog = Array.isArray(state.codexModelCatalog) ? state.codexModelCatalog : [];
    const backendModels = selectedBackendId
      ? catalog.filter((model) => {
          return app.modelEntryMatchesBackend(model, selectedBackendId);
        })
      : [];
    const selectedBackendModels = Array.isArray(selectedBackend.supportedModels)
      ? selectedBackend.supportedModels.filter((model) => app.modelEntryMatchesBackend(model, selectedBackendId))
      : [];
    const fallbackModels =
      selectedBackendModels.length > 0
        ? selectedBackendModels
        : backendModels.length > 0
        ? backendModels
        : Array.isArray(state.codexSupportedModels) &&
            state.codexSupportedModels.some((model) => app.modelEntryMatchesBackend(model, selectedBackendId))
          ? state.codexSupportedModels.filter((model) => app.modelEntryMatchesBackend(model, selectedBackendId))
          : !selectedBackendId || selectedBackendId === "codex"
            ? modelOptions
                .filter((option) => option.value)
                .map((option) => ({
                  id: option.value,
                  model: option.value,
                  displayName: option.label,
                  hidden: false,
                  isDefault: option.value === DEFAULT_CODEX_MODEL,
                  backendIds: [selectedBackendId].filter(Boolean),
                  backendNames: [state.codexAgentRuntime.backendName || state.codexAgentRuntime.backendId || ""].filter(Boolean)
                }))
            : [];
    const backendModelOptions = fallbackModels
      .filter((model) => !model.hidden)
      .map((model) => ({
        value: model.id,
        label: app.modelOptionLabel(model, selectedBackendId)
      }));
    const options = [defaultOption, ...backendModelOptions];
    const requestedModel = String(selectedModel || "").trim();
    if (
      requestedModel &&
      !options.some((option) => option.value === requestedModel) &&
      app.backendRuntimeSupportsModel(selectedBackend, requestedModel)
    ) {
      options.push({ value: requestedModel, label: app.modelDisplayName(requestedModel) });
    }
    return app.dedupeRuntimeOptions(options);
  };

  app.reasoningOptionsForSelectedModel = function reasoningOptionsForSelectedModel(selectedModel = "") {
    const selectedBackendId = app.selectedRuntimeBackendId();
    const selectedBackend = app.backendRuntimeById(selectedBackendId) || state.codexAgentRuntime || {};
    const effectiveModel = String(selectedModel || selectedBackend.model || "").trim();
    const model = Array.isArray(selectedBackend.supportedModels)
      ? selectedBackend.supportedModels.find(
          (item) => String(item?.id || item?.model || "").trim() === effectiveModel
        )
      : null;
    const supportedEfforts = new Set(
      Array.isArray(model?.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
            .map((item) => String(item?.reasoningEffort || item?.value || item || "").trim().toLowerCase())
            .filter(Boolean)
        : []
    );
    if (supportedEfforts.size === 0) return reasoningOptions;
    return reasoningOptions.filter((option) => !option.value || supportedEfforts.has(option.value));
  };

  app.defaultReasoningEffortForSelectedModel = function defaultReasoningEffortForSelectedModel(selectedModel = "") {
    const selectedBackendId = app.selectedRuntimeBackendId();
    const selectedBackend = app.backendRuntimeById(selectedBackendId) || state.codexAgentRuntime || {};
    const effectiveModel = String(selectedModel || selectedBackend.model || "").trim();
    const model = Array.isArray(selectedBackend.supportedModels)
      ? selectedBackend.supportedModels.find(
          (item) => String(item?.id || item?.model || "").trim() === effectiveModel
        )
      : null;
    return String(model?.defaultReasoningEffort || model?.default_reasoning_effort || selectedBackend.reasoningEffort || "")
      .trim()
      .toLowerCase();
  };

  app.selectedRuntimeBackendId = function selectedRuntimeBackendId() {
    const selectedValue = String(elements.codexBackend?.value || "").trim();
    if (selectedValue) return selectedValue;
    return String(
      state.codexAgentRuntime.backendId ||
        state.codexAgentRuntime.provider ||
        state.runtimePreferences.backendId ||
        state.runtimePreferences.provider ||
        ""
    ).trim();
  };

  app.modelEntryMatchesBackend = function modelEntryMatchesBackend(model = {}, backendId = "") {
    const normalizedBackendId = String(backendId || "").trim();
    const modelId = String(model.id || model.model || "").trim();
    if (normalizedBackendId === "codex" && modelId && !/^gpt(?:[-.]|$)/i.test(modelId)) return false;
    const backendIds = Array.isArray(model.backendIds)
      ? model.backendIds.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (backendIds.length === 0 || !normalizedBackendId) return true;
    return backendIds.includes(normalizedBackendId);
  };

  app.modelOptionLabel = function modelOptionLabel(model = {}, selectedBackendId = "") {
    const label = String(model.displayName || model.display_name || model.id || model.model || "").trim();
    if (!label) return "";
    const backendIds = Array.isArray(model.backendIds) ? model.backendIds.map((item) => String(item || "").trim()).filter(Boolean) : [];
    const backendNames = Array.isArray(model.backendNames)
      ? model.backendNames.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (backendIds.length === 0) return label;
    if (backendIds.length === 1 && backendIds[0] === selectedBackendId) return label;
    const suffix = backendNames.length > 0 ? backendNames.slice(0, 2).join(" / ") : backendIds.slice(0, 2).join(" / ");
    return suffix ? `${label} · ${suffix}` : label;
  };

  app.dedupeRuntimeOptions = function dedupeRuntimeOptions(options = []) {
    const seen = new Set();
    const result = [];
    for (const option of options || []) {
      const value = String(option?.value || "").trim();
      if (seen.has(value)) continue;
      seen.add(value);
      result.push({
        value,
        label: String(option?.label || option?.displayName || value || "桌面默认").trim() || value
      });
    }
    return result;
  };

  app.refreshPermissionModeAvailability = function refreshPermissionModeAvailability() {
    const supportedModes = new Set(app.supportedPermissionModesForBackend(state.codexAgentRuntime));
    for (const option of Array.from(elements.codexPermissionMode.options || [])) {
      const value = String(option.value || "").trim();
      if (!value) continue;
      const baseLabel = app.permissionModeDisplayName(value);
      option.dataset.baseLabel = baseLabel;
      option.disabled = supportedModes.size > 0 && !supportedModes.has(value);
      option.textContent = baseLabel;
    }
  };

  app.supportedPermissionModesForBackend = function supportedPermissionModesForBackend(backend = {}) {
    const advertised = Array.isArray(backend.supportedPermissionModes)
      ? backend.supportedPermissionModes.map((mode) => app.normalizePermissionMode(mode)).filter(Boolean)
      : [];
    if (advertised.length > 0) return [...new Set(advertised)];
    const identity = `${backend.backendId || ""} ${backend.provider || ""}`.toLowerCase();
    if (/codex|claude|anthropic|deepseek|volcengine/.test(identity)) return ["strict", "approve", "full"];
    return [];
  };

  app.ensureRuntimeOption = function ensureRuntimeOption(select, options, value, fallbackLabel) {
    if (!value) return;
    const known = options.some((option) => option.value === value);
    const existing = Array.from(select.options).find((option) => option.value === value);
    if (known || existing) return;
    const node = document.createElement("option");
    node.value = value;
    node.textContent = fallbackLabel || value;
    node.dataset.baseLabel = node.textContent;
    select.append(node);
  };

  app.selectHasEnabledOption = function selectHasEnabledOption(select, value) {
    const normalized = String(value || "").trim();
    if (!normalized) return true;
    const option = Array.from(select.options || []).find((item) => item.value === normalized);
    return Boolean(option && !option.disabled);
  };

  app.normalizeRuntimeChoice = function normalizeRuntimeChoice(runtime = {}) {
    const knownModelValues = new Set(modelOptions.map((option) => option.value));
    const knownReasoningValues = new Set(reasoningOptions.map((option) => option.value));
    const backendId = String(runtime.backendId || runtime.provider || "").trim();
    const permissionMode = app.normalizePermissionMode(
      runtime.permissionMode || runtime.permissionsMode || runtime.profile || app.permissionModeFromRuntime(runtime)
    );
    const rawModel = String(runtime.model || "").trim();
    const reasoningEffort = String(runtime.reasoningEffort || runtime.effort || "").trim().toLowerCase();
    const mcpProfileId = normalizeStoredMcpProfileId(runtime.mcpProfileId || runtime.mcpProfile || runtime.mcp);
    return {
      backendId,
      permissionMode,
      sandbox: app.normalizeSandboxModeValue(runtime.sandbox),
      approvalPolicy: app.normalizeApprovalPolicyValue(runtime.approvalPolicy),
      model: knownModelValues.has(rawModel) || rawModel ? rawModel : "",
      reasoningEffort: knownReasoningValues.has(reasoningEffort) || reasoningEffort ? reasoningEffort : "",
      mcpProfileId,
      worktreeMode: app.normalizeWorktreeModeValue(runtime.worktreeMode)
    };
  };

  app.writeStoredRuntimePreferences = function writeStoredRuntimePreferences(runtime = {}) {
    const next = app.normalizeRuntimeChoice(runtime);
    const scopeKey = state.runtimePreferenceScopeKey || app.workspaceRuntimePreferenceScope?.()?.key || "";
    if (!scopeKey) return;
    localStorage.setItem(app.workspaceRuntimePreferenceCacheKey(scopeKey), JSON.stringify({
      ...next,
      version: state.runtimePreferenceVersion,
      cachedAt: new Date().toISOString()
    }));
  };

  app.workspaceRuntimePreferenceScope = function workspaceRuntimePreferenceScope() {
    const workspace = app.currentWorkspace?.();
    const targetAgentId = String(workspace?.agentId || app.currentTargetAgentId?.() || "").trim();
    const workspaceId = String(workspace?.id || app.currentProjectId?.() || "").trim();
    if (!targetAgentId || !workspaceId) return null;
    return { targetAgentId, workspaceId, key: `${targetAgentId}:${workspaceId}` };
  };

  app.workspaceRuntimePreferenceCacheKey = function workspaceRuntimePreferenceCacheKey(scopeKey) {
    const userKey = app.storageUserKey?.(state.currentUser) || "local";
    return `echoWorkspaceRuntimePreference:${encodeURIComponent(userKey)}:${encodeURIComponent(scopeKey)}`;
  };

  app.readWorkspaceRuntimePreferenceCache = function readWorkspaceRuntimePreferenceCache(scopeKey) {
    try {
      const value = JSON.parse(localStorage.getItem(app.workspaceRuntimePreferenceCacheKey(scopeKey)) || "null");
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  };

  app.clearLegacyRuntimePreferences = function clearLegacyRuntimePreferences() {
    for (const key of [
      "echoCodexBackendId",
      "echoCodexPermissionMode",
      "echoCodexModel",
      "echoCodexReasoningEffort",
      "echoCodexMcpProfile",
      "echoCodexWorktreeEnabled"
    ]) {
      localStorage.removeItem(key);
    }
    state.runtimeMigrationCandidate = null;
  };

  app.workspaceRuntimePreferencePayload = function workspaceRuntimePreferencePayload(runtime = state.runtimePreferences) {
    const next = app.normalizeRuntimeChoice(runtime);
    return {
      backendId: next.backendId,
      model: next.model,
      reasoningEffort: next.reasoningEffort,
      permissionMode: next.permissionMode || "full",
      worktreeMode: next.worktreeMode === "always" ? "always" : "off",
      mcpProfileId: next.mcpProfileId
    };
  };

  app.applyWorkspaceRuntimePreferenceRecord = function applyWorkspaceRuntimePreferenceRecord(record, scopeKey) {
    if (!record || state.runtimePreferenceScopeKey !== scopeKey) return;
    state.runtimePreferenceVersion = Number(record.version || 0) || 0;
    state.runtimePreferences = app.workspaceRuntimePreferencePayload(record);
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, remote: false, dirty: false });
    app.writeStoredRuntimePreferences(state.runtimePreferences);
  };

  app.loadWorkspaceRuntimePreference = async function loadWorkspaceRuntimePreference(options = {}) {
    const scope = app.workspaceRuntimePreferenceScope();
    if (!scope) return null;
    if (!options.force && state.runtimePreferenceScopeKey === scope.key && state.runtimePreferenceLoadPromise) {
      return state.runtimePreferenceLoadPromise;
    }
    state.runtimePreferenceScopeKey = scope.key;
    state.runtimePreferenceVersion = 0;
    state.runtimePreferenceLoading = true;
    state.runtimePreferenceError = "";
    const query = new URLSearchParams({ targetAgentId: scope.targetAgentId, workspaceId: scope.workspaceId });
    const load = (async () => {
      try {
        let data = await app.apiGet(`/api/codex/runtime-preference?${query.toString()}`);
        if (state.runtimePreferenceScopeKey !== scope.key) return null;
        if (!data.preference) {
          const migrationCandidate = state.runtimeMigrationCandidate;
          const hasLegacyCandidate = migrationCandidate && Object.values(migrationCandidate).some((value) => Boolean(value) && value !== "off");
          const createBody = {
            targetAgentId: scope.targetAgentId,
            workspaceId: scope.workspaceId,
            version: 0,
            ...(hasLegacyCandidate
              ? { migration: true, migrationCandidate: app.workspaceRuntimePreferencePayload(migrationCandidate) }
              : { preference: app.workspaceRuntimePreferencePayload({}) })
          };
          try {
            data = await app.apiPost("/api/codex/runtime-preference", createBody);
          } catch (error) {
            if (!hasLegacyCandidate || !String(error.code || "").startsWith("runtime.")) throw error;
            data = await app.apiPost("/api/codex/runtime-preference", {
              targetAgentId: scope.targetAgentId,
              workspaceId: scope.workspaceId,
              version: 0,
              preference: app.workspaceRuntimePreferencePayload({})
            });
          }
        }
        if (state.runtimePreferenceScopeKey !== scope.key) return data.preference || null;
        app.applyWorkspaceRuntimePreferenceRecord(data.preference, scope.key);
        app.clearLegacyRuntimePreferences();
        const retryPreference = state.runtimePreferenceRetries?.get?.(scope.key);
        if (retryPreference) {
          state.runtimePreferenceRetries.delete(scope.key);
          app.queueWorkspaceRuntimePreferenceSave(retryPreference);
        }
        return data.preference || null;
      } catch (error) {
        if (state.runtimePreferenceScopeKey === scope.key) {
          state.runtimePreferenceError = error.message || "Runtime preference load failed.";
          const cached = app.readWorkspaceRuntimePreferenceCache(scope.key);
          if (cached) app.applyWorkspaceRuntimePreferenceRecord(cached, scope.key);
        }
        throw error;
      } finally {
        if (state.runtimePreferenceScopeKey === scope.key) {
          state.runtimePreferenceLoading = false;
          state.runtimePreferenceLoadPromise = null;
        }
      }
    })();
    state.runtimePreferenceLoadPromise = load;
    return load;
  };

  app.queueWorkspaceRuntimePreferenceSave = function queueWorkspaceRuntimePreferenceSave(runtime = state.runtimePreferences) {
    const scope = app.workspaceRuntimePreferenceScope();
    if (!scope || state.runtimePreferenceScopeKey !== scope.key) return null;
    state.runtimePreferencePendingSave = { scope, preference: app.workspaceRuntimePreferencePayload(runtime) };
    if (state.runtimePreferenceLoading) {
      return state.runtimePreferenceLoadPromise?.then(() => app.queueWorkspaceRuntimePreferenceSave(state.runtimePreferencePendingSave?.preference || runtime));
    }
    if (state.runtimePreferenceSavePromise) return state.runtimePreferenceSavePromise;
    const save = (async () => {
      state.runtimePreferenceSaving = true;
      while (state.runtimePreferencePendingSave) {
        const pending = state.runtimePreferencePendingSave;
        state.runtimePreferencePendingSave = null;
        let version = pending.scope.key === state.runtimePreferenceScopeKey ? state.runtimePreferenceVersion : 0;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const data = await app.apiPost("/api/codex/runtime-preference", {
              targetAgentId: pending.scope.targetAgentId,
              workspaceId: pending.scope.workspaceId,
              version,
              preference: pending.preference
            });
            if (pending.scope.key === state.runtimePreferenceScopeKey) {
              state.runtimePreferenceError = "";
              state.runtimePreferenceRetries?.delete?.(pending.scope.key);
              app.applyWorkspaceRuntimePreferenceRecord(data.preference, pending.scope.key);
            }
            break;
          } catch (error) {
            const latest = error.data?.preference;
            if (error.status === 409 && latest && attempt === 0) {
              version = Number(latest.version || 0) || 0;
              if (pending.scope.key === state.runtimePreferenceScopeKey) state.runtimePreferenceVersion = version;
              continue;
            }
            const errorMessage = error.message || "Runtime preference save failed.";
            if (pending.scope.key === state.runtimePreferenceScopeKey) {
              state.runtimePreferenceError = errorMessage;
              state.runtimePreferencePendingSave = pending;
              app.toast?.(`运行设置保存失败：${errorMessage}`);
            } else {
              state.runtimePreferenceRetries?.set?.(pending.scope.key, pending.preference);
            }
            throw error;
          }
        }
      }
    })().finally(() => {
      state.runtimePreferenceSaving = false;
      state.runtimePreferenceSavePromise = null;
    });
    state.runtimePreferenceSavePromise = save;
    save.catch(() => {});
    return save;
  };

  app.ensureWorkspaceRuntimePreferenceReady = async function ensureWorkspaceRuntimePreferenceReady() {
    if (state.runtimePreferenceLoadPromise) await state.runtimePreferenceLoadPromise;
    if (!state.runtimePreferenceScopeKey) await app.loadWorkspaceRuntimePreference();
    else if (state.runtimePreferenceError) await app.loadWorkspaceRuntimePreference({ force: true });
    if (state.runtimePreferencePendingSave && !state.runtimePreferenceSavePromise) {
      app.queueWorkspaceRuntimePreferenceSave(state.runtimePreferencePendingSave.preference);
    }
    if (state.runtimePreferenceSavePromise) await state.runtimePreferenceSavePromise;
    if (state.runtimePreferenceError) throw new Error(state.runtimePreferenceError);
  };

  app.requestedWorktreeMode = function requestedWorktreeMode() {
    const agentMode = app.normalizeWorktreeModeValue(state.codexAgentRuntime.worktreeMode);
    if (agentMode === "always") return "always";
    if (agentMode === "optional") return state.worktreePreferenceEnabled ? "always" : "off";
    return "off";
  };

  app.refreshWorktreeModeControls = function refreshWorktreeModeControls() {
    const toggle = elements.worktreeModeToggle;
    if (!toggle) return;
    const agentMode = app.normalizeWorktreeModeValue(state.codexAgentRuntime.worktreeMode);
    const workspacePolicy = state.codexAgentRuntime?.capabilities?.worktreeByWorkspace?.[app.currentProjectId?.() || ""];
    const workspaceAvailability = String(workspacePolicy?.availability || "").trim().toLowerCase();
    const forced = agentMode === "always" && workspaceAvailability !== "disabled" && workspaceAvailability !== "unavailable";
    const available = (forced || agentMode === "optional") && workspaceAvailability !== "disabled" && workspaceAvailability !== "unavailable";
    const checked = forced || (available && state.worktreePreferenceEnabled);
    toggle.checked = checked;
    toggle.disabled = !available || forced;
    toggle.setAttribute("aria-checked", checked ? "true" : "false");
    if (elements.worktreeModeSubtitle) {
      elements.worktreeModeSubtitle.textContent = forced
        ? "桌面端强制开启"
        : available
          ? checked
            ? "修改任务建议隔离；只读任务可关闭"
            : "只读任务用主工作区；修改任务建议开启"
          : "桌面端未启用";
    }
  };

  app.workspaceLabel = function workspaceLabel(workspace) {
    const label = workspace?.label || workspace?.workspaceId || workspace?.id || workspace?.path || "未命名项目";
    return workspace?.agentLabel ? `${label} · ${workspace.agentLabel}` : label;
  };

  app.workspaceMeta = function workspaceMeta(workspace) {
    return workspace?.path || workspace?.id || "桌面端已同步";
  };

  app.workspaceSecondaryLabel = function workspaceSecondaryLabel(workspace) {
    if (workspace?.agentLabel) return workspace.agentLabel;
    if (!workspace?.id) return "";
    return workspace.label && workspace.label !== workspace.id ? workspace.id : "";
  };

  app.workspacePathLabel = function workspacePathLabel(workspace) {
    if (!workspace?.path) return "";
    return workspace.path !== workspace.id ? workspace.path : "";
  };

  app.workspaceDirectoryName = function workspaceDirectoryName(workspace) {
    const pathLabel = String(workspace?.path || "").trim().replace(/[/\\]+$/g, "");
    const directoryName = pathLabel.split(/[/\\]/).filter(Boolean).pop();
    const label = String(workspace?.label || "").trim();
    if (label && app.looksLikeWorktreeDirectoryName(directoryName)) return label;
    return directoryName || label || workspace?.id || "未命名工程";
  };

  app.looksLikeWorktreeDirectoryName = function looksLikeWorktreeDirectoryName(value) {
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(value || ""));
  };

  app.refreshProjectSwitcherVisibility = function refreshProjectSwitcherVisibility() {
    if (!elements.projectSwitcher) return;
    elements.projectSwitcher.hidden = !app.canUseWorkbench?.();
  };

  app.refreshTopbarProjectChip = function refreshTopbarProjectChip() {
    app.refreshProjectSwitcherVisibility();
    const workspace = app.currentWorkspace?.();
    const agent =
      app.agentById?.(state.selectedAgentId) ||
      app.agentById?.(workspace?.agentId) ||
      null;
    const title =
      app.agentDisplayName?.(agent) ||
      workspace?.agentLabel ||
      (workspace ? app.workspaceDirectoryName?.(workspace) : "") ||
      "";
    app.setTopbarContextTitle(title);
  };

  app.formatRelativeTime = function formatRelativeTime(value) {
    if (!value) return "刚刚";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚";
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return "刚刚";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  };

  app.formatMessageTime = function formatMessageTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  };

  app.sessionProjectLabel = function sessionProjectLabel(projectId, targetAgentId = "") {
    const normalizedProjectId = String(projectId || "").trim();
    if (!normalizedProjectId) return "未选择工程";
    const normalizedTargetAgentId = String(targetAgentId || "").trim();
    const workspace = state.codexWorkspaces.find(
      (item) =>
        (item.id === normalizedProjectId || item.workspaceId === normalizedProjectId) &&
        (!normalizedTargetAgentId || item.agentId === normalizedTargetAgentId)
    );
    return app.workspaceLabel(
      workspace ||
        state.codexWorkspaces.find((item) => item.id === normalizedProjectId || item.workspaceId === normalizedProjectId) ||
        { id: normalizedProjectId }
    );
  };

  app.currentWorkspace = function currentWorkspace() {
    const key = String(elements.codexProject?.value || app.storedCodexProjectKey?.() || "").trim();
    return (
      app.workspaceForSelectionKey?.(key) ||
      (Array.isArray(state.codexWorkspaces) ? state.codexWorkspaces : []).find((workspace) => {
        const workspaceId = String(workspace?.id || workspace?.workspaceId || "").trim();
        const agentId = String(workspace?.agentId || "").trim();
        return key === workspaceId || (agentId && key === `${agentId}:${workspaceId}`);
      }) ||
      null
    );
  };

  app.currentProjectId = function currentProjectId() {
    return String(app.currentWorkspace()?.id || state.selectedCodexSession?.projectId || "").trim();
  };

  app.currentTargetAgentId = function currentTargetAgentId() {
    return String(app.currentWorkspace()?.agentId || state.selectedAgentId || state.selectedCodexSession?.targetAgentId || "").trim();
  };

  app.sessionBelongsToCurrentProject = function sessionBelongsToCurrentProject(session) {
    const projectId = app.currentProjectId();
    const targetAgentId = app.currentTargetAgentId();
    return Boolean(
      session?.id &&
        projectId &&
        session.projectId === projectId &&
        (!targetAgentId || !session.targetAgentId || session.targetAgentId === targetAgentId)
    );
  };

  app.sessionRuntimeLabel = function sessionRuntimeLabel(runtime = {}) {
    const normalized = app.normalizeRuntimeChoice(runtime);
    const parts = [];
    if (normalized.backendId) parts.push(app.backendDisplayName(normalized.backendId));
    if (normalized.permissionMode) parts.push(app.permissionModeDisplayName(normalized.permissionMode, app.runtimeWithBackendDefaults(normalized)));
    if (normalized.model) parts.push(app.modelDisplayName(normalized.model));
    if (normalized.reasoningEffort) parts.push(`推理 ${app.reasoningDisplayName(normalized.reasoningEffort)}`);
    if (normalized.mcpProfileId) parts.push(`MCP ${app.mcpProfileDisplayName?.(normalized.mcpProfileId) || normalized.mcpProfileId}`);
    if (normalized.worktreeMode === "always") parts.push("隔离 worktree");
    return parts.join(" · ");
  };

  app.compactBackendDisplayName = function compactBackendDisplayName(value) {
    const normalized = String(value || "").trim();
    if (!normalized) return "";
    if (/^claude(?:[- ]code)?$/i.test(normalized)) return "Claude";
    if (/^codex$/i.test(normalized)) return "Codex";
    return normalized;
  };

  app.backendProviderDisplayName = function backendProviderDisplayName(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "deepseek-via-claude") return "DeepSeek";
    if (normalized === "volcengine-coding-plan") return "Volcengine Coding Plan";
    return "";
  };

  app.backendDisplayName = function backendDisplayName(value) {
    const normalized = String(value || "").trim();
    const backend =
      state.codexBackendRuntimes.find(
        (item) => item.backendId === normalized || item.provider === normalized || item.backendName === normalized
      ) || null;
    const backendName = String(backend?.backendName || normalized).trim();
    const compacted = app.compactBackendDisplayName(backendName);
    if (!backend) return compacted;
    const providerLabel = app.backendProviderDisplayName(backend.provider || backend.backendId || "");
    if (!providerLabel || compacted !== "Claude") return compacted;
    return `${compacted} · ${providerLabel}`;
  };

  app.activeAgentLabel = function activeAgentLabel(session = null) {
    const runtime = app.runtimeForSession(session);
    return app.backendDisplayName(runtime.backendId || runtime.provider || runtime.backendName || runtime.name || "") || "agent";
  };

  app.normalizePermissionMode = function normalizePermissionMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "readonly" || normalized === "read-only" || normalized === "suggest") return "strict";
    if (
      normalized === "approve" ||
      normalized === "approved" ||
      normalized === "auto" ||
      normalized === "auto-edit" ||
      normalized === "acceptedits" ||
      normalized === "default"
    ) {
      return "approve";
    }
    if (
      normalized === "full" ||
      normalized === "full-auto" ||
      normalized === "fullaccess" ||
      normalized === "bypasspermissions" ||
      normalized === "dontask"
    ) {
      return "full";
    }
    if (normalized === "plan") return "strict";
    return permissionOptions.some((option) => option.value === normalized) ? normalized : "";
  };

  app.permissionModeFromRuntime = function permissionModeFromRuntime(runtime = {}) {
    const sandbox = app.normalizeSandboxModeValue(runtime.sandbox);
    if (sandbox === "read-only") return "strict";
    if (sandbox === "danger-full-access") return "full";
    if (sandbox === "workspace-write") return "approve";
    return "";
  };

  app.permissionRuntimeForMode = function permissionRuntimeForMode(mode) {
    const normalized = app.normalizePermissionMode(mode);
    if (normalized === "strict") return { sandbox: "read-only", approvalPolicy: "on-request" };
    if (normalized === "full") return { sandbox: "danger-full-access", approvalPolicy: "never" };
    if (normalized === "approve") return { sandbox: "workspace-write", approvalPolicy: "on-request" };
    return { sandbox: "", approvalPolicy: "" };
  };

  app.normalizeSandboxModeValue = function normalizeSandboxModeValue(value) {
    const normalized = String(value || "").trim();
    if (normalized === "workspaceWrite") return "workspace-write";
    if (normalized === "dangerFullAccess") return "danger-full-access";
    if (normalized === "readOnly") return "read-only";
    return normalized;
  };

  app.normalizeApprovalPolicyValue = function normalizeApprovalPolicyValue(value) {
    return String(value || "").trim().toLowerCase();
  };

  app.normalizeWorktreeModeValue = function normalizeWorktreeModeValue(value) {
    const mode = String(value || "").trim().toLowerCase();
    return ["off", "optional", "always"].includes(mode) ? mode : "";
  };

  app.permissionModeDisplayName = function permissionModeDisplayName(value, runtime = state.codexAgentRuntime) {
    const normalized = app.normalizePermissionMode(value);
    if (app.isClaudeRuntime(runtime)) {
      if (normalized === "strict") return "计划";
      if (normalized === "approve") return "接受编辑";
      if (normalized === "full") return "跳过权限";
    }
    return permissionOptions.find((option) => option.value === normalized)?.label || normalized;
  };

  app.modelDisplayName = function modelDisplayName(value) {
    const normalized = String(value || "").trim();
    return (
      state.codexSupportedModels.find((model) => model.id === normalized)?.displayName ||
      state.codexModelCatalog.find((model) => model.id === normalized)?.displayName ||
      modelOptions.find((option) => option.value === normalized)?.label ||
      normalized
    );
  };

  app.modelRequiresNewerCodex = function modelRequiresNewerCodex(value) {
    return app.modelUnavailableAcrossBackends(value);
  };

  app.modelUnavailableAcrossBackends = function modelUnavailableAcrossBackends(value) {
    const model = String(value || "").trim();
    if (!model) return false;
    const backends = Array.isArray(state.codexBackendRuntimes) ? state.codexBackendRuntimes : [];
    if (backends.some((backend) => app.backendRuntimeSupportsModel(backend, model))) return false;
    if ((state.codexModelCatalog || []).some((item) => item.id === model || item.model === model)) return false;
    const unsupportedByAnyBackend = backends.some((backend) =>
      Array.isArray(backend.unsupportedModels) &&
      backend.unsupportedModels.map((item) => String(item || "").trim()).includes(model)
    );
    if (unsupportedByAnyBackend || state.codexUnsupportedModels.includes(model)) return true;
    return backends.length > 0 && backends.every((backend) => Array.isArray(backend.supportedModels) && backend.supportedModels.length > 0);
  };

  app.permissionModeUnavailable = function permissionModeUnavailable(value) {
    const raw = String(value || "").trim();
    const mode = app.normalizePermissionMode(value);
    return Boolean(raw && !mode);
  };

  app.refreshModelCatalog = function refreshModelCatalog() {
    const backends = Array.isArray(state.codexBackendRuntimes) ? state.codexBackendRuntimes : [];
    const byId = new Map();
    const selectedBackendId = String(state.codexAgentRuntime.backendId || state.runtimePreferences.backendId || "").trim();

    const mergeModel = (model = {}, backend = {}) => {
      const id = String(model.id || model.model || "").trim();
      if (!id) return;
      const backendId = String(backend.backendId || backend.provider || "").trim();
      const backendName = app.backendDisplayName(backendId || backend.provider || backend.backendName || backend.name || "") || backendId;
      const existing = byId.get(id) || {
        id,
        model: String(model.model || id).trim() || id,
        displayName: String(model.displayName || model.display_name || id).trim() || id,
        description: String(model.description || "").trim(),
        hidden: Boolean(model.hidden),
        isDefault: Boolean(model.isDefault || model.is_default),
        inputModalities: Array.isArray(model.inputModalities)
          ? model.inputModalities.map((item) => String(item || "").trim()).filter(Boolean)
          : [],
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
              .map((item) => String(item?.reasoningEffort || item?.value || item || "").trim().toLowerCase())
              .filter(Boolean)
          : [],
        defaultReasoningEffort: String(model.defaultReasoningEffort || model.default_reasoning_effort || "").trim().toLowerCase(),
        backendIds: [],
        backendNames: []
      };
      const backendIds = new Set([...(existing.backendIds || []), ...(backendId ? [backendId] : [])]);
      const backendNames = new Set([...(existing.backendNames || []), ...(backendName ? [backendName] : [])]);
      byId.set(id, {
        ...existing,
        model: String(existing.model || model.model || id).trim() || id,
        displayName: String(model.displayName || model.display_name || existing.displayName || id).trim() || id,
        description: String(model.description || existing.description || "").trim(),
        hidden: Boolean(existing.hidden && model.hidden),
        isDefault: Boolean(existing.isDefault || model.isDefault || model.is_default),
        inputModalities: Array.from(
          new Set([
            ...(existing.inputModalities || []),
            ...(Array.isArray(model.inputModalities)
              ? model.inputModalities.map((item) => String(item || "").trim()).filter(Boolean)
              : [])
          ])
        ),
        supportedReasoningEfforts: Array.from(
          new Set([
            ...(existing.supportedReasoningEfforts || []),
            ...(Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts
                  .map((item) => String(item?.reasoningEffort || item?.value || item || "").trim().toLowerCase())
                  .filter(Boolean)
              : [])
          ])
        ),
        defaultReasoningEffort:
          existing.defaultReasoningEffort || String(model.defaultReasoningEffort || model.default_reasoning_effort || "").trim().toLowerCase(),
        backendIds: Array.from(backendIds),
        backendNames: Array.from(backendNames)
      });
    };

    for (const backend of backends) {
      for (const model of Array.isArray(backend.supportedModels) ? backend.supportedModels : []) {
        mergeModel(model, backend);
      }
    }

    const catalog = Array.from(byId.values());
    catalog.sort((left, right) => {
      const leftCurrent = left.backendIds.includes(selectedBackendId) ? 0 : 1;
      const rightCurrent = right.backendIds.includes(selectedBackendId) ? 0 : 1;
      if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return String(left.displayName || left.id).localeCompare(String(right.displayName || right.id), "zh-Hans-CN");
    });
    state.codexModelCatalog = catalog;
  };

  app.backendRuntimeForModel = function backendRuntimeForModel(model = "", preferredBackendId = "") {
    const normalizedModel = String(model || "").trim();
    const preferred = app.backendRuntimeById(preferredBackendId);
    if (!normalizedModel) return preferred || null;
    const backends = Array.isArray(state.codexBackendRuntimes) ? state.codexBackendRuntimes : [];
    if (app.backendRuntimeSupportsModel(preferred, normalizedModel)) {
      return preferred;
    }
    const matched = backends.find((backend) => app.backendRuntimeSupportsModel(backend, normalizedModel)) || null;
    return matched || preferred || null;
  };

  app.backendRuntimeSupportsModel = function backendRuntimeSupportsModel(backend = {}, model = "") {
    const normalizedModel = String(model || "").trim();
    return Boolean(
      normalizedModel &&
        backend &&
        Array.isArray(backend.supportedModels) &&
        backend.supportedModels.some((item) => String(item?.id || item?.model || "").trim() === normalizedModel)
    );
  };

  app.resolveRuntimeBackendChoice = function resolveRuntimeBackendChoice(runtime = {}, fallback = state.runtimePreferences) {
    const requested = app.normalizeRuntimeChoice(runtime);
    const base = app.normalizeRuntimeChoice(fallback);
    const preferredBackendId =
      requested.backendId || base.backendId || state.runtimePreferences.backendId || state.codexAgentRuntime.backendId || "";
    const matchedBackend = app.backendRuntimeForModel(requested.model, preferredBackendId);
    const currentAgentRuntime =
      app.backendRuntimeById(state.codexAgentRuntime.backendId || state.codexAgentRuntime.provider || state.codexAgentRuntime.backendName) ||
      (state.codexBackendRuntimes.length > 0 ? null : state.codexAgentRuntime);
    const preferredBackend = app.backendRuntimeById(preferredBackendId);
    const selected = preferredBackend || (!preferredBackendId ? matchedBackend : null) || currentAgentRuntime || state.codexBackendRuntimes[0] || {};
    return {
      ...requested,
      backendId: String(selected.backendId || preferredBackendId || requested.backendId || "").trim(),
      backendName: String(selected.backendName || requested.backendName || "").trim(),
      provider: String(selected.provider || requested.provider || "").trim()
    };
  };

  app.refreshSelectedBackendRuntime = function refreshSelectedBackendRuntime(backendId) {
    const normalized = String(backendId || "").trim();
    const selectedRaw =
      state.codexBackendRuntimes.find((backend) => backend.backendId === normalized || backend.provider === normalized) ||
      state.codexBackendRuntimes[0] ||
      {};
    const selected = {
      ...selectedRaw,
      permissionMode: app.normalizePermissionMode(
        selectedRaw.permissionMode || selectedRaw.permissionsMode || selectedRaw.profile || app.permissionModeFromRuntime(selectedRaw)
      )
    };
    state.codexAgentRuntime = selected;
    state.codexUnsupportedModels = Array.isArray(selected.unsupportedModels)
      ? selected.unsupportedModels.map((model) => String(model || "").trim()).filter(Boolean)
      : [];
    state.codexSupportedModels = Array.isArray(selected.supportedModels)
      ? selected.supportedModels
          .map((model) => ({
            id: String(model?.id || model?.model || "").trim(),
            displayName: String(model?.displayName || model?.display_name || model?.id || model?.model || "").trim(),
            hidden: Boolean(model?.hidden)
          }))
          .filter((model) => model.id)
      : [];
    state.codexAllowedPermissionModes = Array.isArray(selected.allowedPermissionModes)
      ? selected.allowedPermissionModes.map((mode) => app.normalizePermissionMode(mode)).filter(Boolean)
      : [];
    state.codexSupportedPermissionModes = app.supportedPermissionModesForBackend(selected);
    app.refreshPermissionModeAvailability();
    app.refreshModelCatalog();
  };

  app.backendRuntimeById = function backendRuntimeById(value = "") {
    const normalized = String(value || "").trim();
    if (!normalized) return null;
    return (
      (state.codexBackendRuntimes || []).find(
        (backend) => backend?.backendId === normalized || backend?.provider === normalized || backend?.backendName === normalized
      ) || null
    );
  };

  app.runtimeWithBackendDefaults = function runtimeWithBackendDefaults(runtime = {}) {
    const source = runtime && typeof runtime === "object" ? runtime : {};
    const backendChoice = app.resolveRuntimeBackendChoice(source, state.runtimePreferences);
    const backend =
      app.backendRuntimeById(backendChoice.backendId || source.backendId || source.provider) ||
      app.backendRuntimeForModel(backendChoice.model, backendChoice.backendId) ||
      app.backendRuntimeById(state.runtimePreferences.backendId) ||
      state.codexAgentRuntime ||
      {};
    const sourcePermissionMode = app.normalizePermissionMode(
      source.permissionMode || source.permissionsMode || source.profile || app.permissionModeFromRuntime(source)
    );
    const backendPermissionMode = app.normalizePermissionMode(
      backend.permissionMode || backend.permissionsMode || backend.profile || app.permissionModeFromRuntime(backend)
    );
    const permissionMode = sourcePermissionMode || backendPermissionMode;
    const permissionPreset = app.permissionRuntimeForMode(permissionMode);
    return {
      ...backend,
      ...source,
      backendId: backend.backendId || backendChoice.backendId || source.backendId || source.provider || "",
      provider: backend.provider || backendChoice.provider || source.provider || source.backendId || "",
      backendName: backend.backendName || backendChoice.backendName || source.backendName || backend.name || "",
      permissionMode,
      profile: permissionMode,
      sandbox: source.sandbox || permissionPreset.sandbox || backend.sandbox || "",
      approvalPolicy: source.approvalPolicy || permissionPreset.approvalPolicy || backend.approvalPolicy || "",
      capabilities: source.capabilities || backend.capabilities,
      unsupportedFeatures: source.unsupportedFeatures || backend.unsupportedFeatures || backend.capabilities?.unsupportedFeatures
    };
  };

  app.currentBackendRuntime = function currentBackendRuntime() {
    const draft = typeof app.currentRuntimeDraft === "function" ? app.currentRuntimeDraft() : state.runtimePreferences || {};
    return app.runtimeWithBackendDefaults(draft);
  };

  app.runtimeForSession = function runtimeForSession(session = null) {
    if (session?.runtime && typeof session.runtime === "object") return app.runtimeWithBackendDefaults(session.runtime);
    return app.currentBackendRuntime();
  };

  app.runtimeSupports = function runtimeSupports(runtime = {}, feature = "") {
    const key = String(feature || "").trim();
    if (!key) return false;
    const source = runtime && typeof runtime === "object" ? runtime : {};
    const supports = source.capabilities?.supports && typeof source.capabilities.supports === "object" ? source.capabilities.supports : {};
    if (typeof supports[key] === "boolean") return supports[key];

    const legacyKey = {
      attachments: "supportsAttachments",
      compaction: "supportsCompaction",
      contextUsage: "supportsContextUsage",
      approvalRequests: "supportsApprovalRequests",
      interactionRequests: "supportsInteractionRequests",
      worktree: "supportsWorktree",
      gitSummary: "supportsGitSummary",
      threadArchive: "supportsThreadArchive"
    }[key];
    if (legacyKey && typeof source[legacyKey] === "boolean") return source[legacyKey];

    if (key === "text" || key === "cancellation") return true;
    if (
      app.isCodexRuntime(source) &&
      [
        "attachments",
        "compaction",
        "contextUsage",
        "approvalRequests",
        "interactionRequests",
        "gitSummary",
        "worktree",
        "threadArchive"
      ].includes(key)
    ) {
      return true;
    }
    return false;
  };

  app.currentBackendSupports = function currentBackendSupports(feature) {
    return app.runtimeSupports(app.currentBackendRuntime(), feature);
  };

  app.sessionBackendSupports = function sessionBackendSupports(session, feature) {
    return app.runtimeSupports(app.runtimeForSession(session), feature);
  };

  app.currentBackendRunsPlanOnly = function currentBackendRunsPlanOnly(runtime = app.currentBackendRuntime()) {
    const resolved = app.runtimeWithBackendDefaults(runtime);
    if (!app.isClaudeRuntime(resolved)) return false;

    const explicitMode = app.normalizePermissionMode(resolved.permissionMode || resolved.profile || app.permissionModeFromRuntime(resolved));
    if (explicitMode === "strict") return true;
    if (explicitMode === "approve" || explicitMode === "full") return false;

    return app.normalizeSandboxModeValue(resolved.sandbox) === "read-only";
  };

  app.isCodexRuntime = function isCodexRuntime(runtime = {}) {
    const label = `${runtime.backendId || ""} ${runtime.provider || ""} ${runtime.backendName || ""}`;
    return /\bcodex\b/i.test(label);
  };

  app.isClaudeRuntime = function isClaudeRuntime(runtime = {}) {
    const label = `${runtime.backendId || ""} ${runtime.provider || ""} ${runtime.backendName || ""}`;
    return /\bclaude\b/i.test(label);
  };

  app.modelSupportsImages = function modelSupportsImages(value) {
    return app.currentBackendSupports("attachments");
  };

  app.runtimeForAttachments = function runtimeForAttachments(runtime = {}, attachments = []) {
    if (!Array.isArray(attachments) || attachments.length === 0) return runtime;
    if (!app.runtimeSupports(app.runtimeWithBackendDefaults(runtime), "attachments")) {
      throw new Error("当前后端暂不支持文件附件。");
    }
    return runtime;
  };

  app.reasoningDisplayName = function reasoningDisplayName(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return reasoningOptions.find((option) => option.value === normalized)?.label || normalized;
  };

  app.humanizeCodexError = function humanizeCodexError(error) {
    const text = String(error || "").trim();
    if (!text) return "";
    if (/requires a newer version of Codex|Please upgrade to the latest app or CLI/i.test(text)) {
      return `${text}\n\n处理方式：在桌面端设置里把当前 backend 模型固定为 CLI 支持的模型，或升级对应 CLI。`;
    }
    if (/ENOENT|No such file or directory/i.test(text)) {
      return `${text}\n\n处理方式：检查桌面端 backend command，必要时填入命令的绝对路径。`;
    }
    return text;
  };

  app.isAuthError = function isAuthError(error) {
    return error.status === 401 || error.code === "SESSION_REQUIRED" || error.code === "PAIRING_REQUIRED";
  };

  app.authHeaders = function authHeaders() {
    return {
      ...app.sessionHeaders(),
      ...(state.token ? { "X-Echo-Token": state.token } : {})
    };
  };

  app.sessionHeaders = function sessionHeaders() {
    return state.authEnabled && state.sessionToken ? { Authorization: `Bearer ${state.sessionToken}` } : {};
  };

  app.ensureLoggedIn = function ensureLoggedIn() {
    if (app.isLoggedIn()) return true;
    app.updateAuthView("请先登录。");
    elements.loginUsername.focus({ preventScroll: true });
    return false;
  };

  app.requiresPairing = function requiresPairing() {
    return state.authEnabled === false;
  };

  app.canUseWorkbench = function canUseWorkbench() {
    return app.isLoggedIn() && (!app.requiresPairing() || Boolean(state.token));
  };

  app.ensurePaired = function ensurePaired() {
    if (!app.ensureLoggedIn()) return false;
    if (!app.requiresPairing()) return true;
    if (state.token) return true;
    app.updateAuthView("请先扫码配对。");
    app.showPairingPanel({ focus: true });
    return false;
  };

  app.apiGet = async function apiGet(path) {
    const response = await fetch(path, { headers: app.authHeaders() });
    return app.parseApiResponse(response);
  };

  app.apiPost = async function apiPost(path, body, options = {}) {
    const controller = options.timeoutMs ? new AbortController() : null;
    const timeout = controller
      ? window.setTimeout(() => {
          controller.abort();
        }, options.timeoutMs)
      : null;
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...app.authHeaders()
        },
        body: JSON.stringify(body),
        signal: controller?.signal
      });
      return app.parseApiResponse(response);
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("请求超时");
      }
      throw error;
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }
  };

  app.parseApiResponse = async function parseApiResponse(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = data.code || "";
      error.data = data;
      throw error;
    }
    return data;
  };

  app.toast = function toast(message) {
    const existing = document.querySelector(".toast");
    if (existing) existing.remove();

    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    document.body.append(node);
    window.setTimeout(() => node.remove(), 2600);
  };

  app.confirm = function confirm(options = {}) {
    const title = String(options.title || "确认操作");
    const body = String(options.body || "");
    const confirmLabel = String(options.confirmLabel || "确认");
    const cancelLabel = String(options.cancelLabel || "取消");
    const tone = options.tone === "danger" ? "danger" : "";
    const previousFocus = document.activeElement;
    const existing = document.querySelector(".echo-confirm");
    if (typeof state.confirmDismiss === "function") state.confirmDismiss(false);
    if (existing) existing.remove();

    return new Promise((resolve) => {
      let settled = false;
      const overlay = document.createElement("div");
      overlay.className = `echo-confirm${tone ? ` ${tone}` : ""}`;
      overlay.setAttribute("role", "presentation");
      overlay.innerHTML = `
        <section class="echo-confirm-panel" role="dialog" aria-modal="true" aria-labelledby="echoConfirmTitle" aria-describedby="echoConfirmBody">
          <div class="echo-confirm-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M12 4.2 20.2 19a1 1 0 0 1-.9 1.5H4.7a1 1 0 0 1-.9-1.5L12 4.2Z"
                fill="none"
                stroke="currentColor"
                stroke-linejoin="round"
                stroke-width="1.8"
              />
              <path d="M12 9v5M12 17.2h.01" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.9" />
            </svg>
          </div>
          <div class="echo-confirm-copy">
            <strong id="echoConfirmTitle">${app.escapeHtml(title)}</strong>
            ${body ? `<p id="echoConfirmBody">${app.escapeHtml(body)}</p>` : `<p id="echoConfirmBody"></p>`}
          </div>
          <div class="echo-confirm-actions">
            <button class="secondary echo-confirm-cancel" type="button">${app.escapeHtml(cancelLabel)}</button>
            <button class="primary echo-confirm-accept" type="button">${app.escapeHtml(confirmLabel)}</button>
          </div>
        </section>
      `;
      const panel = overlay.querySelector(".echo-confirm-panel");
      const cancelButton = overlay.querySelector(".echo-confirm-cancel");
      const acceptButton = overlay.querySelector(".echo-confirm-accept");

      function finish(value) {
        if (settled) return;
        settled = true;
        overlay.removeEventListener("click", handleOverlayClick);
        overlay.removeEventListener("keydown", handleKeydown);
        overlay.remove();
        if (state.confirmDismiss === finish) state.confirmDismiss = null;
        document.body.classList.remove("confirm-open");
        if (previousFocus?.focus) previousFocus.focus({ preventScroll: true });
        resolve(value);
      }

      function handleOverlayClick(event) {
        if (event.target === overlay) finish(false);
      }

      function handleKeydown(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = [cancelButton, acceptButton].filter(Boolean);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }

      overlay.addEventListener("click", handleOverlayClick);
      overlay.addEventListener("keydown", handleKeydown);
      cancelButton?.addEventListener("click", () => finish(false));
      acceptButton?.addEventListener("click", () => finish(true));
      state.confirmDismiss = finish;
      document.body.append(overlay);
      document.body.classList.add("confirm-open");
      panel?.animate?.([{ transform: "translateY(8px)", opacity: 0 }, { transform: "translateY(0)", opacity: 1 }], {
        duration: 180,
        easing: "cubic-bezier(0.16, 1, 0.3, 1)"
      });
      cancelButton?.focus({ preventScroll: true });
    });
  };

  app.escapeHtml = function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  };
}

function readStoredUser(localStorageRef) {
  try {
    return JSON.parse(localStorageRef.getItem("echoUser") || "null");
  } catch {
    return null;
  }
}

function readStoredEchoToken(localStorageRef, user = null, options = {}) {
  const scoped = localStorageRef.getItem(scopedStorageKey("echoToken", user));
  if (scoped) return scoped;
  return options.fallbackLegacy === false ? "" : localStorageRef.getItem("echoToken") || "";
}

function readStoredSelectedAgentId(localStorageRef, user = null, options = {}) {
  const scoped = localStorageRef.getItem(scopedStorageKey("echoSelectedAgent", user));
  if (scoped) return String(scoped || "").trim();
  const fallbackLegacy = options.fallbackLegacy ?? !normalizeStorageUserKey(user);
  return fallbackLegacy ? String(localStorageRef.getItem("echoSelectedAgent") || "").trim() : "";
}

function readStoredRuntimePreferences(localStorageRef) {
  return {
    backendId: localStorageRef.getItem("echoCodexBackendId") || "",
    permissionMode: localStorageRef.getItem("echoCodexPermissionMode") || "",
    model: localStorageRef.getItem("echoCodexModel") || "",
    reasoningEffort: localStorageRef.getItem("echoCodexReasoningEffort") || "",
    mcpProfileId: normalizeStoredMcpProfileId(localStorageRef.getItem("echoCodexMcpProfile")),
    worktreeMode: readStoredWorktreePreference(localStorageRef) ? "always" : "off"
  };
}

function readStoredMcpTargetClients(localStorageRef) {
  const allowed = new Set(["codex", "claude-code"]);
  const raw = String(localStorageRef.getItem("echoMcpTargetClients") || "codex").split(",");
  const targets = raw.map((item) => item.trim()).filter((item) => allowed.has(item));
  return Array.from(new Set(targets.length ? targets : ["codex"]));
}

function normalizeStoredMcpProfileId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function readStoredWorktreePreference(localStorageRef) {
  return localStorageRef.getItem("echoCodexWorktreeEnabled") === "true";
}

function readStoredComposerMode(localStorageRef, user = null) {
  const scoped = normalizeStoredComposerModeValue(localStorageRef.getItem(scopedStorageKey("echoComposerMode", user)));
  if (scoped) return scoped;
  return normalizeStoredComposerModeValue(localStorageRef.getItem("echoComposerMode"));
}

function normalizeStoredComposerModeValue(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "plan") return "plan";
  if (mode === "execute") return "execute";
  return "";
}

function readStoredCodexWorkspaces(localStorageRef, user = null, options = {}) {
  try {
    const scoped = localStorageRef.getItem(scopedStorageKey("echoCodexWorkspaces", user));
    const fallbackLegacy = options.fallbackLegacy ?? !normalizeStorageUserKey(user);
    const legacy = fallbackLegacy ? localStorageRef.getItem("echoCodexWorkspaces") : "";
    const parsed = JSON.parse(scoped || legacy || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStoredCodexWorkspace).filter(Boolean).slice(0, 50);
  } catch {
    return [];
  }
}

function normalizeStoredCodexWorkspace(workspace = {}) {
  const id = String(workspace.workspaceId || workspace.projectId || workspace.id || "").trim();
  if (!id) return null;
  const agentId = String(workspace.agentId || "").trim();
  const key = String(workspace.key || (agentId ? `${agentId}:${id}` : id)).trim();
  return {
    id,
    workspaceId: id,
    key,
    label: String(workspace.label || workspace.id || "").trim() || id,
    path: String(workspace.path || "").trim(),
    agentId,
    agentLabel: String(workspace.agentLabel || workspace.agentName || workspace.agentId || "").trim(),
    agentOwnerUser: String(workspace.agentOwnerUser || "").trim()
  };
}

function scopedStorageKey(baseKey, user = null) {
  const userKey = normalizeStorageUserKey(user);
  return userKey ? `${baseKey}:${userKey}` : baseKey;
}

function normalizeStorageUserKey(user = null) {
  const username = String(user?.username || user?.displayName || "").trim().toLowerCase();
  if (!username) return "";
  return username.replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

function queryElements(documentRef) {
  return {
    topbar: documentRef.querySelector(".topbar"),
    topbarContextTitle: documentRef.querySelector("#topbarContextTitle"),
    topbarEnvironmentAvatar: documentRef.querySelector("#topbarEnvironmentAvatar"),
    themeColorMeta: documentRef.querySelector("#themeColorMeta"),
    appleStatusBarMeta: documentRef.querySelector("#appleStatusBarMeta"),
    statusText: documentRef.querySelector("#statusText"),
    mobileStatusIndicator: documentRef.querySelector("#mobileStatusIndicator"),
    userBadge: documentRef.querySelector("#userBadge"),
    logoutButton: documentRef.querySelector("#logoutButton"),
    openPairingButton: documentRef.querySelector("#openPairingButton"),
    refreshStatus: documentRef.querySelector("#refreshStatus"),
    themeModeToggle: documentRef.querySelector("#themeModeToggle"),
    worktreeModeToggle: documentRef.querySelector("#worktreeModeToggle"),
    worktreeModeSubtitle: documentRef.querySelector("#worktreeModeSubtitle"),
    loginPanel: documentRef.querySelector("#loginPanel"),
    loginForm: documentRef.querySelector("#loginForm"),
    loginStatus: documentRef.querySelector("#loginStatus"),
    loginUsername: documentRef.querySelector("#loginUsername"),
    loginPassword: documentRef.querySelector("#loginPassword"),
    loginButton: documentRef.querySelector("#loginButton"),
    pairingPanel: documentRef.querySelector("#pairingPanel"),
    pairingStatus: documentRef.querySelector("#pairingStatus"),
    pairingVideo: documentRef.querySelector("#pairingVideo"),
    pairingInput: documentRef.querySelector("#pairingInput"),
    scanPairingButton: documentRef.querySelector("#scanPairingButton"),
    stopScanButton: documentRef.querySelector("#stopScanButton"),
    savePairingButton: documentRef.querySelector("#savePairingButton"),
    authenticated: Array.from(documentRef.querySelectorAll("[data-authenticated]")),
    codexView: documentRef.querySelector("#codexView"),
    codexStatusText: documentRef.querySelector("#codexStatusText"),
    codexQueueMeta: documentRef.querySelector("#codexQueueMeta"),
    activeSessionTitle: documentRef.querySelector("#activeSessionTitle"),
    activeSessionMeta: documentRef.querySelector("#activeSessionMeta"),
    sessionStatusRail: documentRef.querySelector("#sessionStatusRail"),
    stopCodexTurnButton: documentRef.querySelector("#stopCodexTurnButton"),
    contextUsageDetailsLine: documentRef.querySelector("#contextUsageDetailsLine"),
    composerStatusText: documentRef.querySelector("#composerStatusText"),
    composerActionsMeta: documentRef.querySelector("#composerActionsMeta"),
    contextUsageIndicator: documentRef.querySelector("#contextUsageIndicator"),
    agentSkills: documentRef.querySelector("#agentSkills"),
    agentSkillsButton: documentRef.querySelector("#agentSkillsButton"),
    agentSkillsPanel: documentRef.querySelector("#agentSkillsPanel"),
    agentSkillsList: documentRef.querySelector("#agentSkillsList"),
    agentSkillsMeta: documentRef.querySelector("#agentSkillsMeta"),
    agentSkillManager: documentRef.querySelector("#agentSkillManager"),
    agentSkillButton: documentRef.querySelector("#agentSkillButton"),
    agentSkillPanel: documentRef.querySelector("#agentSkillPanel"),
    agentSkillCloseButton: documentRef.querySelector("#agentSkillCloseButton"),
    agentSkillMeta: documentRef.querySelector("#agentSkillMeta"),
    agentSkillPreferenceSubtitle: documentRef.querySelector("#agentSkillPreferenceSubtitle"),
    agentSkillRefreshButton: documentRef.querySelector("#agentSkillRefreshButton"),
    agentSkillImportButton: documentRef.querySelector("#agentSkillImportButton"),
    agentSkillImportForm: documentRef.querySelector("#agentSkillImportForm"),
    agentSkillImportUrl: documentRef.querySelector("#agentSkillImportUrl"),
    agentSkillImportCancelButton: documentRef.querySelector("#agentSkillImportCancelButton"),
    agentSkillImportSubmitButton: documentRef.querySelector("#agentSkillImportSubmitButton"),
    agentSkillOverview: documentRef.querySelector("#agentSkillOverview"),
    agentSkillList: documentRef.querySelector("#agentSkillList"),
    agentSkillDetail: documentRef.querySelector("#agentSkillDetail"),
    agentSkillTargetList: documentRef.querySelector("#agentSkillTargetList"),
    agentSkillStatus: documentRef.querySelector("#agentSkillStatus"),
    desktopPluginManager: documentRef.querySelector("#desktopPluginManager"),
    desktopPluginButton: documentRef.querySelector("#desktopPluginButton"),
    desktopPluginPanel: documentRef.querySelector("#desktopPluginPanel"),
    desktopPluginCloseButton: documentRef.querySelector("#desktopPluginCloseButton"),
    desktopPluginRefreshButton: documentRef.querySelector("#desktopPluginRefreshButton"),
    desktopPluginMeta: documentRef.querySelector("#desktopPluginMeta"),
    desktopPluginPreferenceSubtitle: documentRef.querySelector("#desktopPluginPreferenceSubtitle"),
    desktopPluginOverview: documentRef.querySelector("#desktopPluginOverview"),
    desktopPluginList: documentRef.querySelector("#desktopPluginList"),
    desktopPluginStatus: documentRef.querySelector("#desktopPluginStatus"),
    mcpManager: documentRef.querySelector("#mcpManager"),
    mcpButton: documentRef.querySelector("#mcpButton"),
    mcpPanel: documentRef.querySelector("#mcpPanel"),
    mcpCloseButton: documentRef.querySelector("#mcpCloseButton"),
    mcpMeta: documentRef.querySelector("#mcpMeta"),
    mcpPreferenceSubtitle: documentRef.querySelector("#mcpPreferenceSubtitle"),
    mcpRefreshButton: documentRef.querySelector("#mcpRefreshButton"),
    mcpProfileList: documentRef.querySelector("#mcpProfileList"),
    mcpDetailPanel: documentRef.querySelector("#mcpDetailPanel"),
    mcpTargetList: documentRef.querySelector("#mcpTargetList"),
    mcpApplyButton: documentRef.querySelector("#mcpApplyButton"),
    mcpStatus: documentRef.querySelector("#mcpStatus"),
    composerPlanModeButton: documentRef.querySelector("#composerPlanModeButton"),
    quickSkills: documentRef.querySelector("#quickSkills"),
    quickSkillsButton: documentRef.querySelector("#quickSkillsButton"),
    quickSkillsPanel: documentRef.querySelector("#quickSkillsPanel"),
    quickSkillsList: documentRef.querySelector("#quickSkillsList"),
    quickSkillsMeta: documentRef.querySelector("#quickSkillsMeta"),
    quickSkillNewGlobalButton: documentRef.querySelector("#quickSkillNewGlobalButton"),
    quickSkillNewProjectButton: documentRef.querySelector("#quickSkillNewProjectButton"),
    quickSkillForm: documentRef.querySelector("#quickSkillForm"),
    quickSkillFormTitle: documentRef.querySelector("#quickSkillFormTitle"),
    quickSkillId: documentRef.querySelector("#quickSkillId"),
    quickSkillTitle: documentRef.querySelector("#quickSkillTitle"),
    quickSkillScope: documentRef.querySelector("#quickSkillScope"),
    quickSkillPrompt: documentRef.querySelector("#quickSkillPrompt"),
    quickSkillDeleteButton: documentRef.querySelector("#quickSkillDeleteButton"),
    quickSkillCancelButton: documentRef.querySelector("#quickSkillCancelButton"),
    quickSkillSaveButton: documentRef.querySelector("#quickSkillSaveButton"),
    openSpec: documentRef.querySelector("#openSpec"),
    openSpecButton: documentRef.querySelector("#openSpecButton"),
    openSpecPanel: documentRef.querySelector("#openSpecPanel"),
    openSpecTitle: documentRef.querySelector("#openSpecTitle"),
    openSpecMeta: documentRef.querySelector("#openSpecMeta"),
    openSpecExploreButton: documentRef.querySelector("#openSpecExploreButton"),
    openSpecOrchestrationButton: documentRef.querySelector("#openSpecOrchestrationButton"),
    openSpecRefreshButton: documentRef.querySelector("#openSpecRefreshButton"),
    openSpecCloseButton: documentRef.querySelector("#openSpecCloseButton"),
    openSpecBackButton: documentRef.querySelector("#openSpecBackButton"),
    openSpecStatus: documentRef.querySelector("#openSpecStatus"),
    openSpecOverview: documentRef.querySelector("#openSpecOverview"),
    openSpecTimeline: documentRef.querySelector("#openSpecTimeline"),
    openSpecOrchestrationActions: documentRef.querySelector("#openSpecOrchestrationActions"),
    openSpecRunProgress: documentRef.querySelector("#openSpecRunProgress"),
    openSpecRunPage: documentRef.querySelector("#openSpecRunPage"),
    openSpecRunBackButton: documentRef.querySelector("#openSpecRunBackButton"),
    openSpecRunCloseButton: documentRef.querySelector("#openSpecRunCloseButton"),
    openSpecRunMeta: documentRef.querySelector("#openSpecRunMeta"),
    openSpecRunStatus: documentRef.querySelector("#openSpecRunStatus"),
    openSpecRunTimeline: documentRef.querySelector("#openSpecRunTimeline"),
    openSpecRunActions: documentRef.querySelector("#openSpecRunActions"),
    fileBrowser: documentRef.querySelector("#fileBrowser"),
    fileBrowserButton: documentRef.querySelector("#fileBrowserButton"),
    fileBrowserPanel: documentRef.querySelector("#fileBrowserPanel"),
    fileBrowserTitle: documentRef.querySelector("#fileBrowserTitle"),
    fileBrowserMeta: documentRef.querySelector("#fileBrowserMeta"),
    fileBrowserRefreshButton: documentRef.querySelector("#fileBrowserRefreshButton"),
    fileBrowserCloseButton: documentRef.querySelector("#fileBrowserCloseButton"),
    fileBrowserBreadcrumbs: documentRef.querySelector("#fileBrowserBreadcrumbs"),
    fileBrowserStatus: documentRef.querySelector("#fileBrowserStatus"),
    fileBrowserList: documentRef.querySelector("#fileBrowserList"),
    filePreview: documentRef.querySelector("#filePreview"),
    filePreviewTitle: documentRef.querySelector("#filePreviewTitle"),
    filePreviewMeta: documentRef.querySelector("#filePreviewMeta"),
    filePreviewContent: documentRef.querySelector("#filePreviewContent"),
    filePreviewInsertButton: documentRef.querySelector("#filePreviewInsertButton"),
    filePreviewCloseButton: documentRef.querySelector("#filePreviewCloseButton"),
    refreshCodex: documentRef.querySelector("#refreshCodex"),
    toggleSessionsButton: documentRef.querySelector("#toggleSessionsButton"),
    sessionBackdrop: documentRef.querySelector("#sessionBackdrop"),
    codexScrollSurface: documentRef.querySelector("#codexJobDetail"),
    showActiveSessionsButton: documentRef.querySelector("#showActiveSessionsButton"),
    showArchivedSessionsButton: documentRef.querySelector("#showArchivedSessionsButton"),
    sidebarPreferences: documentRef.querySelector(".sidebar-panel-appearance"),
    sidebarPreferencesToggle: documentRef.querySelector("#sidebarPreferencesToggle"),
    sidebarPreferencesBody: documentRef.querySelector("#sidebarPreferencesBody"),
    mobileSettingsButton: documentRef.querySelector("#mobileSettingsButton"),
    mobileSettingsPanel: documentRef.querySelector("#mobileSettingsPanel"),
    mobileSettingsCloseButton: documentRef.querySelector("#mobileSettingsCloseButton"),
    mobileSettingsMeta: documentRef.querySelector("#mobileSettingsMeta"),
    accountManager: documentRef.querySelector("#accountManager"),
    accountButton: documentRef.querySelector("#accountButton"),
    accountPanel: documentRef.querySelector("#accountPanel"),
    accountCloseButton: documentRef.querySelector("#accountCloseButton"),
    accountPreferenceSubtitle: documentRef.querySelector("#accountPreferenceSubtitle"),
    adminManager: documentRef.querySelector("#adminManager"),
    adminButton: documentRef.querySelector("#adminButton"),
    adminPanel: documentRef.querySelector("#adminPanel"),
    adminCloseButton: documentRef.querySelector("#adminCloseButton"),
    adminRefreshButton: documentRef.querySelector("#adminRefreshButton"),
    adminMeta: documentRef.querySelector("#adminMeta"),
    adminPreferenceSubtitle: documentRef.querySelector("#adminPreferenceSubtitle"),
    adminStatus: documentRef.querySelector("#adminStatus"),
    adminAgentList: documentRef.querySelector("#adminAgentList"),
    adminUserList: documentRef.querySelector("#adminUserList"),
    adminUserDetail: documentRef.querySelector("#adminUserDetail"),
    adminApproveButton: documentRef.querySelector("#adminApproveButton"),
    projectSwitcher: documentRef.querySelector("#projectSwitcher"),
    agentEnvironmentList: documentRef.querySelector("#agentEnvironmentList"),
    sidebarUserMeta: documentRef.querySelector("#sidebarUserMeta"),
    codexProject: documentRef.querySelector("#codexProject"),
    codexBackend: documentRef.querySelector("#codexBackend"),
    codexPermissionMode: documentRef.querySelector("#codexPermissionMode"),
    codexModel: documentRef.querySelector("#codexModel"),
    codexReasoningEffort: documentRef.querySelector("#codexReasoningEffort"),
    codexMcpProfile: documentRef.querySelector("#codexMcpProfile"),
    composerAttachmentButton: documentRef.querySelector("#composerAttachmentButton"),
    composerFileAttachmentButton: documentRef.querySelector("#composerFileAttachmentButton"),
    composerAttachmentInput: documentRef.querySelector("#composerAttachmentInput"),
    composerFileAttachmentInput: documentRef.querySelector("#composerFileAttachmentInput"),
    composerAttachmentTray: documentRef.querySelector("#composerAttachmentTray"),
    newProjectButton: documentRef.querySelector("#newProjectButton"),
    openExistingProjectButton: documentRef.querySelector("#openExistingProjectButton"),
    projectCreateForm: documentRef.querySelector("#projectCreateForm"),
    projectCreateName: documentRef.querySelector("#projectCreateName"),
    projectCreateSubmit: documentRef.querySelector("#projectCreateSubmit"),
    projectPickerLabel: documentRef.querySelector("#projectPickerLabel"),
    projectPickerMeta: documentRef.querySelector("#projectPickerMeta"),
    projectSheetStatus: documentRef.querySelector("#projectSheetStatus"),
    projectSheetList: documentRef.querySelector("#projectSheetList"),
    projectImportPanel: documentRef.querySelector("#projectImportPanel"),
    projectImportCloseButton: documentRef.querySelector("#projectImportCloseButton"),
    projectImportRefreshButton: documentRef.querySelector("#projectImportRefreshButton"),
    projectImportMeta: documentRef.querySelector("#projectImportMeta"),
    projectImportRoots: documentRef.querySelector("#projectImportRoots"),
    projectImportBreadcrumbs: documentRef.querySelector("#projectImportBreadcrumbs"),
    projectImportList: documentRef.querySelector("#projectImportList"),
    projectImportStatus: documentRef.querySelector("#projectImportStatus"),
    projectImportSelectButton: documentRef.querySelector("#projectImportSelectButton"),
    codexPrompt: documentRef.querySelector("#codexPrompt"),
    composer: documentRef.querySelector(".composer"),
    newCodexSessionButton: documentRef.querySelector("#newCodexSessionButton"),
    sendCodexButton: documentRef.querySelector("#sendCodexButton"),
    codexJobs: documentRef.querySelector("#codexJobs"),
    codexJobDetail: documentRef.querySelector("#codexJobDetail"),
    codexRunSummary: documentRef.querySelector("#codexRunSummary"),
    codexApprovals: documentRef.querySelector("#codexApprovals"),
    runLog: documentRef.querySelector(".run-log"),
    codexLog: documentRef.querySelector("#codexLog")
  };
}
