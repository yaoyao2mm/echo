import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { getLanUrls } from "./lib/network.js";
import { loadHistory, recentHistory, allHistory, addHistory } from "./lib/history.js";
import { getRefineStatus, refineTranscript } from "./lib/refine.js";
import {
  bearerToken,
  createSessionToken,
  publicUser,
  validatePassword,
  verifySessionToken
} from "./lib/auth.js";
import {
  createAgentAccessGrant,
  createAgentToken,
  createPairingToken,
  findAuthUser,
  getUserSessionNotBeforeMs,
  listAgentAccessGrants,
  listAdminUsers,
  listAgentTokens,
  listAuthUsers,
  listPairingTokens,
  revokeAgentToken,
  revokePairingToken,
  revokeUserSessions,
  setAgentTokenDisabled,
  setPairingTokenDisabled,
  setStorageQuota,
  setUserDisabled,
  updateManagedUser,
  upsertManagedUser,
  verifyAgentToken,
  verifyPairingToken
} from "./lib/authStore.js";
import {
  appendCodexSessionEvents,
  archiveCodexSession,
  cancelCodexSession,
  codexStatus,
  compactCodexSession,
  completeCodexSessionCommand,
  completeCodexFileRequest,
  completeCodexWorkspaceCommand,
  createCodexAgentSkillCommand,
  createCodexDesktopPluginCommand,
  createCodexFileRequest,
  createCodexMcpApply,
  getCodexSessionArtifactContent,
  getCodexSessionAttachmentContent,
  createCodexSessionInteraction,
  createCodexSessionApproval,
  createCodexQuickSkill,
  createCodexSession,
  createCodexWorkspace,
  createCodexWorkspaceImportList,
  createCodexWorkspaceRegister,
  deleteCodexQuickSkill,
  deleteCodexOwnerData,
  deleteCodexSession,
  decideCodexSessionInteraction,
  decideCodexSessionApproval,
  enqueueCodexSessionMessage,
  getCodexSession,
  getCodexWorkspaceRuntimePreference,
  getCodexWorkspaceCommand,
  listCodexQuickSkills,
  listCodexSessionCommandReconciliations,
  listCodexSessions,
  queueCodexSessionWorktreeAction,
  requestCodexAgentRestart,
  armCodexAgentRestart,
  pendingCodexAgentRestart,
  reconcileCodexAgentRestarts,
  expireCodexAgentRestarts,
  reconcileCodexSessionCommands,
  subscribeCodexSession,
  codexOwnerStorageUsage,
  updateCodexAgentSnapshot,
  updateCodexQuickSkill,
  updateCodexWorkspaceVisibility,
  updateCodexWorkspaceRuntimePreference,
  waitForCodexSessionApproval,
  waitForCodexFileRequest,
  waitForCodexFileRequestResult,
  waitForCodexSessionInteraction,
  waitForCodexSessionCommand,
  waitForCodexWorkspaceCommand
} from "./lib/codexQueue.js";
import {
  addOrchestrationArtifact,
  assertOrchestrationAttemptAgent,
  bindOrchestrationAttemptSession,
  claimOrchestrationWork,
  completeOrchestrationAttempt,
  completeOrchestrationIntegration,
  reconcileOrchestrationBaseline,
  controlOrchestrationRun,
  createOrchestrationAttemptSession,
  createOrchestrationRun,
  getOrchestrationRun,
  listOrchestrationRuns,
  markOrchestrationItemReady,
  orchestrationAttemptSession,
  renewOrchestrationAttempt,
  recoverOrchestrationItem,
  retryOrchestrationItem,
  subscribeOrchestrationRun
} from "./lib/orchestrationService.js";

const app = express();
const sseTickets = new Map();
const sseInitialMaxEvents = 160;
const sseIncrementalMaxEvents = 80;
const loginAttempts = new Map();

await loadHistory();

app.use(express.json({ limit: "32mb" }));
app.use(express.static("public", {
  etag: false,
  lastModified: false,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
}));

app.use("/api/codex/sessions/:id/events", (req, res, next) => {
  if (req.method !== "GET") return next();
  const ticket = validateSseTicket(req.params.id, req.query.ticket);
  if (ticket) {
    req.sseTicketAuthenticated = true;
    req.sseTicketUser = ticket.user || null;
  }
  next();
});

app.use("/api/codex/orchestrations/:id/events", (req, res, next) => {
  if (req.method !== "GET") return next();
  const ticket = validateSseTicket(`orchestration:${req.params.id}`, req.query.ticket);
  if (ticket) {
    req.sseTicketAuthenticated = true;
    req.sseTicketUser = ticket.user || null;
  }
  next();
});

app.get("/api/auth/config", (req, res) => {
  res.json({ enabled: config.auth.enabled });
});

