import assert from "node:assert/strict";
import test from "node:test";
import { createAppContext, installCore } from "../public/app/core.js";
import { installMcp } from "../public/app/mcp.js";

test("mobile model selector scopes models to the selected backend", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexBackendRuntimes = [
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      model: "gpt-5.5",
      supportedModels: [
        { id: "gpt-5.5", displayName: "GPT-5.5" },
        { id: "gpt-5.4", displayName: "GPT-5.4" }
      ],
      allowedPermissionModes: ["strict", "approve", "full"],
      worktreeMode: "off"
    },
    {
      backendId: "claude-code",
      provider: "deepseek-via-claude",
      backendName: "Claude Code",
      model: "deepseek-v4-pro[1m]",
      supportedModels: [
        { id: "deepseek-v4-pro[1m]", displayName: "DeepSeek-V4-Pro[1M]" },
        { id: "deepseek-v4-flash", displayName: "DeepSeek-V4-Flash" }
      ],
      allowedPermissionModes: ["strict"],
      worktreeMode: "off"
    }
  ];

  app.initRuntimeControls();
  app.applyRuntimeDraft({ backendId: "codex", model: "gpt-5.4" }, { dirty: false });

  assertSameOptionValues(app.elements.codexModel, ["", "gpt-5.5", "gpt-5.4"]);
  assert.equal(app.elements.codexModel.value, "gpt-5.4");
  assert.equal(optionByValue(app.elements.codexModel, "gpt-5.5").textContent, "GPT-5.5");
  assert.equal(optionByValue(app.elements.codexModel, "gpt-5.4").textContent, "GPT-5.4");

  app.elements.codexBackend.value = "claude-code";
  app.handleRuntimeControlChange();

  assertSameOptionValues(app.elements.codexModel, ["", "deepseek-v4-pro[1m]", "deepseek-v4-flash"]);
  assert.equal(app.elements.codexBackend.value, "claude-code");
  assert.equal(app.elements.codexModel.value, "");
  assert.equal(app.state.runtimePreferences.backendId, "claude-code");
  assert.equal(app.state.runtimePreferences.model, "");

  app.elements.codexModel.value = "deepseek-v4-pro[1m]";
  app.handleRuntimeControlChange();

  assert.equal(app.elements.codexBackend.value, "claude-code");
  assert.equal(app.elements.codexModel.value, "deepseek-v4-pro[1m]");
  assert.equal(app.state.runtimePreferences.backendId, "claude-code");
  assert.equal(app.state.runtimePreferences.model, "deepseek-v4-pro[1m]");
});

test("runtime backend resolution keeps the preferred backend for shared models", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexBackendRuntimes = [
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      supportedModels: [{ id: "shared-model", displayName: "Shared Model" }]
    },
    {
      backendId: "claude-code",
      provider: "claude-code",
      backendName: "Claude Code",
      supportedModels: [{ id: "shared-model", displayName: "Shared Model" }]
    }
  ];

  assert.equal(app.resolveRuntimeBackendChoice({ backendId: "claude-code", model: "shared-model" }).backendId, "claude-code");
  assert.equal(app.resolveRuntimeBackendChoice({ backendId: "codex", model: "shared-model" }).backendId, "codex");
});

test("runtime backend resolution ignores stale agent runtime after environment switches", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexAgentRuntime = { backendId: "alice-codex", provider: "codex", backendName: "Alice Codex" };
  app.state.runtimePreferences = { backendId: "alice-codex", model: "", permissionMode: "", reasoningEffort: "", worktreeMode: "off" };
  app.state.codexBackendRuntimes = [{ backendId: "bob-claude", provider: "claude-code", backendName: "Bob Claude" }];

  assert.equal(app.resolveRuntimeBackendChoice(app.state.runtimePreferences).backendId, "bob-claude");
});

test("default Codex model selector does not show Claude catalog fallbacks", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexBackendRuntimes = [
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex"
    },
    {
      backendId: "claude-code",
      provider: "deepseek-via-claude",
      backendName: "Claude Code",
      supportedModels: [{ id: "deepseek-v4-flash", displayName: "DeepSeek-V4-Flash" }]
    }
  ];

  app.initRuntimeControls();
  app.applyRuntimeDraft({ backendId: "codex" }, { persist: false, dirty: false });
  app.elements.codexBackend.value = "";
  app.state.codexAgentRuntime = { backendId: "codex", provider: "codex", backendName: "Codex" };
  app.state.codexSupportedModels = [
    { id: "gpt-5.5", displayName: "GPT-5.5" },
    { id: "deepseek-v4-flash", displayName: "DeepSeek-V4-Flash" }
  ];
  app.refreshModelOptionAvailability();

  assertSameOptionValues(app.elements.codexModel, ["", "gpt-5.5"]);
  assert.equal(optionByValue(app.elements.codexModel, "deepseek-v4-flash"), undefined);
});

