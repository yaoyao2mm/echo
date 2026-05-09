import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { loadDesktopAgentId } from "./lib/agentIdentity.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./lib/codexFileBrowser.js";
import { publicWorkspaces } from "./lib/codexRunner.js";
import {
  applyCodexSessionWorktree,
  discardCodexSessionWorktree,
  maybeCleanupCodexSessionWorktrees,
  prepareCodexSessionWorktree
} from "./lib/codexWorktree.js";
import { createManagedWorkspace, workspaceCreationRoot } from "./lib/codexWorkspaceManager.js";
import {
  createDesktopBackends,
  createDesktopRuntimeMap,
  desktopRuntimeSnapshot,
  refreshDesktopBackendCapabilities
} from "./lib/desktopBackendRegistry.js";
import { describeHttpNetwork, formatFetchError, httpFetch, isLikelyNetworkError } from "./lib/http.js";

if (!config.relayUrl) {
  console.error("Missing ECHO_RELAY_URL. Example: ECHO_RELAY_URL=https://voice.example.com ECHO_TOKEN=... pnpm run desktop");
  process.exit(1);
}

if (!config.token) {
  console.error("Missing ECHO_TOKEN. Use the same token as the relay server.");
  process.exit(1);
}

const agentId = await loadDesktopAgentId();
const desktopBackends = createDesktopBackends({ agentId });
let codexRuntimeRefreshPromise = null;
let codexRuntimeRefreshTimer = null;
let activeCodexCommandCount = 0;
const activeSessionCommands = new Map();
const runningSessionHeartbeats = new Map();
const runningSessionStates = new Map();
const pendingSessionEventRetries = new Map();
const sessionEventRetryOutboxPath = path.join(config.dataDir, "desktop-session-event-outbox.json");
let sessionEventRetryTimer = null;
let sessionEventOutboxSaveTimer = null;

console.log("Echo desktop agent is running.");
console.log(`Relay: ${config.relayUrl}`);
console.log(`Agent ID: ${agentId}`);
console.log(`Network: ${formatNetworkStatus(describeHttpNetwork(config.relayUrl))}`);
console.log(`Agent backends: ${desktopBackends.size > 0 ? "enabled" : "disabled"}`);
if (desktopBackends.size > 0) {
  for (const runtime of currentCodexRuntime().backends || []) {
    console.log(`  backend: ${runtime.backendName || runtime.provider || runtime.backendId || "backend"}`);
    console.log(`  command: ${runtime.command || "unavailable"}`);
    if (runtime.commandDetail) {
      console.log(`  app: ${runtime.commandDetail}`);
    }
    console.log(`  model: ${runtime.model || `${runtime.backendName || "backend"} default`}`);
    console.log("  supported models: syncing when idle");
    console.log(`  permissions: ${(runtime.allowedPermissionModes || []).join(", ") || "none"}`);
    console.log(`  reasoning: ${runtime.reasoningEffort || "default"}`);
    console.log(`  sandbox: ${runtime.sandbox}`);
    if (runtime.supportsAgentTeams) {
      console.log(`  agent teams: enabled${runtime.subagentModel ? ` (${runtime.subagentModel})` : ""}`);
    }
  }
  console.log(`  session concurrency: ${Math.max(1, Number(config.codex.sessionConcurrency || 1))}`);
  for (const workspace of publicWorkspaces()) {
    console.log(`  ${workspace.id}: ${workspace.path}`);
  }
  console.log(`  new workspace root: ${workspaceCreationRoot()}`);
  if (!(currentCodexRuntime().backends || []).some((runtime) => runtime.command)) {
    console.error("Agent backends cannot start because no enabled backend command is available.");
    process.exit(1);
  }
}
console.log("Waiting for mobile agent tasks.\n");

await loadSessionEventRetryOutbox();

if (desktopBackends.size > 0) {
  setInterval(() => {
    scheduleCodexRuntimeRefresh();
  }, 10 * 60 * 1000).unref?.();
  scheduleCodexRuntimeRefresh({ delayMs: 30000 });
  runCodexWorkspaceLoop();
  runCodexFileLoop();
  runCodexSessionLoops();
}

