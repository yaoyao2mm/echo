import { config } from "../config.js";
import {
  assertBackendAdapterContract,
  assertBackendRuntimeContract,
  assertBackendSnapshotContract
} from "./backendAdapterContract.js";
import { ClaudeCodeBackendAdapter } from "./claudeCodeBackendAdapter.js";
import { CodexBackendAdapter } from "./codexBackendAdapter.js";

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

export function desktopRuntimeSnapshot(backends) {
  const snapshots = Array.from(backends.values())
    .map((adapter) => {
      const snapshot = adapter.snapshot();
      return assertBackendSnapshotContract(snapshot, { backendId: snapshot?.backendId });
    })
    .filter(Boolean);
  const primary = selectPrimarySnapshot(snapshots);
  if (!primary) return {};
  return {
    ...primary,
    defaultBackendId: primary.backendId,
    backends: snapshots
  };
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
  return desktopRuntimeSnapshot(backends);
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
