import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import {
  isVolcengineCodingPlanBaseUrl,
  volcengineCodingPlanBaseUrl,
  volcengineCodingPlanDefaultModelId,
  volcengineCodingPlanModelIds,
  volcengineCodingPlanProvider
} from "./lib/volcengineCodingPlan.js";
import {
  deepSeekClaudeDefaultModel,
  deepSeekClaudeDefaultReasoningEffort,
  deepSeekClaudeFastModel,
  deepSeekClaudeModelIds,
  deepSeekClaudeProvider,
  isDeepSeekClaudeBaseUrl
} from "./lib/deepSeekClaude.js";

dotenv.config();

const runtimeToken = crypto.randomBytes(6).toString("hex");
const postprocessProvider = process.env.POSTPROCESS_PROVIDER || "auto";
const defaultNoProxy = "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local";
const volcengineCodingApiKey =
  process.env.METIO_VOLCENGINE_CODING_API_KEY ||
  process.env.VOLCENGINE_CODING_API_KEY ||
  process.env.ARK_API_KEY ||
  (postprocessProvider === "volcengine" ? process.env.LLM_API_KEY || process.env.OPENAI_API_KEY : "") ||
  "";
const volcengineCodingBaseUrl = trimTrailingSlash(
  process.env.METIO_VOLCENGINE_CODING_OPENAI_BASE_URL ||
    process.env.VOLCENGINE_CODING_OPENAI_BASE_URL ||
    "https://ark.cn-beijing.volces.com/api/coding/v3"
);
const volcengineCodingModel =
  process.env.METIO_VOLCENGINE_CODING_CHAT_MODEL ||
  process.env.VOLCENGINE_CODING_CHAT_MODEL ||
  "ark-code-latest";
const authUsers = parseAuthUsers();
const codexWorktreeMode = normalizeWorktreeMode(process.env.ECHO_CODEX_WORKTREE_MODE || "off");
const defaultVolcengineCodingPermissionMode = "approve";
const defaultVolcengineCodingAllowedPermissionModes = "strict,approve,full";
const volcengineCodingClaudeEnabled = parseBoolean(process.env.ECHO_VOLCENGINE_CODING_ENABLED, false);
const explicitClaudeConfigured = hasExplicitClaudeConfig();
const useVolcengineCodingClaudeConfig = volcengineCodingClaudeEnabled && !explicitClaudeConfigured;
const claudeEnabled = parseBoolean(process.env.ECHO_CLAUDE_ENABLED, useVolcengineCodingClaudeConfig);
const claudeBaseUrl = resolveClaudeBaseUrl();
const claudeModelList = parseFlexibleStringList(
  useVolcengineCodingClaudeConfig
    ? process.env.ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS || defaultClaudeSupportedModels(claudeBaseUrl)
    : process.env.ECHO_CLAUDE_SUPPORTED_MODELS || defaultClaudeSupportedModels(claudeBaseUrl)
);
const parsedAgentBackends = parseAgentBackends(process.env.ECHO_AGENT_BACKENDS_JSON || process.env.ECHO_BACKENDS_JSON || "");
const agentBackends = appendVolcengineCodingAgentBackend(parsedAgentBackends);