async function runCodexWorkspaceLoop() {
  const retryBackoff = createRetryBackoff();

  while (true) {
    let command = null;
    let handledLocally = false;
    try {
      command = await pollNextCodexWorkspaceCommand();
      retryBackoff.reset();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] workspace ${command.type}`);
      const result = await handleCodexWorkspaceCommand(command);
      handledLocally = true;
      await postJson("/api/agent/codex/workspaces/commands/complete", {
        id: command.id,
        agentId,
        result,
        workspaces: publicWorkspaces(),
        runtime: currentCodexRuntime()
      });
      console.log(`  workspace ${command.type} ${result.ok ? "completed" : "failed"}`);
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[workspace ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (command?.id && !handledLocally) {
        await postJson("/api/agent/codex/workspaces/commands/complete", {
          id: command.id,
          agentId,
          result: {
            ok: false,
            error: error.message
          },
          workspaces: publicWorkspaces(),
          runtime: currentCodexRuntime()
        }).catch(() => {});
      }
      await sleep(retryDelayMs);
    }
  }
}

async function runCodexFileLoop() {
  const retryBackoff = createRetryBackoff();

  while (true) {
    let request = null;
    let handledLocally = false;
    try {
      request = await pollNextCodexFileRequest();
      retryBackoff.reset();
      if (!request) continue;

      console.log(`[${new Date().toLocaleTimeString()}] files ${request.type} ${request.projectId}:${request.path || "/"}`);
      const result = await handleCodexFileRequest(request);
      handledLocally = true;
      await postJson("/api/agent/codex/files/requests/complete", {
        id: request.id,
        agentId,
        result,
        workspaces: publicWorkspaces(),
        runtime: currentCodexRuntime()
      });
      console.log(`  files ${request.type} ${result.ok ? "completed" : "failed"}`);
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[files ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (request?.id && !handledLocally) {
        await postJson("/api/agent/codex/files/requests/complete", {
          id: request.id,
          agentId,
          result: {
            ok: false,
            error: error.message
          },
          workspaces: publicWorkspaces(),
          runtime: currentCodexRuntime()
        }).catch(() => {});
      }
      await sleep(retryDelayMs);
    }
  }
}

function runCodexSessionLoops() {
  const runtimes = createDesktopRuntimeMap(desktopBackends, {
    onEvents: postCodexSessionEvents,
    requestApproval: requestCodexApproval,
    requestInteraction: requestCodexInteraction
  });
  const concurrency = Math.max(1, Number(config.codex.sessionConcurrency || 1));
  for (let index = 0; index < concurrency; index += 1) {
    runCodexSessionWorker(runtimes, index + 1).catch((error) => {
      console.error(`[session worker ${index + 1}] stopped unexpectedly: ${error.message}`);
    });
  }
}

async function runCodexSessionWorker(runtimes, workerId) {
  const retryBackoff = createRetryBackoff();

  while (true) {
    let command = null;
    let handledLocally = false;
    try {
      await maybeCleanupWorktrees();
      command = await pollNextCodexSessionCommand();
      retryBackoff.reset();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] session ${command.sessionId} ${command.type} worker=${workerId}`);
      activeCodexCommandCount += 1;
      rememberActiveSessionCommand(command);
      const heartbeat = startCodexSessionHeartbeat(command.sessionId);
      try {
        const result = await runCodexSessionCommand(runtimes, command);
        handledLocally = true;
        if (!result.projectId) result.projectId = command.projectId;
        const completed = await postSessionCommandCompletion(command, result);
        if (completed?.ok === false) {
          console.warn(`  session ${command.type} completion was no longer accepted by relay.`);
          continue;
        }
        updateRunningSessionHeartbeatFromResult(result.sessionId, result, command);
        console.log(`  session ${command.type} ${result.ok ? "accepted" : "failed"}`);
      } finally {
        clearInterval(heartbeat);
        forgetActiveSessionCommand(command.id);
        activeCodexCommandCount = Math.max(0, activeCodexCommandCount - 1);
      }
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[session ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (command?.sessionId) stopRunningSessionHeartbeat(command.sessionId);
      if (command?.id && !handledLocally) {
        await postJson("/api/agent/codex/sessions/commands/complete", {
          id: command.id,
          agentId,
          result: {
            ok: false,
            sessionId: command.sessionId,
            error: error.message
          }
        }).catch(() => {});
      }
      await sleep(retryDelayMs);
    }
  }
}

