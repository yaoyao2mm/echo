export function installDesktopPlugins(app) {
  const { document, elements, state } = app;

  app.updateDesktopPluginSnapshot = function updateDesktopPluginSnapshot(snapshot = {}) {
    const plugins = Array.isArray(snapshot.plugins)
      ? snapshot.plugins.map(app.normalizeDesktopPlugin).filter(Boolean)
      : [];
    state.desktopPluginSnapshot = {
      canManage: Boolean(snapshot.capability?.canManage),
      commandTypes: Array.isArray(snapshot.capability?.commandTypes) ? snapshot.capability.commandTypes : [],
      plugins,
      summary: {
        total: plugins.length,
        enabled: plugins.filter((plugin) => plugin.enabled).length,
        disabled: plugins.filter((plugin) => !plugin.enabled).length
      }
    };
    app.refreshDesktopPluginPreferenceSummary();
    app.renderDesktopPluginPanel();
    app.updateOpenSpecAvailability?.();
    if (!app.isDesktopPluginEnabled("open-spec")) {
      app.closeOpenSpecPanel?.({ restoreFocus: false });
      state.openSpecSummary = null;
      state.openSpecProjectId = "";
    }
    if (!app.isDesktopPluginEnabled("orchestration")) {
      app.stopOrchestrationEvents?.();
      state.openSpecMode = "browse";
      state.orchestrationRun = null;
      state.orchestrationSelectedIds = new Set();
      state.orchestrationOrder = [];
    }
  };

  app.normalizeDesktopPlugin = function normalizeDesktopPlugin(plugin = {}) {
    const id = String(plugin.id || "").trim();
    if (!id) return null;
    return {
      id,
      name: String(plugin.name || id).trim(),
      description: String(plugin.description || "").trim(),
      version: String(plugin.version || "").trim(),
      source: plugin.source && typeof plugin.source === "object" ? plugin.source : {},
      capabilities: Array.isArray(plugin.capabilities)
        ? plugin.capabilities.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      requires: Array.isArray(plugin.requires)
        ? plugin.requires.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
      prerequisites: plugin.prerequisites && typeof plugin.prerequisites === "object" ? plugin.prerequisites : {},
      enabled: plugin.enabled === true
    };
  };

  app.isDesktopPluginEnabled = function isDesktopPluginEnabled(pluginId) {
    const id = String(pluginId || "").trim();
    return Boolean(state.desktopPluginSnapshot?.plugins?.some((plugin) => plugin.id === id && plugin.enabled));
  };

  app.refreshDesktopPluginPreferenceSummary = function refreshDesktopPluginPreferenceSummary() {
    const snapshot = state.desktopPluginSnapshot;
    if (elements.desktopPluginManager) elements.desktopPluginManager.hidden = !snapshot?.canManage;
    if (!elements.desktopPluginPreferenceSubtitle) return;
    elements.desktopPluginPreferenceSubtitle.textContent = snapshot?.canManage
      ? `${snapshot.summary.enabled} 个启用 · ${snapshot.summary.total} 个可用`
      : "等待桌面 agent 同步";
  };

  app.toggleDesktopPluginPanel = function toggleDesktopPluginPanel(event) {
    event?.stopPropagation();
    if (!elements.desktopPluginPanel) return;
    if (elements.desktopPluginPanel.hidden) app.openDesktopPluginPanel();
    else app.closeDesktopPluginPanel({ restoreFocus: true });
  };

  app.openDesktopPluginPanel = function openDesktopPluginPanel() {
    if (!elements.desktopPluginPanel || !state.desktopPluginSnapshot?.canManage) return;
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeAgentSkillPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.renderDesktopPluginPanel();
    elements.desktopPluginPanel.hidden = false;
    elements.desktopPluginPanel.closest?.(".session-sidebar")?.classList.add("mcp-page-open");
    elements.desktopPluginButton?.setAttribute("aria-expanded", "true");
    app.window?.requestAnimationFrame?.(() => elements.desktopPluginCloseButton?.focus?.({ preventScroll: true }));
  };

  app.closeDesktopPluginPanel = function closeDesktopPluginPanel({ restoreFocus = false, returnToSettings = false } = {}) {
    if (!elements.desktopPluginPanel || elements.desktopPluginPanel.hidden) return;
    elements.desktopPluginPanel.hidden = true;
    elements.desktopPluginPanel.closest?.(".session-sidebar")?.classList.remove("mcp-page-open");
    elements.desktopPluginButton?.setAttribute("aria-expanded", "false");
    if (returnToSettings) {
      app.openMobileSettingsPage?.();
      return;
    }
    if (restoreFocus) elements.desktopPluginButton?.focus?.({ preventScroll: true });
  };

  app.renderDesktopPluginPanel = function renderDesktopPluginPanel() {
    const snapshot = state.desktopPluginSnapshot;
    if (elements.desktopPluginMeta) {
      elements.desktopPluginMeta.textContent = snapshot?.canManage
        ? `${snapshot.summary.enabled}/${snapshot.summary.total} 启用`
        : "等待桌面 agent 同步";
    }
    if (elements.desktopPluginOverview) {
      const summary = snapshot?.summary || { total: 0, enabled: 0, disabled: 0 };
      elements.desktopPluginOverview.innerHTML = [["可用", summary.total], ["启用", summary.enabled], ["停用", summary.disabled]]
        .map(([label, value]) => `<span class="agent-skill-stat"><strong>${app.escapeHtml(String(value))}</strong><em>${app.escapeHtml(label)}</em></span>`)
        .join("");
    }
    app.renderDesktopPluginList();
    if (elements.desktopPluginRefreshButton) elements.desktopPluginRefreshButton.disabled = state.desktopPluginBusy;
    if (elements.desktopPluginStatus) {
      elements.desktopPluginStatus.textContent = state.desktopPluginBusy
        ? "桌面 agent 正在更新插件"
        : "插件由桌面端提供；手机只能启停已广告的能力。";
    }
  };

  app.renderDesktopPluginList = function renderDesktopPluginList() {
    if (!elements.desktopPluginList) return;
    const snapshot = state.desktopPluginSnapshot;
    elements.desktopPluginList.innerHTML = "";
    if (!snapshot?.canManage) {
      elements.desktopPluginList.innerHTML = '<div class="mcp-empty mcp-grid-empty">等待桌面 agent 同步。</div>';
      return;
    }
    if (!snapshot.plugins.length) {
      elements.desktopPluginList.innerHTML = '<div class="mcp-empty mcp-grid-empty">桌面端没有广告插件。</div>';
      return;
    }
    for (const plugin of snapshot.plugins) {
      const row = document.createElement("div");
      row.className = `desktop-plugin-row${plugin.enabled ? " is-enabled" : ""}`;
      const unavailableReason = plugin.id === "orchestration" && plugin.prerequisites?.managedWorktree !== true
        ? "先在桌面端开启受管 Worktree"
        : "";
      row.innerHTML = `
        <span class="desktop-plugin-icon" aria-hidden="true">${app.escapeHtml((plugin.name[0] || "P").toUpperCase())}</span>
        <span class="desktop-plugin-copy">
          <strong>${app.escapeHtml(plugin.name)}</strong>
          <small>${app.escapeHtml(unavailableReason || plugin.description || "桌面插件")}</small>
          <em>${app.escapeHtml(plugin.source?.label || "桌面端")}${plugin.version ? ` · ${app.escapeHtml(plugin.version)}` : ""}</em>
        </span>
        <label class="desktop-plugin-switch" title="${plugin.enabled ? "停用" : "启用"} ${app.escapeHtml(plugin.name)}">
          <input type="checkbox" role="switch" aria-label="启用 ${app.escapeHtml(plugin.name)}" data-plugin-id="${app.escapeHtml(plugin.id)}" ${plugin.enabled ? "checked" : ""} ${unavailableReason ? "disabled" : ""} />
          <span aria-hidden="true"></span>
        </label>`;
      const input = row.querySelector("input");
      input.disabled = state.desktopPluginBusy || Boolean(unavailableReason);
      input.addEventListener("change", () => app.updateDesktopPlugin(plugin.id, input.checked));
      elements.desktopPluginList.append(row);
    }
  };

  app.refreshDesktopPluginRegistry = async function refreshDesktopPluginRegistry() {
    await app.runDesktopPluginCommand("/api/codex/plugins/refresh", {});
  };

  app.updateDesktopPlugin = async function updateDesktopPlugin(pluginId, enabled) {
    await app.runDesktopPluginCommand("/api/codex/plugins/update", { pluginId, enabled });
  };

  app.runDesktopPluginCommand = async function runDesktopPluginCommand(endpoint, body) {
    if (state.desktopPluginBusy || !app.ensurePaired()) return;
    state.desktopPluginBusy = true;
    app.renderDesktopPluginPanel();
    try {
      const data = await app.apiPost(endpoint, { targetAgentId: app.currentTargetAgentId(), ...body });
      await app.waitForDesktopPluginCommand(data.command?.id || "");
      await app.refreshCodex({ forcePlugins: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
      if (elements.desktopPluginStatus) elements.desktopPluginStatus.textContent = error.message;
    } finally {
      state.desktopPluginBusy = false;
      app.renderDesktopPluginPanel();
    }
  };

  app.waitForDesktopPluginCommand = async function waitForDesktopPluginCommand(commandId) {
    if (!commandId) throw new Error("Desktop plugin command was not queued.");
    const started = Date.now();
    while (Date.now() - started < 45000) {
      const data = await app.apiGet(`/api/codex/plugins/commands/${encodeURIComponent(commandId)}`);
      const command = data.command || {};
      if (command.status === "done") return command;
      if (command.status === "failed") throw new Error(command.result?.error || command.error || "Desktop plugin command failed.");
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw new Error("等待桌面 agent 更新插件超时");
  };

  const previousHandleGlobalKeydown = app.handleGlobalKeydown;
  app.handleGlobalKeydown = function handleGlobalKeydownWithDesktopPlugins(event) {
    if (event.key === "Escape" && elements.desktopPluginPanel && !elements.desktopPluginPanel.hidden) {
      event.preventDefault();
      app.closeDesktopPluginPanel({ restoreFocus: true });
      return;
    }
    previousHandleGlobalKeydown?.(event);
  };
}
