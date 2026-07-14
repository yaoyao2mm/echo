const permissionPresets = {
  strict: { sandbox: "read-only", approvalPolicy: "on-request" },
  approve: { sandbox: "workspace-write", approvalPolicy: "on-request" },
  full: { sandbox: "danger-full-access", approvalPolicy: "never" }
};
const echoPermissionModes = Object.freeze(Object.keys(permissionPresets));

const defaultRuntimeCommands = ["start", "message", "stop", "compact"];
const defaultRuntimeEvents = [
  "thread.started",
  "thread.resumed",
  "thread.recovered",
  "turn.started",
  "item/agentMessage/delta",
  "item.completed",
  "approval.requested",
  "interaction.requested",
  "context.usage.updated",
  "context.compaction.unavailable",
  "git.summary",
  "turn.completed",
  "turn.failed",
  "turn.interrupted"
];
const defaultRuntimeResultEvents = ["item.completed", "git.summary", "turn.completed", "turn.failed"];
const defaultRuntimeSupports = {
  text: true,
  attachments: false,
  cancellation: true,
  contextUsage: false,
  compaction: false,
  approvalRequests: false,
  interactionRequests: false,
  gitSummary: true,
  worktree: true,
  threadArchive: false
};

const codexRuntimeSupports = {
  text: true,
  attachments: true,
  cancellation: true,
  contextUsage: true,
  compaction: true,
  approvalRequests: true,
  interactionRequests: true,
  gitSummary: true,
  worktree: true,
  threadArchive: true
};

export function codexCompatibleModel(value) {
  const model = String(value || "").trim();
  return unsupportedModels().has(model) ? "" : model;
}

export function modelRequiresNewerCodex(value) {
  return unsupportedModels().has(String(value || "").trim());
}

export function listUnsupportedCodexModels() {
  return [...unsupportedModels()];
}

export function normalizeSupportedModels(models = []) {
  return Array.isArray(models)
    ? models
        .map((model) => {
          const id = String(model?.id || model?.model || "").trim();
          if (!id) return null;
          const supportedReasoningEfforts = normalizeReasoningEfforts(model.supportedReasoningEfforts);
          return {
            id,
            model: String(model?.model || id).trim() || id,
            displayName: String(model?.displayName || model?.display_name || id).trim() || id,
            description: String(model?.description || "").trim(),
            hidden: Boolean(model?.hidden),
            isDefault: Boolean(model?.isDefault || model?.is_default),
            inputModalities: Array.isArray(model?.inputModalities)
              ? model.inputModalities.map((item) => String(item || "").trim()).filter(Boolean)
              : [],
            supportedReasoningEfforts,
            defaultReasoningEffort: normalizeReasoningEffort(model?.defaultReasoningEffort || model?.default_reasoning_effort)
          };
        })
        .filter(Boolean)
    : [];
}

export function normalizeAllowedPermissionModes(value = undefined) {
  const raw = value === undefined ? process.env.ECHO_CODEX_ALLOWED_PERMISSION_MODES || "strict,approve,full" : value;
  const modes = (Array.isArray(raw) ? raw : String(raw || "").split(","))
    .map((mode) => normalizePermissionMode(mode))
    .filter(Boolean);
  return Array.from(new Set(modes));
}

export function normalizeSupportedPermissionModes(value = []) {
  return normalizeAllowedPermissionModes(value);
}

export function normalizePermissionMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "readonly" || normalized === "read-only" || normalized === "suggest") return "strict";
  if (normalized === "approved" || normalized === "auto" || normalized === "auto-edit" || normalized === "acceptedits" || normalized === "default") {
    return "approve";
  }
  if (
    normalized === "full-auto" ||
    normalized === "fullaccess" ||
    normalized === "danger-full-access" ||
    normalized === "bypasspermissions" ||
    normalized === "dontask"
  ) {
    return "full";
  }
  if (normalized === "plan") return "strict";
  return permissionPresets[normalized] ? normalized : "";
}

