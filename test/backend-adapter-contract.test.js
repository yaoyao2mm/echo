import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  assertBackendAdapterContract,
  assertBackendRuntimeContract,
  backendAdapterContractVersion,
  validateBackendSnapshot
} from "../src/lib/backendAdapterContract.js";
import { ClaudeCodeBackendAdapter } from "../src/lib/claudeCodeBackendAdapter.js";
import { CodexBackendAdapter } from "../src/lib/codexBackendAdapter.js";
import { createDesktopRuntimeMap, desktopRuntimeSnapshot } from "../src/lib/desktopBackendRegistry.js";
import { deepSeekClaudeDefaultModel, deepSeekClaudeModelIds } from "../src/lib/deepSeekClaude.js";
import { volcengineCodingPlanModelIds, volcengineCodingPlanProvider } from "../src/lib/volcengineCodingPlan.js";

function codexSnapshot(overrides = {}) {
  return {
    backendId: "codex",
    provider: "codex",
    backendName: "Codex",
    command: "codex",
    commandSource: "shell-command",
    commandDetail: "Using codex.",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalTimeoutMs: 300000,
    model: "gpt-5.5",
    supportedModels: [{ id: "gpt-5.5", displayName: "GPT-5.5" }],
    unsupportedModels: [],
    allowedPermissionModes: ["strict", "approve", "full"],
    reasoningEffort: "medium",
    profile: "approve",
    permissionMode: "approve",
    timeoutMs: 1800000,
    worktreeMode: "optional",
    modelCapabilitySource: "codex-app-server",
    modelCapabilityCheckedAt: "2026-05-07T00:00:00.000Z",
    modelCapabilityError: "",
    ...overrides
  };
}

function claudeSnapshot(overrides = {}) {
  return {
    backendId: "claude-code",
    provider: "deepseek-via-claude",
    backendName: "Claude Code",
    command: "claude",
    commandSource: "shell-command",
    commandDetail: "Using claude.",
    sandbox: "read-only",
    approvalPolicy: "on-request",
    approvalTimeoutMs: 300000,
    model: deepSeekClaudeDefaultModel,
    supportedModels: [
      { id: deepSeekClaudeDefaultModel, displayName: "DeepSeek-V4-Pro[1M]", isDefault: true },
      { id: "deepseek-v4-flash", displayName: "DeepSeek-V4-Flash" }
    ],
    unsupportedModels: [],
    allowedPermissionModes: ["strict"],
    reasoningEffort: "",
    profile: "strict",
    permissionMode: "strict",
    timeoutMs: 1800000,
    worktreeMode: "optional",
    baseUrl: "https://api.deepseek.com/anthropic",
    modelCapabilitySource: "config",
    modelCapabilityCheckedAt: "",
    modelCapabilityError: "",
    ...overrides
  };
}

function contractRuntime(options = {}) {
  return {
    options,
    async handleCommand() {
      return { ok: true, sessionStatus: "active" };
    },
    stop() {}
  };
}

