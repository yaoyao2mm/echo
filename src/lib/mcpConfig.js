import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { buildAgentProcessEnv } from "./agentProcessEnv.js";

const stateFileName = "desktop-mcp-state.json";
const managedBlockStart = "# Echo MCP managed block";
const managedBlockEnd = "# End Echo MCP managed block";
const knownClientIds = new Set(["codex", "claude-code"]);
const mcpSnapshotVersion = 1;
const mcpProtocolVersion = "2025-06-18";
const mcpToolProbeTimeoutMs = 3000;
const mcpToolProbeMaxErrorChars = 800;
const mcpToolProbeMaxOutputChars = 1200;
const toolSignatureCache = new Map();
let toolSignatureProbe = probeMcpServerTools;

export function mcpCatalog() {
  const servers = [];

  const profiles = [
    {
      id: "off",
      label: "关闭",
      description: "不向后端暴露 MCP 工具",
      serverIds: []
    }
  ];

  return {
    enabled: config.mcp.enabled,
    clients: [
      { id: "codex", label: "Codex", description: "写入 Codex config.toml" },
      { id: "claude-code", label: "Claude Code", description: "通过 claude mcp add-json 应用" }
    ],
    servers,
    profiles
  };
}

export function mcpRuntimeSnapshot(options = {}) {
  const catalog = mcpCatalog();
  const state = readMcpState();
  return buildMcpRuntimeSnapshot(catalog, state, options);
}

export async function refreshMcpToolSignatures(options = {}) {
  const catalog = options.catalog || mcpCatalog();
  const servers = Array.isArray(options.servers) ? options.servers : catalog.servers || [];
  const force = options.force === true;
  const results = [];
  for (const server of servers) {
    const serverId = String(server?.id || "").trim();
    if (!serverId) continue;
    if (!force && toolSignatureCache.has(serverId)) {
      results.push(toolSignatureCache.get(serverId));
      continue;
    }
    const checkedAt = new Date().toISOString();
    try {
      const tools = await toolSignatureProbe(server, options);
      const signature = normalizeToolSignature(serverId, tools, checkedAt);
      toolSignatureCache.set(serverId, signature);
      results.push(signature);
    } catch (error) {
      const signature = {
        serverId,
        status: "failed",
        checkedAt,
        toolsHash: "",
        toolCount: 0,
        error: String(error?.message || error || "MCP tool probe failed.").trim().slice(0, mcpToolProbeMaxErrorChars)
      };
      toolSignatureCache.set(serverId, signature);
      results.push(signature);
    }
  }
  return results;
}

export function setMcpToolSignatureProbeForTest(probe) {
  toolSignatureProbe = typeof probe === "function" ? probe : probeMcpServerTools;
  toolSignatureCache.clear();
}

function buildMcpRuntimeSnapshot(catalog, state, options = {}) {
  const lastApplyResult = state.lastApplyResult || null;
  const appliedProfileId = normalizeAppliedProfileId(lastApplyResult, catalog);
  const codexProfileId = codexConfiguredProfileId(catalog);
  const appliedTargets = normalizeAppliedTargetClients(lastApplyResult);
  const activeProfileId =
    normalizeProfileId(options.activeProfileId || "") ||
    codexProfileId ||
    (appliedProfileId === "off" && appliedTargets.includes("codex") ? "off" : "") ||
    (appliedProfileId && !appliedTargets.includes("codex") ? appliedProfileId : "");
  const targetClients = normalizeTargetClients(state.targetClients, config.mcp.defaultTargets);
  const toolSignatures = normalizeToolSignatures(options.toolSignatures || Object.fromEntries(toolSignatureCache));
  const serverSnapshots = serverSnapshotSummaries(catalog.servers, toolSignatures, state.appliedServerSnapshotHashes || {});
  const snapshotHash = mcpSnapshotHash({
    enabled: catalog.enabled,
    activeProfileId,
    defaultProfileId: defaultProfileId(catalog),
    targetClients,
    profiles: catalog.profiles,
    servers: serverSnapshots.map((item) => item.signature)
  });
  const appliedSnapshotHash = String(state.appliedSnapshotHash || lastApplyResult?.appliedSnapshotHash || "").trim();
  const activeProfile = profileById(activeProfileId, catalog);
  const activeServerIds = new Set(Array.isArray(activeProfile?.serverIds) ? activeProfile.serverIds : []);
  const activeServerSnapshots = serverSnapshots.filter((item) => activeServerIds.has(item.serverId));
  const activeServersComparable =
    activeServerSnapshots.length > 0 && activeServerSnapshots.every((item) => item.toolProbeStatus === "ok");
  const hasUpdates = Boolean(
    activeProfileId &&
      activeProfileId !== "off" &&
      activeServersComparable &&
      appliedSnapshotHash &&
      snapshotHash &&
      appliedSnapshotHash !== snapshotHash
  );
  const probeStatus = summarizeToolProbeStatus(toolSignatures, catalog.servers);
  return {
    ...catalog,
    servers: catalog.servers.map((server) => {
      const summary = serverSnapshots.find((item) => item.serverId === server.id);
      return {
        ...server,
        snapshotHash: summary?.snapshotHash || "",
        appliedSnapshotHash: summary?.appliedSnapshotHash || "",
        hasUpdates: Boolean(summary?.hasUpdates),
        toolProbeStatus: summary?.toolProbeStatus || "unknown",
        toolProbeError: summary?.toolProbeError || ""
      };
    }),
    defaultProfileId: defaultProfileId(catalog),
    activeProfileId,
    targetClients,
    snapshotVersion: mcpSnapshotVersion,
    snapshotHash,
    appliedSnapshotHash,
    hasUpdates,
    checkedAt: probeStatus.checkedAt,
    toolProbeStatus: probeStatus.status,
    toolProbeError: probeStatus.error,
    lastAppliedAt: String(state.lastAppliedAt || ""),
    lastApplyResult
  };
}

