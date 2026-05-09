import { BaseBackendAdapter } from "./baseBackendAdapter.js";
import { ClaudeCodeInteractiveRuntime } from "./claudeCodeInteractiveRunner.js";
import { probeClaudeModels, publicClaudeRuntime } from "./claudeCodeRunner.js";
import { isDeepSeekClaudeBaseUrl } from "./deepSeekClaude.js";
import { isVolcengineCodingPlanBaseUrl } from "./volcengineCodingPlan.js";

const claudeCapabilities = {
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
};

export class ClaudeCodeBackendAdapter extends BaseBackendAdapter {
  constructor(options = {}) {
    const backendConfig = options.backendConfig || null;
    super({
      ...options,
      runtimeFactory:
        options.runtimeFactory ||
        ((runtimeOptions = {}) =>
          new ClaudeCodeInteractiveRuntime({
            ...runtimeOptions,
            agentId: runtimeOptions.agentId || options.agentId || "default-agent",
            backendConfig: backendConfig || undefined
          })),
      runtimeSnapshotFactory: options.runtimeSnapshotFactory || (() => publicClaudeRuntime(backendConfig || undefined)),
      probeModels: options.probeModels || ((probeOptions = {}) => probeClaudeModels(probeOptions, backendConfig || undefined)),
      modelCapabilitySource: (runtime = {}) =>
        isVolcengineCodingPlanBaseUrl(runtime.baseUrl)
          ? "volcengine-coding-plan"
          : isDeepSeekClaudeBaseUrl(runtime.baseUrl)
            ? "deepseek-models-api"
            : "config",
      snapshotDefaults: {
        backendId: backendConfig?.backendId || "claude-code",
        provider: backendConfig?.provider || "claude-code",
        backendName: backendConfig?.backendName || "Claude Code",
        capabilities: claudeCapabilities
      }
    });
  }
}
