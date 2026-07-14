const CODEX_AGENT_STATUS_GRACE_MS = 2 * 60 * 1000;

const QUICK_SKILL_ICON_VARIANTS = [
  {
    bg: "rgba(102, 132, 90, 0.14)",
    fg: "#657f57",
    body: `
      <path d="M12 4.5v2.2M12 17.3v2.2M4.5 12h2.2M17.3 12h2.2M7.3 7.3l1.5 1.5M15.2 15.2l1.5 1.5M7.3 16.7l1.5-1.5M15.2 8.8l1.5-1.5" />
    `
  },
  {
    bg: "rgba(187, 123, 72, 0.15)",
    fg: "#9d6630",
    body: `
      <path d="M5.5 18.5h3.6l8.5-8.5a1.6 1.6 0 0 0 0-2.2l-1.4-1.4a1.6 1.6 0 0 0-2.2 0L5.5 15v3.5Z" />
      <path d="M13.3 6.7 17.3 10.7" />
    `
  },
  {
    bg: "rgba(89, 126, 164, 0.14)",
    fg: "#587597",
    body: `
      <path d="M8 7h10M8 12h10M8 17h10M5.5 7h.1M5.5 12h.1M5.5 17h.1" />
    `
  },
  {
    bg: "rgba(126, 104, 84, 0.14)",
    fg: "#7b5d45",
    body: `
      <path d="M10 8 6 12l4 4M14 8l4 4-4 4" />
    `
  },
  {
    bg: "rgba(95, 145, 138, 0.15)",
    fg: "#56817a",
    body: `
      <circle cx="10.5" cy="10.5" r="4.5" />
      <path d="M14 14l4 4" />
    `
  },
  {
    bg: "rgba(178, 103, 96, 0.14)",
    fg: "#a34f45",
    body: `
      <path d="M8 6.5h8A1.5 1.5 0 0 1 17.5 8v10A1.5 1.5 0 0 1 16 19.5H8A1.5 1.5 0 0 1 6.5 18V8A1.5 1.5 0 0 1 8 6.5Z" />
      <path d="M9.2 6.5V5.8A1.3 1.3 0 0 1 10.5 4.5h3A1.3 1.3 0 0 1 14.8 5.8v.7" />
      <path d="M9.1 11h5.8M9.1 14h5.8" />
    `
  },
  {
    bg: "rgba(132, 121, 171, 0.14)",
    fg: "#7767a4",
    body: `
      <path d="M13.1 3.4 6.2 12h5.1l-1.1 8.1 7.6-9.6H12.9l.2-7.1Z" />
    `
  },
  {
    bg: "rgba(111, 116, 135, 0.14)",
    fg: "#5f6778",
    body: `
      <circle cx="12" cy="12" r="5" />
      <path d="M12 9v3l2 1.3" />
    `
  }
];

function hashText(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0) || 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function quickSkillIconVariantIndex(key, usedIndexes) {
  const startIndex = hashText(key) % QUICK_SKILL_ICON_VARIANTS.length;
  if (!usedIndexes) return startIndex;
  for (let offset = 0; offset < QUICK_SKILL_ICON_VARIANTS.length; offset += 1) {
    const index = (startIndex + offset) % QUICK_SKILL_ICON_VARIANTS.length;
    if (!usedIndexes.has(index)) {
      usedIndexes.add(index);
      return index;
    }
  }
  return startIndex;
}

