export function installMcp(app) {
  const { elements, localStorage, state } = app;

  app.updateMcpSnapshot = function updateMcpSnapshot(snapshot = {}) {
    const normalized = app.normalizeMcpSnapshot(snapshot);
    state.mcpSnapshot = normalized;
    state.mcpProfiles = normalized.profiles;
    state.mcpServers = normalized.servers;
    state.mcpClients = normalized.clients;
    if (!state.mcpSelectedProfileId) {
      state.mcpSelectedProfileId = state.runtimePreferences.mcpProfileId || normalized.activeProfileId || app.defaultMcpProfileId();
    }
    app.ensureMcpSelectedServer();
    if (!state.mcpTargetClients.length && normalized.targetClients.length) {
      state.mcpTargetClients = normalized.targetClients;
    }
    app.populateMcpProfileSelect();
    app.renderMcpPanel();
    app.refreshMcpPreferenceSummary();
    app.updateMcpUpdateIndicator();
    app.refreshRuntimeSelectControls?.();
  };

  app.normalizeMcpSnapshot = function normalizeMcpSnapshot(snapshot = {}) {
    const profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles.map(app.normalizeMcpProfile).filter(Boolean) : [];
    const servers = Array.isArray(snapshot.servers) ? snapshot.servers.map(app.normalizeMcpServer).filter(Boolean) : [];
    const clients = Array.isArray(snapshot.clients) ? snapshot.clients.map(app.normalizeMcpClient).filter(Boolean) : [];
    const activeProfileId = app.normalizeMcpProfileId(snapshot.activeProfileId);
    const defaultProfileId = app.normalizeMcpProfileId(snapshot.defaultProfileId);
    const targetClients = app.normalizeMcpTargetClients(snapshot.targetClients);
    return {
      enabled: snapshot.enabled !== false,
      defaultProfileId: profiles.some((profile) => profile.id === defaultProfileId)
        ? defaultProfileId
        : profiles.find((profile) => profile.id !== "off")?.id || profiles[0]?.id || "",
      activeProfileId: profiles.some((profile) => profile.id === activeProfileId) ? activeProfileId : "",
      targetClients: targetClients.length ? targetClients : ["codex"],
      profiles,
      servers,
      clients,
      lastAppliedAt: String(snapshot.lastAppliedAt || ""),
      snapshotHash: String(snapshot.snapshotHash || ""),
      appliedSnapshotHash: String(snapshot.appliedSnapshotHash || ""),
      hasUpdates: Boolean(snapshot.hasUpdates),
      checkedAt: String(snapshot.checkedAt || ""),
      toolProbeStatus: String(snapshot.toolProbeStatus || "").trim(),
      toolProbeError: String(snapshot.toolProbeError || "").trim(),
      lastApplyResult: snapshot.lastApplyResult || null
    };
  };

  app.normalizeMcpProfile = function normalizeMcpProfile(profile = {}) {
    const id = app.normalizeMcpProfileId(profile.id);
    if (!id) return null;
    return {
      id,
      label: String(profile.label || id).trim(),
      description: String(profile.description || "").trim(),
      serverIds: Array.isArray(profile.serverIds)
        ? profile.serverIds.map((item) => app.normalizeMcpProfileId(item)).filter(Boolean)
        : []
    };
  };

  app.normalizeMcpServer = function normalizeMcpServer(server = {}) {
    const id = app.normalizeMcpProfileId(server.id);
    if (!id) return null;
    return {
      id,
      label: String(server.label || id).trim(),
      description: String(server.description || "").trim(),
      icon: String(server.icon || server.iconName || "").trim(),
      source: String(server.source || "").trim(),
      status: String(server.status || "").trim(),
      snapshotHash: String(server.snapshotHash || ""),
      appliedSnapshotHash: String(server.appliedSnapshotHash || ""),
      hasUpdates: Boolean(server.hasUpdates),
      toolProbeStatus: String(server.toolProbeStatus || "").trim(),
      toolProbeError: String(server.toolProbeError || "").trim(),
      canManage: server.canManage !== false,
      installed: server.installed !== false
    };
  };

  app.normalizeMcpClient = function normalizeMcpClient(client = {}) {
    const id = String(client.id || "").trim();
    if (!id) return null;
    return {
      id,
      label: String(client.label || id).trim(),
      description: String(client.description || "").trim()
    };
  };

  app.populateMcpProfileSelect = function populateMcpProfileSelect() {
    const select = elements.codexMcpProfile;
    if (!select) return;
    const options = [{ value: "", label: app.defaultMcpProfileSelectLabel() }];
    for (const profile of state.mcpProfiles || []) {
      options.push({ value: profile.id, label: profile.label });
    }
    const previous = select.value;
    app.populateRuntimeSelect(select, options);
    select.value = app.selectHasEnabledOption(select, previous) ? previous : "";
    app.syncRuntimeSelectControl?.(select);
  };

  app.ensureMcpProfileOption = function ensureMcpProfileOption(profileId) {
    const id = app.normalizeMcpProfileId(profileId);
    if (!id || !elements.codexMcpProfile) return;
    if (app.selectHasEnabledOption(elements.codexMcpProfile, id)) return;
    const option = app.document.createElement("option");
    option.value = id;
    option.textContent = app.mcpProfileDisplayName(id);
    option.dataset.baseLabel = option.textContent;
    elements.codexMcpProfile.append(option);
  };

  app.defaultMcpProfileSelectLabel = function defaultMcpProfileSelectLabel() {
    const active = app.currentActiveMcpProfile();
    return active ? `桌面默认：${active.label}` : "桌面默认";
  };

  app.defaultMcpProfileId = function defaultMcpProfileId() {
    return (
      state.mcpSnapshot?.activeProfileId ||
      state.mcpSnapshot?.defaultProfileId ||
      state.mcpProfiles?.find((profile) => profile.id !== "off")?.id ||
      state.mcpProfiles?.[0]?.id ||
      ""
    );
  };

  app.currentActiveMcpProfile = function currentActiveMcpProfile() {
    return app.mcpProfileById(state.mcpSnapshot?.activeProfileId || "");
  };

  app.mcpProfileById = function mcpProfileById(profileId) {
    const id = app.normalizeMcpProfileId(profileId);
    return (state.mcpProfiles || []).find((profile) => profile.id === id) || null;
  };

  app.mcpProfileDisplayName = function mcpProfileDisplayName(profileId) {
    return app.mcpProfileById(profileId)?.label || app.normalizeMcpProfileId(profileId) || "默认";
  };

  app.mcpServerById = function mcpServerById(serverId) {
    const id = app.normalizeMcpProfileId(serverId);
    return (state.mcpServers || []).find((server) => server.id === id) || null;
  };

  app.mcpProfilesForServer = function mcpProfilesForServer(serverId) {
    const id = app.normalizeMcpProfileId(serverId);
    if (!id) return [];
    return (state.mcpProfiles || []).filter((profile) => profile.serverIds.includes(id));
  };

  app.mcpProfileForServer = function mcpProfileForServer(serverId) {
    const profiles = app.mcpProfilesForServer(serverId);
    return profiles.find((profile) => profile.serverIds.length === 1) || profiles[0] || null;
  };

  app.mcpProfileHasServer = function mcpProfileHasServer(profile, serverId) {
    const id = app.normalizeMcpProfileId(serverId);
    return Boolean(profile && id && Array.isArray(profile.serverIds) && profile.serverIds.includes(id));
  };

  app.defaultMcpSelectedServerId = function defaultMcpSelectedServerId() {
    const servers = state.mcpServers || [];
    const serverIds = new Set(servers.map((server) => server.id));
    const active = app.mcpProfileById(state.mcpSnapshot?.activeProfileId || "");
    const activeServerId = active?.serverIds.find((id) => serverIds.has(id));
    return activeServerId || servers[0]?.id || "";
  };

  app.ensureMcpSelectedServer = function ensureMcpSelectedServer() {
    if (state.mcpAddOpen) return;
    const ids = new Set((state.mcpServers || []).map((server) => server.id));
    if (ids.has(state.mcpSelectedServerId)) return;
    state.mcpSelectedServerId = app.defaultMcpSelectedServerId();
  };

  app.syncMcpSelectedServerFromProfile = function syncMcpSelectedServerFromProfile(profileId) {
    const profile = app.mcpProfileById(profileId);
    const ids = new Set((state.mcpServers || []).map((server) => server.id));
    const serverId = profile?.serverIds.find((id) => ids.has(id));
    if (serverId) state.mcpSelectedServerId = serverId;
    else app.ensureMcpSelectedServer();
  };

  app.mcpServerCards = function mcpServerCards() {
    const activeProfile = app.mcpProfileById(state.mcpSnapshot?.activeProfileId || "");
    const selectedProfile = app.mcpProfileById(state.mcpSelectedProfileId || "");
    const result = state.mcpSnapshot?.lastApplyResult || null;
    const resultProfile = result && !result.ok ? app.mcpProfileById(result.profileId) : null;
    return (state.mcpServers || []).map((server) => {
      const profile = app.mcpProfileForServer(server.id);
      const isActive = app.mcpProfileHasServer(activeProfile, server.id);
      const isSelected = app.mcpProfileHasServer(selectedProfile, server.id);
      const pendingDisconnect = selectedProfile?.id === "off" && isActive && state.mcpSelectedServerId === server.id;
      const failed = Boolean(result && !result.ok && (app.mcpProfileHasServer(resultProfile, server.id) || state.mcpSelectedServerId === server.id));
      const unavailable = !server.installed || server.status === "unavailable" || !profile;
      const hasUpdates = Boolean(server.hasUpdates && isActive);
      const stateName = failed
        ? "failed"
        : pendingDisconnect
          ? "disconnect"
          : hasUpdates
            ? "update"
            : isActive
              ? "active"
              : isSelected
                ? "selected"
                : unavailable
                  ? "unavailable"
                  : "available";
      const labels = {
        active: "已接入",
        update: "有更新",
        disconnect: "待停用",
        selected: "待启用",
        available: "可用",
        unavailable: "未配",
        failed: "失败"
      };
      return {
        server,
        profile,
        state: stateName,
        statusLabel: labels[stateName],
        isActive,
        isSelected,
        hasUpdates,
        unavailable
      };
    });
  };

  app.updateMcpUpdateIndicator = function updateMcpUpdateIndicator() {
    if (!elements.mcpButton) return;
    const hasUpdates = Boolean(state.mcpSnapshot?.hasUpdates);
    elements.mcpButton.classList.toggle("has-mcp-updates", hasUpdates);
    elements.mcpButton.setAttribute("aria-label", hasUpdates ? "配置 MCP，有更新" : "配置 MCP");
    elements.mcpButton.title = hasUpdates ? "MCP 有更新" : "配置 MCP";
  };

  app.mcpActionProfileId = function mcpActionProfileId() {
    if (state.mcpAddOpen) return "";
    if (state.mcpSelectedProfileId === "off") return "off";
    const serverId = state.mcpSelectedServerId;
    const serverProfile = app.mcpProfileForServer(serverId);
    if (!serverProfile) return "";
    const selectedProfile = app.mcpProfileById(state.mcpSelectedProfileId || "");
    if (app.mcpProfileHasServer(selectedProfile, serverId)) return selectedProfile.id;
    return serverProfile.id;
  };

  app.refreshMcpPreferenceSummary = function refreshMcpPreferenceSummary() {
    if (!elements.mcpPreferenceSubtitle) return;
    const activeProfileId = state.mcpSnapshot?.activeProfileId || "";
    const selectedProfileId = elements.codexMcpProfile
      ? app.normalizeMcpProfileId(elements.codexMcpProfile.value)
      : app.normalizeMcpProfileId(state.mcpSelectedProfileId || "");
    const active = app.mcpProfileById(activeProfileId);
    const selected = app.mcpProfileById(selectedProfileId);
    if (!state.mcpSnapshot || (state.mcpProfiles || []).length === 0) {
      elements.mcpPreferenceSubtitle.textContent = "等待桌面 agent 同步";
      return;
    }
    if (state.mcpSnapshot.hasUpdates) {
      elements.mcpPreferenceSubtitle.textContent = "有更新";
      return;
    }
    if (selected && active && selected.id !== active.id) {
      elements.mcpPreferenceSubtitle.textContent = "可接入";
      return;
    }
    if (selected) {
      elements.mcpPreferenceSubtitle.textContent = active && selected.id === active.id ? `当前：${selected.label}` : "可接入";
      return;
    }
    elements.mcpPreferenceSubtitle.textContent = active ? `桌面默认：${active.label}` : "可接入";
  };

  app.normalizeMcpProfileId = function normalizeMcpProfileId(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  };

  app.normalizeMcpTargetClients = function normalizeMcpTargetClients(value) {
    const allowed = new Set(["codex", "claude-code"]);
    const raw = Array.isArray(value) ? value : String(value || "").split(",");
    const targets = raw.map((item) => String(item || "").trim()).filter((item) => allowed.has(item));
    return Array.from(new Set(targets));
  };

  app.toggleMcpPanel = function toggleMcpPanel(event) {
    event?.stopPropagation();
    if (!elements.mcpPanel) return;
    if (elements.mcpPanel.hidden) {
      app.openMcpPanel();
      return;
    }
    app.closeMcpPanel({ restoreFocus: true });
  };

  app.openMcpPanel = function openMcpPanel() {
    if (!elements.mcpPanel) return;
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.closeQuickSkillsPanel?.();
    app.closeAgentSkillsPanel?.();
    app.closeProjectSwitcher?.();
    app.closeRuntimeSelectPopover?.();
    app.renderMcpPanel();
    elements.mcpPanel.hidden = false;
    elements.mcpPanel.closest?.(".session-sidebar")?.classList.add("mcp-page-open");
    elements.mcpButton?.setAttribute("aria-expanded", "true");
    elements.mcpButton?.setAttribute("aria-label", "返回 MCP 配置");
    app.window?.requestAnimationFrame?.(() => {
      elements.mcpCloseButton?.focus?.({ preventScroll: true });
    });
  };

  app.closeMcpPanel = function closeMcpPanel({ restoreFocus = false, returnToSettings = false } = {}) {
    if (!elements.mcpPanel || elements.mcpPanel.hidden) return;
    elements.mcpPanel.hidden = true;
    elements.mcpPanel.closest?.(".session-sidebar")?.classList.remove("mcp-page-open");
    elements.mcpButton?.setAttribute("aria-expanded", "false");
    elements.mcpButton?.setAttribute("aria-label", "配置 MCP");
    if (returnToSettings) {
      app.openMobileSettingsPage?.();
      return;
    }
    if (restoreFocus) elements.mcpButton?.focus({ preventScroll: true });
  };

  app.renderMcpPanel = function renderMcpPanel() {
    if (!elements.mcpProfileList) return;
    const activeProfileId = state.mcpSnapshot?.activeProfileId || "";
    app.ensureMcpSelectedServer();
    if (elements.mcpMeta) {
      const active = app.mcpProfileById(activeProfileId);
      const activeServers = active?.serverIds.map((id) => app.mcpServerDisplayName(id)).filter(Boolean).join(" · ");
      elements.mcpMeta.textContent = activeServers ? `桌面当前：${activeServers}` : state.mcpSnapshot ? "可接入" : "等待桌面 agent 同步";
    }
    app.renderMcpServerGrid();
    app.renderMcpDetailPanel();
    app.renderMcpTargets();
    app.refreshMcpStatusText();
    app.refreshMcpPreferenceSummary();
    app.updateMcpControls();
  };

  app.renderMcpServerGrid = function renderMcpServerGrid() {
    elements.mcpProfileList.innerHTML = "";
    elements.mcpProfileList.classList.add("mcp-server-grid");
    const cards = app.mcpServerCards();
    if (cards.length === 0) {
      elements.mcpProfileList.innerHTML = '<div class="mcp-empty mcp-grid-empty">桌面端还没有同步 MCP。</div>';
    }
    for (const card of cards) {
      const item = app.document.createElement("div");
      const selected = !state.mcpAddOpen && card.server.id === state.mcpSelectedServerId;
      item.className = "mcp-server-item";
      item.append(app.renderMcpServerCard(card));
      if (selected) {
        const targets = app.document.createElement("div");
        targets.className = "mcp-inline-targets";
        targets.innerHTML = '<div class="mcp-section-label">应用到</div>';
        item.append(elements.mcpDetailPanel);
        targets.append(elements.mcpTargetList);
        item.append(targets);
      }
      elements.mcpProfileList.append(item);
    }
    const addItem = app.document.createElement("div");
    addItem.className = "mcp-server-item mcp-add-item";
    addItem.append(app.renderMcpAddCard());
    if (state.mcpAddOpen) addItem.append(elements.mcpDetailPanel);
    elements.mcpProfileList.append(addItem);
  };

  app.renderMcpServerCard = function renderMcpServerCard(card) {
    const { server } = card;
    const button = app.document.createElement("button");
    button.className = `mcp-server-card is-${card.state}`;
    button.type = "button";
    button.dataset.serverId = server.id;
    const selected = !state.mcpAddOpen && server.id === state.mcpSelectedServerId;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-expanded", selected ? "true" : "false");
    button.setAttribute("aria-label", `${server.label}，${card.statusLabel}`);
    button.title = `${server.label} · ${card.statusLabel}`;
    button.innerHTML = `
      <span class="mcp-card-status" aria-hidden="true"></span>
      <span class="mcp-card-icon" aria-hidden="true">${app.mcpServerIconMarkup(server)}</span>
      <span class="mcp-card-label">${app.escapeHtml(server.label)}</span>
      <span class="mcp-card-state">${app.escapeHtml(card.statusLabel)}</span>
      <span class="mcp-card-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" /></svg>
      </span>
    `;
    button.addEventListener("click", () => app.selectMcpServer(server.id));
    return button;
  };

  app.renderMcpAddCard = function renderMcpAddCard() {
    const button = app.document.createElement("button");
    button.className = "mcp-server-card mcp-add-card";
    button.type = "button";
    button.classList.toggle("is-selected", Boolean(state.mcpAddOpen));
    button.setAttribute("aria-expanded", state.mcpAddOpen ? "true" : "false");
    button.setAttribute("aria-label", "添加 MCP");
    button.title = "添加 MCP";
    button.innerHTML = `
      <span class="mcp-card-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" />
        </svg>
      </span>
      <span class="mcp-card-label">添加</span>
      <span class="mcp-card-state">本机模板</span>
      <span class="mcp-card-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" /></svg>
      </span>
    `;
    button.addEventListener("click", app.openMcpAddPanel);
    return button;
  };

  app.mcpServerIconMarkup = function mcpServerIconMarkup(server = {}) {
    const icon = String(server.icon || server.id || "").trim().toLowerCase();
    if (icon === "memory" || icon === "memory" || icon === "database") {
      return `
        <svg viewBox="0 0 24 24">
          <path d="M5 7.5c0-2 14-2 14 0s-14 2-14 0Z" fill="none" stroke="currentColor" stroke-width="1.7" />
          <path d="M5 7.5v8.8c0 2 14 2 14 0V7.5M5 12c0 2 14 2 14 0" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.7" />
        </svg>
      `;
    }
    return `<span class="mcp-card-monogram">${app.escapeHtml(app.mcpServerInitial(server.label || server.id))}</span>`;
  };

  app.mcpServerInitial = function mcpServerInitial(label) {
    const chars = Array.from(String(label || "").trim());
    const match = chars.find((char) => /[\p{L}\p{N}]/u.test(char));
    return (match || "M").toUpperCase();
  };

  app.mcpServerDisplayName = function mcpServerDisplayName(serverId) {
    const id = app.normalizeMcpProfileId(serverId);
    return (state.mcpServers || []).find((server) => server.id === id)?.label || id;
  };

  app.mcpClientDisplayName = function mcpClientDisplayName(clientId) {
    const id = String(clientId || "").trim();
    return (state.mcpClients || []).find((client) => client.id === id)?.label || id;
  };

  app.selectMcpServer = function selectMcpServer(serverId) {
    const id = app.normalizeMcpProfileId(serverId);
    const server = app.mcpServerById(id);
    if (!server) return;
    const wasSelected = !state.mcpAddOpen && id === state.mcpSelectedServerId;
    const activeProfile = app.mcpProfileById(state.mcpSnapshot?.activeProfileId || "");
    const isActive = app.mcpProfileHasServer(activeProfile, id);
    const isPendingDisconnect = wasSelected && state.mcpSelectedProfileId === "off";
    const profile = app.mcpProfileForServer(id);
    state.mcpAddOpen = false;
    state.mcpSelectedServerId = id;
    if (wasSelected && isActive && !isPendingDisconnect) {
      app.disconnectSelectedMcpServer();
      return;
    }
    if (profile) {
      app.selectMcpProfile(profile.id, { preserveServer: true });
      return;
    }
    state.mcpSelectedProfileId = "";
    app.refreshMcpPreferenceSummary();
    app.renderMcpPanel();
  };

  app.openMcpAddPanel = function openMcpAddPanel() {
    state.mcpAddOpen = true;
    app.renderMcpPanel();
  };

  app.selectMcpProfile = function selectMcpProfile(profileId, options = {}) {
    state.mcpSelectedProfileId = app.normalizeMcpProfileId(profileId);
    if (elements.codexMcpProfile && app.selectHasEnabledOption(elements.codexMcpProfile, state.mcpSelectedProfileId)) {
      elements.codexMcpProfile.value = state.mcpSelectedProfileId;
      app.handleRuntimeControlChange?.();
    }
    if (!options.preserveServer) app.syncMcpSelectedServerFromProfile(state.mcpSelectedProfileId);
    app.refreshMcpPreferenceSummary();
    app.renderMcpPanel();
  };

  app.handleMcpProfileControlChange = function handleMcpProfileControlChange() {
    app.selectMcpProfile(elements.codexMcpProfile?.value || "");
  };

  app.disconnectSelectedMcpServer = function disconnectSelectedMcpServer() {
    const offProfile = app.mcpProfileById("off") || (state.mcpProfiles || []).find((profile) => profile.serverIds.length === 0);
    if (!offProfile) {
      app.toast("桌面端没有可用的关闭 MCP 配置");
      return;
    }
    state.mcpAddOpen = false;
    app.selectMcpProfile(offProfile.id, { preserveServer: true });
  };

  app.renderMcpDetailPanel = function renderMcpDetailPanel() {
    if (!elements.mcpDetailPanel) return;
    elements.mcpDetailPanel.classList.toggle("is-add-open", Boolean(state.mcpAddOpen));
    elements.mcpDetailPanel.classList.toggle("is-pending-disconnect", false);
    if (state.mcpAddOpen) {
      elements.mcpDetailPanel.innerHTML = `
        <div class="mcp-detail-head">
          <span class="mcp-detail-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2" />
            </svg>
          </span>
          <div>
            <strong>添加 MCP</strong>
            <span>等待桌面端公布受控模板</span>
          </div>
          <span class="mcp-detail-badge">模板</span>
        </div>
        <button class="secondary compact-action mcp-detail-return" type="button" data-mcp-action="close-add">返回列表</button>
      `;
      elements.mcpDetailPanel.querySelector('[data-mcp-action="close-add"]')?.addEventListener("click", () => {
        state.mcpAddOpen = false;
        app.ensureMcpSelectedServer();
        app.renderMcpPanel();
      });
      return;
    }

    const cards = app.mcpServerCards();
    const card = cards.find((item) => item.server.id === state.mcpSelectedServerId) || cards[0];
    if (!card) {
      elements.mcpDetailPanel.innerHTML = `
        <div class="mcp-empty">桌面端还没有公布可管理的 MCP。</div>
      `;
      return;
    }
    const { server, profile } = card;
    const profileLabel = profile?.label || "未配置";
    const targetText = (state.mcpTargetClients || []).map((id) => app.mcpClientDisplayName(id)).filter(Boolean).join(" · ") || "未选择";
    elements.mcpDetailPanel.classList.toggle("is-pending-disconnect", card.state === "disconnect");
    elements.mcpDetailPanel.innerHTML = `
      <div class="mcp-detail-head">
        <span class="mcp-detail-icon is-${app.escapeHtml(card.state)}" aria-hidden="true">${app.mcpServerIconMarkup(server)}</span>
        <div>
          <strong>${app.escapeHtml(server.label)}</strong>
          <span>${app.escapeHtml(server.description || profile?.description || "本机 MCP")}</span>
        </div>
        <span class="mcp-detail-badge is-${app.escapeHtml(card.state)}">${app.escapeHtml(card.statusLabel)}</span>
      </div>
      <div class="mcp-detail-meta">
        <span>
          <strong>配置</strong>
          <em>${app.escapeHtml(profileLabel)}</em>
        </span>
        <span>
          <strong>后端</strong>
          <em>${app.escapeHtml(targetText)}</em>
        </span>
      </div>
    `;
  };

  app.renderMcpTargets = function renderMcpTargets() {
    if (!elements.mcpTargetList) return;
    elements.mcpTargetList.innerHTML = "";
    const clients = state.mcpClients?.length ? state.mcpClients : [{ id: "codex", label: "Codex" }];
    for (const client of clients) {
      const label = app.document.createElement("label");
      const checked = state.mcpTargetClients.includes(client.id);
      label.className = `mcp-target-item${checked ? " is-selected" : ""}`;
      label.innerHTML = `
        <input type="checkbox" value="${app.escapeHtml(client.id)}" />
        <span>
          <strong>${app.escapeHtml(client.label)}</strong>
          <small>${app.escapeHtml(client.description || "")}</small>
        </span>
      `;
      const checkbox = label.querySelector("input");
      checkbox.checked = checked;
      checkbox.addEventListener("change", app.updateMcpTargetSelection);
      elements.mcpTargetList.append(label);
    }
  };

  app.updateMcpTargetSelection = function updateMcpTargetSelection() {
    const selected = Array.from(elements.mcpTargetList?.querySelectorAll("input:checked") || []).map((input) => input.value);
    state.mcpTargetClients = app.normalizeMcpTargetClients(selected);
    localStorage.setItem("echoMcpTargetClients", state.mcpTargetClients.join(","));
    app.renderMcpTargets();
    app.renderMcpDetailPanel();
    app.refreshMcpStatusText();
    app.updateMcpControls();
  };

  app.applySelectedMcpProfile = async function applySelectedMcpProfile() {
    if (state.mcpBusy) return;
    if (!app.ensurePaired()) return;
    if (state.mcpAddOpen) {
      app.toast("桌面端开放添加能力后才能保存");
      return;
    }
    const profileId = app.mcpActionProfileId();
    const targetClients = state.mcpTargetClients.length ? state.mcpTargetClients : ["codex"];
    if (!app.mcpProfileById(profileId)) {
      app.toast("这个 MCP 还没有可应用的 profile");
      return;
    }
    if (targetClients.length === 0) {
      app.toast("至少选择一个后端");
      return;
    }
    const actionLabel = profileId === "off" ? "断开 MCP" : `接入 ${app.mcpProfileDisplayName(profileId)}`;
    const confirmed = await app.confirm({
      title: actionLabel,
      body: "这个操作会重启桌面 agent，正在运行的任务可能中断。",
      confirmLabel: "继续",
      cancelLabel: "取消",
      tone: "danger"
    });
    if (!confirmed) return;
    state.mcpBusy = true;
    state.mcpApplyCommandId = "";
    app.updateMcpControls();
    if (elements.mcpStatus) elements.mcpStatus.textContent = "正在下发到桌面 agent";
    try {
      const body = {
        profileId,
        targetClients,
        targetAgentId: app.currentTargetAgentId(),
        restartDesktopAgent: true
      };
      const data = await app.apiPost("/api/codex/mcp/apply", body);
      state.mcpApplyCommandId = data.command?.id || "";
      const command = await app.waitForMcpApplyCommand(state.mcpApplyCommandId);
      state.runtimePreferences = {
        ...state.runtimePreferences,
        mcpProfileId: profileId
      };
      app.writeStoredRuntimePreferences(state.runtimePreferences);
      await app.queueWorkspaceRuntimePreferenceSave?.(state.runtimePreferences);
      await app.refreshCodex({ forceMcp: true });
      if (command.result?.restartDesktopAgent && elements.mcpStatus) {
        elements.mcpStatus.textContent = "已应用，桌面 agent 正在重启";
      }
      app.refreshMcpPreferenceSummary();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
        if (elements.mcpStatus) elements.mcpStatus.textContent = error.message;
      }
    } finally {
      state.mcpBusy = false;
      state.mcpApplyCommandId = "";
      app.updateMcpControls();
    }
  };

  app.waitForMcpApplyCommand = async function waitForMcpApplyCommand(commandId) {
    if (!commandId) throw new Error("MCP apply command was not queued.");
    const started = Date.now();
    while (Date.now() - started < 45000) {
      const data = await app.apiGet(`/api/codex/mcp/commands/${encodeURIComponent(commandId)}`);
      const command = data.command || {};
      if (command.status === "done") {
        if (elements.mcpStatus) {
          elements.mcpStatus.textContent = command.result?.restartDesktopAgent ? "已应用，桌面 agent 正在重启" : "已应用到桌面后端";
        }
        return command;
      }
      if (command.status === "failed") {
        const resultError = command.result?.error || command.error || "MCP 应用失败";
        throw new Error(resultError);
      }
      if (elements.mcpStatus) elements.mcpStatus.textContent = "桌面 agent 正在应用 MCP 配置";
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw new Error("等待桌面 agent 应用 MCP 超时");
  };

  app.refreshMcpStatusText = function refreshMcpStatusText() {
    if (!elements.mcpStatus) return;
    if (state.mcpAddOpen) {
      elements.mcpStatus.textContent = "新增入口等待桌面端模板。";
      return;
    }
    const activeProfileId = state.mcpSnapshot?.activeProfileId || "";
    const selectedProfileId = app.mcpActionProfileId();
    const selectedServer = app.mcpServerById(state.mcpSelectedServerId);
    const result = state.mcpSnapshot?.lastApplyResult;
    if ((state.mcpServers || []).length === 0) {
      elements.mcpStatus.textContent = state.codexAgentAvailable ? "本机还没有公布 MCP。" : "等待桌面 agent 在线。";
      return;
    }
    if (selectedServer && !selectedProfileId) {
      elements.mcpStatus.textContent = `${selectedServer.label} 未配置 profile。`;
      return;
    }
    if (!result) {
      elements.mcpStatus.textContent = selectedServer ? "可启用" : "选择 MCP";
      return;
    }
    if (!result.ok) {
      elements.mcpStatus.textContent = result.error || "上次应用失败";
      return;
    }
    if (state.mcpSnapshot?.hasUpdates) {
      elements.mcpStatus.textContent = "有更新，重新应用后生效。";
      return;
    }
    if (selectedProfileId && selectedProfileId !== activeProfileId) {
      elements.mcpStatus.textContent = selectedProfileId === "off" ? `待停用：${selectedServer?.label || "MCP"}` : "待启用";
      return;
    }
    if (selectedServer && app.mcpProfileHasServer(app.mcpProfileById(activeProfileId), selectedServer.id)) {
      elements.mcpStatus.textContent = `已启用：${selectedServer.label}`;
      return;
    }
    elements.mcpStatus.textContent = `上次：${app.mcpProfileDisplayName(result.profileId)} · ${app.formatRelativeTime?.(result.appliedAt) || ""}`;
  };

  app.updateMcpControls = function updateMcpControls() {
    const disabled = state.mcpBusy || !state.codexAgentAvailable;
    const selectedProfileId = app.mcpActionProfileId();
    if (elements.mcpApplyButton) {
      if (state.mcpBusy) elements.mcpApplyButton.textContent = "应用中";
      else if (state.mcpAddOpen) elements.mcpApplyButton.textContent = "待支持";
      else if (!selectedProfileId) elements.mcpApplyButton.textContent = "等待";
      else if (selectedProfileId === "off") elements.mcpApplyButton.textContent = "停用";
      else if (selectedProfileId && selectedProfileId === state.mcpSnapshot?.activeProfileId) elements.mcpApplyButton.textContent = "更新";
      else elements.mcpApplyButton.textContent = "启用";
      elements.mcpApplyButton.disabled = disabled || state.mcpAddOpen || !selectedProfileId || state.mcpTargetClients.length === 0;
    }
    if (elements.mcpRefreshButton) elements.mcpRefreshButton.disabled = state.mcpBusy;
    for (const control of elements.mcpPanel?.querySelectorAll("button,input") || []) {
      if (
        control === elements.mcpRefreshButton ||
        control === elements.mcpApplyButton ||
        control === elements.mcpCloseButton
      ) {
        continue;
      }
      control.disabled = state.mcpBusy;
    }
  };

  const previousHandleGlobalKeydown = app.handleGlobalKeydown;
  app.handleGlobalKeydown = function handleGlobalKeydownWithMcp(event) {
    if (event.key === "Escape" && elements.mcpPanel && !elements.mcpPanel.hidden) {
      event.preventDefault();
      app.closeMcpPanel({ restoreFocus: true });
      return;
    }
    previousHandleGlobalKeydown?.(event);
  };
}