export function permissionModeFromRuntime(runtime = {}) {
  const explicit = normalizePermissionMode(runtime.permissionMode || runtime.permissionsMode || runtime.profile);
  if (explicit) return explicit;

  const sandbox = normalizeSandboxModeValue(runtime.sandbox);
  const approvalPolicy = String(runtime.approvalPolicy || "").trim().toLowerCase();
  if (sandbox === "read-only") return "strict";
  if (sandbox === "danger-full-access" && (!approvalPolicy || approvalPolicy === "never")) return "full";
  if (sandbox === "workspace-write") return "approve";
  return "";
}

export function permissionPresetForMode(mode) {
  const normalized = normalizePermissionMode(mode);
  return normalized ? permissionPresets[normalized] : { sandbox: "", approvalPolicy: "" };
}

export function permissionRuntimeForBackend(mode, backend = {}) {
  const permissionMode = normalizePermissionMode(mode);
  if (!permissionMode) throw runtimeValidationError("runtime.permission.invalid", "Runtime permission mode is invalid.");

  const supportedPermissionModes = supportedPermissionModesForBackend(backend);
  if (!supportedPermissionModes.includes(permissionMode)) {
    throw runtimeValidationError(
      "runtime.permission.unsupported",
      `Backend ${backend.backendId || backend.provider || "unknown"} does not support permission mode ${permissionMode}.`
    );
  }

  const preset = permissionPresetForMode(permissionMode);
  const provider = String(backend.provider || backend.backendId || "").trim().toLowerCase();
  const backendId = String(backend.backendId || backend.provider || "").trim().toLowerCase();
  const claudeCompatible = backendId.includes("claude") || provider.includes("claude") || provider.includes("anthropic") || provider.includes("deepseek") || provider.includes("volcengine");
  return {
    permissionMode,
    profile: permissionMode,
    sandbox: preset.sandbox,
    approvalPolicy: preset.approvalPolicy,
    providerPermissionMode: claudeCompatible
      ? permissionMode === "full"
        ? "bypassPermissions"
        : permissionMode === "strict"
          ? "plan"
          : "acceptEdits"
      : permissionMode
  };
}

export function supportedPermissionModesForBackend(backend = {}) {
  const advertised = normalizeSupportedPermissionModes(backend.supportedPermissionModes);
  if (advertised.length > 0) return advertised;

  const provider = String(backend.provider || backend.backendId || "").trim().toLowerCase();
  const backendId = String(backend.backendId || backend.provider || "").trim().toLowerCase();
  if (
    backendId === "codex" ||
    provider === "codex" ||
    backendId.includes("claude") ||
    provider.includes("claude") ||
    provider.includes("anthropic") ||
    provider.includes("deepseek") ||
    provider.includes("volcengine")
  ) {
    return [...echoPermissionModes];
  }
  return [];
}

export function normalizeRuntimeBackend(runtime = {}) {
  const normalized = runtime && typeof runtime === "object" ? runtime : {};
  const backendId = String(normalized.backendId || normalized.provider || "codex").trim() || "codex";
  const provider = String(normalized.provider || normalized.backendId || backendId).trim() || backendId;
  const backendName = String(
    normalized.backendName || normalized.name || (backendId === "codex" || provider === "codex" ? "Codex" : backendId)
  ).trim();
  return {
    ...normalized,
    backendId,
    provider,
    backendName: backendName || (backendId === "codex" || provider === "codex" ? "Codex" : backendId),
    supportedModels: normalizeSupportedModels(normalized.supportedModels),
    unsupportedModels: Array.isArray(normalized.unsupportedModels)
      ? normalized.unsupportedModels.map((model) => String(model || "").trim()).filter(Boolean)
      : [],
    allowedPermissionModes: normalizeAllowedPermissionModes(
      Array.isArray(normalized.allowedPermissionModes) && normalized.allowedPermissionModes.length > 0
        ? normalized.allowedPermissionModes
        : undefined
    ),
    supportedPermissionModes: supportedPermissionModesForBackend(normalized),
    capabilities: normalizeRuntimeCapabilities(normalized.capabilities, {
      supports: isCodexBackendId(backendId, provider) ? codexRuntimeSupports : {}
    }),
    unsupportedFeatures: normalizeStringList(normalized.unsupportedFeatures || normalized.capabilities?.unsupportedFeatures),
    health: normalizeRuntimeHealth(normalized.health, { backendId, provider, backendName })
  };
}

