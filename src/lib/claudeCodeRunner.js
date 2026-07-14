import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { httpFetch, buildProxyEnv } from "./http.js";
import { buildAgentProcessEnv } from "./agentProcessEnv.js";
import {
  isVolcengineCodingPlanBaseUrl,
  volcengineCodingPlanModelInfo,
  volcengineCodingPlanModels,
  volcengineCodingPlanProvider
} from "./volcengineCodingPlan.js";
import {
  deepSeekClaudeDefaultModel,
  deepSeekClaudeDefaultReasoningEffort,
  deepSeekClaudeEffortEnvValue,
  deepSeekClaudeFastModel,
  deepSeekClaudeModelIds,
  deepSeekClaudeProvider,
  deepSeekClaudeSupportedCapabilities,
  isDeepSeekClaudeBaseUrl,
  isDeepSeekClaudeRuntime
} from "./deepSeekClaude.js";
import {
  normalizeAllowedPermissionModes,
  normalizePermissionMode,
  normalizeSupportedModels,
  permissionPresetForMode
} from "./codexRuntime.js";

export function publicClaudeRuntime(backendConfig = config.claude) {
  const runtimeConfig = backendConfig || config.claude;
  const permissionMode = normalizePermissionMode(runtimeConfig.permissionMode);
  const permissionPreset = permissionPresetForMode(permissionMode);
  const supportedModels = normalizeSupportedModels(buildSupportedModelEntries(runtimeConfig));
  return {
    backendId: String(runtimeConfig.backendId || "claude-code").trim() || "claude-code",
    provider: String(runtimeConfig.provider || claudeProviderId(runtimeConfig)).trim() || "claude-code",
    backendName: String(runtimeConfig.backendName || runtimeConfig.name || "Claude Code").trim() || "Claude Code",
    command: resolveClaudeCommand(runtimeConfig.command),
    commandSource: "shell-command",
    commandDetail: `Using ${runtimeConfig.command || "claude"}.`,
    sandbox: permissionPreset.sandbox || "read-only",
    approvalPolicy: permissionPreset.approvalPolicy || "on-request",
    approvalTimeoutMs: runtimeConfig.approvalTimeoutMs,
    model: String(runtimeConfig.model || "").trim(),
    supportedModels,
    unsupportedModels: [],
    allowedPermissionModes: normalizeAllowedPermissionModes(runtimeConfig.allowedPermissionModes),
    supportedPermissionModes: ["strict", "approve", "full"],
    reasoningEffort: runtimeConfig.reasoningEffort,
    profile: permissionMode,
    permissionMode,
    timeoutMs: runtimeConfig.timeoutMs,
    worktreeMode: runtimeConfig.worktreeMode,
    baseUrl: runtimeConfig.baseUrl,
    capabilities: {
      supports: {
        attachments: false,
        cancellation: true,
        contextUsage: true,
        compaction: false,
        approvalRequests: false,
        interactionRequests: false,
        gitSummary: true,
        worktree: true
      },
      unsupportedFeatures: ["attachments", "remote-context-compaction", "approval-requests", "interaction-requests"]
    },
    unsupportedFeatures: ["attachments", "remote-context-compaction", "approval-requests", "interaction-requests"],
    supportsAttachments: false,
    supportsCompaction: false,
    supportsAgentTeams: Boolean(runtimeConfig.agentTeamsEnabled),
    subagentModel: String(runtimeConfig.subagentModel || "").trim(),
    modelCapabilitySource: modelCapabilitySourceForRuntime(runtimeConfig, supportedModels),
    modelCapabilityCheckedAt: "",
    modelCapabilityError: ""
  };
}

export function buildClaudeEnv(backendConfig = config.claude, sourceEnv = process.env) {
  const runtimeConfig = backendConfig || config.claude;
  const proxyEnv = buildProxyEnv(sourceEnv);
  const next = buildAgentProcessEnv(proxyEnv, {
    HOME: sourceEnv.HOME || proxyEnv.HOME || os.homedir()
  });
  if (shouldUseIsolatedClaudeConfig(runtimeConfig)) {
    for (const key of Object.keys(next)) {
      if (key === "CLAUDE_CONFIG_DIR" || key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_")) {
        delete next[key];
      }
    }
  }
  Object.assign(next, buildClaudeProviderEnv(runtimeConfig));
  return next;
}

