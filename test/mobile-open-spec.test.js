import assert from "node:assert/strict";
import test from "node:test";
import { installOpenSpec } from "../public/app/open-spec.js";

test("mobile Open Spec shows the button and renders a change timeline", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);

  await app.loadOpenSpecSummary();

  assert.equal(app.apiCalls, 1);
  assert.equal(app.elements.openSpec.hidden, false);
  assert.equal(app.elements.openSpecButton.disabled, false);
  assert.equal(app.elements.openSpecStatus.textContent, "1/2 tasks · 2 changes · 1 archived · 1 specs");
  assert.equal(app.elements.openSpecOverview.children.length, 4);
  assert.equal(app.elements.openSpecTimeline.children.length, 2);
  assert.match(app.elements.openSpecTimeline.children[0].className, /open-spec-change-in-progress/);
  assert.match(app.elements.openSpecTimeline.children[1].className, /open-spec-change-archived/);
  assert.equal(app.elements.openSpecTimeline.children[0].querySelector(".open-spec-task-groups").children.length, 1);
  assert.equal(app.elements.openSpecTimeline.children[0].querySelector(".open-spec-node"), null);
  assert.notEqual(app.elements.openSpecTimeline.children[0].querySelector(".open-spec-change-copy-button"), null);
  assert.notEqual(app.elements.openSpecTimeline.children[0].querySelector(".open-spec-change-menu-button"), null);
  assert.equal(app.elements.openSpecTimeline.children[0].querySelector(".open-spec-change-progress"), null);
});

test("mobile Open Spec copies the change id from the title action", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);

  await app.loadOpenSpecSummary();
  const copyButton = app.elements.openSpecTimeline.children[0].querySelector(".open-spec-change-copy-button");
  await copyButton.click({ preventDefault() {}, stopPropagation() {} });

  assert.equal(app.copiedText, "add-open-spec-mobile-progress");
  assert.equal(app.lastToast, "已复制 change ID");
});

test("mobile Open Spec Explore pre-fills the composer for user review", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);

  await app.openOpenSpecPanel();
  await app.elements.openSpecExploreButton.click({ preventDefault() {}, stopPropagation() {} });

  assert.match(app.elements.codexPrompt.value, /^请使用 OpenSpec Explore 流程探索一个 change。/);
  assert.match(app.elements.codexPrompt.value, /只做 Explore\/Proposal，不要实现代码/);
  assert.match(app.elements.codexPrompt.value, /我要探索：$/);
  assert.equal(app.elements.codexPrompt.selectionStart, app.elements.codexPrompt.value.length);
  assert.equal(app.elements.codexPrompt.selectionEnd, app.elements.codexPrompt.value.length);
  assert.equal(app.elements.codexPrompt.focusCalled, true);
  assert.equal(app.syncComposerInputHeightCalls, 1);
  assert.equal(app.updateComposerAvailabilityCalls, 1);
  assert.equal(app.elements.openSpecPanel.hidden, true);
  assert.equal(app.lastToast, "已填入 Explore 前缀");
});

test("mobile Open Spec Explore treats an existing composer draft as the exploration target", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);
  app.elements.codexPrompt.value = "给 Open Spec 面板加 Explore 按钮";

  await app.elements.openSpecExploreButton.click({ preventDefault() {}, stopPropagation() {} });

  assert.match(app.elements.codexPrompt.value, /^请使用 OpenSpec Explore 流程探索一个 change。/);
  assert.match(app.elements.codexPrompt.value, /我要探索：给 Open Spec 面板加 Explore 按钮$/);
});

test("mobile Open Spec action menu starts an apply session for a change", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);

  await app.loadOpenSpecSummary();
  const changeRow = app.elements.openSpecTimeline.children[0];
  const menuButton = changeRow.querySelector(".open-spec-change-menu-button");
  menuButton.click({ preventDefault() {}, stopPropagation() {} });
  assert.equal(menuButton.getAttribute("aria-expanded"), "true");

  const applyButton = changeRow.querySelectorAll("[data-open-spec-change-action]")[0];
  await applyButton.click({ preventDefault() {}, stopPropagation() {} });

  assert.equal(app.startedSession.projectId, "echo");
  assert.equal(app.startedSession.targetAgentId, "agent");
  assert.match(app.startedSession.prompt, /apply OpenSpec change `add-open-spec-mobile-progress`/);
  assert.equal(app.state.selectedCodexJobId, "session-apply");
  assert.equal(app.lastToast, "已创建 Apply 任务");
});