app.post("/api/auth/login", (req, res) => {
  if (isLoginRateLimited(req)) {
    return res.status(429).json({
      code: "LOGIN_RATE_LIMITED",
      error: "登录尝试过于频繁，请稍后再试。"
    });
  }

  if (!config.auth.enabled) {
    clearLoginAttempts(req);
    return res.json({
      user: { username: "local", displayName: "Local", role: "owner" },
      sessionToken: "",
      expiresAt: null
    });
  }

  const user = findAuthUser(req.body?.username, config.auth.users);
  if (!validatePassword(user, req.body?.password)) {
    recordLoginFailure(req);
    return res.status(401).json({
      code: "LOGIN_FAILED",
      error: "用户名或密码错误。"
    });
  }

  const sessionToken = createSessionToken({
    user,
    secret: config.auth.sessionSecret,
    ttlMs: config.auth.sessionTtlMs
  });
  clearLoginAttempts(req);
  res.json({
    user: publicUser(user),
    sessionToken,
    expiresAt: new Date(Date.now() + config.auth.sessionTtlMs).toISOString()
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!config.auth.enabled) {
    return res.json({ user: { username: "local", displayName: "Local", role: "owner" } });
  }

  const user = currentSessionUser(req);
  if (!user) {
    return res.status(401).json({
      code: "SESSION_REQUIRED",
      error: "需要登录。"
    });
  }
  res.json({ user });
});

app.use("/api", (req, res, next) => {
  if (req.sseTicketAuthenticated) {
    req.user = req.sseTicketUser || null;
    return next();
  }

  if (isAgentRequest(req)) {
    const agentAuth = currentAgentAuth(req);
    if (!agentAuth) {
      return res.status(401).json({
        code: "AGENT_AUTH_REQUIRED",
        error: "Desktop agent token is invalid or missing."
      });
    }
    req.agentAuth = agentAuth;
    return next();
  }

  if (config.auth.enabled) {
    const user = currentSessionUser(req);
    if (!user) {
      return res.status(401).json({
        code: "SESSION_REQUIRED",
        error: "需要登录。"
      });
    }
    req.user = user;
  } else {
    req.user = null;
  }

  if (isAdminRequest(req)) {
    if (!isOwner(req.user)) {
      return res.status(403).json({
        code: "OWNER_REQUIRED",
        error: "需要 owner 权限。"
      });
    }
    return next();
  }

  const provided = req.get("x-echo-token") || req.query.token || req.body?.token;
  if (String(provided || "").trim()) {
    const pairingUser = req.user || (!config.auth.enabled ? { username: "local", displayName: "Local", role: "owner" } : null);
    req.pairingAuth = verifyPairingToken({
      token: provided,
      user: pairingUser,
      configTokens: config.auth.pairingTokens
    });
  }

  if (!config.auth.enabled && !req.pairingAuth) {
    return res.status(401).json({
      code: "PAIRING_REQUIRED",
      error: "配对 token 无效或缺失。"
    });
  }
  next();
});

app.get("/api/admin/summary", (req, res) => {
  try {
    res.json(adminSummary());
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/admin/users", (req, res) => {
  try {
    res.json({ users: adminUsersWithUsage() });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/users", (req, res) => {
  try {
    const quotaBytes = quotaBytesFromBody(req.body);
    const user = upsertManagedUser({
      username: req.body.username,
      displayName: req.body.displayName,
      role: req.body.role,
      password: req.body.password,
      passwordSha256: req.body.passwordSha256,
      quotaBytes
    });
    res.json({ user: adminUserWithUsage(user) });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/users/:username", (req, res) => {
  try {
    const quotaBytes = quotaBytesFromBody(req.body);
    const existingUser = listAuthUsers(config.auth.users).find((item) => item.username === String(req.params.username || "").trim().toLowerCase());
    const user = updateManagedUser(req.params.username, {
      displayName: req.body.displayName,
      role: req.body.role,
      password: req.body.password,
      passwordSha256: req.body.passwordSha256,
      quotaBytes,
      allowPasswordlessShell: Boolean(existingUser)
    });
    res.json({ user: adminUserWithUsage(user) });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/users/:username/disable", (req, res) => {
  try {
    const disabled = req.body.disabled !== false;
    const user = setUserDisabled(req.params.username, disabled);
    res.json({ user: adminUserWithUsage(user) });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/users/:username/revoke-sessions", (req, res) => {
  try {
    const user = revokeUserSessions(req.params.username);
    res.json({ user: adminUserWithUsage(user) });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/users/:username/quota", (req, res) => {
  try {
    const quotaBytes = quotaBytesFromBody(req.body) ?? 0;
    const quota = setStorageQuota(req.params.username, quotaBytes);
    res.json({ quota, user: adminUserWithUsage(listAdminUsers(config.auth.users).find((item) => item.username === quota.ownerUser)) });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/users/:username/delete-data", (req, res) => {
  try {
    const result = deleteCodexOwnerData(req.params.username);
    res.json({ result, summary: adminSummary() });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/admin/tokens", (req, res) => {
  try {
    res.json(adminTokenSummary());
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/pairing-tokens", (req, res) => {
  try {
    const created = createPairingToken({
      ownerUsername: req.body.ownerUsername || req.body.ownerUser || req.body.username,
      label: req.body.label,
      createdBy: req.user?.username || ""
    });
    res.json(created);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/pairing-tokens/:id/disable", (req, res) => {
  try {
    const item = setPairingTokenDisabled(req.params.id, req.body.disabled !== false);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/pairing-tokens/:id/revoke", (req, res) => {
  try {
    const item = revokePairingToken(req.params.id);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/agent-approvals", (req, res) => {
  try {
    const username = req.body.username || req.body.granteeUsername || req.body.granteeUser;
    const agentId = req.body.agentId;
    const ownerUsername = req.body.ownerUsername || req.body.ownerUser || req.body.agentOwnerUsername;
    const createdBy = req.user?.username || "";
    const targetUser = findAuthUser(username, config.auth.users);
    if (!targetUser) {
      return res.status(400).json({ error: "User is not available." });
    }
    const grant = createAgentAccessGrant({
      username: targetUser.username,
      agentId,
      ownerUsername,
      createdBy
    });
    const pairing = createPairingToken({
      ownerUsername: grant.granteeUser,
      label: req.body.label || `${grant.granteeUser} ${req.body.agentDisplayName || agentId || "Echo"}`,
      createdBy
    });
    res.json({
      grant,
      token: pairing.token,
      pairing: pairing.item
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/agent-tokens", (req, res) => {
  try {
    const created = createAgentToken({
      ownerUsername: req.body.ownerUsername || req.body.ownerUser || req.body.username,
      agentId: req.body.agentId,
      displayName: req.body.displayName,
      label: req.body.label,
      createdBy: req.user?.username || ""
    });
    res.json(created);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/agent-tokens/:id/disable", (req, res) => {
  try {
    const item = setAgentTokenDisabled(req.params.id, req.body.disabled !== false);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/admin/agent-tokens/:id/revoke", (req, res) => {
  try {
    const item = revokeAgentToken(req.params.id);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    mode: config.mode,
    refine: getRefineStatus(),
    codex: config.mode === "relay" ? codexStatus({ user: codexWorkbenchUser(req) }) : null,
    user: req.user || null,
    platform: process.platform
  });
});

app.get("/api/history", (req, res) => {
  res.json({ items: allHistory(50) });
});

app.post("/api/refine", async (req, res) => {
  try {
    const rawText = req.body.rawText || "";
    const mode = req.body.mode || "chat";
    const contextHint = req.body.contextHint || "";
    const history = req.body.includeHistory === false ? [] : recentHistory(8);
    const refined = await refineTranscript({
      rawText,
      mode,
      contextHint,
      history
    });
    const item = await addHistory({ raw: rawText, refined, mode, contextHint, user: req.user || null });
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/agent/ping", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Agent ping is only available in relay mode." });
  }

  res.json({
    ok: true,
    mode: config.mode,
    refine: getRefineStatus(),
    codex: codexStatus({ user: agentAuthUser(req) })
  });
});

app.post("/api/agent/codex/heartbeat", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Agent heartbeat is only available in relay mode." });
    }

    const agent = updateCodexAgentSnapshot(agentRequest(req));
    const restarts = reconcileCodexAgentRestarts(agent);
    res.json({
      ok: true,
      agent: {
        id: agent.id,
        lastSeenAt: agent.lastSeenAt
      },
      codex: codexStatus({ user: agentAuthUser(req) }),
      restarts
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/refine", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Agent refine test is only available in relay mode." });
    }

    const rawText = String(req.body.rawText || "").trim();
    if (!rawText) {
      return res.status(400).json({ error: "rawText is required." });
    }

    const refined = await refineTranscript({
      rawText,
      mode: req.body.mode || "chat",
      contextHint: req.body.contextHint || "桌面端配置页测试实际 relay 后处理",
      history: req.body.includeHistory === false ? [] : recentHistory(8)
    });
    res.json({
      ok: true,
      status: getRefineStatus(),
      refined
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/status", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Echo agent control is only available in relay mode." });
  }

  res.json(codexStatus({ user: codexWorkbenchUser(req) }));
});

app.post("/api/codex/mcp/apply", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "MCP management is only available in relay mode." });
    }

    const command = createCodexMcpApply({
      profileId: req.body.profileId,
      targetClients: req.body.targetClients || req.body.targets,
      restartDesktopAgent: req.body.restartDesktopAgent,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/mcp/commands/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "MCP management is only available in relay mode." });
  }

  const command = getCodexWorkspaceCommand(req.params.id, { user: codexWorkbenchUser(req) });
  if (!command || command.type !== "mcp.apply") return res.status(404).json({ error: "MCP command not found." });
  res.json({ command });
});

app.post("/api/codex/agent-skills/refresh", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Agent Skill management is only available in relay mode." });
    }

    const command = createCodexAgentSkillCommand({
      type: "agent-skill.list",
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/agent-skills/update", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Agent Skill management is only available in relay mode." });
    }

    const command = createCodexAgentSkillCommand({
      type: "agent-skill.update",
      skillId: req.body.skillId,
      enabled: req.body.enabled,
      showInComposer: req.body.showInComposer,
      targetProviders: req.body.targetProviders,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/agent-skills/sync", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Agent Skill management is only available in relay mode." });
    }

    const command = createCodexAgentSkillCommand({
      type: "agent-skill.sync",
      skillId: req.body.skillId,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/agent-skills/import", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Agent Skill management is only available in relay mode." });
    }

    const command = createCodexAgentSkillCommand({
      type: "agent-skill.import",
      sourceUrl: req.body.sourceUrl || req.body.url,
      enabled: req.body.enabled,
      showInComposer: req.body.showInComposer,
      targetProviders: req.body.targetProviders,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/agent-skills/commands/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Agent Skill management is only available in relay mode." });
  }

  const command = getCodexWorkspaceCommand(req.params.id, { user: codexWorkbenchUser(req) });
  if (!command || !String(command.type || "").startsWith("agent-skill.")) {
    return res.status(404).json({ error: "Agent Skill command not found." });
  }
  res.json({ command });
});

app.post("/api/codex/plugins/refresh", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Desktop plugin management is only available in relay mode." });
    }
    const command = createCodexDesktopPluginCommand({
      type: "plugin.list",
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/plugins/update", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Desktop plugin management is only available in relay mode." });
    }
    const command = createCodexDesktopPluginCommand({
      type: "plugin.update",
      pluginId: req.body.pluginId,
      enabled: req.body.enabled,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/plugins/commands/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Desktop plugin management is only available in relay mode." });
  }
  const command = getCodexWorkspaceCommand(req.params.id, { user: codexWorkbenchUser(req) });
  if (!command || !String(command.type || "").startsWith("plugin.")) {
    return res.status(404).json({ error: "Desktop plugin command not found." });
  }
  res.json({ command });
});

