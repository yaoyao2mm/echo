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
  { value: "xhigh", label: "极高" }
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
      token: tokenFromUrl || windowRef.localStorage.getItem("echoToken") || "",
      sessionToken: windowRef.localStorage.getItem("echoSession") || "",
      currentUser: readStoredUser(windowRef.localStorage),
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
      codexWorkspaces: readStoredCodexWorkspaces(windowRef.localStorage),
      codexAgentOnline: false,
      codexAgentAvailable: false,
      codexLastAgentSeenAt: "",
      codexConnectionState: "connecting",
      projectCreateBusy: false,
      showArchivedSessions: false,
      composerBusy: false,
      codexAgentRuntime: {},
      codexBackendRuntimes: [],
      codexModelCatalog: [],
      codexUnsupportedModels: [],
      codexSupportedModels: [],
      codexAllowedPermissionModes: [],
      runtimePreferences: readStoredRuntimePreferences(windowRef.localStorage),
      runtimeDirty: false,
      runtimeSelectControls: [],
      runtimeSelectControlsInstalled: false,
      runtimeSelectPopover: null,
      runtimeSelectPopoverPanel: null,
      lastTopbarScrollY: 0,
      topbarScrollAccumulator: 0,
      topbarCollapsed: false,
      viewportStableHeight: 0,
      viewportStableWidth: 0,
      viewportKeyboardActive: false,
      viewportPromptFocused: false,
      renderedCodexSessionId: "",
      renderedCodexSessionSignature: "",
      composerAttachments: [],
      composerAttachmentPendingCount: 0,
      composerPlanMode: windowRef.localStorage.getItem("echoComposerMode") === "plan",
      quickSkills: [],
      quickSkillsLoadedProjectId: null,
      quickSkillsBusy: false,
      quickSkillEditingId: "",
      turnActivityDetailsOpen: false,
      contextUsageDetailsOpen: false,
      autoCompactedSessionIds: new Set(),
      fileBrowserProjectId: "",
      fileBrowserPath: "",
      fileBrowserTree: null,
      filePreview: null,
      fileBrowserBusy: false,
      fileBrowserError: ""
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

  app.bindViewportMetrics = function bindViewportMetrics() {
    app.syncViewportMetrics();
    window.addEventListener("resize", app.syncViewportMetrics, { passive: true });
    window.visualViewport?.addEventListener("resize", app.syncViewportMetrics, { passive: true });
    window.visualViewport?.addEventListener("scroll", app.syncViewportMetrics, { passive: true });
    elements.codexPrompt?.addEventListener("focus", () => {
      state.viewportPromptFocused = true;
      app.queueViewportSync();
    });
    elements.codexPrompt?.addEventListener("blur", () => {
      state.viewportPromptFocused = false;
      app.queueViewportSync();
    });
  };

  app.syncViewportMetrics = function syncViewportMetrics() {
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

    const stableHeight = Math.max(state.viewportStableHeight || 0, baseHeight);
    const keyboardHeight = Math.max(0, stableHeight - visualHeight);
    const keyboardLikely = compactMode && keyboardHeight >= 96;
    const promptFocused = state.viewportPromptFocused || document.activeElement === elements.codexPrompt;
    const keyboardActive = keyboardLikely && (promptFocused || state.viewportKeyboardActive);
    state.viewportKeyboardActive = keyboardActive;
    if (!keyboardActive) {
      state.viewportStableHeight = stableHeight;
      state.viewportStableWidth = baseWidth;
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

  app.queueViewportSync = function queueViewportSync() {
    window.requestAnimationFrame(() => {
      app.syncViewportMetrics();
    });
    window.setTimeout(app.syncViewportMetrics, 120);
    window.setTimeout(app.syncViewportMetrics, 320);
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
      elements.codexView.classList.contains("files-open")
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

  app.refreshComposerStatusBar = function refreshComposerStatusBar() {
    if (!elements.composerStatusText) return;

    const session = state.composingNewSession ? null : state.selectedCodexSession;
    let status = "";
    if (state.composerBusy) {
      status = "正在发送…";
    } else if (state.composerAttachmentPendingCount > 0) {
      status =
        state.composerAttachmentPendingCount === 1
          ? "正在处理 1 张图片…"
          : `正在处理 ${state.composerAttachmentPendingCount} 张图片…`;
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
      status = "消息已排队";
    } else if (session?.status === "failed" && app.sessionCanRecoverFailure(session)) {
      status = "上一轮失败，可继续";
    } else if (session && !app.sessionCanAcceptFollowUp(session)) {
      status = "当前会话不可继续";
    } else if (!state.codexAgentAvailable) {
      status = "等待桌面 agent";
    } else if (!app.currentProjectId()) {
      status = "先选择工程";
    } else if (state.codexConnectionState === "syncing") {
      status = "桌面状态同步中";
    }
    elements.composerStatusText.textContent = status;
    elements.composerStatusText.classList.toggle("is-empty", !status);
    app.refreshTurnActivityToggle?.(session, status);
    app.refreshTurnActivityLine?.();
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
    if (elements.mobileStatusIndicator) {
      elements.mobileStatusIndicator.dataset.state = indicatorState;
      elements.mobileStatusIndicator.title = text;
      elements.mobileStatusIndicator.setAttribute("aria-hidden", indicatorState === "online" ? "true" : "false");
      elements.mobileStatusIndicator.setAttribute("aria-label", text);
    }
  };

  app.initRuntimeControls = function initRuntimeControls() {
    app.populateRuntimeSelect(elements.codexBackend, backendOptions);
    app.populateRuntimeSelect(elements.codexPermissionMode, permissionOptions);
    app.populateRuntimeSelect(elements.codexModel, modelOptions);
    app.populateRuntimeSelect(elements.codexReasoningEffort, reasoningOptions);
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
      { select: elements.quickSkillScope, label: "范围" },
      { select: elements.quickSkillMode, label: "模式" }
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
    if (select?.id !== "codexBackend") return options;
    const concreteOptions = options.filter((option) => String(option.value || "").trim());
    return concreteOptions.length > 0 ? concreteOptions : options;
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
    const modelSupportedBySelectedBackend = !requestedModel || app.backendRuntimeSupportsModel(selectedBackend, requestedModel);
    const permissionMode = app.normalizePermissionMode(requestedPermissionMode);
    const resolved = app.runtimeChoiceWithFallback(
      {
        backendId: requestedBackendId,
        model: modelSupportedBySelectedBackend ? requestedModel : "",
        permissionMode,
        reasoningEffort: elements.codexReasoningEffort.value,
        worktreeMode: app.requestedWorktreeMode()
      },
      state.runtimePreferences
    );
    resolved.backendId = requestedBackendId || resolved.backendId;
    resolved.model = modelSupportedBySelectedBackend ? requestedModel : "";
    resolved.permissionMode = permissionMode;
    resolved.reasoningEffort = String(elements.codexReasoningEffort.value || "").trim();
    resolved.worktreeMode = app.requestedWorktreeMode();
    app.applyRuntimeDraft(resolved, { dirty: true });
    app.refreshRuntimeSelectControls();
    app.refreshActiveSessionHeader();
    app.refreshComposerMeta();
  };

  app.applyWorktreeModePreference = function applyWorktreeModePreference(enabled, options = {}) {
    state.worktreePreferenceEnabled = enabled !== false;
    if (options.persist !== false) {
      localStorage.setItem("echoCodexWorktreeEnabled", state.worktreePreferenceEnabled ? "true" : "false");
    }
    state.runtimeDirty = true;
    state.runtimePreferences = app.currentRuntimeDraft();
    app.writeStoredRuntimePreferences(state.runtimePreferences);
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
    app.refreshRuntimeDefaultOptions({ selectedModel: next.model });
    elements.codexPermissionMode.value = next.permissionMode;
    elements.codexModel.value = app.selectHasEnabledOption(elements.codexModel, next.model) ? next.model : "";
    elements.codexReasoningEffort.value = next.reasoningEffort;
    app.refreshRuntimeSelectControls();
    if (next.worktreeMode) {
      state.worktreePreferenceEnabled = next.worktreeMode !== "off";
    }
    state.runtimeDirty = Boolean(options.dirty);
    if (options.persist !== false) {
      state.runtimePreferences = next;
      app.writeStoredRuntimePreferences(next);
    }
    app.refreshWorktreeModeControls();
  };

  app.refreshRuntimeDefaultOptions = function refreshRuntimeDefaultOptions(options = {}) {
    const backendOption = elements.codexBackend.querySelector('option[value=""]');
    const permissionOption = elements.codexPermissionMode.querySelector('option[value=""]');
    const reasoningOption = elements.codexReasoningEffort.querySelector('option[value=""]');
    if (backendOption) {
      backendOption.textContent = app.backendDisplayName(
        state.codexAgentRuntime.backendId || state.codexAgentRuntime.provider || state.codexAgentRuntime.backendName || "codex"
      );
      backendOption.dataset.baseLabel = backendOption.textContent;
    }
    if (permissionOption) {
      permissionOption.textContent = state.codexAgentRuntime.permissionMode
        ? `默认 · ${app.permissionModeDisplayName(state.codexAgentRuntime.permissionMode)}`
        : "默认";
      permissionOption.dataset.baseLabel = permissionOption.textContent;
    }
    if (reasoningOption) {
      reasoningOption.textContent = state.codexAgentRuntime.reasoningEffort
        ? `默认 · ${app.reasoningDisplayName(state.codexAgentRuntime.reasoningEffort)}`
        : "默认";
      reasoningOption.dataset.baseLabel = reasoningOption.textContent;
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
    const modelOption = elements.codexModel.querySelector('option[value=""]');
    if (modelOption) {
      modelOption.textContent = state.codexAgentRuntime.model
        ? `默认 · ${app.modelDisplayName(state.codexAgentRuntime.model)}`
        : "默认";
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
    for (const option of Array.from(elements.codexPermissionMode.options || [])) {
      const value = String(option.value || "").trim();
      if (!value) continue;
      const baseLabel = app.permissionModeDisplayName(value);
      option.dataset.baseLabel = baseLabel;
      option.disabled = false;
      option.textContent = baseLabel;
    }
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
    return {
      backendId,
      permissionMode,
      sandbox: app.normalizeSandboxModeValue(runtime.sandbox),
      approvalPolicy: app.normalizeApprovalPolicyValue(runtime.approvalPolicy),
      model: knownModelValues.has(rawModel) || rawModel ? rawModel : "",
      reasoningEffort: knownReasoningValues.has(reasoningEffort) || reasoningEffort ? reasoningEffort : "",
      worktreeMode: app.normalizeWorktreeModeValue(runtime.worktreeMode)
    };
  };

  app.writeStoredRuntimePreferences = function writeStoredRuntimePreferences(runtime = {}) {
    const next = app.normalizeRuntimeChoice(runtime);
    if (next.backendId) localStorage.setItem("echoCodexBackendId", next.backendId);
    else localStorage.removeItem("echoCodexBackendId");
    if (next.permissionMode) localStorage.setItem("echoCodexPermissionMode", next.permissionMode);
    else localStorage.removeItem("echoCodexPermissionMode");
    if (next.model) localStorage.setItem("echoCodexModel", next.model);
    else localStorage.removeItem("echoCodexModel");
    if (next.reasoningEffort) localStorage.setItem("echoCodexReasoningEffort", next.reasoningEffort);
    else localStorage.removeItem("echoCodexReasoningEffort");
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
    const forced = agentMode === "always";
    const available = forced || agentMode === "optional";
    const checked = forced || (available && state.worktreePreferenceEnabled);
    toggle.checked = checked;
    toggle.disabled = !available || forced;
    toggle.setAttribute("aria-checked", checked ? "true" : "false");
    if (elements.worktreeModeSubtitle) {
      elements.worktreeModeSubtitle.textContent = forced
        ? "桌面端强制开启"
        : available
          ? "新会话默认独立执行"
          : "桌面端未启用";
    }
  };

  app.workspaceLabel = function workspaceLabel(workspace) {
    return workspace?.label || workspace?.id || workspace?.path || "未命名项目";
  };

  app.workspaceMeta = function workspaceMeta(workspace) {
    return workspace?.path || workspace?.id || "桌面端已同步";
  };

  app.workspaceSecondaryLabel = function workspaceSecondaryLabel(workspace) {
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
    elements.projectSwitcher.hidden = !app.isLoggedIn() || !state.token;
  };

  app.refreshTopbarProjectChip = app.refreshProjectSwitcherVisibility;

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

  app.sessionProjectLabel = function sessionProjectLabel(projectId) {
    const normalizedProjectId = String(projectId || "").trim();
    if (!normalizedProjectId) return "未选择工程";
    return app.workspaceLabel(
      state.codexWorkspaces.find((workspace) => workspace.id === normalizedProjectId) || { id: normalizedProjectId }
    );
  };

  app.currentProjectId = function currentProjectId() {
    return String(
      elements.codexProject?.value ||
        state.selectedCodexSession?.projectId ||
        localStorage.getItem("echoCodexProject") ||
        ""
    ).trim();
  };

  app.sessionBelongsToCurrentProject = function sessionBelongsToCurrentProject(session) {
    const projectId = app.currentProjectId();
    return Boolean(session?.id && projectId && session.projectId === projectId);
  };

  app.sessionRuntimeLabel = function sessionRuntimeLabel(runtime = {}) {
    const normalized = app.normalizeRuntimeChoice(runtime);
    const parts = [];
    if (normalized.backendId) parts.push(app.backendDisplayName(normalized.backendId));
    if (normalized.permissionMode) parts.push(app.permissionModeDisplayName(normalized.permissionMode, app.runtimeWithBackendDefaults(normalized)));
    if (normalized.model) parts.push(app.modelDisplayName(normalized.model));
    if (normalized.reasoningEffort) parts.push(`推理 ${app.reasoningDisplayName(normalized.reasoningEffort)}`);
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
    const selected = matchedBackend || app.backendRuntimeById(preferredBackendId) || state.codexAgentRuntime || state.codexBackendRuntimes[0] || {};
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
      gitSummary: "supportsGitSummary"
    }[key];
    if (legacyKey && typeof source[legacyKey] === "boolean") return source[legacyKey];

    if (key === "text" || key === "cancellation") return true;
    if (
      app.isCodexRuntime(source) &&
      ["attachments", "compaction", "contextUsage", "approvalRequests", "interactionRequests", "gitSummary", "worktree"].includes(key)
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
      throw new Error("当前后端暂不支持截图附件。");
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

  app.ensurePaired = function ensurePaired() {
    if (!app.ensureLoggedIn()) return false;
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

function readStoredRuntimePreferences(localStorageRef) {
  return {
    backendId: localStorageRef.getItem("echoCodexBackendId") || "",
    permissionMode: localStorageRef.getItem("echoCodexPermissionMode") || "",
    model: localStorageRef.getItem("echoCodexModel") || "",
    reasoningEffort: localStorageRef.getItem("echoCodexReasoningEffort") || "",
    worktreeMode: readStoredWorktreePreference(localStorageRef) ? "always" : "off"
  };
}

function readStoredWorktreePreference(localStorageRef) {
  return localStorageRef.getItem("echoCodexWorktreeEnabled") !== "false";
}

function readStoredCodexWorkspaces(localStorageRef) {
  try {
    const parsed = JSON.parse(localStorageRef.getItem("echoCodexWorkspaces") || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStoredCodexWorkspace).filter(Boolean).slice(0, 50);
  } catch {
    return [];
  }
}

function normalizeStoredCodexWorkspace(workspace = {}) {
  const id = String(workspace.id || "").trim();
  if (!id) return null;
  return {
    id,
    label: String(workspace.label || workspace.id || "").trim() || id,
    path: String(workspace.path || "").trim()
  };
}

function queryElements(documentRef) {
  return {
    topbar: documentRef.querySelector(".topbar"),
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
    turnActivityLine: documentRef.querySelector("#turnActivityLine"),
    turnActivityText: documentRef.querySelector("#turnActivityText"),
    contextUsageDetailsLine: documentRef.querySelector("#contextUsageDetailsLine"),
    composerStatusText: documentRef.querySelector("#composerStatusText"),
    composerActionsMeta: documentRef.querySelector("#composerActionsMeta"),
    contextUsageIndicator: documentRef.querySelector("#contextUsageIndicator"),
    compactContextButton: documentRef.querySelector("#compactContextButton"),
    composerPlanModeButton: documentRef.querySelector("#composerPlanModeButton"),
    quickSkills: documentRef.querySelector("#quickSkills"),
    quickSkillsButton: documentRef.querySelector("#quickSkillsButton"),
    quickSkillsPanel: documentRef.querySelector("#quickSkillsPanel"),
    quickSkillsList: documentRef.querySelector("#quickSkillsList"),
    quickSkillsMeta: documentRef.querySelector("#quickSkillsMeta"),
    quickSkillNewButton: documentRef.querySelector("#quickSkillNewButton"),
    quickSkillForm: documentRef.querySelector("#quickSkillForm"),
    quickSkillFormTitle: documentRef.querySelector("#quickSkillFormTitle"),
    quickSkillId: documentRef.querySelector("#quickSkillId"),
    quickSkillTitle: documentRef.querySelector("#quickSkillTitle"),
    quickSkillScope: documentRef.querySelector("#quickSkillScope"),
    quickSkillMode: documentRef.querySelector("#quickSkillMode"),
    quickSkillRequiresSession: documentRef.querySelector("#quickSkillRequiresSession"),
    quickSkillDescription: documentRef.querySelector("#quickSkillDescription"),
    quickSkillPrompt: documentRef.querySelector("#quickSkillPrompt"),
    quickSkillDeleteButton: documentRef.querySelector("#quickSkillDeleteButton"),
    quickSkillCancelButton: documentRef.querySelector("#quickSkillCancelButton"),
    quickSkillSaveButton: documentRef.querySelector("#quickSkillSaveButton"),
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
    sidebarUserToggle: documentRef.querySelector("#sidebarUserToggle"),
    sidebarUserBody: documentRef.querySelector("#sidebarUserBody"),
    projectSwitcher: documentRef.querySelector("#projectSwitcher"),
    sidebarUserMeta: documentRef.querySelector("#sidebarUserMeta"),
    codexProject: documentRef.querySelector("#codexProject"),
    codexBackend: documentRef.querySelector("#codexBackend"),
    codexPermissionMode: documentRef.querySelector("#codexPermissionMode"),
    codexModel: documentRef.querySelector("#codexModel"),
    codexReasoningEffort: documentRef.querySelector("#codexReasoningEffort"),
    composerAttachmentButton: documentRef.querySelector("#composerAttachmentButton"),
    composerAttachmentInput: documentRef.querySelector("#composerAttachmentInput"),
    composerAttachmentTray: documentRef.querySelector("#composerAttachmentTray"),
    newProjectButton: documentRef.querySelector("#newProjectButton"),
    projectCreateForm: documentRef.querySelector("#projectCreateForm"),
    projectCreateName: documentRef.querySelector("#projectCreateName"),
    projectCreateSubmit: documentRef.querySelector("#projectCreateSubmit"),
    projectPickerLabel: documentRef.querySelector("#projectPickerLabel"),
    projectPickerMeta: documentRef.querySelector("#projectPickerMeta"),
    projectSheetStatus: documentRef.querySelector("#projectSheetStatus"),
    projectSheetList: documentRef.querySelector("#projectSheetList"),
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
