export const deepSeekClaudeProvider = "deepseek-via-claude";
export const deepSeekClaudeDefaultModel = "deepseek-v4-pro[1m]";
export const deepSeekClaudeFastModel = "deepseek-v4-flash";
export const deepSeekClaudeDefaultReasoningEffort = "xhigh";
export const deepSeekClaudeEffortEnvDefault = "max";
export const deepSeekClaudeSupportedCapabilities =
  "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking";

export function isDeepSeekClaudeBaseUrl(baseUrl = "") {
  return String(baseUrl || "").includes("deepseek.com");
}

export function isDeepSeekClaudeRuntime(runtime = {}) {
  const provider = String(runtime?.provider || "").trim();
  return provider === deepSeekClaudeProvider || isDeepSeekClaudeBaseUrl(runtime?.baseUrl);
}

export function deepSeekClaudeModelIds() {
  return [deepSeekClaudeDefaultModel, deepSeekClaudeFastModel];
}

export function deepSeekClaudeEffortEnvValue(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "xhigh" || normalized === "max") return "max";
  if (["low", "medium", "high"].includes(normalized)) return normalized;
  return deepSeekClaudeEffortEnvDefault;
}