test("mobile model selector disables a model only when no backend can serve it", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexBackendRuntimes = [
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      supportedModels: [{ id: "gpt-5.4", displayName: "GPT-5.4" }],
      unsupportedModels: ["gpt-5.5"]
    },
    {
      backendId: "claude-code",
      provider: "claude-code",
      backendName: "Claude Code",
      supportedModels: [{ id: "gpt-5.5", displayName: "GPT-5.5 via Claude" }]
    }
  ];

  app.initRuntimeControls();
  app.applyRuntimeDraft({ backendId: "codex" }, { persist: false, dirty: false });
  assert.equal(optionByValue(app.elements.codexModel, "gpt-5.5"), undefined);

  const singleBackendApp = createRuntimeControlApp();
  installCore(singleBackendApp);
  singleBackendApp.state.codexBackendRuntimes = [
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      unsupportedModels: ["gpt-5.5"]
    }
  ];

  singleBackendApp.initRuntimeControls();
  singleBackendApp.applyRuntimeDraft({ backendId: "codex", model: "gpt-5.5" }, { persist: false, dirty: false });
  assert.equal(optionByValue(singleBackendApp.elements.codexModel, "gpt-5.5").disabled, true);
  assert.equal(singleBackendApp.elements.codexModel.value, "");
});

test("runtime model popover widens for long model names and stays within the viewport", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.populateRuntimeSelect(app.elements.codexModel, [
    { value: "", label: "桌面默认" },
    { value: "deepseek-v4-pro-reasoner-128k", label: "DeepSeek-V4-Pro-Reasoner-128K" }
  ]);

  const width = app.runtimeSelectPopoverWidth(app.elements.codexModel, { width: 82 }, 390, 8);
  assert.ok(width > 82);
  assert.ok(width >= 224);
  assert.ok(width <= 292);

  assert.equal(app.runtimeSelectPopoverWidth(app.elements.codexModel, { width: 82 }, 180, 8), 164);
});

test("backend popover omits the duplicate default backend row", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.populateRuntimeSelect(app.elements.codexBackend, [
    { value: "", label: "Codex" },
    { value: "codex", label: "Codex" },
    { value: "volcengine-coding-plan", label: "Claude · Volcengine Coding Plan" }
  ]);
  app.populateRuntimeSelect(app.elements.codexModel, [
    { value: "", label: "桌面默认" },
    { value: "ark-code-latest", label: "Ark Code Latest" }
  ]);

  assert.deepEqual(
    app.runtimeSelectOptionsForPopover(app.elements.codexBackend).map((option) => option.value),
    ["codex", "volcengine-coding-plan"]
  );
  assert.deepEqual(
    app.runtimeSelectOptionsForPopover(app.elements.codexModel).map((option) => option.value),
    ["", "ark-code-latest"]
  );
});

test("runtime default rows show effective desktop values without duplicate options", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexBackendRuntimes = [
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      permissionMode: "full",
      supportedModels: [
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
        }
      ],
      allowedPermissionModes: ["strict", "approve", "full"],
      worktreeMode: "off"
    }
  ];

  app.initRuntimeControls();
  app.applyRuntimeDraft({ backendId: "codex" }, { persist: false, dirty: false });

  assert.equal(optionByValue(app.elements.codexModel, "").textContent, "GPT-5.6 Sol");
  assert.equal(optionByValue(app.elements.codexPermissionMode, "").textContent, "全权限");
  assert.equal(optionByValue(app.elements.codexReasoningEffort, "").textContent, "最大");
  assert.deepEqual(app.runtimeSelectOptionsForPopover(app.elements.codexModel).map((option) => option.value), [""]);
  assert.equal(app.runtimeSelectOptionsForPopover(app.elements.codexPermissionMode).some((option) => option.value === "full"), false);
  assert.equal(app.runtimeSelectOptionsForPopover(app.elements.codexReasoningEffort).some((option) => option.value === "max"), false);
});