export async function applyMcpProfile(input = {}) {
  if (!config.mcp.enabled) {
    return {
      ok: false,
      error: "Echo MCP management is disabled by ECHO_MCP_ENABLED=false."
    };
  }

  const catalog = mcpCatalog();
  const profileId = normalizeProfileId(input.profileId || input.id);
  const profile = profileById(profileId, catalog);
  if (!profile) {
    return {
      ok: false,
      error: `Unknown MCP profile: ${String(input.profileId || input.id || "")}`
    };
  }

  const requestedTargetClients = input.targetClients ?? input.targets;
  const targetClients = normalizeTargetClients(
    requestedTargetClients,
    requestedTargetClients == null ? config.mcp.defaultTargets : []
  );
  if (targetClients.length === 0) {
    return {
      ok: false,
      error: "At least one MCP target client is required."
    };
  }

  const servers = serversForProfile(profile, catalog);
  const results = [];
  for (const clientId of targetClients) {
    if (clientId === "codex") {
      results.push(await applyCodexMcpServers(servers, catalog));
      continue;
    }
    if (clientId === "claude-code") {
      results.push(await applyClaudeMcpServers(servers, catalog));
      continue;
    }
    results.push({ clientId, ok: false, error: `Unsupported MCP target client: ${clientId}` });
  }

  const ok = results.every((result) => result.ok);
  await refreshMcpToolSignatures({ catalog, force: true });
  const snapshot = {
    ok,
    profileId,
    profile,
    targetClients,
    targets: results,
    appliedAt: new Date().toISOString()
  };
  const previousState = readMcpState();
  const nextState = {
    ...previousState,
    activeProfileId: profileId,
    targetClients,
    lastAppliedAt: snapshot.appliedAt,
    lastApplyResult: snapshot
  };
  if (ok) {
    const runtimeSnapshot = buildMcpRuntimeSnapshot(catalog, {
      ...previousState,
      ...nextState,
      lastApplyResult: snapshot
    }, {
      activeProfileId: profileId
    });
    snapshot.appliedSnapshotHash = runtimeSnapshot.snapshotHash;
    snapshot.appliedServerSnapshotHashes = serverSnapshotHashMap(runtimeSnapshot.servers);
    nextState.appliedSnapshotHash = runtimeSnapshot.snapshotHash;
    nextState.appliedServerSnapshotHashes = snapshot.appliedServerSnapshotHashes;
    nextState.lastApplyResult = snapshot;
  }
  writeMcpState({
    ...nextState
  });

  return snapshot;
}

export function buildCodexMcpConfig(existingText, servers = []) {
  const serverIds = new Set(mcpCatalog().servers.map((server) => server.id));
  const cleaned = removeManagedMcpSections(String(existingText || ""), serverIds);
  const blocks = servers.map(codexServerBlock).filter(Boolean);
  return [cleaned.trimEnd(), ...blocks].filter(Boolean).join("\n\n") + "\n";
}

