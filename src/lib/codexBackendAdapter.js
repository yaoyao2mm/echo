import { BaseBackendAdapter } from "./baseBackendAdapter.js";
import { CodexInteractiveRuntime } from "./codexInteractiveRunner.js";
import { probeCodexModels } from "./codexModelProbe.js";
import { publicCodexRuntime } from "./codexRunner.js";

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
    super({
      ...options,
      runtimeFactory:
        options.runtimeFactory ||
        ((runtimeOptions = {}) =>
          new CodexInteractiveRuntime({
            ...runtimeOptions,
            agentId: runtimeOptions.agentId || options.agentId || "default-agent"
          })),
      runtimeSnapshotFactory: options.runtimeSnapshotFactory || publicCodexRuntime,
      probeModels: options.probeModels || probeCodexModels,
      modelCapabilitySource: "codex-app-server",
      snapshotDefaults: {
        backendId: "codex",
        provider: "codex",
        backendName: "Codex",
        capabilities: codexCapabilities
      }
    });
  }
}