test("reasoning selector only shows efforts advertised by the selected model", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexBackendRuntimes = [
    {
      backendId: "codex",
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      supportedModels: [
        {
          id: "gpt-5.6-sol",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
          defaultReasoningEffort: "max"
        },
        {
          id: "gpt-5.5",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
          defaultReasoningEffort: "medium"
        }
      ]
    }
  ];

  app.initRuntimeControls();
  app.applyRuntimeDraft({ backendId: "codex", model: "gpt-5.6-sol" }, { persist: false, dirty: false });
  assert.equal(optionByValue(app.elements.codexReasoningEffort, "max")?.textContent, "最大");

  app.applyRuntimeDraft({ backendId: "codex", model: "gpt-5.5", reasoningEffort: "max" }, { persist: false, dirty: false });
  assert.equal(optionByValue(app.elements.codexReasoningEffort, "max"), undefined);
  assert.equal(app.elements.codexReasoningEffort.value, "");
  assert.equal(optionByValue(app.elements.codexReasoningEffort, "").textContent, "中");
});

test("optional worktree mode is not enabled by default on mobile", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexAgentRuntime = { worktreeMode: "optional" };
  app.state.worktreePreferenceEnabled = false;

  app.refreshWorktreeModeControls();

  assert.equal(app.elements.worktreeModeToggle.checked, false);
  assert.equal(app.elements.worktreeModeToggle.disabled, false);
  assert.equal(app.elements.worktreeModeSubtitle.textContent, "只读任务用主工作区；修改任务建议开启");
  assert.equal(app.requestedWorktreeMode(), "off");

  app.applyWorktreeModePreference(true, { persist: false });
  assert.equal(app.elements.worktreeModeToggle.checked, true);
  assert.equal(app.elements.worktreeModeSubtitle.textContent, "修改任务建议隔离；只读任务可关闭");
  assert.equal(app.requestedWorktreeMode(), "always");
});

test("workspace worktree capability can disable the mobile opt-in", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.currentProjectId = () => "demo";
  app.state.codexAgentRuntime = {
    worktreeMode: "optional",
    capabilities: { worktreeByWorkspace: { demo: { availability: "unavailable" } } }
  };

  app.refreshWorktreeModeControls();

  assert.equal(app.elements.worktreeModeToggle.checked, false);
  assert.equal(app.elements.worktreeModeToggle.disabled, true);
  assert.equal(app.elements.worktreeModeSubtitle.textContent, "桌面端未启用");
});

test("stored worktree preference must be explicitly true", () => {
  const empty = createAppContext(createContextWindow(createMemoryStorage()), createContextDocument());
  assert.equal(empty.state.worktreePreferenceEnabled, false);

  const disabled = createAppContext(createContextWindow(createMemoryStorage({ echoCodexWorktreeEnabled: "false" })), createContextDocument());
  assert.equal(disabled.state.worktreePreferenceEnabled, false);

  const enabled = createAppContext(createContextWindow(createMemoryStorage({ echoCodexWorktreeEnabled: "true" })), createContextDocument());
  assert.equal(enabled.state.worktreePreferenceEnabled, true);
});

test("runtime select option clicks stay inside the floating popover", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  const select = new FakeSelect("testRuntimeSelect");
  select.append(createOption("project", "当前项目"));
  select.append(createOption("global", "全局"));
  select.value = "project";
  const button = new FakeButton();
  const panel = { hidden: false };
  const option = new FakeRuntimeOption("global");
  let stopped = false;

  app.state.runtimeSelectPopover = { select, button, panel };

  const previousElement = globalThis.Element;
  globalThis.Element = FakeRuntimeElement;
  try {
    app.handleRuntimeSelectOptionClick({
      target: option,
      stopPropagation() {
        stopped = true;
      }
    });
  } finally {
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
  }

  assert.equal(stopped, true);
  assert.equal(select.value, "global");
  assert.equal(select.dispatchedEvents.length, 1);
  assert.equal(panel.hidden, true);
  assert.equal(button.attributes.get("aria-expanded"), "false");
  assert.equal(button.focused, true);
  assert.equal(app.state.runtimeSelectPopover, null);
});

test("MCP update snapshot marks the mobile entry and active server", () => {
  const app = createMcpControlApp();
  installMcp(app);

  app.updateMcpSnapshot({
    activeProfileId: "memory",
    defaultProfileId: "memory",
    hasUpdates: true,
    profiles: [{ id: "memory", label: "Memory", serverIds: ["memory"] }],
    servers: [{ id: "memory", label: "Memory", hasUpdates: true }],
    clients: [{ id: "codex", label: "Codex" }],
    targetClients: ["codex"],
    lastApplyResult: { ok: true, profileId: "memory" }
  });

  assert.equal(app.state.mcpSnapshot.hasUpdates, true);
  assert.equal(app.elements.mcpButton.classList.contains("has-mcp-updates"), true);
  assert.equal(app.elements.mcpPreferenceSubtitle.textContent, "有更新");
  assert.equal(app.mcpServerCards()[0].state, "update");
});

