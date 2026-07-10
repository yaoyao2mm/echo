import { BaseBackendAdapter } from "./baseBackendAdapter.js";
import { CodexInteractiveRuntime } from "./codexInteractiveRunner.js";
import { probeCodexModels } from "./codexModelProbe.js";
import { publicCodexRuntime } from "./codexRunner.js";
import { normalizeSupportedModels } from "./codexRuntime.js";

const codexCapabilities = {
  supports: {
    attachments: true,
    cancellation: true,
    contextUsage: true,
    compaction: true,
    approvalRequests: true,
    interactionRequests: true,
    gitSummary: true,
    worktree: true
  }
};

export class CodexBackendAdapter extends BaseBackendAdapter {
  constructor(options = {}) {
    const runtimeSnapshotFactory = options.runtimeSnapshotFactory || publicCodexRuntime;
    const modelProbe = options.probeModels || probeCodexModels;
    super({
      ...options,
      runtimeFactory:
        options.runtimeFactory ||
        ((runtimeOptions = {}) =>
          new CodexInteractiveRuntime({
            ...runtimeOptions,
            agentId: runtimeOptions.agentId || options.agentId || "default-agent"
          })),
      runtimeSnapshotFactory,
      probeModels: async (probeOptions = {}) =>
        mergeConfiguredCodexModel(await modelProbe(probeOptions), runtimeSnapshotFactory()),
      modelCapabilitySource: "codex-app-server+desktop-config",
      snapshotDefaults: {
        backendId: "codex",
        provider: "codex",
        backendName: "Codex",
        capabilities: codexCapabilities
      }
    });
  }
}

export function mergeConfiguredCodexModel(models = [], runtime = {}) {
  const normalized = normalizeSupportedModels(models);
  const configuredModel = String(runtime.model || "").trim();
  if (!configuredModel) return normalized;
  const configuredIndex = normalized.findIndex((model) => model.id === configuredModel || model.model === configuredModel);
  if (configuredIndex >= 0) {
    return normalized.map((model, index) => ({ ...model, isDefault: index === configuredIndex }));
  }
  const reasoningEffort = String(runtime.reasoningEffort || "").trim().toLowerCase();
  return normalizeSupportedModels([
    ...normalized.map((model) => ({ ...model, isDefault: false })),
    {
      id: configuredModel,
      model: configuredModel,
      displayName: configuredModelDisplayName(configuredModel),
      description: "Desktop-configured Codex model.",
      isDefault: true,
      inputModalities: ["text", "image"],
      supportedReasoningEfforts: configuredModelReasoningEfforts(configuredModel),
      defaultReasoningEffort: reasoningEffort
    }
  ]);
}

function configuredModelDisplayName(model) {
  const normalized = String(model || "").trim();
  const gptMatch = normalized.match(/^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/i);
  if (gptMatch) {
    const suffix = String(gptMatch[2] || "")
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    return `GPT-${gptMatch[1]}${suffix ? ` ${suffix}` : ""}`;
  }
  return normalized
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function configuredModelReasoningEfforts(model) {
  const efforts = ["low", "medium", "high", "xhigh"];
  return /^gpt-5\.6(?:-|$)/i.test(String(model || "").trim()) ? [...efforts, "max"] : efforts;
}