export const config = {
  host: process.env.ECHO_HOST || "0.0.0.0",
  port: Number(process.env.ECHO_PORT || 3888),
  mode: process.env.ECHO_MODE || (process.argv.includes("--relay") ? "relay" : "local"),
  publicUrl: trimTrailingSlash(process.env.ECHO_PUBLIC_URL || ""),
  relayUrl: trimTrailingSlash(process.env.ECHO_RELAY_URL || ""),
  token: process.env.ECHO_TOKEN || runtimeToken,
  dataDir: path.join(os.homedir(), ".echo-voice"),
  httpsCert: process.env.HTTPS_CERT || "",
  httpsKey: process.env.HTTPS_KEY || "",

  auth: {
    enabled: parseBoolean(process.env.ECHO_AUTH_ENABLED, authUsers.length > 0),
    users: authUsers,
    sessionSecret: process.env.ECHO_SESSION_SECRET || process.env.ECHO_TOKEN || runtimeToken,
    sessionTtlMs: Number(process.env.ECHO_SESSION_TTL_HOURS || 24 * 30) * 60 * 60 * 1000
  },

  network: {
    proxyUrl:
      process.env.ECHO_PROXY_URL ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      "",
    noProxy: process.env.ECHO_NO_PROXY || process.env.NO_PROXY || process.env.no_proxy || defaultNoProxy,
    timeoutMs: Number(process.env.ECHO_HTTP_TIMEOUT_MS || 60000),
    proxyFallbackDirect: parseBoolean(process.env.ECHO_PROXY_FALLBACK_DIRECT, true)
  },

  refine: {
    provider: postprocessProvider,
    llmBaseUrl: resolveRefineBaseUrl(),
    llmApiKey: resolveRefineApiKey(),
    llmModel: resolveRefineModel(),
    volcengineConfigured: Boolean(volcengineCodingApiKey),
    volcengineBaseUrl: volcengineCodingBaseUrl,
    volcengineModel: volcengineCodingModel,
    ollamaBaseUrl: trimTrailingSlash(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"),
    ollamaModel: process.env.OLLAMA_MODEL || "qwen3:4b"
  },

  codex: {
    enabled: process.env.ECHO_CODEX_ENABLED !== "false",
    appPath: process.env.ECHO_CODEX_APP_PATH || "",
    command: process.env.ECHO_CODEX_COMMAND || "codex",
    workspaces: parseWorkspaces(process.env.ECHO_CODEX_WORKSPACES || process.cwd()),
    sandbox: process.env.ECHO_CODEX_SANDBOX || "workspace-write",
    approvalPolicy: process.env.ECHO_CODEX_APPROVAL_POLICY || "on-request",
    approvalTimeoutMs: Number(process.env.ECHO_CODEX_APPROVAL_TIMEOUT_MS || 5 * 60 * 1000),
    model: process.env.ECHO_CODEX_MODEL || "",
    reasoningEffort: process.env.ECHO_CODEX_REASONING_EFFORT || process.env.ECHO_CODEX_MODEL_REASONING_EFFORT || "",
    profile: process.env.ECHO_CODEX_PROFILE || "",
    timeoutMs: Number(process.env.ECHO_CODEX_TIMEOUT_MS || 30 * 60 * 1000),
    leaseMs: Number(process.env.ECHO_CODEX_LEASE_MS || 10 * 60 * 1000),
    sessionConcurrency: parseIntegerInRange(process.env.ECHO_CODEX_SESSION_CONCURRENCY, 3, 1, 8),
    maxEvents: Number(process.env.ECHO_CODEX_MAX_EVENTS || 500),
    worktreeMode: codexWorktreeMode,
    worktreeRoot: path.resolve(expandHome(process.env.ECHO_CODEX_WORKTREE_ROOT || path.join(os.homedir(), ".echo-voice", "worktrees"))),
    worktreeRetentionDays: Number(process.env.ECHO_CODEX_WORKTREE_RETENTION_DAYS || 14)
  },

  claude: {
    type: "claude-code",
    backendId: "claude-code",
    provider: claudeProviderForBaseUrl(claudeBaseUrl),
    backendName: "Claude Code",
    enabled: claudeEnabled,
    command:
      (useVolcengineCodingClaudeConfig ? process.env.ECHO_VOLCENGINE_CODING_COMMAND : "") ||
      process.env.ECHO_CLAUDE_COMMAND ||
      "claude",
    baseUrl: claudeBaseUrl,
    authToken: resolveClaudeAuthToken(),
    model:
      (useVolcengineCodingClaudeConfig ? resolveVolcengineCodingModel() : "") ||
      process.env.ECHO_CLAUDE_MODEL ||
      defaultClaudeModel(claudeBaseUrl),
    permissionMode:
      (useVolcengineCodingClaudeConfig ? resolveVolcengineCodingPermissionMode() : "") ||
      process.env.ECHO_CLAUDE_PERMISSION_MODE ||
      process.env.ECHO_CLAUDE_PROFILE ||
      "",
    reasoningEffort:
      (useVolcengineCodingClaudeConfig ? process.env.ECHO_VOLCENGINE_CODING_REASONING_EFFORT : "") ||
      process.env.ECHO_CLAUDE_REASONING_EFFORT ||
      defaultClaudeReasoningEffort(claudeBaseUrl),
    approvalTimeoutMs: Number(
      (useVolcengineCodingClaudeConfig ? process.env.ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS : "") ||
        process.env.ECHO_CLAUDE_APPROVAL_TIMEOUT_MS ||
        5 * 60 * 1000
    ),
    timeoutMs: Number(
      (useVolcengineCodingClaudeConfig ? process.env.ECHO_VOLCENGINE_CODING_TIMEOUT_MS : "") ||
        process.env.ECHO_CLAUDE_TIMEOUT_MS ||
        30 * 60 * 1000
    ),
    supportedModels: claudeModelList,
    allowedPermissionModes:
      (useVolcengineCodingClaudeConfig ? resolveVolcengineCodingAllowedPermissionModes() : "") ||
      process.env.ECHO_CLAUDE_ALLOWED_PERMISSION_MODES ||
      "strict",
    worktreeMode: normalizeWorktreeMode(
      (useVolcengineCodingClaudeConfig ? process.env.ECHO_VOLCENGINE_CODING_WORKTREE_MODE : "") ||
        process.env.ECHO_CLAUDE_WORKTREE_MODE ||
        codexWorktreeMode
    ),
    subagentModel:
      (useVolcengineCodingClaudeConfig ? process.env.ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL : "") ||
      process.env.ECHO_CLAUDE_SUBAGENT_MODEL ||
      process.env.CLAUDE_CODE_SUBAGENT_MODEL ||
      defaultClaudeSubagentModel(claudeBaseUrl),
    agentTeamsEnabled: parseBoolean(
      (useVolcengineCodingClaudeConfig ? process.env.ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED : "") ||
        process.env.ECHO_CLAUDE_AGENT_TEAMS_ENABLED ||
        process.env.CLAUDE_CODE_ENABLE_AGENT_TEAMS,
      false
    )
  },

  agentBackends
};

validateConfig();

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function resolveRefineBaseUrl() {
  if (postprocessProvider === "volcengine") return volcengineCodingBaseUrl;
  if (postprocessProvider === "auto" && !hasExplicitOpenAiCompatibleRefineKey() && volcengineCodingApiKey) {
    return volcengineCodingBaseUrl;
  }
  return trimTrailingSlash(process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || volcengineCodingBaseUrl || "https://api.openai.com/v1");
}

function resolveRefineApiKey() {
  if (postprocessProvider === "volcengine") return volcengineCodingApiKey;
  return process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || volcengineCodingApiKey || "";
}

function resolveRefineModel() {
  if (postprocessProvider === "volcengine") return volcengineCodingModel;
  if (postprocessProvider === "auto" && !hasExplicitOpenAiCompatibleRefineKey() && volcengineCodingApiKey) {
    return volcengineCodingModel;
  }
  return process.env.LLM_MODEL || (volcengineCodingApiKey ? volcengineCodingModel : "gpt-4.1-mini");
}

function hasExplicitOpenAiCompatibleRefineKey() {
  return Boolean(process.env.LLM_API_KEY || process.env.OPENAI_API_KEY);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseIntegerInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function normalizeWorktreeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["off", "optional", "always"].includes(mode) ? mode : "off";
}

function validateConfig() {
  validateChoice("ECHO_CODEX_WORKTREE_MODE", process.env.ECHO_CODEX_WORKTREE_MODE, ["off", "optional", "always"]);
  validateChoice("ECHO_CODEX_SANDBOX", process.env.ECHO_CODEX_SANDBOX, ["read-only", "workspace-write", "danger-full-access"]);
  validateChoice("ECHO_CODEX_APPROVAL_POLICY", process.env.ECHO_CODEX_APPROVAL_POLICY, ["on-request", "never"]);
  validatePositiveNumber("ECHO_CODEX_WORKTREE_RETENTION_DAYS", process.env.ECHO_CODEX_WORKTREE_RETENTION_DAYS);
  validatePositiveNumber("ECHO_CODEX_LEASE_MS", process.env.ECHO_CODEX_LEASE_MS);
  validatePositiveNumber("ECHO_CODEX_TIMEOUT_MS", process.env.ECHO_CODEX_TIMEOUT_MS);
}

function validateChoice(name, value, choices) {
  if (value === undefined || value === "") return;
  if (!choices.includes(String(value).trim())) {
    throw new Error(`${name} must be one of: ${choices.join(", ")}`);
  }
}

function validatePositiveNumber(name, value) {
  if (value === undefined || value === "") return;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
}

function hasExplicitClaudeConfig() {
  return [
    process.env.ECHO_CLAUDE_BASE_URL,
    process.env.ANTHROPIC_BASE_URL,
    process.env.ECHO_CLAUDE_AUTH_TOKEN,
    process.env.ANTHROPIC_AUTH_TOKEN,
    process.env.ANTHROPIC_API_KEY,
    process.env.ECHO_CLAUDE_MODEL,
    process.env.ECHO_CLAUDE_SUPPORTED_MODELS,
    process.env.ECHO_CLAUDE_PERMISSION_MODE,
    process.env.ECHO_CLAUDE_PROFILE,
    process.env.ECHO_CLAUDE_ALLOWED_PERMISSION_MODES,
    process.env.ECHO_CLAUDE_REASONING_EFFORT,
    process.env.ECHO_CLAUDE_APPROVAL_TIMEOUT_MS,
    process.env.ECHO_CLAUDE_TIMEOUT_MS,
    process.env.ECHO_CLAUDE_WORKTREE_MODE,
    process.env.ECHO_CLAUDE_SUBAGENT_MODEL,
    process.env.ECHO_CLAUDE_AGENT_TEAMS_ENABLED
  ].some((value) => value !== undefined && value !== "");
}

function parseModelList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultClaudeSupportedModels(baseUrl) {
  if (claudeProviderForBaseUrl(baseUrl) === volcengineCodingPlanProvider) {
    return volcengineCodingPlanModelIds();
  }
  if (claudeProviderForBaseUrl(baseUrl) === deepSeekClaudeProvider) {
    return deepSeekClaudeModelIds();
  }
  return ["sonnet", "opus"];
}

function defaultClaudeModel(baseUrl) {
  return claudeProviderForBaseUrl(baseUrl) === deepSeekClaudeProvider ? deepSeekClaudeDefaultModel : "";
}

function defaultClaudeReasoningEffort(baseUrl) {
  return claudeProviderForBaseUrl(baseUrl) === deepSeekClaudeProvider ? deepSeekClaudeDefaultReasoningEffort : "";
}

function defaultClaudeSubagentModel(baseUrl) {
  return claudeProviderForBaseUrl(baseUrl) === deepSeekClaudeProvider ? deepSeekClaudeFastModel : "";
}

function claudeProviderForBaseUrl(baseUrl) {
  if (isVolcengineCodingPlanBaseUrl(baseUrl)) return volcengineCodingPlanProvider;
  if (isDeepSeekClaudeBaseUrl(baseUrl)) return deepSeekClaudeProvider;
  return "claude-code";
}

function resolveClaudeBaseUrl() {
  if (useVolcengineCodingClaudeConfig) {
    return resolveVolcengineCodingClaudeBaseUrl();
  }
  return trimTrailingSlash(
    process.env.ECHO_CLAUDE_BASE_URL ||
      process.env.ANTHROPIC_BASE_URL ||
      ""
  );
}

function resolveClaudeAuthToken() {
  if (useVolcengineCodingClaudeConfig) {
    return resolveVolcengineCodingAuthToken();
  }
  return process.env.ECHO_CLAUDE_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
}

function resolveVolcengineCodingClaudeBaseUrl() {
  return trimTrailingSlash(
    process.env.ECHO_VOLCENGINE_CODING_BASE_URL ||
      process.env.METIO_VOLCENGINE_CODING_ANTHROPIC_BASE_URL ||
      process.env.VOLCENGINE_CODING_ANTHROPIC_BASE_URL ||
      volcengineCodingPlanBaseUrl
  );
}

function resolveVolcengineCodingAuthToken() {
  return process.env.ECHO_VOLCENGINE_CODING_API_KEY || volcengineCodingApiKey || "";
}

function resolveVolcengineCodingModel() {
  return (
    process.env.ECHO_VOLCENGINE_CODING_MODEL ||
    process.env.METIO_VOLCENGINE_CODING_CHAT_MODEL ||
    process.env.VOLCENGINE_CODING_CHAT_MODEL ||
    volcengineCodingPlanDefaultModelId()
  );
}

function resolveVolcengineCodingPermissionMode() {
  return (
    process.env.ECHO_VOLCENGINE_CODING_PERMISSION_MODE ||
    process.env.ECHO_VOLCENGINE_CODING_PROFILE ||
    defaultVolcengineCodingPermissionMode
  );
}

function resolveVolcengineCodingAllowedPermissionModes() {
  return process.env.ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES || defaultVolcengineCodingAllowedPermissionModes;
}

function appendVolcengineCodingAgentBackend(backends = []) {
  const entries = Array.isArray(backends) ? backends : [];
  if (!volcengineCodingClaudeEnabled || !explicitClaudeConfigured) return entries;
  if (entries.some((backend) => backend.provider === volcengineCodingPlanProvider)) return entries;

  const backendId = normalizeBackendId(process.env.ECHO_VOLCENGINE_CODING_BACKEND_ID || volcengineCodingPlanProvider);
  if (!backendId || entries.some((backend) => backend.backendId === backendId)) return entries;

  const backend = normalizeAgentBackend({
    type: "claude-code",
    backendId,
    provider: volcengineCodingPlanProvider,
    backendName: "Claude Code",
    enabled: true,
    command: process.env.ECHO_VOLCENGINE_CODING_COMMAND || process.env.ECHO_CLAUDE_COMMAND || "claude",
    baseUrl: resolveVolcengineCodingClaudeBaseUrl(),
    authToken: resolveVolcengineCodingAuthToken(),
    model: resolveVolcengineCodingModel(),
    permissionMode: resolveVolcengineCodingPermissionMode(),
    reasoningEffort: process.env.ECHO_VOLCENGINE_CODING_REASONING_EFFORT || "",
    approvalTimeoutMs:
      process.env.ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS ||
      process.env.ECHO_CLAUDE_APPROVAL_TIMEOUT_MS ||
      5 * 60 * 1000,
    timeoutMs:
      process.env.ECHO_VOLCENGINE_CODING_TIMEOUT_MS ||
      process.env.ECHO_CLAUDE_TIMEOUT_MS ||
      30 * 60 * 1000,
    supportedModels: process.env.ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS || volcengineCodingPlanModelIds(),
    allowedPermissionModes: resolveVolcengineCodingAllowedPermissionModes(),
    worktreeMode:
      process.env.ECHO_VOLCENGINE_CODING_WORKTREE_MODE ||
      process.env.ECHO_CLAUDE_WORKTREE_MODE ||
      codexWorktreeMode,
    subagentModel: process.env.ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL || "",
    agentTeamsEnabled: process.env.ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED || false
  });
  return backend ? [...entries, backend] : entries;
}

function parseAgentBackends(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn("Could not parse ECHO_AGENT_BACKENDS_JSON:", error.message);
    return [];
  }

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const backends = [];
  const seen = new Set();
  for (const entry of entries) {
    const backend = normalizeAgentBackend(entry);
    if (!backend) continue;
    if (seen.has(backend.backendId)) {
      console.warn(`Skipping duplicate Echo backend id: ${backend.backendId}`);
      continue;
    }
    seen.add(backend.backendId);
    backends.push(backend);
  }
  return backends;
}

