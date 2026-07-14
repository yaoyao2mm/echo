export function installOpenSpec(app) {
  const { document, elements, state, window: windowRef } = app;

  app.toggleOpenSpecPanel = async function toggleOpenSpecPanel(event) {
    event?.stopPropagation();
    if (!elements.openSpecPanel) return;
    if (elements.openSpecPanel.hidden && elements.openSpecRunPage?.hidden !== false) {
      await app.openOpenSpecPanel();
      return;
    }
    app.closeOpenSpecPanel({ restoreFocus: true });
  };

  app.openOpenSpecPanel = async function openOpenSpecPanel() {
    if (!elements.openSpecPanel) return;
    if (!app.isDesktopPluginEnabled?.("open-spec")) return;
    if (elements.codexView?.classList.contains("sessions-open")) app.closeSessionSidebar?.({ restoreFocus: false });
    if (elements.codexView?.classList.contains("files-open")) app.closeFileBrowser?.({ restoreFocus: false });
    app.closeProjectSwitcher?.();
    app.closeQuickSkillsPanel?.();
    app.closeAgentSkillsPanel?.();
    app.closeMcpPanel?.();
    app.closeDesktopPluginPanel?.();
    app.setTopbarCollapsed?.(false);

    if (state.openSpecCloseTimer) {
      windowRef.clearTimeout(state.openSpecCloseTimer);
      state.openSpecCloseTimer = null;
    }
    elements.openSpecPanel.hidden = false;
    if (elements.openSpecRunPage) elements.openSpecRunPage.hidden = true;
    elements.openSpecButton?.setAttribute("aria-expanded", "true");
    elements.sessionBackdrop.hidden = false;
    elements.sessionBackdrop.dataset.layer = "open-spec";
    elements.sessionBackdrop.setAttribute("aria-label", "关闭 Open Spec");
    elements.openSpecPanel.getBoundingClientRect?.();
    elements.codexView?.classList.add("open-spec-open");
    app.syncBodySheetState?.();

    const projectKey = app.openSpecProjectKey();
    if (state.openSpecProjectId !== projectKey) {
      app.restoreCachedOpenSpecSummary(projectKey);
    }
    if (!state.openSpecSummary || state.openSpecProjectId !== projectKey || state.openSpecError) {
      await app.loadOpenSpecSummary({ silent: true });
    } else {
      app.renderOpenSpecPanel();
    }
    if (app.orchestrationAvailable() && !state.orchestrationRun) await app.loadActiveOrchestration();
  };

  app.closeOpenSpecPanel = function closeOpenSpecPanel({ restoreFocus = false } = {}) {
    if (!elements.openSpecPanel || (elements.openSpecPanel.hidden && elements.openSpecRunPage?.hidden !== false)) return;
    elements.openSpecButton?.setAttribute("aria-expanded", "false");
    elements.codexView?.classList.remove("open-spec-open");
    app.syncBodySheetState?.();
    elements.sessionBackdrop.hidden = true;
    delete elements.sessionBackdrop.dataset.layer;
    elements.sessionBackdrop.setAttribute("aria-label", "关闭会话列表");
    if (state.openSpecCloseTimer) windowRef.clearTimeout(state.openSpecCloseTimer);
    state.openSpecCloseTimer = windowRef.setTimeout(() => {
      state.openSpecCloseTimer = null;
      if (!elements.codexView?.classList.contains("open-spec-open")) {
        elements.openSpecPanel.hidden = true;
        if (elements.openSpecRunPage) elements.openSpecRunPage.hidden = true;
      }
    }, 220);
    if (restoreFocus) elements.openSpecButton?.focus?.({ preventScroll: true });
  };

  app.orchestrationAvailable = function orchestrationAvailable() {
    return app.isDesktopPluginEnabled?.("orchestration") === true;
  };

  app.openOrchestrationRunPage = function openOrchestrationRunPage() {
    if (!state.orchestrationRun || !elements.openSpecRunPage) return;
    elements.openSpecPanel.hidden = true;
    elements.openSpecRunPage.hidden = false;
    elements.openSpecRunPage.getBoundingClientRect?.();
    elements.codexView?.classList.add("open-spec-open");
    app.renderOpenSpecRunPage();
  };

  app.closeOrchestrationRunPage = function closeOrchestrationRunPage() {
    if (!elements.openSpecRunPage) return;
    elements.openSpecRunPage.hidden = true;
    elements.openSpecPanel.hidden = false;
    app.renderOpenSpecPanel();
  };

  app.backOpenSpecPlanning = function backOpenSpecPlanning() {
    if (state.openSpecMode === "confirm") state.openSpecMode = "select";
    else if (state.openSpecMode === "select") state.openSpecMode = "browse";
    else return;
    state.orchestrationError = "";
    app.renderOpenSpecPanel();
  };

  app.enterOpenSpecOrchestrationSelection = function enterOpenSpecOrchestrationSelection() {
    if (!app.orchestrationAvailable() || state.orchestrationBusy) return;
    state.openSpecMode = "select";
    state.orchestrationSelectedIds = new Set();
    state.orchestrationOrder = [];
    state.orchestrationError = "";
    app.renderOpenSpecPanel();
  };

  app.cancelOpenSpecOrchestration = function cancelOpenSpecOrchestration() {
    state.openSpecMode = "browse";
    state.orchestrationSelectedIds = new Set();
    state.orchestrationOrder = [];
    state.orchestrationError = "";
    app.renderOpenSpecPanel();
  };

  app.toggleOrchestrationChange = function toggleOrchestrationChange(changeId) {
    const selected = new Set(state.orchestrationSelectedIds || []);
    if (selected.has(changeId)) selected.delete(changeId);
    else selected.add(changeId);
    state.orchestrationSelectedIds = selected;
    state.orchestrationOrder = [...selected];
    app.renderOpenSpecPanel();
  };

  app.confirmOpenSpecOrchestrationSelection = function confirmOpenSpecOrchestrationSelection() {
    if (!(state.orchestrationSelectedIds?.size > 0)) return;
    state.openSpecMode = "confirm";
    state.orchestrationOrder = (state.openSpecSummary?.changes || [])
      .filter((change) => state.orchestrationSelectedIds.has(change.id) && app.orchestrationEligibleChange(change))
      .map((change) => change.id);
    app.renderOpenSpecPanel();
  };

  app.moveOrchestrationChange = function moveOrchestrationChange(changeId, direction) {
    const order = [...state.orchestrationOrder];
    const index = order.indexOf(changeId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    state.orchestrationOrder = order;
    app.renderOpenSpecPanel();
  };

  app.startOpenSpecOrchestration = async function startOpenSpecOrchestration() {
    if (state.orchestrationBusy || !state.orchestrationOrder.length) return;
    state.orchestrationBusy = true;
    state.orchestrationError = "";
    app.renderOpenSpecPanel();
    try {
      const runtime = app.currentRuntimeDraft?.() || {};
      const data = await app.apiPost("/api/codex/orchestrations", {
        projectId: app.currentProjectId(),
        targetAgentId: app.currentTargetAgentId?.() || "",
        items: app.orchestrationItemsForOrder(),
        runtimePolicy: {
          backendId: runtime.backendId || "",
          model: runtime.model || "",
          permissionMode: runtime.permissionMode || "default",
          maxConcurrency: app.orchestrationMaxConcurrency()
        }
      }, { timeoutMs: 45000 });
      state.orchestrationRun = data.run || null;
      state.openSpecMode = "browse";
      await app.connectOrchestrationEvents();
    } catch (error) {
      state.orchestrationError = error.message;
    } finally {
      state.orchestrationBusy = false;
      app.renderOpenSpecPanel();
    }
  };

  app.orchestrationItemsForOrder = function orchestrationItemsForOrder() {
    const byId = new Map((state.openSpecSummary?.changes || []).map((change) => [change.id, change]));
    const selected = new Set(state.orchestrationOrder);
    return state.orchestrationOrder.map((changeId) => {
      const change = byId.get(changeId);
      const explicit = Array.isArray(change?.dependsOn) ? change.dependsOn : [];
      return { changeId, dependsOn: [...new Set(explicit.filter((dependency) => selected.has(dependency)))] };
    });
  };

  app.orchestrationMaxConcurrency = function orchestrationMaxConcurrency() {
    const advertised = Number(
      state.codexAgentRuntime?.capabilities?.orchestration?.maxConcurrency ||
      state.codexAgentRuntime?.sessionConcurrency ||
      2
    );
    return Number.isFinite(advertised) ? Math.max(1, Math.min(8, Math.trunc(advertised))) : 1;
  };

  app.orchestrationEligibleChange = function orchestrationEligibleChange(change) {
    if (!change || change.archived || ["archived", "complete", "completed"].includes(change.status)) return false;
    const completed = Number(change.progress?.completedTasks || 0);
    const total = Number(change.progress?.totalTasks || 0);
    return !(total > 0 && completed >= total);
  };

  app.loadActiveOrchestration = async function loadActiveOrchestration() {
    if (!app.orchestrationAvailable() || !app.currentProjectId()) return null;
    try {
      const query = new URLSearchParams({
        projectId: app.currentProjectId(),
        targetAgentId: app.currentTargetAgentId?.() || "",
        active: "true",
        limit: "1"
      });
      const data = await app.apiGet(`/api/codex/orchestrations?${query}`);
      const run = data.items?.[0] || null;
      if (run) {
        state.orchestrationRun = run;
        state.openSpecMode = "browse";
        await app.connectOrchestrationEvents();
      }
      return run;
    } catch {
      return null;
    }
  };

  app.connectOrchestrationEvents = async function connectOrchestrationEvents() {
    app.stopOrchestrationEvents();
    const runId = state.orchestrationRun?.id;
    if (!runId || !app.orchestrationAvailable()) return;
    try {
      const ticket = await app.apiPost(`/api/codex/orchestrations/${encodeURIComponent(runId)}/events-ticket`, {});
      const source = new windowRef.EventSource(`/api/codex/orchestrations/${encodeURIComponent(runId)}/events?ticket=${encodeURIComponent(ticket.ticket)}`);
      state.orchestrationEventSource = source;
      source.addEventListener("run", (event) => {
        const payload = JSON.parse(event.data || "{}");
        if (payload.run?.id === runId) {
          state.orchestrationRun = payload.run;
          app.renderOpenSpecPanel();
          app.renderOpenSpecRunPage();
        }
      });
      source.onerror = () => {
        source.close();
        if (state.orchestrationEventSource === source) state.orchestrationEventSource = null;
        app.scheduleOrchestrationPoll();
      };
    } catch {
      app.scheduleOrchestrationPoll();
    }
  };

  app.scheduleOrchestrationPoll = function scheduleOrchestrationPoll() {
    if (state.orchestrationPollTimer || !state.orchestrationRun?.id || !app.orchestrationAvailable()) return;
    state.orchestrationPollTimer = windowRef.setTimeout(async () => {
      state.orchestrationPollTimer = null;
      try {
        const data = await app.apiGet(`/api/codex/orchestrations/${encodeURIComponent(state.orchestrationRun.id)}`);
        if (data.run) state.orchestrationRun = data.run;
      } catch {
        state.orchestrationRun = { ...state.orchestrationRun, stale: true };
      }
      app.renderOpenSpecPanel();
      app.renderOpenSpecRunPage();
      if (!["completed", "failed", "cancelled"].includes(state.orchestrationRun?.status)) app.scheduleOrchestrationPoll();
    }, 5000);
  };

  app.stopOrchestrationEvents = function stopOrchestrationEvents() {
    state.orchestrationEventSource?.close?.();
    state.orchestrationEventSource = null;
    if (state.orchestrationPollTimer) windowRef.clearTimeout(state.orchestrationPollTimer);
    state.orchestrationPollTimer = null;
  };

  app.controlOrchestration = async function controlOrchestration(action) {
    const runId = state.orchestrationRun?.id;
    if (!runId || state.orchestrationBusy) return;
    state.orchestrationBusy = true;
    app.renderOpenSpecPanel();
    try {
      const data = await app.apiPost(`/api/codex/orchestrations/${encodeURIComponent(runId)}/${action}`, {});
      state.orchestrationRun = data.run || state.orchestrationRun;
    } catch (error) {
      state.orchestrationError = error.message;
    } finally {
      state.orchestrationBusy = false;
      app.renderOpenSpecPanel();
      app.renderOpenSpecRunPage();
    }
  };

  app.retryOrchestrationItem = async function retryOrchestrationItem(itemId) {
    const runId = state.orchestrationRun?.id;
    if (!runId || state.orchestrationBusy) return;
    state.orchestrationBusy = true;
    try {
      const data = await app.apiPost(`/api/codex/orchestrations/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/retry`, {});
      state.orchestrationRun = data.run || state.orchestrationRun;
    } catch (error) {
      state.orchestrationError = error.message;
      app.toast?.(error.message);
    } finally {
      state.orchestrationBusy = false;
      app.renderOpenSpecPanel();
      app.renderOpenSpecRunPage();
    }
  };

  app.recoverOrchestrationItem = async function recoverOrchestrationItem(itemId) {
    const runId = state.orchestrationRun?.id;
    if (!runId || state.orchestrationBusy) return;
    state.orchestrationBusy = true;
    app.renderOpenSpecRunPage();
    try {
      const path = `/api/codex/orchestrations/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/recover`;
      const data = await app.apiPost(path, {});
      state.orchestrationRun = data.run || state.orchestrationRun;
      app.toast?.("Echo 已开始处理");
    } catch (error) {
      state.orchestrationError = error.message;
      app.toast?.(error.message);
    } finally {
      state.orchestrationBusy = false;
      app.renderOpenSpecPanel();
      app.renderOpenSpecRunPage();
    }
  };

  app.refreshOpenSpecSummary = async function refreshOpenSpecSummary() {
    await app.loadOpenSpecSummary({ force: true });
  };

  app.openSpecExplorePromptPrefix = function openSpecExplorePromptPrefix() {
    return [
      "请使用 OpenSpec Explore 流程探索一个 change。",
      "",
      "要求：",
      "- 使用项目里的 OpenSpec 流程新建 change，并补齐 proposal、tasks 和 specs delta。",
      "- 只做 Explore/Proposal，不要实现代码，不要 apply，不要 archive，除非我明确要求。",
      "- 如果需要执行 CLI，使用 `openspec new change <change-id>`。",
      "- 完成后简短汇报 change id 和建议的下一步。",
      "",
      "我要探索："
    ].join("\n");
  };

  app.prefillOpenSpecExplorePrompt = function prefillOpenSpecExplorePrompt(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const input = elements.codexPrompt;
    if (!input || state.composerBusy) return;
    if (!app.currentProjectId()) {
      app.toast?.("先选择工程");
      return;
    }
    const prefix = app.openSpecExplorePromptPrefix();
    const current = String(input.value || "").trim();
    const nextValue = current && !current.startsWith(prefix) ? `${prefix}${current}` : current || prefix;
    input.value = nextValue;
    const cursor = nextValue.length;
    input.setSelectionRange?.(cursor, cursor);
    app.syncComposerInputHeight?.();
    app.updateComposerAvailability?.();
    app.closeOpenSpecPanel?.({ restoreFocus: false });
    input.focus?.({ preventScroll: true });
    app.toast?.("已填入 Explore 前缀");
  };

  app.loadOpenSpecSummary = async function loadOpenSpecSummary(options = {}) {
    const projectId = app.currentProjectId();
    const targetAgentId = app.currentTargetAgentId?.() || "";
    const projectKey = app.openSpecProjectKey();
    if (!app.isDesktopPluginEnabled?.("open-spec")) {
      state.openSpecSummary = null;
      state.openSpecError = "";
      state.openSpecStale = false;
      state.openSpecProjectId = "";
      app.renderOpenSpecPanel();
      app.updateOpenSpecAvailability();
      return null;
    }
    if (!projectId) {
      state.openSpecSummary = null;
      state.openSpecError = "";
      state.openSpecStale = false;
      state.openSpecProjectId = "";
      app.renderOpenSpecPanel();
      app.updateOpenSpecAvailability();
      return null;
    }

    if (!app.codexCommandsAvailable?.()) {
      const restored = app.restoreCachedOpenSpecSummary(projectKey);
      if (!restored) {
        state.openSpecError = state.codexConnectionState === "error" ? "连接中断" : "等待桌面 agent";
        if (!options.silent) app.toast(state.openSpecError);
      }
      app.renderOpenSpecPanel();
      app.updateOpenSpecAvailability();
      return state.openSpecSummary;
    }

    const requestSeq = Number(state.openSpecRequestSeq || 0) + 1;
    state.openSpecRequestSeq = requestSeq;
    state.openSpecBusy = true;
    state.openSpecError = "";
    state.openSpecProjectId = projectKey;
    app.renderOpenSpecPanel();
    try {
      const data = await app.apiPost(
        "/api/codex/open-spec/summary",
        {
          projectId,
          targetAgentId,
          maxChanges: 80,
          maxSpecs: 120
        },
        { timeoutMs: 42000 }
      );
      if (requestSeq !== state.openSpecRequestSeq || projectKey !== app.openSpecProjectKey()) return state.openSpecSummary;
      const summary = app.normalizeOpenSpecSummary(data.openSpec);
      state.openSpecSummary = summary;
      state.openSpecProjectId = projectKey;
      state.openSpecStale = false;
      state.openSpecError = "";
      app.rememberOpenSpecSummary(projectKey, summary);
      return summary;
    } catch (error) {
      if (requestSeq !== state.openSpecRequestSeq) return state.openSpecSummary;
      const restored = app.restoreCachedOpenSpecSummary(projectKey, { preserveCurrent: true });
      state.openSpecError = restored ? "" : error.message;
      if (!app.handleAuthError?.(error, "当前配对已失效，请重新扫描桌面端二维码。") && !options.silent && !restored) {
        app.toast(error.message);
      }
      return state.openSpecSummary;
    } finally {
      if (requestSeq === state.openSpecRequestSeq) {
        state.openSpecBusy = false;
        app.renderOpenSpecPanel();
        app.updateOpenSpecAvailability();
      }
    }
  };

  app.normalizeOpenSpecSummary = function normalizeOpenSpecSummary(summary = {}) {
    const source = summary && typeof summary === "object" ? summary : {};
    const overview = source.overview && typeof source.overview === "object" ? source.overview : {};
    return {
      projectId: String(source.projectId || ""),
      workspace: source.workspace || {},
      available: Boolean(source.available),
      directoryName: String(source.directoryName || ""),
      directoryPath: String(source.directoryPath || ""),
      generatedAt: String(source.generatedAt || ""),
      overview: {
        totalChanges: Number(overview.totalChanges || 0) || 0,
        totalChangeEntries: Number(overview.totalChangeEntries || 0) || 0,
        activeChanges: Number(overview.activeChanges || 0) || 0,
        archivedChanges: Number(overview.archivedChanges || 0) || 0,
        completedChanges: Number(overview.completedChanges || 0) || 0,
        changesWithTasks: Number(overview.changesWithTasks || 0) || 0,
        totalTasks: Number(overview.totalTasks || 0) || 0,
        completedTasks: Number(overview.completedTasks || 0) || 0,
        percentComplete: Number.isFinite(Number(overview.percentComplete)) ? Number(overview.percentComplete) : null,
        specCount: Number(overview.specCount || 0) || 0,
        totalSpecEntries: Number(overview.totalSpecEntries || 0) || 0,
        truncated: Boolean(overview.truncated)
      },
      changes: Array.isArray(source.changes) ? source.changes.map(app.normalizeOpenSpecChange).filter(Boolean) : [],
      specs: Array.isArray(source.specs) ? source.specs.map(app.normalizeOpenSpecSpec).filter(Boolean) : [],
      warnings: Array.isArray(source.warnings) ? source.warnings.map((item) => String(item || "")).filter(Boolean) : []
    };
  };

  app.normalizeOpenSpecChange = function normalizeOpenSpecChange(change = {}) {
    const id = String(change.id || "").trim();
    if (!id) return null;
    const progress = change.progress && typeof change.progress === "object" ? change.progress : {};
    const proposal = change.proposal && typeof change.proposal === "object" ? change.proposal : {};
    const design = change.design && typeof change.design === "object" ? change.design : {};
    const tasks = change.tasks && typeof change.tasks === "object" ? change.tasks : {};
    return {
      id,
      title: String(change.title || id).trim(),
      path: String(change.path || ""),
      status: String(change.status || "planned"),
      archived: Boolean(change.archived || String(change.status || "").toLowerCase() === "archived"),
      archiveId: String(change.archiveId || ""),
      archivedAt: String(change.archivedAt || ""),
      updatedAt: String(change.updatedAt || ""),
      progress: {
        completedTasks: Number(progress.completedTasks || 0) || 0,
        totalTasks: Number(progress.totalTasks || 0) || 0,
        percent: Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : null
      },
      proposal: {
        why: String(proposal.why || ""),
        excerpt: String(proposal.excerpt || ""),
        whatChanges: Array.isArray(proposal.whatChanges) ? proposal.whatChanges.map((item) => String(item || "")).filter(Boolean) : [],
        truncated: Boolean(proposal.truncated),
        path: String(proposal.path || "")
      },
      design: {
        excerpt: String(design.excerpt || ""),
        truncated: Boolean(design.truncated),
        path: String(design.path || "")
      },
      affectedSpecs: Array.isArray(change.affectedSpecs) ? change.affectedSpecs.map((item) => String(item || "")).filter(Boolean) : [],
      tasks: {
        groups: Array.isArray(tasks.groups) ? tasks.groups.map(app.normalizeOpenSpecTaskGroup).filter(Boolean) : [],
        truncated: Boolean(tasks.truncated)
      },
      hasDesign: Boolean(change.hasDesign),
      hasProposal: Boolean(change.hasProposal),
      hasTasks: Boolean(change.hasTasks)
    };
  };

  app.normalizeOpenSpecTaskGroup = function normalizeOpenSpecTaskGroup(group = {}) {
    const title = String(group.title || "Tasks").trim();
    const tasks = Array.isArray(group.tasks)
      ? group.tasks.map((task) => ({
          text: String(task?.text || "").trim(),
          checked: Boolean(task?.checked)
        })).filter((task) => task.text)
      : [];
    return tasks.length ? { title, tasks } : null;
  };

  app.normalizeOpenSpecSpec = function normalizeOpenSpecSpec(spec = {}) {
    const id = String(spec.id || "").trim();
    if (!id) return null;
    return {
      id,
      title: String(spec.title || id).trim(),
      path: String(spec.path || ""),
      updatedAt: String(spec.updatedAt || ""),
      requirementCount: Number(spec.requirementCount || 0) || 0,
      truncated: Boolean(spec.truncated)
    };
  };

  app.openSpecProjectKey = function openSpecProjectKey() {
    return String(app.currentWorkspace?.()?.key || app.currentProjectId() || "").trim();
  };

  app.openSpecProjectCache = function openSpecProjectCache() {
    if (!state.openSpecSummariesByProject || typeof state.openSpecSummariesByProject !== "object") {
      state.openSpecSummariesByProject = {};
    }
    return state.openSpecSummariesByProject;
  };

  app.rememberOpenSpecSummary = function rememberOpenSpecSummary(projectKey, summary) {
    const key = String(projectKey || "").trim();
    if (!key || !summary) return;
    app.openSpecProjectCache()[key] = summary;
  };

  app.cachedOpenSpecSummary = function cachedOpenSpecSummary(projectKey) {
    const key = String(projectKey || "").trim();
    if (!key) return null;
    return app.openSpecProjectCache()[key] || null;
  };

  app.restoreCachedOpenSpecSummary = function restoreCachedOpenSpecSummary(projectKey, options = {}) {
    const key = String(projectKey || "").trim();
    const cached = app.cachedOpenSpecSummary(key);
    if (!cached && !(options.preserveCurrent && state.openSpecSummary)) return false;
    if (cached) state.openSpecSummary = cached;
    state.openSpecProjectId = key;
    state.openSpecStale = true;
    state.openSpecError = "";
    return true;
  };

  app.updateOpenSpecAvailability = function updateOpenSpecAvailability() {
    if (!elements.openSpec || !elements.openSpecButton) return;
    const authenticated = typeof app.isLoggedIn === "function" ? app.isLoggedIn() : Boolean(state.token);
    const enabled = app.isDesktopPluginEnabled?.("open-spec") === true;
    elements.openSpec.hidden = !authenticated || !enabled;
    elements.openSpecButton.disabled = Boolean(state.openSpecBusy) || !authenticated || !enabled;
    elements.openSpecButton.title = "Open Spec";
  };

  app.renderOpenSpecPanel = function renderOpenSpecPanel() {
    if (!elements.openSpecPanel) return;
    const workspace = app.currentWorkspace?.();
    if (elements.openSpecOrchestrationActions) {
      elements.openSpecOrchestrationActions.hidden = true;
      elements.openSpecOrchestrationActions.innerHTML = "";
    }
    const summary = state.openSpecSummary;
    const title = workspace ? app.workspaceDirectoryName?.(workspace) || workspace.label || workspace.id : "Open Spec";
    elements.openSpecPanel.classList.toggle("is-busy", Boolean(state.openSpecBusy));
    elements.openSpecPanel.classList.toggle("is-stale", Boolean(state.openSpecStale));
    elements.openSpecPanel.dataset.mode = state.openSpecMode || "browse";
    const planning = state.openSpecMode === "select" || state.openSpecMode === "confirm";
    if (elements.openSpecBackButton) elements.openSpecBackButton.hidden = !planning;
    if (elements.openSpecCloseButton) elements.openSpecCloseButton.hidden = planning;
    elements.openSpecTitle.textContent = title;
    elements.openSpecMeta.textContent = summary?.directoryName
      ? `${summary.directoryName}${state.openSpecStale ? " · 离线缓存" : ""}`
      : "当前工程";
    if (elements.openSpecExploreButton) {
      elements.openSpecExploreButton.hidden = (state.openSpecMode || "browse") !== "browse";
      elements.openSpecExploreButton.disabled = Boolean(state.composerBusy) || !app.currentProjectId();
    }
    if (elements.openSpecOrchestrationButton) {
      elements.openSpecOrchestrationButton.hidden = !app.orchestrationAvailable() || (state.openSpecMode || "browse") !== "browse";
      elements.openSpecOrchestrationButton.disabled = Boolean(state.orchestrationBusy);
    }
    elements.openSpecRefreshButton.disabled = state.openSpecBusy || !app.currentProjectId() || !app.codexCommandsAvailable?.();
    app.renderOpenSpecStatus();
    app.renderOpenSpecOverview();
    app.renderOrchestrationProgress();
    app.renderOpenSpecTimeline();
  };

  app.renderOrchestrationProgress = function renderOrchestrationProgress() {
    const root = elements.openSpecRunProgress;
    if (!root) return;
    const run = state.orchestrationRun;
    const visible = Boolean(run) && (state.openSpecMode || "browse") === "browse";
    root.hidden = !visible;
    if (!visible) {
      root.innerHTML = "";
      return;
    }
    const progress = run.progress || {};
    const completed = Math.max(0, Number(progress.completed || 0) || 0);
    const total = Math.max(completed, Number(progress.total || run.items?.length || 0) || 0);
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    root.className = `open-spec-run-progress is-${app.orchestrationRunStateClass(run.status)}`;
    root.innerHTML = `
      <button type="button" class="open-spec-run-progress-button" aria-label="查看编排详情">
        <span class="open-spec-run-progress-copy">
          <strong>${app.escapeHtml(run.title || "OpenSpec 编排")}</strong>
          <small>${app.escapeHtml(app.orchestrationRunLabel(run.status))} · ${completed}/${total}</small>
        </span>
        <span class="open-spec-run-progress-track" aria-hidden="true"><i style="transform: scaleX(${percent / 100})"></i></span>
        <span class="open-spec-run-progress-value">${percent}%</span>
      </button>
    `;
    root.querySelector(".open-spec-run-progress-button")?.addEventListener("click", app.openOrchestrationRunPage);
  };

  app.renderOpenSpecStatus = function renderOpenSpecStatus() {
    if (!elements.openSpecStatus) return;
    if (state.orchestrationError) {
      elements.openSpecStatus.textContent = state.orchestrationError;
      return;
    }
    if (state.openSpecMode === "select") {
      const eligible = (state.openSpecSummary?.changes || []).filter(app.orchestrationEligibleChange).length;
      elements.openSpecStatus.textContent = `${eligible} 项可编排 · 已选 ${state.orchestrationSelectedIds?.size || 0} 项`;
      return;
    }
    if (state.openSpecMode === "confirm") {
      elements.openSpecStatus.textContent = `最多同时执行 ${app.orchestrationMaxConcurrency()} 项`;
      return;
    }
    if (state.openSpecBusy) {
      elements.openSpecStatus.textContent = "读取 Open Spec...";
      return;
    }
    if (state.openSpecError) {
      elements.openSpecStatus.textContent = state.openSpecError;
      return;
    }
    const summary = state.openSpecSummary;
    if (!summary) {
      elements.openSpecStatus.textContent = app.codexCommandsAvailable?.() ? "等待读取" : "等待桌面 agent";
      return;
    }
    if (!summary.available) {
      elements.openSpecStatus.textContent = "当前工程没有 Open Spec 目录。";
      return;
    }
    const overview = summary.overview || {};
    const archived = overview.archivedChanges ? ` · ${overview.archivedChanges} archived` : "";
    elements.openSpecStatus.textContent = `${overview.completedTasks || 0}/${overview.totalTasks || 0} tasks · ${overview.totalChanges || 0} changes${archived} · ${overview.specCount || 0} specs`;
  };

  app.renderOpenSpecOverview = function renderOpenSpecOverview() {
    if (!elements.openSpecOverview) return;
    elements.openSpecOverview.innerHTML = "";
    const summary = state.openSpecSummary;
    if ((state.openSpecMode || "browse") !== "browse") return;
    if (!summary?.available) return;
    const overview = summary.overview || {};
    const percent = overview.percentComplete === null ? "—" : `${overview.percentComplete}%`;
    const metrics = [
      { label: "Progress", value: percent },
      { label: "Tasks", value: `${overview.completedTasks || 0}/${overview.totalTasks || 0}` },
      { label: "Active", value: String(overview.activeChanges || 0) },
      { label: "Specs", value: String(overview.specCount || 0) }
    ];
    for (const metric of metrics) {
      const node = document.createElement("div");
      node.className = "open-spec-metric";
      node.innerHTML = `
        <span>${app.escapeHtml(metric.label)}</span>
        <strong>${app.escapeHtml(metric.value)}</strong>
      `;
      elements.openSpecOverview.append(node);
    }
  };

  app.renderOpenSpecTimeline = function renderOpenSpecTimeline() {
    if (!elements.openSpecTimeline) return;
    elements.openSpecTimeline.innerHTML = "";
    const summary = state.openSpecSummary;
    if (state.openSpecMode === "select") return app.renderOrchestrationSelection();
    if (state.openSpecMode === "confirm") return app.renderOrchestrationConfirmation();
    if (!summary) {
      elements.openSpecTimeline.innerHTML = '<div class="open-spec-empty">选择工程后读取 Open Spec。</div>';
      return;
    }
    if (!summary.available) {
      elements.openSpecTimeline.innerHTML = '<div class="open-spec-empty">没有检测到 `.OpenSpec`、`openspec`、`.openspec` 或 `OpenSpec`。</div>';
      return;
    }
    if (!summary.changes.length) {
      elements.openSpecTimeline.innerHTML = '<div class="open-spec-empty">Open Spec 目录里还没有 changes。</div>';
      return;
    }
    for (const change of summary.changes) {
      elements.openSpecTimeline.append(app.renderOpenSpecChange(change));
    }
  };

  app.renderOrchestrationSelection = function renderOrchestrationSelection() {
    const changes = (state.openSpecSummary?.changes || []).filter(app.orchestrationEligibleChange);
    if (!changes.length) {
      elements.openSpecTimeline.innerHTML = '<div class="orchestration-empty"><strong>没有待执行的 change</strong><span>已完成和已归档项目不会进入编排。</span></div>';
      app.renderOrchestrationActions('<button type="button" class="secondary" data-orchestration-action="cancel">返回</button>');
      return;
    }
    for (const change of changes) {
      const row = document.createElement("label");
      row.className = "orchestration-select-row";
      const selected = state.orchestrationSelectedIds?.has(change.id);
      const taskCount = Number(change.progress?.totalTasks || 0);
      const taskMeta = taskCount ? `${Number(change.progress?.completedTasks || 0)}/${taskCount}` : "无任务清单";
      row.innerHTML = `<input type="checkbox" ${selected ? "checked" : ""}><span><strong>${app.escapeHtml(change.title || change.id)}</strong><small>${app.escapeHtml(taskMeta)}</small></span><em>${app.escapeHtml(app.openSpecStatusLabel(change.status))}</em>`;
      row.querySelector("input")?.addEventListener("change", () => app.toggleOrchestrationChange(change.id));
      elements.openSpecTimeline.append(row);
    }
    app.renderOrchestrationActions(`
      <button type="button" class="secondary" data-orchestration-action="cancel">取消</button>
      <button type="button" class="primary" data-orchestration-action="next" ${state.orchestrationSelectedIds?.size ? "" : "disabled"}>下一步</button>
    `);
  };

  app.renderOrchestrationConfirmation = function renderOrchestrationConfirmation() {
    const byId = new Map((state.openSpecSummary?.changes || []).map((change) => [change.id, change]));
    const items = app.orchestrationItemsForOrder();
    const parallelCount = items.filter((item) => item.dependsOn.length === 0).length;
    const summary = document.createElement("div");
    summary.className = "orchestration-plan-summary";
    summary.innerHTML = `<strong>${state.orchestrationOrder.length} 项任务</strong><span>${parallelCount} 项可立即启动 · ${Math.max(0, state.orchestrationOrder.length - parallelCount)} 项等待依赖 · 并发上限 ${app.orchestrationMaxConcurrency()}</span>`;
    elements.openSpecTimeline.append(summary);
    state.orchestrationOrder.forEach((changeId, index) => {
      const change = byId.get(changeId);
      const row = document.createElement("div");
      row.className = "orchestration-order-row";
      const dependencies = items.find((item) => item.changeId === changeId)?.dependsOn || [];
      const dependencyNames = dependencies.map((id) => byId.get(id)?.title || id).join("、");
      row.innerHTML = `<span>${index + 1}</span><strong>${app.escapeHtml(change?.title || changeId)}<small>${dependencies.length ? `等待 ${app.escapeHtml(dependencyNames)}` : "无依赖，可并行"}</small></strong><em class="orchestration-lane ${dependencies.length ? "is-blocked" : "is-parallel"}">${dependencies.length ? "依赖" : "并行"}</em>`;
      elements.openSpecTimeline.append(row);
    });
    app.renderOrchestrationActions(`
      <button type="button" class="secondary" data-orchestration-action="cancel">返回</button>
      <button type="button" class="primary" data-orchestration-action="start" ${state.orchestrationBusy ? "disabled" : ""}>${state.orchestrationBusy ? "创建中" : "开始"}</button>
    `);
  };

  app.renderOpenSpecRunPage = function renderOpenSpecRunPage() {
    if (!elements.openSpecRunPage || elements.openSpecRunPage.hidden) return;
    const run = state.orchestrationRun;
    if (elements.openSpecRunMeta) elements.openSpecRunMeta.textContent = run?.title || "OpenSpec 编排";
    if (elements.openSpecRunStatus) {
      const progress = run?.progress || {};
      elements.openSpecRunStatus.textContent = run
        ? `${app.orchestrationRunLabel(run.status)} · ${progress.completed || 0}/${progress.total || run.items?.length || 0} 完成${run.stale ? " · 状态可能已过期" : ""}`
        : "没有活跃编排";
    }
    app.renderOrchestrationRun({ timeline: elements.openSpecRunTimeline, actions: elements.openSpecRunActions });
  };

  app.renderOrchestrationRun = function renderOrchestrationRun(options = {}) {
    const timeline = options.timeline || elements.openSpecRunTimeline || elements.openSpecTimeline;
    const actions = options.actions || elements.openSpecRunActions || elements.openSpecOrchestrationActions;
    if (!timeline) return;
    timeline.innerHTML = "";
    const run = state.orchestrationRun;
    if (!run) {
      timeline.innerHTML = '<div class="open-spec-empty">没有活跃编排。</div>';
      app.renderOrchestrationActions('<button type="button" class="secondary" data-orchestration-action="browse">返回</button>', actions);
      return;
    }
    const byId = new Map(run.items.map((item) => [item.changeId, item]));
    const groups = [
      ["待处理", run.items.filter((item) => item.status === "attention" || item.status === "failed")],
      ["执行中", run.items.filter((item) => ["preparing", "implementing", "verifying", "integrating"].includes(item.status))],
      ["等待依赖", run.items.filter((item) => item.status === "blocked")],
      ["待启动", run.items.filter((item) => item.status === "queued")],
      ["已完成", run.items.filter((item) => ["ready", "completed"].includes(item.status))],
      ["已取消", run.items.filter((item) => item.status === "cancelled")]
    ];
    const appendGroup = (label, items) => {
      if (!items.length) return;
      const heading = document.createElement("div");
      heading.className = "orchestration-group-label";
      heading.textContent = label;
      timeline.append(heading);
      for (const item of items) {
        const row = document.createElement("div");
        row.className = `orchestration-run-row${item.status === "attention" || item.status === "failed" ? " needs-attention" : ""}`;
        const dependencies = (item.dependsOn || []).filter((id) => !["ready", "completed"].includes(byId.get(id)?.status));
        const dependencyReason = dependencies.length ? `等待 ${dependencies.map((id) => byId.get(id)?.title || id).join("、")}` : "";
        const availableActions = new Set(item.availableActions || []);
        const canRetry = availableActions.has("retry");
        const canRecover = availableActions.has("recover");
        const nextStep = !canRetry && !canRecover && (item.status === "attention" || item.status === "failed") ? "请查看详情或结束本批次。" : "";
        const reasonText = [item.errorSummary || dependencyReason, nextStep].filter(Boolean).join(" ");
        const reason = reasonText ? `<small>${app.escapeHtml(reasonText)}</small>` : "";
        const recoveryAction = canRecover
          ? '<button type="button" class="orchestration-recover">让 Echo 处理</button>'
          : (canRetry ? '<button type="button" class="orchestration-retry">重试</button>' : "");
        row.innerHTML = `<button type="button" class="orchestration-run-main"><span><strong>${app.escapeHtml(item.title || item.changeId)}</strong>${reason}</span><em>${app.escapeHtml(app.orchestrationItemLabel(item.status))}</em></button>${recoveryAction}`;
        const sessionId = item.attempts?.at(-1)?.sessionId;
        if (sessionId) row.querySelector(".orchestration-run-main")?.addEventListener("click", () => { app.closeOpenSpecPanel({ restoreFocus: false }); app.showCodexJob?.(sessionId); });
        row.querySelector(".orchestration-retry")?.addEventListener("click", () => app.retryOrchestrationItem(item.id));
        row.querySelector(".orchestration-recover")?.addEventListener("click", () => app.recoverOrchestrationItem(item.id));
        timeline.append(row);
      }
    };
    for (const [label, items] of groups) appendGroup(label, items);
    const terminal = ["completed", "failed", "cancelled"].includes(run.status);
    const runActions = new Set(run.availableActions || []);
    const canFinish = runActions.has("finish");
    const stateControl = runActions.has("resume")
      ? '<button type="button" class="secondary" data-orchestration-action="resume">继续</button>'
      : (runActions.has("pause") ? '<button type="button" class="secondary" data-orchestration-action="pause">暂停</button>' : "");
    app.renderOrchestrationActions(terminal
      ? '<button type="button" class="secondary" data-orchestration-action="browse">返回</button>'
      : `<button type="button" class="secondary" data-orchestration-action="browse">返回</button>${canFinish ? '<button type="button" class="secondary" data-orchestration-action="finish">结束本批次</button>' : ""}${stateControl}`, actions);
  };

  app.renderOrchestrationActions = function renderOrchestrationActions(html, root = elements.openSpecOrchestrationActions) {
    if (!root) return;
    root.hidden = false;
    root.innerHTML = html;
    for (const button of root.querySelectorAll("[data-orchestration-action]")) {
      button.addEventListener("click", () => {
        const action = button.dataset.orchestrationAction;
        if (action === "cancel") app.cancelOpenSpecOrchestration();
        else if (action === "next") app.confirmOpenSpecOrchestrationSelection();
        else if (action === "start") app.startOpenSpecOrchestration();
        else if (action === "browse") app.closeOrchestrationRunPage();
        else if (action === "cancel-run") app.controlOrchestration("cancel");
        else if (action === "finish") {
          const confirmed = !windowRef.confirm || windowRef.confirm("结束后 Echo 将停止自动推进，但会保留 Session、Worktree 和验收记录。确定结束本批次？");
          if (confirmed) app.controlOrchestration("finish");
        }
        else app.controlOrchestration(action);
      });
    }
  };

  app.orchestrationItemLabel = function orchestrationItemLabel(status) {
    return ({ queued: "等待", blocked: "等待", preparing: "准备中", implementing: "执行中", verifying: "验收中", ready: "已提交", integrating: "集成中", completed: "完成", attention: "待处理", failed: "待处理", cancelled: "已取消" })[status] || "等待";
  };

  app.orchestrationRunLabel = function orchestrationRunLabel(status) {
    return ({ queued: "等待开始", running: "执行中", paused: "已暂停", attention: "需要处理", integrating: "自动合入中", completed: "已合入", failed: "执行失败", cancelled: "已取消" })[status] || "执行中";
  };

  app.orchestrationRunStateClass = function orchestrationRunStateClass(status) {
    if (status === "completed") return "complete";
    if (["attention", "failed"].includes(status)) return "attention";
    if (status === "cancelled") return "cancelled";
    return "active";
  };

  app.renderOpenSpecChange = function renderOpenSpecChange(change) {
    const details = document.createElement("details");
    details.className = `open-spec-change open-spec-change-${app.openSpecStatusClass(change.status)}`;
    details.open = false;
    const isArchived = Boolean(change.archived || change.status === "archived");
    const percent = Math.max(0, Math.min(100, change.progress.percent === null ? 0 : change.progress.percent));
    const menuDisabled = state.openSpecActionBusy ? " disabled" : "";
    const archiveDisabled = isArchived || state.openSpecActionBusy ? " disabled" : "";
    const excerpt = change.proposal.excerpt || change.proposal.why || change.design.excerpt || "";
    const specs = change.affectedSpecs.slice(0, 4);
    details.setAttribute("style", `--open-spec-change-progress: ${percent}%;`);
    details.innerHTML = `
      <summary>
        <span class="open-spec-change-copy">
          <span class="open-spec-change-title-row">
            <strong>${app.escapeHtml(change.title || change.id)}</strong>
          </span>
        </span>
        <span class="open-spec-change-state">${app.escapeHtml(app.openSpecStatusLabel(change.status))}</span>
      </summary>
      <div class="open-spec-change-body">
        <div class="open-spec-change-detail-head">
          <span class="open-spec-change-id">${app.escapeHtml(change.id)}</span>
          <button class="open-spec-change-copy-button" type="button" aria-label="复制 change ID" title="复制 change ID">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 7.5A2.5 2.5 0 0 1 10.5 5h6A2.5 2.5 0 0 1 19 7.5v6A2.5 2.5 0 0 1 16.5 16h-6A2.5 2.5 0 0 1 8 13.5v-6Z" />
              <path d="M6 8.5v7A2.5 2.5 0 0 0 8.5 18h7" />
            </svg>
          </button>
        </div>
        ${excerpt ? `<p>${app.escapeHtml(excerpt)}</p>` : ""}
        ${specs.length ? `<div class="open-spec-tags">${specs.map((spec) => `<span>${app.escapeHtml(spec)}</span>`).join("")}</div>` : ""}
        <div class="open-spec-task-groups"></div>
        <div class="open-spec-change-detail-actions" aria-label="Change 操作">
          <button type="button" data-open-spec-change-action="apply"${menuDisabled}>Apply</button>
          <button type="button" data-open-spec-change-action="sync"${menuDisabled}>Sync</button>
          <button type="button" data-open-spec-change-action="validate"${menuDisabled}>Validate</button>
          <button type="button" data-open-spec-change-action="archive"${archiveDisabled}>Archive</button>
        </div>
      </div>
    `;
    const groupsRoot = details.querySelector(".open-spec-task-groups");
    if (groupsRoot) {
      if (!change.tasks.groups.length) {
        groupsRoot.innerHTML = '<div class="open-spec-task-empty">这个 change 没有 checkbox tasks。</div>';
      } else {
        for (const group of change.tasks.groups) groupsRoot.append(app.renderOpenSpecTaskGroup(group));
      }
    }
    details.querySelector(".open-spec-change-copy-button")?.addEventListener("click", (event) => {
      app.copyOpenSpecChangeId(change.id, event);
    });
    for (const button of details.querySelectorAll("[data-open-spec-change-action]")) {
      button.addEventListener("click", (event) => app.runOpenSpecChangeAction(change, button.dataset.openSpecChangeAction, event));
    }
    return details;
  };

  app.openSpecStatusLabel = function openSpecStatusLabel(status) {
    const normalized = String(status || "").trim().toLowerCase();
    if (normalized === "complete") return "完成";
    if (normalized === "archived") return "归档";
    if (normalized === "in-progress") return "进行中";
    return "计划";
  };

  app.toggleOpenSpecChangeMenu = function toggleOpenSpecChangeMenu(details, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const isOpen = details.classList.toggle("open-spec-change-menu-open");
    details.querySelector(".open-spec-change-menu-button")?.setAttribute("aria-expanded", isOpen ? "true" : "false");
  };

  app.runOpenSpecChangeAction = async function runOpenSpecChangeAction(change, action, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const changeId = String(change?.id || "").trim();
    const normalizedAction = String(action || "").trim().toLowerCase();
    if (
      !changeId ||
      (normalizedAction !== "apply" &&
        normalizedAction !== "archive" &&
        normalizedAction !== "sync" &&
        normalizedAction !== "validate")
    ) {
      return;
    }
    const projectId = app.currentProjectId();
    const targetAgentId = app.currentTargetAgentId?.() || "";
    if (!projectId) {
      app.toast?.("先选择工程");
      return;
    }
    if (!app.codexCommandsAvailable?.()) {
      app.toast?.(state.codexConnectionState === "error" ? "连接恢复后再操作" : "桌面 agent 在线后再操作");
      return;
    }

    const runtime = app.currentRuntimeDraft?.() || {};
    const prompt = app.openSpecChangeActionPrompt(changeId, normalizedAction);
    state.openSpecActionBusy = changeId;
    app.renderOpenSpecPanel();
    try {
      const body = { projectId, prompt, runtime, attachments: [], mode: "execute" };
      if (targetAgentId) body.targetAgentId = targetAgentId;
      const data = await app.apiPost("/api/codex/sessions", body);
      if (data.session?.id) {
        if (state.showArchivedSessions) {
          state.showArchivedSessions = false;
          elements.showActiveSessionsButton?.classList.add("active");
          elements.showArchivedSessionsButton?.classList.remove("active");
        }
        state.selectedCodexJobId = data.session.id;
        state.selectedCodexSession = data.session;
        state.composingNewSession = false;
        state.runtimeDirty = false;
        app.applyRuntimeDraft?.(data.session.runtime || runtime, { persist: false, dirty: false });
        app.renderCodexJob?.(data.session, { keepSelection: true, scrollToBottom: true });
        app.closeOpenSpecPanel?.({ restoreFocus: false });
        await app.showCodexJob?.(data.session.id, { keepSelection: true, scrollToBottom: true });
        app.scheduleSessionListRefresh?.({ delayMs: 300 });
      }
      const toastByAction = {
        apply: "已创建 Apply 任务",
        archive: "已创建归档任务",
        sync: "已创建 Sync 任务",
        validate: "已创建 Validate 任务"
      };
      app.toast?.(toastByAction[normalizedAction] || "已创建任务");
    } catch (error) {
      if (!app.handleAuthError?.(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast?.(error.message);
      }
    } finally {
      state.openSpecActionBusy = "";
      app.renderOpenSpecPanel();
    }
  };

  app.openSpecChangeActionPrompt = function openSpecChangeActionPrompt(changeId, action) {
    if (action === "archive") {
      return [
        `请归档 OpenSpec change \`${changeId}\`。`,
        "",
        "要求：",
        "- 使用项目里的 OpenSpec 流程处理这个 change 的归档。",
        "- 如果需要执行 CLI，使用 `openspec archive <change> -y`。",
        "- 只处理这个 change 相关的文件，不要引入无关改动。",
        "- 完成后简短汇报归档结果。"
      ].join("\n");
    }
    if (action === "sync") {
      return [
        `请同步 OpenSpec change \`${changeId}\` 的 task 勾选状态。`,
        "",
        "要求：",
        "- 先读取这个 change 的 proposal、tasks 和 specs delta，再对照当前代码实现。",
        "- 只把已经由代码、测试或文档实际完成的 unchecked task 标记为 checked。",
        "- 不要实现新的功能代码，不要 apply，也不要 archive。",
        "- 如果没有可同步的 task，简短说明原因。"
      ].join("\n");
    }
    if (action === "validate") {
      return [
        `请校验 OpenSpec change \`${changeId}\`。`,
        "",
        "要求：",
        "- 先读取这个 change 的 proposal、tasks 和 specs delta。",
        "- 使用项目里的 OpenSpec 流程执行校验；如果需要 CLI，使用 `openspec validate <change> --strict`。",
        "- 不要实现新功能代码，不要修改 task 勾选状态，不要 apply，也不要 archive。",
        "- 完成后简短汇报校验结果和需要处理的问题。"
      ].join("\n");
    }
    return [
      `请 apply OpenSpec change \`${changeId}\`。`,
      "",
      "要求：",
      "- 先读取这个 change 的 proposal、tasks 和 specs delta。",
      "- 实施当前适合上线的改动，并保持范围只限这个 change。",
      "- 不要自动 archive，除非我后续明确要求。",
      "- 完成后简短汇报改动和必要校验。"
    ].join("\n");
  };

  app.copyOpenSpecChangeId = async function copyOpenSpecChangeId(changeId, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const value = String(changeId || "").trim();
    if (!value) return;
    try {
      if (typeof app.copyTextToClipboard === "function") await app.copyTextToClipboard(value);
      else await app.navigator.clipboard.writeText(value);
      app.toast?.("已复制 change ID");
    } catch {
      app.toast?.("复制失败，请长按选择文本");
    }
  };

  app.renderOpenSpecTaskGroup = function renderOpenSpecTaskGroup(group) {
    const section = document.createElement("section");
    section.className = "open-spec-task-group";
    section.innerHTML = `<strong>${app.escapeHtml(group.title)}</strong>`;
    const list = document.createElement("div");
    list.className = "open-spec-task-list";
    for (const task of group.tasks) {
      const item = document.createElement("div");
      item.className = `open-spec-task${task.checked ? " is-complete" : ""}`;
      item.innerHTML = `
        <span class="open-spec-check" aria-hidden="true"></span>
        <span>${app.escapeHtml(task.text)}</span>
      `;
      list.append(item);
    }
    section.append(list);
    return section;
  };

  app.openSpecStatusClass = function openSpecStatusClass(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "in-progress" || normalized === "complete" || normalized === "planned" || normalized === "no-tasks" || normalized === "archived") return normalized;
    return "planned";
  };

  const previousRefreshCodex = app.refreshCodex;
  app.refreshCodex = async function refreshCodexWithOpenSpec(options = {}) {
    await previousRefreshCodex(options);
    if (!app.canUseWorkbench?.() || !app.currentProjectId()) {
      app.updateOpenSpecAvailability();
      return;
    }
    const shouldLoad = options.forceOpenSpec || !options.scheduled || state.openSpecProjectId !== app.openSpecProjectKey();
    if (shouldLoad) await app.loadOpenSpecSummary({ silent: true });
    else app.updateOpenSpecAvailability();
  };

  const previousUpdateAuthView = app.updateAuthView;
  app.updateAuthView = function updateAuthViewWithOpenSpec(message = "") {
    previousUpdateAuthView(message);
    app.updateOpenSpecAvailability();
  };

  const previousUpdateComposerAvailability = app.updateComposerAvailability;
  app.updateComposerAvailability = function updateComposerAvailabilityWithOpenSpec() {
    previousUpdateComposerAvailability();
    app.updateOpenSpecAvailability();
  };

  const previousHandleGlobalKeydown = app.handleGlobalKeydown;
  app.handleGlobalKeydown = function handleGlobalKeydownWithOpenSpec(event) {
    if (event.key === "Escape" && elements.openSpecRunPage?.hidden === false) {
      event.preventDefault();
      app.closeOrchestrationRunPage();
      return;
    }
    if (event.key === "Escape" && ["select", "confirm"].includes(state.openSpecMode)) {
      event.preventDefault();
      app.backOpenSpecPlanning();
      return;
    }
    if (event.key === "Escape" && elements.openSpecPanel && !elements.openSpecPanel.hidden) {
      event.preventDefault();
      app.closeOpenSpecPanel({ restoreFocus: true });
      return;
    }
    previousHandleGlobalKeydown?.(event);
  };

  const previousSelectProject = app.selectProject;
  app.selectProject = async function selectProjectWithOpenSpec(projectId) {
    const previousProjectId = app.openSpecProjectKey();
    await previousSelectProject(projectId);
    const nextProjectId = app.openSpecProjectKey();
    if (previousProjectId !== nextProjectId) {
      state.openSpecRequestSeq = Number(state.openSpecRequestSeq || 0) + 1;
      state.openSpecBusy = false;
      app.restoreCachedOpenSpecSummary(nextProjectId);
      app.updateOpenSpecAvailability();
      await app.loadOpenSpecSummary({ silent: true });
    }
  };

  elements.openSpecButton?.addEventListener("click", app.toggleOpenSpecPanel);
  elements.openSpecOrchestrationButton?.addEventListener("click", app.enterOpenSpecOrchestrationSelection);
  elements.openSpecExploreButton?.addEventListener("click", app.prefillOpenSpecExplorePrompt);
  elements.openSpecRefreshButton?.addEventListener("click", app.refreshOpenSpecSummary);
  elements.openSpecCloseButton?.addEventListener("click", () => app.closeOpenSpecPanel({ restoreFocus: true }));
  elements.openSpecBackButton?.addEventListener("click", app.backOpenSpecPlanning);
  elements.openSpecRunBackButton?.addEventListener("click", app.closeOrchestrationRunPage);
  elements.openSpecRunCloseButton?.addEventListener("click", () => app.closeOpenSpecPanel({ restoreFocus: true }));

  windowRef.addEventListener("resize", () => {
    if (!elements.openSpecPanel?.hidden) app.renderOpenSpecPanel();
    if (!elements.openSpecRunPage?.hidden) app.renderOpenSpecRunPage();
  });
}