async function postSessionCommandCompletion(command, result) {
  const retryBackoff = createRetryBackoff();
  while (true) {
    try {
      return await postJson("/api/agent/codex/sessions/commands/complete", {
        id: command.id,
        agentId,
        result
      });
    } catch (error) {
      const delayMs = retryBackoff.nextDelay(error);
      console.error(
        `[session report ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, delayMs)}`
      );
      if (!isRetryableRelayError(error)) throw error;
      await sleep(delayMs);
    }
  }
}

async function runCodexSessionCommand(runtimes, command) {
  const preparedCommand = await prepareCodexSessionWorktree(command);
  if (preparedCommand.type === "worktree") return handleCodexWorktreeCommand(preparedCommand);
  const backendId = String(preparedCommand.runtime?.backendId || "codex").trim() || "codex";
  const runtime = runtimes.get(backendId) || runtimes.get("codex") || runtimes.values().next().value;
  if (!runtime) throw new Error(`No desktop runtime is available for backend ${backendId}.`);
  const result = await runtime.handleCommand(preparedCommand);
  if (preparedCommand.execution && !result.execution) result.execution = preparedCommand.execution;
  result.sessionId = preparedCommand.sessionId || command.sessionId;
  result.projectId = preparedCommand.projectId || command.projectId;
  return result;
}

async function handleCodexWorktreeCommand(command) {
  const action = String(command.payload?.action || "").trim().toLowerCase();
  const result = action === "discard" ? await discardCodexSessionWorktree(command) : await applyCodexSessionWorktree(command);
  if (result.events?.length) await postCodexSessionEvents(command.sessionId, result.events);
  return result;
}

async function postCodexSessionEvents(sessionId, events = []) {
  try {
    const posted = await postJson("/api/agent/codex/sessions/events", { id: sessionId, agentId, events });
    updateRunningSessionHeartbeatFromEvents(sessionId, events);
    return posted;
  } catch (error) {
    queueSessionEventRetry(sessionId, events, error);
    return null;
  }
}

function queueSessionEventRetry(sessionId, events = [], error = null) {
  const id = String(sessionId || "").trim();
  if (!id || !Array.isArray(events) || events.length === 0) return;
  const existing = pendingSessionEventRetries.get(id) || { events: [], attempts: 0 };
  existing.events.push(...events);
  existing.events = existing.events.slice(-200);
  pendingSessionEventRetries.set(id, existing);
  scheduleSessionEventOutboxSave();
  const retryDelayMs = Math.min(30000, 1500 * Math.max(1, existing.attempts + 1));
  console.error(
    `[session events ${new Date().toLocaleTimeString()}] ${formatFetchError(error || new Error("event post failed"))}; retrying in ${Math.round(retryDelayMs / 1000)}s`
  );
  scheduleSessionEventRetry(retryDelayMs);
}

function scheduleSessionEventRetry(delayMs = 1500) {
  if (sessionEventRetryTimer) return;
  sessionEventRetryTimer = setTimeout(() => {
    sessionEventRetryTimer = null;
    flushPendingSessionEventRetries().catch((error) => {
      console.error(`[session events retry] ${formatFetchError(error)}`);
      scheduleSessionEventRetry(5000);
    });
  }, Math.max(500, delayMs));
  sessionEventRetryTimer.unref?.();
}

async function flushPendingSessionEventRetries() {
  if (pendingSessionEventRetries.size === 0) return;
  for (const [sessionId, pending] of [...pendingSessionEventRetries.entries()]) {
    const events = pending.events.splice(0, 80);
    if (events.length === 0) {
      pendingSessionEventRetries.delete(sessionId);
      continue;
    }
    try {
      await postJson("/api/agent/codex/sessions/events", { id: sessionId, agentId, events });
      updateRunningSessionHeartbeatFromEvents(sessionId, events);
      if (pending.events.length === 0) pendingSessionEventRetries.delete(sessionId);
      else pendingSessionEventRetries.set(sessionId, { ...pending, attempts: 0 });
      scheduleSessionEventOutboxSave();
    } catch (error) {
      pending.events.unshift(...events);
      pending.attempts = Math.min(20, Number(pending.attempts || 0) + 1);
      pendingSessionEventRetries.set(sessionId, pending);
      scheduleSessionEventOutboxSave();
      const retryDelayMs = Math.min(30000, 1500 * pending.attempts);
      console.error(`[session events retry] ${formatFetchError(error)}; retrying in ${Math.round(retryDelayMs / 1000)}s`);
      scheduleSessionEventRetry(retryDelayMs);
      return;
    }
  }
  if (pendingSessionEventRetries.size > 0) scheduleSessionEventRetry(1000);
}