test("mobile Open Spec action menu starts a sync session for a change", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);

  await app.loadOpenSpecSummary();
  const changeRow = app.elements.openSpecTimeline.children[0];
  const syncButton = changeRow.querySelectorAll("[data-open-spec-change-action]")[1];
  await syncButton.click({ preventDefault() {}, stopPropagation() {} });

  assert.equal(app.startedSession.projectId, "echo");
  assert.equal(app.startedSession.targetAgentId, "agent");
  assert.match(app.startedSession.prompt, /同步 OpenSpec change `add-open-spec-mobile-progress` 的 task 勾选状态/);
  assert.match(app.startedSession.prompt, /不要实现新的功能代码/);
  assert.equal(app.lastToast, "已创建 Sync 任务");
});

test("mobile Open Spec action menu starts a validate session for a change", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);

  await app.loadOpenSpecSummary();
  const changeRow = app.elements.openSpecTimeline.children[0];
  const validateButton = changeRow.querySelectorAll("[data-open-spec-change-action]")[2];
  await validateButton.click({ preventDefault() {}, stopPropagation() {} });

  assert.equal(app.startedSession.projectId, "echo");
  assert.equal(app.startedSession.targetAgentId, "agent");
  assert.match(app.startedSession.prompt, /校验 OpenSpec change `add-open-spec-mobile-progress`/);
  assert.match(app.startedSession.prompt, /openspec validate <change> --strict/);
  assert.match(app.startedSession.prompt, /不要实现新功能代码/);
  assert.equal(app.lastToast, "已创建 Validate 任务");
});

test("mobile Open Spec restores cached progress when the desktop is unavailable", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);

  await app.loadOpenSpecSummary();
  app.available = false;
  app.state.codexConnectionState = "syncing";

  await app.loadOpenSpecSummary({ silent: true });

  assert.equal(app.apiCalls, 1);
  assert.equal(app.state.openSpecStale, true);
  assert.equal(app.elements.openSpec.hidden, false);
  assert.match(app.elements.openSpecMeta.textContent, /离线缓存/);
  assert.equal(app.elements.openSpecTimeline.children.length, 2);
});

test("mobile Open Spec updates availability when switching projects", async () => {
  const app = createOpenSpecApp();
  installOpenSpec(app);

  await app.loadOpenSpecSummary();
  assert.equal(app.elements.openSpec.hidden, false);

  await app.selectProject("agent:side");

  assert.equal(app.currentProjectId(), "side");
  assert.equal(app.state.openSpecSummary.available, false);
  assert.equal(app.elements.openSpec.hidden, false);
  assert.equal(app.elements.openSpecButton.disabled, false);
});