test("MCP active card click toggles a compact pending-disable state", () => {
  const app = createMcpControlApp();
  installMcp(app);

  app.updateMcpSnapshot({
    activeProfileId: "memory",
    defaultProfileId: "memory",
    profiles: [
      { id: "off", label: "关闭 MCP", serverIds: [] },
      { id: "memory", label: "Memory", serverIds: ["memory"] }
    ],
    servers: [{ id: "memory", label: "Memory" }],
    clients: [{ id: "codex", label: "Codex" }],
    targetClients: ["codex"]
  });

  assert.equal(app.mcpServerCards()[0].state, "active");

  app.selectMcpServer("memory");

  assert.equal(app.state.mcpSelectedProfileId, "off");
  assert.equal(app.mcpActionProfileId(), "off");
  assert.equal(app.mcpServerCards()[0].state, "disconnect");

  app.selectMcpServer("memory");

  assert.equal(app.state.mcpSelectedProfileId, "memory");
  assert.equal(app.mcpServerCards()[0].state, "active");
});

test("mobile runtime controls keep permissions phone-owned when desktop allowed list is narrow", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexBackendRuntimes = [
    {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      permissionMode: "strict",
      allowedPermissionModes: ["strict", "approve", "full"],
      worktreeMode: "off"
    },
    {
      backendId: "claude-code",
      provider: "claude-code",
      backendName: "Claude Code",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      permissionMode: "strict",
      allowedPermissionModes: ["strict"],
      worktreeMode: "off"
    },
    {
      backendId: "deepseek-code",
      provider: "deepseek-via-claude",
      backendName: "DeepSeek Code",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      permissionMode: "approve",
      allowedPermissionModes: ["strict", "approve"],
      worktreeMode: "off"
    }
  ];

  app.initRuntimeControls();
  app.applyRuntimeDraft({ backendId: "codex", permissionMode: "strict" }, { persist: false, dirty: false });
  assert.equal(app.currentBackendRunsPlanOnly(), false);
  assert.equal(app.permissionModeDisplayName("strict", app.currentBackendRuntime()), "严格");

  app.applyRuntimeDraft({ backendId: "claude-code" }, { persist: false, dirty: false });
  assert.equal(app.currentBackendRunsPlanOnly(), true);
  assert.equal(app.permissionModeDisplayName("strict", app.currentBackendRuntime()), "计划");

  app.applyRuntimeDraft({ backendId: "claude-code", permissionMode: "full" }, { persist: false, dirty: false });
  assert.equal(app.elements.codexPermissionMode.value, "full");
  assert.equal(app.permissionModeUnavailable("full"), false);
  assert.equal(app.currentBackendRunsPlanOnly(), false);

  app.applyRuntimeDraft({ backendId: "deepseek-code", permissionMode: "approve" }, { persist: false, dirty: false });
  assert.equal(app.currentBackendRunsPlanOnly(), false);
});

test("mobile loads Relay runtime preferences per Workspace and resolves concurrent saves", async () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.currentUser = { username: "alice" };
  app.storageUserKey = () => "alice";
  app.state.codexAgentRuntime = {
    backendId: "codex",
    provider: "codex",
    worktreeMode: "optional",
    supportedModels: [{ id: "gpt-5.5", supportedReasoningEfforts: ["high"] }]
  };
  app.state.codexBackendRuntimes = [app.state.codexAgentRuntime];
  app.initRuntimeControls();
  let workspace = { id: "alpha", agentId: "desktop-a" };
  app.currentWorkspace = () => workspace;
  app.currentProjectId = () => workspace.id;
  app.currentTargetAgentId = () => workspace.agentId;
  const records = {
    alpha: { backendId: "codex", model: "gpt-5.5", reasoningEffort: "high", permissionMode: "full", worktreeMode: "always", version: 3 },
    beta: { backendId: "codex", model: "", reasoningEffort: "", permissionMode: "strict", worktreeMode: "off", version: 1 }
  };
  app.apiGet = async (pathName) => ({ preference: pathName.includes("workspaceId=alpha") ? records.alpha : records.beta });
  app.apiPost = async () => {
    throw new Error("unexpected create");
  };

  await app.loadWorkspaceRuntimePreference();
  assert.equal(app.state.runtimePreferences.permissionMode, "full");
  assert.equal(app.state.runtimePreferenceVersion, 3);

  workspace = { id: "beta", agentId: "desktop-a" };
  await app.loadWorkspaceRuntimePreference({ force: true });
  assert.equal(app.state.runtimePreferences.permissionMode, "strict");
  assert.equal(app.state.runtimePreferenceVersion, 1);

  let writes = 0;
  app.apiPost = async (_pathName, body) => {
    writes += 1;
    if (writes === 1) {
      const error = new Error("conflict");
      error.status = 409;
      error.data = { preference: { ...records.beta, version: 2 } };
      throw error;
    }
    return { preference: { ...body.preference, version: 3 } };
  };
  await app.queueWorkspaceRuntimePreferenceSave({ ...records.beta, permissionMode: "approve" });
  assert.equal(writes, 2);
  assert.equal(app.state.runtimePreferences.permissionMode, "approve");
  assert.equal(app.state.runtimePreferenceVersion, 3);
});