function applyCodexMcpServers(servers) {
  const configPath = config.codex.configPath;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const next = buildCodexMcpConfig(existing, servers);
    fs.writeFileSync(configPath, next, { mode: 0o600 });
    chmodIfPossible(configPath, 0o600);
    return {
      clientId: "codex",
      ok: true,
      status: servers.length ? "configured" : "removed",
      serverIds: servers.map((server) => server.id),
      detail: "Codex MCP config updated."
    };
  } catch (error) {
    return {
      clientId: "codex",
      ok: false,
      status: "failed",
      error: error.message
    };
  }
}

async function applyClaudeMcpServers(servers, catalog) {
  const results = [];
  const configuredIds = new Set(servers.map((server) => server.id));
  for (const server of catalog.servers) {
    if (configuredIds.has(server.id)) {
      results.push(await runClaudeMcpAdd(server));
    } else {
      results.push(await runClaudeMcpRemove(server.id));
    }
  }
  const ok = results.every((result) => result.ok);
  return {
    clientId: "claude-code",
    ok,
    status: ok ? (servers.length ? "configured" : "removed") : "failed",
    serverIds: servers.map((server) => server.id),
    detail: ok ? "Claude Code MCP config updated." : "",
    results,
    error: ok ? "" : results.find((result) => !result.ok)?.error || "Claude Code MCP update failed."
  };
}

function runClaudeMcpAdd(server) {
  const serverJson = JSON.stringify(claudeServerJson(server));
  return runClaudeMcpCommand(["mcp", "add-json", server.id, serverJson, "--scope", config.mcp.claudeScope], {
    action: "add",
    serverId: server.id
  });
}

function claudeServerJson(server) {
  if (isHttpMcpServer(server)) {
    return {
      type: "http",
      url: server.url
    };
  }
  return {
    type: "stdio",
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: server.env
  };
}

async function runClaudeMcpRemove(serverId) {
  const result = await runClaudeMcpCommand(["mcp", "remove", serverId, "--scope", config.mcp.claudeScope], {
    action: "remove",
    serverId
  });
  if (!result.ok && /not found|does not exist|unknown/i.test(result.error || "")) {
    return { ...result, ok: true, ignored: true };
  }
  return result;
}

function runClaudeMcpCommand(args, metadata = {}) {
  const command = config.claude.command || "claude";
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: buildAgentProcessEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({
        clientId: "claude-code",
        ok: false,
        ...metadata,
        error: error.message
      });
    });
    child.on("close", (code, signal) => {
      const ok = code === 0;
      resolve({
        clientId: "claude-code",
        ok,
        ...metadata,
        code,
        signal: signal || "",
        output: stdout.trim().slice(0, 2000),
        error: ok ? "" : (stderr || stdout || `claude exited with ${signal || code}`).trim().slice(0, 4000)
      });
    });
  });
}

function codexServerBlock(server) {
  if (isHttpMcpServer(server)) {
    return [
      `${managedBlockStart}: ${server.id}`,
      `[mcp_servers.${server.id}]`,
      `url = ${tomlString(server.url)}`,
      managedBlockEnd
    ].join("\n");
  }
  const lines = [
    `${managedBlockStart}: ${server.id}`,
    `[mcp_servers.${server.id}]`,
    `command = ${tomlString(server.command)}`,
    `args = ${tomlArray(server.args)}`
  ];
  if (server.cwd) lines.push(`cwd = ${tomlString(server.cwd)}`);
  const envEntries = Object.entries(server.env || {}).filter(([, value]) => String(value || "").trim());
  if (envEntries.length > 0) {
    lines.push("");
    lines.push(`[mcp_servers.${server.id}.env]`);
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  lines.push(managedBlockEnd);
  return lines.join("\n");
}

function removeManagedMcpSections(text, serverIds) {
  const ids = serverIds instanceof Set ? serverIds : new Set(serverIds || []);
  const lines = String(text || "").split(/\r?\n/);
  const next = [];
  let skipBlock = false;
  let skipSection = false;
  for (const line of lines) {
    const section = mcpSectionId(line);
    if (line.startsWith(managedBlockStart)) {
      skipBlock = true;
      continue;
    }
    if (skipBlock) {
      if (line.startsWith(managedBlockEnd)) skipBlock = false;
      continue;
    }
    if (skipSection && /^\s*\[/.test(line)) skipSection = false;
    if (skipSection) continue;
    if (section && ids.has(section)) {
      skipSection = true;
      continue;
    }
    next.push(line);
  }
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}

function mcpSectionId(line) {
  const match = String(line || "").trim().match(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(?:\.env)?\]$/);
  return match ? match[1] || match[2] || "" : "";
}

function mcpMainSectionId(line) {
  const match = String(line || "").trim().match(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]$/);
  return match ? match[1] || match[2] || "" : "";
}

