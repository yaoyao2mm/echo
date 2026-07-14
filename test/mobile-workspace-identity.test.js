import assert from "node:assert/strict";
import test from "node:test";
import { installAgentSkills } from "../public/app/agent-skills.js";
import { installAuth } from "../public/app/auth.js";
import { installCodex } from "../public/app/codex.js";
import { installCore } from "../public/app/core.js";
import { installMcp } from "../public/app/mcp.js";

test("project selection persists the agent-qualified workspace key for duplicate workspace ids", () => {
  const storage = createStorage({
    "echoCodexProject:alice": "echo"
  });
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "owner" });
  installCodex(app);
  stubCodexStatusSideEffects(app);
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.renderCodexStatus({
      agentOnline: true,
      workspaces: [
        { id: "echo", key: "alice-mac:echo", label: "Echo", agentId: "alice-mac", agentLabel: "Alice Mac" },
        { id: "echo", key: "bob-pc:echo", label: "Echo", agentId: "bob-pc", agentLabel: "Bob PC" }
      ],
      runtime: {}
    });

    assert.equal(app.elements.codexProject.value, "alice-mac:echo");
    assert.equal(storage.getItem("echoCodexProject:alice"), "alice-mac:echo");

    app.renderCodexStatus({
      agentOnline: true,
      workspaces: [
        { id: "echo", key: "bob-pc:echo", label: "Echo", agentId: "bob-pc", agentLabel: "Bob PC" },
        { id: "echo", key: "alice-mac:echo", label: "Echo", agentId: "alice-mac", agentLabel: "Alice Mac" }
      ],
      runtime: {}
    });

    assert.equal(app.elements.codexProject.value, "alice-mac:echo");
    assert.equal(app.currentProjectId(), "echo");
    assert.equal(app.currentTargetAgentId(), "alice-mac");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("online empty workspace status keeps the mobile workspace cache", () => {
  const storage = createStorage({
    "echoCodexProject:alice": "alice-mac:echo"
  });
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "owner" });
  installCodex(app);
  stubCodexStatusSideEffects(app);
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.renderCodexStatus({
      agentOnline: true,
      workspaces: [{ id: "echo", key: "alice-mac:echo", label: "Echo", path: "/workspace/echo", agentId: "alice-mac" }],
      runtime: {}
    });

    assert.equal(app.state.codexWorkspaces.length, 1);
    assert.equal(app.elements.codexProject.value, "alice-mac:echo");

    app.renderCodexStatus({
      agentOnline: true,
      workspaces: [],
      runtime: {}
    });

    assert.deepEqual(app.state.codexWorkspaces.map((workspace) => workspace.key), ["alice-mac:echo"]);
    assert.deepEqual(app.state.codexAvailableWorkspaceKeys, []);
    assert.equal(app.elements.codexProject.value, "alice-mac:echo");
    assert.equal(app.currentProjectId(), "echo");
    assert.equal(app.elements.codexQueueMeta.textContent.includes("项目 1"), true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("online workspace availability is tracked separately from the cached project list", () => {
  const storage = createStorage({
    "echoCodexProject:alice": "alice-mac:echo"
  });
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "owner" });
  installCodex(app);
  stubCodexStatusSideEffects(app);
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.renderCodexStatus({
      agentOnline: true,
      workspaces: [{ id: "echo", key: "alice-mac:echo", label: "Echo", path: "/workspace/echo", agentId: "alice-mac" }],
      statusUpdatedAt: "2026-05-21T00:00:02.000Z",
      workspacesUpdatedAt: "2026-05-21T00:00:01.000Z",
      runtimeUpdatedAt: "2026-05-21T00:00:00.000Z",
      statusVersion: "v1",
      runtime: {}
    });

    assert.deepEqual(app.state.codexAvailableWorkspaceKeys, ["alice-mac:echo"]);
    assert.equal(app.codexCommandsAvailable(), true);
    assert.equal(app.state.codexStatusUpdatedAt, "2026-05-21T00:00:02.000Z");
    assert.equal(app.state.codexWorkspacesUpdatedAt, "2026-05-21T00:00:01.000Z");
    assert.equal(app.state.codexRuntimeUpdatedAt, "2026-05-21T00:00:00.000Z");
    assert.equal(app.state.codexStatusVersion, "v1");

    app.renderCodexStatus({
      agentOnline: true,
      workspaces: [],
      runtime: {}
    });

    assert.deepEqual(app.state.codexWorkspaces.map((workspace) => workspace.key), ["alice-mac:echo"]);
    assert.deepEqual(app.state.codexAvailableWorkspaceKeys, []);
    assert.equal(app.elements.codexProject.value, "alice-mac:echo");
    assert.equal(app.codexCommandsAvailable(), false);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("hidden workspace keys filter cached mobile projects while desktop is online", () => {
  const storage = createStorage({
    "echoCodexProject:alice": "alice-mac:echo"
  });
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "owner" });
  installCodex(app);
  stubCodexStatusSideEffects(app);
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.renderCodexStatus({
      agentOnline: true,
      workspaces: [{ id: "echo", key: "alice-mac:echo", label: "Echo", path: "/workspace/echo", agentId: "alice-mac" }],
      runtime: {}
    });
    assert.deepEqual(app.state.codexWorkspaces.map((workspace) => workspace.key), ["alice-mac:echo"]);

    app.renderCodexStatus({
      agentOnline: true,
      workspaces: [],
      hiddenWorkspaceKeys: ["alice-mac:echo"],
      runtime: {}
    });

    assert.deepEqual(app.state.codexWorkspaces, []);
    assert.equal(app.elements.codexProject.value, "");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("auth user switches load only that user's scoped pairing and workspace cache", () => {
  const storage = createStorage({
    "echoToken": "legacy-token",
    "echoToken:alice": "alice-token",
    "echoToken:bob": "bob-token",
    "echoCodexWorkspaces": JSON.stringify([{ id: "echo", key: "alice-mac:echo", agentId: "alice-mac" }]),
    "echoCodexWorkspaces:bob": JSON.stringify([
      { id: "side", key: "bob-pc:side", label: "Side", agentId: "bob-pc" }
    ])
  });
  const app = createAuthApp(storage, {
    currentUser: { username: "alice", displayName: "Alice", role: "user" },
    token: "alice-token",
    codexWorkspaces: [{ id: "echo", key: "alice-mac:echo", agentId: "alice-mac" }]
  });
  installCore(app);
  installAuth(app);

  app.setCurrentUser({ username: "bob", displayName: "Bob", role: "user" }, { updateView: false });

  assert.equal(app.state.token, "bob-token");
  assert.equal(storage.getItem("echoToken"), null);
  assert.equal(storage.getItem("echoToken:alice"), "alice-token");
  assert.deepEqual(app.state.codexWorkspaces.map((workspace) => workspace.key), ["bob-pc:side"]);
});

test("auth user switches do not fall back to legacy unscoped workspace cache", () => {
  const storage = createStorage({
    "echoCodexWorkspaces": JSON.stringify([{ id: "echo", key: "alice-mac:echo", agentId: "alice-mac" }])
  });
  const app = createAuthApp(storage, {
    currentUser: { username: "alice", displayName: "Alice", role: "user" },
    token: "alice-token",
    codexWorkspaces: [{ id: "echo", key: "alice-mac:echo", agentId: "alice-mac" }]
  });
  installCore(app);
  installAuth(app);

  app.setCurrentUser({ username: "bob", displayName: "Bob", role: "user" }, { updateView: false });

  assert.equal(app.state.token, "");
  assert.deepEqual(app.state.codexWorkspaces, []);
});

test("authenticated users can enter the workbench without a pairing token", async () => {
  const storage = createStorage({});
  const app = createAuthApp(storage, {
    currentUser: { username: "huahua", displayName: "Huahua", role: "user" },
    sessionToken: "session-token",
    authEnabled: true
  });
  installCore(app);
  installAuth(app);

  let refreshStatusCount = 0;
  let refreshCodexCount = 0;
  let pollingStarted = false;
  app.refreshStatus = async () => {
    refreshStatusCount += 1;
  };
  app.refreshCodex = async () => {
    refreshCodexCount += 1;
  };
  app.startCodexPolling = () => {
    pollingStarted = true;
  };

  assert.equal(app.canUseWorkbench(), true);
  app.updateAuthView();
  assert.equal(app.elements.pairingPanel.hidden, true);
  assert.equal(app.elements.refreshStatus.hidden, false);

  await app.bootAuthenticated();
  assert.equal(refreshStatusCount, 1);
  assert.equal(refreshCodexCount, 1);
  assert.equal(pollingStarted, true);
});

test("local unauthenticated mode still requires a pairing token", () => {
  const storage = createStorage({});
  const app = createAuthApp(storage, {
    currentUser: { username: "local", displayName: "Local", role: "owner" },
    authEnabled: false
  });
  installCore(app);
  installAuth(app);

  assert.equal(app.canUseWorkbench(), false);
  app.updateAuthView();
  assert.equal(app.elements.pairingPanel.hidden, false);
});

test("topbar environment title uses an initials avatar for long desktop names", () => {
  const app = createAuthApp(createStorage({}), {
    currentUser: { username: "alice", displayName: "Alice", role: "owner" },
    authEnabled: true
  });
  installCore(app);
  app.canUseWorkbench = () => true;

  app.setTopbarContextTitle("JohndeMac-mini.local-6c7308b26d0d");
  app.setTopbarStatus("本机 agent 在线", "online");

  assert.equal(app.state.topbarContextTitle, "JohndeMac-mini.local-6c7308b26d0d");
  assert.equal(app.elements.topbarContextTitle.textContent, "");
  assert.equal(app.elements.topbarContextTitle.title, "JohndeMac-mini.local-6c7308b26d0d");
  assert.equal(app.elements.topbarEnvironmentAvatar.textContent, "J");
  assert.equal(app.elements.topbarEnvironmentAvatar.title, "JohndeMac-mini.local-6c7308b26d0d");
  assert.equal(app.elements.topbarEnvironmentAvatar.hidden, false);
  assert.equal(app.elements.topbarEnvironmentAvatar.dataset.state, "online");
});

test("logged-in workspace helpers ignore legacy unscoped project cache by default", () => {
  const storage = createStorage({
    "echoCodexProject": "alice-mac:echo",
    "echoCodexWorkspaces": JSON.stringify([{ id: "echo", key: "alice-mac:echo", agentId: "alice-mac" }])
  });
  const app = createAuthApp(storage, {
    currentUser: { username: "bob", displayName: "Bob", role: "user" },
    token: "bob-token",
    codexWorkspaces: []
  });
  installCore(app);

  assert.deepEqual(app.readStoredCodexWorkspaces(), []);
  assert.equal(app.storedCodexProjectKey(), "");
});

test("authenticated empty agent status clears stale workspace cache", () => {
  const storage = createStorage({});
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "user" });
  installCodex(app);
  stubCodexStatusSideEffects(app);
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.renderCodexStatus({
      agentOnline: true,
      agents: [{ id: "legacy-agent", ownerUser: "" }],
      workspaces: [{ id: "echo", key: "legacy-agent:echo", label: "Echo", agentId: "legacy-agent" }],
      runtime: {}
    });

    assert.deepEqual(app.state.codexWorkspaces.map((workspace) => workspace.key), ["legacy-agent:echo"]);
    assert.equal(storage.getItem("echoCodexProject:alice"), "legacy-agent:echo");
    assert.notEqual(storage.getItem("echoCodexWorkspaces:alice"), null);

    app.renderCodexStatus({
      agentOnline: false,
      agents: [],
      workspaces: [],
      runtime: {}
    });

    assert.deepEqual(app.state.codexWorkspaces, []);
    assert.equal(app.elements.codexProject.value, "");
    assert.equal(storage.getItem("echoCodexProject:alice"), null);
    assert.equal(storage.getItem("echoCodexWorkspaces:alice"), null);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("multi-agent status filters projects and switches environment explicitly", async () => {
  const storage = createStorage({
    "echoCodexProject:alice": "alice-mac:echo"
  });
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "owner" });
  const quickSkillRequests = [];
  const sessionListRequests = [];
  installCodex(app);
  stubCodexStatusSideEffects(app, { keepProjectPicker: true });
  app.loadQuickSkills = async () => {
    quickSkillRequests.push({ projectId: app.currentProjectId(), targetAgentId: app.currentTargetAgentId() });
  };
  app.loadCodexJobs = async () => {
    sessionListRequests.push({ projectId: app.currentProjectId(), targetAgentId: app.currentTargetAgentId() });
  };
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.renderCodexStatus({
      agentOnline: true,
      agents: [
        {
          id: "alice-mac",
          displayName: "Alice Mac",
          runtime: { backendId: "alice-codex", provider: "codex", backendName: "Alice Codex" }
        },
        {
          id: "bob-pc",
          displayName: "Bob PC",
          runtime: { backendId: "bob-claude", provider: "claude-code", backendName: "Bob Claude" }
        }
      ],
      workspaces: [
        { id: "echo", key: "alice-mac:echo", label: "Echo", path: "/alice/echo", agentId: "alice-mac", agentLabel: "Alice Mac" },
        { id: "metio", key: "alice-mac:metio", label: "Metio", path: "/alice/metio", agentId: "alice-mac", agentLabel: "Alice Mac" },
        { id: "echo", key: "bob-pc:echo", label: "Echo", path: "/bob/echo", agentId: "bob-pc", agentLabel: "Bob PC" }
      ],
      runtime: {}
    });

    assert.equal(app.state.selectedAgentId, "alice-mac");
    assert.equal(app.elements.codexProject.value, "alice-mac:echo");
    assert.equal(app.elements.topbarContextTitle.textContent, "Alice Mac");
    assert.deepEqual(app.elements.codexProject.options.map((option) => option.value), ["alice-mac:echo", "alice-mac:metio"]);
    assert.equal(app.elements.agentEnvironmentList.hidden, false);

    await app.selectAgentEnvironment("bob-pc");

    assert.equal(app.state.selectedAgentId, "bob-pc");
    assert.equal(app.elements.topbarContextTitle.textContent, "Bob PC");
    assert.equal(storage.getItem("echoSelectedAgent:alice"), "bob-pc");
    assert.equal(app.elements.codexProject.value, "bob-pc:echo");
    assert.equal(storage.getItem("echoCodexProject:alice"), "bob-pc:echo");
    assert.deepEqual(app.elements.codexProject.options.map((option) => option.value), ["bob-pc:echo"]);
    assert.deepEqual(app.state.codexBackendRuntimes.map((runtime) => runtime.backendId), ["bob-claude"]);
    assert.deepEqual(quickSkillRequests.at(-1), { projectId: "echo", targetAgentId: "bob-pc" });
    assert.deepEqual(sessionListRequests.at(-1), { projectId: "echo", targetAgentId: "bob-pc" });
  } finally {
    globalThis.document = previousDocument;
  }
});