function createOpenSpecApp() {
  const elements = createOpenSpecElements();
  const state = {
    token: "token",
    codexConnectionState: "online",
    openSpecProjectId: "",
    openSpecSummary: null,
    openSpecSummariesByProject: {},
    openSpecBusy: false,
    openSpecError: "",
    openSpecStale: false,
    openSpecRequestSeq: 0
  };
  const workspaces = {
    "agent:echo": { id: "echo", key: "agent:echo", label: "Echo", path: "/workspace/echo", agentId: "agent" },
    "agent:side": { id: "side", key: "agent:side", label: "Side", path: "/workspace/side", agentId: "agent" }
  };
  const app = {
    document: new FakeDocument(),
    elements,
    state,
    window: {
      clearTimeout() {},
      setTimeout(callback) {
        callback();
        return 1;
      },
      addEventListener() {}
    },
    available: true,
    apiCalls: 0,
    selectedKey: "agent:echo",
    currentWorkspace() {
      return workspaces[app.selectedKey] || null;
    },
    currentProjectId() {
      return app.currentWorkspace()?.id || "";
    },
    currentTargetAgentId() {
      return app.currentWorkspace()?.agentId || "";
    },
    codexCommandsAvailable() {
      return app.available;
    },
    async apiPost(pathName, body) {
      if (pathName === "/api/codex/open-spec/summary") {
        assert.equal(body.targetAgentId, "agent");
        app.apiCalls += 1;
        return {
          openSpec: body.projectId === "side" ? unavailableSummary("side") : availableSummary(body.projectId)
        };
      }
      if (pathName === "/api/codex/sessions") {
        app.startedSession = body;
        return {
          session: {
            id: "session-apply",
            projectId: body.projectId,
            runtime: body.runtime || {}
          }
        };
      }
      throw new Error(`Unexpected API path ${pathName}`);
    },
    handleAuthError: () => false,
    toast(message) {
      app.lastToast = message;
    },
    async copyTextToClipboard(text) {
      app.copiedText = text;
    },
    escapeHtml(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    },
    workspaceDirectoryName: (workspace) => workspace.label || workspace.id,
    currentRuntimeDraft: () => ({ backendId: "codex" }),
    applyRuntimeDraft(runtime) {
      app.appliedRuntime = runtime;
    },
    renderCodexJob(session) {
      app.renderedSession = session;
    },
    async showCodexJob(id) {
      app.shownSessionId = id;
    },
    scheduleSessionListRefresh(options) {
      app.scheduledSessionListRefresh = options;
    },
    closeSessionSidebar() {},
    closeFileBrowser() {},
    closeProjectSwitcher() {},
    closeQuickSkillsPanel() {},
    closeAgentSkillsPanel() {},
    closeMcpPanel() {},
    setTopbarCollapsed() {},
    syncBodySheetState() {
      app.sheetSyncs = Number(app.sheetSyncs || 0) + 1;
    },
    syncComposerInputHeight() {
      app.syncComposerInputHeightCalls = Number(app.syncComposerInputHeightCalls || 0) + 1;
    },
    async refreshCodex() {},
    isLoggedIn: () => true,
    updateAuthView() {},
    updateComposerAvailability() {
      app.updateComposerAvailabilityCalls = Number(app.updateComposerAvailabilityCalls || 0) + 1;
    },
    handleGlobalKeydown() {},
    async selectProject(projectKey) {
      app.selectedKey = projectKey;
    }
  };
  return app;
}

function availableSummary(projectId = "echo") {
  return {
    projectId,
    available: true,
    directoryName: "openspec",
    overview: {
      totalChanges: 2,
      totalChangeEntries: 2,
      activeChanges: 1,
      archivedChanges: 1,
      completedChanges: 0,
      changesWithTasks: 1,
      totalTasks: 2,
      completedTasks: 1,
      percentComplete: 50,
      specCount: 1,
      totalSpecEntries: 1,
      truncated: false
    },
    changes: [
      {
        id: "add-open-spec-mobile-progress",
        title: "Add Open Spec Mobile Progress",
        status: "in-progress",
        progress: { completedTasks: 1, totalTasks: 2, percent: 50 },
        proposal: { excerpt: "Show OpenSpec progress on mobile." },
        design: {},
        affectedSpecs: ["mobile-open-spec-progress"],
        tasks: {
          groups: [
            {
              title: "1. Mobile UI",
              tasks: [
                { text: "Render timeline", checked: true },
                { text: "Restore cache", checked: false }
              ]
            }
          ]
        }
      },
      {
        id: "archived-open-spec-mobile-progress",
        title: "Archived Open Spec Mobile Progress",
        status: "archived",
        archived: true,
        archiveId: "2026-06-06-archived-open-spec-mobile-progress",
        archivedAt: "2026-06-06T00:00:00.000Z",
        progress: { completedTasks: 2, totalTasks: 2, percent: 100 },
        proposal: { excerpt: "Previously shipped OpenSpec progress." },
        design: {},
        affectedSpecs: ["mobile-open-spec-progress"],
        tasks: {
          groups: [
            {
              title: "1. History",
              tasks: [{ text: "Keep archived work visible", checked: true }]
            }
          ]
        }
      }
    ],
    specs: [{ id: "mobile-open-spec-progress", title: "Mobile Open Spec Progress", requirementCount: 1 }],
    warnings: []
  };
}

