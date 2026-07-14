import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { resolveDesktopCodexCommand } from "./codexCommand.js";
import { codexCompatibleModel, listUnsupportedCodexModels, normalizeAllowedPermissionModes, normalizeReasoningEffort } from "./codexRuntime.js";
import { configuredWorkspaces } from "./codexWorkspaceConfig.js";
import { managedWorkspaces } from "./codexWorkspaceManager.js";
import { buildProxyEnv } from "./http.js";
import { buildAgentProcessEnv } from "./agentProcessEnv.js";

export function publicWorkspaces() {
  const byKey = new Map();
  for (const workspace of [...configuredWorkspaces(), ...managedWorkspaces()]) {
    const id = String(workspace.id || "").trim();
    const workspacePath = String(workspace.path || "").trim();
    if (!id || !workspacePath) continue;
    const key = `${id}:${workspacePath}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      id,
      label: String(workspace.label || id).trim(),
      path: workspacePath
    });
  }
  return Array.from(byKey.values());
}

export function publicCodexRuntime() {
  const commandInfo = resolveDesktopCodexCommand({
    configuredCommand: config.codex.command,
    bundledPath: config.codex.appPath
  });
  const codexConfig = readCodexRuntimeConfig();
  return {
    backendId: "codex",
    provider: "codex",
    backendName: "Codex",
    command: commandInfo.command,
    commandSource: commandInfo.source,
    commandDetail: commandInfo.detail,
    sandbox: config.codex.sandbox || "danger-full-access",
    approvalPolicy: config.codex.approvalPolicy,
    approvalTimeoutMs: config.codex.approvalTimeoutMs,
    model: codexCompatibleModel(codexConfig.model),
    unsupportedModels: listUnsupportedCodexModels(),
    supportedModels: [],
    allowedPermissionModes: normalizeAllowedPermissionModes(),
    supportedPermissionModes: ["strict", "approve", "full"],
    capabilities: {
      supports: {
        attachments: true,
        cancellation: true,
        contextUsage: true,
        compaction: true,
        approvalRequests: true,
        interactionRequests: true,
        gitSummary: true,
        worktree: true,
        threadArchive: true
      }
    },
    reasoningEffort: codexConfig.reasoningEffort,
    profile: "",
    timeoutMs: config.codex.timeoutMs,
    worktreeMode: config.codex.worktreeMode,
    codexConfig,
    runtimeFingerprint: codexConfig.fingerprint
  };
}

export function resolveCodexHome(env = process.env) {
  const home = env.HOME || os.homedir();
  return env.CODEX_HOME || path.join(home, ".codex");
}

export function readCodexRuntimeConfig(env = process.env) {
  const codexHome = resolveCodexHome(env);
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const configText = readTextFile(configPath);
  const authText = readTextFile(authPath);
  const parsed = parseCodexToml(configText);
  const modelProvider = String(parsed.root.model_provider || "").trim();
  const provider = modelProvider ? parsed.modelProviders[modelProvider] || {} : {};
  return {
    codexHome,
    configPath,
    authPath,
    configLoaded: configText !== null,
    authLoaded: authText !== null,
    modelProvider,
    providerName: String(provider.name || modelProvider || "").trim(),
    providerWireApi: String(provider.wire_api || provider.wireApi || "").trim(),
    providerBaseUrl: String(provider.base_url || provider.baseUrl || "").trim(),
    model: codexCompatibleModel(parsed.root.model),
    reasoningEffort: normalizeReasoningEffort(parsed.root.model_reasoning_effort || parsed.root.modelReasoningEffort),
    fingerprint: codexRuntimeFingerprint({ configText, authText, codexHome })
  };
}

export function buildCodexEnv(env = process.env) {
  const home = env.HOME || os.homedir();
  const codexHome = resolveCodexHome(env);
  const codexAuthApiKey = readCodexAuthApiKey(codexHome);
  return buildProxyEnv(buildAgentProcessEnv(codexBaseEnv(env), {
    HOME: home,
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: codexAuthApiKey || ""
  }));
}

function codexBaseEnv(sourceEnv) {
  const next = { ...sourceEnv };
  for (const key of Object.keys(next)) {
    if (isEchoModelProviderEnv(key)) delete next[key];
  }
  return next;
}

function isEchoModelProviderEnv(key) {
  return (
    key === "OPENAI_BASE_URL" ||
    key === "LLM_BASE_URL" ||
    key === "LLM_API_KEY" ||
    key === "LLM_MODEL" ||
    key === "ARK_API_KEY" ||
    key.startsWith("ANTHROPIC_") ||
    key.startsWith("CLAUDE_CODE_") ||
    key.startsWith("METIO_VOLCENGINE_CODING_") ||
    key.startsWith("VOLCENGINE_CODING_") ||
    key.startsWith("ECHO_CLAUDE_") ||
    key.startsWith("ECHO_VOLCENGINE_CODING_")
  );
}

function readCodexAuthApiKey(codexHome) {
  try {
    const authPath = path.join(codexHome, "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return String(auth.OPENAI_API_KEY || "").trim();
  } catch {
    return "";
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function codexRuntimeFingerprint({ configText, authText, codexHome }) {
  return createHash("sha256")
    .update(String(codexHome || ""))
    .update("\n")
    .update(configText || "")
    .update("\n")
    .update(authText || "")
    .digest("hex")
    .slice(0, 16);
}

function parseCodexToml(text) {
  const root = {};
  const modelProviders = {};
  let section = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = parseTomlScalar(line.slice(separatorIndex + 1).trim());
    if (!section) {
      root[key] = value;
      continue;
    }

    const providerMatch = section.match(/^model_providers\.(.+)$/);
    if (providerMatch) {
      const providerId = unquoteTomlKey(providerMatch[1].trim());
      modelProviders[providerId] ||= {};
      modelProviders[providerId][key] = value;
    }
  }
  return { root, modelProviders };
}

function stripTomlComment(line) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? "" : char;
      continue;
    }
    if (!quote && char === "#") return line.slice(0, index);
  }
  return line;
}

function parseTomlScalar(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

function unquoteTomlKey(value) {
  return String(parseTomlScalar(value) || value || "").trim();
}
