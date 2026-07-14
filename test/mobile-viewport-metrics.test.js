import assert from "node:assert/strict";
import test from "node:test";
import { installCore } from "../public/app/core.js";

test("mobile viewport metrics ignore non-keyboard visual viewport changes", () => {
  const { app, cssVars } = createViewportApp();

  app.syncViewportMetrics();
  assert.equal(cssVars.get("--app-height"), "800px");
  assert.equal(cssVars.get("--visual-viewport-top"), "0px");
  assert.equal(cssVars.get("--visual-viewport-bottom"), "0px");
  assert.equal(app.document.body.classList.contains("mobile-keyboard-open"), false);

  app.window.visualViewport.height = 720;
  app.window.visualViewport.offsetTop = 80;
  app.syncViewportMetrics();

  assert.equal(cssVars.get("--app-height"), "800px");
  assert.equal(cssVars.get("--visual-viewport-top"), "0px");
  assert.equal(cssVars.get("--visual-viewport-bottom"), "0px");
  assert.equal(app.document.body.classList.contains("mobile-keyboard-open"), false);
});

test("mobile viewport metrics follow the keyboard only while the composer is focused", () => {
  const { app, cssVars } = createViewportApp();

  app.syncViewportMetrics();
  app.document.activeElement = app.elements.codexPrompt;
  app.window.visualViewport.height = 520;
  app.window.visualViewport.offsetTop = 280;
  app.syncViewportMetrics();

  assert.equal(cssVars.get("--app-height"), "520px");
  assert.equal(cssVars.get("--visual-viewport-top"), "280px");
  assert.equal(cssVars.get("--visual-viewport-bottom"), "0px");
  assert.equal(app.document.body.classList.contains("mobile-keyboard-open"), true);

  app.document.activeElement = null;
  app.window.visualViewport.height = 800;
  app.window.visualViewport.offsetTop = 0;
  app.syncViewportMetrics();

  assert.equal(cssVars.get("--app-height"), "800px");
  assert.equal(cssVars.get("--visual-viewport-top"), "0px");
  assert.equal(cssVars.get("--visual-viewport-bottom"), "0px");
  assert.equal(app.document.body.classList.contains("mobile-keyboard-open"), false);
});

test("mobile viewport metrics expose keyboard bottom inset while the composer is focused", () => {
  const { app, cssVars } = createViewportApp();

  app.syncViewportMetrics();
  app.state.viewportPromptFocused = true;
  app.window.visualViewport.height = 520;
  app.window.visualViewport.offsetTop = 0;
  app.syncViewportMetrics();

  assert.equal(cssVars.get("--app-height"), "520px");
  assert.equal(cssVars.get("--visual-viewport-top"), "0px");
  assert.equal(cssVars.get("--visual-viewport-bottom"), "280px");
  assert.equal(app.document.body.classList.contains("mobile-keyboard-open"), true);
});

test("mobile viewport metrics do not inflate the keyboard gap while focused", () => {
  const { app, cssVars } = createViewportApp();

  app.syncViewportMetrics();
  app.state.viewportPromptFocused = true;
  app.window.visualViewport.height = 520;
  app.window.visualViewport.offsetTop = 0;
  app.syncViewportMetrics();

  assert.equal(app.state.viewportStableHeight, 800);
  assert.equal(cssVars.get("--visual-viewport-bottom"), "280px");

  app.window.innerHeight = 860;
  app.window.visualViewport.height = 520;
  app.syncViewportMetrics();

  assert.equal(app.state.viewportStableHeight, 800);
  assert.equal(cssVars.get("--visual-viewport-bottom"), "280px");
});

test("mobile viewport metrics reset the stable height after the keyboard closes", () => {
  const { app, cssVars } = createViewportApp();

  app.syncViewportMetrics();
  app.state.viewportPromptFocused = true;
  app.window.visualViewport.height = 520;
  app.window.visualViewport.offsetTop = 0;
  app.syncViewportMetrics();

  app.window.innerHeight = 860;
  app.syncViewportMetrics();
  assert.equal(app.state.viewportStableHeight, 800);

  app.state.viewportPromptFocused = false;
  app.window.innerHeight = 800;
  app.window.visualViewport.height = 800;
  app.window.visualViewport.offsetTop = 0;
  app.syncViewportMetrics();

  assert.equal(app.state.viewportStableHeight, 800);
  assert.equal(cssVars.get("--visual-viewport-bottom"), "0px");
  assert.equal(app.document.body.classList.contains("mobile-keyboard-open"), false);
});

test("mobile viewport metrics restores the plan switch to the left composer controls", () => {
  const { app, composerMeta, composerStatusRight, composerPlanModeButton } = createViewportApp();

  composerStatusRight.appendChild(composerPlanModeButton);
  assert.equal(composerPlanModeButton.parentElement, composerStatusRight);

  app.syncViewportMetrics();

  assert.equal(composerPlanModeButton.parentElement, composerMeta);
  assert.equal(composerMeta.firstElementChild, composerPlanModeButton);
});

function createViewportApp() {
  const cssVars = new Map();
  const bodyClasses = new Set();
  const composerMeta = createFakeContainer();
  const composerStatusRight = createFakeContainer();
  const composerPlanModeButton = createFakeNode();
  const composerAttachmentButton = createFakeNode();
  composerMeta.appendChild(composerAttachmentButton);
  const document = {
    activeElement: null,
    querySelector: (selector) => {
      if (selector === ".composer-status-meta") return composerMeta;
      return null;
    },
    body: {
      classList: {
        contains: (name) => bodyClasses.has(name),
        toggle: (name, enabled) => {
          if (enabled) bodyClasses.add(name);
          else bodyClasses.delete(name);
        }
      }
    },
    documentElement: {
      style: {
        setProperty: (name, value) => cssVars.set(name, value)
      }
    }
  };
  const window = {
    innerHeight: 800,
    innerWidth: 390,
    scrollY: 0,
    visualViewport: {
      height: 800,
      width: 390,
      offsetTop: 0
    },
    matchMedia: (query) => ({ matches: query === "(max-width: 760px)" }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
    addEventListener: () => {},
    scrollTo: (x, y) => {
      window.scrollY = y;
    }
  };
  const prompt = {
    scrollHeight: 56,
    style: {}
  };
  const composer = {
    offsetHeight: 120,
    getBoundingClientRect: () => ({ height: 120 })
  };
  const app = {
    constants: {},
    document,
    elements: {
      codexPrompt: prompt,
      codexView: {
        hidden: false,
        classList: {
          contains: () => false
        }
      },
      topbar: { offsetHeight: 64 },
      composer,
      composerPlanModeButton
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {}
    },
    state: {
      topbarCollapsed: false,
      viewportStableHeight: 0,
      viewportStableWidth: 0,
      viewportKeyboardActive: false,
      viewportPromptFocused: false
    },
    window
  };

  installCore(app);
  return { app, cssVars, composerMeta, composerStatusRight, composerPlanModeButton };
}

function createFakeNode() {
  return {
    parentElement: null
  };
}

function createFakeContainer() {
  const node = createFakeNode();
  node.children = [];
  Object.defineProperty(node, "firstElementChild", {
    get() {
      return node.children[0] || null;
    }
  });
  node.appendChild = (child) => {
    if (child.parentElement?.children) {
      child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    }
    child.parentElement = node;
    node.children.push(child);
  };
  node.insertBefore = (child, before) => {
    if (child.parentElement?.children) {
      child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    }
    child.parentElement = node;
    const index = before ? node.children.indexOf(before) : -1;
    if (index >= 0) node.children.splice(index, 0, child);
    else node.children.push(child);
  };
  return node;
}