function unavailableSummary(projectId = "side") {
  return {
    projectId,
    available: false,
    directoryName: "",
    overview: {
      totalChanges: 0,
      totalChangeEntries: 0,
      activeChanges: 0,
      completedChanges: 0,
      changesWithTasks: 0,
      totalTasks: 0,
      completedTasks: 0,
      percentComplete: null,
      specCount: 0,
      totalSpecEntries: 0,
      truncated: false
    },
    changes: [],
    specs: [],
    warnings: []
  };
}

function createOpenSpecElements() {
  return {
    codexView: new FakeElement(),
    openSpec: new FakeElement({ hidden: true }),
    openSpecButton: new FakeElement(),
    openSpecPanel: new FakeElement({ hidden: true }),
    openSpecTitle: new FakeElement(),
    openSpecMeta: new FakeElement(),
    openSpecExploreButton: new FakeElement(),
    openSpecRefreshButton: new FakeElement(),
    openSpecCloseButton: new FakeElement(),
    openSpecStatus: new FakeElement(),
    openSpecOverview: new FakeElement(),
    openSpecTimeline: new FakeElement(),
    sessionBackdrop: new FakeElement({ hidden: true }),
    codexPrompt: new FakeElement({ tagName: "textarea" })
  };
}

class FakeDocument {
  createElement(tagName = "div") {
    return new FakeElement({ tagName });
  }
}

class FakeElement {
  constructor(options = {}) {
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.disabled = false;
    this.hidden = Boolean(options.hidden);
    this.open = false;
    this.tagName = String(options.tagName || "div").toUpperCase();
    this.textContent = "";
    this.title = "";
    this.value = "";
    this.className = "";
    this._innerHTML = "";
    this._selectors = new Map();
    this._selectorAll = new Map();
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.add(name);
        this.className = Array.from(current).join(" ");
      },
      remove: (...names) => {
        const remove = new Set(names);
        this.className = this.className
          .split(/\s+/)
          .filter((name) => name && !remove.has(name))
          .join(" ");
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !this.classList.contains(name) : Boolean(force);
        if (shouldAdd) this.classList.add(name);
        else this.classList.remove(name);
        return shouldAdd;
      }
    };
  }

  set innerHTML(value) {
    this._innerHTML = String(value || "");
    this.children = [];
    this._selectors = new Map();
    this._selectorAll = new Map();
    if (this._innerHTML.includes("open-spec-task-groups")) {
      this._selectors.set(".open-spec-task-groups", new FakeElement());
    }
    if (this._innerHTML.includes("open-spec-change-copy-button")) {
      this._selectors.set(".open-spec-change-copy-button", new FakeElement());
    }
    if (this._innerHTML.includes("open-spec-change-menu-button")) {
      this._selectors.set(".open-spec-change-menu-button", new FakeElement());
    }
    if (this._innerHTML.includes("data-open-spec-change-action")) {
      const apply = new FakeElement();
      apply.dataset.openSpecChangeAction = "apply";
      const sync = new FakeElement();
      sync.dataset.openSpecChangeAction = "sync";
      const validate = new FakeElement();
      validate.dataset.openSpecChangeAction = "validate";
      const archive = new FakeElement();
      archive.dataset.openSpecChangeAction = "archive";
      this._selectorAll.set("[data-open-spec-change-action]", [apply, sync, validate, archive]);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  querySelector(selector) {
    return this._selectors.get(selector) || null;
  }

  querySelectorAll(selector) {
    return this._selectorAll.get(selector) || [];
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  addEventListener(type, handler) {
    if (type === "click") this._clickHandler = handler;
  }

  click(event = {}) {
    return this._clickHandler?.(event);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] || "";
  }

  getBoundingClientRect() {
    return {};
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  focus() {
    this.focusCalled = true;
  }
}