app.get("/api/codex/quick-skills", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Quick skills are only available in relay mode." });
  }

  res.json({
    items: listCodexQuickSkills({
      projectId: req.query.projectId,
      targetAgentId: req.query.targetAgentId
    })
  });
});

app.post("/api/codex/quick-skills", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Quick skills are only available in relay mode." });
    }

    const skill = createCodexQuickSkill({
      scope: req.body.scope,
      projectId: req.body.projectId,
      targetAgentId: req.body.targetAgentId,
      title: req.body.title,
      description: req.body.description,
      prompt: req.body.prompt,
      mode: req.body.mode,
      requiresSession: req.body.requiresSession,
      sortOrder: req.body.sortOrder
    });
    res.json({ skill });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/quick-skills/:id", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Quick skills are only available in relay mode." });
    }

    const skill = updateCodexQuickSkill(req.params.id, {
      scope: req.body.scope,
      projectId: req.body.projectId,
      targetAgentId: req.body.targetAgentId,
      title: req.body.title,
      description: req.body.description,
      prompt: req.body.prompt,
      mode: req.body.mode,
      requiresSession: req.body.requiresSession,
      sortOrder: req.body.sortOrder
    });
    res.json({ skill });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/quick-skills/:id/delete", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Quick skills are only available in relay mode." });
    }

    const skill = deleteCodexQuickSkill(req.params.id);
    res.json({ skill });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/workspaces", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Workspace management is only available in relay mode." });
    }

    const command = createCodexWorkspace({
      name: req.body.name || req.body.label,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/workspaces/visibility", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Workspace management is only available in relay mode." });
    }

    const visibility = updateCodexWorkspaceVisibility({
      workspaceId: req.body.workspaceId || req.body.projectId,
      targetAgentId: req.body.targetAgentId,
      visible: req.body.visible !== false,
      ownerUser: req.user?.username || "",
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      user: codexWorkbenchUser(req)
    });
    res.json({ visibility, status: codexStatus({ user: codexWorkbenchUser(req) }) });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/workspaces/import/list", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Workspace management is only available in relay mode." });
    }

    const command = createCodexWorkspaceImportList({
      rootId: req.body.rootId,
      path: req.body.path || req.body.relativePath,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/workspaces/import/register", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Workspace management is only available in relay mode." });
    }

    const command = createCodexWorkspaceRegister({
      rootId: req.body.rootId,
      path: req.body.path || req.body.relativePath,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/workspaces/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Workspace management is only available in relay mode." });
  }

  const command = getCodexWorkspaceCommand(req.params.id, { user: codexWorkbenchUser(req) });
  if (!command) return res.status(404).json({ error: "Workspace command not found." });
  res.json({ command });
});

