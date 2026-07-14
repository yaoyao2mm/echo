import assert from "node:assert/strict";
import test from "node:test";
import { installFiles } from "../public/app/files.js";

test("file browser keeps the last directory tree when refresh cannot reach the desktop", async () => {
  const app = createFileBrowserApp();
  installFiles(app);

  await app.loadFileBrowserPath("");

  assert.equal(app.state.fileBrowserTree.entries[0].name, "src");
  assert.equal(app.state.fileBrowserStale, false);
  assert.equal(app.state.fileBrowserError, "");
  assert.equal(app.elements.fileBrowserStatus.textContent, "1 项");

  app.available = false;
  app.state.codexConnectionState = "syncing";

  await app.loadFileBrowserPath("", { silent: true });

  assert.equal(app.state.fileBrowserTree.entries[0].name, "src");
  assert.equal(app.state.fileBrowserStale, true);
  assert.equal(app.state.fileBrowserError, "");
  assert.equal(app.elements.fileBrowserList.children.length, 1);
  assert.equal(app.elements.fileBrowserStatus.textContent, "1 项");
});

test("file browser entry stays available for cached projects even when commands are unavailable", () => {
  const app = createFileBrowserApp();
  installFiles(app);

  app.available = false;
  app.updateComposerAvailability();

  assert.equal(app.elements.fileBrowserButton.disabled, false);

  app.currentProjectId = () => "";
  app.updateComposerAvailability();

  assert.equal(app.elements.fileBrowserButton.disabled, true);
});

test("transcript file reference opens the session-scoped parent and preview at the requested line", async () => {
  const app = createFileBrowserApp();
  const requests = [];
  app.apiPost = async (pathName, body) => {
    requests.push({ pathName, body });
    if (pathName.endsWith("/list")) {
      return {
        tree: {
          projectId: body.projectId,
          path: body.path,
          entries: body.path === "src" ? [{ name: "server.js", path: "src/server.js", type: "file", previewable: true }] : [],
          totalEntries: body.path === "src" ? 1 : 0
        }
      };
    }
    return {
      file: {
        projectId: body.projectId,
        path: body.path,
        name: "server.js",
        content: "one\ntwo\nthree\n",
        size: 14
      }
    };
  };
  installFiles(app);

  await app.openWorkspaceFileReference({
    workspaceId: "echo",
    sessionId: "session-1",
    targetAgentId: "agent",
    executionTarget: "session-worktree",
    reference: "src/server.js#L2"
  });

  const previewRequest = requests.find((request) => request.pathName.endsWith("/read"));
  assert.equal(previewRequest.body.path, "src/server.js");
  assert.equal(previewRequest.body.sessionId, "session-1");
  assert.equal(previewRequest.body.executionTarget, "session-worktree");
  assert.equal(app.state.filePreviewLine, 2);
  assert.equal(app.elements.filePreviewContent.children[1].className.includes("is-target"), true);

  app.state.filePreviewLine = 99;
  app.renderFilePreview();
  assert.match(app.elements.filePreviewMeta.textContent, /无法定位第 99 行/);
});

function createFileBrowserApp() {
  const elements = createFileBrowserElements();
  const state = {
    composerBusy: false,
    codexConnectionState: "online",
    fileBrowserProjectId: "",
    fileBrowserPath: "",
    fileBrowserTree: null,
    fileBrowserTreesByProject: {},
    filePreview: null,
    fileBrowserBusy: false,
    fileBrowserError: "",
    fileBrowserRequestSeq: 0
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
      addEventListener() {},
      requestAnimationFrame(callback) {
        callback();
      }
    },
    available: true,
    currentWorkspace: () => ({ id: "echo", key: "agent:echo", label: "Echo", path: "/workspace/echo", agentId: "agent" }),
    currentProjectId: () => "echo",
    currentTargetAgentId: () => "agent",
    codexCommandsAvailable() {
      return app.available;
    },
    async apiPost(pathName, body) {
      assert.equal(pathName, "/api/codex/files/list");
      assert.equal(body.projectId, "echo");
      return {
        tree: {
          projectId: "echo",
          workspace: { id: "echo" },
          path: body.path || "",
          entries: [{ name: "src", path: "src", type: "directory" }],
          totalEntries: 1
        }
      };
    },
    handleAuthError: () => false,
    toast(message) {
      app.lastToast = message;
    },
    escapeHtml(value) {
      return String(value || "");
    },
    workspaceDirectoryName: (workspace) => workspace.label || workspace.id,
    workspaceLabel: (workspace) => workspace.label || workspace.id,
    closeSessionSidebar() {},
    closeProjectSwitcher() {},
    closeQuickSkillsPanel() {},
    closeAgentSkillsPanel() {},
    setTopbarCollapsed() {},
    syncBodySheetState() {},
    updateComposerAvailability() {},
    handleDocumentClick() {},
    handleGlobalKeydown() {},
    async selectProject() {},
    renderFilePreview() {}
  };
  return app;
}

function createFileBrowserElements() {
  return {
    codexView: new FakeElement(),
    fileBrowserPanel: new FakeElement({ hidden: true }),
    fileBrowserButton: new FakeElement(),
    sessionBackdrop: new FakeElement(),
    fileBrowserTitle: new FakeElement(),
    fileBrowserMeta: new FakeElement(),
    fileBrowserRefreshButton: new FakeElement(),
    fileBrowserCloseButton: new FakeElement(),
    fileBrowserBreadcrumbs: new FakeElement(),
    fileBrowserStatus: new FakeElement(),
    fileBrowserList: new FakeElement(),
    filePreview: new FakeElement(),
    filePreviewTitle: new FakeElement(),
    filePreviewMeta: new FakeElement(),
    filePreviewContent: new FakeElement(),
    filePreviewInsertButton: new FakeElement(),
    filePreviewCloseButton: new FakeElement(),
    codexPrompt: new FakeTextInput()
  };
}

class FakeDocument {
  createElement() {
    return new FakeElement();
  }
}

class FakeElement {
  constructor(options = {}) {
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.hidden = Boolean(options.hidden);
    this.textContent = "";
    this.title = "";
    this.value = "";
    this.className = "";
    this.classList = {
      add() {},
      remove() {},
      contains: () => false,
      toggle() {}
    };
  }

  set innerHTML(_value) {
    this.children = [];
  }

  getBoundingClientRect() {
    return {};
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  querySelector(selector) {
    if (selector === ".is-target") return this.children.find((child) => child.className.includes("is-target")) || null;
    return null;
  }

  scrollIntoView() {}

  addEventListener() {}

  setAttribute() {}

  focus() {}
}

class FakeTextInput extends FakeElement {
  constructor() {
    super();
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}