function normalizeAgentBackend(entry = {}) {
  if (!entry || typeof entry !== "object") return null;
  const type = String(entry.type || entry.kind || entry.adapter || "").trim().toLowerCase();
  const normalizedType = type === "claude" ? "claude-code" : type;
  if (normalizedType !== "claude-code") {
    console.warn(`Skipping unsupported Echo backend type: ${type || "unknown"}`);
    return null;
  }

  const backendId = normalizeBackendId(entry.backendId || entry.id || entry.name);
  if (!backendId) {
    console.warn("Skipping Echo backend without an id.");
    return null;
  }

  const authTokenEnv = String(entry.authTokenEnv || entry.auth_token_env || "").trim();
  const authToken = String(entry.authToken || entry.auth_token || (authTokenEnv ? process.env[authTokenEnv] : "") || "").trim();
  const baseUrl = trimTrailingSlash(String(entry.baseUrl || entry.base_url || entry.anthropicBaseUrl || "").trim());
  const supportedModels = parseFlexibleStringList(entry.supportedModels ?? entry.models);
  const provider = String(entry.provider || claudeProviderForBaseUrl(baseUrl)).trim();
  const isVolcengineCodingPlanBackend = provider === volcengineCodingPlanProvider || isVolcengineCodingPlanBaseUrl(baseUrl);
  const defaultPermissionMode = isVolcengineCodingPlanBackend ? defaultVolcengineCodingPermissionMode : "";
  const defaultAllowedPermissionModes = isVolcengineCodingPlanBackend ? defaultVolcengineCodingAllowedPermissionModes : "strict";

  return {
    type: "claude-code",
    backendId,
    provider,
    backendName: String(entry.backendName || entry.name || backendId).trim() || backendId,
    enabled: parseBoolean(entry.enabled, true),
    command: String(entry.command || "claude").trim() || "claude",
    baseUrl,
    authToken,
    model: String(entry.model || defaultClaudeModel(baseUrl)).trim(),
    permissionMode: String(entry.permissionMode || entry.profile || defaultPermissionMode).trim(),
    reasoningEffort: String(entry.reasoningEffort || entry.effort || defaultClaudeReasoningEffort(baseUrl)).trim(),
    approvalTimeoutMs: Number(entry.approvalTimeoutMs || entry.approval_timeout_ms || configNumberFallback(process.env.ECHO_CLAUDE_APPROVAL_TIMEOUT_MS, 5 * 60 * 1000)),
    timeoutMs: Number(entry.timeoutMs || entry.timeout_ms || configNumberFallback(process.env.ECHO_CLAUDE_TIMEOUT_MS, 30 * 60 * 1000)),
    supportedModels:
      supportedModels.length > 0
        ? supportedModels
        : defaultClaudeSupportedModels(baseUrl),
    allowedPermissionModes: parseFlexibleStringList(
      entry.allowedPermissionModes ?? entry.allowed_permission_modes ?? defaultAllowedPermissionModes
    ).join(","),
    worktreeMode: normalizeWorktreeMode(entry.worktreeMode || entry.worktree_mode || codexWorktreeMode),
    subagentModel: String(entry.subagentModel || entry.subagent_model || defaultClaudeSubagentModel(baseUrl)).trim(),
    agentTeamsEnabled: parseBoolean(entry.agentTeamsEnabled ?? entry.agent_teams_enabled, false)
  };
}