app.post("/api/codex/files/list", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "File browsing is only available in relay mode." });
    }

    const request = createCodexFileRequest({
      type: "list",
      projectId: req.body.projectId,
      targetAgentId: req.body.targetAgentId,
      path: req.body.path,
      maxEntries: req.body.maxEntries,
      sessionContext: fileRequestSessionContext(req),
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      user: codexWorkbenchUser(req)
    });
    const completed = await waitForCodexFileRequestResult(request.id, {
      waitMs: Number(req.query.wait || req.body.wait || 30000)
    });
    sendFileRequestResult(res, completed || request, "tree");
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/files/read", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "File browsing is only available in relay mode." });
    }

    const request = createCodexFileRequest({
      type: "read",
      projectId: req.body.projectId,
      targetAgentId: req.body.targetAgentId,
      path: req.body.path,
      maxBytes: req.body.maxBytes,
      sessionContext: fileRequestSessionContext(req),
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      user: codexWorkbenchUser(req)
    });
    const completed = await waitForCodexFileRequestResult(request.id, {
      waitMs: Number(req.query.wait || req.body.wait || 30000)
    });
    sendFileRequestResult(res, completed || request, "file");
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/open-spec/summary", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Open Spec summaries are only available in relay mode." });
    }

    const request = createCodexFileRequest({
      type: "open-spec-summary",
      projectId: req.body.projectId,
      targetAgentId: req.body.targetAgentId,
      maxChanges: req.body.maxChanges,
      maxSpecs: req.body.maxSpecs,
      requestedBy: req.user?.username || req.user?.displayName || "mobile",
      ownerUser: req.user?.username || "",
      user: codexWorkbenchUser(req)
    });
    const completed = await waitForCodexFileRequestResult(request.id, {
      waitMs: Number(req.query.wait || req.body.wait || 30000)
    });
    sendFileRequestResult(res, completed || request, "openSpec", { label: "Open Spec summary" });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/orchestrations", async (req, res) => {
  try {
    if (config.mode !== "relay") return res.status(400).json({ error: "Orchestration is only available in relay mode." });
    const ownerUser = req.user?.username || "local";
    const request = createCodexFileRequest({
      type: "orchestration-plan",
      projectId: req.body.projectId,
      targetAgentId: req.body.targetAgentId,
      items: req.body.items,
      requestedBy: ownerUser,
      ownerUser,
      user: codexWorkbenchUser(req)
    });
    const completed = await waitForCodexFileRequestResult(request.id, { waitMs: Number(req.query.wait || req.body.wait || 30000) });
    if (!completed || completed.status !== "done" || !completed.result?.plan) {
      const error = new Error(completed?.error || completed?.result?.error || "Desktop did not return a valid orchestration plan.");
      error.statusCode = completed?.status === "expired" ? 504 : 409;
      throw error;
    }
    const plan = completed.result.plan;
    const run = createOrchestrationRun({
      ownerUser,
      targetAgentId: completed.targetAgentId,
      projectId: plan.projectId,
      title: req.body.title,
      baseBranch: plan.baseBranch,
      baseCommit: plan.baseCommit,
      runtimePolicy: req.body.runtimePolicy,
      items: plan.items
    });
    res.status(201).json({ run });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/orchestrations/next", (req, res) => {
  try {
    const agent = agentRequest(req);
    updateCodexAgentSnapshot(agent);
    const plugins = Array.isArray(agent.runtime?.plugins?.plugins) ? agent.runtime.plugins.plugins : [];
    if (!plugins.some((plugin) => plugin.id === "orchestration" && plugin.enabled === true)) return res.json({ work: null, leaseOwner: "" });
    const leaseOwner = `${agent.id}:${String(req.body.workerId || "orchestration").slice(0, 80)}`;
    const work = claimOrchestrationWork({ targetAgentId: agent.id, leaseOwner, leaseMs: 120000 });
    res.json({ work, leaseOwner: work?.attempt?.leaseOwner || "" });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/orchestrations/:attemptId/session", (req, res) => {
  try {
    const agent = agentRequest(req);
    const session = createOrchestrationAttemptSession(req.params.attemptId, {
      agentId: agent.id,
      leaseOwner: req.body.leaseOwner,
      execution: req.body.execution
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/orchestrations/:attemptId/heartbeat", (req, res) => {
  try {
    const attempt = renewOrchestrationAttempt(req.params.attemptId, { agentId: agentRequest(req).id, leaseOwner: req.body.leaseOwner, leaseMs: 120000 });
    if (!attempt) return res.status(409).json({ error: "Orchestration Attempt lease is no longer active." });
    res.json({ attempt });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/agent/codex/orchestrations/:attemptId/session", (req, res) => {
  const session = orchestrationAttemptSession(req.params.attemptId, { agentId: agentRequest(req).id, leaseOwner: req.query.leaseOwner });
  if (!session) return res.status(404).json({ error: "Orchestration Attempt Session not found." });
  res.json({ session });
});

app.post("/api/agent/codex/orchestrations/:attemptId/reconcile", (req, res) => {
  try {
    const input = req.body || {};
    const run = reconcileOrchestrationBaseline(req.params.attemptId, {
      ...input,
      agentId: agentRequest(req).id
    });
    res.json({ run });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/orchestrations/:attemptId/complete", (req, res) => {
  try {
    const input = req.body || {};
    const agentId = agentRequest(req).id;
    const ownership = assertOrchestrationAttemptAgent(req.params.attemptId, { agentId, leaseOwner: input.leaseOwner });
    if (input.integration) {
      addOrchestrationArtifact({
        runId: ownership.run.id,
        attemptId: req.params.attemptId,
        kind: "validation",
        status: input.ok === true ? "passed" : "failed",
        summary: input.validationSummary || input.errorSummary || "Integration validation result."
      });
      if (input.ok === true) addOrchestrationArtifact({
        runId: ownership.run.id,
        attemptId: req.params.attemptId,
        kind: "integration-result",
        status: "info",
        summary: `Integrated branch ${String(input.branch || "").slice(0, 240)}`,
        data: { branch: input.branch, commit: input.commit }
      });
      const run = completeOrchestrationIntegration(req.params.attemptId, { ...input, agentId });
      return res.json({ run });
    }
    const attempt = completeOrchestrationAttempt(req.params.attemptId, { ...input, agentId });
    for (const artifact of Array.isArray(input.artifacts) ? input.artifacts : []) {
      addOrchestrationArtifact({
        ...artifact,
        runId: ownership.run.id,
        itemId: ownership.attempt.itemId,
        attemptId: req.params.attemptId
      });
    }
    let item = null;
    if (attempt.status === "succeeded") {
      item = markOrchestrationItemReady(attempt.itemId, {
        commit: input.commit,
        verifierConclusion: input.verifierConclusion
      });
    }
    res.json({ attempt, item });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/orchestrations", (req, res) => {
  try {
    if (config.mode !== "relay") return res.status(400).json({ error: "Orchestration is only available in relay mode." });
    res.json({
      items: listOrchestrationRuns({
        ownerUser: req.user?.username || "local",
        targetAgentId: req.query.targetAgentId,
        projectId: req.query.projectId,
        activeOnly: req.query.active === "true",
        limit: req.query.limit
      })
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/orchestrations/:id", (req, res) => {
  const run = getOrchestrationRun(req.params.id, { ownerUser: req.user?.username || "local" });
  if (!run) return res.status(404).json({ error: "Orchestration Run not found." });
  res.json({ run });
});

app.post("/api/codex/orchestrations/:id/:action(pause|resume|cancel|finish)", (req, res) => {
  try {
    const run = controlOrchestrationRun(req.params.id, req.params.action, { ownerUser: req.user?.username || "local" });
    res.json({ run });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/orchestrations/:id/items/:itemId/retry", (req, res) => {
  try {
    const run = retryOrchestrationItem(req.params.id, req.params.itemId, { ownerUser: req.user?.username || "local" });
    res.json({ run });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/orchestrations/:id/items/:itemId/recover", (req, res) => {
  try {
    const run = recoverOrchestrationItem(req.params.id, req.params.itemId, { ownerUser: req.user?.username || "local" });
    res.json({ run });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/orchestrations/:id/events-ticket", (req, res) => {
  const run = getOrchestrationRun(req.params.id, { ownerUser: req.user?.username || "local" });
  if (!run) return res.status(404).json({ error: "Orchestration Run not found." });
  const ticket = createSseTicket(`orchestration:${req.params.id}`, codexWorkbenchUser(req));
  res.json({ ticket: ticket.id, expiresAt: ticket.expiresAt });
});

app.get("/api/codex/orchestrations/:id/events", (req, res) => {
  if (!req.sseTicketAuthenticated) return res.status(401).json({ code: "SSE_TICKET_REQUIRED", error: "Run event stream ticket is invalid or expired." });
  const ownerUser = req.user?.username || "local";
  const run = getOrchestrationRun(req.params.id, { ownerUser });
  if (!run) return res.status(404).json({ error: "Orchestration Run not found." });
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  writeSse(res, "run", { run });
  const unsubscribe = subscribeOrchestrationRun(req.params.id, () => {
    const next = getOrchestrationRun(req.params.id, { ownerUser });
    if (next) writeSse(res, "run", { run: next });
  });
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  heartbeat.unref?.();
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  req.on("aborted", cleanup);
});

app.get("/api/codex/sessions", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
  }

  res.json({
    items: listCodexSessions(30, {
      archived: req.query.archived === "true",
      projectId: req.query.projectId,
      targetAgentId: req.query.targetAgentId,
      user: codexWorkbenchUser(req)
    })
  });
});

app.get("/api/codex/runtime-preference", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Runtime preferences are only available in relay mode." });
    }
    const preference = getCodexWorkspaceRuntimePreference({
      ownerUser: req.user?.username || "local",
      targetAgentId: req.query.targetAgentId,
      workspaceId: req.query.workspaceId,
      user: codexWorkbenchUser(req)
    });
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({ preference });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/runtime-preference", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Runtime preferences are only available in relay mode." });
    }
    const result = updateCodexWorkspaceRuntimePreference({
      ownerUser: req.user?.username || "local",
      targetAgentId: req.body.targetAgentId,
      workspaceId: req.body.workspaceId,
      preference: req.body.preference,
      migrationCandidate: req.body.migrationCandidate,
      migration: req.body.migration === true,
      version: req.body.version,
      user: codexWorkbenchUser(req)
    });
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json(result);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
    }

    const session = createCodexSession({
      projectId: req.body.projectId,
      prompt: req.body.prompt,
      attachments: req.body.attachments,
      runtime: req.body.runtime || {},
      mode: req.body.mode,
      sourceSessionId: req.body.sourceSessionId,
      threadMode: req.body.threadMode,
      ownerUser: req.user?.username || "",
      targetAgentId: req.body.targetAgentId,
      user: codexWorkbenchUser(req)
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/codex/sessions/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
  }

  const session = getCodexSession(req.params.id, { ...streamSessionOptions({ initial: true }), user: codexWorkbenchUser(req) });
  if (!session) return res.status(404).json({ error: "Session not found." });
  res.json({ session });
});

app.post("/api/codex/sessions/:id/events-ticket", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Session events are only available in relay mode." });
  }

  const session = getCodexSession(req.params.id, {
    includeMessages: false,
    includeApprovals: false,
    includeRaw: false,
    maxEvents: 1,
    user: codexWorkbenchUser(req)
  });
  if (!session) return res.status(404).json({ error: "Session not found." });

  const ticket = createSseTicket(req.params.id, codexWorkbenchUser(req));
  res.json({
    ticket: ticket.id,
    expiresAt: ticket.expiresAt
  });
});

app.get("/api/codex/sessions/:id/events", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Session events are only available in relay mode." });
  }
  if (!req.sseTicketAuthenticated) {
    return res.status(401).json({
      code: "SSE_TICKET_REQUIRED",
      error: "Session event stream ticket is invalid or expired."
    });
  }

  const afterEventId = sseLastEventId(req);
  const session = getCodexSession(req.params.id, {
    ...streamSessionOptions({ initial: afterEventId === 0, afterEventId }),
    user: codexWorkbenchUser(req)
  });
  if (!session) return res.status(404).json({ error: "Session not found." });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");
  let lastEventId =
    afterEventId > 0
      ? writeSseSessionCatchup(res, req.params.id, afterEventId, { firstSession: session, recovered: true })
      : writeSseSessionPage(res, session, { partial: false }, afterEventId);

  const unsubscribe = subscribeCodexSession(req.params.id, () => {
    lastEventId = writeSseSessionCatchup(res, req.params.id, lastEventId, { user: codexWorkbenchUser(req) });
  });
  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 25000);
  heartbeat.unref?.();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  req.on("aborted", cleanup);
});