function serversForProfile(profile, catalog) {
  const wanted = new Set(Array.isArray(profile.serverIds) ? profile.serverIds : []);
  return catalog.servers.filter((server) => wanted.has(server.id));
}

function profileById(profileId, catalog) {
  return catalog.profiles.find((profile) => profile.id === profileId) || null;
}

function normalizeProfileId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function profileExists(profileId, catalog) {
  return Boolean(profileId && profileById(profileId, catalog));
}

function defaultProfileId(catalog) {
  const configured = String(config.mcp.defaultProfile || "").trim();
  if (profileExists(configured, catalog)) return configured;
  return catalog.profiles.find((profile) => profile.id !== "off")?.id || "off";
}

function normalizeAppliedProfileId(result, catalog) {
  if (!result || result.ok !== true) return "";
  const profileId = normalizeProfileId(result.profileId);
  return profileExists(profileId, catalog) ? profileId : "";
}

function normalizeAppliedTargetClients(result) {
  if (!result || result.ok !== true) return [];
  const direct = normalizeTargetClients(result.targetClients || [], []);
  if (direct.length > 0) return direct;
  const targets = Array.isArray(result.targets) ? result.targets : [];
  return normalizeTargetClients(targets.map((target) => target?.clientId), []);
}

function codexConfiguredProfileId(catalog) {
  const serverIds = readCodexMcpServerIds(catalog);
  if (serverIds.size === 0) return "";
  const configured = Array.from(serverIds).sort();
  const profile = catalog.profiles.find((candidate) => {
    const ids = Array.isArray(candidate.serverIds) ? candidate.serverIds.slice().sort() : [];
    return ids.length === configured.length && ids.every((id, index) => id === configured[index]);
  });
  return profile?.id || "";
}

function readCodexMcpServerIds(catalog) {
  const knownIds = new Set(catalog.servers.map((server) => server.id));
  const configured = new Set();
  try {
    const text = fs.existsSync(config.codex.configPath) ? fs.readFileSync(config.codex.configPath, "utf8") : "";
    for (const line of text.split(/\r?\n/)) {
      const section = mcpMainSectionId(line);
      if (section && knownIds.has(section)) configured.add(section);
    }
  } catch {
    return new Set();
  }
  return configured;
}

function normalizeTargetClients(value, fallback = []) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const clients = raw.map((item) => String(item || "").trim()).filter((item) => knownClientIds.has(item));
  const normalized = clients.length ? clients : fallback.map((item) => String(item || "").trim()).filter((item) => knownClientIds.has(item));
  return Array.from(new Set(normalized));
}

function serverSnapshotSummaries(servers = [], toolSignatures = {}, appliedHashes = {}) {
  return servers.map((server) => {
    const serverId = String(server?.id || "").trim();
    const toolSignature = toolSignatures[serverId] || {};
    const signature = {
      id: serverId,
      transport: normalizeServerTransport(server),
      url: isHttpMcpServer(server) ? String(server.url || "").trim() : "",
      command: String(server.command || "").trim(),
      args: Array.isArray(server.args) ? server.args.map((arg) => String(arg || "")) : [],
      cwd: String(server.cwd || "").trim(),
      env: stableObject(server.env || {}),
      toolsHash: String(toolSignature.toolsHash || "").trim(),
      toolProbeStatus: String(toolSignature.status || "unknown").trim() || "unknown"
    };
    const snapshotHash = mcpSnapshotHash(signature);
    const appliedSnapshotHash = String(appliedHashes?.[serverId] || "").trim();
    return {
      serverId,
      signature,
      snapshotHash,
      appliedSnapshotHash,
      hasUpdates: Boolean(
        signature.toolProbeStatus === "ok" &&
          appliedSnapshotHash &&
          appliedSnapshotHash !== snapshotHash
      ),
      toolProbeStatus: signature.toolProbeStatus,
      toolProbeError: String(toolSignature.error || "").trim().slice(0, mcpToolProbeMaxErrorChars)
    };
  });
}