async function loadSessionEventRetryOutbox() {
  try {
    const text = await fs.readFile(sessionEventRetryOutboxPath, "utf8");
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
    for (const entry of entries) {
      const sessionId = String(entry?.sessionId || "").trim();
      const events = Array.isArray(entry?.events) ? entry.events : [];
      if (!sessionId || events.length === 0) continue;
      pendingSessionEventRetries.set(sessionId, {
        events: events.slice(-200),
        attempts: Math.max(0, Number(entry.attempts || 0) || 0)
      });
    }
    if (pendingSessionEventRetries.size > 0) {
      console.log(`[session events] loaded ${pendingSessionEventRetries.size} pending event outbox entr${pendingSessionEventRetries.size === 1 ? "y" : "ies"}`);
      scheduleSessionEventRetry(1000);
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`[session events outbox] ${error.message}`);
  }
}

function scheduleSessionEventOutboxSave() {
  if (sessionEventOutboxSaveTimer) return;
  sessionEventOutboxSaveTimer = setTimeout(() => {
    sessionEventOutboxSaveTimer = null;
    saveSessionEventRetryOutbox().catch((error) => {
      console.error(`[session events outbox] ${error.message}`);
    });
  }, 250);
  sessionEventOutboxSaveTimer.unref?.();
}

async function saveSessionEventRetryOutbox() {
  await fs.mkdir(path.dirname(sessionEventRetryOutboxPath), { recursive: true });
  if (pendingSessionEventRetries.size === 0) {
    await fs.rm(sessionEventRetryOutboxPath, { force: true }).catch(() => {});
    return;
  }

  const items = [...pendingSessionEventRetries.entries()].map(([sessionId, pending]) => ({
    sessionId,
    attempts: Number(pending.attempts || 0) || 0,
    events: (pending.events || []).slice(-200)
  }));
  const tempPath = `${sessionEventRetryOutboxPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify({ version: 1, items }, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, sessionEventRetryOutboxPath);
}

async function handleCodexWorkspaceCommand(command) {
  if (command.type !== "create") {
    return { ok: false, error: `Unsupported workspace command: ${command.type}` };
  }
  const workspace = createManagedWorkspace(command.payload || {});
  return { ok: true, workspace };
}

async function handleCodexFileRequest(request) {
  const payload = request.payload || {};
  try {
    if (request.type === "list") {
      return await listWorkspaceFiles({
        projectId: request.projectId,
        relativePath: payload.path ?? request.path,
        maxEntries: payload.maxEntries,
        workspaces: publicWorkspaces()
      });
    }
    if (request.type === "read") {
      return await readWorkspaceFile({
        projectId: request.projectId,
        relativePath: payload.path ?? request.path,
        maxBytes: payload.maxBytes,
        workspaces: publicWorkspaces()
      });
    }
    return { ok: false, error: `Unsupported file browser request: ${request.type}` };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || "" };
  }
}

async function requestCodexApproval(approval) {
  const created = await postJson("/api/agent/codex/sessions/approvals", {
    agentId,
    sessionId: approval.sessionId,
    appRequestId: approval.appRequestId,
    method: approval.method,
    prompt: approval.prompt,
    payload: approval.payload
  });

  const approvalId = created.approval?.id;
  if (!approvalId) throw new Error("Relay did not create an approval request.");

  const started = Date.now();
  const timeoutMs = config.codex.approvalTimeoutMs;
  while (Date.now() - started < timeoutMs) {
    const waited = await postJson(`/api/agent/codex/sessions/approvals/${encodeURIComponent(approvalId)}/wait?wait=25000`, {
      agentId,
      sessionId: approval.sessionId
    });
    if (waited.approval?.response) return waited.approval.response;
  }

  return approval.method === "execCommandApproval" || approval.method === "applyPatchApproval"
    ? { decision: "timed_out" }
    : { decision: "cancel" };
}

async function requestCodexInteraction(interaction) {
  const created = await postJson("/api/agent/codex/sessions/interactions", {
    agentId,
    sessionId: interaction.sessionId,
    appRequestId: interaction.appRequestId,
    method: interaction.method,
    kind: interaction.kind,
    prompt: interaction.prompt,
    payload: interaction.payload
  });

  const interactionId = created.interaction?.id;
  if (!interactionId) throw new Error("Relay did not create an interaction request.");

  const started = Date.now();
  const timeoutMs = config.codex.approvalTimeoutMs;
  while (Date.now() - started < timeoutMs) {
    const waited = await postJson(`/api/agent/codex/sessions/interactions/${encodeURIComponent(interactionId)}/wait?wait=25000`, {
      agentId,
      sessionId: interaction.sessionId
    });
    if (waited.interaction?.response) return waited.interaction.response;
  }

  return interaction.kind === "user_input" ? { answers: {} } : {};
}

async function pollNextCodexWorkspaceCommand() {
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/workspaces/next?wait=25000`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      agentId,
      workspaces: publicWorkspaces(),
      runtime: currentCodexRuntime()
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.command || null;
}