export function resolveRuntimeForAgent(requestedRuntime = {}, agentRuntime = {}) {
  const requested = requestedRuntime && typeof requestedRuntime === "object" ? requestedRuntime : {};
  const normalizedAgent = normalizeRuntimeBackend(agentRuntime);
  const availableBackends = normalizeRuntimeBackends(normalizedAgent.backends, normalizedAgent);
  const requestedBackendId = String(requested.backendId || requested.provider || "").trim();
  const selectedBackend = requestedBackendId
    ? runtimeBackendById(availableBackends, requestedBackendId)
    : runtimeBackendById(availableBackends, normalizedAgent.defaultBackendId || normalizedAgent.backendId) || availableBackends[0];
  if (!selectedBackend) {
    throw runtimeValidationError("runtime.backend.unsupported", `Backend ${requestedBackendId || "default"} is not available.`);
  }
  if (requestedBackendId && selectedBackend.backendId !== requestedBackendId && selectedBackend.provider !== requestedBackendId) {
    throw runtimeValidationError("runtime.backend.unsupported", `Backend ${requestedBackendId} is not available.`);
  }

  const rawPermissionMode = String(requested.permissionMode || requested.permissionsMode || requested.profile || "").trim();
  const permissionMode = rawPermissionMode
    ? normalizePermissionMode(rawPermissionMode)
    : "full";
  if (rawPermissionMode && !permissionMode) {
    throw runtimeValidationError("runtime.permission.invalid", `Permission mode ${rawPermissionMode} is invalid.`);
  }
  const permissionRuntime = permissionRuntimeForBackend(permissionMode, selectedBackend);

  const requestedModel = String(requested.model || "").trim();
  const supportedModels = normalizeSupportedModels(selectedBackend.supportedModels);
  const selectedModel = requestedModel
    ? supportedModels.find((model) => model.id === requestedModel || model.model === requestedModel)
    : null;
  if (requestedModel && !selectedModel) {
    throw runtimeValidationError(
      "runtime.model.unsupported",
      `Model ${requestedModel} is not supported by backend ${selectedBackend.backendId}.`
    );
  }
  const model = selectedModel?.id || "";

  const rawReasoningEffort = String(requested.reasoningEffort || requested.effort || "").trim();
  const reasoningEffort = normalizeReasoningEffort(rawReasoningEffort);
  if (rawReasoningEffort && !reasoningEffort) {
    throw runtimeValidationError("runtime.reasoning.unsupported", `Reasoning effort ${rawReasoningEffort} is invalid.`);
  }
  if (
    reasoningEffort &&
    selectedModel?.supportedReasoningEfforts?.length > 0 &&
    !selectedModel.supportedReasoningEfforts.includes(reasoningEffort)
  ) {
    throw runtimeValidationError(
      "runtime.reasoning.unsupported",
      `Reasoning effort ${reasoningEffort} is not supported by model ${model}.`
    );
  }

  const rawWorktreeMode = String(requested.worktreeMode || "off").trim().toLowerCase() || "off";
  if (!["off", "always"].includes(rawWorktreeMode)) {
    throw runtimeValidationError("runtime.worktree.unsupported", `Worktree mode ${rawWorktreeMode} is invalid.`);
  }
  const desktopWorktreeMode = normalizeWorktreeMode(selectedBackend.worktreeMode);
  if (desktopWorktreeMode === "off" && rawWorktreeMode !== "off") {
    throw runtimeValidationError("runtime.worktree.unsupported", "Worktree execution is not enabled for this backend.");
  }
  const worktreeMode = desktopWorktreeMode === "always" ? "always" : rawWorktreeMode;
  const mcpProfileId = sanitizeMcpProfileId(requested.mcpProfileId || requested.mcpProfile || requested.mcp);
  const advertisedMcpProfiles = Array.isArray(normalizedAgent.mcp?.profiles)
    ? normalizedAgent.mcp.profiles.map((profile) => String(profile?.id || "").trim()).filter(Boolean)
    : [];
  if (mcpProfileId && !advertisedMcpProfiles.includes(mcpProfileId)) {
    throw runtimeValidationError("runtime.profile.unsupported", `MCP profile ${mcpProfileId} is not available.`);
  }

  return {
    backendId: selectedBackend.backendId,
    provider: selectedBackend.provider,
    backendName: selectedBackend.backendName,
    command: "",
    ...permissionRuntime,
    model,
    reasoningEffort,
    mcpProfileId,
    worktreeMode,
    unsupportedModels: [],
    capabilities: selectedBackend.capabilities,
    unsupportedFeatures: selectedBackend.unsupportedFeatures || selectedBackend.capabilities?.unsupportedFeatures || [],
    timeoutMs: Number(requested.timeoutMs || 0) || null
  };
}