function serverSnapshotHashMap(servers = []) {
  const entries = {};
  for (const server of servers) {
    const id = String(server?.id || "").trim();
    const hash = String(server?.snapshotHash || "").trim();
    if (id && hash) entries[id] = hash;
  }
  return entries;
}

function summarizeToolProbeStatus(toolSignatures = {}, servers = []) {
  const signatures = servers
    .map((server) => toolSignatures[String(server?.id || "").trim()])
    .filter(Boolean);
  if (signatures.length === 0) return { status: "unknown", checkedAt: "", error: "" };
  const failed = signatures.filter((signature) => signature.status === "failed");
  const ok = signatures.filter((signature) => signature.status === "ok");
  const status = failed.length && ok.length ? "partial" : failed.length ? "failed" : "ok";
  const checkedAt = signatures
    .map((signature) => String(signature.checkedAt || ""))
    .filter(Boolean)
    .sort()
    .at(-1) || "";
  return {
    status,
    checkedAt,
    error: failed[0]?.error || ""
  };
}

function normalizeToolSignatures(value = {}) {
  const entries = Array.isArray(value) ? value.map((item) => [item?.serverId, item]) : Object.entries(value || {});
  const normalized = {};
  for (const [key, item] of entries) {
    const serverId = String(item?.serverId || key || "").trim();
    if (!serverId) continue;
    normalized[serverId] = {
      serverId,
      status: String(item?.status || "unknown").trim() || "unknown",
      checkedAt: String(item?.checkedAt || "").trim(),
      toolsHash: String(item?.toolsHash || "").trim(),
      toolCount: Number(item?.toolCount || 0) || 0,
      error: String(item?.error || "").trim().slice(0, mcpToolProbeMaxErrorChars)
    };
  }
  return normalized;
}

function normalizeToolSignature(serverId, tools = [], checkedAt = "") {
  const normalizedTools = (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const name = String(tool?.name || "").trim();
      if (!name) return null;
      return {
        name,
        descriptionHash: shortHash(String(tool.description || "")),
        inputSchemaHash: shortHash(stableStringify(tool.inputSchema || tool.input_schema || {})),
        annotationsHash: shortHash(stableStringify(tool.annotations || {}))
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    serverId,
    status: "ok",
    checkedAt,
    toolsHash: shortHash(stableStringify(normalizedTools)),
    toolCount: normalizedTools.length,
    error: ""
  };
}

function isHttpMcpServer(server) {
  return normalizeServerTransport(server) === "streamable_http" && /^https?:\/\//i.test(String(server?.url || ""));
}

function normalizeServerTransport(server) {
  const raw = String(server?.transport || (server?.url ? "streamable_http" : "stdio"))
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (raw === "http" || raw === "streamable_http" || raw === "streamablehttp") return "streamable_http";
  return "stdio";
}

function stableObject(value = {}) {
  const next = {};
  for (const key of Object.keys(value || {}).sort()) {
    next[key] = String(value[key] || "");
  }
  return next;
}

function mcpSnapshotHash(value) {
  return shortHash(stableStringify(value));
}

function shortHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function stableStringify(value) {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value) {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const key of Object.keys(value).sort()) {
    next[key] = sortForStableStringify(value[key]);
  }
  return next;
}

