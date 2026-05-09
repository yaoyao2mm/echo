import {
  normalizeAllowedPermissionModes,
  normalizePermissionMode,
  normalizeSupportedModels
} from "./codexRuntime.js";

export const backendAdapterContractVersion = "echo.backend-adapter.v1";

export const backendRuntimeCommands = Object.freeze(["start", "message", "stop", "compact"]);

const defaultBackendEvents = Object.freeze([
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
]);

const defaultResultEvents = Object.freeze(["item.completed", "git.summary", "turn.completed", "turn.failed"]);

const defaultSupports = Object.freeze({
  text: true,
  attachments: false,
  cancellation: true,
  contextUsage: false,
  compaction: false,
  approvalRequests: false,
  interactionRequests: false,
  gitSummary: true,
  worktree: true
});

const validHealthStates = new Set(["ready", "degraded", "unavailable", "unknown"]);

export function normalizeBackendSnapshot(snapshot = {}, defaults = {}) {
  const normalized = snapshot && typeof snapshot === "object" ? snapshot : {};
  const fallback = defaults && typeof defaults === "object" ? defaults : {};
  const backendId = stringValue(normalized.backendId || normalized.provider || fallback.backendId || fallback.provider || "codex", "codex");
  const provider = stringValue(normalized.provider || fallback.provider || backendId, backendId);
  const backendName = stringValue(
    normalized.backendName ||
      normalized.name ||
      fallback.backendName ||
      fallback.name ||
      (backendId === "codex" || provider === "codex" ? "Codex" : backendId),
    backendId
  );
  const capabilities = normalizeBackendCapabilities(normalized.capabilities, fallback.capabilities);
  const unsupportedFeatures = normalizeStringList(
    normalized.unsupportedFeatures ?? fallback.unsupportedFeatures ?? capabilities.unsupportedFeatures,
    []
  );

  return {
    ...normalized,
    contractVersion: backendAdapterContractVersion,
    backendId,
    provider,
    backendName,
    command: stringValue(normalized.command ?? fallback.command, ""),
    commandSource: stringValue(normalized.commandSource ?? fallback.commandSource, ""),
    commandDetail: stringValue(normalized.commandDetail ?? fallback.commandDetail, ""),
    sandbox: stringValue(normalized.sandbox ?? fallback.sandbox, ""),
    approvalPolicy: stringValue(normalized.approvalPolicy ?? fallback.approvalPolicy, ""),
    approvalTimeoutMs: numberValue(normalized.approvalTimeoutMs ?? fallback.approvalTimeoutMs, null),
    model: stringValue(normalized.model ?? fallback.model, ""),
    unsupportedModels: normalizeStringList(normalized.unsupportedModels ?? fallback.unsupportedModels, []),
    supportedModels: normalizeSupportedModels(normalized.supportedModels ?? fallback.supportedModels ?? []),
    allowedPermissionModes: normalizeAllowedPermissionModes(
      normalizeStringList(normalized.allowedPermissionModes ?? fallback.allowedPermissionModes, [])
    ),
    reasoningEffort: stringValue(normalized.reasoningEffort ?? normalized.effort ?? fallback.reasoningEffort, "").toLowerCase(),
    profile: stringValue(normalized.profile ?? fallback.profile, ""),
    permissionMode: normalizePermissionMode(normalized.permissionMode || normalized.profile || fallback.permissionMode || fallback.profile),
    timeoutMs: numberValue(normalized.timeoutMs ?? fallback.timeoutMs, null),
    worktreeMode: normalizeWorktreeMode(normalized.worktreeMode ?? fallback.worktreeMode),
    modelCapabilitySource: stringValue(normalized.modelCapabilitySource ?? fallback.modelCapabilitySource, ""),
    modelCapabilityCheckedAt: stringValue(normalized.modelCapabilityCheckedAt ?? fallback.modelCapabilityCheckedAt, ""),
    modelCapabilityError: stringValue(normalized.modelCapabilityError ?? fallback.modelCapabilityError, ""),
    capabilities: {
      ...capabilities,
      unsupportedFeatures
    },
    unsupportedFeatures,
    health: normalizeBackendHealth(
      normalized.health,
      summarizeBackendHealth({ ...normalized, backendId, provider, backendName }, { checkedAt: "" })
    )
  };
}

