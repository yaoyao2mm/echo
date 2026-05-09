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

function createViewportApp() {
  const cssVars = new Map();
  const bodyClasses = new Set();
  const document = {
    activeElement: null,
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
      composer
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
  return { app, cssVars };
}