app.get("/api/codex/attachments/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Session attachments are only available in relay mode." });
  }

  sendCodexAttachment(req, res);
});

app.get("/api/codex/artifacts/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Session artifacts are only available in relay mode." });
  }

  sendCodexArtifact(req, res);
});

app.get("/api/agent/codex/attachments/:id", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Session attachments are only available in relay mode." });
  }

  sendCodexAttachment(req, res);
});

app.post("/api/codex/sessions/:id/messages", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
    }

    const session = enqueueCodexSessionMessage(req.params.id, {
      text: req.body.text || req.body.prompt,
      attachments: req.body.attachments,
      runtime: req.body.runtime || {},
      mode: req.body.mode,
      projectId: req.body.projectId,
      user: codexWorkbenchUser(req)
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/compact", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
    }

    const session = compactCodexSession(req.params.id, {
      automatic: req.body.automatic,
      reason: req.body.reason,
      user: codexWorkbenchUser(req)
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/cancel", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
    }

    const session = cancelCodexSession(req.params.id, {
      reason: req.body.reason,
      user: codexWorkbenchUser(req)
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/worktree/:action", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
    }

    const session = queueCodexSessionWorktreeAction(req.params.id, {
      action: req.params.action || req.body.action,
      user: codexWorkbenchUser(req)
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/archive", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
    }

    const session = archiveCodexSession(req.params.id, {
      archived: req.body.archived !== false,
      user: codexWorkbenchUser(req)
    });
    res.json({ session });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/delete", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive sessions are only available in relay mode." });
    }

    const result = deleteCodexSession(req.params.id, {
      user: codexWorkbenchUser(req)
    });
    res.json({ result });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/approvals/:approvalId", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive approvals are only available in relay mode." });
    }

    const approval = decideCodexSessionApproval(
      req.params.approvalId,
      {
        sessionId: req.params.id,
        decision: req.body.decision
      },
      {
        user: codexWorkbenchUser(req)
      }
    );
    if (!approval) return res.status(404).json({ error: "Approval not found." });
    res.json({ approval });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/codex/sessions/:id/interactions/:interactionId", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Interactive requests are only available in relay mode." });
    }

    const interaction = decideCodexSessionInteraction(
      req.params.interactionId,
      {
        sessionId: req.params.id,
        decision: req.body.decision,
        answers: req.body.answers,
        response: req.body.response
      },
      {
        user: codexWorkbenchUser(req)
      }
    );
    if (!interaction) return res.status(404).json({ error: "Interaction not found." });
    res.json({ interaction });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/next", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Session agent polling is only available in relay mode." });
    }

    const body = req.body || {};
    const agent = agentRequest(req);
    let reconciliation = listCodexSessionCommandReconciliations({ agent });
    const command = reconciliation.length > 0
      ? null
      : await waitForCodexSessionCommand({
          waitMs: Number(req.query.wait || body.wait || 25000),
          agent,
          busySessionIds: body.busySessionIds,
          busyProjectIds: body.busyProjectIds,
          runningSessionIds: body.runningSessionIds,
          sessionActivitySnapshotAt: body.sessionActivitySnapshotAt,
          commandTypes: body.commandTypes || body.types
        });
    reconciliation = listCodexSessionCommandReconciliations({ agent });
    res.json({ command, reconciliation });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/workspaces/next", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Workspace agent polling is only available in relay mode." });
    }

    const command = await waitForCodexWorkspaceCommand({
      waitMs: Number(req.query.wait || req.body.wait || 25000),
      agent: agentRequest(req)
    });
    res.json({ command });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/files/next", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "File browser agent polling is only available in relay mode." });
    }

    const request = await waitForCodexFileRequest({
      waitMs: Number(req.query.wait || req.body.wait || 25000),
      agent: agentRequest(req)
    });
    res.json({ request });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/files/requests/complete", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "File browser agent completion is only available in relay mode." });
  }

  const ok = completeCodexFileRequest(req.body.id, req.body.result || {}, {
    agent: agentRequest(req)
  });
  res.json({ ok });
});