export function installCodex(app) {
  const { constants, elements, state } = app;

  app.hashText = hashText;

  app.hasPendingComposerAttachments = function hasPendingComposerAttachments() {
    return Number(state.composerAttachmentPendingCount || 0) > 0;
  };

  app.setComposerAttachmentPendingCount = function setComposerAttachmentPendingCount(count, kind = state.composerAttachmentPendingKind) {
    state.composerAttachmentPendingCount = Math.max(0, Number(count) || 0);
    state.composerAttachmentPendingKind = state.composerAttachmentPendingCount > 0 ? String(kind || "").trim() : "";
    app.updateComposerAvailability();
  };

  app.refreshCodex = async function refreshCodex(options = {}) {
    if (!app.canUseWorkbench?.()) return;
    if (state.codexRefreshPromise) return state.codexRefreshPromise;

    state.codexRefreshPromise = (async () => {
      try {
        const data = await app.apiGet("/api/codex/status");
        app.renderCodexStatus(data);
        const quickSkillWorkspaceKey = app.currentWorkspace?.()?.key || app.currentProjectId();
        const shouldLoadQuickSkills =
          options.forceQuickSkills || !options.scheduled || state.quickSkillsLoadedProjectId !== quickSkillWorkspaceKey;
        if (shouldLoadQuickSkills) await app.loadQuickSkills({ silent: true });
        await app.loadCodexJobs({ skipSelectedDetailLoad: Boolean(state.sessionEventSourceId || state.sessionEventReconnectTimer) });
      } catch (error) {
        if (app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) return;
        const shouldToast = app.markCodexConnectionProblem("连接中断，当前会话已保留。");
        if (shouldToast && error.message && !error.message.includes("relay mode")) app.toast(error.message);
      }
    })().finally(() => {
      state.codexRefreshPromise = null;
    });

    return state.codexRefreshPromise;
  };

  app.renderCodexStatus = function renderCodexStatus(codex) {
    const agentOnline = Boolean(codex.agentOnline);
    const agentAvailable = agentOnline || app.codexAgentRecentlySeen(codex);
    const incomingWorkspaces = app.codexIncomingWorkspaces(codex);
    const workspaces = app.codexWorkspacesForStatus(codex);
    const previousProject = app.currentProjectId();
    const previousTargetAgent = app.currentTargetAgentId();
    state.codexWorkspaces = workspaces;
    state.codexHiddenWorkspaceKeys = app.codexHiddenWorkspaceKeys(codex);
    state.codexAvailableWorkspaceKeys = agentOnline ? incomingWorkspaces.map((workspace) => workspace.key).filter(Boolean) : [];
    state.codexAgents = Array.isArray(codex.agents) ? codex.agents : [];
    state.selectedAgentId = app.resolveSelectedAgentId(
      app.storedSelectedAgentId?.() || previousTargetAgent || app.agentIdFromWorkspaceKey(app.storedCodexProjectKey?.()) || "",
      workspaces,
      state.codexAgents
    );
    if (state.selectedAgentId) app.persistSelectedAgentId?.(state.selectedAgentId);
    const selectedAgent = app.agentById(state.selectedAgentId);
    const currentAgentLabel = app.agentDisplayName(selectedAgent) || "桌面 agent";
    const agentStatusText = agentOnline
      ? `${currentAgentLabel} 在线`
      : agentAvailable
        ? "桌面状态同步中"
        : "等待桌面 agent";
    state.codexAgentOnline = agentOnline;
    state.codexAgentAvailable = agentAvailable;
    state.codexLastAgentSeenAt = app.codexLastAgentSeenAt(codex);
    state.codexConnectionState = agentOnline ? "online" : agentAvailable ? "syncing" : "waiting";
    state.codexStatusUpdatedAt = String(codex.statusUpdatedAt || "").trim();
    state.codexWorkspacesUpdatedAt = String(codex.workspacesUpdatedAt || "").trim();
    state.codexRuntimeUpdatedAt = String(codex.runtimeUpdatedAt || "").trim();
    state.codexStatusVersion = String(codex.statusVersion || "").trim();
    const selectedAgentRuntime = app.runtimeForAgent(state.selectedAgentId, codex.runtime || {});
    state.codexBackendRuntimes = app.backendRuntimesForRuntime(selectedAgentRuntime);
    if (app.codexShouldDropWorkspaceCache(codex, incomingWorkspaces)) {
      app.removeScopedStorage?.("echoCodexWorkspaces");
      app.removeScopedStorage?.("echoCodexProject");
      app.persistSelectedAgentId?.("");
    }
    app.updateMcpSnapshot?.(selectedAgentRuntime?.mcp || {});
    app.updateAgentSkillSnapshot?.(selectedAgentRuntime?.agentSkills || {}, selectedAgentRuntime || {});
    app.updateDesktopPluginSnapshot?.(selectedAgentRuntime?.plugins || {});
    state.installedAgentSkills = app.installedAgentSkillsForRuntime(selectedAgentRuntime || {});
    const resolvedRuntimePreferences = app.resolveRuntimeBackendChoice(state.runtimePreferences, selectedAgentRuntime || state.runtimePreferences);
    app.refreshSelectedBackendRuntime(resolvedRuntimePreferences.backendId || selectedAgentRuntime?.backendId || "");
    app.applyRuntimeDraft(app.runtimeChoiceWithFallback(app.currentRuntimeDraft(), state.runtimePreferences), {
      persist: false,
      dirty: state.runtimeDirty
    });
    app.refreshRuntimeDefaultOptions();
    app.refreshWorktreeModeControls?.();
    app.refreshTopbarProjectChip();
    app.setTopbarStatus(agentStatusText, agentOnline ? "online" : "idle");
    elements.codexStatusText.textContent = agentStatusText;
    const pendingDecisions = Number(codex.interactive?.pendingInteractions || 0) + Number(codex.interactive?.pendingApprovals || 0);
    elements.codexQueueMeta.textContent = agentAvailable
      ? `会话 ${codex.interactive?.activeSessions || 0} · 待处理 ${pendingDecisions} · 归档 ${codex.interactive?.archivedSessions || 0} · 项目 ${workspaces.length}`
      : workspaces.length
        ? `桌面离线 · 可浏览已同步会话 · 项目 ${workspaces.length}`
        : "打开桌面端后自动同步";

    const preferred = app.storedCodexProjectKey?.() || elements.codexProject.value;
    const visibleWorkspaces = app.workspacesForSelectedAgent(workspaces, state.selectedAgentId);
    const preferredWorkspace = app.workspaceForSelectionKey(preferred, visibleWorkspaces);
    const selectedWorkspace =
      preferredWorkspace ||
      (state.selectedAgentId ? null : app.workspaceForSelectionKey(preferred, workspaces)) ||
      (agentAvailable ? null : app.workspaceForProjectAndAgent(previousProject, previousTargetAgent, visibleWorkspaces)) ||
      visibleWorkspaces[0] ||
      workspaces[0] ||
      null;
    if (selectedWorkspace?.agentId && selectedWorkspace.agentId !== state.selectedAgentId) {
      state.selectedAgentId = selectedWorkspace.agentId;
      app.persistSelectedAgentId?.(state.selectedAgentId);
      const nextRuntime = app.runtimeForAgent(state.selectedAgentId, codex.runtime || {});
      state.codexBackendRuntimes = app.backendRuntimesForRuntime(nextRuntime);
      app.updateMcpSnapshot?.(nextRuntime?.mcp || {});
      app.updateAgentSkillSnapshot?.(nextRuntime?.agentSkills || {}, nextRuntime || {});
      app.updateDesktopPluginSnapshot?.(nextRuntime?.plugins || {});
      state.installedAgentSkills = app.installedAgentSkillsForRuntime(nextRuntime || {});
    }
    const selected = selectedWorkspace?.key || "";
    if (
      previousProject &&
      selectedWorkspace &&
      (previousProject !== selectedWorkspace.id || previousTargetAgent !== selectedWorkspace.agentId) &&
      agentOnline
    ) {
      state.composingNewSession = false;
      state.selectedCodexJobId = "";
      state.selectedCodexSession = null;
      app.closeCodexSessionStream?.();
    }
    app.renderCodexProjectOptions(app.workspacesForSelectedAgent(workspaces, state.selectedAgentId), selected, agentAvailable);
    if (elements.codexProject.value) app.persistCodexProjectKey?.(elements.codexProject.value);
    const preferenceScope = app.workspaceRuntimePreferenceScope?.();
    if (preferenceScope && preferenceScope.key !== state.runtimePreferenceScopeKey) {
      app.loadWorkspaceRuntimePreference?.().catch((error) => {
        if (!app.handleAuthError?.(error, "当前登录已失效，请重新登录。")) app.toast?.(error.message);
      });
    }
    app.refreshTopbarProjectChip();
    if (agentOnline && workspaces.length > 0) app.persistCodexWorkspaces(workspaces);
    app.renderProjectPicker(agentAvailable);
    app.renderAgentSkills();
    app.restoreComposerMode?.({ includeSession: Boolean(state.selectedCodexSession?.id) });
    app.updateComposerAvailability();
    app.syncComposerMetrics();
  };

  app.codexLastAgentSeenAt = function codexLastAgentSeenAt(codex = {}) {
    const direct = String(codex.lastAgentSeenAt || "").trim();
    if (direct) return direct;
    const agents = Array.isArray(codex.agents) ? codex.agents : [];
    return String(agents[0]?.lastSeenAt || "").trim();
  };

  app.codexAgentRecentlySeen = function codexAgentRecentlySeen(codex = {}) {
    const lastSeenMs = new Date(app.codexLastAgentSeenAt(codex)).getTime();
    return Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs < CODEX_AGENT_STATUS_GRACE_MS;
  };

  app.codexWorkspacesForStatus = function codexWorkspacesForStatus(codex = {}) {
    const hiddenKeys = new Set(app.codexHiddenWorkspaceKeys(codex));
    const filterHidden = (workspaces) => (workspaces || []).filter((workspace) => !hiddenKeys.has(workspace.key || workspace.id));
    const incoming = filterHidden(app.codexIncomingWorkspaces(codex));
    if (incoming.length > 0) return incoming;
    if (app.codexShouldDropWorkspaceCache(codex, incoming)) return incoming;

    const cached = filterHidden((state.codexWorkspaces || []).map(app.normalizeCodexWorkspace).filter(Boolean));
    if (codex.agentOnline && cached.length > 0) return cached;
    if (codex.agentOnline) return incoming;

    const projectId = app.currentProjectId();
    if (!projectId) return cached;
    return filterHidden(app.mergeCodexWorkspaces(cached, [app.cachedWorkspaceForProject(projectId)]));
  };

  app.codexHiddenWorkspaceKeys = function codexHiddenWorkspaceKeys(codex = {}) {
    return Array.isArray(codex.hiddenWorkspaceKeys)
      ? codex.hiddenWorkspaceKeys.map((key) => String(key || "").trim()).filter(Boolean)
      : [];
  };

  app.codexShouldDropWorkspaceCache = function codexShouldDropWorkspaceCache(codex = {}, incoming = app.codexIncomingWorkspaces(codex)) {
    if (!state.currentUser?.username) return false;
    if (Boolean(codex.agentOnline)) return false;
    if (!Array.isArray(codex.agents) || codex.agents.length > 0) return false;
    return incoming.length === 0;
  };

  app.codexIncomingWorkspaces = function codexIncomingWorkspaces(codex = {}) {
    return Array.isArray(codex.workspaces)
      ? codex.workspaces.map(app.normalizeCodexWorkspace).filter(Boolean)
      : [];
  };

  app.normalizeCodexAgent = function normalizeCodexAgent(agent = {}) {
    const source = agent && typeof agent === "object" ? agent : {};
    const id = String(source.id || source.agentId || "").trim();
    if (!id) return null;
    return {
      ...source,
      id,
      displayName: String(source.displayName || source.label || source.name || "").trim(),
      ownerUser: String(source.ownerUser || source.ownerUsername || "").trim(),
      online: source.online !== false,
      workspaces: Array.isArray(source.workspaces) ? source.workspaces.map(app.normalizeCodexWorkspace).filter(Boolean) : [],
      runtime: source.runtime && typeof source.runtime === "object" ? source.runtime : {}
    };
  };

  app.visibleCodexAgents = function visibleCodexAgents(workspaces = state.codexWorkspaces, agents = state.codexAgents) {
    const normalizedAgents = (agents || []).map(app.normalizeCodexAgent).filter(Boolean);
    const idsFromWorkspaces = new Set((workspaces || []).map((workspace) => workspace.agentId).filter(Boolean));
    const byId = new Map();
    for (const agent of normalizedAgents) {
      byId.set(agent.id, agent);
    }
    for (const workspace of workspaces || []) {
      if (!workspace.agentId || byId.has(workspace.agentId)) continue;
      byId.set(workspace.agentId, {
        id: workspace.agentId,
        displayName: workspace.agentLabel || workspace.agentId,
        ownerUser: workspace.agentOwnerUser || "",
        online: state.codexAvailableWorkspaceKeys?.includes(workspace.key) || false,
        workspaces: [],
        runtime: {}
      });
    }
    return Array.from(byId.values()).filter((agent) => byId.size <= 1 || idsFromWorkspaces.has(agent.id) || agent.online);
  };

  app.agentById = function agentById(agentId, agents = state.codexAgents) {
    const id = String(agentId || "").trim();
    if (!id) return null;
    return (agents || []).map(app.normalizeCodexAgent).filter(Boolean).find((agent) => agent.id === id) || null;
  };

  app.agentDisplayName = function agentDisplayName(agent = null) {
    if (!agent) return "";
    return String(agent.displayName || agent.label || agent.name || agent.id || "").trim();
  };

  app.agentIdFromWorkspaceKey = function agentIdFromWorkspaceKey(key = "") {
    return app.splitWorkspaceSelectionKey(key).agentId || "";
  };

  app.resolveSelectedAgentId = function resolveSelectedAgentId(preferred = "", workspaces = state.codexWorkspaces, agents = state.codexAgents) {
    const normalizedPreferred = String(preferred || "").trim();
    const visibleAgents = app.visibleCodexAgents(workspaces, agents);
    if (normalizedPreferred && visibleAgents.some((agent) => agent.id === normalizedPreferred)) return normalizedPreferred;
    const workspaceAgentIds = (workspaces || []).map((workspace) => workspace.agentId).filter(Boolean);
    const uniqueWorkspaceAgentIds = Array.from(new Set(workspaceAgentIds));
    if (uniqueWorkspaceAgentIds.length === 1) return uniqueWorkspaceAgentIds[0];
    const onlineAgent = visibleAgents.find((agent) => agent.online !== false);
    return onlineAgent?.id || visibleAgents[0]?.id || "";
  };

  app.workspacesForSelectedAgent = function workspacesForSelectedAgent(workspaces = state.codexWorkspaces, agentId = state.selectedAgentId) {
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) return workspaces || [];
    const filtered = (workspaces || []).filter((workspace) => !workspace.agentId || workspace.agentId === normalizedAgentId);
    return filtered.length > 0 ? filtered : workspaces || [];
  };

  app.runtimeForAgent = function runtimeForAgent(agentId = state.selectedAgentId, fallbackRuntime = {}) {
    const agent = app.agentById(agentId);
    if (agent?.runtime && Object.keys(agent.runtime).length > 0) return agent.runtime;
    return fallbackRuntime && typeof fallbackRuntime === "object" ? fallbackRuntime : {};
  };

  app.backendRuntimesForRuntime = function backendRuntimesForRuntime(runtime = {}) {
    if (Array.isArray(runtime?.backends) && runtime.backends.length > 0) return runtime.backends;
    return runtime && Object.keys(runtime).length > 0 ? [runtime] : [];
  };

  app.normalizeCodexWorkspace = function normalizeCodexWorkspace(workspace = {}) {
    const source = workspace && typeof workspace === "object" ? workspace : {};
    const id = String(source.workspaceId || source.projectId || source.id || "").trim();
    if (!id) return null;
    const agentId = String(source.agentId || "").trim();
    const key = String(source.key || (agentId ? `${agentId}:${id}` : id)).trim();
    return {
      id,
      workspaceId: id,
      key,
      label: String(source.label || source.id || source.path || "").trim() || id,
      path: String(source.path || "").trim(),
      agentId,
      agentLabel: String(source.agentLabel || source.agentName || source.agentId || "").trim(),
      agentOwnerUser: String(source.agentOwnerUser || "").trim()
    };
  };

  app.mergeCodexWorkspaces = function mergeCodexWorkspaces(...groups) {
    const byKey = new Map();
    for (const group of groups) {
      for (const workspace of group || []) {
        const normalized = app.normalizeCodexWorkspace(workspace);
        if (!normalized || byKey.has(normalized.key)) continue;
        byKey.set(normalized.key, normalized);
      }
    }
    return Array.from(byKey.values()).slice(0, 50);
  };

  app.workspaceForSelectionKey = function workspaceForSelectionKey(selectionKey, workspaces = state.codexWorkspaces) {
    const key = String(selectionKey || "").trim();
    if (!key) return null;
    const normalizedWorkspaces = (workspaces || []).map(app.normalizeCodexWorkspace).filter(Boolean);
    const exact = normalizedWorkspaces.find((workspace) => workspace.key === key);
    if (exact) return exact;
    const legacyMatches = normalizedWorkspaces.filter((workspace) => workspace.id === key || workspace.workspaceId === key);
    return legacyMatches.length === 1 ? legacyMatches[0] : null;
  };

  app.workspaceForProjectAndAgent = function workspaceForProjectAndAgent(projectId, targetAgentId = "", workspaces = state.codexWorkspaces) {
    const normalizedProjectId = String(projectId || "").trim();
    const normalizedTargetAgentId = String(targetAgentId || "").trim();
    if (!normalizedProjectId) return null;
    return (
      (workspaces || [])
        .map(app.normalizeCodexWorkspace)
        .filter(Boolean)
        .find(
          (workspace) =>
            (workspace.id === normalizedProjectId || workspace.workspaceId === normalizedProjectId) &&
            (!normalizedTargetAgentId || workspace.agentId === normalizedTargetAgentId)
        ) || null
    );
  };

  app.cachedWorkspaceForProject = function cachedWorkspaceForProject(projectId) {
    const key = String(projectId || "").trim();
    if (!key) return null;
    const existing = app.workspaceForSelectionKey(key);
    if (existing) return existing;
    const split = app.splitWorkspaceSelectionKey(key);
    const id = split.workspaceId || key;
    return (
      app.normalizeCodexWorkspace(app.workspaceForProjectAndAgent(id, split.agentId)) || {
        id,
        key: split.agentId ? key : id,
        label: id,
        path: "",
        agentId: split.agentId
      }
    );
  };

  app.splitWorkspaceSelectionKey = function splitWorkspaceSelectionKey(key) {
    const value = String(key || "").trim();
    const index = value.indexOf(":");
    if (index <= 0 || index === value.length - 1) return { agentId: "", workspaceId: value };
    return {
      agentId: value.slice(0, index),
      workspaceId: value.slice(index + 1)
    };
  };

  app.persistCodexWorkspaces = function persistCodexWorkspaces(workspaces = []) {
    const normalized = app.mergeCodexWorkspaces(workspaces);
    if (normalized.length === 0) return;
    app.writeScopedStorage?.("echoCodexWorkspaces", JSON.stringify(normalized));
  };

  app.renderCodexProjectOptions = function renderCodexProjectOptions(workspaces, selected, agentOnline) {
    elements.codexProject.innerHTML = "";
    if (!workspaces.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = agentOnline ? "还没有工程" : "等待桌面 agent";
      elements.codexProject.append(option);
      return;
    }
    for (const workspace of workspaces) {
      const option = document.createElement("option");
      option.value = workspace.key || workspace.id;
      option.textContent = workspace.agentLabel ? `${workspace.label || workspace.id} · ${workspace.agentLabel}` : workspace.label || workspace.id || workspace.path;
      option.title = workspace.path || "";
      option.selected = (workspace.key || workspace.id) === selected;
      elements.codexProject.append(option);
    }
    if (selected && workspaces.some((workspace) => (workspace.key || workspace.id) === selected)) {
      elements.codexProject.value = selected;
    } else if (!elements.codexProject.value && workspaces[0]) {
      elements.codexProject.value = workspaces[0].key || workspaces[0].id || "";
    }
  };

  app.markCodexConnectionProblem = function markCodexConnectionProblem(message = "连接中断，当前会话已保留。") {
    const wasAlreadyError = state.codexConnectionState === "error";
    state.codexConnectionState = "error";
    state.codexAgentOnline = false;
    state.codexAgentAvailable = false;
    const currentWorkspace = app.currentWorkspace();
    const projectKey = currentWorkspace?.key || state.codexWorkspaces?.[0]?.key || "";
    if (projectKey) {
      state.codexWorkspaces = app.mergeCodexWorkspaces(state.codexWorkspaces, [app.cachedWorkspaceForProject(projectKey)]);
      app.renderCodexProjectOptions(state.codexWorkspaces, projectKey, false);
    } else if (state.codexWorkspaces?.length) {
      app.renderCodexProjectOptions(state.codexWorkspaces, state.codexWorkspaces[0]?.key || "", false);
    }
    if (elements.codexProject.value) app.persistCodexProjectKey?.(elements.codexProject.value);
    app.setTopbarStatus("连接中断", "error");
    elements.codexStatusText.textContent = "连接中断";
    elements.codexQueueMeta.textContent = message;
    app.renderProjectPicker(false);
    app.updateComposerAvailability();
    return !wasAlreadyError;
  };

  app.openSessionSidebar = function openSessionSidebar() {
    app.closeFileBrowser?.({ restoreFocus: false });
    app.closeOpenSpecPanel?.({ restoreFocus: false });
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeProjectImportPanel?.({ restoreFocus: false });
    app.setSidebarPreferencesOpen?.(false);
    elements.codexView.classList.add("sessions-open");
    app.setTopbarCollapsed(false);
    elements.sessionBackdrop.hidden = false;
    elements.sessionBackdrop.dataset.layer = "sessions";
    elements.sessionBackdrop.setAttribute("aria-label", "关闭会话列表");
    app.updateSessionSidebarToggle(true);
    app.syncBodySheetState();
  };

  app.closeSessionSidebar = function closeSessionSidebar({ restoreFocus = true } = {}) {
    elements.codexView.classList.remove("sessions-open");
    elements.sessionBackdrop.hidden = true;
    delete elements.sessionBackdrop.dataset.layer;
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeAgentSkillPanel?.({ restoreFocus: false });
    app.closeDesktopPluginPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeProjectImportPanel?.({ restoreFocus: false });
    app.setSidebarPreferencesOpen?.(false);
    app.closeProjectSwitcher?.();
    app.updateSessionSidebarToggle(false);
    app.syncBodySheetState();
    app.resetTopbarScrollTracking({ forceVisible: true });
    if (restoreFocus) {
      elements.toggleSessionsButton.focus({ preventScroll: true });
    }
  };

  app.openProjectSwitcher = function openProjectSwitcher() {
    app.closeQuickSkillsPanel?.();
    app.closeAgentSkillsPanel?.();
    app.closeMcpPanel?.();
    app.closeAgentSkillPanel?.();
    app.closeDesktopPluginPanel?.();
    app.closeAdminPanel?.();
    app.closeAccountPanel?.();
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeProjectImportPanel?.({ restoreFocus: false });
    app.setTopbarCollapsed(false);
    app.renderProjectSheetList();
    app.updateProjectCreateControls();
  };

  app.openMobileSettingsPage = function openMobileSettingsPage(event) {
    event?.stopPropagation();
    if (!elements.mobileSettingsPanel) return;
    app.closeProjectImportPanel?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeAgentSkillPanel?.({ restoreFocus: false });
    app.closeDesktopPluginPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.closeQuickSkillsPanel?.();
    app.closeAgentSkillsPanel?.();
    app.closeRuntimeSelectPopover?.();
    if (elements.mobileSettingsMeta) {
      elements.mobileSettingsMeta.textContent = app.agentDisplayName(app.agentById(state.selectedAgentId)) || "Echo";
    }
    elements.mobileSettingsPanel.hidden = false;
    elements.mobileSettingsPanel.closest?.(".session-sidebar")?.classList.add("mobile-settings-page-open");
    elements.mobileSettingsButton?.setAttribute("aria-expanded", "true");
    app.window?.requestAnimationFrame?.(() => {
      elements.mobileSettingsCloseButton?.focus?.({ preventScroll: true });
    });
  };

  app.closeMobileSettingsPage = function closeMobileSettingsPage({ restoreFocus = false } = {}) {
    if (!elements.mobileSettingsPanel || elements.mobileSettingsPanel.hidden) return;
    elements.mobileSettingsPanel.hidden = true;
    elements.mobileSettingsPanel.closest?.(".session-sidebar")?.classList.remove("mobile-settings-page-open");
    elements.mobileSettingsButton?.setAttribute("aria-expanded", "false");
    if (restoreFocus) elements.mobileSettingsButton?.focus({ preventScroll: true });
  };

  app.toggleSidebarPreferences = function toggleSidebarPreferences(event) {
    event?.stopPropagation();
    const open = !elements.sidebarPreferences?.classList.contains("is-open");
    app.setSidebarPreferencesOpen(open);
  };

  app.setSidebarPreferencesOpen = function setSidebarPreferencesOpen(open) {
    if (!elements.sidebarPreferences) return;
    elements.sidebarPreferences.classList.toggle("is-open", Boolean(open));
    elements.sidebarPreferencesToggle?.setAttribute("aria-expanded", open ? "true" : "false");
    elements.sidebarPreferencesToggle?.setAttribute("aria-label", open ? "收起偏好" : "展开偏好");
    elements.sidebarPreferencesToggle?.setAttribute("title", open ? "收起偏好" : "展开偏好");
    const label = elements.sidebarPreferencesToggle?.querySelector?.(".sidebar-preferences-toggle-label");
    if (label) label.textContent = open ? "收起" : "展开";
  };

  app.closeProjectSwitcher = function closeProjectSwitcher() {
    if (!state.projectCreateBusy && elements.projectCreateForm) {
      elements.projectCreateForm.hidden = true;
      if (elements.projectSheetStatus) elements.projectSheetStatus.textContent = "";
    }
  };

  app.toggleProjectSwitcher = function toggleProjectSwitcher(event) {
    event?.stopPropagation();
    app.openProjectSwitcher();
  };

  app.handleDocumentClick = function handleDocumentClick(event) {
    if (!event.target.closest?.(".project-tree-actions")) app.closeProjectActionMenus?.();
    if (
      elements.agentSkillsPanel &&
      !elements.agentSkillsPanel.hidden &&
      !elements.agentSkillsPanel.contains(event.target) &&
      !elements.agentSkillsButton?.contains(event.target)
    ) {
      app.closeAgentSkillsPanel();
    }
    if (elements.quickSkills && !elements.quickSkillsPanel?.hidden && !elements.quickSkills.contains(event.target)) {
      app.closeQuickSkillsPanel();
    }
  };

  app.closeProjectActionMenus = function closeProjectActionMenus(except = null) {
    for (const actions of elements.projectSheetList?.querySelectorAll?.(".project-tree-actions.is-open") || []) {
      if (actions === except) continue;
      actions.classList.remove("is-open");
      actions.querySelector(".project-tree-more")?.setAttribute("aria-expanded", "false");
    }
  };

  app.toggleSessionSidebar = function toggleSessionSidebar() {
    if (elements.codexView.classList.contains("sessions-open")) {
      app.closeSessionSidebar();
      return;
    }
    app.openSessionSidebar();
  };

  app.updateSessionSidebarToggle = function updateSessionSidebarToggle(isOpen) {
    const label = isOpen ? "关闭会话列表" : "打开会话列表";
    elements.toggleSessionsButton.textContent = isOpen ? "✕" : "☰";
    elements.toggleSessionsButton.setAttribute("aria-label", label);
    elements.toggleSessionsButton.setAttribute("title", label);
    elements.toggleSessionsButton.setAttribute("aria-expanded", isOpen ? "true" : "false");
  };

  app.syncBodySheetState = function syncBodySheetState() {
    document.body.classList.toggle(
      "sheet-open",
      elements.codexView.classList.contains("sessions-open") ||
        elements.codexView.classList.contains("files-open") ||
        elements.codexView.classList.contains("open-spec-open")
    );
  };

  app.setSessionArchiveView = async function setSessionArchiveView(archived) {
    if (state.showArchivedSessions === archived) return;
    state.showArchivedSessions = archived;
    elements.showActiveSessionsButton.classList.toggle("active", !archived);
    elements.showArchivedSessionsButton.classList.toggle("active", archived);
    state.composingNewSession = false;
    state.selectedCodexJobId = "";
    state.selectedCodexSession = null;
    app.closeCodexSessionStream?.();
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    app.renderEmptySessionDetail(
      archived
        ? { title: "归档", body: "归档会话只保留查看和恢复。" }
        : { title: "新会话", body: "选择权限、模型和推理强度后直接发送。" }
    );
    await app.loadCodexJobs();
  };

  app.startNewCodexSession = function startNewCodexSession() {
    state.selectedCodexJobId = "";
    state.selectedCodexSession = null;
    state.composingNewSession = true;
    app.closeCodexSessionStream?.();
    app.clearComposerAttachments({ silent: true });
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    if (state.showArchivedSessions) {
      state.showArchivedSessions = false;
      elements.showActiveSessionsButton.classList.add("active");
      elements.showArchivedSessionsButton.classList.remove("active");
      app.loadCodexJobs().catch(() => {});
    }
    app.closeSessionSidebar({ restoreFocus: false });
    app.renderEmptySessionDetail({
      title: "新会话",
      body: "选择权限、模型和推理强度后直接发送。"
    });
    app.resetTopbarScrollTracking({ forceVisible: true });
    for (const button of elements.codexJobs.querySelectorAll(".conversation-item")) {
      button.classList.remove("active");
    }
    app.restoreComposerMode?.({ includeSession: false });
    app.updateComposerAvailability();
    elements.codexPrompt.focus({ preventScroll: true });
  };

  app.sendToCodex = async function sendToCodex() {
    if (state.composerBusy) return;
    if (!app.ensurePaired()) return;
    if (app.hasPendingComposerAttachments()) {
      app.toast("附件还在处理中，请稍候再发送");
      return;
    }

    const rawPrompt = elements.codexPrompt.value.trim();
    const attachments = app.currentComposerAttachmentsPayload();
    const projectId = app.currentProjectId();
    const targetAgentId = app.currentTargetAgentId();
    const runtimeDraft = app.currentRuntimeDraft();
    const mode = app.currentComposerMode();
    if (!rawPrompt && attachments.length === 0) {
      app.toast("请先填写任务或附上文件");
      return;
    }
    if (!projectId) {
      app.toast("桌面 agent 还没有公布项目");
      return;
    }
    if (!app.codexCommandsAvailable()) {
      app.toast(state.codexConnectionState === "error" ? "连接恢复后再发送" : "桌面 agent 在线后再发送");
      return;
    }
    try {
      app.runtimeForAttachments(runtimeDraft, attachments);
    } catch (error) {
      app.toast(error.message);
      return;
    }
    const runtime = app.runtimeForAttachments(runtimeDraft, attachments);

    app.persistCodexProjectKey?.(app.currentWorkspace()?.key || projectId);
    app.persistComposerMode(mode);
    if (attachments.length > 0 && runtime.model !== runtimeDraft.model) {
      app.applyRuntimeDraft(runtime, { persist: true, dirty: true });
      app.toast("附件消息会自动使用桌面默认模型");
    }
    app.setComposerBusy(true, "发送中");
    try {
      const data = await app.sendCodexPrompt({ projectId, targetAgentId, prompt: rawPrompt, runtime, attachments, mode });
      if (state.showArchivedSessions) {
        state.showArchivedSessions = false;
        elements.showActiveSessionsButton.classList.add("active");
        elements.showArchivedSessionsButton.classList.remove("active");
      }
      state.selectedCodexJobId = data.session.id;
      state.selectedCodexSession = data.session;
      state.composingNewSession = false;
      state.runtimeDirty = false;
      app.applyRuntimeDraft(state.selectedCodexSession.runtime || runtime, { persist: false, dirty: false });
      if (mode === "plan") app.setComposerPlanMode(false);
      app.renderCodexJob(data.session, { keepSelection: true, scrollToBottom: true });
      elements.codexPrompt.value = "";
      app.syncComposerInputHeight();
      app.clearComposerAttachments({ silent: true });
      await app.showCodexJob(data.session.id, { keepSelection: true, scrollToBottom: true });
      app.scheduleSessionListRefresh?.({ delayMs: 300 });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    } finally {
      app.setComposerBusy(false);
    }
  };

  app.loadQuickSkills = async function loadQuickSkills({ silent = false } = {}) {
    if (!app.canUseWorkbench?.()) return;
    const projectId = app.currentProjectId();
    const targetAgentId = app.currentTargetAgentId();
    const workspaceKey = app.currentWorkspace?.()?.key || projectId;
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (targetAgentId) params.set("targetAgentId", targetAgentId);

    try {
      const data = await app.apiGet(`/api/codex/quick-skills?${params.toString()}`);
      state.quickSkills = Array.isArray(data.items) ? data.items.map(app.normalizeQuickSkill).filter(Boolean) : [];
      state.quickSkillsLoadedProjectId = workspaceKey;
      app.renderQuickSkills();
      app.updateComposerAvailability();
    } catch (error) {
      if (!silent && !app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
    }
  };

  app.normalizeQuickSkill = function normalizeQuickSkill(skill = {}) {
    const id = String(skill.id || "").trim();
    const scope = String(skill.scope || "").trim();
    const title = String(skill.title || "").trim();
    const prompt = String(skill.prompt || "").trim();
    if (!id || (scope !== "global" && scope !== "project") || !title || !prompt) return null;
    return {
      id,
      scope,
      projectId: String(skill.projectId || "").trim(),
      targetAgentId: String(skill.targetAgentId || "").trim(),
      title: title.slice(0, 80),
      prompt: prompt.slice(0, 12000),
      mode: String(skill.mode || "execute").trim() === "plan" ? "plan" : "execute",
      requiresSession: Boolean(skill.requiresSession),
      sortOrder: Number(skill.sortOrder || 0),
      createdAt: String(skill.createdAt || ""),
      updatedAt: String(skill.updatedAt || "")
    };
  };

  app.quickSkillIconMarkup = function quickSkillIconMarkup(skill = {}, usedIconVariants = null) {
    const key = skill.id || skill.title || "quick-skill";
    const variant = QUICK_SKILL_ICON_VARIANTS[quickSkillIconVariantIndex(key, usedIconVariants)];
    return `
      <span
        class="quick-skill-icon"
        style="--quick-skill-icon-bg: ${variant.bg}; --quick-skill-icon-fg: ${variant.fg};"
        aria-hidden="true"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" focusable="false">
          ${variant.body}
        </svg>
      </span>
    `;
  };

  app.toggleQuickSkillsPanel = async function toggleQuickSkillsPanel(event) {
    event?.stopPropagation();
    if (!elements.quickSkillsPanel) return;
    if (elements.quickSkillsPanel.hidden) {
      await app.openQuickSkillsPanel();
      return;
    }
    app.closeQuickSkillsPanel({ restoreFocus: true });
  };

  app.openQuickSkillsPanel = async function openQuickSkillsPanel() {
    if (!elements.quickSkillsPanel) return;
    app.closeAgentSkillsPanel?.();
    app.closeMcpPanel?.();
    app.closeProjectSwitcher();
    app.setTopbarCollapsed(false);
    elements.quickSkillsPanel.hidden = false;
    elements.quickSkillsButton?.setAttribute("aria-expanded", "true");
    if (state.quickSkillsLoadedProjectId !== (app.currentWorkspace?.()?.key || app.currentProjectId())) await app.loadQuickSkills({ silent: true });
    app.renderQuickSkills();
  };

  app.closeQuickSkillsPanel = function closeQuickSkillsPanel({ restoreFocus = false } = {}) {
    if (!elements.quickSkillsPanel || elements.quickSkillsPanel.hidden) return;
    elements.quickSkillsPanel.hidden = true;
    elements.quickSkillsButton?.setAttribute("aria-expanded", "false");
    app.resetQuickSkillForm();
    if (restoreFocus) elements.quickSkillsButton?.focus({ preventScroll: true });
  };

  app.installedAgentSkillsForRuntime = function installedAgentSkillsForRuntime(runtime = {}) {
    const collected = [];
    if (Array.isArray(runtime.installedSkills)) collected.push(...runtime.installedSkills);
    for (const backend of Array.isArray(runtime.backends) ? runtime.backends : []) {
      if (Array.isArray(backend.installedSkills)) collected.push(...backend.installedSkills);
    }
    const byName = new Map();
    for (const skill of collected) {
      const normalized = app.normalizeInstalledAgentSkill(skill);
      if (!normalized) continue;
      if (!normalized.enabled || !normalized.showInComposer) continue;
      if (!app.agentSkillAvailableForCurrentBackend(normalized)) continue;
      const existing = byName.get(normalized.name);
      if (!existing) {
        byName.set(normalized.name, normalized);
        continue;
      }
      existing.providers = app.mergeSkillProviders(existing.providers, normalized.providers);
      if (!existing.description && normalized.description) existing.description = normalized.description;
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  };

  app.normalizeInstalledAgentSkill = function normalizeInstalledAgentSkill(skill = {}) {
    const name = String(skill.name || "").trim();
    if (!name) return null;
    const providers = Array.isArray(skill.providers)
      ? skill.providers
          .map((provider) => ({
            provider: String(provider?.provider || "").trim(),
            label: String(provider?.label || provider?.provider || "").trim(),
            installed: provider?.installed !== false,
            enabled: provider?.enabled === undefined ? true : provider.enabled === true,
            syncState: String(provider?.syncState || "").trim()
          }))
          .filter((provider) => provider.provider)
      : [];
    return {
      id: String(skill.id || "").trim(),
      name,
      description: String(skill.description || "").trim(),
      providers,
      folder: String(skill.folder || "").trim(),
      enabled: skill.enabled !== false,
      showInComposer: skill.showInComposer !== false,
      syncState: String(skill.syncState || "").trim()
    };
  };

  app.agentSkillAvailableForCurrentBackend = function agentSkillAvailableForCurrentBackend(skill = {}) {
    const providers = Array.isArray(skill.providers) ? skill.providers : [];
    if (providers.length === 0) return true;
    const backendIds = app.currentAgentSkillBackendIds();
    if (backendIds.size === 0) return true;
    return providers.some((provider) => {
      if (!backendIds.has(provider.provider)) return false;
      if (provider.enabled === false) return false;
      if (["failed", "disabled"].includes(provider.syncState)) return false;
      return provider.installed !== false;
    });
  };

  app.currentAgentSkillBackendIds = function currentAgentSkillBackendIds() {
    const runtime = app.currentBackendRuntime?.() || {};
    return new Set(
      [
        elements.codexBackend?.value,
        runtime.backendId,
        runtime.provider,
        runtime.backendName
      ]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    );
  };

  app.mergeSkillProviders = function mergeSkillProviders(existing = [], incoming = []) {
    const byProvider = new Map();
    for (const provider of [...existing, ...incoming]) {
      if (provider?.provider) byProvider.set(provider.provider, provider);
    }
    return Array.from(byProvider.values());
  };

  app.toggleAgentSkillsPanel = function toggleAgentSkillsPanel(event) {
    event?.stopPropagation();
    if (!elements.agentSkillsPanel) return;
    if (elements.agentSkillsPanel.hidden) {
      app.openAgentSkillsPanel();
      return;
    }
    app.closeAgentSkillsPanel({ restoreFocus: true });
  };

  app.openAgentSkillsPanel = function openAgentSkillsPanel() {
    if (!elements.agentSkillsPanel) return;
    app.closeQuickSkillsPanel();
    app.closeMcpPanel?.();
    app.closeProjectSwitcher();
    app.renderAgentSkills();
    elements.agentSkillsPanel.hidden = false;
    elements.agentSkillsButton?.setAttribute("aria-expanded", "true");
  };

  app.closeAgentSkillsPanel = function closeAgentSkillsPanel({ restoreFocus = false } = {}) {
    if (!elements.agentSkillsPanel || elements.agentSkillsPanel.hidden) return;
    elements.agentSkillsPanel.hidden = true;
    elements.agentSkillsButton?.setAttribute("aria-expanded", "false");
    if (restoreFocus) elements.agentSkillsButton?.focus({ preventScroll: true });
  };

  app.renderAgentSkills = function renderAgentSkills() {
    if (!elements.agentSkillsList) return;
    const skills = Array.isArray(state.installedAgentSkills) ? state.installedAgentSkills : [];
    if (elements.agentSkillsMeta) {
      elements.agentSkillsMeta.textContent = skills.length ? `${skills.length} 个可用` : "本机尚未同步";
    }
    elements.agentSkillsList.innerHTML = "";
    if (skills.length === 0) {
      elements.agentSkillsList.innerHTML = '<div class="agent-skills-empty">还没有从桌面端同步到已安装 skills。</div>';
      return;
    }
    for (const skill of skills) {
      elements.agentSkillsList.append(app.renderAgentSkillButton(skill));
    }
  };

  app.renderAgentSkillButton = function renderAgentSkillButton(skill) {
    const button = document.createElement("button");
    button.className = "agent-skill-button";
    button.type = "button";
    const providers = app.installedSkillProviderLabel(skill);
    button.innerHTML = `
      <span class="agent-skill-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" focusable="false">
          <path d="M12 3.5 13.7 8l4.6 1.7-4.6 1.7L12 16l-1.7-4.6-4.6-1.7L10.3 8 12 3.5Z" />
          <path d="M5.4 14.4l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1Z" />
        </svg>
      </span>
      <span class="agent-skill-copy">
        <strong>${app.escapeHtml(skill.name)}</strong>
        <span>${app.escapeHtml(skill.description || providers || "已安装 skill")}</span>
      </span>
    `;
    button.title = providers ? `${skill.name} · ${providers}` : skill.name;
    button.addEventListener("click", () => app.insertAgentSkillInvocation(skill));
    return button;
  };

  app.installedSkillProviderLabel = function installedSkillProviderLabel(skill = {}) {
    const providers = Array.isArray(skill.providers) ? skill.providers : [];
    return providers.map((provider) => provider.label || provider.provider).filter(Boolean).join(" · ");
  };

  app.insertAgentSkillInvocation = function insertAgentSkillInvocation(skill = {}) {
    const name = String(skill.name || "").trim();
    if (!name || !elements.codexPrompt) return;
    const invocation = `$${name}`;
    const current = elements.codexPrompt.value.trim();
    elements.codexPrompt.value = current.startsWith(invocation) ? current : current ? `${invocation} ${current}` : `${invocation} `;
    app.closeAgentSkillsPanel({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    elements.codexPrompt.focus({ preventScroll: true });
    elements.codexPrompt.selectionStart = elements.codexPrompt.value.length;
    elements.codexPrompt.selectionEnd = elements.codexPrompt.value.length;
    app.syncComposerInputHeight();
    app.updateComposerAvailability();
    app.toast(`已插入 ${invocation}`);
  };

  app.renderQuickSkills = function renderQuickSkills() {
    if (!elements.quickSkillsList) return;
    const projectId = app.currentProjectId();
    const projectLabel = projectId ? app.sessionProjectLabel(projectId, app.currentTargetAgentId()) : "未选择工程";
    const globalSkills = state.quickSkills.filter((skill) => skill.scope === "global");
    const projectSkills = state.quickSkills.filter((skill) => skill.scope === "project");
    if (elements.quickSkillsMeta) {
      elements.quickSkillsMeta.textContent = `${globalSkills.length} 个全局 · ${projectSkills.length} 个项目`;
    }

    elements.quickSkillsList.innerHTML = "";
    if (state.quickSkills.length === 0) {
      elements.quickSkillsList.innerHTML = '<div class="quick-skills-empty">还没有快速指令。</div>';
      return;
    }

    const groups = [
      { title: "全局", meta: "所有项目可用", items: globalSkills },
      { title: "项目", meta: projectLabel, items: projectSkills }
    ];
    const usedIconVariants = new Set();
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "quick-skill-group";
      section.innerHTML = `
        <div class="quick-skill-group-head">
          <strong>${app.escapeHtml(group.title)}</strong>
          <span>${app.escapeHtml(group.meta)}</span>
        </div>
      `;
      const wheel = document.createElement("div");
      wheel.className = "quick-skill-wheel";
      if (group.items.length === 0) {
        wheel.innerHTML = '<div class="quick-skills-empty compact">暂无</div>';
      } else {
        for (const skill of group.items) {
          wheel.append(app.renderQuickSkillButton(skill, usedIconVariants));
        }
      }
      section.append(wheel);
      elements.quickSkillsList.append(section);
    }
  };

  app.renderQuickSkillButton = function renderQuickSkillButton(skill, usedIconVariants = null) {
    const item = document.createElement("div");
    item.className = "quick-skill-item";
    item.dataset.skillId = skill.id;
    item.innerHTML = `
      <button class="quick-skill-run" type="button">
        ${app.quickSkillIconMarkup(skill, usedIconVariants)}
        <span class="quick-skill-copy">
          <strong>${app.escapeHtml(skill.title)}</strong>
        </span>
      </button>
      <button class="quick-skill-edit" type="button" aria-label="编辑 ${app.escapeHtml(skill.title)}" title="编辑">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 19h3.4L18.7 8.7a2.1 2.1 0 0 0-3-3L5.4 16 5 19Z"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.8"
          />
          <path d="m14.4 7 2.6 2.6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
        </svg>
      </button>
    `;
    item.querySelector(".quick-skill-run").addEventListener("click", () => app.sendQuickSkill(skill));
    item.querySelector(".quick-skill-edit").addEventListener("click", () => app.editQuickSkill(skill.id));
    return item;
  };

  app.sendQuickSkill = async function sendQuickSkill(skill) {
    if (state.composerBusy) return;
    if (!app.ensurePaired()) return;
    if (app.hasPendingComposerAttachments()) {
      app.toast("附件还在处理中，请稍候再发送");
      return;
    }
    if (elements.codexPrompt.value.trim() || state.composerAttachments.length > 0) {
      app.toast("请先发送或清空输入框内容");
      return;
    }

    const projectId = app.currentProjectId();
    const targetAgentId = app.currentTargetAgentId();
    if (!projectId) {
      app.toast("桌面 agent 还没有公布项目");
      return;
    }
    if (!app.codexCommandsAvailable()) {
      app.toast(state.codexConnectionState === "error" ? "连接恢复后再发送" : "桌面 agent 在线后再发送");
      return;
    }
    const mode = app.currentComposerMode();
    app.persistCodexProjectKey?.(app.currentWorkspace()?.key || projectId);
    app.closeQuickSkillsPanel();
    app.setComposerBusy(true, "发送中");
    try {
      const runtime = app.currentRuntimeDraft();
      const data = await app.sendCodexPrompt({ projectId, targetAgentId, prompt: skill.prompt, runtime, attachments: [], mode });
      state.selectedCodexJobId = data.session.id;
      state.selectedCodexSession = data.session;
      state.composingNewSession = false;
      state.runtimeDirty = false;
      app.applyRuntimeDraft(state.selectedCodexSession.runtime || runtime, { persist: false, dirty: false });
      app.renderCodexJob(data.session, { keepSelection: true, scrollToBottom: true });
      await app.showCodexJob(data.session.id, { keepSelection: true, scrollToBottom: true });
      app.scheduleSessionListRefresh?.({ delayMs: 300 });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    } finally {
      app.setComposerBusy(false);
    }
  };

  app.startNewQuickSkill = function startNewQuickSkill(scope = "global") {
    const normalizedScope = String(scope || "").trim();
    if (normalizedScope !== "global" && normalizedScope !== "project") return;
    if (normalizedScope === "project" && !app.currentProjectId()) {
      app.toast("先选择工程");
      return;
    }
    app.fillQuickSkillForm({
      id: "",
      scope: normalizedScope,
      projectId: app.currentProjectId(),
      targetAgentId: app.currentTargetAgentId(),
      title: "",
      prompt: ""
    });
  };

  app.editQuickSkill = function editQuickSkill(id) {
    const skill = state.quickSkills.find((item) => item.id === id);
    if (!skill) return;
    app.fillQuickSkillForm(skill);
  };

  app.fillQuickSkillForm = function fillQuickSkillForm(skill) {
    const scope = String(skill.scope || "").trim();
    if (scope !== "global" && scope !== "project") return;
    state.quickSkillEditingId = skill.id || "";
    elements.quickSkillForm.hidden = false;
    if (elements.quickSkillsPanel) elements.quickSkillsPanel.dataset.formOpen = "true";
    elements.quickSkillId.value = skill.id || "";
    elements.quickSkillTitle.value = skill.title || "";
    elements.quickSkillScope.value = scope;
    elements.quickSkillPrompt.value = skill.prompt || "";
    elements.quickSkillDeleteButton.hidden = !skill.id;
    elements.quickSkillSaveButton.textContent = skill.id ? "保存" : "创建";
    if (elements.quickSkillFormTitle) {
      const scopeLabel = elements.quickSkillScope.value === "global" ? "全局" : "项目";
      elements.quickSkillFormTitle.textContent = skill.id ? "编辑指令" : `新增${scopeLabel}指令`;
    }
    app.updateQuickSkillFormControls();
    elements.quickSkillTitle.focus({ preventScroll: true });
  };

  app.resetQuickSkillForm = function resetQuickSkillForm() {
    if (!elements.quickSkillForm) return;
    state.quickSkillEditingId = "";
    elements.quickSkillForm.hidden = true;
    if (elements.quickSkillsPanel) elements.quickSkillsPanel.dataset.formOpen = "";
    elements.quickSkillId.value = "";
    elements.quickSkillTitle.value = "";
    elements.quickSkillScope.value = "global";
    elements.quickSkillPrompt.value = "";
    elements.quickSkillDeleteButton.hidden = true;
    if (elements.quickSkillFormTitle) elements.quickSkillFormTitle.textContent = "编辑指令";
    app.updateQuickSkillFormControls();
  };

  app.updateQuickSkillFormControls = function updateQuickSkillFormControls() {
    if (!elements.quickSkillForm) return;
    const disabled = state.quickSkillsBusy;
    for (const control of [
      elements.quickSkillTitle,
      elements.quickSkillScope,
      elements.quickSkillPrompt,
      elements.quickSkillDeleteButton,
      elements.quickSkillCancelButton,
      elements.quickSkillSaveButton
    ]) {
      if (control) control.disabled = disabled;
    }
    if (elements.quickSkillNewGlobalButton) elements.quickSkillNewGlobalButton.disabled = disabled;
    if (elements.quickSkillNewProjectButton) elements.quickSkillNewProjectButton.disabled = disabled || !app.currentProjectId();
  };

  app.saveQuickSkill = async function saveQuickSkill(event) {
    event?.preventDefault();
    if (!app.ensurePaired()) return;
    const id = elements.quickSkillId.value.trim();
    const scope = String(elements.quickSkillScope.value || "").trim();
    if (scope !== "global" && scope !== "project") {
      app.toast("快速指令范围无效");
      return;
    }
    const body = {
      scope,
      projectId: scope === "project" ? app.currentProjectId() : "",
      targetAgentId: scope === "project" ? app.currentTargetAgentId() : "",
      title: elements.quickSkillTitle.value.trim(),
      prompt: elements.quickSkillPrompt.value.trim()
    };
    if (!body.title || !body.prompt) {
      app.toast("名称和指令不能为空");
      return;
    }
    if (body.scope === "project" && !body.projectId) {
      app.toast("先选择工程");
      return;
    }

    state.quickSkillsBusy = true;
    app.updateQuickSkillFormControls();
    try {
      if (id) {
        await app.apiPost(`/api/codex/quick-skills/${encodeURIComponent(id)}`, body);
        app.toast("已保存");
      } else {
        await app.apiPost("/api/codex/quick-skills", body);
        app.toast("已创建");
      }
      app.resetQuickSkillForm();
      await app.loadQuickSkills();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
    } finally {
      state.quickSkillsBusy = false;
      app.updateQuickSkillFormControls();
    }
  };

  app.deleteEditingQuickSkill = async function deleteEditingQuickSkill() {
    const id = elements.quickSkillId.value.trim();
    if (!id) return;
    state.quickSkillsBusy = true;
    app.updateQuickSkillFormControls();
    try {
      await app.apiPost(`/api/codex/quick-skills/${encodeURIComponent(id)}/delete`, {});
      app.toast("已删除");
      app.resetQuickSkillForm();
      await app.loadQuickSkills();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
    } finally {
      state.quickSkillsBusy = false;
      app.updateQuickSkillFormControls();
    }
  };

  app.sendCodexPrompt = async function sendCodexPrompt({ projectId, targetAgentId, prompt, runtime, attachments, mode = "execute" }) {
    await app.ensureWorkspaceRuntimePreferenceReady?.();
    runtime = app.currentRuntimeDraft?.() || runtime;
    if (app.canContinueSelectedSession()) {
      const body = {
        projectId,
        text: prompt,
        runtime,
        attachments,
        mode
      };
      if (targetAgentId) body.targetAgentId = targetAgentId;
      return app.apiPost(`/api/codex/sessions/${encodeURIComponent(state.selectedCodexJobId)}/messages`, body);
    }
    if (!app.canStartNewSessionFromComposer()) {
      throw new Error("当前会话不能继续，请先从左上角新建会话。");
    }
    const body = { projectId, prompt, runtime, attachments, mode };
    if (targetAgentId) body.targetAgentId = targetAgentId;
    return app.apiPost("/api/codex/sessions", body);
  };

  app.canContinueSelectedSession = function canContinueSelectedSession() {
    return app.sessionCanAcceptFollowUp(app.selectedSessionForComposer());
  };

  app.sessionAwaitsPlanFollowUp = function sessionAwaitsPlanFollowUp(session) {
    const events = Array.isArray(session?.events) ? session.events : [];
    for (const event of [...events].reverse()) {
      if (event?.type !== "user.message") continue;
      const mode = app.normalizeComposerMode(event.raw?.mode || event.raw?.payload?.mode);
      if (mode) return mode === "plan";
    }
    return false;
  };

  app.selectedSessionForComposer = function selectedSessionForComposer() {
    if (state.composingNewSession) return null;
    if (!state.selectedCodexJobId || !state.selectedCodexSession) return null;
    if (!app.sessionBelongsToCurrentProject(state.selectedCodexSession)) return null;
    return state.selectedCodexSession;
  };

  app.canRunSessionQuickSkill = function canRunSessionQuickSkill() {
    const session = app.selectedSessionForComposer();
    return Boolean(session && app.sessionCanAcceptFollowUp(session) && !app.sessionHasPendingWork(session));
  };

  app.toggleComposerPlanMode = function toggleComposerPlanMode() {
    const lockedMode = app.lockedActiveTurnComposerMode?.();
    if (lockedMode) {
      app.toast?.("当前轮正在运行，完成或取消后再切换 Plan mode");
      app.updateComposerModeControls();
      return;
    }
    if (app.currentBackendRunsPlanOnly?.()) return;
    app.setComposerPlanMode(!state.composerPlanMode, { persist: true });
  };

  app.setComposerPlanMode = function setComposerPlanMode(enabled, options = {}) {
    state.composerPlanMode = Boolean(enabled);
    if (options.persist !== false) app.persistComposerMode(state.composerPlanMode ? "plan" : "execute");
    app.updateComposerModeControls();
    app.updateComposerAvailability();
  };

  app.normalizeComposerMode = function normalizeComposerMode(value) {
    const mode = String(value || "").trim().toLowerCase();
    if (mode === "plan") return "plan";
    if (mode === "execute") return "execute";
    return "";
  };

  app.currentComposerMode = function currentComposerMode() {
    const lockedMode = app.lockedActiveTurnComposerMode?.();
    if (lockedMode) return lockedMode;
    return state.composerPlanMode || app.currentBackendRunsPlanOnly?.() ? "plan" : "execute";
  };

  app.lockedActiveTurnComposerMode = function lockedActiveTurnComposerMode(session = app.selectedSessionForComposer()) {
    if (!app.sessionTurnIsRunning?.(session)) return "";
    return app.activeTurnComposerMode(session) || app.inferComposerModeFromSession(session);
  };

  app.sessionTurnIsRunning = function sessionTurnIsRunning(session = app.selectedSessionForComposer()) {
    return Boolean(session && (session.status === "running" || String(session.activeTurnId || "").trim()));
  };

  app.activeTurnComposerMode = function activeTurnComposerMode(session = state.selectedCodexSession) {
    const activeTurnId = String(session?.activeTurnId || "").trim();
    const events = Array.isArray(session?.events) ? session.events : [];
    if (!activeTurnId || events.length === 0) return "";

    let turnStartedIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const raw = event?.raw || {};
      const method = raw.method || event?.type || "";
      if (method !== "turn/started") continue;
      const params = raw.params || {};
      const turnId = String(params.turn?.id || params.turnId || event.activeTurnId || "").trim();
      if (turnId === activeTurnId) {
        turnStartedIndex = index;
        break;
      }
    }
    if (turnStartedIndex < 0) return "";

    for (let index = turnStartedIndex; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "user.message") continue;
      const mode = app.normalizeComposerMode(event.raw?.mode || event.raw?.payload?.mode);
      if (mode) return mode;
    }
    return "";
  };

  app.composerModeSessionKey = function composerModeSessionKey() {
    if (state.composingNewSession) return "";
    return String(state.selectedCodexSession?.id || state.selectedCodexJobId || "").trim();
  };

  app.composerModeWorkspaceKey = function composerModeWorkspaceKey() {
    const workspace = app.currentWorkspace?.();
    const workspaceKey = String(workspace?.key || workspace?.id || "").trim();
    if (workspaceKey) return workspaceKey;
    return String(state.selectedCodexSession?.projectId || "").trim();
  };

  app.composerModeStorageKeys = function composerModeStorageKeys(options = {}) {
    const includeSession = options.includeSession !== false;
    const includeWorkspace = options.includeWorkspace !== false;
    const includeGlobal = options.includeGlobal !== false;
    const keys = [];
    const sessionKey = includeSession ? app.composerModeSessionKey() : "";
    const workspaceKey = includeWorkspace ? app.composerModeWorkspaceKey() : "";
    if (sessionKey) keys.push(`echoComposerModeSession:${sessionKey}`);
    if (workspaceKey) keys.push(`echoComposerModeWorkspace:${workspaceKey}`);
    if (includeGlobal) keys.push("echoComposerMode");
    return Array.from(new Set(keys));
  };

  app.readStoredComposerMode = function readStoredComposerMode(options = {}) {
    for (const key of app.composerModeStorageKeys(options)) {
      const value = app.readScopedStorage
        ? app.readScopedStorage(key, state.currentUser, { fallbackLegacy: key === "echoComposerMode" })
        : app.localStorage?.getItem(key) || "";
      const normalized = app.normalizeComposerMode(value);
      if (normalized) return normalized;
    }
    return "";
  };

  app.persistComposerMode = function persistComposerMode(mode, options = {}) {
    const normalized = app.normalizeComposerMode(mode) || "execute";
    const keys = app.composerModeStorageKeys(options);
    for (const key of keys) {
      if (app.writeScopedStorage) {
        app.writeScopedStorage(key, normalized, state.currentUser);
      } else {
        app.localStorage?.setItem(key, normalized);
      }
    }
  };

  app.inferComposerModeFromSession = function inferComposerModeFromSession(session) {
    if (!session?.id || state.composingNewSession) return "";
    const direct = app.normalizeComposerMode(session.composerMode || session.currentMode || session.mode);
    if (direct) return direct;
    for (const event of [...(session.events || [])].reverse()) {
      if (event?.type !== "user.message") continue;
      const mode = app.normalizeComposerMode(event.raw?.mode || event.raw?.payload?.mode);
      if (mode) return mode;
    }
    return "";
  };

  app.restoreComposerMode = function restoreComposerMode(options = {}) {
    const sessionMode =
      options.includeSession === false
        ? ""
        : app.readStoredComposerMode({ includeSession: true, includeWorkspace: false, includeGlobal: false });
    const inferredMode = options.includeSession === false ? "" : app.inferComposerModeFromSession(state.selectedCodexSession);
    const workspaceMode = app.readStoredComposerMode({ includeSession: false, includeWorkspace: true, includeGlobal: false });
    const globalMode = app.readStoredComposerMode({ includeSession: false, includeWorkspace: false, includeGlobal: true });
    const mode = sessionMode || inferredMode || workspaceMode || globalMode || "execute";
    state.composerPlanMode = mode === "plan";
    app.updateComposerModeControls();
  };

  app.updateComposerModeControls = function updateComposerModeControls() {
    if (!elements.composerPlanModeButton) return;
    const lockedMode = app.lockedActiveTurnComposerMode?.();
    const enabled = Boolean(state.composerPlanMode);
    const planOnly = Boolean(app.currentBackendRunsPlanOnly?.());
    const effectiveEnabled = lockedMode ? lockedMode === "plan" : enabled || planOnly;
    const label = lockedMode
      ? effectiveEnabled
        ? "Plan mode 正在当前轮中使用，完成或取消后可切换"
        : "当前轮按执行模式运行，完成或取消后可切换 Plan mode"
      : planOnly
      ? "Plan mode 已开启，当前后端权限只允许计划"
      : effectiveEnabled
        ? "Plan mode 已开启，点击关闭并在下次发送时退出计划模式"
        : "Plan mode 已关闭，点击开启计划模式";
    elements.composerPlanModeButton.classList.toggle("active", effectiveEnabled);
    elements.composerPlanModeButton.disabled = state.composerBusy || planOnly || Boolean(lockedMode);
    elements.composerPlanModeButton.setAttribute("aria-checked", effectiveEnabled ? "true" : "false");
    elements.composerPlanModeButton.setAttribute("aria-pressed", effectiveEnabled ? "true" : "false");
    elements.composerPlanModeButton.setAttribute("aria-label", label);
    elements.composerPlanModeButton.setAttribute("title", label);
  };

  app.requestContextCompaction = async function requestContextCompaction({ automatic = false } = {}) {
    if (!app.codexCommandsAvailable()) {
      if (!automatic) app.toast(state.codexConnectionState === "error" ? "连接恢复后再压缩" : "桌面 agent 在线后再压缩");
      return;
    }
    const session = app.selectedSessionForComposer();
    if (!session || !app.canCompactSelectedSession(session)) {
      if (!automatic) app.toast(app.compactContextUnavailableReason(session));
      return;
    }

    if (automatic) state.autoCompactionRequestSessionIds.add(session.id);
    if (!automatic) app.setComposerBusy(true, "压缩中");
    try {
      const data = await app.apiPost(`/api/codex/sessions/${encodeURIComponent(session.id)}/compact`, {
        automatic,
        reason: automatic ? "context-threshold" : "manual"
      });
      state.selectedCodexSession = data.session || session;
      app.renderCodexJob(state.selectedCodexSession, { keepSelection: true, scrollToBottom: automatic });
      app.scheduleSessionListRefresh?.({ delayMs: 250 });
      if (!automatic) app.toast("已请求压缩上下文");
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。") && !automatic) {
        app.toast(error.message);
      }
    } finally {
      if (automatic) state.autoCompactionRequestSessionIds.delete(session.id);
      if (!automatic) app.setComposerBusy(false);
    }
  };

  app.maybeAutoCompactContext = function maybeAutoCompactContext(usage, percent) {
    if (!Number.isFinite(percent) || percent < 85) return;
    const session = app.selectedSessionForComposer();
    if (!session || !app.sessionBackendSupports(session, "compaction") || !app.sessionBackendSupports(session, "contextUsage")) return;
    if (state.autoCompactionRequestSessionIds.has(session.id)) return;
    if (elements.codexPrompt.value.trim() || state.composerAttachments.length > 0 || app.hasPendingComposerAttachments()) return;
    if (!app.canCompactSelectedSession(session)) return;
    app.requestContextCompaction({ automatic: true }).catch(() => {});
  };

  app.canCompactSelectedSession = function canCompactSelectedSession(session = app.selectedSessionForComposer()) {
    return Boolean(
      session &&
        session.appThreadId &&
        app.sessionBackendSupports(session, "compaction") &&
        app.sessionCanAcceptFollowUp(session) &&
        !["failed", "closed", "stale", "cancelled"].includes(session.status) &&
        !app.sessionHasPendingWork(session) &&
        Number(session.pendingApprovalCount || 0) === 0 &&
        Number(session.pendingInteractionCount || 0) === 0
    );
  };

  app.compactContextUnavailableReason = function compactContextUnavailableReason(session = app.selectedSessionForComposer(), options = {}) {
    const commandsAvailable = options.commandsAvailable ?? app.codexCommandsAvailable();
    const attachmentsPending = options.attachmentsPending ?? app.hasPendingComposerAttachments();
    const hasDraft = options.hasDraft ?? (Boolean(elements.codexPrompt.value.trim()) || state.composerAttachments.length > 0);
    if (!session) return "请选择一个可继续的会话";
    if (!commandsAvailable) return state.codexConnectionState === "error" ? "连接恢复后再压缩" : "桌面 agent 在线后再压缩";
    if (attachmentsPending) return "请等待当前附件处理完成";
    if (hasDraft) return "先发送当前草稿再压缩";
    if (!app.sessionBackendSupports(session, "compaction")) return "当前后端暂不支持远程上下文压缩";
    if (!session.appThreadId) return "当前会话还没有可压缩的远端线程";
    if (!app.sessionCanAcceptFollowUp(session)) return "当前会话暂时不能继续";
    if (["failed", "closed", "stale", "cancelled"].includes(session.status)) return "当前会话暂时不能压缩";
    if (app.sessionHasPendingWork(session)) return "当前会话还有未完成任务";
    if (Number(session.pendingApprovalCount || 0) > 0) return "当前会话还有待审批";
    if (Number(session.pendingInteractionCount || 0) > 0) return "当前会话还有待选择";
    return "当前会话暂时不能压缩";
  };

  app.sessionCanAcceptFollowUp = function sessionCanAcceptFollowUp(session) {
    if (!session || session.archivedAt) return false;
    if (session.status === "failed") return app.sessionCanRecoverFailure(session);
    return !["closed", "stale"].includes(session.status);
  };

  app.sessionCanRecoverFailure = function sessionCanRecoverFailure(session) {
    const error = String(session?.lastError || session?.error || "");
    if (
      /thread not found|requires a newer version of Codex|Please upgrade to the latest app or CLI|rate[ _-]?limit|rate limited|rate_limited|too many requests|\b429\b|quota|temporarily unavailable|overloaded|capacity|限流|速率限制|请求过多/i.test(
        error
      )
    ) {
      return true;
    }
    if (String(session?.appThreadId || "").trim()) return true;
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    if (
      messages.some((message) => {
        const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
        return ["user", "assistant"].includes(message?.role) && (String(message?.text || "").trim() || attachments.length > 0);
      })
    ) {
      return true;
    }
    const events = Array.isArray(session?.events) ? session.events : [];
    return events.some((event) => ["user.message", "thread.started", "thread.resumed", "thread.restarted"].includes(event?.type));
  };

  app.canStartNewSessionFromComposer = function canStartNewSessionFromComposer() {
    if (state.composingNewSession) return true;
    if (state.selectedCodexSession && !app.sessionBelongsToCurrentProject(state.selectedCodexSession)) return true;
    return !state.selectedCodexJobId && !state.selectedCodexSession;
  };

  app.selectedSessionNeedsExplicitNew = function selectedSessionNeedsExplicitNew() {
    if (state.composingNewSession) return false;
    if (!state.selectedCodexJobId || !state.selectedCodexSession) return false;
    return !app.canContinueSelectedSession();
  };

  app.sessionHasPendingWork = function sessionHasPendingWork(session) {
    if (!session) return false;
    return (
      ["queued", "starting", "running"].includes(session.status) ||
      Number(session.pendingCommandCount || 0) > 0 ||
      Number(session.pendingInteractionCount || 0) > 0
    );
  };

  app.composerActionLabel = function composerActionLabel() {
    if (app.selectedSessionNeedsExplicitNew()) return "先新建";
    if (app.currentComposerMode() === "plan") return "生成计划";
    if (!app.canContinueSelectedSession()) return "发送";
    if (app.sessionAwaitsPlanFollowUp(state.selectedCodexSession) && !app.sessionHasPendingWork(state.selectedCodexSession)) {
      return "执行计划";
    }
    return app.sessionHasPendingWork(state.selectedCodexSession) ? "追加" : "继续";
  };

  app.openComposerAttachmentPicker = function openComposerAttachmentPicker() {
    if (state.composerBusy || app.hasPendingComposerAttachments()) return;
    if (!app.currentBackendSupports("attachments")) {
      app.toast("当前后端暂不支持图片附件");
      return;
    }
    elements.composerAttachmentInput.click();
  };

  app.openComposerFileAttachmentPicker = function openComposerFileAttachmentPicker() {
    if (state.composerBusy || app.hasPendingComposerAttachments()) return;
    if (!app.currentBackendSupports("attachments")) {
      app.toast("当前后端暂不支持文件附件");
      return;
    }
    elements.composerFileAttachmentInput?.click();
  };

  app.handleComposerAttachmentInput = async function handleComposerAttachmentInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (app.hasPendingComposerAttachments()) {
      if (files.length > 0) app.toast("请等待当前图片处理完成");
      return;
    }
    await app.addComposerAttachmentFiles(files, { kind: "image" });
  };

  app.handleComposerFileAttachmentInput = async function handleComposerFileAttachmentInput(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (app.hasPendingComposerAttachments()) {
      if (files.length > 0) app.toast("请等待当前文件处理完成");
      return;
    }
    await app.addComposerAttachmentFiles(files, { kind: "file" });
  };

  app.handleComposerPaste = async function handleComposerPaste(event) {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    if (!app.currentBackendSupports("attachments")) {
      event.preventDefault();
      app.toast("当前后端暂不支持图片附件");
      return;
    }
    if (app.hasPendingComposerAttachments()) {
      event.preventDefault();
      app.toast("请等待当前图片处理完成");
      return;
    }
    event.preventDefault();
    await app.addComposerAttachmentFiles(files, { kind: "image" });
  };

  app.addComposerAttachmentFiles = async function addComposerAttachmentFiles(files = [], options = {}) {
    const kind = String(options.kind || "file").trim() === "image" ? "image" : "file";
    if (!app.currentBackendSupports("attachments")) {
      if (files.length) app.toast(kind === "image" ? "当前后端暂不支持图片附件" : "当前后端暂不支持文件附件");
      return;
    }
    const attachmentFiles =
      kind === "image"
        ? files.filter((file) => file && (file.type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(file.name || "")))
        : files.filter(Boolean);
    if (attachmentFiles.length === 0) {
      if (files.length && kind === "image") app.toast("只能附加图片");
      return;
    }

    const remaining = constants.MAX_COMPOSER_ATTACHMENTS - state.composerAttachments.length - state.composerAttachmentPendingCount;
    if (remaining <= 0) {
      app.toast(kind === "image" ? `最多附加 ${constants.MAX_COMPOSER_ATTACHMENTS} 张截图` : `最多附加 ${constants.MAX_COMPOSER_ATTACHMENTS} 个文件`);
      return;
    }
    if (attachmentFiles.length > remaining) {
      app.toast(kind === "image" ? `最多附加 ${constants.MAX_COMPOSER_ATTACHMENTS} 张截图` : `最多附加 ${constants.MAX_COMPOSER_ATTACHMENTS} 个文件`);
    }

    const accepted = [];
    const queuedFiles = attachmentFiles.slice(0, remaining);
    app.setComposerAttachmentPendingCount(state.composerAttachmentPendingCount + queuedFiles.length, kind);
    for (const file of queuedFiles) {
      try {
        if (file.size > constants.MAX_COMPOSER_ATTACHMENT_BYTES) {
          app.toast(`${kind === "image" ? "截图" : "文件"}不能超过 ${Math.round(constants.MAX_COMPOSER_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
          continue;
        }
        const url = await app.fileToDataUrl(file);
        accepted.push({
          id: crypto.randomUUID(),
          type: kind,
          name: file.name || (kind === "image" ? "截图" : "文件"),
          mimeType: file.type || (kind === "image" ? "image/png" : "application/octet-stream"),
          sizeBytes: file.size || 0,
          url
        });
      } catch {
        app.toast(`读取${kind === "image" ? "截图" : "文件"}失败，请重试`);
      } finally {
        app.setComposerAttachmentPendingCount(state.composerAttachmentPendingCount - 1);
      }
    }

    if (accepted.length === 0) return;
    state.composerAttachments = [...state.composerAttachments, ...accepted].slice(0, constants.MAX_COMPOSER_ATTACHMENTS);
    app.renderComposerAttachments();
  };

  app.fileToDataUrl = function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("file read failed"));
      reader.readAsDataURL(file);
    });
  };

  app.renderComposerAttachments = function renderComposerAttachments() {
    const hasAttachments = state.composerAttachments.length > 0;
    const imageCount = state.composerAttachments.filter((attachment) => attachment.type === "image").length;
    const fileCount = state.composerAttachments.filter((attachment) => attachment.type === "file").length;
    elements.composerAttachmentTray.hidden = !hasAttachments;
    elements.composerAttachmentButton.classList.toggle("active", imageCount > 0);
    elements.composerAttachmentButton.setAttribute(
      "aria-label",
      imageCount > 0 ? `已附加 ${imageCount} 张截图` : "附加截图"
    );
    elements.composerFileAttachmentButton?.classList.toggle("active", fileCount > 0);
    elements.composerFileAttachmentButton?.setAttribute(
      "aria-label",
      fileCount > 0 ? `已附加 ${fileCount} 个文件` : "附加文件"
    );
    elements.composerAttachmentTray.innerHTML = hasAttachments
      ? `
          ${state.composerAttachments
            .map((attachment, index) => {
              const label = app.attachmentDisplayLabel(attachment, index);
              return `
                <div class="composer-attachment-pill" data-attachment-id="${app.escapeHtml(attachment.id)}">
                  <span class="composer-attachment-pill-label">${app.escapeHtml(label)}</span>
                  <button type="button" class="composer-attachment-remove" aria-label="移除 ${app.escapeHtml(label)}">移除</button>
                </div>
              `;
            })
            .join("")}
        `
      : "";

    for (const button of elements.composerAttachmentTray.querySelectorAll(".composer-attachment-remove")) {
      button.addEventListener("click", () => {
        const chip = button.closest("[data-attachment-id]");
        if (!chip) return;
        app.removeComposerAttachment(chip.dataset.attachmentId || "");
      });
    }

    app.updateComposerAvailability();
    app.syncComposerMetrics?.();
  };

  app.removeComposerAttachment = function removeComposerAttachment(id) {
    state.composerAttachments = state.composerAttachments.filter((attachment) => attachment.id !== id);
    app.renderComposerAttachments();
  };

  app.clearComposerAttachments = function clearComposerAttachments(options = {}) {
    if (state.composerAttachments.length === 0 && options.silent) return;
    state.composerAttachments = [];
    app.renderComposerAttachments();
  };

  app.currentComposerAttachmentsPayload = function currentComposerAttachmentsPayload() {
    return state.composerAttachments.map((attachment) => ({
      type: attachment.type || "file",
      url: attachment.url,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes
    }));
  };

  app.setComposerBusy = function setComposerBusy(isBusy, label = "") {
    state.composerBusy = isBusy;
    if (label) app.setTopbarStatus(label, isBusy ? "busy" : "info");
    elements.sendCodexButton.textContent = isBusy ? label || "处理中" : app.composerActionLabel();
    app.updateComposerAvailability();
    app.syncComposerMetrics();
    app.refreshComposerStatusBar();
    if (!isBusy) app.refreshStatus({ silentAuthFailure: true });
  };

  app.updateComposerAvailability = function updateComposerAvailability() {
    const hasProject = Boolean(app.currentProjectId());
    const commandsAvailable = app.codexCommandsAvailable();
    const hasDraft = Boolean(elements.codexPrompt.value.trim()) || state.composerAttachments.length > 0;
    const blockedBySelectedSession = app.selectedSessionNeedsExplicitNew();
    const attachmentsPending = app.hasPendingComposerAttachments();
    elements.sendCodexButton.disabled =
      state.composerBusy || attachmentsPending || !commandsAvailable || !hasProject || !hasDraft || blockedBySelectedSession;
    if (!state.composerBusy) {
      elements.sendCodexButton.textContent = attachmentsPending ? app.composerAttachmentPendingActionLabel() : app.composerActionLabel();
    }
    elements.newCodexSessionButton.disabled = state.composerBusy;
    elements.codexProject.disabled = state.composerBusy;
    elements.codexPermissionMode.disabled = state.composerBusy;
    elements.codexModel.disabled = state.composerBusy;
    elements.codexReasoningEffort.disabled = state.composerBusy;
    elements.codexPrompt.disabled = state.composerBusy;
    elements.codexBackend.disabled = state.composerBusy;
    app.refreshRuntimeSelectControls?.();
    elements.composerAttachmentButton.disabled =
      state.composerBusy || attachmentsPending || !app.currentBackendSupports("attachments");
    elements.composerAttachmentButton.title = app.currentBackendSupports("attachments") ? "附加截图" : "当前后端暂不支持图片附件";
    if (elements.composerFileAttachmentButton) {
      elements.composerFileAttachmentButton.disabled =
        state.composerBusy || attachmentsPending || !app.currentBackendSupports("attachments");
      elements.composerFileAttachmentButton.title = app.currentBackendSupports("attachments") ? "附加文件" : "当前后端暂不支持文件附件";
    }
    if (elements.composerPlanModeButton) {
      elements.composerPlanModeButton.disabled = state.composerBusy;
    }
    if (elements.agentSkillsButton) {
      const count = Array.isArray(state.installedAgentSkills) ? state.installedAgentSkills.length : 0;
      elements.agentSkillsButton.disabled = state.composerBusy;
      elements.agentSkillsButton.title = count ? `已安装 Skills · ${count}` : "已安装 Skills";
    }
    app.updateProjectCreateControls();
    if (elements.quickSkillsButton) {
      elements.quickSkillsButton.disabled = state.composerBusy;
    }
    app.updateStopButton?.();
    app.refreshComposerMeta();
    app.refreshTopbarProjectChip();
    app.updateComposerModeControls();
    app.syncComposerMetrics();
    app.refreshComposerStatusBar();
  };

  app.codexCommandsAvailable = function codexCommandsAvailable() {
    if (state.codexConnectionState === "error" || !state.codexAgentAvailable) return false;
    const workspace = app.currentWorkspace();
    if (!workspace?.id) return false;
    if (!state.codexAgentOnline) {
      return (state.codexWorkspaces || []).some((item) => item.key === workspace.key);
    }
    return app.workspaceCurrentlyAvailable(workspace);
  };

  app.workspaceCurrentlyAvailable = function workspaceCurrentlyAvailable(workspace = app.currentWorkspace?.()) {
    const key = String(workspace?.key || "").trim();
    if (!key) return false;
    const availableKeys = Array.isArray(state.codexAvailableWorkspaceKeys) ? state.codexAvailableWorkspaceKeys : [];
    return availableKeys.includes(key);
  };

  app.toggleProjectCreateForm = function toggleProjectCreateForm() {
    if (state.projectCreateBusy || !state.codexAgentOnline) {
      app.toast(state.codexAgentOnline ? "工程正在创建中" : "桌面 agent 在线后才能新建工程");
      return;
    }
    app.openProjectSwitcher();
    elements.projectCreateForm.hidden = !elements.projectCreateForm.hidden;
    if (!elements.projectCreateForm.hidden) {
      elements.projectSheetStatus.textContent = "会在桌面默认工程目录下创建，并自动加入工程列表。";
      elements.projectCreateName.focus({ preventScroll: true });
    }
  };

  app.createProjectFromMobile = async function createProjectFromMobile(event) {
    event?.preventDefault();
    if (!state.codexAgentOnline) {
      app.toast("桌面 agent 在线后才能新建工程");
      return;
    }

    const name = elements.projectCreateName.value.trim();
    if (!name) {
      app.toast("先填写工程名称");
      elements.projectCreateName.focus({ preventScroll: true });
      return;
    }

    app.setProjectCreateBusy(true, "正在通知桌面 agent...");
    try {
      const targetAgentId = app.currentTargetAgentId() || state.codexAgents.find((agent) => agent.online !== false)?.id || "";
      const created = await app.apiPost("/api/codex/workspaces", { name, targetAgentId });
      const command = await app.waitForProjectCreateCommand(created.command?.id);
      const workspace = command.result?.workspace;
      if (!workspace?.id) throw new Error("桌面 agent 没有返回新工程信息。");

      const workspaceKey = targetAgentId ? `${targetAgentId}:${workspace.id}` : workspace.key || workspace.id;
      app.persistCodexProjectKey?.(workspaceKey);
      elements.projectCreateName.value = "";
      elements.projectCreateForm.hidden = true;
      await app.refreshCodex();
      await app.selectProject(workspaceKey);
      elements.projectSheetStatus.textContent = `已创建 ${app.workspaceLabel(workspace)}`;
      app.toast(`已新建并切换到 ${app.workspaceLabel(workspace)}`);
      app.closeProjectSwitcher();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        elements.projectSheetStatus.textContent = error.message;
        app.toast(error.message);
      }
    } finally {
      app.setProjectCreateBusy(false);
    }
  };

  app.waitForProjectCreateCommand = async function waitForProjectCreateCommand(commandId) {
    return app.waitForWorkspaceCommand(commandId, {
      missing: "新建工程请求没有排入队列。",
      failed: "新建工程失败。",
      timeout: "新建工程超时，请确认桌面 agent 已更新并在运行。",
      progress: (command) => {
        elements.projectSheetStatus.textContent = command?.status === "leased" ? "桌面 agent 正在创建目录..." : "等待桌面 agent 创建目录...";
      }
    });
  };

  app.waitForWorkspaceCommand = async function waitForWorkspaceCommand(commandId, messages = {}) {
    if (!commandId) throw new Error(messages.missing || "请求没有排入队列。");

    const startedAt = Date.now();
    while (Date.now() - startedAt < 60000) {
      const data = await app.apiGet(`/api/codex/workspaces/${encodeURIComponent(commandId)}`);
      const command = data.command;
      if (command?.status === "done") return command;
      if (command?.status === "failed") {
        throw new Error(command.error || command.result?.error || messages.failed || "操作失败。");
      }
      messages.progress?.(command);
      await new Promise((resolve) => setTimeout(resolve, 900));
    }

    throw new Error(messages.timeout || "请求超时，请确认桌面 agent 已更新并在运行。");
  };

  app.setProjectCreateBusy = function setProjectCreateBusy(isBusy, message = "") {
    state.projectCreateBusy = isBusy;
    if (message) elements.projectSheetStatus.textContent = message;
    app.updateProjectCreateControls();
  };

  app.updateProjectCreateControls = function updateProjectCreateControls() {
    const disabled = state.projectCreateBusy || !state.codexAgentOnline;
    if (elements.newProjectButton) elements.newProjectButton.disabled = disabled;
    if (elements.openExistingProjectButton) elements.openExistingProjectButton.disabled = state.projectImportBusy;
    if (elements.projectCreateName) elements.projectCreateName.disabled = state.projectCreateBusy;
    if (elements.projectCreateSubmit) {
      elements.projectCreateSubmit.disabled = disabled;
      elements.projectCreateSubmit.textContent = state.projectCreateBusy ? "创建中" : "创建";
    }
    if (elements.projectImportSelectButton) {
      elements.projectImportSelectButton.disabled = state.projectImportBusy || !state.projectImportTree?.canSelect;
      elements.projectImportSelectButton.textContent = state.projectImportBusy ? "处理中" : "打开此目录";
    }
  };

  app.openProjectImportPanel = function openProjectImportPanel(event) {
    event?.stopPropagation();
    if (!elements.projectImportPanel) return;
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.closeQuickSkillsPanel?.();
    app.closeAgentSkillsPanel?.();
    app.closeRuntimeSelectPopover?.();
    elements.projectImportPanel.hidden = false;
    elements.projectImportPanel.closest?.(".session-sidebar")?.classList.add("project-import-page-open");
    app.renderProjectImportPanel();
    const roots = app.projectImportRoots();
    if (state.codexAgentOnline && roots.length === 1 && !state.projectImportTree && !state.projectImportBusy) {
      app.refreshProjectImportDirectory({ rootId: roots[0].id, path: "" });
    }
    app.window?.requestAnimationFrame?.(() => {
      elements.projectImportCloseButton?.focus?.({ preventScroll: true });
    });
  };

  app.closeProjectImportPanel = function closeProjectImportPanel({ restoreFocus = false } = {}) {
    if (!elements.projectImportPanel || elements.projectImportPanel.hidden) return;
    elements.projectImportPanel.hidden = true;
    elements.projectImportPanel.closest?.(".session-sidebar")?.classList.remove("project-import-page-open");
    if (restoreFocus) elements.openExistingProjectButton?.focus({ preventScroll: true });
  };

  app.projectImportRoots = function projectImportRoots() {
    const runtime = app.runtimeForAgent?.(state.selectedAgentId, {}) || {};
    const sourceRoots =
      runtime.projectImport?.roots ||
      runtime.capabilities?.projectImport?.roots ||
      runtime.capabilities?.workspaceImport?.roots ||
      [];
    const byId = new Map();
    for (const root of Array.isArray(sourceRoots) ? sourceRoots : []) {
      const id = String(root?.id || root?.rootId || "").trim();
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        label: String(root.label || root.name || "Projects").trim() || "Projects",
        pathLabel: String(root.pathLabel || root.label || "").trim()
      });
    }
    return Array.from(byId.values());
  };

  app.renderProjectImportPanel = function renderProjectImportPanel() {
    if (!elements.projectImportPanel) return;
    const roots = app.projectImportRoots();
    if (elements.projectImportMeta) {
      elements.projectImportMeta.textContent = state.codexAgentOnline
        ? roots.length
          ? `${roots.length} 个位置`
          : "未找到可浏览位置"
        : "等待桌面 agent";
    }
    if (elements.projectImportRoots) {
      elements.projectImportRoots.innerHTML = roots.length
        ? roots
            .map((root) => {
              const active = root.id === state.projectImportRootId;
              return `
                <button class="project-import-root${active ? " active" : ""}" type="button" data-root-id="${app.escapeHtml(root.id)}" aria-pressed="${active ? "true" : "false"}">
                  <strong>${app.escapeHtml(root.label)}</strong>
                  ${root.pathLabel ? `<span>${app.escapeHtml(root.pathLabel)}</span>` : ""}
                </button>
              `;
            })
            .join("")
        : '<div class="mcp-empty mcp-grid-empty">暂无可浏览位置。</div>';
      for (const button of elements.projectImportRoots.querySelectorAll("[data-root-id]")) {
        button.addEventListener("click", () => app.refreshProjectImportDirectory({ rootId: button.dataset.rootId || "", path: "" }));
      }
    }
    app.renderProjectImportTree();
    app.updateProjectCreateControls();
  };

  app.renderProjectImportTree = function renderProjectImportTree() {
    if (!elements.projectImportList) return;
    const tree = state.projectImportTree;
    if (elements.projectImportStatus) {
      elements.projectImportStatus.textContent = state.projectImportBusy
        ? "正在读取目录..."
        : state.projectImportError || (tree ? `${tree.entries?.length || 0} 个目录` : "");
    }
    if (!tree) {
      elements.projectImportBreadcrumbs.innerHTML = "";
      elements.projectImportList.innerHTML = state.projectImportBusy
        ? '<div class="mcp-empty mcp-grid-empty">正在读取目录...</div>'
        : '<div class="mcp-empty mcp-grid-empty">选择一个位置开始浏览。</div>';
      return;
    }

    const pathParts = String(tree.path || "").split("/").filter(Boolean);
    const crumbs = [`<button type="button" data-import-path="">${app.escapeHtml(tree.root?.label || "根目录")}</button>`];
    pathParts.forEach((part, index) => {
      const crumbPath = pathParts.slice(0, index + 1).join("/");
      crumbs.push(`<button type="button" data-import-path="${app.escapeHtml(crumbPath)}">${app.escapeHtml(part)}</button>`);
    });
    elements.projectImportBreadcrumbs.innerHTML = crumbs.join('<span aria-hidden="true">/</span>');
    for (const button of elements.projectImportBreadcrumbs.querySelectorAll("[data-import-path]")) {
      button.addEventListener("click", () =>
        app.refreshProjectImportDirectory({ rootId: state.projectImportRootId, path: button.dataset.importPath || "" })
      );
    }

    const rows = [];
    if (tree.path) {
      rows.push(`
        <button class="project-import-entry" type="button" data-import-path="${app.escapeHtml(tree.parentPath || "")}">
          <span aria-hidden="true">..</span>
          <strong>上一级</strong>
        </button>
      `);
    }
    for (const entry of tree.entries || []) {
      rows.push(`
        <button class="project-import-entry" type="button" data-import-path="${app.escapeHtml(entry.path || "")}">
          <span aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.7" />
            </svg>
          </span>
          <strong>${app.escapeHtml(entry.name || entry.path || "目录")}</strong>
        </button>
      `);
    }
    elements.projectImportList.innerHTML = rows.join("") || '<div class="mcp-empty mcp-grid-empty">没有可进入的子目录。</div>';
    for (const button of elements.projectImportList.querySelectorAll("[data-import-path]")) {
      button.addEventListener("click", () =>
        app.refreshProjectImportDirectory({ rootId: state.projectImportRootId, path: button.dataset.importPath || "" })
      );
    }
  };

  app.refreshProjectImportDirectory = async function refreshProjectImportDirectory(options = {}) {
    if (!state.codexAgentOnline) {
      state.projectImportError = "桌面 agent 在线后才能浏览";
      app.renderProjectImportPanel();
      return;
    }
    if (state.projectImportBusy) return;
    const rootId = String(options.rootId || state.projectImportRootId || app.projectImportRoots()[0]?.id || "").trim();
    if (!rootId) {
      state.projectImportError = "未找到可浏览位置";
      app.renderProjectImportPanel();
      return;
    }
    const path = String(options.path ?? state.projectImportPath ?? "").trim();
    state.projectImportBusy = true;
    state.projectImportError = "";
    state.projectImportRootId = rootId;
    state.projectImportPath = path;
    app.renderProjectImportPanel();

    try {
      const data = await app.apiPost("/api/codex/workspaces/import/list", {
        targetAgentId: app.currentTargetAgentId() || state.selectedAgentId,
        rootId,
        path
      });
      const command = await app.waitForWorkspaceCommand(data.command?.id, {
        missing: "目录浏览请求没有排入队列。",
        failed: "目录浏览失败。",
        timeout: "目录浏览超时，请确认桌面 agent 已更新并在运行。",
        progress: () => {
          if (elements.projectImportStatus) elements.projectImportStatus.textContent = "桌面 agent 正在读取目录...";
        }
      });
      if (!command.result?.tree) throw new Error("桌面 agent 没有返回目录列表。");
      state.projectImportTree = command.result.tree;
      state.projectImportRootId = command.result.tree.rootId || rootId;
      state.projectImportPath = command.result.tree.path || "";
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        state.projectImportError = error.message;
        app.toast(error.message);
      }
    } finally {
      state.projectImportBusy = false;
      app.renderProjectImportPanel();
    }
  };

  app.registerProjectImportSelection = async function registerProjectImportSelection() {
    if (!state.projectImportTree || state.projectImportBusy) return;
    const tree = state.projectImportTree;
    if (tree.looksLikeProject === false && typeof app.confirm === "function") {
      const directoryLabel = tree.label || tree.path || tree.root?.label || "这个目录";
      const confirmed = await app.confirm({
        title: "打开普通文件夹？",
        body: `“${directoryLabel}”不像代码项目，可能没有 Git 变更摘要。确认后 agent 仍只会在这个文件夹内工作。`,
        confirmLabel: "仍然打开",
        cancelLabel: "返回选择"
      });
      if (!confirmed) return;
    }
    state.projectImportBusy = true;
    state.projectImportError = "";
    app.renderProjectImportPanel();
    const targetAgentId = app.currentTargetAgentId() || state.selectedAgentId;
    try {
      const data = await app.apiPost("/api/codex/workspaces/import/register", {
        targetAgentId,
        rootId: state.projectImportRootId,
        path: state.projectImportPath
      });
      const command = await app.waitForWorkspaceCommand(data.command?.id, {
        missing: "项目注册请求没有排入队列。",
        failed: "项目注册失败。",
        timeout: "项目注册超时，请确认桌面 agent 已更新并在运行。",
        progress: () => {
          if (elements.projectImportStatus) elements.projectImportStatus.textContent = "桌面 agent 正在验证目录...";
        }
      });
      const workspace = command.result?.workspace;
      if (!workspace?.id) throw new Error("桌面 agent 没有返回项目信息。");
      const workspaceKey = targetAgentId ? `${targetAgentId}:${workspace.id}` : workspace.key || workspace.id;
      app.persistCodexProjectKey?.(workspaceKey);
      await app.refreshCodex({ forceQuickSkills: true });
      await app.selectProject(workspaceKey);
      app.toast(`已打开 ${app.workspaceLabel(workspace)}`);
      app.closeProjectImportPanel({ restoreFocus: false });
      app.closeProjectSwitcher();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        state.projectImportError = error.message;
        app.toast(error.message);
      }
    } finally {
      state.projectImportBusy = false;
      app.renderProjectImportPanel();
    }
  };

  app.updateProjectSummary = function updateProjectSummary(workspace, hasProjects, agentOnline = state.codexAgentOnline) {
    if (workspace) {
      elements.projectPickerLabel.textContent = app.workspaceDirectoryName(workspace);
      elements.projectPickerMeta.textContent = "";
      return;
    }
    elements.projectPickerLabel.textContent = hasProjects ? "选择工程" : agentOnline ? "还没有工程" : "等待桌面 agent";
    elements.projectPickerMeta.textContent = hasProjects
      ? `已同步 ${state.codexWorkspaces.length} 个项目。`
      : agentOnline
        ? "可以新建工程，或打开桌面上的现有项目。"
        : "桌面端启动后会同步可切换项目。";
  };

  app.renderProjectPicker = function renderProjectPicker(agentOnline) {
    const selectedWorkspace = state.codexWorkspaces.find((workspace) => workspace.key === elements.codexProject.value) || null;
    const hasProjects = app.workspacesForSelectedAgent().length > 0;
    app.updateProjectSummary(selectedWorkspace, hasProjects, agentOnline);
    app.updateProjectCreateControls();

    if (!hasProjects) {
      elements.projectSheetStatus.textContent = "";
      app.renderProjectSheetList();
      app.refreshActiveSessionHeader();
      app.refreshTopbarProjectChip();
      return;
    }

    elements.projectSheetStatus.textContent = "";
    app.renderProjectSheetList();
    app.refreshActiveSessionHeader();
    app.refreshTopbarProjectChip();
  };

  app.renderProjectSheetList = function renderProjectSheetList() {
    const sessionList = elements.codexJobs;
    if (sessionList && elements.projectSheetList.contains(sessionList)) sessionList.remove();
    elements.projectSheetList.innerHTML = "";
    const visibleAgents = app.visibleCodexAgents();
    if (elements.agentEnvironmentList) {
      elements.agentEnvironmentList.hidden = visibleAgents.length <= 1;
      elements.agentEnvironmentList.innerHTML =
        visibleAgents.length > 1
          ? visibleAgents
              .map((agent) => {
                const active = agent.id === state.selectedAgentId;
                const workspaceCount = state.codexWorkspaces.filter((workspace) => workspace.agentId === agent.id).length;
                return `
                  <button
                    class="agent-environment-option${active ? " active" : ""}"
                    type="button"
                    data-agent-id="${app.escapeHtml(agent.id)}"
                    aria-pressed="${active ? "true" : "false"}"
                  >
                    <span class="agent-environment-dot${agent.online === false ? " offline" : ""}" aria-hidden="true"></span>
                    <span class="agent-environment-main">
                      <strong>${app.escapeHtml(app.agentDisplayName(agent) || agent.id)}</strong>
                      <span>${agent.online === false ? "离线" : "在线"} · ${workspaceCount} 个项目</span>
                    </span>
                  </button>
                `;
              })
              .join("")
          : "";
      for (const button of elements.agentEnvironmentList.querySelectorAll("[data-agent-id]")) {
        button.addEventListener("click", () => app.selectAgentEnvironment(button.dataset.agentId || ""));
      }
    }

    const visibleWorkspaces = app.workspacesForSelectedAgent();
    if (!visibleWorkspaces.length) {
      elements.projectSheetList.innerHTML = '<div class="project-sheet-empty">暂时没有可切换工程。</div>';
      return;
    }

    for (const workspace of visibleWorkspaces) {
      const group = document.createElement("div");
      const row = document.createElement("div");
      const button = document.createElement("button");
      const actions = document.createElement("div");
      const moreButton = document.createElement("button");
      const isActive = workspace.key === elements.codexProject.value;
      const directoryName = app.workspaceDirectoryName(workspace);
      const secondaryLabel = workspace.label && workspace.label !== directoryName ? workspace.label : app.workspaceSecondaryLabel(workspace);
      const pathLabel = app.workspacePathLabel(workspace) || app.workspaceMeta(workspace);
      group.className = "project-tree-group";
      group.classList.toggle("active", isActive);
      row.className = "project-tree-row";
      button.type = "button";
      button.className = "project-option project-tree-project";
      button.dataset.projectId = workspace.key || workspace.id || "";
      button.title = pathLabel;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", isActive ? "true" : "false");
      button.classList.toggle("active", isActive);
      button.innerHTML = `
        <span class="project-option-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9Z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.7" />
          </svg>
        </span>
        <div class="project-option-main">
          <div class="project-option-title-row">
            <strong>${app.escapeHtml(directoryName)}</strong>
          </div>
          ${secondaryLabel ? `<span class="project-option-id">${app.escapeHtml(secondaryLabel)}</span>` : ""}
        </div>
      `;
      button.addEventListener("click", () => app.selectProject(workspace.key || workspace.id));
      actions.className = "project-tree-actions";
      moreButton.type = "button";
      moreButton.className = "project-tree-more";
      moreButton.setAttribute("aria-label", `${directoryName} 的项目操作`);
      moreButton.setAttribute("aria-expanded", "false");
      moreButton.title = "项目操作";
      moreButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" fill="currentColor" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
          <circle cx="12" cy="19" r="1.5" fill="currentColor" />
        </svg>
      `;
      const menu = document.createElement("div");
      const removeButton = document.createElement("button");
      menu.className = "project-tree-menu";
      menu.setAttribute("role", "menu");
      removeButton.type = "button";
      removeButton.className = "project-tree-menu-remove";
      removeButton.setAttribute("role", "menuitem");
      removeButton.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
        </svg>
        <span>从侧栏移除</span>
      `;
      moreButton.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = !actions.classList.contains("is-open");
        app.closeProjectActionMenus(actions);
        actions.classList.toggle("is-open", open);
        moreButton.setAttribute("aria-expanded", open ? "true" : "false");
      });
      removeButton.addEventListener("click", (event) => {
        event.stopPropagation();
        app.closeProjectActionMenus();
        app.removeWorkspaceFromSidebar(workspace);
      });
      menu.append(removeButton);
      actions.append(moreButton, menu);
      row.append(button, actions);
      group.append(row);
      if (isActive && sessionList) {
        sessionList.classList.add("project-session-list");
        group.append(sessionList);
      }
      elements.projectSheetList.append(group);
    }
  };

  app.removeWorkspaceFromSidebar = async function removeWorkspaceFromSidebar(workspace) {
    const normalized = app.normalizeCodexWorkspace(workspace);
    if (!normalized?.id) return;
    const confirmed = await app.confirm({
      title: "从侧栏移除项目",
      body: `“${app.workspaceLabel(normalized)}”只会从这台手机的项目列表中隐藏，本地文件夹、Git 仓库和历史会话都不会删除。`,
      confirmLabel: "移除",
      cancelLabel: "取消",
      tone: "danger"
    });
    if (!confirmed) return;

    try {
      await app.apiPost("/api/codex/workspaces/visibility", {
        workspaceId: normalized.id,
        targetAgentId: normalized.agentId,
        visible: false
      });

      const removedKey = normalized.key || normalized.id;
      state.codexWorkspaces = (state.codexWorkspaces || []).filter((item) => (item.key || item.id) !== removedKey);
      state.codexAvailableWorkspaceKeys = (state.codexAvailableWorkspaceKeys || []).filter((key) => key !== removedKey);
      const remaining = app.workspacesForSelectedAgent();
      if (elements.codexProject.value === removedKey) {
        const nextWorkspace = remaining[0] || null;
        if (nextWorkspace) {
          await app.selectProject(nextWorkspace.key || nextWorkspace.id);
        } else {
          elements.codexProject.value = "";
          app.removeScopedStorage?.("echoCodexProject");
          state.selectedCodexJobId = "";
          state.selectedCodexSession = null;
          state.composingNewSession = false;
          app.closeCodexSessionStream?.();
          await app.loadCodexJobs();
          app.syncProjectPicker();
        }
      } else {
        app.syncProjectPicker();
      }
      app.toast("已从侧栏移除");
      await app.refreshCodex({ forceQuickSkills: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    }
  };

  app.selectAgentEnvironment = async function selectAgentEnvironment(agentId) {
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId || normalizedAgentId === state.selectedAgentId) return;
    state.selectedAgentId = normalizedAgentId;
    app.persistSelectedAgentId?.(normalizedAgentId);
    const selectedWorkspace = app.workspacesForSelectedAgent(state.codexWorkspaces, normalizedAgentId)[0] || null;
    const selectedWorkspaceKey = selectedWorkspace?.key || selectedWorkspace?.id || "";
    if (selectedWorkspaceKey) app.persistCodexProjectKey?.(selectedWorkspaceKey);
    const nextRuntime = app.runtimeForAgent(normalizedAgentId, {});
    state.codexBackendRuntimes = app.backendRuntimesForRuntime(nextRuntime);
    app.updateMcpSnapshot?.(nextRuntime?.mcp || {});
    app.updateAgentSkillSnapshot?.(nextRuntime?.agentSkills || {}, nextRuntime || {});
    app.updateDesktopPluginSnapshot?.(nextRuntime?.plugins || {});
    state.installedAgentSkills = app.installedAgentSkillsForRuntime(nextRuntime || {});
    const resolvedRuntimePreferences = app.resolveRuntimeBackendChoice(state.runtimePreferences, nextRuntime || state.runtimePreferences);
    app.refreshSelectedBackendRuntime(resolvedRuntimePreferences.backendId || nextRuntime.backendId || "");
    app.renderCodexProjectOptions(app.workspacesForSelectedAgent(state.codexWorkspaces, normalizedAgentId), selectedWorkspaceKey, state.codexAgentOnline);
    if (selectedWorkspaceKey) elements.codexProject.value = selectedWorkspaceKey;
    app.applyRuntimeDraft(app.runtimeChoiceWithFallback(resolvedRuntimePreferences, nextRuntime || state.runtimePreferences), {
      persist: false,
      dirty: state.runtimeDirty
    });
    await app.loadWorkspaceRuntimePreference?.({ force: true });
    app.refreshTopbarProjectChip();
    app.renderProjectPicker(state.codexAgentOnline);
    await app.loadQuickSkills({ silent: true });
    await app.loadCodexJobs({ skipSelectedDetailLoad: false });
  };

  app.handleGlobalKeydown = function handleGlobalKeydown(event) {
    if (event.key !== "Escape") return;
    if (elements.agentSkillsPanel && !elements.agentSkillsPanel.hidden) {
      event.preventDefault();
      app.closeAgentSkillsPanel({ restoreFocus: true });
      return;
    }
    if (elements.quickSkillsPanel && !elements.quickSkillsPanel.hidden) {
      event.preventDefault();
      app.closeQuickSkillsPanel({ restoreFocus: true });
      return;
    }
    if (elements.projectImportPanel && !elements.projectImportPanel.hidden) {
      event.preventDefault();
      app.closeProjectImportPanel({ restoreFocus: true });
      return;
    }
    if (elements.mobileSettingsPanel && !elements.mobileSettingsPanel.hidden) {
      event.preventDefault();
      app.closeMobileSettingsPage({ restoreFocus: true });
      return;
    }
    if (elements.codexView.classList.contains("sessions-open")) {
      event.preventDefault();
      app.closeSessionSidebar();
    }
  };

  app.selectProject = async function selectProject(projectId) {
    if (!projectId) return;
    const selectedWorkspace = app.workspaceForSelectionKey(projectId);
    const nextProjectKey = selectedWorkspace?.key || String(projectId || "").trim();
    const previous = elements.codexProject.value;
    elements.codexProject.value = nextProjectKey;
    app.persistCodexProjectKey?.(nextProjectKey);
    if (previous !== nextProjectKey) {
      state.composingNewSession = false;
      state.selectedCodexJobId = "";
      state.selectedCodexSession = null;
      app.closeCodexSessionStream?.();
      app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
      app.renderEmptySessionDetail({ title: "切换工程", body: "正在打开这个工程的最近会话。" });
      elements.codexJobs.innerHTML = '<div class="empty-state">正在加载会话...</div>';
    }
    app.restoreComposerMode?.({ includeSession: false });
    app.syncProjectPicker();
    app.updateComposerAvailability();
    if (previous && previous !== nextProjectKey) {
      app.toast(`已切换到 ${app.workspaceLabel(selectedWorkspace || { id: nextProjectKey })}`);
    }
    app.closeProjectSwitcher();
    if (previous !== nextProjectKey) {
      try {
        await app.loadWorkspaceRuntimePreference?.({ force: true });
        await app.loadQuickSkills({ silent: true });
        await app.loadCodexJobs();
      } catch (error) {
        if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
          app.toast(error.message);
        }
      }
    }
  };

  app.syncProjectPicker = function syncProjectPicker() {
    const workspace = state.codexWorkspaces.find((item) => item.key === elements.codexProject.value);
    const hasProjects = state.codexWorkspaces.length > 0;
    app.updateProjectSummary(workspace, hasProjects);
    app.refreshTopbarProjectChip();
    app.renderProjectSheetList();
    app.refreshActiveSessionHeader();
  };
}