export function runtimePreferenceFromResolvedRuntime(runtime = {}) {
  return {
    backendId: String(runtime.backendId || "").trim(),
    model: String(runtime.model || "").trim(),
    reasoningEffort: normalizeReasoningEffort(runtime.reasoningEffort),
    permissionMode: normalizePermissionMode(runtime.permissionMode),
    worktreeMode: String(runtime.worktreeMode || "off").trim() === "always" ? "always" : "off",
    mcpProfileId: sanitizeMcpProfileId(runtime.mcpProfileId)
  };
}

function runtimeValidationError(code, message) {
  const error = new Error(message);
  error.statusCode = 422;
  error.code = code;
  return error;
}

export function normalizeRuntimeBackends(backends = [], fallbackRuntime = {}) {
  const normalized = Array.isArray(backends) ? backends.map((backend) => normalizeRuntimeBackend(backend)).filter(Boolean) : [];
  if (normalized.length > 0) return dedupeRuntimeBackends(normalized);

  const fallback = fallbackRuntime && typeof fallbackRuntime === "object" ? fallbackRuntime : {};
  if (!Object.keys(fallback).length) return [];
  return [normalizeRuntimeBackend(fallback)];
}

export function runtimeBackendById(backends = [], value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalizeRuntimeBackends(backends).find(
    (backend) => backend.backendId === normalized || backend.provider === normalized
  ) || null;
}

export function runtimeBackendByModel(backends = [], value = "", preferredBackendId = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const normalizedBackends = normalizeRuntimeBackends(backends);
  const preferredBackend = runtimeBackendById(normalizedBackends, preferredBackendId);
  if (
    preferredBackend &&
    Array.isArray(preferredBackend.supportedModels) &&
    preferredBackend.supportedModels.some((model) => model.id === normalized || model.model === normalized)
  ) {
    return preferredBackend;
  }
  return (
    normalizedBackends.find(
      (backend) =>
        Array.isArray(backend.supportedModels) &&
        backend.supportedModels.some((model) => model.id === normalized || model.model === normalized)
    ) || null
  );
}

