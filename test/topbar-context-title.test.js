import assert from "node:assert/strict";
import test from "node:test";
import { installCore } from "../public/app/core.js";

test("topbar context title follows the selected workspace", () => {
  const app = createTopbarContextApp();
  installCore(app);

  app.refreshTopbarProjectChip();
  assert.equal(app.elements.topbarContextTitle.textContent, "echo");
  assert.equal(app.elements.topbarContextTitle.title, "echo");

  app.elements.codexProject.value = "side";
  app.refreshTopbarProjectChip();
  assert.equal(app.elements.topbarContextTitle.textContent, "Side Project");
});

test("topbar context title falls back while waiting for desktop context", () => {
  const app = createTopbarContextApp({ workspaces: [], selectedProject: "echo" });
  installCore(app);

  app.refreshTopbarProjectChip();

  assert.equal(app.elements.topbarContextTitle.textContent, "等待桌面");
});

function createTopbarContextApp(options = {}) {
  const cssVars = new Map();
  const workspaces =
    options.workspaces ??
    [
      { id: "echo", label: "Echo", path: "/workspace/echo" },
      { id: "side", label: "Side Project", path: "" }
    ];
  const selectedProject = options.selectedProject ?? "echo";
  const topbarContextTitle = new FakeElement();
  topbarContextTitle.textContent = "Echo";
  const codexProject = { value: selectedProject };
  const projectSwitcher = { hidden: false };
  const document = {
    body: {
      classList: {
        toggle() {}
      }
    },
    documentElement: {
      style: {
        setProperty: (name, value) => cssVars.set(name, value)
      }
    }
  };
  return {
    constants: {},
    document,
    elements: {
      codexProject,
      projectSwitcher,
      topbarContextTitle
    },
    isLoggedIn: () => true,
    localStorage: {
      getItem(key) {
        return key === "echoCodexProject" ? selectedProject : null;
      },
      setItem() {}
    },
    state: {
      token: "token",
      codexWorkspaces: workspaces
    },
    window: {}
  };
}

class FakeElement {
  constructor() {
    this.textContent = "";
    this.title = "";
  }
}