async function pollNextCodexFileRequest() {
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/files/next?wait=25000`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      agentId,
      workspaces: publicWorkspaces(),
      runtime: currentCodexRuntime()
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.request || null;
}

async function pollNextCodexSessionCommand() {
  const scheduling = codexSchedulingSnapshot();
  const waitMs = scheduling.busyProjectIds.length > 0 || scheduling.busySessionIds.length > 0 ? 5000 : 25000;
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/sessions/next?wait=${waitMs}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      agentId,
      workspaces: publicWorkspaces(),
      runtime: currentCodexRuntime(),
      ...scheduling
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.command || null;
}

async function maybeCleanupWorktrees() {
  const result = await maybeCleanupCodexSessionWorktrees().catch((error) => {
    console.error(`[worktree cleanup] ${error.message}`);
    return null;
  });
  if (!result?.removed) return;
  console.log(
    `[worktree cleanup] removed ${result.removed} old clean worktree${result.removed === 1 ? "" : "s"}`
  );
}

function startCodexSessionHeartbeat(sessionId) {
  const intervalMs = Math.max(15000, Math.min(Math.floor(config.codex.leaseMs / 2), 30000));
  const heartbeat = setInterval(() => {
    postJson("/api/agent/codex/sessions/events", { id: sessionId, agentId, events: [] }).catch(() => {});
  }, intervalMs);
  heartbeat.unref?.();
  return heartbeat;
}

function startRunningSessionHeartbeat(sessionId, details = {}) {
  if (!sessionId || runningSessionHeartbeats.has(sessionId)) return;
  runningSessionHeartbeats.set(sessionId, startCodexSessionHeartbeat(sessionId));
  rememberRunningSessionState(sessionId, details);
}

function stopRunningSessionHeartbeat(sessionId) {
  const heartbeat = runningSessionHeartbeats.get(sessionId);
  if (!heartbeat) {
    runningSessionStates.delete(sessionId);
    return;
  }
  clearInterval(heartbeat);
  runningSessionHeartbeats.delete(sessionId);
  runningSessionStates.delete(sessionId);
}

function updateRunningSessionHeartbeatFromResult(sessionId, result = {}, command = {}) {
  const status = String(result.sessionStatus || "").toLowerCase();
  if (result.ok === true && status === "running") {
    const state = sessionWorkStateFromCommand(command, result);
    startRunningSessionHeartbeat(sessionId, state);
    rememberRunningSessionState(sessionId, state);
    return;
  }
  if (status && status !== "running") stopRunningSessionHeartbeat(sessionId);
}

function updateRunningSessionHeartbeatFromEvents(sessionId, events = []) {
  for (const event of events || []) {
    const method = event?.raw?.method || event?.type || "";
    if (method === "turn/started" || event?.sessionStatus === "running") {
      startRunningSessionHeartbeat(sessionId);
    }
    if (
      method === "turn/completed" ||
      method === "thread/compacted" ||
      method === "turn/interrupt" ||
      event?.clearActiveTurnId ||
      (event?.sessionStatus && event.sessionStatus !== "running")
    ) {
      stopRunningSessionHeartbeat(sessionId);
    }
  }
}

function rememberActiveSessionCommand(command = {}) {
  const commandId = String(command.id || "").trim();
  if (!commandId) return;
  activeSessionCommands.set(commandId, sessionWorkStateFromCommand(command));
}

function forgetActiveSessionCommand(commandId) {
  const id = String(commandId || "").trim();
  if (id) activeSessionCommands.delete(id);
}

function rememberRunningSessionState(sessionId, details = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  const previous = runningSessionStates.get(id) || {};
  runningSessionStates.set(id, {
    ...previous,
    ...details,
    sessionId: id,
    isolated: Boolean(details.isolated ?? previous.isolated)
  });
}

function activeCodexSessionIds() {
  return Array.from(new Set([...activeSessionCommands.values()].map((item) => item.sessionId).filter(Boolean)));
}

function runningCodexSessionIds() {
  return [...runningSessionStates.keys()];
}

function busyCodexProjectIds() {
  const ids = new Set();
  for (const item of [...activeSessionCommands.values(), ...runningSessionStates.values()]) {
    if (item.projectId && !item.isolated) ids.add(item.projectId);
  }
  return [...ids];
}

function codexSchedulingSnapshot() {
  return {
    busySessionIds: activeCodexSessionIds(),
    busyProjectIds: busyCodexProjectIds(),
    runningSessionIds: runningCodexSessionIds()
  };
}

function sessionWorkStateFromCommand(command = {}, result = {}) {
  const execution = result.execution || command.execution || {};
  return {
    sessionId: String(result.sessionId || command.sessionId || "").trim(),
    projectId: String(result.projectId || command.projectId || execution.baseWorkspaceId || "").trim(),
    isolated: isIsolatedSessionExecution(command, result)
  };
}

function isIsolatedSessionExecution(command = {}, result = {}) {
  const execution = result.execution || command.execution || {};
  if (execution?.mode === "worktree" || execution?.path) return true;
  return command.type === "start" && String(command.runtime?.worktreeMode || "").trim() === "always";
}

async function postJson(path, body) {
  const response = await httpFetch(`${config.relayUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify(body),
    timeoutMs: 60000
  });
  return parseApiResponse(response);
}