function normalizeBackendId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseFlexibleStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return parseModelList(value);
}

function configNumberFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseAuthUsers() {
  const users = [];
  if (process.env.ECHO_USERS_JSON) {
    try {
      const parsed = JSON.parse(process.env.ECHO_USERS_JSON);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      for (const entry of entries) {
        const user = normalizeAuthUser(entry);
        if (user) users.push(user);
      }
    } catch (error) {
      console.warn("Could not parse ECHO_USERS_JSON:", error.message);
    }
  }

  const envUser = normalizeAuthUser({
    username: process.env.ECHO_AUTH_USERNAME,
    password: process.env.ECHO_AUTH_PASSWORD,
    passwordSha256: process.env.ECHO_AUTH_PASSWORD_SHA256,
    displayName: process.env.ECHO_AUTH_DISPLAY_NAME,
    role: process.env.ECHO_AUTH_ROLE || "owner"
  });
  if (envUser && !users.some((user) => user.username === envUser.username)) users.push(envUser);

  return users;
}

function normalizeAuthUser(entry = {}) {
  const username = String(entry.username || "").trim();
  const password = String(entry.password || "");
  const passwordSha256 = String(entry.passwordSha256 || entry.password_hash_sha256 || "").trim();
  if (!username || (!password && !passwordSha256)) return null;
  return {
    username,
    password,
    passwordSha256,
    displayName: String(entry.displayName || entry.display_name || username).trim() || username,
    role: String(entry.role || "user").trim() || "user"
  };
}

function parseWorkspaces(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [label, rawPath] = item.includes("=") ? item.split("=", 2) : ["", item];
      const workspacePath = path.resolve(expandHome(rawPath.trim()));
      return {
        id: slug(label || path.basename(workspacePath) || "workspace"),
        label: label || path.basename(workspacePath) || workspacePath,
        path: workspacePath
      };
    });
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workspace";
}