test("backend adapter snapshots expose the v1 compatibility contract for Codex and Claude", () => {
  const codex = new CodexBackendAdapter({
    runtimeSnapshotFactory: () => codexSnapshot(),
    runtimeFactory: contractRuntime,
    probeModels: async () => []
  });
  const claude = new ClaudeCodeBackendAdapter({
    runtimeSnapshotFactory: () => claudeSnapshot(),
    runtimeFactory: contractRuntime,
    probeModels: async () => []
  });

  assertBackendAdapterContract(codex, { backendId: "codex" });
  assertBackendAdapterContract(claude, { backendId: "claude-code" });

  const codexRuntime = codex.snapshot();
  assert.equal(codexRuntime.contractVersion, backendAdapterContractVersion);
  assert.deepEqual(codexRuntime.supportedPermissionModes, ["strict", "approve", "full"]);
  assert.equal(codexRuntime.capabilities.supports.attachments, true);
  assert.equal(codexRuntime.capabilities.supports.compaction, true);
  assert.equal(codexRuntime.capabilities.supports.approvalRequests, true);
  assert.equal(codexRuntime.capabilities.supports.interactionRequests, true);
  assert.equal(codexRuntime.capabilities.supports.gitSummary, true);
  assert.equal(codexRuntime.capabilities.supports.worktree, true);
  assert.equal(codexRuntime.health.state, "ready");
  assert.equal(codexRuntime.health.ok, true);

  const claudeRuntime = claude.snapshot();
  assert.equal(claudeRuntime.contractVersion, backendAdapterContractVersion);
  assert.equal(claudeRuntime.provider, "deepseek-via-claude");
  assert.deepEqual(claudeRuntime.supportedPermissionModes, ["strict", "approve", "full"]);
  assert.equal(claudeRuntime.capabilities.supports.attachments, false);
  assert.equal(claudeRuntime.capabilities.supports.contextUsage, true);
  assert.equal(claudeRuntime.capabilities.supports.compaction, false);
  assert.equal(claudeRuntime.capabilities.supports.approvalRequests, false);
  assert.equal(claudeRuntime.capabilities.supports.interactionRequests, false);
  assert.equal(claudeRuntime.capabilities.supports.gitSummary, true);
  assert.equal(claudeRuntime.capabilities.supports.worktree, true);
  assert.equal(claudeRuntime.unsupportedFeatures.includes("attachments"), true);
  assert.equal(claudeRuntime.unsupportedFeatures.includes("remote-context-compaction"), true);
  assert.equal(claudeRuntime.health.state, "ready");
});

test("desktop registry publishes contract-validated backend roster and runtime objects", () => {
  const backends = new Map([
    [
      "claude-code",
      new ClaudeCodeBackendAdapter({
        agentId: "agent-contract",
        runtimeSnapshotFactory: () => claudeSnapshot(),
        runtimeFactory: contractRuntime,
        probeModels: async () => []
      })
    ],
    [
      "codex",
      new CodexBackendAdapter({
        agentId: "agent-contract",
        runtimeSnapshotFactory: () => codexSnapshot(),
        runtimeFactory: contractRuntime,
        probeModels: async () => []
      })
    ]
  ]);

  const snapshot = desktopRuntimeSnapshot(backends, { sessionConcurrency: 6 });
  assert.equal(snapshot.backendId, "codex");
  assert.equal(snapshot.defaultBackendId, "codex");
  assert.equal(snapshot.plugins.capability.canManage, true);
  assert.equal(snapshot.plugins.plugins[0].id, "open-spec");
  assert.equal(snapshot.plugins.plugins[0].enabled, true);
  assert.equal(snapshot.capabilities.orchestration.maxConcurrency, 6);
  assert.equal(snapshot.backends.every((backend) => backend.capabilities.orchestration.maxConcurrency === 6), true);
  assert.deepEqual(snapshot.backends.map((backend) => backend.backendId), ["claude-code", "codex"]);
  for (const backend of snapshot.backends) {
    assert.equal(validateBackendSnapshot(backend).ok, true);
  }

  const runtimes = createDesktopRuntimeMap(backends, { onEvents: () => {} });
  assertBackendRuntimeContract(runtimes.get("codex"), { backendId: "codex" });
  assertBackendRuntimeContract(runtimes.get("claude-code"), { backendId: "claude-code" });
  assert.equal(runtimes.get("codex").options.agentId, "agent-contract");
  assert.equal(runtimes.get("claude-code").options.agentId, "agent-contract");
});