test("mobile settings page opens from sidebar and returns without changing project selection", () => {
  const storage = createStorage({
    "echoCodexProject:alice": "alice-mac:echo"
  });
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "owner" });
  installCodex(app);
  stubCodexStatusSideEffects(app);
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.renderCodexStatus({
      agentOnline: true,
      agents: [{ id: "alice-mac", displayName: "Alice Mac" }],
      workspaces: [{ id: "echo", key: "alice-mac:echo", label: "Echo", path: "/workspace/echo", agentId: "alice-mac" }],
      runtime: {}
    });

    assert.equal(app.elements.codexProject.value, "alice-mac:echo");
    app.openMobileSettingsPage();
    assert.equal(app.elements.mobileSettingsPanel.hidden, false);
    app.closeMobileSettingsPage({ restoreFocus: true });
    assert.equal(app.elements.mobileSettingsPanel.hidden, true);
    assert.equal(app.elements.codexProject.value, "alice-mac:echo");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("mobile settings entries open their subpages and return to settings", () => {
  const storage = createStorage({
    "echoCodexProject:alice": "alice-mac:echo"
  });
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "owner" });
  installAuth(app);
  installCodex(app);
  installAgentSkills(app);
  installMcp(app);
  stubCodexStatusSideEffects(app);
  app.canUseWorkbench = () => true;
  app.renderMcpPanel = () => {};
  app.renderAgentSkillManagement = () => {};
  app.loadAdmin = () => {};
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.openMobileSettingsPage();
    assert.equal(app.elements.mobileSettingsPanel.hidden, false);

    app.openMcpPanel();
    assert.equal(app.elements.mobileSettingsPanel.hidden, true);
    assert.equal(app.elements.mcpPanel.hidden, false);
    assert.equal(app.elements.mcpPanel.closest().classList.contains("mobile-settings-page-open"), false);
    assert.equal(app.elements.mcpPanel.closest().classList.contains("mcp-page-open"), true);
    app.closeMcpPanel({ returnToSettings: true });
    assert.equal(app.elements.mcpPanel.hidden, true);
    assert.equal(app.elements.mobileSettingsPanel.hidden, false);

    app.openAgentSkillPanel();
    assert.equal(app.elements.mobileSettingsPanel.hidden, true);
    assert.equal(app.elements.agentSkillPanel.hidden, false);
    assert.equal(app.elements.agentSkillPanel.closest().classList.contains("mcp-page-open"), true);
    app.closeAgentSkillPanel({ returnToSettings: true });
    assert.equal(app.elements.agentSkillPanel.hidden, true);
    assert.equal(app.elements.mobileSettingsPanel.hidden, false);

    app.openAdminPanel();
    assert.equal(app.elements.mobileSettingsPanel.hidden, true);
    assert.equal(app.elements.adminPanel.hidden, false);
    assert.equal(app.elements.adminPanel.closest().classList.contains("admin-page-open"), true);
    app.closeAdminPanel({ returnToSettings: true });
    assert.equal(app.elements.adminPanel.hidden, true);
    assert.equal(app.elements.mobileSettingsPanel.hidden, false);

    app.openAccountPanel();
    assert.equal(app.elements.mobileSettingsPanel.hidden, true);
    assert.equal(app.elements.accountPanel.hidden, false);
    assert.equal(app.elements.accountPanel.closest().classList.contains("account-page-open"), true);
    app.closeAccountPanel({ returnToSettings: true });
    assert.equal(app.elements.accountPanel.hidden, true);
    assert.equal(app.elements.mobileSettingsPanel.hidden, false);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("existing project import confirms before opening a plain folder", async () => {
  const storage = createStorage({
    "echoCodexProject:alice": "alice-mac:echo"
  });
  const app = createCodexStatusApp(storage, { username: "alice", displayName: "Alice", role: "owner" });
  installCodex(app);
  stubCodexStatusSideEffects(app);
  const previousDocument = globalThis.document;
  globalThis.document = app.document;

  try {
    app.renderCodexStatus({
      agentOnline: true,
      agents: [{ id: "alice-mac", displayName: "Alice Mac" }],
      workspaces: [{ id: "echo", key: "alice-mac:echo", label: "Echo", path: "/workspace/echo", agentId: "alice-mac" }],
      runtime: {}
    });

    let confirmCalls = 0;
    let registerCalls = 0;
    app.confirm = async (options) => {
      confirmCalls += 1;
      assert.equal(options.title, "打开普通文件夹？");
      return false;
    };
    app.apiPost = async (pathName) => {
      if (pathName === "/api/codex/workspaces/import/register") registerCalls += 1;
      return { command: { id: "cmd_register" } };
    };
    app.waitForWorkspaceCommand = async () => ({
      status: "done",
      result: { workspace: { id: "plain", label: "plain", path: "/workspace/plain" } }
    });
    app.refreshCodex = async () => {};
    app.selectProject = async () => {};
    app.toast = () => {};
    app.handleAuthError = () => false;

    app.state.projectImportTree = {
      root: { label: "workspace" },
      rootId: "root-a",
      path: "plain",
      label: "plain",
      canSelect: true,
      looksLikeProject: false,
      entries: []
    };
    app.state.projectImportRootId = "root-a";
    app.state.projectImportPath = "plain";

    await app.registerProjectImportSelection();
    assert.equal(confirmCalls, 1);
    assert.equal(registerCalls, 0);

    app.confirm = async () => {
      confirmCalls += 1;
      return true;
    };
    await app.registerProjectImportSelection();
    assert.equal(confirmCalls, 2);
    assert.equal(registerCalls, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});

function createCodexStatusApp(storage, currentUser) {
  const elements = createCommonElements();
  const state = {
    currentUser,
    codexWorkspaces: [],
    codexAvailableWorkspaceKeys: [],
    codexAgents: [],
    codexAgentOnline: false,
    codexAgentAvailable: false,
    codexLastAgentSeenAt: "",
    codexConnectionState: "connecting",
    codexStatusUpdatedAt: "",
    codexWorkspacesUpdatedAt: "",
    codexRuntimeUpdatedAt: "",
    codexStatusVersion: "",
    codexAgentRuntime: {},
    codexBackendRuntimes: [],
    installedAgentSkills: [],
    runtimePreferences: {},
    runtimeDirty: false,
    projectImportBusy: false,
    projectImportRootId: "",
    projectImportPath: "",
    projectImportTree: null,
    projectImportError: "",
    selectedCodexJobId: "",
    selectedCodexSession: null,
    composingNewSession: false
  };
  const app = {
    constants: {
      BACKEND_OPTIONS: [],
      MODEL_OPTIONS: [],
      PERMISSION_MODE_OPTIONS: [],
      REASONING_OPTIONS: []
    },
    document: new FakeDocument(),
    elements,
    localStorage: storage,
    state,
    storedCodexProjectKey: () => storage.getItem(`echoCodexProject:${currentUser.username}`) || storage.getItem("echoCodexProject") || "",
    persistCodexProjectKey: (value) => {
      storage.setItem(`echoCodexProject:${currentUser.username}`, value);
      storage.removeItem("echoCodexProject");
    },
    storedSelectedAgentId: () => storage.getItem(`echoSelectedAgent:${currentUser.username}`) || "",
    persistSelectedAgentId: (value) => {
      if (value) storage.setItem(`echoSelectedAgent:${currentUser.username}`, value);
      else storage.removeItem(`echoSelectedAgent:${currentUser.username}`);
    },
    writeScopedStorage: (key, value) => storage.setItem(`${key}:${currentUser.username}`, value),
    removeScopedStorage: (key) => {
      storage.removeItem(`${key}:${currentUser.username}`);
      storage.removeItem(key);
    },
    currentWorkspace() {
      return app.workspaceForSelectionKey(elements.codexProject.value || app.storedCodexProjectKey());
    },
    currentProjectId() {
      return String(app.currentWorkspace()?.id || "");
    },
    currentTargetAgentId() {
      return String(app.currentWorkspace()?.agentId || "");
    },
    codexCommandsAvailable() {
      if (state.codexConnectionState === "error" || !state.codexAgentAvailable) return false;
      const workspace = app.currentWorkspace();
      if (!workspace?.id) return false;
      if (!state.codexAgentOnline) return state.codexWorkspaces.some((item) => item.key === workspace.key);
      return app.workspaceCurrentlyAvailable(workspace);
    },
    workspaceLabel: (workspace) => {
      const label = workspace?.label || workspace?.workspaceId || workspace?.id || workspace?.path || "未命名项目";
      return workspace?.agentLabel ? `${label} · ${workspace.agentLabel}` : label;
    },
    workspaceMeta: (workspace) => workspace?.path || workspace?.id || "桌面端已同步",
    workspaceSecondaryLabel: (workspace) => workspace?.agentLabel || workspace?.id || "",
    workspacePathLabel: (workspace) => workspace?.path || "",
    workspaceDirectoryName: (workspace) => {
      const pathLabel = String(workspace?.path || "").trim().replace(/[/\\]+$/g, "");
      return pathLabel.split(/[/\\]/).filter(Boolean).pop() || workspace?.label || workspace?.id || "未命名工程";
    },
    escapeHtml: (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;"),
    setTopbarStatus() {},
    resolveRuntimeBackendChoice: (runtime) => runtime || {},
    refreshSelectedBackendRuntime() {},
    currentRuntimeDraft: () => ({}),
    runtimeChoiceWithFallback: (runtime) => runtime || {},
    applyRuntimeDraft() {},
    refreshRuntimeDefaultOptions() {},
    refreshWorktreeModeControls() {},
    updateMcpSnapshot() {},
    installedAgentSkillsForRuntime: () => [],
    closeCodexSessionStream() {},
    updateComposerAvailability() {},
    syncComposerMetrics() {},
    refreshActiveSessionHeader() {},
    refreshTopbarProjectChip() {
      const workspace = app.currentWorkspace();
      const agent = app.agentById?.(state.selectedAgentId) || app.agentById?.(workspace?.agentId) || null;
      const title = app.agentDisplayName?.(agent) || workspace?.agentLabel || app.workspaceDirectoryName(workspace) || "等待桌面";
      elements.topbarContextTitle.textContent = title;
    },
    updateProjectCreateControls() {}
  };
  return app;
}

function stubCodexStatusSideEffects(app, options = {}) {
  if (!options.keepProjectPicker) app.renderProjectPicker = () => {};
  app.renderAgentSkills = () => {};
  app.updateComposerAvailability = () => {};
  app.syncComposerMetrics = () => {};
}

function createAuthApp(storage, overrides = {}) {
  return {
    constants: {
      BACKEND_OPTIONS: [],
      MODEL_OPTIONS: [],
      PERMISSION_MODE_OPTIONS: [],
      REASONING_OPTIONS: []
    },
    document: new FakeDocument(),
    elements: createCommonElements(),
    localStorage: storage,
    state: {
      currentUser: overrides.currentUser || null,
      token: overrides.token || "",
      sessionToken: overrides.sessionToken || "",
      authEnabled: overrides.authEnabled !== undefined ? overrides.authEnabled : true,
      codexWorkspaces: overrides.codexWorkspaces || [],
      codexAvailableWorkspaceKeys: [],
      codexAgents: [],
      codexAgentOnline: false,
      codexAgentAvailable: false,
      codexLastAgentSeenAt: "",
      codexConnectionState: "connecting",
      codexStatusUpdatedAt: "",
      codexWorkspacesUpdatedAt: "",
      codexRuntimeUpdatedAt: "",
      codexStatusVersion: "",
      selectedCodexJobId: "",
      selectedCodexSession: null,
      composingNewSession: false
    },
    window: {
      addEventListener() {},
      clearTimeout() {},
      requestAnimationFrame(callback) {
        return callback();
      },
      setTimeout(callback) {
        return callback();
      },
      matchMedia() {
        return { matches: false, addEventListener() {}, removeEventListener() {} };
      },
      visualViewport: null
    },
    closeCodexSessionStream() {},
    stopCodexPolling() {},
    stopPairingScanner() {},
    closeSessionSidebar() {},
    closeQuickSkillsPanel() {},
    closeAgentSkillsPanel() {},
    updateAuthView() {},
    renderUserCenter() {}
  };
}

function createCommonElements() {
  const sidebar = new FakeElement();
  return {
    codexProject: new FakeSelect(),
    codexStatusText: new FakeElement(),
    codexQueueMeta: new FakeElement(),
    projectPickerLabel: new FakeElement(),
    projectPickerMeta: new FakeElement(),
    projectSheetStatus: new FakeElement(),
    projectSheetList: new FakeElement(),
    mobileSettingsButton: new FakeElement({ sidebar }),
    mobileSettingsPanel: new FakeElement({ sidebar }),
    mobileSettingsCloseButton: new FakeElement(),
    mobileSettingsMeta: new FakeElement(),
    mcpButton: new FakeElement({ sidebar }),
    mcpPanel: new FakeElement({ sidebar }),
    mcpCloseButton: new FakeElement(),
    mcpProfileList: new FakeElement(),
    mcpMeta: new FakeElement(),
    mcpStatus: new FakeElement(),
    mcpApplyButton: new FakeElement(),
    agentSkillButton: new FakeElement({ sidebar }),
    agentSkillPanel: new FakeElement({ sidebar }),
    agentSkillCloseButton: new FakeElement(),
    agentSkillRefreshButton: new FakeElement(),
    agentSkillMeta: new FakeElement(),
    agentSkillPreferenceSubtitle: new FakeElement(),
    agentSkillOverview: new FakeElement(),
    agentSkillList: new FakeElement(),
    agentSkillDetail: new FakeElement(),
    agentSkillTargetList: new FakeElement(),
    agentSkillStatus: new FakeElement(),
    accountButton: new FakeElement({ sidebar }),
    accountPanel: new FakeElement({ sidebar }),
    accountCloseButton: new FakeElement(),
    accountPreferenceSubtitle: new FakeElement(),
    projectImportPanel: new FakeElement({ sidebar }),
    projectImportCloseButton: new FakeElement(),
    projectImportRefreshButton: new FakeElement(),
    projectImportMeta: new FakeElement(),
    projectImportRoots: new FakeElement(),
    projectImportBreadcrumbs: new FakeElement(),
    projectImportList: new FakeElement(),
    projectImportStatus: new FakeElement(),
    projectImportSelectButton: new FakeElement(),
    agentEnvironmentList: new FakeElement(),
    codexJobs: new FakeElement(),
    codexView: new FakeElement(),
    codexPrompt: new FakeElement(),
    sendCodexButton: new FakeElement(),
    newCodexSessionButton: new FakeElement(),
    codexPermissionMode: new FakeSelect(),
    codexModel: new FakeSelect(),
    codexReasoningEffort: new FakeSelect(),
    codexBackend: new FakeSelect(),
    composerAttachmentButton: new FakeElement(),
    composerPlanModeButton: new FakeElement(),
    agentSkillsButton: new FakeElement(),
    openExistingProjectButton: new FakeElement(),
    worktreeModeToggle: new FakeElement(),
    worktreeModeSubtitle: new FakeElement(),
    loginPanel: new FakeElement(),
    pairingPanel: new FakeElement(),
    openPairingButton: new FakeElement(),
    refreshStatus: new FakeElement(),
    userBadge: new FakeElement(),
    logoutButton: new FakeElement(),
    authenticated: [],
    adminButton: new FakeElement({ sidebar }),
    adminPanel: new FakeElement({ sidebar }),
    adminCloseButton: new FakeElement(),
    adminStatus: new FakeElement(),
    adminMeta: new FakeElement(),
    adminPreferenceSubtitle: new FakeElement(),
    loginStatus: new FakeElement(),
    pairingStatus: new FakeElement(),
    sidebarUserMeta: new FakeElement(),
    pairingVideo: new FakeElement(),
    scanPairingButton: new FakeElement(),
    stopScanButton: new FakeElement(),
    topbarContextTitle: new FakeElement(),
    topbarEnvironmentAvatar: new FakeElement()
  };
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.body = new FakeElement();
    this.documentElement = { style: { setProperty() {} } };
  }

  createElement(tagName) {
    return tagName === "option" ? new FakeOption() : new FakeElement();
  }
}

class FakeSelect {
  constructor() {
    this.options = [];
    this._value = "";
    this.disabled = false;
  }

  set innerHTML(_value) {
    this.options = [];
    this._value = "";
  }

  get value() {
    return this.options.some((option) => option.value === this._value) ? this._value : "";
  }

  set value(value) {
    const next = String(value || "");
    this._value = this.options.some((option) => option.value === next) ? next : "";
  }

  append(node) {
    this.options.push(node);
    if (node.selected) this._value = node.value;
  }
}

class FakeOption {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.title = "";
    this.selected = false;
  }
}

class FakeElement {
  constructor(options = {}) {
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this._innerHTML = "";
    this._listeners = new Map();
    this._sidebar = options.sidebar || null;
    this._classes = new Set();
    this.style = {};
    this.textContent = "";
    this.value = "";
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (shouldAdd) this._classes.add(name);
        else this._classes.delete(name);
        return shouldAdd;
      }
    };
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    const buttonPattern = /<button\b[^>]*\bdata-agent-id="([^"]*)"[^>]*>/g;
    for (const match of this._innerHTML.matchAll(buttonPattern)) {
      const button = new FakeElement();
      button.dataset.agentId = match[1];
      this.children.push(button);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  contains(node) {
    return this.children.includes(node);
  }

  closest() {
    return this._sidebar || this;
  }

  remove() {}

  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) || [];
    listeners.push(listener);
    this._listeners.set(type, listeners);
  }

  querySelectorAll(selector) {
    if (selector === "[data-agent-id]") return this.children.filter((child) => child.dataset?.agentId);
    return [];
  }

  setAttribute() {}

  focus() {}
}