test("mobile migrates legacy runtime storage once without overwriting an existing Relay record", async () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.currentUser = { username: "alice" };
  app.storageUserKey = () => "alice";
  app.state.codexAgentRuntime = { backendId: "codex", provider: "codex", worktreeMode: "optional" };
  app.state.codexBackendRuntimes = [app.state.codexAgentRuntime];
  app.initRuntimeControls();
  app.currentWorkspace = () => ({ id: "alpha", agentId: "desktop-a" });
  app.currentProjectId = () => "alpha";
  app.currentTargetAgentId = () => "desktop-a";
  app.state.runtimeMigrationCandidate = {
    backendId: "codex",
    permissionMode: "full",
    model: "",
    reasoningEffort: "",
    worktreeMode: "always"
  };
  app.localStorage.setItem("echoCodexPermissionMode", "full");
  app.localStorage.setItem("echoCodexWorktreeEnabled", "true");
  app.apiGet = async () => ({ preference: null });
  let migrationBody = null;
  app.apiPost = async (_pathName, body) => {
    migrationBody = body;
    return { preference: { ...body.migrationCandidate, version: 1 }, migrated: true };
  };

  await app.loadWorkspaceRuntimePreference();
  assert.equal(migrationBody.migration, true);
  assert.equal(migrationBody.migrationCandidate.permissionMode, "full");
  assert.equal(app.localStorage.getItem("echoCodexPermissionMode"), null);
  assert.equal(app.localStorage.getItem("echoCodexWorktreeEnabled"), null);
  assert.equal(app.state.runtimePreferences.permissionMode, "full");
});

test("mobile creates a new Workspace preference with full access by default", async () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.currentUser = { username: "alice" };
  app.storageUserKey = () => "alice";
  app.state.codexAgentRuntime = { backendId: "codex", provider: "codex", worktreeMode: "optional" };
  app.state.codexBackendRuntimes = [app.state.codexAgentRuntime];
  app.initRuntimeControls();
  app.currentWorkspace = () => ({ id: "new-workspace", agentId: "desktop-a" });
  app.currentProjectId = () => "new-workspace";
  app.currentTargetAgentId = () => "desktop-a";
  app.apiGet = async () => ({ preference: null });
  let createBody = null;
  app.apiPost = async (_pathName, body) => {
    createBody = body;
    return { preference: { ...body.preference, version: 1 } };
  };

  await app.loadWorkspaceRuntimePreference();
  assert.equal(createBody.preference.permissionMode, "full");
  assert.equal(app.state.runtimePreferences.permissionMode, "full");
});