test("backend health check distinguishes unavailable and degraded backends", async () => {
  const missingCodex = new CodexBackendAdapter({
    runtimeSnapshotFactory: () => codexSnapshot({ command: "", commandSource: "missing-codex-app" }),
    runtimeFactory: contractRuntime,
    probeModels: async () => []
  });
  const missingHealth = await missingCodex.healthCheck();
  assert.equal(missingHealth.state, "unavailable");
  assert.equal(missingHealth.ok, false);
  assert.equal(missingHealth.checks.command, false);

  const degradedClaude = new ClaudeCodeBackendAdapter({
    runtimeSnapshotFactory: () => claudeSnapshot({ modelCapabilitySource: "unavailable", modelCapabilityError: "DeepSeek model probe failed" }),
    runtimeFactory: contractRuntime,
    probeModels: async () => []
  });
  const degradedHealth = await degradedClaude.healthCheck();
  assert.equal(degradedHealth.state, "degraded");
  assert.equal(degradedHealth.ok, false);
  assert.equal(degradedHealth.checks.command, true);
  assert.equal(degradedHealth.checks.modelProbe, false);
  assert.match(degradedHealth.reason, /DeepSeek model probe failed/);
});

test("backend capability refresh updates health after model probe failures", async () => {
  const adapter = new ClaudeCodeBackendAdapter({
    runtimeSnapshotFactory: () => claudeSnapshot(),
    runtimeFactory: contractRuntime,
    probeModels: async () => {
      throw new Error("DeepSeek model probe failed");
    }
  });

  const refreshed = await adapter.refreshCapabilities();
  assert.equal(refreshed.modelCapabilitySource, "unavailable");
  assert.equal(refreshed.health.state, "degraded");
  assert.equal(refreshed.health.ok, false);
  assert.equal(refreshed.health.checks.command, true);
  assert.equal(refreshed.health.checks.modelProbe, false);
  assert.match(refreshed.health.reason, /DeepSeek model probe failed/);
});

test("Claude backend adapter can publish a separate configured backend profile", async () => {
  const adapter = new ClaudeCodeBackendAdapter({
    backendConfig: {
      backendId: "deepseek-code",
      provider: "deepseek-via-claude",
      backendName: "DeepSeek Code",
      command: "claude",
      baseUrl: "https://api.deepseek.com/anthropic",
      authToken: "test-token",
      supportedModels: ["deepseek-v4-flash"],
      allowedPermissionModes: "strict,approve",
      permissionMode: "strict",
      worktreeMode: "always"
    },
    runtimeFactory: contractRuntime,
    probeModels: async () => [{ id: "deepseek-v4-pro[1m]", displayName: "DeepSeek-V4-Pro[1M]" }]
  });

  assertBackendAdapterContract(adapter, { backendId: "deepseek-code" });
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.backendId, "deepseek-code");
  assert.equal(snapshot.provider, "deepseek-via-claude");
  assert.equal(snapshot.backendName, "DeepSeek Code");
  assert.equal(snapshot.supportedModels[0].id, "deepseek-v4-flash");
  assert.deepEqual(snapshot.allowedPermissionModes, ["strict", "approve"]);
  assert.deepEqual(snapshot.supportedPermissionModes, ["strict", "approve", "full"]);
  assert.equal(snapshot.worktreeMode, "always");

  const refreshed = await adapter.refreshCapabilities();
  assert.equal(refreshed.modelCapabilitySource, "deepseek-models-api");
  assert.equal(refreshed.supportedModels[0].id, "deepseek-v4-pro[1m]");
});

test("Claude backend adapter publishes the Volcengine Coding Plan model roster when pointed at the Coding Plan base URL", async () => {
  const adapter = new ClaudeCodeBackendAdapter({
    backendConfig: {
      backendId: "claude-code",
      provider: volcengineCodingPlanProvider,
      backendName: "Claude Code",
      command: "claude",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
      authToken: "test-token",
      permissionMode: "strict",
      allowedPermissionModes: "strict",
      worktreeMode: "optional"
    },
    runtimeFactory: contractRuntime
  });

  assertBackendAdapterContract(adapter, { backendId: "claude-code" });
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.backendId, "claude-code");
  assert.equal(snapshot.provider, volcengineCodingPlanProvider);
  assert.equal(snapshot.backendName, "Claude Code");
  assert.deepEqual(snapshot.supportedModels.map((model) => model.id), volcengineCodingPlanModelIds());
  assert.equal(snapshot.supportedModels[0].isDefault, true);
  assert.equal(snapshot.modelCapabilitySource, "volcengine-coding-plan");

  const refreshed = await adapter.refreshCapabilities();
  assert.equal(refreshed.modelCapabilitySource, "volcengine-coding-plan");
  assert.deepEqual(refreshed.supportedModels.map((model) => model.id), volcengineCodingPlanModelIds());
});

