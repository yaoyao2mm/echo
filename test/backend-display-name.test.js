import assert from "node:assert/strict";
import test from "node:test";
import { installCore } from "../public/app/core.js";

test("backend display names stay compact and expose Claude provider variants", () => {
  const app = {
    constants: {
      BACKEND_OPTIONS: [],
      MODEL_OPTIONS: [],
      PERMISSION_MODE_OPTIONS: [],
      REASONING_OPTIONS: []
    },
    document: {
      activeElement: null,
      body: { classList: { toggle: () => {}, contains: () => false } },
      documentElement: { style: { setProperty: () => {} } }
    },
    elements: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    state: {
      codexBackendRuntimes: [
        { backendId: "codex", backendName: "Codex" },
        { backendId: "claude-code", backendName: "Claude Code", provider: "deepseek-via-claude" },
        { backendId: "claude-volcengine", backendName: "Claude Code", provider: "volcengine-coding-plan" }
      ]
    },
    window: {
      addEventListener: () => {},
      requestAnimationFrame: (callback) => callback(),
      setTimeout: (callback) => callback(),
      visualViewport: null
    }
  };

  installCore(app);

  assert.equal(app.backendDisplayName("codex"), "Codex");
  assert.equal(app.backendDisplayName("claude-code"), "Claude · DeepSeek");
  assert.equal(app.backendDisplayName("volcengine-coding-plan"), "Claude · Volcengine Coding Plan");
  assert.equal(app.backendDisplayName("Claude Code"), "Claude · DeepSeek");
});
