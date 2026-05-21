import assert from "node:assert/strict";
import test from "node:test";
import { installCore } from "../public/app/core.js";

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

test("mobile runtime controls keep permissions phone-owned when desktop allowed list is narrow", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexBackendRuntimes = [
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

test("mobile runtime draft marks worktree choice as explicit", () => {
  const app = createRuntimeControlApp();
  installCore(app);
  app.state.codexAgentRuntime = { backendId: "codex", provider: "codex", backendName: "Codex", worktreeMode: "optional" };
  app.state.codexBackendRuntimes = [app.state.codexAgentRuntime];
  app.state.worktreePreferenceEnabled = false;

  app.initRuntimeControls();
  const disabledDraft = app.currentRuntimeDraft();
  assert.equal(disabledDraft.worktreeMode, "off");
  assert.equal(disabledDraft.worktreeModeExplicit, true);

  app.applyWorktreeModePreference(true, { persist: false });
  const enabledDraft = app.currentRuntimeDraft();
  assert.equal(enabledDraft.worktreeMode, "always");
  assert.equal(enabledDraft.worktreeModeExplicit, true);
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
        { value: "xhigh", label: "极高" }
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