export function sanitizeRuntimeForAgent(requestedRuntime = {}, agentRuntime = {}) {
  const normalizedAgent = normalizeRuntimeBackend(agentRuntime);
  const requested = requestedRuntime && typeof requestedRuntime === "object" ? requestedRuntime : {};
  const availableBackends = normalizeRuntimeBackends(normalizedAgent.backends, normalizedAgent);
  const requestedBackendId = String(requested.backendId || requested.provider || "").trim();
  const requestedModel = String(requested.model || "").trim();
  const preferredBackendId = requestedBackendId || normalizedAgent.defaultBackendId || normalizedAgent.backendId || "";
  const selectedBackend =
    runtimeBackendByModel(availableBackends, requestedModel, preferredBackendId) ||
    runtimeBackendById(availableBackends, requestedBackendId) ||
    runtimeBackendById(availableBackends, normalizedAgent.defaultBackendId || normalizedAgent.backendId) ||
    availableBackends[0] ||
    normalizedAgent;
  const allowedModes = Array.isArray(selectedBackend.allowedPermissionModes) ? selectedBackend.allowedPermissionModes : [];
  const requestedMode = permissionModeFromRuntime(requested);
  const fallbackMode = "full";
  const permissionMode = requestedMode || fallbackMode;
  const preset = permissionPresetForMode(permissionMode);
  const desktopDefault = desktopPermissionDefault(selectedBackend);
  const sandbox = permissionMode ? preset.sandbox : desktopDefault.sandbox || permissionPresetForMode(allowedModes[0] || "").sandbox;
  const approvalPolicy = permissionMode
    ? preset.approvalPolicy
    : desktopDefault.approvalPolicy || permissionPresetForMode(allowedModes[0] || "").approvalPolicy;
  const supportedModels = normalizeSupportedModels(selectedBackend.supportedModels);
  const supportedModelIds = new Set(supportedModels.map((model) => model.id));
  const unsupportedModelIds = new Set(
    Array.isArray(selectedBackend.unsupportedModels)
      ? selectedBackend.unsupportedModels.map((model) => String(model || "").trim()).filter(Boolean)
      : []
  );
  const selectedIsCodexBackend = isCodexBackendId(selectedBackend.backendId, selectedBackend.provider);
  const hasSupportedModelList = supportedModels.length > 0;
  const model = selectedIsCodexBackend && !hasSupportedModelList
    ? ""
    : sanitizeModel(requested.model, { supportedModelIds, unsupportedModelIds, hasSupportedModelList });
  const requestedReasoningEffort = requested.reasoningEffort || requested.effort;
  const selectedModelInfo = supportedModels.find((item) => item.id === model || item.model === model);
  const effectiveReasoningEffort = requestedReasoningEffort || (model ? selectedModelInfo?.defaultReasoningEffort : "");
  const reasoningEffort = (selectedIsCodexBackend && !hasSupportedModelList) || (requestedModel && !model)
    ? ""
    : sanitizeReasoningEffort(effectiveReasoningEffort, model || selectedBackend.model, supportedModels);
  const worktreeMode = sanitizeWorktreeMode(requested.worktreeMode, selectedBackend.worktreeMode);
  const mcpProfileId = sanitizeMcpProfileId(requested.mcpProfileId || requested.mcpProfile || requested.mcp);
  const backendName = String(
    selectedBackend.backendName ||
      selectedBackend.name ||
      (selectedBackend.backendId === "codex" || selectedBackend.provider === "codex" ? "Codex" : "")
  ).trim();

  return {
    backendId: String(selectedBackend.backendId || selectedBackend.provider || "codex").trim() || "codex",
    provider: String(selectedBackend.provider || selectedBackend.backendId || "codex").trim() || "codex",
    backendName: backendName || ((selectedBackend.backendId === "codex" || selectedBackend.provider === "codex") ? "Codex" : ""),
    command: "",
    sandbox,
    approvalPolicy,
    model,
    unsupportedModels: [],
    capabilities: selectedBackend.capabilities,
    unsupportedFeatures: selectedBackend.unsupportedFeatures || selectedBackend.capabilities?.unsupportedFeatures || [],
    reasoningEffort,
    mcpProfileId,
    profile: permissionMode,
    permissionMode,
    worktreeMode,
    timeoutMs: Number(requested.timeoutMs || 0) || null
  };
}

export function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high", "xhigh", "max"].includes(normalized) ? normalized : "";
}