function createRuntimeControlApp() {
  const storage = new Map();
  const elements = {
    codexBackend: new FakeSelect("codexBackend"),
    codexPermissionMode: new FakeSelect("codexPermissionMode"),
    codexModel: new FakeSelect("codexModel"),
    codexReasoningEffort: new FakeSelect("codexReasoningEffort"),
    worktreeModeToggle: {
      checked: false,
      disabled: false,
      setAttribute() {}
    },
    worktreeModeSubtitle: { textContent: "" }
  };

  return {
    constants: {
      BACKEND_OPTIONS: [{ value: "", label: "桌面默认" }],
      MODEL_OPTIONS: [
        { value: "", label: "桌面默认" },
        { value: "gpt-5.5", label: "GPT-5.5" },
        { value: "gpt-5.4", label: "GPT-5.4" },
        { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" }
      ],
      PERMISSION_MODE_OPTIONS: [
        { value: "", label: "默认" },
        { value: "strict", label: "严格" },
        { value: "approve", label: "批准" },
        { value: "full", label: "全权限" }
      ],
      REASONING_OPTIONS: [
        { value: "", label: "桌面默认" },
        { value: "low", label: "低" },
        { value: "medium", label: "中" },
        { value: "high", label: "高" },
        { value: "xhigh", label: "极高" },
        { value: "max", label: "最大" }
      ]
    },
    document: {
      activeElement: null,
      body: { classList: { toggle() {}, contains: () => false } },
      createElement: () => new FakeOption(),
      documentElement: { style: { setProperty() {} } }
    },
    elements,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    state: {
      codexAgentRuntime: {},
      codexBackendRuntimes: [],
      codexUnsupportedModels: [],
      codexSupportedModels: [],
      codexAllowedPermissionModes: [],
      runtimePreferences: {
        backendId: "",
        permissionMode: "",
        model: "",
        reasoningEffort: "",
        worktreeMode: "off"
      },
      runtimeDirty: false,
      worktreePreferenceEnabled: false
    },
    window: {},
    refreshActiveSessionHeader() {},
    refreshComposerMeta() {},
    toast() {}
  };
}

function createMcpControlApp() {
  const storage = new Map();
  const elements = {
    codexMcpProfile: new FakeSelect("codexMcpProfile"),
    mcpButton: new FakeButton(),
    mcpPanel: null,
    mcpProfileList: null,
    mcpPreferenceSubtitle: { textContent: "" }
  };
  return {
    document: {
      createElement: () => new FakeOption()
    },
    elements,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    state: {
      runtimePreferences: {},
      mcpTargetClients: [],
      mcpSelectedProfileId: "",
      mcpSelectedServerId: "",
      mcpAddOpen: false
    },
    populateRuntimeSelect(select, options) {
      select.innerHTML = "";
      for (const option of options) {
        const node = new FakeOption();
        node.value = option.value;
        node.textContent = option.label;
        node.dataset.baseLabel = option.label;
        select.append(node);
      }
    },
    selectHasEnabledOption(select, value) {
      return Boolean(Array.from(select.options || []).find((option) => option.value === value && !option.disabled));
    },
    refreshRuntimeSelectControls() {},
    syncRuntimeSelectControl() {}
  };
}

function createMemoryStorage(initial = {}) {
  const storage = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  return {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  };
}

function createContextWindow(localStorage) {
  return {
    location: { search: "", pathname: "/" },
    history: { replaceState() {} },
    localStorage,
    navigator: {},
    crypto: {}
  };
}

function createContextDocument() {
  return {
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function optionValues(select) {
  return Array.from(select.options).map((option) => option.value);
}

function optionByValue(select, value) {
  return Array.from(select.options).find((option) => option.value === value);
}

function assertSameOptionValues(select, expected) {
  assert.deepEqual(optionValues(select).sort(), [...expected].sort());
}

class FakeSelect {
  constructor(id = "") {
    this.id = id;
    this.options = [];
    this._value = "";
    this.disabled = false;
    this.dispatchedEvents = [];
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
  }

  dispatchEvent(event) {
    this.dispatchedEvents.push(event);
  }

  querySelector(selector) {
    const match = /^option\[value="(.*)"\]$/.exec(selector);
    if (!match) return null;
    return this.options.find((option) => option.value === match[1]) || null;
  }
}

class FakeOption {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.dataset = {};
    this.disabled = false;
  }
}

function createOption(value, label) {
  const option = new FakeOption();
  option.value = value;
  option.textContent = label;
  return option;
}

class FakeButton {
  constructor() {
    this.title = "";
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.focused = false;
  }

  setAttribute(key, value) {
    this.attributes.set(key, String(value));
  }

  focus() {
    this.focused = true;
  }
}

class FakeRuntimeElement {}

class FakeRuntimeOption extends FakeRuntimeElement {
  constructor(value) {
    super();
    this.dataset = { value };
    this.disabled = false;
  }

  closest(selector) {
    return selector === ".runtime-select-option" ? this : null;
  }
}

class FakeClassList {
  constructor() {
    this.items = new Set();
  }

  toggle(name, force) {
    if (force) this.items.add(name);
    else this.items.delete(name);
  }

  contains(name) {
    return this.items.has(name);
  }
}