app.post("/api/agent/codex/workspaces/commands/complete", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Workspace agent completion is only available in relay mode." });
  }

  const ok = completeCodexWorkspaceCommand(req.body.id, req.body.result || {}, {
    agent: agentRequest(req)
  });
  res.json({ ok });
});

app.post("/api/agent/codex/sessions/events", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Session agent events are only available in relay mode." });
  }

  const ok = appendCodexSessionEvents(req.body.id, req.body.events || [], {
    agent: agentRequest(req),
    commandId: req.body.commandId,
    attempt: req.body.attempt
  });
  res.json({ ok });
});

app.post("/api/agent/codex/sessions/commands/complete", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Session agent completion is only available in relay mode." });
  }

  const agent = agentRequest(req);
  const result = req.body.result || {};
  const ok = completeCodexSessionCommand(req.body.id, result, {
    agent,
    attempt: req.body.attempt
  });
  const restart = ok && result.ok === true
    ? (req.body.restartArmMode === "desktop-exit" ? pendingCodexAgentRestart : armCodexAgentRestart)({
        sessionId: result.sessionId,
        agentId: agent.id,
        agentInstanceId: agent.agentInstanceId
      })
    : null;
  res.json({ ok, restart: restart ? { ...restart, shouldExit: true } : null });
});

app.post("/api/agent/codex/restarts/:id/arm", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Desktop restart operations are only available in relay mode." });
    }
    const agent = agentRequest(req);
    const restart = armCodexAgentRestart({
      operationId: req.params.id,
      sessionId: req.body.sessionId,
      agentId: agent.id,
      agentInstanceId: agent.agentInstanceId
    });
    if (!restart) return res.status(409).json({ error: "Desktop restart checkpoint is no longer pending." });
    res.json({ ok: true, restart: { ...restart, shouldExit: true } });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/restarts", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Desktop restart operations are only available in relay mode." });
    }
    const agent = agentRequest(req);
    const restart = requestCodexAgentRestart({
      sessionId: req.body.sessionId,
      agentId: agent.id,
      agentInstanceId: agent.agentInstanceId,
      expectedRevision: req.body.expectedRevision,
      resumeSummary: req.body.resumeSummary
    });
    res.json({ ok: true, restart });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/reconcile", (req, res) => {
  if (config.mode !== "relay") {
    return res.status(400).json({ error: "Session reconciliation is only available in relay mode." });
  }

  const outcomes = reconcileCodexSessionCommands({
    agent: agentRequest(req),
    states: req.body.states
  });
  res.json({ outcomes });
});

app.post("/api/agent/codex/sessions/approvals", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Session approvals are only available in relay mode." });
    }

    const approval = createCodexSessionApproval(
      {
        sessionId: req.body.sessionId,
        appRequestId: req.body.appRequestId,
        method: req.body.method,
        prompt: req.body.prompt,
        payload: req.body.payload
      },
      {
        agent: agentRequest(req)
      }
    );
    res.json({ approval });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/approvals/:id/wait", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Session approval waiting is only available in relay mode." });
    }

    const approval = await waitForCodexSessionApproval(req.params.id, {
      waitMs: Number(req.query.wait || req.body.wait || 25000),
      agent: agentRequest(req),
      sessionId: req.body.sessionId
    });
    res.json({ approval });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/interactions", (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Session interactions are only available in relay mode." });
    }

    const interaction = createCodexSessionInteraction(
      {
        sessionId: req.body.sessionId,
        appRequestId: req.body.appRequestId,
        method: req.body.method,
        kind: req.body.kind,
        prompt: req.body.prompt,
        payload: req.body.payload
      },
      {
        agent: agentRequest(req)
      }
    );
    res.json({ interaction });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/agent/codex/sessions/interactions/:id/wait", async (req, res) => {
  try {
    if (config.mode !== "relay") {
      return res.status(400).json({ error: "Session interaction waiting is only available in relay mode." });
    }

    const interaction = await waitForCodexSessionInteraction(req.params.id, {
      waitMs: Number(req.query.wait || req.body.wait || 25000),
      agent: agentRequest(req),
      sessionId: req.body.sessionId
    });
    res.json({ interaction });
  } catch (error) {
    handleError(res, error);
  }
});

const useHttps = Boolean(config.httpsCert && config.httpsKey);
const server = useHttps
  ? https.createServer(
      {
        cert: fs.readFileSync(config.httpsCert),
        key: fs.readFileSync(config.httpsKey)
      },
      app
    )
  : http.createServer(app);

const agentRestartExpirationSweep = config.mode === "relay"
  ? setInterval(() => {
      try {
        expireCodexAgentRestarts();
      } catch (error) {
        console.error(`Failed to expire desktop agent restart operations: ${error.message}`);
      }
    }, 15000)
  : null;
agentRestartExpirationSweep?.unref?.();