test("Volcengine Coding Plan configures the built-in Claude Code backend from environment variables", () => {
  const script = `
    process.env.ECHO_CODEX_ENABLED = "false";
    process.env.ECHO_CLAUDE_ENABLED = "";
    process.env.ECHO_CLAUDE_COMMAND = "";
    process.env.ECHO_CLAUDE_BASE_URL = "";
    process.env.ECHO_CLAUDE_AUTH_TOKEN = "";
    process.env.ECHO_CLAUDE_MODEL = "";
    process.env.ECHO_CLAUDE_SUPPORTED_MODELS = "";
    process.env.ECHO_CLAUDE_PERMISSION_MODE = "";
    process.env.ECHO_CLAUDE_PROFILE = "";
    process.env.ECHO_CLAUDE_ALLOWED_PERMISSION_MODES = "";
    process.env.ECHO_CLAUDE_REASONING_EFFORT = "";
    process.env.ECHO_CLAUDE_APPROVAL_TIMEOUT_MS = "";
    process.env.ECHO_CLAUDE_TIMEOUT_MS = "";
    process.env.ECHO_CLAUDE_WORKTREE_MODE = "";
    process.env.ECHO_CLAUDE_SUBAGENT_MODEL = "";
    process.env.ECHO_CLAUDE_AGENT_TEAMS_ENABLED = "";
    process.env.ANTHROPIC_BASE_URL = "";
    process.env.ANTHROPIC_AUTH_TOKEN = "";
    process.env.ANTHROPIC_API_KEY = "";
    process.env.ECHO_VOLCENGINE_CODING_ENABLED = "true";
    process.env.ECHO_VOLCENGINE_CODING_BACKEND_ID = "volcengine-coding-plan";
    process.env.ECHO_AGENT_BACKENDS_JSON = "";
    process.env.ECHO_BACKENDS_JSON = "";
    process.env.ECHO_CLAUDE_SUPPORTED_MODELS = "";
    process.env.ECHO_VOLCENGINE_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding";
    process.env.ECHO_VOLCENGINE_CODING_MODEL = "";
    process.env.ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS = "";
    process.env.METIO_VOLCENGINE_CODING_API_KEY = "test-token";
    process.env.VOLCENGINE_CODING_API_KEY = "test-token";
    const { config } = await import(${JSON.stringify(path.join(process.cwd(), "src/config.js"))});
    const { createDesktopBackends, desktopRuntimeSnapshot } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/desktopBackendRegistry.js"))});
    const snapshot = desktopRuntimeSnapshot(createDesktopBackends({ agentId: "agent-contract" }));
    console.log(JSON.stringify({
      claude: {
        enabled: config.claude.enabled,
        backendId: config.claude.backendId,
        provider: config.claude.provider,
        backendName: config.claude.backendName,
        baseUrl: config.claude.baseUrl,
        model: config.claude.model,
        supportedModels: config.claude.supportedModels,
        permissionMode: config.claude.permissionMode,
        allowedPermissionModes: config.claude.allowedPermissionModes
      },
      agentBackends: config.agentBackends,
      roster: snapshot.backends.map((backend) => ({
        backendId: backend.backendId,
        provider: backend.provider,
        backendName: backend.backendName,
        supportedModels: backend.supportedModels.map((model) => model.id),
        permissionMode: backend.permissionMode,
        allowedPermissionModes: backend.allowedPermissionModes
      }))
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      ECHO_CODEX_ENABLED: "false",
      ECHO_CLAUDE_ENABLED: "",
      ECHO_CLAUDE_COMMAND: "",
      ECHO_CLAUDE_BASE_URL: "",
      ECHO_CLAUDE_AUTH_TOKEN: "",
      ECHO_CLAUDE_MODEL: "",
      ECHO_CLAUDE_SUPPORTED_MODELS: "",
      ECHO_CLAUDE_PERMISSION_MODE: "",
      ECHO_CLAUDE_PROFILE: "",
      ECHO_CLAUDE_ALLOWED_PERMISSION_MODES: "",
      ECHO_CLAUDE_REASONING_EFFORT: "",
      ECHO_CLAUDE_APPROVAL_TIMEOUT_MS: "",
      ECHO_CLAUDE_TIMEOUT_MS: "",
      ECHO_CLAUDE_WORKTREE_MODE: "",
      ECHO_CLAUDE_SUBAGENT_MODEL: "",
      ECHO_CLAUDE_AGENT_TEAMS_ENABLED: "",
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
      ECHO_VOLCENGINE_CODING_ENABLED: "true",
      ECHO_VOLCENGINE_CODING_BACKEND_ID: "volcengine-coding-plan",
      ECHO_AGENT_BACKENDS_JSON: "",
      ECHO_BACKENDS_JSON: "",
      ECHO_CLAUDE_SUPPORTED_MODELS: "",
      ECHO_VOLCENGINE_CODING_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding",
      ECHO_VOLCENGINE_CODING_MODEL: "",
      ECHO_VOLCENGINE_CODING_PERMISSION_MODE: "",
      ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS: "",
      ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES: "",
      METIO_VOLCENGINE_CODING_API_KEY: "test-token",
      VOLCENGINE_CODING_API_KEY: "test-token"
    }
  }).toString("utf8").trim();

  const result = JSON.parse(output);
  assert.equal(result.claude.enabled, true);
  assert.equal(result.claude.backendId, "claude-code");
  assert.equal(result.claude.provider, "volcengine-coding-plan");
  assert.equal(result.claude.backendName, "Claude Code");
  assert.equal(result.claude.baseUrl, "https://ark.cn-beijing.volces.com/api/coding");
  assert.equal(result.claude.model, "ark-code-latest");
  assert.deepEqual(result.claude.supportedModels, volcengineCodingPlanModelIds());
  assert.equal(result.claude.permissionMode, "full");
  assert.equal(result.claude.allowedPermissionModes, "strict,approve,full");
  assert.deepEqual(result.agentBackends, []);
  assert.deepEqual(result.roster.map((backend) => backend.backendId), ["claude-code"]);
  assert.equal(result.roster[0].backendName, "Claude Code");
  assert.deepEqual(result.roster[0].supportedModels, volcengineCodingPlanModelIds());
  assert.equal(result.roster[0].permissionMode, "full");
  assert.deepEqual(result.roster[0].allowedPermissionModes, ["strict", "approve", "full"]);
});

test("Claude DeepSeek config defaults to the Claude Code compatible model roster", () => {
  const script = `
    process.env.ECHO_CODEX_ENABLED = "false";
    process.env.ECHO_CLAUDE_ENABLED = "true";
    process.env.ECHO_CLAUDE_COMMAND = "claude";
    process.env.ECHO_CLAUDE_BASE_URL = "https://api.deepseek.com/anthropic";
    process.env.ECHO_CLAUDE_AUTH_TOKEN = "deepseek-token";
    process.env.ECHO_CLAUDE_MODEL = "";
    process.env.ECHO_CLAUDE_SUPPORTED_MODELS = "";
    process.env.ECHO_CLAUDE_PERMISSION_MODE = "";
    process.env.ECHO_CLAUDE_PROFILE = "";
    process.env.ECHO_CLAUDE_ALLOWED_PERMISSION_MODES = "";
    process.env.ECHO_CLAUDE_REASONING_EFFORT = "";
    process.env.ECHO_CLAUDE_SUBAGENT_MODEL = "";
    process.env.ECHO_CLAUDE_AGENT_TEAMS_ENABLED = "";
    process.env.ECHO_VOLCENGINE_CODING_ENABLED = "false";
    process.env.ECHO_AGENT_BACKENDS_JSON = "";
    process.env.ECHO_BACKENDS_JSON = "";
    const { config } = await import(${JSON.stringify(path.join(process.cwd(), "src/config.js"))});
    const { createDesktopBackends, desktopRuntimeSnapshot } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/desktopBackendRegistry.js"))});
    const snapshot = desktopRuntimeSnapshot(createDesktopBackends({ agentId: "agent-contract" }));
    console.log(JSON.stringify({
      claude: {
        provider: config.claude.provider,
        model: config.claude.model,
        reasoningEffort: config.claude.reasoningEffort,
        supportedModels: config.claude.supportedModels
      },
      roster: snapshot.backends.map((backend) => ({
        backendId: backend.backendId,
        provider: backend.provider,
        model: backend.model,
        reasoningEffort: backend.reasoningEffort,
        supportedModels: backend.supportedModels.map((model) => model.id)
      }))
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      ECHO_CODEX_ENABLED: "false",
      ECHO_CLAUDE_ENABLED: "true",
      ECHO_CLAUDE_COMMAND: "claude",
      ECHO_CLAUDE_BASE_URL: "https://api.deepseek.com/anthropic",
      ECHO_CLAUDE_AUTH_TOKEN: "deepseek-token",
      ECHO_CLAUDE_MODEL: "",
      ECHO_CLAUDE_SUPPORTED_MODELS: "",
      ECHO_CLAUDE_PERMISSION_MODE: "",
      ECHO_CLAUDE_PROFILE: "",
      ECHO_CLAUDE_ALLOWED_PERMISSION_MODES: "",
      ECHO_CLAUDE_REASONING_EFFORT: "",
      ECHO_CLAUDE_SUBAGENT_MODEL: "",
      ECHO_CLAUDE_AGENT_TEAMS_ENABLED: "",
      ECHO_VOLCENGINE_CODING_ENABLED: "false",
      ECHO_AGENT_BACKENDS_JSON: "",
      ECHO_BACKENDS_JSON: ""
    }
  }).toString("utf8").trim();

  const result = JSON.parse(output);
  assert.equal(result.claude.provider, "deepseek-via-claude");
  assert.equal(result.claude.model, deepSeekClaudeDefaultModel);
  assert.equal(result.claude.reasoningEffort, "xhigh");
  assert.deepEqual(result.claude.supportedModels, deepSeekClaudeModelIds());
  assert.equal(result.roster[0].provider, "deepseek-via-claude");
  assert.equal(result.roster[0].model, deepSeekClaudeDefaultModel);
  assert.equal(result.roster[0].reasoningEffort, "xhigh");
  assert.deepEqual(result.roster[0].supportedModels, deepSeekClaudeModelIds());
});