export function prepareClaudeRunEnvironment(backendConfig = config.claude, options = {}) {
  const runtimeConfig = backendConfig || config.claude;
  const env = buildClaudeEnv(runtimeConfig);
  if (shouldUseIsolatedClaudeConfig(runtimeConfig)) {
    env.CLAUDE_CONFIG_DIR = writeClaudeSettings(runtimeConfig, options);
  }
  return env;
}

export function buildClaudeProviderEnv(backendConfig = config.claude) {
  const runtimeConfig = backendConfig || config.claude;
  const providerEnv = {};
  const baseUrl = String(runtimeConfig.baseUrl || "").trim();
  const authToken = String(runtimeConfig.authToken || "").trim();
  const deepSeekRuntime = isDeepSeekClaudeRuntime(runtimeConfig);
  const model = String(runtimeConfig.model || (deepSeekRuntime ? deepSeekClaudeDefaultModel : "")).trim();
  const subagentModel = String(runtimeConfig.subagentModel || (deepSeekRuntime ? deepSeekClaudeFastModel : "")).trim();

  if (baseUrl) {
    providerEnv.ANTHROPIC_BASE_URL = baseUrl;
    providerEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }
  if (authToken) {
    providerEnv.ANTHROPIC_AUTH_TOKEN = authToken;
    providerEnv.ANTHROPIC_API_KEY = authToken;
  }
  if (model) {
    providerEnv.ANTHROPIC_MODEL = model;
    providerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    providerEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    providerEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = deepSeekRuntime && subagentModel ? subagentModel : model;
  }
  if (subagentModel) providerEnv.CLAUDE_CODE_SUBAGENT_MODEL = subagentModel;
  if (deepSeekRuntime) {
    providerEnv.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = "1";
    providerEnv.CLAUDE_CODE_EFFORT_LEVEL = deepSeekClaudeEffortEnvValue(runtimeConfig.reasoningEffort);
    providerEnv.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES = deepSeekClaudeSupportedCapabilities;
    providerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = deepSeekClaudeSupportedCapabilities;
    providerEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES = deepSeekClaudeSupportedCapabilities;
  }
  if (runtimeConfig.agentTeamsEnabled) providerEnv.CLAUDE_CODE_ENABLE_AGENT_TEAMS = "1";
  return providerEnv;
}

export function shouldUseIsolatedClaudeConfig(backendConfig = config.claude) {
  const runtimeConfig = backendConfig || config.claude;
  return Boolean(String(runtimeConfig.baseUrl || "").trim() || String(runtimeConfig.authToken || "").trim());
}

