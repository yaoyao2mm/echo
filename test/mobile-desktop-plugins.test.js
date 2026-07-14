import assert from "node:assert/strict";
import test from "node:test";
import { installDesktopPlugins } from "../public/app/desktop-plugins.js";

test("mobile desktop plugins normalize snapshots and gate OpenSpec", () => {
  const app = createPluginApp();
  installDesktopPlugins(app);

  app.updateDesktopPluginSnapshot({
    capability: { canManage: true, commandTypes: ["plugin.list", "plugin.update"] },
    plugins: [
      {
        id: "open-spec",
        name: "OpenSpec",
        version: "1.0.0",
        source: { kind: "echo-builtin", label: "Echo 内建" },
        capabilities: ["open-spec.summary"],
        enabled: false
      }
    ]
  });

  assert.equal(app.state.desktopPluginSnapshot.canManage, true);
  assert.equal(app.state.desktopPluginSnapshot.summary.disabled, 1);
  assert.equal(app.isDesktopPluginEnabled("open-spec"), false);
  assert.equal(app.elements.desktopPluginManager.hidden, false);
  assert.equal(app.elements.desktopPluginPreferenceSubtitle.textContent, "0 个启用 · 1 个可用");
  assert.equal(app.closeOpenSpecCalls, 1);
  assert.equal(app.state.openSpecSummary, null);
});

test("mobile desktop plugin switch sends only advertised state intent", async () => {
  const app = createPluginApp();
  installDesktopPlugins(app);

  await app.updateDesktopPlugin("open-spec", false);

  assert.deepEqual(app.posted, {
    endpoint: "/api/codex/plugins/update",
    body: { targetAgentId: "desktop-a", pluginId: "open-spec", enabled: false }
  });
  assert.equal(app.polledPath, "/api/codex/plugins/commands/command-1");
  assert.deepEqual(app.refreshOptions, { forcePlugins: true });
  assert.equal(app.state.desktopPluginBusy, false);
});

function createPluginApp() {
  const elements = {
    desktopPluginManager: { hidden: true },
    desktopPluginPreferenceSubtitle: { textContent: "" },
    desktopPluginPanel: null,
    desktopPluginMeta: null,
    desktopPluginOverview: null,
    desktopPluginList: null,
    desktopPluginRefreshButton: null,
    desktopPluginStatus: null
  };
  const app = {
    document: { createElement() { return {}; } },
    elements,
    state: {
      desktopPluginSnapshot: null,
      desktopPluginBusy: false,
      openSpecSummary: { available: true },
      openSpecProjectId: "desktop-a:echo"
    },
    window: { requestAnimationFrame(callback) { callback(); } },
    closeOpenSpecPanel() {
      app.closeOpenSpecCalls = Number(app.closeOpenSpecCalls || 0) + 1;
    },
    updateOpenSpecAvailability() {
      app.availabilityUpdates = Number(app.availabilityUpdates || 0) + 1;
    },
    ensurePaired: () => true,
    currentTargetAgentId: () => "desktop-a",
    async apiPost(endpoint, body) {
      app.posted = { endpoint, body };
      return { command: { id: "command-1" } };
    },
    async apiGet(path) {
      app.polledPath = path;
      return { command: { status: "done" } };
    },
    async refreshCodex(options) {
      app.refreshOptions = options;
    },
    handleAuthError: () => false,
    toast(message) {
      app.lastToast = message;
    },
    escapeHtml: (value) => String(value || ""),
    handleGlobalKeydown() {}
  };
  return app;
}