export function normalizeBackendCapabilities(capabilities = {}, defaults = {}) {
  const normalized = capabilities && typeof capabilities === "object" ? capabilities : {};
  const fallback = defaults && typeof defaults === "object" ? defaults : {};
  const supports = normalizeSupports(normalized.supports, fallback.supports);
  return {
    ...fallback,
    ...normalized,
    commands: normalizeStringList(normalized.commands ?? fallback.commands, backendRuntimeCommands),
    events: normalizeStringList(normalized.events ?? fallback.events, defaultBackendEvents),
    resultEvents: normalizeStringList(normalized.resultEvents ?? fallback.resultEvents, defaultResultEvents),
    supports,
    limits: {
      ...(fallback.limits && typeof fallback.limits === "object" ? fallback.limits : {}),
      ...(normalized.limits && typeof normalized.limits === "object" ? normalized.limits : {})
    },
    unsupportedFeatures: normalizeStringList(normalized.unsupportedFeatures ?? fallback.unsupportedFeatures, [])
  };
}

export function summarizeBackendHealth(snapshot = {}, options = {}) {
  const backendId = stringValue(snapshot.backendId || snapshot.provider || "backend", "backend");
  const provider = stringValue(snapshot.provider || backendId, backendId);
  const backendName = stringValue(snapshot.backendName || snapshot.name || backendId, backendId);
  const command = stringValue(snapshot.command, "");
  const modelCapabilitySource = stringValue(snapshot.modelCapabilitySource, "");
  const modelCapabilityError = stringValue(snapshot.modelCapabilityError, "");
  const checkedAt = options.checkedAt === undefined ? new Date().toISOString() : stringValue(options.checkedAt, "");

  let state = "ready";
  let reason = "";
  if (!command) {
    state = "unavailable";
    reason = `${backendName} command is not available.`;
  } else if (modelCapabilityError || modelCapabilitySource === "unavailable") {
    state = "degraded";
    reason = modelCapabilityError || `${backendName} model capability probe is unavailable.`;
  }

  return {
    ok: state === "ready",
    state,
    backendId,
    provider,
    backendName,
    checkedAt,
    reason,
    checks: {
      command: Boolean(command),
      modelProbe: !modelCapabilityError && modelCapabilitySource !== "unavailable",
      ...(options.checks && typeof options.checks === "object" ? options.checks : {})
    }
  };
}

export function normalizeBackendHealth(value = {}, fallback = {}) {
  const normalized = value && typeof value === "object" ? value : {};
  const state = stringValue(normalized.state || fallback.state || "unknown", "unknown").toLowerCase();
  const health = {
    ...fallback,
    ...normalized,
    ok: typeof normalized.ok === "boolean" ? normalized.ok : Boolean(fallback.ok),
    state: validHealthStates.has(state) ? state : "unknown",
    backendId: stringValue(normalized.backendId || fallback.backendId, ""),
    provider: stringValue(normalized.provider || fallback.provider, ""),
    backendName: stringValue(normalized.backendName || fallback.backendName, ""),
    checkedAt: stringValue(normalized.checkedAt ?? fallback.checkedAt, ""),
    reason: stringValue(normalized.reason ?? fallback.reason, ""),
    checks: {
      ...(fallback.checks && typeof fallback.checks === "object" ? fallback.checks : {}),
      ...(normalized.checks && typeof normalized.checks === "object" ? normalized.checks : {})
    }
  };
  if (health.state !== "ready") health.ok = false;
  return health;
}

