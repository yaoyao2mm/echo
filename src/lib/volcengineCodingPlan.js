export const volcengineCodingPlanProvider = "volcengine-coding-plan";
export const volcengineCodingPlanBaseUrl = "https://ark.cn-beijing.volces.com/api/coding";

const modelEntries = Object.freeze([
  {
    id: "ark-code-latest",
    displayName: "Ark Code Latest",
    description: "Volcengine Coding Plan managed coding-model alias.",
    isDefault: true
  },
  {
    id: "doubao-seed-2.0-code",
    displayName: "Doubao Seed 2.0 Code",
    description: "Primary Coding Plan model for code generation and code understanding."
  },
  {
    id: "doubao-seed-2.0-pro",
    displayName: "Doubao Seed 2.0 Pro",
    description: "Coding Plan model for deeper reasoning and project planning."
  },
  {
    id: "doubao-seed-2.0-lite",
    displayName: "Doubao Seed 2.0 Lite",
    description: "Lightweight Coding Plan model for faster coding tasks."
  },
  {
    id: "doubao-seed-code",
    displayName: "Doubao Seed Code",
    description: "Coding-specialized Doubao model for frontend and bugfix workflows."
  },
  {
    id: "glm-5.1",
    displayName: "GLM 5.1",
    description: "High-output reasoning model available through Coding Plan."
  },
  {
    id: "glm-4.7",
    displayName: "GLM 4.7",
    description: "General coding and reasoning model available through Coding Plan."
  },
  {
    id: "deepseek-v3.2",
    displayName: "DeepSeek V3.2",
    description: "Balanced coding model available through Coding Plan."
  },
  {
    id: "kimi-k2.6",
    displayName: "Kimi K2.6",
    description: "Long-context agent coding model available through Coding Plan."
  },
  {
    id: "kimi-k2.5",
    displayName: "Kimi K2.5",
    description: "Long-context coding model available through Coding Plan."
  },
  {
    id: "minimax-m2.7",
    displayName: "MiniMax M2.7",
    description: "High-context coding model available through Coding Plan."
  },
  {
    id: "minimax-m2.5",
    displayName: "MiniMax M2.5",
    description: "High-context Coding Plan model for agent tasks."
  }
]);

const modelById = new Map(modelEntries.map((model) => [model.id, model]));

export function volcengineCodingPlanModels() {
  return modelEntries.map((model) => ({ ...model }));
}

export function volcengineCodingPlanModelIds() {
  return modelEntries.map((model) => model.id);
}

export function volcengineCodingPlanDefaultModelId() {
  return modelEntries.find((model) => model.isDefault)?.id || modelEntries[0]?.id || "";
}

export function volcengineCodingPlanModelInfo(id) {
  const model = modelById.get(String(id || "").trim());
  return model ? { ...model } : null;
}

export function isVolcengineCodingPlanBaseUrl(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\/+$/, "");
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.hostname.endsWith("volces.com") && url.pathname.includes("/api/coding");
  } catch {
    return raw.includes("volces.com") && raw.includes("/api/coding");
  }
}
