import assert from "node:assert/strict";
import test from "node:test";
import { installCodex } from "../public/app/codex.js";
import { installCore } from "../public/app/core.js";

test("composer sends follow-ups to the selected session even when it is high risk", async () => {
  const calls = [];
  const app = createRoutingApp(calls);
  app.state.selectedCodexJobId = "session-high-risk";
  app.state.selectedCodexSession = {
    id: "session-high-risk",
    projectId: "echo",
    status: "active",
    metrics: { risk: "high", eventCount: 220 },
    memory: { summary: "旧会话摘要" }
  };

  await app.sendCodexPrompt({
    projectId: "echo",
    prompt: "现在有个新的 bug，每次我回话都会开启新会话",
    runtime: { model: "gpt-test" },
    attachments: [],
    mode: "execute"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/codex/sessions/session-high-risk/messages");
  assert.equal(calls[0].body.text, "现在有个新的 bug，每次我回话都会开启新会话");
  assert.equal(calls[0].body.projectId, "echo");
  assert.equal(calls[0].body.runtime.model, "gpt-test");
});

test("composer creates a session only when composing a new session", async () => {
  const calls = [];
  const app = createRoutingApp(calls);
  app.state.composingNewSession = true;
  app.state.selectedCodexJobId = "session-existing";
  app.state.selectedCodexSession = {
    id: "session-existing",
    projectId: "echo",
    status: "active"
  };

  await app.sendCodexPrompt({
    projectId: "echo",
    prompt: "开启一个新话题",
    runtime: {},
    attachments: [],
    mode: "plan"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/codex/sessions");
  assert.deepEqual(calls[0].body, {
    projectId: "echo",
    prompt: "开启一个新话题",
    runtime: {},
    attachments: [],
    mode: "plan"
  });
});

test("composer sends follow-ups to failed sessions when Codex was rate limited", async () => {
  const calls = [];
  const app = createRoutingApp(calls);
  app.state.selectedCodexJobId = "session-rate-limited";
  app.state.selectedCodexSession = {
    id: "session-rate-limited",
    projectId: "echo",
    status: "failed",
    lastError: "429 Too Many Requests: rate limit reached for model gpt-5.5"
  };

  assert.equal(app.sessionCanRecoverFailure(app.state.selectedCodexSession), true);
  assert.equal(app.sessionCanAcceptFollowUp(app.state.selectedCodexSession), true);

  await app.sendCodexPrompt({
    projectId: "echo",
    prompt: "等恢复后继续这条上下文",
    runtime: {},
    attachments: [],
    mode: "execute"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/codex/sessions/session-rate-limited/messages");
  assert.equal(calls[0].body.text, "等恢复后继续这条上下文");
});

test("composer action label reflects plan-only backend permissions", () => {
  const app = createRoutingApp([]);
  app.state.selectedCodexJobId = "session-plan-only";
  app.state.selectedCodexSession = {
    id: "session-plan-only",
    projectId: "echo",
    status: "active"
  };
  app.currentBackendRunsPlanOnly = () => true;

  assert.equal(app.composerActionLabel(), "生成计划");
});

test("composer action label uses append copy while work is pending", () => {
  const app = createRoutingApp([]);
  app.state.selectedCodexJobId = "session-pending";
  app.state.selectedCodexSession = {
    id: "session-pending",
    projectId: "echo",
    status: "active",
    pendingCommandCount: 1,
    queuedCommandCount: 1
  };

  assert.equal(app.composerActionLabel(), "追加");
});

test("composer recognizes a completed plan as the next execution target", () => {
  const app = createRoutingApp([]);
  const session = {
    id: "session-plan-follow-up",
    projectId: "echo",
    status: "active",
    events: [{ type: "user.message", raw: { source: "mobile", mode: "plan" } }]
  };
  app.state.selectedCodexJobId = session.id;
  app.state.selectedCodexSession = session;
  app.state.composingNewSession = false;

  assert.equal(app.sessionAwaitsPlanFollowUp(session), true);
  assert.equal(app.composerActionLabel(), "执行计划");

  session.events.push({ type: "user.message", raw: { source: "mobile", mode: "execute" } });
  assert.equal(app.sessionAwaitsPlanFollowUp(session), false);
});

test("composer status bar uses turn activity copy for pending commands", () => {
  const app = createStatusBarApp();

  app.refreshComposerStatusBar();

  assert.equal(app.elements.composerStatusText.textContent, "等待桌面接收任务");
});

test("composer status bar makes worktree follow-up reuse explicit", () => {
  const app = createStatusBarApp();
  app.state.selectedCodexSession = {
    id: "session-worktree",
    status: "active",
    pendingCommandCount: 0,
    execution: { mode: "worktree", lifecycleState: "completed" }
  };

  app.refreshComposerStatusBar();

  assert.equal(app.elements.composerStatusText.textContent, "继续将在当前隔离 worktree 中运行");
});

test("composer plan switch restores session mode and explicit off wins after reload", () => {
  const app = createRoutingApp([]);
  const writes = new Map();
  app.elements.composerPlanModeButton = createFakeSwitchButton();
  app.updateComposerAvailability = () => {};
  app.readScopedStorage = (key) => writes.get(key) || "";
  app.writeScopedStorage = (key, value) => writes.set(key, value);
  app.state.selectedCodexJobId = "session-plan";
  app.state.selectedCodexSession = {
    id: "session-plan",
    projectId: "echo",
    status: "active",
    composerMode: "plan"
  };

  app.restoreComposerMode({ includeSession: true });

  assert.equal(app.state.composerPlanMode, true);
  assert.equal(app.elements.composerPlanModeButton.attrs["aria-checked"], "true");

  app.toggleComposerPlanMode();

  assert.equal(app.state.composerPlanMode, false);
  assert.equal(writes.get("echoComposerModeSession:session-plan"), "execute");
  assert.equal(writes.get("echoComposerModeWorkspace:echo"), "execute");
  assert.equal(writes.get("echoComposerMode"), "execute");

  app.restoreComposerMode({ includeSession: true });

  assert.equal(app.state.composerPlanMode, false);
  assert.equal(app.elements.composerPlanModeButton.attrs["aria-checked"], "false");
});

test("composer plan switch falls back to server session mode when no local override exists", () => {
  const app = createRoutingApp([]);
  app.elements.composerPlanModeButton = createFakeSwitchButton();
  app.updateComposerAvailability = () => {};
  app.readScopedStorage = () => "";
  app.state.selectedCodexJobId = "session-server-plan";
  app.state.selectedCodexSession = {
    id: "session-server-plan",
    projectId: "echo",
    status: "active",
    composerMode: "plan"
  };

  app.restoreComposerMode({ includeSession: true });

  assert.equal(app.state.composerPlanMode, true);
  assert.equal(app.currentComposerMode(), "plan");
});

test("composer plan switch stays locked to the running turn mode until the turn finishes", () => {
  const app = createRoutingApp([]);
  const toasts = [];
  app.elements.composerPlanModeButton = createFakeSwitchButton();
  app.updateComposerAvailability = () => {};
  app.readScopedStorage = () => "execute";
  app.toast = (message) => toasts.push(message);
  app.state.selectedCodexJobId = "session-running-plan";
  app.state.selectedCodexSession = {
    id: "session-running-plan",
    projectId: "echo",
    status: "running",
    activeTurnId: "turn-running",
    composerMode: "plan",
    events: [
      {
        type: "user.message",
        raw: { mode: "plan" }
      },
      {
        type: "turn/started",
        activeTurnId: "turn-running",
        raw: { method: "turn/started", params: { threadId: "thr-running", turn: { id: "turn-running" } } }
      },
      {
        type: "user.message",
        raw: { mode: "execute" }
      }
    ]
  };

  app.restoreComposerMode({ includeSession: true });

  assert.equal(app.state.composerPlanMode, false);
  assert.equal(app.currentComposerMode(), "plan");
  assert.equal(app.elements.composerPlanModeButton.attrs["aria-checked"], "true");
  assert.equal(app.elements.composerPlanModeButton.attrs["aria-label"], "Plan mode 正在当前轮中使用，完成或取消后可切换");
  assert.equal(app.elements.composerPlanModeButton.disabled, true);

  app.toggleComposerPlanMode();

  assert.equal(app.state.composerPlanMode, false);
  assert.deepEqual(toasts, ["当前轮正在运行，完成或取消后再切换 Plan mode"]);
});

test("installed agent skill picker inserts explicit skill invocation", () => {
  const app = createRoutingApp([]);
  const prompt = {
    value: "修一下移动端按钮",
    selectionStart: 0,
    selectionEnd: 0,
    focusCalled: false,
    focus() {
      this.focusCalled = true;
    }
  };
  const calls = [];
  app.elements.codexPrompt = prompt;
  app.closeAgentSkillsPanel = () => calls.push("close");
  app.syncComposerInputHeight = () => calls.push("height");
  app.updateComposerAvailability = () => calls.push("availability");
  app.toast = (message) => calls.push(message);

  const skills = app.installedAgentSkillsForRuntime({
    installedSkills: [
      {
        name: "design-taste-frontend",
        description: "Codex copy",
        providers: [{ provider: "codex", label: "Codex" }]
      }
    ],
    backends: [
      {
        installedSkills: [
          {
            name: "design-taste-frontend",
            description: "Claude copy",
            providers: [{ provider: "claude-code", label: "Claude Code" }]
          }
        ]
      }
    ]
  });

  assert.equal(skills.length, 1);
  assert.deepEqual(
    skills[0].providers.map((provider) => provider.provider).sort(),
    ["claude-code", "codex"]
  );

  app.insertAgentSkillInvocation(skills[0]);

  assert.equal(prompt.value, "$design-taste-frontend 修一下移动端按钮");
  assert.equal(prompt.selectionStart, prompt.value.length);
  assert.equal(prompt.selectionEnd, prompt.value.length);
  assert.equal(prompt.focusCalled, true);
  assert.deepEqual(calls, ["close", "height", "availability", "已插入 $design-taste-frontend"]);

  app.insertAgentSkillInvocation(skills[0]);
  assert.equal(prompt.value, "$design-taste-frontend 修一下移动端按钮");
});

test("installed agent skill picker filters disabled hidden and backend-unavailable skills", () => {
  const app = createQuickSkillApp([]);
  app.elements.codexBackend = { value: "codex" };

  const codexSkills = app.installedAgentSkillsForRuntime({
    installedSkills: [
      {
        id: "skill-a",
        name: "codex-ready",
        enabled: true,
        showInComposer: true,
        providers: [{ provider: "codex", label: "Codex", enabled: true, syncState: "ready" }]
      },
      {
        id: "skill-b",
        name: "hidden-ready",
        enabled: true,
        showInComposer: false,
        providers: [{ provider: "codex", label: "Codex", enabled: true, syncState: "ready" }]
      },
      {
        id: "skill-c",
        name: "disabled-ready",
        enabled: false,
        showInComposer: true,
        providers: [{ provider: "codex", label: "Codex", enabled: true, syncState: "ready" }]
      },
      {
        id: "skill-d",
        name: "claude-ready",
        enabled: true,
        showInComposer: true,
        providers: [{ provider: "claude-code", label: "Claude Code", enabled: true, syncState: "ready" }]
      }
    ]
  });

  assert.deepEqual(codexSkills.map((skill) => skill.name), ["codex-ready"]);

  app.elements.codexBackend.value = "claude-code";
  const claudeSkills = app.installedAgentSkillsForRuntime({
    installedSkills: [
      {
        id: "skill-a",
        name: "codex-ready",
        enabled: true,
        showInComposer: true,
        providers: [{ provider: "codex", label: "Codex", enabled: true, syncState: "ready" }]
      },
      {
        id: "skill-d",
        name: "claude-ready",
        enabled: true,
        showInComposer: true,
        providers: [{ provider: "claude-code", label: "Claude Code", enabled: true, syncState: "ready" }]
      }
    ]
  });

  assert.deepEqual(claudeSkills.map((skill) => skill.name), ["claude-ready"]);
});

test("project quick skill creation does not switch to global without a project", () => {
  const calls = [];
  const app = createQuickSkillApp(calls);
  const toasts = [];
  app.currentProjectId = () => "";
  app.toast = (message) => toasts.push(message);

  app.startNewQuickSkill("project");

  assert.equal(app.elements.quickSkillForm.hidden, true);
  assert.equal(app.elements.quickSkillScope.value, "global");
  assert.deepEqual(toasts, ["先选择工程"]);
  assert.deepEqual(calls, []);
});

test("quick skill save submits only scope title and prompt", async () => {
  const calls = [];
  const app = createQuickSkillApp(calls);
  app.elements.quickSkillScope.value = "project";
  app.elements.quickSkillTitle.value = "发布";
  app.elements.quickSkillPrompt.value = "请发布当前项目。";

  await app.saveQuickSkill({ preventDefault() {} });

  assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      path: "/api/codex/quick-skills",
      body: {
        scope: "project",
        projectId: "echo",
        targetAgentId: "agent",
        title: "发布",
        prompt: "请发布当前项目。"
      }
    });
});

function createRoutingApp(calls) {
  const app = {
    constants: {},
    elements: {},
    state: {
      selectedCodexJobId: "",
      selectedCodexSession: null,
      composingNewSession: false,
      composerPlanMode: false
    },
    currentProjectId: () => "echo",
    sessionBelongsToCurrentProject: (session) => Boolean(session?.id && session.projectId === "echo"),
    apiPost: async (path, body) => {
      calls.push({ path, body });
      return {
        session: {
          id: path.endsWith("/messages") ? "session-high-risk" : "session-new",
          projectId: body.projectId,
          status: "queued"
        }
      };
    }
  };
  installCodex(app);
  return app;
}

function createQuickSkillApp(calls) {
  const app = {
    constants: {},
    elements: {
      quickSkillsPanel: { dataset: {}, hidden: false },
      quickSkillForm: { hidden: true },
      quickSkillId: createFakeInput(""),
      quickSkillTitle: createFakeInput(""),
      quickSkillScope: createFakeInput("global"),
      quickSkillPrompt: createFakeInput(""),
      quickSkillDeleteButton: createFakeElement(),
      quickSkillCancelButton: createFakeElement(),
      quickSkillSaveButton: createFakeElement(),
      quickSkillFormTitle: createFakeElement(),
      quickSkillNewGlobalButton: createFakeElement(),
      quickSkillNewProjectButton: createFakeElement()
    },
    state: {
      quickSkills: [],
      quickSkillsBusy: false,
      quickSkillEditingId: ""
    },
    currentProjectId: () => "echo",
    currentTargetAgentId: () => "agent",
    ensurePaired: () => true,
    apiPost: async (path, body) => {
      calls.push({ path, body });
      return { skill: { id: "quick-1", ...body } };
    },
    loadQuickSkills: async () => {},
    handleAuthError: () => false,
    toast() {}
  };
  installCodex(app);
  return app;
}

function createStatusBarApp() {
  const noop = () => {};
  const elements = new Proxy(
    {},
    {
      get(target, prop) {
        if (!(prop in target)) target[prop] = createFakeElement();
        return target[prop];
      }
    }
  );
  const app = {
    constants: {
      BACKEND_OPTIONS: [],
      MODEL_OPTIONS: [],
      PERMISSION_MODE_OPTIONS: [],
      REASONING_OPTIONS: []
    },
    document: {
      body: { classList: { toggle: noop } },
      documentElement: { style: { setProperty: noop } },
      addEventListener: noop
    },
    elements,
    localStorage: { getItem: () => "", setItem: noop },
    state: {
      selectedCodexSession: {
        id: "session-pending",
        status: "active",
        pendingCommandCount: 1,
        queuedCommandCount: 1
      },
      composingNewSession: false,
      composerBusy: false,
      composerAttachmentPendingCount: 0,
      codexConnectionState: "online",
      codexAgentAvailable: true,
      codexAgentRuntime: {},
      codexBackendRuntimes: [],
      runtimePreferences: {}
    },
    window: {
      addEventListener: noop,
      matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
      visualViewport: null
    }
  };
  installCore(app);
  app.currentProjectId = () => "echo";
  app.turnActivityForSession = () => ({ state: "queued", text: "等待桌面接收任务" });
  app.refreshContextUsageIndicator = noop;
  app.sessionCanRecoverFailure = () => false;
  app.sessionCanAcceptFollowUp = () => true;
  return app;
}

function createFakeElement() {
  const noop = () => {};
  return {
    textContent: "",
    value: "",
    disabled: false,
    hidden: false,
    innerHTML: "",
    style: { setProperty: noop },
    classList: { add: noop, remove: noop, toggle: noop },
    setAttribute: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    append: noop
  };
}

function createFakeInput(value = "") {
  return {
    ...createFakeElement(),
    value,
    focus() {
      this.focused = true;
    }
  };
}

function createFakeSwitchButton() {
  return {
    attrs: {},
    disabled: false,
    title: "",
    classList: {
      active: false,
      toggle(name, enabled) {
        if (name === "active") this.active = Boolean(enabled);
      }
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    querySelector() {
      return null;
    }
  };
}