function unsupportedModels() {
  return new Set(
    String(process.env.ECHO_CODEX_UNSUPPORTED_MODELS || "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
  );
}

function normalizeSandboxModeValue(value) {
  const normalized = String(value || "").trim();
  if (normalized === "workspaceWrite") return "workspace-write";
  if (normalized === "dangerFullAccess") return "danger-full-access";
  if (normalized === "readOnly") return "read-only";
  return normalized;
}

function desktopPermissionDefault(runtime = {}) {
  const sandbox = normalizeSandboxModeValue(runtime.sandbox);
  const approvalPolicy = String(runtime.approvalPolicy || "").trim().toLowerCase();
  if (!sandbox && !approvalPolicy) return { sandbox: "", approvalPolicy: "" };
  return {
    sandbox: sandbox || "workspace-write",
    approvalPolicy: approvalPolicy || "on-request"
  };
}

function normalizeReasoningEfforts(value = []) {
  return Array.isArray(value)
    ? value
        .map((item) => normalizeReasoningEffort(item?.reasoningEffort || item?.value || item))
        .filter(Boolean)
    : [];
}

function sanitizeModel(value, { supportedModelIds, unsupportedModelIds, hasSupportedModelList }) {
  const model = codexCompatibleModel(value);
  if (!model) return "";
  if (unsupportedModelIds.has(model)) return "";
  if (hasSupportedModelList && !supportedModelIds.has(model)) return "";
  return model;
}

function sanitizeReasoningEffort(value, model, supportedModels) {
  const reasoningEffort = normalizeReasoningEffort(value);
  if (!reasoningEffort) return "";
  const modelInfo = supportedModels.find((item) => item.id === model || item.model === model);
  if (!modelInfo || modelInfo.supportedReasoningEfforts.length === 0) return reasoningEffort;
  return modelInfo.supportedReasoningEfforts.includes(reasoningEffort) ? reasoningEffort : "";
}

function sanitizeMcpProfileId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeWorktreeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return ["off", "optional", "always"].includes(mode) ? mode : "off";
}

function sanitizeWorktreeMode(requestedMode, agentMode) {
  const desktopMode = normalizeWorktreeMode(agentMode);
  if (desktopMode === "always") return "always";
  if (desktopMode === "optional") {
    return String(requestedMode || "").trim().toLowerCase() === "always" ? "always" : "off";
  }
  return "off";
}

function dedupeRuntimeBackends(backends = []) {
  const byId = new Map();
  for (const backend of backends) {
    if (!backend?.backendId) continue;
    byId.set(backend.backendId, backend);
  }
  return Array.from(byId.values());
}

function normalizeRuntimeCapabilities(capabilities = {}, defaults = {}) {
  const normalized = capabilities && typeof capabilities === "object" ? capabilities : {};
  const fallback = defaults && typeof defaults === "object" ? defaults : {};
  const supports = normalized.supports && typeof normalized.supports === "object" ? normalized.supports : {};
  const fallbackSupports = fallback.supports && typeof fallback.supports === "object" ? fallback.supports : {};
  return {
    ...fallback,
    ...normalized,
    commands: normalizeStringList(normalized.commands || fallback.commands || defaultRuntimeCommands),
    events: normalizeStringList(normalized.events || fallback.events || defaultRuntimeEvents),
    resultEvents: normalizeStringList(normalized.resultEvents || fallback.resultEvents || defaultRuntimeResultEvents),
    unsupportedFeatures: normalizeStringList(normalized.unsupportedFeatures || fallback.unsupportedFeatures),
    supports: {
      ...defaultRuntimeSupports,
      ...fallbackSupports,
      ...supports
    },
    limits: {
      ...(fallback.limits && typeof fallback.limits === "object" ? fallback.limits : {}),
      ...(normalized.limits && typeof normalized.limits === "object" ? normalized.limits : {})
    }
  };
}

function isCodexBackendId(backendId, provider) {
  return String(backendId || "").trim().toLowerCase() === "codex" || String(provider || "").trim().toLowerCase() === "codex";
}

function normalizeRuntimeHealth(health = {}, defaults = {}) {
  const normalized = health && typeof health === "object" ? health : {};
  const state = String(normalized.state || defaults.state || "unknown").trim().toLowerCase();
  return {
    ...normalized,
    ok: typeof normalized.ok === "boolean" ? normalized.ok : Boolean(defaults.ok),
    state,
    backendId: String(normalized.backendId || defaults.backendId || "").trim(),
    provider: String(normalized.provider || defaults.provider || "").trim(),
    backendName: String(normalized.backendName || defaults.backendName || "").trim(),
    checkedAt: String(normalized.checkedAt || "").trim(),
    reason: String(normalized.reason || "").trim(),
    checks: normalized.checks && typeof normalized.checks === "object" ? { ...normalized.checks } : {}
  };
}

export function normalizeStringList(value) {
  return (Array.isArray(value) ? value : String(value || "").split(","))
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}
