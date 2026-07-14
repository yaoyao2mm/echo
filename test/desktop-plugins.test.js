import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  desktopPluginRegistry,
  desktopPluginStatePath,
  isDesktopPluginEnabled,
  updateDesktopPluginState
} from "../src/lib/desktopPlugins.js";

test("desktop plugin registry advertises OpenSpec enabled by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-desktop-plugins-"));
  const statePath = path.join(root, "plugins.json");
  const registry = desktopPluginRegistry({ statePath });

  assert.equal(registry.capability.canManage, true);
  assert.deepEqual(registry.capability.commandTypes, ["plugin.list", "plugin.update"]);
  assert.equal(registry.plugins.length, 2);
  assert.equal(registry.plugins[0].id, "open-spec");
  assert.equal(registry.plugins[0].enabled, true);
  assert.deepEqual(registry.plugins[0].capabilities, ["open-spec.summary", "open-spec.mobile-progress"]);
  assert.equal(registry.plugins[1].id, "orchestration");
  assert.equal(registry.plugins[1].enabled, false);
  assert.deepEqual(registry.plugins[1].requires, ["open-spec"]);
  assert.deepEqual(registry.plugins[1].prerequisites, { managedWorktree: false });
  assert.equal(isDesktopPluginEnabled("open-spec", { statePath }), true);
});

test("orchestration plugin enforces dependencies, Worktree capability, and drain semantics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-orchestration-plugin-"));
  const statePath = path.join(root, "plugins.json");

  let result = updateDesktopPluginState({ pluginId: "orchestration", enabled: true }, { statePath });
  assert.equal(result.ok, false);
  assert.equal(result.code, "MANAGED_WORKTREE_UNAVAILABLE");

  result = updateDesktopPluginState(
    { pluginId: "orchestration", enabled: true },
    { statePath, managedWorktreeAvailable: true }
  );
  assert.equal(result.ok, true);
  assert.equal(result.plugin.enabled, true);

  result = updateDesktopPluginState({ pluginId: "open-spec", enabled: false }, { statePath, managedWorktreeAvailable: true });
  assert.equal(result.code, "PLUGIN_DEPENDENT_ENABLED");

  result = updateDesktopPluginState(
    { pluginId: "orchestration", enabled: false },
    { statePath, managedWorktreeAvailable: true, hasActiveOrchestrationWork: true }
  );
  assert.equal(result.code, "PLUGIN_DRAIN_REQUIRED");
  assert.equal(isDesktopPluginEnabled("orchestration", { statePath, managedWorktreeAvailable: true }), true);
});

test("desktop plugin state persists a bounded enable switch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-desktop-plugin-state-"));
  const statePath = path.join(root, "plugins.json");
  const result = updateDesktopPluginState({ pluginId: "open-spec", enabled: false, path: "/tmp/ignored" }, { statePath });

  assert.equal(result.ok, true);
  assert.equal(result.plugin.enabled, false);
  assert.equal(isDesktopPluginEnabled("open-spec", { statePath }), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), {
    version: 1,
    plugins: { "open-spec": { enabled: false } }
  });
  assert.equal(updateDesktopPluginState({ pluginId: "unknown", enabled: true }, { statePath }).ok, false);
});

test("desktop plugin state path is scoped by agent id", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-desktop-plugin-path-"));
  assert.equal(desktopPluginStatePath({ dataDir, agentId: "desk one" }), path.join(dataDir, "desktop-plugins-desk-one.json"));
});
