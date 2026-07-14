import { config } from "../config.js";
import {
  assertBackendAdapterContract,
  assertBackendRuntimeContract,
  assertBackendSnapshotContract
} from "./backendAdapterContract.js";
import { ClaudeCodeBackendAdapter } from "./claudeCodeBackendAdapter.js";
import { CodexBackendAdapter } from "./codexBackendAdapter.js";
import { agentSkillRegistry } from "./agentSkills.js";
import { desktopPluginRegistry } from "./desktopPlugins.js";
import { mcpRuntimeSnapshot, refreshMcpToolSignatures } from "./mcpConfig.js";

export function createDesktopBackends({ agentId }) {
  const backends = new Map();
  if (config.codex.enabled) {
    registerBackend(backends, "codex", new CodexBackendAdapter({ agentId }));
  }
  if (config.claude.enabled) {
    registerBackend(backends, "claude-code", new ClaudeCodeBackendAdapter({ agentId }));
  }
  for (const backendConfig of config.agentBackends || []) {
    if (backendConfig.enabled === false) continue;
    if (backendConfig.type === "claude-code") {
      registerBackend(
        backends,
        backendConfig.backendId,
        new ClaudeCodeBackendAdapter({
          agentId,
          backendConfig
        })
      );
    }
  }
  return backends;
}

export function createDesktopRuntimeMap(backends, runtimeOptions = {}) {
  const runtimes = new Map();
  for (const [backendId, adapter] of backends.entries()) {
    runtimes.set(backendId, assertBackendRuntimeContract(adapter.createRuntime(runtimeOptions), { backendId }));
  }
  return runtimes;
}

export function desktopRuntimeSnapshot(backends, options = {}) {
  const skillRegistry = agentSkillRegistry(options);
  const plugins = desktopPluginRegistry(options);
  const installedSkills = skillRegistry.installedSkills;
  const mcp = mcpRuntimeSnapshot();
  const orchestrationMaxConcurrency = normalizeConcurrency(options.sessionConcurrency);
  const snapshots = Array.from(backends.values())
    .map((adapter) => {
      const snapshot = adapter.snapshot();
      const normalized = assertBackendSnapshotContract(snapshot, { backendId: snapshot?.backendId });
      return {
        ...normalized,
        capabilities: {
          ...(normalized.capabilities || {}),
          orchestration: { maxConcurrency: orchestrationMaxConcurrency }
        },
        installedSkills,
        agentSkills: skillRegistry,
        plugins
      };
    })
    .filter(Boolean);
  const primary = selectPrimarySnapshot(snapshots);
  if (!primary) return {};
  return {
    ...primary,
    defaultBackendId: primary.backendId,
    installedSkills,
    agentSkills: skillRegistry,
    plugins,
    mcp,
    backends: snapshots
  };
}

function normalizeConcurrency(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(8, Math.trunc(parsed))) : 1;
}

export async function refreshDesktopBackendCapabilities(backends, options = {}) {
  await Promise.all(
    Array.from(backends.values()).map((adapter) =>
      adapter.refreshCapabilities({
        activeCommandCount: options.activeCommandCount,
        runningSessionCount: options.runningSessionCount
      })
    )
  );
  await refreshMcpToolSignatures({ force: true }).catch(() => {});
  return desktopRuntimeSnapshot(backends, options);
}

function selectPrimarySnapshot(snapshots = []) {
  if (snapshots.length === 0) return null;
  return snapshots.find((snapshot) => snapshot.backendId === "codex") || snapshots[0];
}

function registerBackend(backends, backendId, adapter) {
  const id = String(backendId || "").trim();
  if (!id) return;
  if (backends.has(id)) {
    console.warn(`Skipping duplicate desktop backend id: ${id}`);
    return;
  }
  backends.set(id, assertBackendAdapterContract(adapter, { backendId: id }));
}
