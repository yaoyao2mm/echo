export function installAuth(app) {
  const { elements, localStorage, state, window } = app;

  app.bootUserSession = async function bootUserSession() {
    await app.loadAuthConfig();
    if (!state.authEnabled) {
      state.sessionToken = "";
      state.currentUser = { username: "local", displayName: "Local", role: "owner" };
      localStorage.removeItem("echoSession");
      localStorage.removeItem("echoUser");
      return;
    }
    if (state.sessionToken) {
      await app.refreshCurrentUser({ silent: true });
    }
  };

  app.bootAuthenticated = async function bootAuthenticated() {
    if (!app.canUseWorkbench()) {
      app.updateAuthView();
      return;
    }
    app.updateAuthView();
    await app.refreshStatus({ silentAuthFailure: true });
    await app.refreshCodex();
    app.startCodexPolling();
  };

  app.startCodexPolling = function startCodexPolling() {
    if (state.codexTimer) return;

    const schedule = (delayMs = app.codexPollingDelayMs()) => {
      state.codexTimer = window.setTimeout(tick, delayMs);
    };

    const tick = async () => {
      state.codexTimer = null;
      if (!app.canUseWorkbench()) return;
      try {
        await app.refreshCodex({ scheduled: true });
      } finally {
        if (app.canUseWorkbench()) schedule();
      }
    };

    schedule();
  };

  app.stopCodexPolling = function stopCodexPolling() {
    if (!state.codexTimer) return;
    window.clearTimeout(state.codexTimer);
    state.codexTimer = null;
  };

  app.codexPollingDelayMs = function codexPollingDelayMs() {
    if (state.sessionEventSourceId || state.sessionEventReconnectTimer) return 8000;
    return 3500;
  };

  app.updateAuthView = function updateAuthView(message = "") {
    const loggedIn = app.isLoggedIn();
    const paired = Boolean(state.token);
    const pairingRequired = app.requiresPairing?.() !== false;
    const showApp = app.canUseWorkbench();

    if (!showApp) {
      app.resetTopbarScrollTracking({ forceVisible: true });
    }

    if (!showApp && elements.codexView.classList.contains("sessions-open")) {
      app.closeSessionSidebar({ restoreFocus: false });
    }

    elements.loginPanel.hidden = loggedIn;
    elements.pairingPanel.hidden = !loggedIn || !pairingRequired || paired;
    elements.openPairingButton.hidden = !loggedIn;
    elements.openPairingButton.textContent = paired ? "重新配对" : pairingRequired ? "配对" : "连接桌面";
    elements.refreshStatus.hidden = !showApp;
    elements.userBadge.hidden = !loggedIn;
    elements.logoutButton.hidden = !state.authEnabled || !loggedIn;
    elements.userBadge.textContent = loggedIn ? app.displayUser(state.currentUser) : "";
    if (!showApp) {
      app.closeAccountPanel?.({ restoreFocus: false });
    }
    if (!app.isOwnerUser()) {
      app.closeAdminPanel?.({ restoreFocus: false });
    }
    app.renderUserCenter();
    for (const node of elements.authenticated) node.hidden = !showApp;
    if (elements.accountManager) {
      elements.accountManager.hidden = !showApp;
      app.refreshAccountPreferenceSummary?.();
    }
    if (elements.adminManager) {
      elements.adminManager.hidden = !showApp || !app.isOwnerUser();
      app.refreshAdminPreferenceSummary?.();
    }
    app.refreshTopbarProjectChip();

    if (!loggedIn) {
      app.setTopbarStatus("等待登录", "idle");
      elements.loginStatus.textContent = message || "请输入账号后继续。";
      app.queueViewportSync();
      return;
    }

    if (pairingRequired && !paired) {
      app.setTopbarStatus("等待配对", "idle");
      elements.pairingStatus.textContent = message || "如果你是直接打开这个网页，请先扫桌面端显示的二维码。";
      app.queueViewportSync();
      return;
    }

    app.setTopbarStatus(message || "连接中", "info");
    app.queueViewportSync();
  };

  app.loadAuthConfig = async function loadAuthConfig() {
    try {
      const response = await fetch("/api/auth/config");
      const data = await app.parseApiResponse(response);
      state.authEnabled = Boolean(data.enabled);
    } catch {
      state.authEnabled = true;
    }
  };

  app.refreshCurrentUser = async function refreshCurrentUser({ silent = false } = {}) {
    try {
      const response = await fetch("/api/auth/me", { headers: app.sessionHeaders() });
      const data = await app.parseApiResponse(response);
      app.setCurrentUser(data.user);
    } catch {
      app.enterLogin(silent ? "" : "登录已过期，请重新登录。");
    }
  };

  app.login = async function login(event) {
    event.preventDefault();
    elements.loginButton.disabled = true;
    elements.loginStatus.textContent = "登录中...";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          username: elements.loginUsername.value.trim(),
          password: elements.loginPassword.value
        })
      });
      const data = await app.parseApiResponse(response);
      state.sessionToken = data.sessionToken || "";
      localStorage.setItem("echoSession", state.sessionToken);
      app.setCurrentUser(data.user);
      elements.loginPassword.value = "";
      app.toast("已登录");
      await app.bootAuthenticated();
    } catch (error) {
      elements.loginStatus.textContent = error.message || "登录失败";
    } finally {
      elements.loginButton.disabled = false;
    }
  };

  app.logout = function logout() {
    state.sessionToken = "";
    state.token = "";
    state.currentUser = null;
    localStorage.removeItem("echoSession");
    localStorage.removeItem("echoUser");
    localStorage.removeItem("echoToken");
    localStorage.removeItem("echoCodexProject");
    localStorage.removeItem("echoCodexWorkspaces");
    app.clearCodexClientState?.({ clearPairing: false, clearStorage: false });
    app.stopCodexPolling();
    app.closeCodexSessionStream?.();
    app.stopPairingScanner();
    app.closeSessionSidebar({ restoreFocus: false });
    app.closeQuickSkillsPanel?.({ restoreFocus: false });
    app.closeAgentSkillsPanel?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeDesktopPluginPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.updateAuthView("已退出，请重新登录。");
  };

  app.enterLogin = function enterLogin(message = "登录已过期，请重新登录。") {
    state.sessionToken = "";
    state.token = "";
    state.currentUser = null;
    localStorage.removeItem("echoSession");
    localStorage.removeItem("echoUser");
    localStorage.removeItem("echoToken");
    localStorage.removeItem("echoCodexProject");
    localStorage.removeItem("echoCodexWorkspaces");
    app.clearCodexClientState?.({ clearPairing: false, clearStorage: false });
    app.stopCodexPolling();
    app.closeCodexSessionStream?.();
    app.stopPairingScanner();
    app.closeSessionSidebar({ restoreFocus: false });
    app.closeQuickSkillsPanel?.({ restoreFocus: false });
    app.closeAgentSkillsPanel?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeDesktopPluginPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.updateAuthView(message);
  };

  app.renderUserCenter = function renderUserCenter() {
    if (!app.isLoggedIn()) {
      elements.sidebarUserMeta.textContent = "未登录";
      return;
    }
    elements.sidebarUserMeta.textContent = app.canUseWorkbench()
      ? "已连接桌面端"
      : "账号已登录，未连接桌面端";
    app.refreshAccountPreferenceSummary?.();
    app.renderAdminPanel?.();
  };

  app.isOwnerUser = function isOwnerUser() {
    return String(state.currentUser?.role || "").toLowerCase() === "owner";
  };

  app.toggleAccountPanel = function toggleAccountPanel(event) {
    event?.stopPropagation();
    if (!elements.accountPanel) return;
    if (elements.accountPanel.hidden) {
      app.openAccountPanel();
      return;
    }
    app.closeAccountPanel({ restoreFocus: true });
  };

  app.openAccountPanel = function openAccountPanel() {
    if (!app.canUseWorkbench() || !elements.accountPanel) return;
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeDesktopPluginPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeQuickSkillsPanel?.({ restoreFocus: false });
    app.closeAgentSkillsPanel?.({ restoreFocus: false });
    app.closeProjectSwitcher?.();
    app.closeRuntimeSelectPopover?.();
    app.renderUserCenter();
    elements.accountPanel.hidden = false;
    elements.accountPanel.closest?.(".session-sidebar")?.classList.add("account-page-open");
    elements.accountButton?.setAttribute("aria-expanded", "true");
    elements.accountButton?.setAttribute("aria-label", "返回用户中心");
    app.window?.requestAnimationFrame?.(() => {
      elements.accountCloseButton?.focus?.({ preventScroll: true });
    });
  };

  app.closeAccountPanel = function closeAccountPanel({ restoreFocus = false, returnToSettings = false } = {}) {
    if (!elements.accountPanel || elements.accountPanel.hidden) return;
    elements.accountPanel.hidden = true;
    elements.accountPanel.closest?.(".session-sidebar")?.classList.remove("account-page-open");
    elements.accountButton?.setAttribute("aria-expanded", "false");
    elements.accountButton?.setAttribute("aria-label", "打开用户中心");
    if (returnToSettings) {
      app.openMobileSettingsPage?.();
      return;
    }
    if (restoreFocus) elements.accountButton?.focus({ preventScroll: true });
  };

  app.refreshAccountPreferenceSummary = function refreshAccountPreferenceSummary() {
    if (!elements.accountPreferenceSubtitle) return;
    if (!app.isLoggedIn()) {
      elements.accountPreferenceSubtitle.textContent = "未登录";
      return;
    }
    const name = app.displayUser(state.currentUser);
    elements.accountPreferenceSubtitle.textContent = app.canUseWorkbench()
      ? `${name} · 已连接`
      : `${name} · 未连接`;
  };

  app.toggleAdminPanel = function toggleAdminPanel(event) {
    event?.stopPropagation();
    if (!elements.adminPanel) return;
    if (elements.adminPanel.hidden) {
      app.openAdminPanel();
      return;
    }
    app.closeAdminPanel({ restoreFocus: true });
  };

  app.openAdminPanel = function openAdminPanel() {
    if (!app.isOwnerUser() || !elements.adminPanel) return;
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeDesktopPluginPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.closeQuickSkillsPanel?.({ restoreFocus: false });
    app.closeAgentSkillsPanel?.({ restoreFocus: false });
    app.closeProjectSwitcher?.();
    app.closeRuntimeSelectPopover?.();
    app.renderAdminPanel();
    elements.adminPanel.hidden = false;
    elements.adminPanel.closest?.(".session-sidebar")?.classList.add("admin-page-open");
    elements.adminButton?.setAttribute("aria-expanded", "true");
    elements.adminButton?.setAttribute("aria-label", "返回访问管理");
    if (!state.adminLoaded && !state.adminBusy) app.loadAdmin();
    app.window?.requestAnimationFrame?.(() => {
      elements.adminCloseButton?.focus?.({ preventScroll: true });
    });
  };

  app.closeAdminPanel = function closeAdminPanel({ restoreFocus = false, returnToSettings = false } = {}) {
    if (!elements.adminPanel || elements.adminPanel.hidden) return;
    elements.adminPanel.hidden = true;
    elements.adminPanel.closest?.(".session-sidebar")?.classList.remove("admin-page-open");
    elements.adminButton?.setAttribute("aria-expanded", "false");
    elements.adminButton?.setAttribute("aria-label", "管理访问");
    if (returnToSettings) {
      app.openMobileSettingsPage?.();
      return;
    }
    if (restoreFocus) elements.adminButton?.focus({ preventScroll: true });
  };

  app.loadAdmin = async function loadAdmin() {
    if (!app.isOwnerUser() || state.adminBusy) return;
    state.adminBusy = true;
    if (elements.adminStatus) elements.adminStatus.textContent = "正在刷新用户...";
    try {
      const [summary, status] = await Promise.all([app.apiGet("/api/admin/summary"), app.apiGet("/api/status")]);
      if (status.user) app.setCurrentUser(status.user, { updateView: false });
      if (status.codex) app.renderCodexStatus(status.codex);
      state.adminSummary = summary;
      state.adminLoaded = true;
      app.renderAdminPanel();
    } catch (error) {
      if (!app.handleAuthError(error, "登录已过期，请重新登录。")) {
        if (elements.adminStatus) elements.adminStatus.textContent = error.message || "加载失败";
      }
    } finally {
      state.adminBusy = false;
      app.updateAdminControls?.();
    }
  };

  app.refreshAdminPreferenceSummary = function refreshAdminPreferenceSummary() {
    if (!elements.adminPreferenceSubtitle) return;
    if (!app.isOwnerUser()) {
      elements.adminPreferenceSubtitle.textContent = "仅 owner 可用";
      return;
    }
    const rows = app.adminAccessRows?.() || [];
    if (!state.adminLoaded) {
      elements.adminPreferenceSubtitle.textContent = "批准哪些用户可使用这台电脑";
      return;
    }
    const registered = rows.length;
    const approved = rows.filter((row) => row.approved).length;
    elements.adminPreferenceSubtitle.textContent = `${registered} 个已注册 · ${approved} 个已批准`;
  };

  app.adminAccessRows = function adminAccessRows() {
    const users = Array.isArray(state.adminSummary?.users) ? state.adminSummary.users : [];
    const agents = Array.isArray(state.codexAgents) ? state.codexAgents : [];
    const pairingTokens = Array.isArray(state.adminSummary?.tokens?.pairingTokens) ? state.adminSummary.tokens.pairingTokens : [];
    const accessGrants = Array.isArray(state.adminSummary?.tokens?.agentAccessGrants)
      ? state.adminSummary.tokens.agentAccessGrants
      : [];
    const currentAgent = app.adminCurrentAgent();
    const currentAgentId = String(currentAgent?.id || "").trim();
    const currentAgentOwner = app.adminUsername(currentAgent?.ownerUser || currentAgent?.ownerUsername || state.currentUser?.username);
    const byUsername = new Map();
    for (const user of users) {
      const username = app.adminUsername(user.username);
      if (!username) continue;
      byUsername.set(username, {
        username,
        displayName: String(user.displayName || username).trim(),
        role: String(user.role || "user").trim(),
        disabled: Boolean(user.disabledAt),
        source: user.source || "user"
      });
    }
    for (const agent of agents) {
      const username = app.adminUsername(agent.ownerUser || agent.ownerUsername);
      if (!username) continue;
      const existing = byUsername.get(username);
      if (existing) continue;
      byUsername.set(username, {
        username,
        displayName: String(agent.ownerUser || username).trim(),
        role: "user",
        disabled: true,
        source: "agent"
      });
    }

    return Array.from(byUsername.values())
      .map((user) => {
        const userAgents = agents.filter((agent) => app.adminUsername(agent.ownerUser || agent.ownerUsername) === user.username);
        const hasPairingToken = pairingTokens.some((token) => {
          const owner = app.adminUsername(token.ownerUser || token.ownerUsername || token.username);
          return owner === user.username && !token.disabledAt && !token.revokedAt;
        });
        const approved = accessGrants.some((grant) => {
          const grantee = app.adminUsername(grant.granteeUser || grant.username);
          const grantAgentId = String(grant.agentId || "").trim();
          const grantOwner = app.adminUsername(grant.ownerUser || grant.ownerUsername);
          return (
            grantee === user.username &&
            grantAgentId === currentAgentId &&
            grantOwner === currentAgentOwner &&
            !grant.disabledAt &&
            !grant.revokedAt
          );
        });
        const onlineAgent = userAgents.find((agent) => agent.online) || userAgents[0] || null;
        const current = user.username === app.adminUsername(state.currentUser?.username);
        return {
          ...user,
          agents: userAgents,
          agent: onlineAgent,
          hasAgent: userAgents.length > 0,
          agentOnline: Boolean(onlineAgent?.online),
          approved,
          hasPairingToken,
          current,
          canApprove: Boolean(currentAgentId && !current && !user.disabled),
          status: current ? "current" : approved ? "approved" : user.disabled ? "disabled" : "pending"
        };
      })
      .sort((left, right) => {
        const order = { pending: 0, approved: 1, current: 2, disabled: 3 };
        const byStatus = (order[left.status] ?? 9) - (order[right.status] ?? 9);
        if (byStatus) return byStatus;
        return left.username.localeCompare(right.username);
      });
  };

  app.adminCurrentAgent = function adminCurrentAgent() {
    const agents = Array.isArray(state.codexAgents) ? state.codexAgents : [];
    if (agents.length === 0) return null;
    const targetAgentId = app.currentTargetAgentId?.() || "";
    return (
      agents.find((agent) => agent.id && agent.id === targetAgentId) ||
      agents.find((agent) => agent.online) ||
      agents[0] ||
      null
    );
  };

  app.renderAdminPanel = function renderAdminPanel() {
    if (!elements.adminPanel) return;
    const owner = app.isOwnerUser();
    if (elements.adminManager) elements.adminManager.hidden = !app.canUseWorkbench() || !owner;
    if (!owner) {
      app.closeAdminPanel?.({ restoreFocus: false });
      return;
    }

    const rows = app.adminAccessRows();
    if (!rows.some((row) => row.username === state.adminSelectedUsername)) state.adminSelectedUsername = "";

    app.renderAdminAgentList(rows);
    if (!state.adminSelectedUsername) elements.adminPanel.querySelector?.(".admin-actions")?.append(elements.adminApproveButton);
    app.renderAdminUserGrid(rows);
    app.renderAdminUserDetail(rows.find((row) => row.username === state.adminSelectedUsername) || null);
    app.refreshAdminPreferenceSummary();
    app.updateAdminControls();
  };

  app.renderAdminAgentList = function renderAdminAgentList(rows = app.adminAccessRows()) {
    if (!elements.adminAgentList) return;
    const agents = Array.isArray(state.codexAgents) ? state.codexAgents : [];
    const online = agents.filter((agent) => agent.online).length;
    const registered = rows.length;
    if (elements.adminMeta) {
      elements.adminMeta.textContent = state.adminLoaded
        ? `${registered} 个用户注册 · ${online} 个在线 agent`
        : "等待刷新访问状态";
    }
    elements.adminAgentList.innerHTML = agents.length
      ? agents
          .map((agent) => {
            const owner = app.adminUsername(agent.ownerUser || agent.ownerUsername) || "未绑定";
            const label = String(agent.displayName || agent.id || owner).trim();
            const selected = agent === app.adminCurrentAgent();
            return `
              <div class="admin-agent-pill ${agent.online ? "is-online" : "is-offline"}${selected ? " is-selected" : ""}">
                <span class="admin-agent-dot" aria-hidden="true"></span>
                <strong>${app.escapeHtml(label)}</strong>
                <span>${selected ? "当前" : app.escapeHtml(owner)}</span>
              </div>
            `;
          })
          .join("")
      : '<div class="mcp-empty">当前还没有在线 agent。</div>';
  };

  app.renderAdminUserGrid = function renderAdminUserGrid(rows = app.adminAccessRows()) {
    if (!elements.adminUserList) return;
    if (!state.adminLoaded && state.adminBusy) {
      elements.adminUserList.innerHTML = '<div class="mcp-empty mcp-grid-empty">正在加载用户...</div>';
      return;
    }
    if (rows.length === 0) {
      elements.adminUserList.innerHTML = '<div class="mcp-empty mcp-grid-empty">还没有可管理访问。</div>';
      return;
    }
    elements.adminUserList.innerHTML = "";
    for (const row of rows) {
      const item = app.document.createElement("div");
      const selected = row.username === state.adminSelectedUsername;
      item.className = "admin-user-item";
      item.innerHTML = app.adminUserCardMarkup(row);
      if (selected) {
        item.append(elements.adminUserDetail);
        item.append(elements.adminApproveButton);
      }
      elements.adminUserList.append(item);
    }
  };

  app.adminUserCardMarkup = function adminUserCardMarkup(row) {
    const selected = row.username === state.adminSelectedUsername;
    const statusLabel = row.current ? "管理员" : row.approved ? "已批准" : row.disabled ? "不可用" : "待批准";
    const statusClass = row.current ? "current" : row.approved ? "approved" : row.disabled ? "disabled" : "pending";
    const canApprove = row.canApprove && !row.approved;
    return `
      <button
        class="mcp-server-card admin-user-card is-${statusClass}${selected ? " is-selected" : ""}"
        type="button"
        data-admin-action="select-user"
        data-username="${app.escapeHtml(row.username)}"
        data-can-approve="${canApprove ? "true" : "false"}"
        aria-expanded="${selected ? "true" : "false"}"
        aria-label="${app.escapeHtml(row.displayName)}，${app.escapeHtml(statusLabel)}"
        ${row.disabled ? "disabled" : ""}
      >
        <span class="mcp-card-status" aria-hidden="true"></span>
        <span class="mcp-card-icon admin-avatar" aria-hidden="true">${app.escapeHtml(app.adminInitials(row.displayName || row.username))}</span>
        <span class="admin-user-copy">
          <span class="mcp-card-label">${app.escapeHtml(row.displayName || row.username)}</span>
          <span class="mcp-card-state">${app.escapeHtml(row.username)}</span>
        </span>
        <span class="admin-user-status">${app.escapeHtml(statusLabel)}</span>
        <span class="mcp-card-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="m8 10 4 4 4-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" /></svg>
        </span>
      </button>
    `;
  };

  app.renderAdminUserDetail = function renderAdminUserDetail(row) {
    if (!elements.adminUserDetail) return;
    if (!row) {
      elements.adminUserDetail.innerHTML = `
        <div class="mcp-detail-head">
          <span class="mcp-detail-icon admin-avatar" aria-hidden="true">U</span>
          <div>
            <strong>没有用户</strong>
            <span>刷新后会显示可审批用户</span>
          </div>
          <span class="mcp-detail-badge">空</span>
        </div>
      `;
      return;
    }
    const generated = state.adminGeneratedPairing?.username === row.username ? state.adminGeneratedPairing : null;
    const badgeClass = row.approved ? "is-active" : row.current ? "is-active" : row.canApprove ? "is-selected" : "";
    const badge = row.current ? "管理员" : row.approved ? "已批准" : row.disabled ? "不可用" : "待批准";
    const currentAgent = app.adminCurrentAgent();
    const agentLabel = currentAgent
      ? `${currentAgent.displayName || currentAgent.id || "Agent"}${currentAgent.online ? " 在线" : " 离线"}`
      : "没有在线 desktop agent";
    const ownAgentLabel = row.agent
      ? `${row.agent.displayName || row.agent.id || "Agent"}${row.agent.online ? " 在线" : " 离线"}`
      : "无";
    elements.adminUserDetail.innerHTML = `
      <div class="mcp-detail-head">
        <span class="mcp-detail-icon admin-avatar" aria-hidden="true">${app.escapeHtml(app.adminInitials(row.displayName || row.username))}</span>
        <div>
          <strong>${app.escapeHtml(row.displayName || row.username)}</strong>
          <span>${app.escapeHtml(row.username)}</span>
        </div>
        <span class="mcp-detail-badge ${badgeClass}">${app.escapeHtml(badge)}</span>
      </div>
      <div class="mcp-detail-meta">
        <span><strong>批准到</strong><em>${app.escapeHtml(agentLabel)}</em></span>
        <span><strong>自有 agent</strong><em>${app.escapeHtml(ownAgentLabel)}</em></span>
        <span><strong>角色</strong><em>${app.escapeHtml(row.role || "user")}</em></span>
        <span><strong>手机 token</strong><em>${row.hasPairingToken ? "已有" : "将生成"}</em></span>
      </div>
      ${
        generated
          ? `
            <div class="admin-generated-token">
              <strong>配对链接只显示一次</strong>
              <code>${app.escapeHtml(generated.url)}</code>
              <button class="secondary compact-action" type="button" data-admin-action="copy-generated-link">复制链接</button>
            </div>
          `
          : ""
      }
    `;
  };

  app.selectAdminUser = async function selectAdminUser(username, options = {}) {
    const normalized = app.adminUsername(username);
    if (!normalized) return;
    state.adminSelectedUsername = state.adminSelectedUsername === normalized ? "" : normalized;
    app.renderAdminPanel();
    if (options.approve) await app.approveSelectedAdminUser();
  };

  app.approveSelectedAdminUser = async function approveSelectedAdminUser() {
    if (!app.isOwnerUser() || state.adminBusy) return;
    const rows = app.adminAccessRows();
    const row = rows.find((item) => item.username === state.adminSelectedUsername);
    if (!row) return;
    const agent = app.adminCurrentAgent();
    if (!agent?.id) {
      app.toast("当前没有可批准的 desktop agent");
      return;
    }
    if (row.current) {
      app.toast("当前管理员已经有访问权限");
      return;
    }
    if (row.disabled) {
      app.toast("这个用户不可用");
      return;
    }
    state.adminBusy = true;
    app.updateAdminControls();
    if (elements.adminStatus) elements.adminStatus.textContent = `正在批准 ${row.displayName || row.username}...`;
    try {
      const data = await app.apiPost("/api/admin/agent-approvals", {
        username: row.username,
        agentId: agent.id,
        ownerUsername: agent.ownerUser || agent.ownerUsername || state.currentUser?.username || "",
        agentDisplayName: agent.displayName || agent.id || "Desktop Agent",
        label: `${row.displayName || row.username} Safari`
      });
      const token = data.token || "";
      state.adminGeneratedPairing = {
        username: row.username,
        agentId: agent.id,
        token,
        url: app.adminPairingUrl(token)
      };
      state.adminBusy = false;
      await app.loadAdmin();
      app.toast("已批准，配对链接已生成");
    } catch (error) {
      if (!app.handleAuthError(error, "登录已过期，请重新登录。")) app.toast(error.message);
    } finally {
      state.adminBusy = false;
      app.renderAdminPanel();
    }
  };

  app.updateAdminControls = function updateAdminControls() {
    const rows = app.adminAccessRows();
    const row = rows.find((item) => item.username === state.adminSelectedUsername);
    const canApprove = Boolean(row?.canApprove);
    if (elements.adminApproveButton) {
      elements.adminApproveButton.hidden = !row;
      elements.adminApproveButton.disabled = state.adminBusy || !canApprove;
      elements.adminApproveButton.textContent = row?.approved ? "重新生成" : "批准";
    }
    if (elements.adminStatus) {
      if (state.adminBusy) return;
      const pending = rows.filter((item) => item.canApprove && !item.approved).length;
      const approved = rows.filter((item) => item.approved).length;
      elements.adminStatus.textContent = state.adminLoaded ? `${pending} 个待批准 · ${approved} 个已批准` : "点击刷新加载用户";
    }
  };

  app.handleAdminClick = async function handleAdminClick(event) {
    const button = event.target.closest("[data-admin-action]");
    if (!button || !app.isOwnerUser()) return;
    const action = button.dataset.adminAction;
    if (action === "select-user") {
      await app.selectAdminUser(button.dataset.username || "");
      return;
    }
    if (action === "copy-generated-link") {
      const text = state.adminGeneratedPairing?.url || "";
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        app.toast("已复制配对链接");
      } catch {
        app.toast("复制失败，请长按链接手动复制");
      }
      return;
    }
  };

  app.adminUsername = function adminUsername(value) {
    return String(value || "").trim().toLowerCase();
  };

  app.adminInitials = function adminInitials(value) {
    const text = String(value || "").trim();
    if (!text) return "U";
    const parts = text.split(/[\s._-]+/).filter(Boolean);
    const letters = (parts.length > 1 ? [parts[0], parts[1]] : [text])
      .map((part) => Array.from(part).find((char) => /[\p{L}\p{N}]/u.test(char)) || "")
      .join("");
    return (letters || "U").slice(0, 2).toUpperCase();
  };

  app.adminPairingUrl = function adminPairingUrl(token) {
    const url = new URL("/", window.location.origin);
    url.searchParams.set("token", token);
    return url.toString();
  };

  app.adminBytes = function adminBytes(value) {
    if (typeof app.formatBytes === "function") return app.formatBytes(value);
    const bytes = Math.max(0, Number(value || 0) || 0);
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  };

  app.setCurrentUser = function setCurrentUser(user, options = {}) {
    const previousUserKey = app.storageUserKey?.(state.currentUser) || "";
    const nextUserKey = app.storageUserKey?.(user) || "";
    const userChanged = Boolean(previousUserKey && nextUserKey && previousUserKey !== nextUserKey);
    if (userChanged) {
      state.token = "";
      localStorage.removeItem("echoToken");
      app.clearCodexClientState?.({ user, clearPairing: false, clearStorage: false });
    }
    state.currentUser = user || null;
    if (state.currentUser) {
      localStorage.setItem("echoUser", JSON.stringify(state.currentUser));
      if (!state.token) state.token = app.storedEchoToken?.(state.currentUser, { fallbackLegacy: !userChanged }) || "";
      if (userChanged || !state.codexWorkspaces?.length) {
        state.codexWorkspaces = app.readStoredCodexWorkspaces?.(state.currentUser, { fallbackLegacy: !userChanged }) || [];
        state.codexAvailableWorkspaceKeys = [];
      }
    } else {
      localStorage.removeItem("echoUser");
    }
    if (options.updateView !== false) app.updateAuthView();
  };

  app.isLoggedIn = function isLoggedIn() {
    return !state.authEnabled || Boolean(state.sessionToken && state.currentUser);
  };

  app.displayUser = function displayUser(user) {
    return user?.displayName || user?.username || "";
  };

  app.showPairingPanel = function showPairingPanel({ focus = false } = {}) {
    if (!app.ensureLoggedIn()) return;
    app.closeAccountPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeDesktopPluginPanel?.({ restoreFocus: false });
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeProjectImportPanel?.({ restoreFocus: false });
    if (elements.codexView?.classList.contains("sessions-open")) {
      app.closeSessionSidebar?.({ restoreFocus: false });
    }
    app.updateAuthView();
    elements.pairingPanel.hidden = false;
    if (state.token && !elements.pairingStatus.textContent.trim()) {
      elements.pairingStatus.textContent = "重新扫码会覆盖当前桌面端配对。";
    }
    if (focus) {
      elements.pairingPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      elements.scanPairingButton.focus({ preventScroll: true });
    }
  };

  app.enterPairing = function enterPairing(message = "配对已失效，请重新扫描桌面端二维码。") {
    app.clearEchoToken?.();
    state.token = "";
    app.stopCodexPolling();
    app.closeCodexSessionStream?.();
    app.stopPairingScanner();
    app.closeQuickSkillsPanel?.({ restoreFocus: false });
    app.closeAgentSkillsPanel?.({ restoreFocus: false });
    app.closeMcpPanel?.({ restoreFocus: false });
    app.closeDesktopPluginPanel?.({ restoreFocus: false });
    app.closeAdminPanel?.({ restoreFocus: false });
    app.closeAccountPanel?.({ restoreFocus: false });
    app.closeMobileSettingsPage?.({ restoreFocus: false });
    app.closeProjectImportPanel?.({ restoreFocus: false });
    if (elements.codexView?.classList.contains("sessions-open")) {
      app.closeSessionSidebar?.({ restoreFocus: false });
    }
    app.updateAuthView(message);
  };

  app.handleAuthError = function handleAuthError(error, message) {
    if (error.code === "SESSION_REQUIRED") {
      app.enterLogin("登录已过期，请重新登录。");
      return true;
    }
    if (error.code && error.code !== "PAIRING_REQUIRED") return false;
    if (error.status !== 401) return false;
    app.enterPairing(message);
    return true;
  };

  app.refreshStatus = async function refreshStatus(options = {}) {
    if (!app.canUseWorkbench()) {
      app.updateAuthView();
      return;
    }

    try {
      const status = await app.apiGet("/api/status");
      const codexOnline = status.codex?.agentOnline;
      const codexAvailable = codexOnline || app.codexAgentRecentlySeen?.(status.codex || {});
      app.setTopbarStatus(
        codexOnline ? "Codex 在线" : codexAvailable ? "桌面状态同步中" : status.mode === "relay" ? "等待桌面 agent" : status.platform,
        codexOnline ? "online" : "idle"
      );
      if (status.user) app.setCurrentUser(status.user, { updateView: false });
      app.renderUserCenter();
      if (status.codex) app.renderCodexStatus(status.codex);
    } catch (error) {
      if (app.handleAuthError(error, "当前浏览器没有有效配对，请扫描桌面端二维码。")) {
        if (!options.silentAuthFailure) {
          elements.pairingStatus.textContent = "当前浏览器没有有效配对，请扫描桌面端二维码。";
        }
      } else {
        app.markCodexConnectionProblem?.("连接中断，当前会话已保留。") || app.setTopbarStatus("连接失败", "error");
        app.toast(error.message);
      }
    }
  };

  app.startPairingScanner = async function startPairingScanner() {
    if (!app.ensureLoggedIn()) return;
    app.showPairingPanel();
    if (!window.isSecureContext) {
      app.toast("扫码需要 HTTPS 或 localhost 安全上下文");
      return;
    }
    if (!("BarcodeDetector" in window)) {
      elements.pairingStatus.textContent = "当前浏览器不支持网页扫码，请使用 Android Chrome，或粘贴桌面端配对链接。";
      return;
    }

    try {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      state.pairingStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment"
        }
      });
      elements.pairingVideo.srcObject = state.pairingStream;
      await elements.pairingVideo.play();
      state.pairingScanActive = true;
      elements.pairingStatus.textContent = "正在扫描桌面端二维码...";
      elements.scanPairingButton.hidden = true;
      elements.stopScanButton.hidden = false;
      app.scanPairingFrame(detector);
    } catch (error) {
      app.stopPairingScanner();
      elements.pairingStatus.textContent = "相机没有启动，请检查浏览器相机权限，或粘贴配对链接。";
      app.toast(error.message);
    }
  };

  app.scanPairingFrame = async function scanPairingFrame(detector) {
    if (!state.pairingScanActive) return;
    if (!state.pairingScanBusy && elements.pairingVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      state.pairingScanBusy = true;
      try {
        const codes = await detector.detect(elements.pairingVideo);
        const value = codes[0]?.rawValue || "";
        const nextToken = app.extractPairingToken(value);
        if (nextToken) {
          await app.completePairing(nextToken);
          return;
        }
      } catch {
        // Ignore transient detector failures while the camera warms up.
      } finally {
        state.pairingScanBusy = false;
      }
    }
    window.requestAnimationFrame(() => app.scanPairingFrame(detector));
  };

  app.stopPairingScanner = function stopPairingScanner() {
    state.pairingScanActive = false;
    state.pairingScanBusy = false;
    if (state.pairingStream) {
      state.pairingStream.getTracks().forEach((track) => track.stop());
      state.pairingStream = null;
    }
    elements.pairingVideo.srcObject = null;
    elements.scanPairingButton.hidden = false;
    elements.stopScanButton.hidden = true;
    if (!state.token) {
      elements.pairingStatus.textContent ||= "如果你是直接打开这个网页，请先扫桌面端显示的二维码。";
    }
  };

  app.pairFromInput = async function pairFromInput() {
    const nextToken = app.extractPairingToken(elements.pairingInput.value);
    if (!nextToken) {
      elements.pairingStatus.textContent = "没有找到配对 token，请粘贴完整配对链接或 token。";
      return;
    }
    await app.completePairing(nextToken);
  };

  app.extractPairingToken = function extractPairingToken(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text, window.location.origin);
      const urlToken = url.searchParams.get("token") || "";
      if (urlToken) return urlToken;
    } catch {
      // Fall through to raw token handling.
    }
    return /^[A-Za-z0-9._-]{12,}$/.test(text) ? text : "";
  };

  app.completePairing = async function completePairing(nextToken) {
    if (!app.ensureLoggedIn()) return;
    state.token = nextToken;
    app.persistEchoToken?.(state.token);
    app.stopPairingScanner();
    elements.pairingInput.value = "";
    await app.bootAuthenticated();
    if (state.token) app.toast("配对成功");
  };
}