server.listen(config.port, config.host, () => {
  const protocol = useHttps ? "https" : "http";
  const publicUrl = config.publicUrl || "";
  const publicPairingUrl = publicUrl ? `${publicUrl}/?token=${encodeURIComponent(config.token)}` : "";
  const urls =
    config.mode === "relay"
      ? [publicUrl || `${protocol}://YOUR_DOMAIN`]
      : [...(publicPairingUrl ? [publicPairingUrl] : []), ...getLanUrls(config.port, config.token, protocol)];
  const androidUsbUrl = `http://localhost:${config.port}/?token=${encodeURIComponent(config.token)}`;
  console.log(`\nEcho ${config.mode === "relay" ? "relay server" : "desktop agent"} is running.\n`);
  console.log("Open one of these URLs on your phone:\n");
  for (const url of urls) console.log(`  ${url}`);
  if (!useHttps && config.mode !== "relay") {
    console.log("\nAndroid QR camera pairing needs HTTPS or localhost.");
    console.log("For USB development, run `pnpm run android:usb`, then open:");
    console.log(`  ${androidUsbUrl}`);
  }
  if (config.mode === "relay") {
    if (!config.publicUrl) {
      console.log("\nSet ECHO_PUBLIC_URL=https://YOUR_DOMAIN so the relay prints the correct phone URL.");
    }
    console.log("\nRun this on the computer that should run local backends:");
    console.log(`  ECHO_RELAY_URL=${config.publicUrl || `${protocol}://YOUR_DOMAIN`} ECHO_AGENT_TOKEN=<agent-token> pnpm run desktop`);
  }
  if (config.mode !== "relay") {
    const qrUrl = publicPairingUrl || (useHttps ? urls[0] : androidUsbUrl);
    const qrLabel = publicPairingUrl ? "the public URL" : useHttps ? "the first LAN URL" : "Android USB localhost";
    console.log(`\nPairing QR for ${qrLabel}:\n`);
    qrcode.generate(qrUrl, { small: true });
  } else {
    console.log("\nRelay mode does not print pairing tokens. Use the desktop settings QR or your saved ECHO_TOKEN.");
  }
  console.log("\nKeep this terminal running while using the phone UI.\n");
});

function sendFileRequestResult(res, request, resultKey, options = {}) {
  const label = String(options.label || "File browser request").trim();
  if (!request) {
    return res.status(504).json({ error: `${label} timed out.` });
  }
  if (request.status === "queued" || request.status === "leased") {
    return res.status(504).json({ error: `${label} timed out.`, request });
  }
  if (request.status === "expired") {
    return res.status(504).json({ error: request.error || `${label} expired.`, request });
  }
  if (request.status === "failed" || request.result?.ok === false) {
    return res.status(422).json({ error: request.error || request.result?.error || `${label} failed.`, request });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({
    request,
    [resultKey]: request.result?.[resultKey] || null
  });
}

function fileRequestSessionContext(req) {
  const sessionId = String(req.body.sessionId || "").trim();
  if (!sessionId) return null;
  const session = getCodexSession(sessionId, { user: codexWorkbenchUser(req) });
  if (!session) {
    const error = new Error("Codex session not found.");
    error.statusCode = 404;
    throw error;
  }
  if (String(session.projectId || "") !== String(req.body.projectId || "")) {
    const error = new Error("File reference does not belong to this workspace.");
    error.statusCode = 403;
    throw error;
  }
  if (req.body.targetAgentId && session.targetAgentId && req.body.targetAgentId !== session.targetAgentId) {
    const error = new Error("File reference does not belong to this desktop agent.");
    error.statusCode = 403;
    throw error;
  }
  const execution = session.execution || {};
  const requestedTarget = req.body.executionTarget === "session-worktree" ? "session-worktree" : "workspace";
  if (requestedTarget === "session-worktree" && execution.mode !== "worktree") {
    const error = new Error("This session does not own a worktree execution target.");
    error.statusCode = 422;
    throw error;
  }
  return {
    sessionId: session.id,
    executionTarget: requestedTarget,
    baseWorkspaceId: String(execution.baseWorkspaceId || session.projectId || ""),
    desktopAgentId: String(execution.desktopAgentId || session.targetAgentId || ""),
    lifecycleState: String(execution.lifecycleState || execution.cleanupState || "")
  };
}

function handleError(res, error) {
  const status = error.statusCode || 500;
  res.status(status).json({
    error: error.message || "Unexpected error",
    ...(error.code ? { code: error.code } : {}),
    ...(error.preference !== undefined ? { preference: error.preference } : {})
  });
}

function writeSse(res, event, data, options = {}) {
  if (options.id) res.write(`id: ${String(options.id)}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseSessionPage(res, session, data = {}, fallbackEventId = 0) {
  const lastEventId = maxSessionEventId(session.events || [], fallbackEventId);
  writeSse(
    res,
    "session",
    {
      session,
      partial: data.partial !== false,
      recovered: Boolean(data.recovered),
      lastEventId
    },
    { id: lastEventId }
  );
  return lastEventId;
}

function writeSseSessionCatchup(res, sessionId, afterEventId, options = {}) {
  let cursor = Math.max(0, Number(afterEventId || 0) || 0);
  let session = options.firstSession || getCodexSession(sessionId, {
    ...streamSessionOptions({ initial: false, afterEventId: cursor }),
    user: options.user || null
  });
  let wrote = false;

  while (session && !res.writableEnded) {
    const events = Array.isArray(session.events) ? session.events : [];
    const nextEventId = maxSessionEventId(events, cursor);
    cursor = writeSseSessionPage(
      res,
      session,
      {
        partial: true,
        recovered: Boolean(options.recovered && !wrote)
      },
      cursor
    );
    wrote = true;

    if (events.length < sseIncrementalMaxEvents || nextEventId <= afterEventId) break;
    session = getCodexSession(sessionId, {
      ...streamSessionOptions({ initial: false, afterEventId: cursor }),
      user: options.user || null
    });
  }

  return cursor;
}

function streamSessionOptions({ initial = false, afterEventId = 0 } = {}) {
  return {
    rawMode: "client",
    afterEventId,
    maxEvents: initial ? sseInitialMaxEvents : sseIncrementalMaxEvents,
    includeMessages: initial && afterEventId === 0,
    includeApprovals: true,
    includeInteractions: true,
    includeArtifacts: true
  };
}

function sseLastEventId(req) {
  const value = req.get("last-event-id") || req.query.after || req.query.lastEventId || "";
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function maxSessionEventId(events = [], fallback = 0) {
  let max = Number(fallback || 0) || 0;
  for (const event of events || []) {
    const id = Number(event?.id || 0);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

function createSseTicket(sessionId, user = null) {
  pruneSseTickets();
  const id = crypto.randomBytes(24).toString("base64url");
  const expiresAtMs = Date.now() + 2 * 60 * 1000;
  const ticket = {
    id,
    sessionId: String(sessionId || ""),
    user: publicUser(user),
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString()
  };
  sseTickets.set(id, ticket);
  return ticket;
}

function validateSseTicket(sessionId, ticketId) {
  pruneSseTickets();
  const ticket = sseTickets.get(String(ticketId || ""));
  if (!ticket) return false;
  if (ticket.sessionId !== String(sessionId || "")) return false;
  if (ticket.expiresAtMs < Date.now()) {
    sseTickets.delete(ticket.id);
    return false;
  }
  return ticket;
}

function pruneSseTickets() {
  const now = Date.now();
  for (const ticket of sseTickets.values()) {
    if (ticket.expiresAtMs < now) sseTickets.delete(ticket.id);
  }
}

function sendCodexAttachment(req, res) {
  const agent = isAgentRequest(req) ? agentRequest(req) : null;
  const attachment = getCodexSessionAttachmentContent(req.params.id, {
    user: agent ? agentAuthUser(req) : codexWorkbenchUser(req),
    agentId: agent?.id || ""
  });
  if (!attachment) return res.status(404).json({ error: "Attachment not found." });
  if (!fs.existsSync(attachment.filePath)) {
    return res.status(410).json({ error: "Attachment file is no longer available." });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.type(attachment.mimeType || "application/octet-stream");
  res.sendFile(attachment.filePath);
}

function sendCodexArtifact(req, res) {
  const artifact = getCodexSessionArtifactContent(req.params.id, { user: codexWorkbenchUser(req) });
  if (!artifact) return res.status(404).json({ error: "Artifact not found." });
  if (!fs.existsSync(artifact.filePath)) {
    return res.status(410).json({ error: "Artifact file is no longer available." });
  }

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.type(artifact.mimeType || "text/plain; charset=utf-8");
  res.sendFile(artifact.filePath);
}

function agentRequest(req) {
  const body = req.body || {};
  const bodyAgent = body.agent && typeof body.agent === "object" ? body.agent : {};
  const tokenAuth = req.agentAuth || {};
  const agent = {
    id: tokenAuth.agentId || body.agentId || body.agent?.id,
    agentInstanceId: body.agentInstanceId || body.agent?.agentInstanceId || body.agent?.instanceId,
    ownerUser: tokenAuth.ownerUsername || "",
    displayName: tokenAuth.displayName || ""
  };
  if (hasOwn(body, "workspaces")) {
    agent.workspaces = body.workspaces;
  } else if (hasOwn(bodyAgent, "workspaces")) {
    agent.workspaces = bodyAgent.workspaces;
  }
  if (hasOwn(body, "runtime")) {
    agent.runtime = body.runtime;
  } else if (hasOwn(bodyAgent, "runtime")) {
    agent.runtime = bodyAgent.runtime;
  }
  return agent;
}

function codexWorkbenchUser(req) {
  return scopeCodexWorkbenchUser(req.user || null);
}

function scopeCodexWorkbenchUser(user) {
  if (!user) return null;
  if (!isOwner(user)) return user;
  const username = String(user.username || user.displayName || "").trim();
  if (!username) return user;
  return {
    ...user,
    role: "user"
  };
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function adminSummary() {
  return {
    users: adminUsersWithUsage(),
    tokens: adminTokenSummary()
  };
}

function adminTokenSummary() {
  return {
    pairingTokens: listPairingTokens(),
    agentTokens: listAgentTokens(),
    agentAccessGrants: listAgentAccessGrants()
  };
}

function adminUsersWithUsage() {
  return listAdminUsers(config.auth.users).map(adminUserWithUsage);
}

function adminUserWithUsage(user) {
  if (!user) return null;
  return {
    ...user,
    storage: codexOwnerStorageUsage(user.username)
  };
}

function quotaBytesFromBody(body = {}) {
  if (body.quotaBytes !== undefined) {
    const bytes = Number(body.quotaBytes);
    return Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
  }
  if (body.quotaMb !== undefined) {
    const mb = Number(body.quotaMb);
    return Number.isFinite(mb) ? Math.max(0, Math.floor(mb * 1024 * 1024)) : 0;
  }
  return undefined;
}

function currentSessionUser(req) {
  const querySessionToken =
    isCodexDownloadRequest(req) && (req.method === "GET" || req.method === "HEAD") ? String(req.query.session || "") : "";
  return verifySessionToken({
    token: bearerToken(req) || querySessionToken,
    users: listAuthUsers(config.auth.users),
    secret: config.auth.sessionSecret,
    notBeforeMs: config.auth.sessionNotBeforeMs,
    notBeforeMsByUser: getUserSessionNotBeforeMs
  });
}

function isOwner(user) {
  return String(user?.role || "").toLowerCase() === "owner";
}

function currentAgentAuth(req) {
  const token = req.get("x-echo-agent-token") || bearerToken(req) || req.get("x-echo-token") || req.query.agentToken || req.body?.agentToken || "";
  return verifyAgentToken({ token, configTokens: config.auth.agentTokens });
}

function agentAuthUser(req) {
  const username = String(req.agentAuth?.ownerUsername || "").trim();
  if (!username) return null;
  return {
    username,
    displayName: username,
    role: "user"
  };
}

function isLoginRateLimited(req) {
  const key = loginAttemptKey(req);
  const attempt = loginAttempts.get(key);
  if (!attempt) return false;
  const windowMs = Math.max(1000, Number(config.auth.loginRateLimitWindowMs || 60000));
  const max = Math.max(1, Number(config.auth.loginRateLimitMax || 8));
  if (Date.now() - attempt.firstAt > windowMs) {
    loginAttempts.delete(key);
    return false;
  }
  return attempt.count >= max;
}

function recordLoginFailure(req) {
  const key = loginAttemptKey(req);
  const now = Date.now();
  const windowMs = Math.max(1000, Number(config.auth.loginRateLimitWindowMs || 60000));
  const previous = loginAttempts.get(key);
  if (!previous || now - previous.firstAt > windowMs) {
    loginAttempts.set(key, { firstAt: now, count: 1 });
    return;
  }
  previous.count += 1;
  loginAttempts.set(key, previous);
}

function clearLoginAttempts(req) {
  loginAttempts.delete(loginAttemptKey(req));
}

function loginAttemptKey(req) {
  return `${req.ip || req.socket?.remoteAddress || "unknown"}:${String(req.body?.username || "").trim().toLowerCase()}`;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  const length = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const leftPadded = Buffer.alloc(length);
  const rightPadded = Buffer.alloc(length);
  leftBuffer.copy(leftPadded);
  rightBuffer.copy(rightPadded);
  return crypto.timingSafeEqual(leftPadded, rightPadded) && leftBuffer.length === rightBuffer.length;
}

function isCodexDownloadRequest(req) {
  const path = req.originalUrl.split("?")[0];
  return /^\/api\/codex\/(?:attachments|artifacts)\//.test(path);
}

function isAgentRequest(req) {
  const path = req.originalUrl.split("?")[0];
  return path.startsWith("/api/agent/");
}

function isAdminRequest(req) {
  const path = req.originalUrl.split("?")[0];
  return path.startsWith("/api/admin/");
}