export function writeClaudeSettings(backendConfig = config.claude, options = {}) {
  const runtimeConfig = backendConfig || config.claude;
  const configDir = resolveClaudeConfigDir(runtimeConfig, options);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodIfPossible(configDir, 0o700);

  const settingsPath = path.join(configDir, "settings.json");
  const settings = {
    env: buildClaudeProviderEnv(runtimeConfig)
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodIfPossible(settingsPath, 0o600);
  return configDir;
}

export async function probeClaudeModels(options = {}, backendConfig = config.claude) {
  const runtimeConfig = backendConfig || config.claude;
  const configured = normalizeSupportedModels(buildSupportedModelEntries(runtimeConfig));
  if (isVolcengineCodingPlanBaseUrl(runtimeConfig.baseUrl)) return configured;
  if (!isDeepSeekClaudeBaseUrl(runtimeConfig.baseUrl) || !runtimeConfig.authToken) return configured;

  const response = await httpFetch(deepSeekModelsUrl(runtimeConfig.baseUrl), {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${runtimeConfig.authToken}`
    },
    timeoutMs: Number(options.timeoutMs || 15000)
  });
  if (!response.ok) {
    throw new Error(`DeepSeek model probe failed: ${response.status} ${response.statusText}`);
  }
  return configured;
}

function resolveClaudeCommand(command) {
  const raw = String(command || "").trim() || "claude";
  if (raw.includes(path.sep)) return fs.existsSync(raw) ? raw : "";
  return raw;
}

function deepSeekModelsUrl(baseUrl) {
  const url = new URL(baseUrl || "https://api.deepseek.com/anthropic");
  url.pathname = "/models";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function resolveClaudeConfigDir(runtimeConfig = {}, options = {}) {
  const key = safeClaudeConfigKey(runtimeConfig);
  const scopeId = String(options.configScopeId || options.scopeId || "").trim();
  const scopedKey = scopeId ? `${key}-${safePathSegment(scopeId)}` : key;
  return path.join(config.dataDir, "claude-configs", scopedKey);
}

function safeClaudeConfigKey(runtimeConfig = {}) {
  const backendId = String(runtimeConfig.backendId || "claude-code").trim() || "claude-code";
  const provider = String(runtimeConfig.provider || claudeProviderId(runtimeConfig)).trim() || "claude-code";
  const baseUrl = String(runtimeConfig.baseUrl || "").trim();
  const label = `${backendId}-${provider}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "claude-code";
  const hash = createHash("sha256")
    .update([backendId, provider, baseUrl].join("\n"))
    .digest("hex")
    .slice(0, 12);
  return `${label}-${hash}`;
}

function safePathSegment(value = "") {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "session";
}

function chmodIfPossible(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Some filesystems do not preserve POSIX modes.
  }
}

function displayNameForModel(value) {
  const model = String(value || "").trim();
  if (!model) return "";
  return model
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("-");
}

function claudeProviderId(backendConfig = config.claude) {
  const runtimeConfig = backendConfig || config.claude;
  if (isVolcengineCodingPlanBaseUrl(runtimeConfig.baseUrl)) return volcengineCodingPlanProvider;
  return isDeepSeekClaudeBaseUrl(runtimeConfig.baseUrl) ? deepSeekClaudeProvider : "claude-code";
}

function modelCapabilitySourceForRuntime(runtimeConfig = {}, supportedModels = []) {
  if (!Array.isArray(supportedModels) || supportedModels.length === 0) return "unavailable";
  if (isVolcengineCodingPlanBaseUrl(runtimeConfig.baseUrl)) return "volcengine-coding-plan";
  if (isDeepSeekClaudeBaseUrl(runtimeConfig.baseUrl)) return "config";
  return "config";
}

function buildSupportedModelEntries(runtimeConfig = {}) {
  const configuredModels = Array.isArray(runtimeConfig.supportedModels) ? runtimeConfig.supportedModels : [];
  const deepSeekRuntime = isDeepSeekClaudeBaseUrl(runtimeConfig.baseUrl);
  const explicitModel = String(runtimeConfig.model || "").trim();
  const normalized = configuredModels.map((model, index) => {
    if (model && typeof model === "object") {
      const id = String(model.id || model.model || "").trim();
      if (!id) return null;
      return {
        ...model,
        id,
        model: String(model.model || id).trim() || id,
        displayName: String(model.displayName || model.display_name || displayNameForModel(id)).trim() || displayNameForModel(id),
        isDefault: explicitModel ? id === explicitModel : Boolean(model.isDefault || model.is_default || index === 0),
        supportedReasoningEfforts:
          model.supportedReasoningEfforts ||
          model.supported_reasoning_efforts ||
          (deepSeekRuntime ? ["low", "medium", "high", "xhigh"] : []),
        defaultReasoningEffort:
          model.defaultReasoningEffort ||
          model.default_reasoning_effort ||
          (deepSeekRuntime ? deepSeekClaudeDefaultReasoningEffort : "")
      };
    }
    const id = String(model || "").trim();
    if (!id) return null;
    const info = volcengineCodingPlanModelInfo(id);
    return {
      id,
      model: id,
      displayName: info?.displayName || displayNameForModel(id),
      description: info?.description || "",
      isDefault: explicitModel ? id === explicitModel : index === 0,
      supportedReasoningEfforts: deepSeekRuntime ? ["low", "medium", "high", "xhigh"] : [],
      defaultReasoningEffort: deepSeekRuntime ? deepSeekClaudeDefaultReasoningEffort : ""
    };
  }).filter(Boolean);

  if (normalized.length > 0) return normalized;

  if (isVolcengineCodingPlanBaseUrl(runtimeConfig.baseUrl)) {
    return [
      ...volcengineCodingPlanModelsForRuntime(runtimeConfig)
    ];
  }

  if (deepSeekRuntime) {
    return deepSeekClaudeModelIds().map((id, index) => ({
      id,
      model: id,
      displayName: displayNameForModel(id),
      isDefault: explicitModel ? id === explicitModel : index === 0,
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: deepSeekClaudeDefaultReasoningEffort
    }));
  }

  return [
    {
      id: "sonnet",
      model: "sonnet",
      displayName: "Sonnet",
      isDefault: true
    },
    {
      id: "opus",
      model: "opus",
      displayName: "Opus"
    }
  ];
}

function volcengineCodingPlanModelsForRuntime(runtimeConfig = {}) {
  const explicitModel = String(runtimeConfig.model || "").trim();
  return volcengineCodingPlanModels().map((model, index) => ({
    ...model,
    isDefault: explicitModel ? model.id === explicitModel : Boolean(model.isDefault || index === 0)
  }));
}