export function validateBackendSnapshot(snapshot = {}) {
  const normalized = normalizeBackendSnapshot(snapshot);
  const errors = [];
  if (normalized.contractVersion !== backendAdapterContractVersion) errors.push("snapshot.contractVersion is invalid");
  if (!normalized.backendId) errors.push("snapshot.backendId is required");
  if (!normalized.provider) errors.push("snapshot.provider is required");
  if (!normalized.backendName) errors.push("snapshot.backendName is required");

  for (const command of ["start", "message", "stop"]) {
    if (!normalized.capabilities.commands.includes(command)) {
      errors.push(`snapshot.capabilities.commands must include ${command}`);
    }
  }

  for (const key of [
    "attachments",
    "cancellation",
    "contextUsage",
    "compaction",
    "approvalRequests",
    "interactionRequests",
    "gitSummary",
    "worktree"
  ]) {
    if (typeof normalized.capabilities.supports[key] !== "boolean") {
      errors.push(`snapshot.capabilities.supports.${key} must be boolean`);
    }
  }

  if (!validHealthStates.has(normalized.health.state)) errors.push("snapshot.health.state is invalid");
  return { ok: errors.length === 0, errors, snapshot: normalized };
}

export function assertBackendSnapshotContract(snapshot = {}, options = {}) {
  const result = validateBackendSnapshot(snapshot);
  if (result.ok) return result.snapshot;
  throw new Error(`${contractLabel(options)} snapshot contract failed: ${result.errors.join("; ")}`);
}

export function validateBackendAdapter(adapter, options = {}) {
  const errors = [];
  for (const method of ["snapshot", "refreshCapabilities", "createRuntime", "healthCheck"]) {
    if (typeof adapter?.[method] !== "function") errors.push(`adapter.${method} must be a function`);
  }
  let snapshot = null;
  if (typeof adapter?.snapshot === "function") {
    const result = validateBackendSnapshot(adapter.snapshot());
    snapshot = result.snapshot;
    errors.push(...result.errors);
  }
  const expectedBackendId = stringValue(options.backendId, "");
  if (expectedBackendId && snapshot?.backendId && snapshot.backendId !== expectedBackendId) {
    errors.push(`adapter snapshot backendId must be ${expectedBackendId}`);
  }
  return { ok: errors.length === 0, errors, snapshot };
}

export function assertBackendAdapterContract(adapter, options = {}) {
  const result = validateBackendAdapter(adapter, options);
  if (result.ok) return adapter;
  throw new Error(`${contractLabel(options)} adapter contract failed: ${result.errors.join("; ")}`);
}

export function validateBackendRuntime(runtime, options = {}) {
  const errors = [];
  if (typeof runtime?.handleCommand !== "function") errors.push("runtime.handleCommand must be a function");
  if (typeof runtime?.stop !== "function") errors.push("runtime.stop must be a function");
  if (runtime && typeof runtime === "object" && typeof runtime.warmup !== "undefined" && typeof runtime.warmup !== "function") {
    errors.push("runtime.warmup must be a function when present");
  }
  return { ok: errors.length === 0, errors };
}

export function assertBackendRuntimeContract(runtime, options = {}) {
  const result = validateBackendRuntime(runtime, options);
  if (result.ok) return runtime;
  throw new Error(`${contractLabel(options)} runtime contract failed: ${result.errors.join("; ")}`);
}

function normalizeSupports(value = {}, defaults = {}) {
  const normalized = value && typeof value === "object" ? value : {};
  const fallback = defaults && typeof defaults === "object" ? defaults : {};
  const supports = { ...defaultSupports, ...fallback, ...normalized };
  for (const key of Object.keys(defaultSupports)) {
    supports[key] = Boolean(supports[key]);
  }
  return supports;
}

function normalizeStringList(value, fallback = []) {
  const source = value === undefined || value === null ? fallback : value;
  const items = (Array.isArray(source) ? source : String(source || "").split(","))
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return items.length > 0 ? Array.from(new Set(items)) : Array.from(fallback);
}

function normalizeWorktreeMode(value) {
  const mode = stringValue(value, "").toLowerCase();
  return ["off", "optional", "always"].includes(mode) ? mode : "off";
}

function stringValue(value, fallback) {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function contractLabel(options = {}) {
  return stringValue(options.backendId || options.provider || "backend", "backend");
}