test("explicit Claude DeepSeek settings are preserved when Volcengine Coding Plan is also enabled", () => {
  const script = `
    process.env.ECHO_CODEX_ENABLED = "false";
    process.env.ECHO_CLAUDE_ENABLED = "true";
    process.env.ECHO_CLAUDE_COMMAND = "claude";
    process.env.ECHO_CLAUDE_BASE_URL = "https://api.deepseek.com/anthropic";
    process.env.ECHO_CLAUDE_AUTH_TOKEN = "deepseek-token";
    process.env.ECHO_CLAUDE_MODEL = "deepseek-v4-flash";
    process.env.ECHO_CLAUDE_SUPPORTED_MODELS = "";
    process.env.ECHO_VOLCENGINE_CODING_ENABLED = "true";
    process.env.ECHO_VOLCENGINE_CODING_BACKEND_ID = "volcengine-coding-plan";
    process.env.ECHO_VOLCENGINE_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding";
    process.env.ECHO_VOLCENGINE_CODING_MODEL = "ark-code-latest";
    process.env.ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS = "";
    process.env.METIO_VOLCENGINE_CODING_API_KEY = "test-token";
    process.env.VOLCENGINE_CODING_API_KEY = "test-token";
    const { config } = await import(${JSON.stringify(path.join(process.cwd(), "src/config.js"))});
    const { createDesktopBackends, desktopRuntimeSnapshot } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/desktopBackendRegistry.js"))});
    const snapshot = desktopRuntimeSnapshot(createDesktopBackends({ agentId: "agent-contract" }));
    console.log(JSON.stringify({
      claude: {
        enabled: config.claude.enabled,
        backendId: config.claude.backendId,
        provider: config.claude.provider,
        backendName: config.claude.backendName,
        baseUrl: config.claude.baseUrl,
        model: config.claude.model,
        supportedModels: config.claude.supportedModels
      },
      agentBackends: config.agentBackends.map((backend) => ({
        backendId: backend.backendId,
        provider: backend.provider,
        backendName: backend.backendName,
        baseUrl: backend.baseUrl,
        model: backend.model,
        supportedModels: backend.supportedModels,
        permissionMode: backend.permissionMode,
        allowedPermissionModes: backend.allowedPermissionModes
      })),
      roster: snapshot.backends.map((backend) => ({
        backendId: backend.backendId,
        provider: backend.provider,
        backendName: backend.backendName,
        baseUrl: backend.baseUrl,
        model: backend.model,
        supportedModels: backend.supportedModels.map((model) => model.id),
        permissionMode: backend.permissionMode,
        allowedPermissionModes: backend.allowedPermissionModes
      }))
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      ECHO_CODEX_ENABLED: "false",
      ECHO_CLAUDE_ENABLED: "true",
      ECHO_CLAUDE_COMMAND: "claude",
      ECHO_CLAUDE_BASE_URL: "https://api.deepseek.com/anthropic",
      ECHO_CLAUDE_AUTH_TOKEN: "deepseek-token",
      ECHO_CLAUDE_MODEL: "deepseek-v4-flash",
      ECHO_CLAUDE_SUPPORTED_MODELS: "",
      ECHO_VOLCENGINE_CODING_ENABLED: "true",
      ECHO_VOLCENGINE_CODING_BACKEND_ID: "volcengine-coding-plan",
      ECHO_VOLCENGINE_CODING_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding",
      ECHO_VOLCENGINE_CODING_MODEL: "ark-code-latest",
      ECHO_VOLCENGINE_CODING_PERMISSION_MODE: "",
      ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS: "",
      ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES: "",
      METIO_VOLCENGINE_CODING_API_KEY: "test-token",
      VOLCENGINE_CODING_API_KEY: "test-token"
    }
  }).toString("utf8").trim();

  const result = JSON.parse(output);
  assert.equal(result.claude.enabled, true);
  assert.equal(result.claude.backendId, "claude-code");
  assert.equal(result.claude.provider, "deepseek-via-claude");
  assert.equal(result.claude.backendName, "Claude Code");
  assert.equal(result.claude.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(result.claude.model, "deepseek-v4-flash");
  assert.deepEqual(result.claude.supportedModels, deepSeekClaudeModelIds());
  assert.deepEqual(result.agentBackends.map((backend) => backend.backendId), ["volcengine-coding-plan"]);
  assert.equal(result.agentBackends[0].provider, "volcengine-coding-plan");
  assert.equal(result.agentBackends[0].backendName, "Claude Code");
  assert.equal(result.agentBackends[0].baseUrl, "https://ark.cn-beijing.volces.com/api/coding");
  assert.equal(result.agentBackends[0].model, "ark-code-latest");
  assert.deepEqual(result.agentBackends[0].supportedModels, volcengineCodingPlanModelIds());
  assert.equal(result.agentBackends[0].permissionMode, "full");
  assert.equal(result.agentBackends[0].allowedPermissionModes, "strict,approve,full");
  assert.deepEqual(result.roster.map((backend) => backend.backendId), ["claude-code", "volcengine-coding-plan"]);
  assert.equal(result.roster[0].provider, "deepseek-via-claude");
  assert.equal(result.roster[0].baseUrl, "https://api.deepseek.com/anthropic");
  assert.deepEqual(result.roster[0].supportedModels, deepSeekClaudeModelIds());
  assert.equal(result.roster[1].provider, "volcengine-coding-plan");
  assert.equal(result.roster[1].backendName, "Claude Code");
  assert.equal(result.roster[1].baseUrl, "https://ark.cn-beijing.volces.com/api/coding");
  assert.equal(result.roster[1].permissionMode, "full");
  assert.deepEqual(result.roster[1].allowedPermissionModes, ["strict", "approve", "full"]);
  assert.equal(result.roster[1].model, "ark-code-latest");
  assert.deepEqual(result.roster[1].supportedModels, volcengineCodingPlanModelIds());
});

test("custom Volcengine Coding Plan backend defaults to full Claude permissions", () => {
  const script = `
    process.env.ECHO_CODEX_ENABLED = "false";
    process.env.ECHO_CLAUDE_ENABLED = "false";
    process.env.ECHO_VOLCENGINE_CODING_ENABLED = "";
    process.env.ECHO_AGENT_BACKENDS_JSON = JSON.stringify({
      type: "claude-code",
      backendId: "volcengine-coding-plan",
      provider: "volcengine-coding-plan",
      backendName: "Claude Code",
      command: "claude",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
      authToken: "test-token",
      model: "ark-code-latest"
    });
    const { config } = await import(${JSON.stringify(path.join(process.cwd(), "src/config.js"))});
    const { createDesktopBackends, desktopRuntimeSnapshot } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/desktopBackendRegistry.js"))});
    const snapshot = desktopRuntimeSnapshot(createDesktopBackends({ agentId: "agent-contract" }));
    console.log(JSON.stringify({
      agentBackends: config.agentBackends.map((backend) => ({
        backendId: backend.backendId,
        permissionMode: backend.permissionMode,
        allowedPermissionModes: backend.allowedPermissionModes
      })),
      roster: snapshot.backends.map((backend) => ({
        backendId: backend.backendId,
        permissionMode: backend.permissionMode,
        allowedPermissionModes: backend.allowedPermissionModes
      }))
    }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      ECHO_CODEX_ENABLED: "false",
      ECHO_CLAUDE_ENABLED: "false",
      ECHO_VOLCENGINE_CODING_ENABLED: "",
      ECHO_AGENT_BACKENDS_JSON: ""
    }
  }).toString("utf8").trim();

  const result = JSON.parse(output);
  assert.deepEqual(result.agentBackends, [
    {
      backendId: "volcengine-coding-plan",
      permissionMode: "full",
      allowedPermissionModes: "strict,approve,full"
    }
  ]);
  assert.deepEqual(result.roster, [
    {
      backendId: "volcengine-coding-plan",
      permissionMode: "full",
      allowedPermissionModes: ["strict", "approve", "full"]
    }
  ]);
});

test("backend contract rejects runtimes without cancellation stop support", () => {
  const adapter = new CodexBackendAdapter({
    runtimeSnapshotFactory: () => codexSnapshot(),
    runtimeFactory: () => ({
      async handleCommand() {
        return { ok: true };
      }
    }),
    probeModels: async () => []
  });

  assert.throws(
    () => createDesktopRuntimeMap(new Map([["codex", adapter]])),
    /runtime\.stop must be a function/
  );
});
