import assert from "node:assert/strict";
import test from "node:test";
import { CodexBackendAdapter } from "../src/lib/codexBackendAdapter.js";
import { normalizeSupportedModels } from "../src/lib/codexRuntime.js";

function baseRuntimeSnapshot() {
  return {
    backendId: "codex",
    provider: "codex",
    backendName: "Codex",
    command: "codex",
    commandSource: "custom-command",
    commandDetail: "Using codex.",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalTimeoutMs: 300000,
    model: "",
    unsupportedModels: [],
    supportedModels: [],
    allowedPermissionModes: ["strict", "approve", "full"],
    reasoningEffort: "",
    profile: "",
    timeoutMs: 1800000,
    worktreeMode: "off"
  };
}

test("CodexBackendAdapter keeps Codex identity and builds interactive runtimes with the desktop agent id", async () => {
  const createdRuntimeOptions = [];
  const adapter = new CodexBackendAdapter({
    agentId: "agent-1",
    runtimeSnapshotFactory: () => baseRuntimeSnapshot(),
    probeModels: async () => [],
    runtimeFactory: (options = {}) => {
      createdRuntimeOptions.push(options);
      return { options };
    }
  });

  const snapshot = adapter.snapshot();
  assert.equal(snapshot.backendId, "codex");
  assert.equal(snapshot.provider, "codex");
  assert.equal(snapshot.backendName, "Codex");

  const runtime = adapter.createRuntime({
    onEvents: () => {},
    requestApproval: () => {},
    requestInteraction: () => {}
  });

  assert.equal(createdRuntimeOptions.length, 1);
  assert.equal(createdRuntimeOptions[0].agentId, "agent-1");
  assert.equal(typeof createdRuntimeOptions[0].onEvents, "function");
  assert.equal(typeof runtime.options.onEvents, "function");
  assert.equal(runtime.options.agentId, "agent-1");
});

test("CodexBackendAdapter preserves the last successful capability probe while the desktop agent is busy", async () => {
  let probeCount = 0;
  const adapter = new CodexBackendAdapter({
    runtimeSnapshotFactory: () => baseRuntimeSnapshot(),
    probeModels: async () => {
      probeCount += 1;
      return normalizeSupportedModels([
        {
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          description: "Latest reasoning model",
          inputModalities: ["text"]
        }
      ]);
    }
  });

  const refreshed = await adapter.refreshCapabilities({
    activeCommandCount: 0,
    runningSessionCount: 0
  });
  assert.equal(probeCount, 1);
  assert.equal(refreshed.modelCapabilitySource, "codex-app-server");
  assert.equal(refreshed.supportedModels[0].id, "gpt-5.5");
  assert.equal(refreshed.supportedModels[0].displayName, "GPT-5.5");

  const busy = await adapter.refreshCapabilities({
    activeCommandCount: 1,
    runningSessionCount: 0
  });
  assert.equal(probeCount, 1);
  assert.equal(busy.modelCapabilitySource, "codex-app-server");
  assert.equal(busy.supportedModels[0].id, "gpt-5.5");
  assert.equal(busy.supportedModels[0].displayName, "GPT-5.5");
  assert.equal(busy.backendId, "codex");
  assert.equal(busy.provider, "codex");
});