async function probeMcpServerTools(server) {
  if (isHttpMcpServer(server)) return probeHttpMcpServerTools(server);

  const command = String(server?.command || "").trim();
  if (!command) throw new Error("MCP server command is required.");
  const child = spawn(command, Array.isArray(server.args) ? server.args : [], {
    cwd: server.cwd || process.cwd(),
    env: buildAgentProcessEnv(process.env, server.env || {}),
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stderr = "";
  let stdoutBuffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  let settled = false;

  const cleanup = () => {
    if (settled) return;
    settled = true;
    for (const pendingRequest of pending.values()) {
      clearTimeout(pendingRequest.timer);
    }
    pending.clear();
    child.kill();
  };

  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-mcpToolProbeMaxOutputChars);
  });
  child.stdout?.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    const messages = readMcpMessages();
    for (const message of messages) {
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) continue;
      clearTimeout(pendingRequest.timer);
      pending.delete(message.id);
      if (message.error) {
        pendingRequest.reject(new Error(message.error.message || `MCP request ${pendingRequest.method} failed.`));
      } else {
        pendingRequest.resolve(message.result || {});
      }
    }
  });

  const closed = new Promise((_, reject) => {
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      const detail = stderr.trim() || `MCP server exited with ${signal || code}`;
      reject(new Error(detail));
    });
  });

  try {
    const initialized = await Promise.race([
      request("initialize", {
        protocolVersion: mcpProtocolVersion,
        capabilities: {},
        clientInfo: { name: "echo", version: "0.1.0" }
      }),
      closed
    ]);
    notify("notifications/initialized");
    const listed = await Promise.race([request("tools/list", {}), closed]);
    cleanup();
    return Array.isArray(listed.tools) ? listed.tools : Array.isArray(initialized?.tools) ? initialized.tools : [];
  } catch (error) {
    cleanup();
    const message = stderr.trim();
    if (message && !String(error.message || "").includes(message)) {
      throw new Error(`${error.message}; ${message}`.slice(0, mcpToolProbeMaxErrorChars));
    }
    throw error;
  }

  function request(method, params) {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, mcpToolProbeTimeoutMs);
      timer.unref?.();
      pending.set(id, { method, resolve, reject, timer });
    });
    writeMcpMessage({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  function notify(method, params = {}) {
    writeMcpMessage({ jsonrpc: "2.0", method, params });
  }

  function writeMcpMessage(message) {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  function readMcpMessages() {
    const messages = [];
    while (stdoutBuffer.length > 0) {
      let body = "";
      if (/^content-length:/i.test(stdoutBuffer.toString("utf8", 0, Math.min(stdoutBuffer.length, 32)))) {
        const headerEnd = stdoutBuffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) break;
        const header = stdoutBuffer.slice(0, headerEnd).toString("utf8");
        const lengthMatch = header.match(/content-length:\s*(\d+)/i);
        if (!lengthMatch) {
          stdoutBuffer = stdoutBuffer.slice(headerEnd + 4);
          continue;
        }
        const length = Number(lengthMatch[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (stdoutBuffer.length < bodyEnd) break;
        body = stdoutBuffer.slice(bodyStart, bodyEnd).toString("utf8");
        stdoutBuffer = stdoutBuffer.slice(bodyEnd);
      } else {
        const lineEnd = stdoutBuffer.indexOf("\n");
        if (lineEnd < 0) break;
        body = stdoutBuffer.slice(0, lineEnd).toString("utf8").trim();
        stdoutBuffer = stdoutBuffer.slice(lineEnd + 1);
        if (!body) continue;
      }
      try {
        messages.push(JSON.parse(body));
      } catch {
        // Ignore malformed protocol output from an MCP server probe.
      }
    }
    return messages;
  }
}

async function probeHttpMcpServerTools(server) {
  const endpoint = String(server?.url || "").trim();
  if (!endpoint) throw new Error("MCP server URL is required.");
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), mcpToolProbeTimeoutMs);
  timer.unref?.();
  let sessionId = "";
  let nextId = 1;
  try {
    const initialized = await request("initialize", {
      protocolVersion: mcpProtocolVersion,
      capabilities: {},
      clientInfo: { name: "echo", version: "0.1.0" }
    });
    await notify("notifications/initialized");
    const listed = await request("tools/list", {});
    return Array.isArray(listed.tools) ? listed.tools : Array.isArray(initialized?.tools) ? initialized.tools : [];
  } finally {
    clearTimeout(timer);
  }

  async function request(method, params) {
    const response = await postMcpMessage({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params
    });
    if (response.error) throw new Error(response.error.message || `MCP request ${method} failed.`);
    return response.result || {};
  }

  async function notify(method, params = {}) {
    await postMcpMessage({
      jsonrpc: "2.0",
      method,
      params
    });
  }

  async function postMcpMessage(message) {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json"
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: timeoutController.signal
    });
    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) sessionId = nextSessionId;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP MCP probe failed with ${response.status}: ${text}`.slice(0, mcpToolProbeMaxErrorChars));
    }
    if (!text.trim()) return {};
    return JSON.parse(text);
  }
}

function readMcpState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpStatePath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMcpState(state) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const filePath = mcpStatePath();
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  chmodIfPossible(filePath, 0o600);
}

function mcpStatePath() {
  return path.join(config.dataDir, stateFileName);
}

function tomlString(value) {
  return JSON.stringify(String(value || ""));
}

function tomlArray(value) {
  const items = Array.isArray(value) ? value : [];
  return `[${items.map(tomlString).join(", ")}]`;
}

function chmodIfPossible(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Some filesystems do not support POSIX modes.
  }
}
