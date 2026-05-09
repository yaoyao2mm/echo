import { normalizeBackendSnapshot, summarizeBackendHealth } from "./backendAdapterContract.js";

export class BaseBackendAdapter {
  constructor(options = {}) {
    this.agentId = String(options.agentId || "default-agent").trim() || "default-agent";
    this.runtimeFactory = options.runtimeFactory;
    this.runtimeSnapshotFactory = options.runtimeSnapshotFactory;
    this.probeModels = options.probeModels || (async () => []);
    this.snapshotDefaults = options.snapshotDefaults || {};
    this.modelCapabilitySource = options.modelCapabilitySource || "";
    if (typeof this.runtimeFactory !== "function") throw new Error("BaseBackendAdapter requires a runtimeFactory.");
    if (typeof this.runtimeSnapshotFactory !== "function") throw new Error("BaseBackendAdapter requires a runtimeSnapshotFactory.");
    this.runtimeStatus = this.normalizeSnapshot(this.runtimeSnapshotFactory());
    this.refreshPromise = null;
  }

  snapshot() {
    return this.runtimeStatus;
  }

  createRuntime(options = {}) {
    return this.runtimeFactory({
      ...options,
      agentId: this.agentId
    });
  }

  async refreshCapabilities({ activeCommandCount = 0, runningSessionCount = 0 } = {}) {
    const runtime = this.normalizeSnapshot(this.runtimeSnapshotFactory());
    const previous = this.runtimeStatus || runtime;
    if (!runtime.command) {
      this.runtimeStatus = runtime;
      return runtime;
    }

    if (Number(activeCommandCount || 0) > 0 || Number(runningSessionCount || 0) > 0) {
      this.runtimeStatus = this.normalizeSnapshot({
        ...runtime,
        supportedModels: previous.supportedModels?.length ? previous.supportedModels : runtime.supportedModels || [],
        modelCapabilitySource: previous.modelCapabilitySource || "deferred",
        modelCapabilityCheckedAt: previous.modelCapabilityCheckedAt || "",
        modelCapabilityError: previous.modelCapabilityError || ""
      });
      return this.runtimeStatus;
    }

    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const supportedModels = await this.probeModels({ timeoutMs: 15000 });
        this.runtimeStatus = this.normalizeSnapshot({
          ...runtime,
          supportedModels,
          modelCapabilitySource: this.resolveModelCapabilitySource(runtime),
          modelCapabilityCheckedAt: new Date().toISOString(),
          modelCapabilityError: ""
        });
      } catch (error) {
        this.runtimeStatus = this.normalizeSnapshot({
          ...runtime,
          supportedModels: previous.supportedModels?.length ? previous.supportedModels : runtime.supportedModels || [],
          modelCapabilitySource: "unavailable",
          modelCapabilityCheckedAt: new Date().toISOString(),
          modelCapabilityError: error.message
        });
      }
      return this.runtimeStatus;
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async healthCheck() {
    this.runtimeStatus = this.normalizeSnapshot({
      ...this.runtimeStatus,
      health: summarizeBackendHealth(this.runtimeStatus)
    });
    return this.runtimeStatus.health;
  }

  normalizeSnapshot(snapshot = {}) {
    const normalized = normalizeBackendSnapshot(snapshot, this.snapshotDefaults);
    return {
      ...normalized,
      health: summarizeBackendHealth(normalized)
    };
  }

  resolveModelCapabilitySource(runtime = {}) {
    if (typeof this.modelCapabilitySource === "function") return this.modelCapabilitySource(runtime);
    return String(this.modelCapabilitySource || runtime.modelCapabilitySource || "config").trim() || "config";
  }
}