async function parseApiResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function authHeaders() {
  return { "X-Echo-Token": config.token };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRetryBackoff(options = {}) {
  const baseMs = Number(options.baseMs || 2500) || 2500;
  const maxMs = Number(options.maxMs || 30000) || 30000;
  let nextMs = baseMs;

  return {
    reset() {
      nextMs = baseMs;
    },
    nextDelay(error) {
      if (!isLikelyNetworkError(error)) {
        nextMs = baseMs;
        return baseMs;
      }
      const delayMs = nextMs;
      nextMs = Math.min(maxMs, Math.round(nextMs * 1.8));
      return delayMs;
    }
  };
}

function retryNote(error, delayMs) {
  if (!isLikelyNetworkError(error)) return "";
  return `; retrying in ${Math.round(delayMs / 1000)}s`;
}

function isRetryableRelayError(error) {
  if (isLikelyNetworkError(error)) return true;
  return /\bHTTP (429|5\d\d)\b/i.test(String(error?.message || ""));
}

function currentCodexRuntime() {
  return desktopRuntimeSnapshot(desktopBackends);
}

async function refreshCodexRuntimeStatus() {
  if (codexRuntimeRefreshPromise) return codexRuntimeRefreshPromise;
  codexRuntimeRefreshPromise = refreshDesktopBackendCapabilities(desktopBackends, {
      activeCommandCount: activeCodexCommandCount,
      runningSessionCount: runningSessionHeartbeats.size
    })
    .finally(() => {
      codexRuntimeRefreshPromise = null;
    });

  return codexRuntimeRefreshPromise;
}

function scheduleCodexRuntimeRefresh(options = {}) {
  if (codexRuntimeRefreshTimer) return;
  const delayMs = Math.max(0, Number(options.delayMs || 0) || 0);
  codexRuntimeRefreshTimer = setTimeout(() => {
    codexRuntimeRefreshTimer = null;
    refreshCodexRuntimeStatus().catch((error) => {
      console.error(`[runtime refresh] ${error.message}`);
    });
  }, delayMs);
  codexRuntimeRefreshTimer.unref?.();
}

function formatNetworkStatus(status) {
  if (!status.activeProxyUrl) return `direct, timeout=${status.timeoutMs}ms`;
  const fallback = status.proxyFallbackDirect ? ", direct fallback=on" : "";
  return `proxy=${status.activeProxyUrl}${fallback}, timeout=${status.timeoutMs}ms`;
}
