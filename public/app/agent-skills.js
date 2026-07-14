export function installAgentSkills(app) {
  const { document, elements, state } = app;

  app.updateAgentSkillSnapshot = function updateAgentSkillSnapshot(snapshot = {}, runtime = {}) {
    const normalized = app.normalizeAgentSkillSnapshot(snapshot, runtime);
    state.agentSkillSnapshot = normalized;
    app.ensureAgentSkillSelection();
    app.refreshAgentSkillPreferenceSummary();
    app.renderAgentSkillManagement();
  };

  app.normalizeAgentSkillSnapshot = function normalizeAgentSkillSnapshot(snapshot = {}, runtime = {}) {
    const rawSkills = Array.isArray(snapshot.skills)
      ? snapshot.skills
      : Array.isArray(snapshot.installedSkills)
        ? snapshot.installedSkills
        : Array.isArray(runtime.installedSkills)
          ? runtime.installedSkills
          : [];
    const skills = rawSkills.map(app.normalizeManagedAgentSkill).filter(Boolean);
    const providers = Array.isArray(snapshot.capability?.providers)
      ? snapshot.capability.providers.map(app.normalizeAgentSkillProvider).filter(Boolean)
      : app.agentSkillProvidersFromSkills(skills);
    const summary = snapshot.summary && typeof snapshot.summary === "object"
      ? snapshot.summary
      : app.summarizeAgentSkills(skills);
    return {
      canManage: Boolean(snapshot.capability?.canManage),
      providers,
      skills,
      summary: {
        total: Number(summary.total ?? skills.length) || 0,
        enabled: Number(summary.enabled ?? skills.filter((skill) => skill.enabled).length) || 0,
        showInComposer: Number(summary.showInComposer ?? skills.filter((skill) => skill.enabled && skill.showInComposer).length) || 0,
        failed: Number(summary.failed ?? skills.filter((skill) => skill.syncState === "failed").length) || 0
      }
    };
  };

  app.normalizeManagedAgentSkill = function normalizeManagedAgentSkill(skill = {}) {
    const name = String(skill.name || "").trim();
    if (!name) return null;
    const id = String(skill.id || `name:${name}`).trim();
    const providers = Array.isArray(skill.providers)
      ? skill.providers.map(app.normalizeAgentSkillProvider).filter(Boolean)
      : [];
    const enabled = skill.enabled !== false;
    const showInComposer = skill.showInComposer !== false;
    const targetProviders = Array.isArray(skill.targetProviders)
      ? skill.targetProviders.map((item) => String(item || "").trim()).filter(Boolean)
      : providers.filter((provider) => provider.enabled || provider.installed).map((provider) => provider.provider);
    return {
      id,
      name,
      description: String(skill.description || "").trim(),
      folder: String(skill.folder || "").trim(),
      source: skill.source && typeof skill.source === "object" ? skill.source : {},
      providers,
      enabled,
      showInComposer,
      targetProviders: Array.from(new Set(targetProviders)),
      syncState: String(skill.syncState || app.aggregateAgentSkillSyncState(providers, enabled)).trim() || "ready"
    };
  };

  app.normalizeAgentSkillProvider = function normalizeAgentSkillProvider(provider = {}) {
    const id = String(provider.provider || provider.id || "").trim();
    if (!id) return null;
    return {
      provider: id,
      label: String(provider.label || id).trim(),
      installed: provider.installed !== false,
      enabled: provider.enabled === true,
      syncState: String(provider.syncState || "").trim() || (provider.enabled ? "ready" : "disabled"),
      error: String(provider.error || "").trim().slice(0, 240)
    };
  };

  app.agentSkillProvidersFromSkills = function agentSkillProvidersFromSkills(skills = []) {
    const byProvider = new Map();
    for (const skill of skills) {
      for (const provider of skill.providers || []) {
        if (!provider.provider) continue;
        byProvider.set(provider.provider, {
          provider: provider.provider,
          label: provider.label || provider.provider
        });
      }
    }
    return Array.from(byProvider.values());
  };

  app.aggregateAgentSkillSyncState = function aggregateAgentSkillSyncState(providers = [], enabled = true) {
    if (!enabled) return "disabled";
    const active = providers.filter((provider) => provider.enabled);
    if (active.length === 0) return "pending";
    if (active.some((provider) => provider.syncState === "failed")) return "failed";
    if (active.some((provider) => provider.syncState === "pending")) return "pending";
    return "ready";
  };

  app.summarizeAgentSkills = function summarizeAgentSkills(skills = []) {
    return {
      total: skills.length,
      enabled: skills.filter((skill) => skill.enabled).length,
      showInComposer: skills.filter((skill) => skill.enabled && skill.showInComposer).length,
      failed: skills.filter((skill) => skill.syncState === "failed").length
    };
  };

  app.ensureAgentSkillSelection = function ensureAgentSkillSelection() {
    const skills = state.agentSkillSnapshot?.skills || [];
    if (skills.some((skill) => skill.id === state.agentSkillSelectedId)) return;
    state.agentSkillSelectedId = "";
  };

  app.selectedManagedAgentSkill = function selectedManagedAgentSkill() {
    return (state.agentSkillSnapshot?.skills || []).find((skill) => skill.id === state.agentSkillSelectedId) || null;
  };

  app.refreshAgentSkillPreferenceSummary = function refreshAgentSkillPreferenceSummary() {
    if (!elements.agentSkillPreferenceSubtitle) return;
    const snapshot = state.agentSkillSnapshot;
    if (!snapshot || !snapshot.canManage) {
      elements.agentSkillPreferenceSubtitle.textContent = "等待桌面 agent 同步";
      return;
    }
    elements.agentSkillPreferenceSubtitle.textContent =
      `${snapshot.summary.enabled} 个启用 · ${snapshot.summary.showInComposer} 个在快捷菜单`;
  };

  app.toggleAgentSkillPanel = function toggleAgentSkillPanel(event) {
    event?.stopPropagation();
    if (!elements.agentSkillPanel) return;
    if (elements.agentSkillPanel.hidden) {
      app.openAgentSkillPanel();
      return;
    }
    app.closeAgentSkillPanel({ restoreFocus: true });
  };

  app.openAgentSkillPanel = function openAgentSkillPanel() {
    if (!elements.agentSkillPanel) return;
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.closeQuickSkillsPanel?.();
    app.closeAgentSkillsPanel?.();
    app.closeProjectSwitcher?.();
    app.renderAgentSkillManagement();
    elements.agentSkillPanel.hidden = false;
    elements.agentSkillPanel.closest?.(".session-sidebar")?.classList.add("mcp-page-open");
    elements.agentSkillButton?.setAttribute("aria-expanded", "true");
    app.window?.requestAnimationFrame?.(() => {
      elements.agentSkillCloseButton?.focus?.({ preventScroll: true });
    });
  };

  app.closeAgentSkillPanel = function closeAgentSkillPanel({ restoreFocus = false, returnToSettings = false } = {}) {
    if (!elements.agentSkillPanel || elements.agentSkillPanel.hidden) return;
    elements.agentSkillPanel.hidden = true;
    elements.agentSkillPanel.closest?.(".session-sidebar")?.classList.remove("mcp-page-open");
    elements.agentSkillButton?.setAttribute("aria-expanded", "false");
    if (returnToSettings) {
      app.openMobileSettingsPage?.();
      return;
    }
    if (restoreFocus) elements.agentSkillButton?.focus({ preventScroll: true });
  };

  app.renderAgentSkillManagement = function renderAgentSkillManagement() {
    if (!elements.agentSkillPanel) return;
    const snapshot = state.agentSkillSnapshot;
    if (elements.agentSkillMeta) {
      if (!snapshot?.canManage) elements.agentSkillMeta.textContent = "等待桌面 agent 同步";
      else elements.agentSkillMeta.textContent = `${snapshot.summary.enabled}/${snapshot.summary.total} 启用 · ${snapshot.summary.showInComposer} 快捷`;
    }
    app.renderAgentSkillOverview();
    app.renderAgentSkillList();
    app.renderAgentSkillDetail();
    app.renderAgentSkillTargets();
    app.refreshAgentSkillStatusText();
    app.updateAgentSkillControls();
  };

  app.renderAgentSkillOverview = function renderAgentSkillOverview() {
    if (!elements.agentSkillOverview) return;
    const summary = state.agentSkillSnapshot?.summary || { total: 0, enabled: 0, showInComposer: 0, failed: 0 };
    const cells = [
      ["发现", summary.total],
      ["启用", summary.enabled],
      ["快捷", summary.showInComposer],
      ["失败", summary.failed]
    ];
    elements.agentSkillOverview.innerHTML = cells
      .map(([label, value]) => `
        <span class="agent-skill-stat">
          <strong>${app.escapeHtml(String(value))}</strong>
          <em>${app.escapeHtml(label)}</em>
        </span>
      `)
      .join("");
  };

  app.renderAgentSkillList = function renderAgentSkillList() {
    if (!elements.agentSkillList) return;
    const snapshot = state.agentSkillSnapshot;
    const skills = snapshot?.skills || [];
    elements.agentSkillList.innerHTML = "";
    if (!snapshot?.canManage) {
      elements.agentSkillList.innerHTML = '<div class="mcp-empty mcp-grid-empty">等待桌面 agent 同步。</div>';
      return;
    }
    if (skills.length === 0) {
      elements.agentSkillList.innerHTML = '<div class="mcp-empty mcp-grid-empty">还没有 Skills。点右上角添加。</div>';
      return;
    }
    for (const skill of skills) {
      const item = document.createElement("div");
      item.className = "agent-skill-item";
      item.append(app.renderAgentSkillManagementCard(skill));
      if (skill.id === state.agentSkillSelectedId) {
        const targetSection = document.createElement("div");
        targetSection.className = "agent-skill-target-section";
        targetSection.innerHTML = '<div class="mcp-section-label">同步到</div>';
        item.append(elements.agentSkillDetail);
        targetSection.append(elements.agentSkillTargetList);
        item.append(targetSection);
      }
      elements.agentSkillList.append(item);
    }
  };

  app.renderAgentSkillManagementCard = function renderAgentSkillManagementCard(skill) {
    const stateName = app.agentSkillCardState(skill);
    const button = document.createElement("button");
    button.className = `mcp-server-card agent-skill-card is-${stateName}`;
    button.type = "button";
    button.dataset.skillId = skill.id;
    const selected = skill.id === state.agentSkillSelectedId;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-expanded", selected ? "true" : "false");
    button.setAttribute("aria-label", `${skill.name}，${app.agentSkillStateLabel(skill)}`);
    button.title = `${skill.name} · ${app.agentSkillStateLabel(skill)}`;
    button.innerHTML = `
      <span class="mcp-card-status" aria-hidden="true"></span>
      <span class="mcp-card-icon" aria-hidden="true">${app.agentSkillIconMarkup(skill)}</span>
      <span class="agent-skill-card-copy">
        <span class="mcp-card-label">${app.escapeHtml(skill.name)}</span>
        <span class="mcp-card-state">${app.escapeHtml(skill.description || app.agentSkillSourceLabel(skill))}</span>
      </span>
      <span class="agent-skill-card-badge">${app.escapeHtml(app.agentSkillStateLabel(skill))}</span>
      <span class="agent-skill-card-chevron" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" /></svg>
      </span>
    `;
    button.addEventListener("click", () => {
      state.agentSkillSelectedId = selected ? "" : skill.id;
      app.renderAgentSkillManagement();
    });
    return button;
  };

  app.agentSkillIconMarkup = function agentSkillIconMarkup(skill = {}) {
    const initial = (String(skill.name || "S").trim()[0] || "S").toUpperCase();
    return `<span class="mcp-card-monogram">${app.escapeHtml(initial)}</span>`;
  };

  app.agentSkillCardState = function agentSkillCardState(skill = {}) {
    if (skill.syncState === "failed") return "failed";
    if (!skill.enabled) return "unavailable";
    if (!skill.showInComposer) return "selected";
    return "active";
  };

  app.agentSkillStateLabel = function agentSkillStateLabel(skill = {}) {
    if (skill.syncState === "failed") return "失败";
    if (!skill.enabled) return "停用";
    if (!skill.showInComposer) return "已启用";
    return "快捷";
  };

  app.renderAgentSkillDetail = function renderAgentSkillDetail() {
    if (!elements.agentSkillDetail) return;
    const skill = app.selectedManagedAgentSkill();
    if (!state.agentSkillSnapshot?.canManage) {
      elements.agentSkillDetail.innerHTML = '<div class="mcp-empty">等待桌面端同步 Skills。</div>';
      return;
    }
    if (!skill) {
      elements.agentSkillDetail.innerHTML = "";
      return;
    }
    const source = skill.source || {};
    const providerText = skill.providers.map((provider) => provider.label || provider.provider).filter(Boolean).join(" · ") || "未同步";
    const failedProviders = skill.providers.filter((provider) => provider.syncState === "failed");
    elements.agentSkillDetail.innerHTML = `
      <div class="mcp-detail-head">
        <span class="mcp-detail-icon is-${app.escapeHtml(app.agentSkillCardState(skill))}" aria-hidden="true">${app.agentSkillIconMarkup(skill)}</span>
        <div>
          <strong>${app.escapeHtml(skill.name)}</strong>
          <span>${app.escapeHtml(skill.description || "本机 Agent Skill")}</span>
        </div>
        <span class="mcp-detail-badge is-${app.escapeHtml(app.agentSkillCardState(skill))}">${app.escapeHtml(app.agentSkillStateLabel(skill))}</span>
      </div>
      <div class="mcp-detail-meta">
        <span>
          <strong>来源</strong>
          <em>${app.escapeHtml(app.agentSkillSourceLabel(skill))}</em>
        </span>
        <span>
          <strong>后端</strong>
          <em>${app.escapeHtml(providerText)}</em>
        </span>
      </div>
      <div class="agent-skill-detail-controls">
        <label class="agent-skill-toggle">
          <input type="checkbox" data-agent-skill-toggle="enabled" ${skill.enabled ? "checked" : ""} />
          <span>
            <strong>启用</strong>
            <small>同步到所选 backend</small>
          </span>
        </label>
        <label class="agent-skill-toggle">
          <input type="checkbox" data-agent-skill-toggle="showInComposer" ${skill.showInComposer ? "checked" : ""} />
          <span>
            <strong>显示在快捷菜单</strong>
            <small>输入框上方可选</small>
          </span>
        </label>
      </div>
      ${failedProviders.length ? `<button class="secondary compact-action agent-skill-retry" type="button" data-agent-skill-retry="true">重试同步</button>` : ""}
    `;
    for (const input of elements.agentSkillDetail.querySelectorAll("[data-agent-skill-toggle]")) {
      input.addEventListener("change", () => {
        app.updateSelectedAgentSkill({ [input.dataset.agentSkillToggle]: input.checked });
      });
    }
    elements.agentSkillDetail.querySelector("[data-agent-skill-retry]")?.addEventListener("click", app.syncSelectedAgentSkill);
  };

  app.agentSkillSourceLabel = function agentSkillSourceLabel(skill = {}) {
    const source = skill.source || {};
    if (source.kind === "echo-shared") return "Echo";
    if (source.kind === "codex") return "Codex";
    if (source.kind === "claude-code") return "Claude";
    return source.label || source.kind || "本机";
  };

  app.renderAgentSkillTargets = function renderAgentSkillTargets() {
    if (!elements.agentSkillTargetList) return;
    const skill = app.selectedManagedAgentSkill();
    elements.agentSkillTargetList.innerHTML = "";
    const providers = state.agentSkillSnapshot?.providers || [];
    if (!skill || providers.length === 0) {
      if (skill) elements.agentSkillTargetList.innerHTML = '<div class="mcp-empty">等待桌面 agent 公布可同步 backend。</div>';
      return;
    }
    for (const provider of providers) {
      const checked = skill.targetProviders.includes(provider.provider);
      const label = document.createElement("label");
      label.className = `mcp-target-item${checked ? " is-selected" : ""}`;
      label.innerHTML = `
        <input type="checkbox" value="${app.escapeHtml(provider.provider)}" ${checked ? "checked" : ""} />
        <span>
          <strong>${app.escapeHtml(provider.label || provider.provider)}</strong>
          <small>${app.escapeHtml(app.agentSkillProviderStatus(skill, provider.provider))}</small>
        </span>
      `;
      label.querySelector("input")?.addEventListener("change", app.updateSelectedAgentSkillTargets);
      elements.agentSkillTargetList.append(label);
    }
  };

  app.agentSkillProviderStatus = function agentSkillProviderStatus(skill = {}, providerId = "") {
    const provider = (skill.providers || []).find((item) => item.provider === providerId);
    if (!provider) return "可同步";
    if (provider.syncState === "failed") return provider.error || "同步失败";
    if (provider.enabled && provider.syncState === "ready") return "已同步";
    if (provider.enabled) return provider.syncState || "同步中";
    return provider.installed ? "已安装" : "未启用";
  };

  app.updateSelectedAgentSkillTargets = function updateSelectedAgentSkillTargets() {
    const selected = Array.from(elements.agentSkillTargetList?.querySelectorAll("input:checked") || []).map((input) => input.value);
    app.updateSelectedAgentSkill({ targetProviders: selected });
  };

  app.refreshAgentSkillStatusText = function refreshAgentSkillStatusText() {
    if (!elements.agentSkillStatus) return;
    const snapshot = state.agentSkillSnapshot;
    const skill = app.selectedManagedAgentSkill();
    if (state.agentSkillBusy) {
      elements.agentSkillStatus.textContent = "桌面 agent 正在处理 Skill 命令";
      return;
    }
    if (!snapshot?.canManage) {
      elements.agentSkillStatus.textContent = "Agent Skills 是本机 runtime 的 SKILL.md；Quick Skills 是 Echo prompt，MCP 是工具连接。";
      return;
    }
    if (!skill) {
      elements.agentSkillStatus.textContent = "刷新后会显示桌面端发现的 Skills。";
      return;
    }
    if (skill.syncState === "failed") {
      const failed = skill.providers.find((provider) => provider.syncState === "failed");
      elements.agentSkillStatus.textContent = failed?.error || "同步失败，可重试或取消该 backend。";
      return;
    }
    elements.agentSkillStatus.textContent = skill.showInComposer
      ? "已启用并显示在输入框 Agent Skills 菜单。"
      : "已启用，但不会显示在输入框快捷菜单。";
  };

  app.updateAgentSkillControls = function updateAgentSkillControls() {
    const disabled = state.agentSkillBusy || !state.codexAgentAvailable;
    if (elements.agentSkillRefreshButton) elements.agentSkillRefreshButton.disabled = state.agentSkillBusy;
    if (elements.agentSkillImportButton) elements.agentSkillImportButton.disabled = disabled;
    for (const control of elements.agentSkillPanel?.querySelectorAll("button,input") || []) {
      if (control === elements.agentSkillRefreshButton || control === elements.agentSkillCloseButton || control === elements.agentSkillImportButton) continue;
      control.disabled = disabled;
    }
    if (elements.agentSkillImportSubmitButton) {
      elements.agentSkillImportSubmitButton.disabled = disabled || !String(elements.agentSkillImportUrl?.value || "").trim();
    }
  };

  app.toggleAgentSkillImportForm = function toggleAgentSkillImportForm(event) {
    event?.stopPropagation();
    if (!elements.agentSkillImportForm) return;
    if (elements.agentSkillImportForm.hidden) {
      app.openAgentSkillImportForm();
      return;
    }
    app.closeAgentSkillImportForm();
  };

  app.openAgentSkillImportForm = function openAgentSkillImportForm() {
    if (!elements.agentSkillImportForm) return;
    elements.agentSkillImportForm.hidden = false;
    elements.agentSkillImportButton?.setAttribute("aria-expanded", "true");
    app.updateAgentSkillControls();
    app.window?.requestAnimationFrame?.(() => {
      elements.agentSkillImportUrl?.focus?.({ preventScroll: true });
    });
  };

  app.closeAgentSkillImportForm = function closeAgentSkillImportForm() {
    if (!elements.agentSkillImportForm) return;
    elements.agentSkillImportForm.hidden = true;
    elements.agentSkillImportUrl.value = "";
    elements.agentSkillImportButton?.setAttribute("aria-expanded", "false");
    app.updateAgentSkillControls();
  };

  app.importAgentSkillFromForm = async function importAgentSkillFromForm(event) {
    event?.preventDefault();
    if (state.agentSkillBusy) return;
    if (!app.ensurePaired()) return;
    const sourceUrl = String(elements.agentSkillImportUrl?.value || "").trim();
    if (!sourceUrl) {
      app.toast("请输入 GitHub URL");
      return;
    }
    const snapshot = state.agentSkillSnapshot;
    const targetProviders = (snapshot?.providers || []).map((provider) => provider.provider).filter(Boolean);
    state.agentSkillBusy = true;
    app.renderAgentSkillManagement();
    try {
      const data = await app.apiPost("/api/codex/agent-skills/import", {
        targetAgentId: app.currentTargetAgentId(),
        sourceUrl,
        enabled: true,
        showInComposer: true,
        targetProviders: targetProviders.length ? targetProviders : undefined
      });
      await app.waitForAgentSkillCommand(data.command?.id || "");
      app.closeAgentSkillImportForm();
      await app.refreshCodex({ forceSkills: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
      if (elements.agentSkillStatus) elements.agentSkillStatus.textContent = error.message;
    } finally {
      state.agentSkillBusy = false;
      app.renderAgentSkillManagement();
    }
  };

  app.refreshAgentSkillRegistry = async function refreshAgentSkillRegistry() {
    if (state.agentSkillBusy) return;
    if (!app.ensurePaired()) return;
    state.agentSkillBusy = true;
    app.renderAgentSkillManagement();
    try {
      const data = await app.apiPost("/api/codex/agent-skills/refresh", {
        targetAgentId: app.currentTargetAgentId()
      });
      await app.waitForAgentSkillCommand(data.command?.id || "");
      await app.refreshCodex({ forceSkills: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
      if (elements.agentSkillStatus) elements.agentSkillStatus.textContent = error.message;
    } finally {
      state.agentSkillBusy = false;
      app.renderAgentSkillManagement();
    }
  };

  app.updateSelectedAgentSkill = async function updateSelectedAgentSkill(patch = {}) {
    if (state.agentSkillBusy) return;
    if (!app.ensurePaired()) return;
    const skill = app.selectedManagedAgentSkill();
    if (!skill) return;
    const targetProviders = Object.prototype.hasOwnProperty.call(patch, "targetProviders") ? patch.targetProviders : skill.targetProviders;
    const nextEnabled = Object.prototype.hasOwnProperty.call(patch, "enabled") ? patch.enabled === true : skill.enabled;
    if (nextEnabled && (!Array.isArray(targetProviders) || targetProviders.length === 0)) {
      app.toast("至少选择一个 backend");
      app.renderAgentSkillManagement();
      return;
    }
    state.agentSkillBusy = true;
    app.renderAgentSkillManagement();
    try {
      const body = {
        targetAgentId: app.currentTargetAgentId(),
        skillId: skill.id,
        enabled: nextEnabled,
        showInComposer: Object.prototype.hasOwnProperty.call(patch, "showInComposer") ? patch.showInComposer === true : skill.showInComposer,
        targetProviders
      };
      const data = await app.apiPost("/api/codex/agent-skills/update", body);
      await app.waitForAgentSkillCommand(data.command?.id || "");
      await app.refreshCodex({ forceSkills: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
      if (elements.agentSkillStatus) elements.agentSkillStatus.textContent = error.message;
    } finally {
      state.agentSkillBusy = false;
      app.renderAgentSkillManagement();
    }
  };

  app.syncSelectedAgentSkill = async function syncSelectedAgentSkill() {
    if (state.agentSkillBusy) return;
    if (!app.ensurePaired()) return;
    const skill = app.selectedManagedAgentSkill();
    if (!skill) return;
    state.agentSkillBusy = true;
    app.renderAgentSkillManagement();
    try {
      const data = await app.apiPost("/api/codex/agent-skills/sync", {
        targetAgentId: app.currentTargetAgentId(),
        skillId: skill.id
      });
      await app.waitForAgentSkillCommand(data.command?.id || "");
      await app.refreshCodex({ forceSkills: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
      if (elements.agentSkillStatus) elements.agentSkillStatus.textContent = error.message;
    } finally {
      state.agentSkillBusy = false;
      app.renderAgentSkillManagement();
    }
  };

  app.waitForAgentSkillCommand = async function waitForAgentSkillCommand(commandId) {
    if (!commandId) throw new Error("Agent Skill command was not queued.");
    const started = Date.now();
    while (Date.now() - started < 45000) {
      const data = await app.apiGet(`/api/codex/agent-skills/commands/${encodeURIComponent(commandId)}`);
      const command = data.command || {};
      if (command.status === "done") return command;
      if (command.status === "failed") throw new Error(command.result?.error || command.error || "Agent Skill command failed.");
      if (elements.agentSkillStatus) elements.agentSkillStatus.textContent = "桌面 agent 正在同步 Skills";
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    throw new Error("等待桌面 agent 同步 Skills 超时");
  };

  const previousHandleGlobalKeydown = app.handleGlobalKeydown;
  app.handleGlobalKeydown = function handleGlobalKeydownWithAgentSkills(event) {
    if (event.key === "Escape" && elements.agentSkillPanel && !elements.agentSkillPanel.hidden) {
      event.preventDefault();
      app.closeAgentSkillPanel({ restoreFocus: true });
      return;
    }
    previousHandleGlobalKeydown?.(event);
  };
}
