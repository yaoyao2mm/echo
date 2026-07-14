import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const builtInPlugins = Object.freeze([
  Object.freeze({
    id: "open-spec",
    name: "OpenSpec",
    description: "在移动端查看工作区 OpenSpec 变更、规范与任务进度",
    version: "1.0.0",
    source: Object.freeze({ kind: "echo-builtin", label: "Echo 内建" }),
    capabilities: Object.freeze(["open-spec.summary", "open-spec.mobile-progress"]),
    defaultEnabled: true,
    requires: Object.freeze([]),
    prerequisites: Object.freeze({})
  }),
  Object.freeze({
    id: "orchestration",
    name: "编排",
    description: "隔离实施、验收并集成多个 OpenSpec change",
    version: "1.0.0",
    source: Object.freeze({ kind: "echo-builtin", label: "Echo 内建" }),
    capabilities: Object.freeze([
      "orchestration.plan",
      "orchestration.execute",
      "orchestration.integrate",
      "orchestration.mobile-workbench"
    ]),
    defaultEnabled: false,
    requires: Object.freeze(["open-spec"]),
    prerequisites: Object.freeze({ managedWorktree: true })
  })
]);

export function desktopPluginRegistry(options = {}) {
  const state = normalizeDesktopPluginState(options.state || readDesktopPluginState(options));
  const plugins = builtInPlugins.map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    source: { ...plugin.source },
    capabilities: [...plugin.capabilities],
    requires: [...plugin.requires],
    prerequisites: publicPluginPrerequisites(plugin, options),
    enabled: state.plugins?.[plugin.id]?.enabled ?? plugin.defaultEnabled
  }));
  return {
    version: 1,
    capability: {
      canManage: true,
      commandTypes: ["plugin.list", "plugin.update"]
    },
    plugins,
    summary: {
      total: plugins.length,
      enabled: plugins.filter((plugin) => plugin.enabled).length,
      disabled: plugins.filter((plugin) => !plugin.enabled).length
    }
  };
}

export function updateDesktopPluginState(input = {}, options = {}) {
  const pluginId = normalizePluginId(input.pluginId || input.id);
  const registry = desktopPluginRegistry(options);
  const plugin = registry.plugins.find((item) => item.id === pluginId);
  if (!plugin) return pluginError("Unknown desktop plugin.");
  if (typeof input.enabled !== "boolean") return pluginError("Plugin enabled state is required.");

  if (input.enabled) {
    const missingPlugin = plugin.requires.find((id) => !registry.plugins.some((item) => item.id === id && item.enabled));
    if (missingPlugin) return pluginError(`Plugin dependency is disabled: ${missingPlugin}.`, "PLUGIN_DEPENDENCY_DISABLED");
    if (pluginId === "orchestration" && plugin.prerequisites.managedWorktree !== true) {
      return pluginError("Managed Worktree capability is unavailable.", "MANAGED_WORKTREE_UNAVAILABLE");
    }
  } else {
    const dependent = registry.plugins.find((item) => item.enabled && item.requires.includes(pluginId));
    if (dependent) return pluginError(`Disable dependent plugin first: ${dependent.id}.`, "PLUGIN_DEPENDENT_ENABLED");
    if (pluginId === "orchestration" && hasActiveOrchestrationWork(options)) {
      return pluginError(
        "Orchestration is active. Pause, cancel, or let the current attempt reach a safe boundary before disabling it.",
        "PLUGIN_DRAIN_REQUIRED"
      );
    }
  }

  const state = normalizeDesktopPluginState(readDesktopPluginState(options));
  writeDesktopPluginState({
    version: 1,
    plugins: {
      ...(state.plugins || {}),
      [pluginId]: { enabled: input.enabled }
    }
  }, options);
  const nextRegistry = desktopPluginRegistry(options);
  return {
    ok: true,
    plugin: nextRegistry.plugins.find((item) => item.id === pluginId) || null,
    plugins: nextRegistry,
    error: ""
  };
}

export function isDesktopPluginEnabled(pluginId, options = {}) {
  const id = normalizePluginId(pluginId);
  return desktopPluginRegistry(options).plugins.some((plugin) => plugin.id === id && plugin.enabled);
}

export function readDesktopPluginState(options = {}) {
  try {
    return JSON.parse(fs.readFileSync(desktopPluginStatePath(options), "utf8"));
  } catch {
    return { version: 1, plugins: {} };
  }
}

export function writeDesktopPluginState(state = {}, options = {}) {
  const filePath = desktopPluginStatePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(normalizeDesktopPluginState(state), null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
}

export function desktopPluginStatePath(options = {}) {
  if (options.statePath) return path.resolve(String(options.statePath));
  const dataDir = options.dataDir ? path.resolve(String(options.dataDir)) : path.join(os.homedir(), ".echo-voice");
  const agentId = normalizeAgentId(options.agentId || process.env.ECHO_AGENT_ID || "");
  return path.join(dataDir, agentId ? `desktop-plugins-${agentId}.json` : "desktop-plugins.json");
}

function normalizeDesktopPluginState(state = {}) {
  const normalized = { version: 1, plugins: {} };
  if (!state || typeof state !== "object" || !state.plugins || typeof state.plugins !== "object") return normalized;
  for (const [rawId, desired] of Object.entries(state.plugins)) {
    const id = normalizePluginId(rawId);
    if (!id || !desired || typeof desired !== "object" || typeof desired.enabled !== "boolean") continue;
    normalized.plugins[id] = { enabled: desired.enabled };
  }
  return normalized;
}

function normalizePluginId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeAgentId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function publicPluginPrerequisites(plugin, options = {}) {
  if (!plugin.prerequisites.managedWorktree) return {};
  return { managedWorktree: options.managedWorktreeAvailable === true };
}

function hasActiveOrchestrationWork(options = {}) {
  if (typeof options.hasActiveOrchestrationWork === "function") return options.hasActiveOrchestrationWork() === true;
  return options.hasActiveOrchestrationWork === true;
}

function pluginError(error, code = "PLUGIN_OPERATION_FAILED") {
  return {
    ok: false,
    code,
    error: String(error || "Desktop plugin operation failed.").slice(0, 800)
  };
}
