import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { canAccessAgentOwner, getStorageQuotaBytes } from "./authStore.js";
import { backendAdapterContractVersion, normalizeBackendCapabilities, normalizeBackendHealth } from "./backendAdapterContract.js";
import {
  codexCompatibleModel,
  normalizeAllowedPermissionModes,
  normalizePermissionMode,
  normalizeReasoningEffort,
  normalizeRuntimeBackend,
  normalizeRuntimeBackends,
  normalizeSupportedModels,
  normalizeStringList,
  permissionModeFromRuntime,
  resolveRuntimeForAgent,
  runtimePreferenceFromResolvedRuntime,
  sanitizeRuntimeForAgent
} from "./codexRuntime.js";

const dbPath = path.join(config.dataDir, "echo.sqlite");
const attachmentStorageDir = path.join(config.dataDir, "codex-attachments");
const artifactStorageDir = path.join(config.dataDir, "codex-artifacts");
const fileRequestTtlMs = 90 * 1000;
const fileRequestRetentionMs = 10 * 60 * 1000;
const maxStoredFileRequestResultBytes = 480000;
const maxStoredSessionEventBytes = 64 * 1024;
const maxInlineImageArtifactBytes = 10 * 1024 * 1024;
const maxImageArtifactsPerEvent = 8;
const agentOnlineTtlMs = 90 * 1000;
const runningSessionRecoveryGraceMs = 30 * 1000;
const autoCompactContextPercent = 85;
const reasoningEffortOrder = ["low", "medium", "high", "xhigh", "max"];
const schemaVersion = 10;
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(attachmentStorageDir, { recursive: true });
fs.mkdirSync(artifactStorageDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

migrate();

const insertJob = db.prepare(`
  INSERT INTO codex_jobs (
    id, project_id, prompt, status, created_at, updated_at
  ) VALUES (
    @id, @projectId, @prompt, 'queued', @now, @now
  )
`);

const insertEvent = db.prepare(`
  INSERT INTO codex_events (job_id, at, type, text, raw_json)
  VALUES (@jobId, @at, @type, @text, @rawJson)
`);

const insertSessionEvent = db.prepare(`
  INSERT OR IGNORE INTO codex_session_events (session_id, at, type, text, raw_json, event_key)
  VALUES (@sessionId, @at, @type, @text, @rawJson, @eventKey)
`);

const insertSessionMessage = db.prepare(`
  INSERT INTO codex_session_messages (
    id, session_id, role, text, command_id, external_key, created_at, updated_at
  ) VALUES (
    @id, @sessionId, @role, @text, @commandId, @externalKey, @createdAt, @updatedAt
  )
`);

const insertSessionMessageIgnore = db.prepare(`
  INSERT OR IGNORE INTO codex_session_messages (
    id, session_id, role, text, command_id, external_key, created_at, updated_at
  ) VALUES (
    @id, @sessionId, @role, @text, @commandId, @externalKey, @createdAt, @updatedAt
  )
`);

const insertSessionAttachment = db.prepare(`
  INSERT INTO codex_session_attachments (
    id, session_id, message_id, type, original_name, mime_type, size_bytes, sha256, storage_key, created_at
  ) VALUES (
    @id, @sessionId, @messageId, @type, @originalName, @mimeType, @sizeBytes, @sha256, @storageKey, @createdAt
  )
`);

const insertSessionArtifact = db.prepare(`
  INSERT INTO codex_session_artifacts (
    id, session_id, event_id, kind, label, mime_type, size_bytes, sha256, storage_key, created_at
  ) VALUES (
    @id, @sessionId, @eventId, @kind, @label, @mimeType, @sizeBytes, @sha256, @storageKey, @createdAt
  )
`);

const insertSessionCommand = db.prepare(`
  INSERT INTO codex_session_commands (
    id, session_id, type, payload_json, status, created_at, updated_at, available_at
  ) VALUES (
    @id, @sessionId, @type, @payloadJson, 'queued', @now, @now, @now
  )
`);

const insertWorkspaceCommand = db.prepare(`
  INSERT INTO codex_workspace_commands (
    id, type, payload_json, owner_user, target_agent_id, status, result_json, created_at, updated_at
  ) VALUES (
    @id, @type, @payloadJson, @ownerUser, @targetAgentId, 'queued', '{}', @now, @now
  )
`);

const upsertWorkspaceVisibility = db.prepare(`
  INSERT INTO codex_workspace_visibility (
    owner_user, project_key, workspace_id, target_agent_id, visible_in_sidebar, hidden_at, source, updated_at
  ) VALUES (
    @ownerUser, @projectKey, @workspaceId, @targetAgentId, @visibleInSidebar, @hiddenAt, @source, @now
  )
  ON CONFLICT(owner_user, project_key) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    target_agent_id = excluded.target_agent_id,
    visible_in_sidebar = excluded.visible_in_sidebar,
    hidden_at = excluded.hidden_at,
    source = excluded.source,
    updated_at = excluded.updated_at
`);

const insertFileRequest = db.prepare(`
  INSERT INTO codex_file_requests (
    id, type, project_id, owner_user, target_agent_id, path, payload_json, status, result_json, created_at, updated_at, expires_at, requested_by
  ) VALUES (
    @id, @type, @projectId, @ownerUser, @targetAgentId, @path, @payloadJson, 'queued', '{}', @now, @now, @expiresAt, @requestedBy
  )
`);

const insertSessionApproval = db.prepare(`
  INSERT INTO codex_session_approvals (
    id, session_id, app_request_id, method, status, prompt, payload_json, response_json, created_at, updated_at, requested_by
  ) VALUES (
    @id, @sessionId, @appRequestId, @method, 'pending', @prompt, @payloadJson, '', @now, @now, @requestedBy
  )
`);

const insertSessionInteraction = db.prepare(`
  INSERT INTO codex_session_interactions (
    id, session_id, app_request_id, method, kind, status, prompt, payload_json, response_json, created_at, updated_at, requested_by
  ) VALUES (
    @id, @sessionId, @appRequestId, @method, @kind, 'pending', @prompt, @payloadJson, '', @now, @now, @requestedBy
  )
`);

const trimEvents = db.prepare(`
  DELETE FROM codex_events
  WHERE job_id = ?
    AND id NOT IN (
      SELECT id FROM codex_events
      WHERE job_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
`);

const trimSessionEvents = db.prepare(`
  DELETE FROM codex_session_events
  WHERE session_id = ?
    AND id NOT IN (
      SELECT id FROM codex_session_events
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
`);

const selectLatestSessionContextUsage = db.prepare(`
  SELECT id, at, raw_json AS rawJson
  FROM codex_session_events
  WHERE session_id = ?
    AND type IN ('thread/tokenUsage/updated', 'context.usage.updated', 'context/usage/updated')
  ORDER BY id DESC
  LIMIT 1
`);

const selectLatestSessionContextReset = db.prepare(`
  SELECT id
  FROM codex_session_events
  WHERE session_id = ?
    AND (
      type IN ('context.compaction.started', 'thread/compacted', 'thread.restarted', 'session.context.reset.queued', 'session.backend.switched')
      OR (type = 'item/completed' AND raw_json LIKE '%"contextCompaction"%')
    )
  ORDER BY id DESC
  LIMIT 1
`);

const selectLatestSessionCompactionMarker = db.prepare(`
  SELECT id
  FROM codex_session_events
  WHERE session_id = ?
    AND (
      type IN ('context.compaction.queued', 'context.compaction.started', 'thread/compacted', 'thread.restarted', 'session.context.reset.queued', 'session.backend.switched')
      OR (type = 'item/completed' AND raw_json LIKE '%"contextCompaction"%')
    )
  ORDER BY id DESC
  LIMIT 1
`);

const selectPendingSessionCompactCommand = db.prepare(`
  SELECT 1
  FROM codex_session_commands
  WHERE session_id = ?
    AND type = 'compact'
    AND status IN ('queued', 'leased', 'reconciling')
  LIMIT 1
`);

const summarizeJobColumns = `
  id,
  project_id AS projectId,
  prompt,
  status,
  created_at AS createdAt,
  started_at AS startedAt,
  completed_at AS completedAt,
  exit_code AS exitCode,
  error,
  final_message AS finalMessage,
  leased_by AS leasedBy,
  lease_expires_at AS leaseExpiresAt,
  updated_at AS updatedAt
`;

const summarizeSessionColumns = `
  id,
  project_id AS projectId,
  owner_user AS ownerUser,
  target_agent_id AS targetAgentId,
  title,
  status,
  app_thread_id AS appThreadId,
  active_turn_id AS activeTurnId,
  created_at AS createdAt,
  updated_at AS updatedAt,
  last_error AS lastError,
  final_message AS finalMessage,
  leased_by AS leasedBy,
  leased_instance_id AS leasedInstanceId,
  lease_expires_at AS leaseExpiresAt,
  archived_at AS archivedAt,
  runtime_json AS runtimeJson,
  execution_json AS executionJson,
  memory_json AS memoryJson
`;

const summarizeSessionCommandColumns = `
  id,
  session_id AS sessionId,
  type,
  payload_json AS payloadJson,
  status,
  created_at AS createdAt,
  updated_at AS updatedAt,
  available_at AS availableAt,
  leased_by AS leasedBy,
  leased_instance_id AS leasedInstanceId,
  lease_expires_at AS leaseExpiresAt,
  error,
  attempt,
  result_json AS resultJson,
  completed_by AS completedBy
`;

const summarizeWorkspaceCommandColumns = `
  id,
  type,
  payload_json AS payloadJson,
  owner_user AS ownerUser,
  target_agent_id AS targetAgentId,
  status,
  result_json AS resultJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  leased_by AS leasedBy,
  lease_expires_at AS leaseExpiresAt,
  error
`;

const summarizeFileRequestColumns = `
  id,
  type,
  project_id AS projectId,
  owner_user AS ownerUser,
  target_agent_id AS targetAgentId,
  path,
  payload_json AS payloadJson,
  status,
  result_json AS resultJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  expires_at AS expiresAt,
  leased_by AS leasedBy,
  lease_expires_at AS leaseExpiresAt,
  error,
  requested_by AS requestedBy
`;

const summarizeSessionApprovalColumns = `
  id,
  session_id AS sessionId,
  app_request_id AS appRequestId,
  method,
  status,
  prompt,
  payload_json AS payloadJson,
  response_json AS responseJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  decided_at AS decidedAt,
  decided_by AS decidedBy,
  requested_by AS requestedBy
`;

const summarizeSessionInteractionColumns = `
  id,
  session_id AS sessionId,
  app_request_id AS appRequestId,
  method,
  kind,
  status,
  prompt,
  payload_json AS payloadJson,
  response_json AS responseJson,
  created_at AS createdAt,
  updated_at AS updatedAt,
  answered_at AS answeredAt,
  answered_by AS answeredBy,
  requested_by AS requestedBy
`;

const summarizeSessionMessageColumns = `
  id,
  session_id AS sessionId,
  role,
  text,
  command_id AS commandId,
  external_key AS externalKey,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const summarizeSessionAttachmentColumns = `
  id,
  session_id AS sessionId,
  message_id AS messageId,
  type,
  original_name AS originalName,
  mime_type AS mimeType,
  size_bytes AS sizeBytes,
  sha256,
  storage_key AS storageKey,
  created_at AS createdAt
`;

const summarizeSessionArtifactColumns = `
  id,
  session_id AS sessionId,
  event_id AS eventId,
  kind,
  label,
  mime_type AS mimeType,
  size_bytes AS sizeBytes,
  sha256,
  storage_key AS storageKey,
  created_at AS createdAt
`;

const summarizeQuickSkillColumns = `
  id,
  scope,
  project_id AS projectId,
  target_agent_id AS targetAgentId,
  title,
  description,
  prompt,
  mode,
  requires_session AS requiresSession,
  sort_order AS sortOrder,
  created_at AS createdAt,
  updated_at AS updatedAt,
  archived_at AS archivedAt
`;

function defaultQuickDeployPrompt() {
  return [
    "请把当前对话中已经完成且适合发布的代码改动提交、推送，然后把本次结果合入主部署分支并等待部署完成。",
    "",
    "要求：",
    "- 先检查 git status，只提交与本次对话需求相关的文件，不要提交未跟踪的本地预览或附件文件。",
    "- 根据当前仓库和改动类型选择必要且可运行的验证，例如现有测试、语法检查、格式检查或轻量 smoke test；不要强行运行与项目技术栈无关的检查。",
    "- 将本次改动提交在当前结果分支上；如果当前分支不是主部署分支，先把当前分支推送到默认远端。",
    "- 主部署分支默认使用 main；如果仓库明确配置了其他部署分支或当前任务明确指定目标分支，则使用该分支。",
    "- 如果当前分支已经是主部署分支，提交并推送该分支即可；否则先更新远端信息，再把本次结果合入主部署分支并推送主部署分支，以触发基于主部署分支的部署流程。",
    "- 在隔离 worktree 中，主分支可能已被其他工作区占用；可以安全快进时，优先用 refspec 将当前结果提交推送到主部署分支，不要为了切换主分支破坏其他工作区。",
    "- 不要 force push，不要绕过分支保护；如果遇到冲突、非快进、权限限制或必须走 PR/CI 审批，停止并说明需要的人工处理。",
    "- 如果仓库配置了部署流程，等待部署完成并尽量确认远端服务已更新到合并后的主部署分支提交；如果没有可识别的部署流程，说明已完成提交、推送和合并。",
    "- 如果没有可提交改动，不要空提交，直接说明当前状态。",
    "- 最后简短汇报已运行的验证、结果分支 commit、推送目标、合并目标，以及部署或服务状态。"
  ].join("\n");
}

export function createJob({ projectId, prompt }) {
  const now = nowIso();
  const job = {
    id: crypto.randomUUID(),
    projectId,
    prompt,
    now
  };

  insertJob.run(job);
  trimOldJobs();
  return getJobSummary(job.id);
}

export function upsertAgent(input = {}) {
  const agentId = normalizeAgentId(input.id || input.agentId);
  const agentInstanceId = normalizeAgentInstanceId(input.agentInstanceId || input.instanceId);
  const now = nowIso();
  const hasWorkspaces = hasOwn(input, "workspaces");
  const hasRuntime = hasOwn(input, "runtime");
  const workspaces = hasWorkspaces ? normalizeWorkspaces(input.workspaces) : [];
  const runtime = hasRuntime ? normalizeRuntime(input.runtime) : {};
  const ownerUser = normalizeOwnerUser(input.ownerUser || input.ownerUsername || input.accountId);
  const displayName = String(input.displayName || input.label || "").trim().slice(0, 120);

  db.prepare(`
    INSERT INTO codex_agents (
      id, owner_user, display_name, instance_id, instance_started_at, last_seen_at, workspaces_json, runtime_json,
      snapshot_updated_at, workspaces_updated_at, runtime_updated_at
    ) VALUES (
      @id, @ownerUser, @displayName, @agentInstanceId, @agentInstanceStartedAt, @now, @workspacesJson, @runtimeJson,
      @snapshotUpdatedAt, @workspacesUpdatedAt, @runtimeUpdatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      owner_user = CASE WHEN excluded.owner_user <> '' THEN excluded.owner_user ELSE codex_agents.owner_user END,
      display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE codex_agents.display_name END,
      instance_started_at = CASE
        WHEN @agentInstanceId = '' THEN codex_agents.instance_started_at
        WHEN codex_agents.instance_id = @agentInstanceId AND codex_agents.instance_started_at <> '' THEN codex_agents.instance_started_at
        ELSE @now
      END,
      instance_id = CASE WHEN @agentInstanceId <> '' THEN excluded.instance_id ELSE codex_agents.instance_id END,
      last_seen_at = excluded.last_seen_at,
      workspaces_json = CASE WHEN @hasWorkspaces = 1 THEN excluded.workspaces_json ELSE codex_agents.workspaces_json END,
      runtime_json = CASE WHEN @hasRuntime = 1 THEN excluded.runtime_json ELSE codex_agents.runtime_json END,
      snapshot_updated_at = CASE WHEN @hasSnapshotFields = 1 THEN excluded.snapshot_updated_at ELSE codex_agents.snapshot_updated_at END,
      workspaces_updated_at = CASE WHEN @hasWorkspaces = 1 THEN excluded.workspaces_updated_at ELSE codex_agents.workspaces_updated_at END,
      runtime_updated_at = CASE WHEN @hasRuntime = 1 THEN excluded.runtime_updated_at ELSE codex_agents.runtime_updated_at END
  `).run({
    id: agentId,
    agentInstanceId,
    agentInstanceStartedAt: agentInstanceId ? now : "",
    ownerUser,
    displayName,
    now,
    workspacesJson: JSON.stringify(workspaces),
    runtimeJson: JSON.stringify(runtime),
    hasWorkspaces: hasWorkspaces ? 1 : 0,
    hasRuntime: hasRuntime ? 1 : 0,
    hasSnapshotFields: hasWorkspaces || hasRuntime ? 1 : 0,
    snapshotUpdatedAt: hasWorkspaces || hasRuntime ? now : "",
    workspacesUpdatedAt: hasWorkspaces ? now : "",
    runtimeUpdatedAt: hasRuntime ? now : ""
  });

  const row = db.prepare(`
    SELECT id, owner_user AS ownerUser, display_name AS displayName,
           instance_id AS instanceId, instance_started_at AS instanceStartedAt, last_seen_at AS lastSeenAt,
           workspaces_json AS workspacesJson, runtime_json AS runtimeJson,
           snapshot_updated_at AS snapshotUpdatedAt, workspaces_updated_at AS workspacesUpdatedAt, runtime_updated_at AS runtimeUpdatedAt
    FROM codex_agents
    WHERE id = ?
  `).get(agentId);
  return row ? parseAgent(row) : { id: agentId, ownerUser, displayName, instanceId: agentInstanceId, instanceStartedAt: agentInstanceId ? now : "", lastSeenAt: now, workspaces, runtime };
}

export function touchAgent(id) {
  const agentId = normalizeAgentId(id);
  const now = nowIso();

  db.prepare(`
    INSERT INTO codex_agents (
      id, last_seen_at, workspaces_json, runtime_json, snapshot_updated_at, workspaces_updated_at, runtime_updated_at
    ) VALUES (
      @id, @now, '[]', '{}', '', '', ''
    )
    ON CONFLICT(id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at
  `).run({ id: agentId, now });

  return { id: agentId, lastSeenAt: now };
}

export function statusSnapshot(options = {}) {
  expireStaleAgentRestarts();
  reclaimExpiredWorkspaceCommandLeases();
  expireFileRequests();

  const nowMs = Date.now();
  const visibilityOwner = workspaceVisibilityOwner({ user: options.user });
  const hiddenWorkspaceKeys = hiddenWorkspaceKeySet(visibilityOwner);
  const agents = listAgents()
    .filter((agent) => canAccessAgent(options.user, agent))
    .map((agent) => {
      const visibleWorkspaces = filterVisibleAgentWorkspaces(agent, hiddenWorkspaceKeys);
      return {
        ...agent,
        workspaces: visibleWorkspaces,
        online: isAgentOnline(agent, nowMs)
      };
    });
  const onlineAgents = agents.filter((agent) => agent.online);
  const latestAgent = agents[0] || null;
  const primaryAgent = onlineAgents[0] || null;
  const workspacesUpdatedAt = latestIso(onlineAgents.map((agent) => agent.workspacesUpdatedAt || agent.snapshotUpdatedAt));
  const runtimeUpdatedAt = latestIso(onlineAgents.map((agent) => agent.runtimeUpdatedAt || agent.snapshotUpdatedAt));
  const statusUpdatedAt = latestIso([
    latestAgent?.lastSeenAt,
    ...onlineAgents.flatMap((agent) => [agent.snapshotUpdatedAt, agent.workspacesUpdatedAt, agent.runtimeUpdatedAt])
  ]);

  return {
    enabled: true,
    agentOnline: onlineAgents.length > 0,
    lastAgentSeenAt: latestAgent?.lastSeenAt || "",
    statusUpdatedAt,
    workspacesUpdatedAt,
    runtimeUpdatedAt,
    statusVersion: statusVersionFor({ agents, statusUpdatedAt, workspacesUpdatedAt, runtimeUpdatedAt, hiddenWorkspaceKeys }),
    hiddenWorkspaceKeys: Array.from(hiddenWorkspaceKeys).sort(),
    agents,
    workspaces: mergeAgentWorkspaces(onlineAgents),
    runtime: mergeAgentRuntimes(onlineAgents, primaryAgent?.runtime || {}),
    queued: 0,
    running: 0,
    active: null,
    runningJobs: [],
    recent: [],
    interactive: sessionStatusSnapshot(options)
  };
}

export function getWorkspaceRuntimePreference(input = {}) {
  const ownerUser = workspacePreferenceOwner(input);
  const targetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const workspaceId = String(input.workspaceId || input.projectId || "").trim();
  if (!targetAgentId || !workspaceId) return badRequest("Desktop agent and Workspace are required.");
  assertKnownWorkspacePreferenceScope({ ownerUser, targetAgentId, workspaceId, user: input.user });
  return selectWorkspaceRuntimePreference(ownerUser, targetAgentId, workspaceId);
}

export function updateWorkspaceRuntimePreference(input = {}) {
  const ownerUser = workspacePreferenceOwner(input);
  const targetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const workspaceId = String(input.workspaceId || input.projectId || "").trim();
  if (!targetAgentId || !workspaceId) return badRequest("Desktop agent and Workspace are required.");
  const agent = assertKnownWorkspacePreferenceScope({
    ownerUser,
    targetAgentId,
    workspaceId,
    user: input.user,
    requireOnline: true
  });
  const migration = Boolean(input.migration);
  const candidate = migration ? input.migrationCandidate : input.preference;
  const existing = migration ? selectWorkspaceRuntimePreference(ownerUser, targetAgentId, workspaceId) : null;
  if (existing) return { preference: existing, migrated: false };
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return badRequest("Runtime preference is required.");
  }
  assertWorkspaceWorktreePreference(candidate, agent.runtime || {}, workspaceId);
  const resolved = resolveRuntimeForAgent(candidate, agent.runtime || {});
  const preference = runtimePreferenceFromResolvedRuntime(resolved);
  const expectedVersion = Number(input.version ?? input.expectedVersion ?? 0);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return badRequest("Runtime preference version is invalid.");

  const write = db.transaction(() => {
    const current = selectWorkspaceRuntimePreference(ownerUser, targetAgentId, workspaceId);
    if (migration && current) return { preference: current, migrated: false };
    if ((current?.version || 0) !== expectedVersion) {
      throwHttpError(409, "Runtime preference was updated by another client.", {
        code: "runtime.preference.version_conflict",
        preference: current
      });
    }

    const now = nowIso();
    const version = expectedVersion + 1;
    db.prepare(`
      INSERT INTO workspace_runtime_preferences (
        owner_user, target_agent_id, workspace_id, preference_json, version, created_at, updated_at
      ) VALUES (
        @ownerUser, @targetAgentId, @workspaceId, @preferenceJson, @version, @now, @now
      )
      ON CONFLICT(owner_user, target_agent_id, workspace_id) DO UPDATE SET
        preference_json = excluded.preference_json,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run({
      ownerUser,
      targetAgentId,
      workspaceId,
      preferenceJson: JSON.stringify(preference),
      version,
      now
    });
    return {
      preference: selectWorkspaceRuntimePreference(ownerUser, targetAgentId, workspaceId),
      migrated: migration
    };
  });

  return write();
}

export function listJobs(limit = 20) {
  reclaimExpiredLeases();

  return db.prepare(`
    SELECT ${summarizeJobColumns}
    FROM codex_jobs
    ORDER BY created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 20, 100))).map(summarizeJob);
}

export function getJob(id) {
  reclaimExpiredLeases();

  const row = db.prepare(`
    SELECT ${summarizeJobColumns}
    FROM codex_jobs
    WHERE id = ?
  `).get(id);
  if (!row) return null;

  return {
    ...summarizeJob(row),
    events: listEvents(id)
  };
}

export function acquireNextJob({ agentId, workspaces = [] } = {}) {
  reclaimExpiredLeases();

  const workspaceIds = workspaces.map((workspace) => workspace.id).filter(Boolean);
  if (workspaceIds.length === 0) return null;

  const leaseHolder = normalizeAgentId(agentId);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const placeholders = workspaceIds.map(() => "?").join(",");

  const acquire = db.transaction(() => {
    const job = db.prepare(`
      SELECT ${summarizeJobColumns}
      FROM codex_jobs
      WHERE status = 'queued'
        AND project_id IN (${placeholders})
      ORDER BY created_at ASC
      LIMIT 1
    `).get(...workspaceIds);

    if (!job) return null;

    db.prepare(`
      UPDATE codex_jobs
      SET status = 'running',
          started_at = @now,
          completed_at = NULL,
          leased_by = @leasedBy,
          lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE id = @id
        AND status = 'queued'
    `).run({
      id: job.id,
      now,
      leasedBy: leaseHolder,
      leaseExpiresAt
    });

    insertInternalEvents(job.id, [
      {
        type: "lease.acquired",
        text: `Desktop agent ${leaseHolder} acquired this agent job.`
      }
    ]);

    return getJobSummary(job.id);
  });

  return acquire();
}

export function appendEvents(jobId, incomingEvents = [], options = {}) {
  const job = getJobSummary(jobId);
  if (!job) return false;

  if (!canMutateRunningJob(job, options.agentId)) return false;

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const events = incomingEvents.slice(0, 50).map((event) => normalizeEvent(jobId, event, now));

  const write = db.transaction(() => {
    const update = db.prepare(`
      UPDATE codex_jobs
      SET lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE id = @jobId
        AND status = 'running'
        AND leased_by = @leasedBy
    `).run({ jobId, leaseExpiresAt, now, leasedBy: job.leasedBy });

    if (update.changes === 0) return false;

    for (const event of events) insertEvent.run(event);
    trimEvents.run(jobId, jobId, config.codex.maxEvents);
    return true;
  });

  return write();
}

export function completeJob(jobId, result = {}, options = {}) {
  const job = getJobSummary(jobId);
  if (!job) return false;

  if (!canMutateRunningJob(job, options.agentId)) return false;

  const now = nowIso();
  const error = String(result.error || "");
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
  const succeeded = result.ok === true && !error && (exitCode === null || exitCode === 0);
  const status = succeeded ? "completed" : "failed";
  const finalMessage = String(result.finalMessage || "").slice(0, 12000);

  const finish = db.transaction(() => {
    const update = db.prepare(`
      UPDATE codex_jobs
      SET status = @status,
          completed_at = @now,
          exit_code = @exitCode,
          error = @error,
          final_message = @finalMessage,
          leased_by = NULL,
          lease_expires_at = NULL,
          updated_at = @now
      WHERE id = @jobId
        AND status = 'running'
        AND leased_by = @leasedBy
    `).run({
      jobId,
      status,
      now,
      exitCode,
      error,
      finalMessage,
      leasedBy: job.leasedBy
    });

    if (update.changes === 0) return false;

    insertInternalEvents(jobId, [
      {
        type: status === "completed" ? "job.completed" : "job.failed",
        text: status === "completed" ? "Agent job completed." : error || "Agent job failed."
      }
    ]);
    return true;
  });

  if (!finish()) return false;
  trimOldJobs();
  return true;
}

export function createSession({ projectId, prompt, attachments, runtime, mode, sourceSessionId, threadMode, ownerUser: inputOwnerUser, targetAgentId: inputTargetAgentId, user, internalExecution }) {
  const now = nowIso();
  const sessionId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const normalizedPrompt = String(prompt || "").trim();
  const normalizedProjectId = String(projectId || "").trim();
  const ownerUser = normalizeOwnerUser(inputOwnerUser);
  const targetAgentId = normalizeTargetAgentId(inputTargetAgentId);
  const workspace = onlineWorkspaceForProject(normalizedProjectId, { targetAgentId, user });
  if (workspace?.ambiguous) return conflict("Multiple desktop environments expose this workspace. Choose an environment before starting.");
  if (!workspace && (targetAgentId || user)) return conflict("Desktop agent is not online for this workspace.");
  const resolvedTargetAgentId = targetAgentId || (user ? workspace?.agentId || "" : "");
  const commandMode = normalizeSessionMode(mode);
  const normalizedThreadMode = normalizeThreadMode(threadMode);
  const sourceMemory = normalizedThreadMode === "fork-summary" ? sourceSessionMemory(sourceSessionId, normalizedProjectId, ownerUser, resolvedTargetAgentId) : null;
  const contextPrompt = sourceMemory ? forkSummaryPrompt(normalizedPrompt, sourceMemory) : "";
  const storedPreference = selectWorkspaceRuntimePreference(ownerUser || "local", resolvedTargetAgentId, normalizedProjectId);
  const requestedRuntime = storedPreference || (runtime && Object.keys(runtime).length > 0 ? runtime : {});
  const normalizedRuntime = (resolvedTargetAgentId || user) && !internalExecution
    ? resolveSessionRuntimeForProject(requestedRuntime, normalizedProjectId, resolvedTargetAgentId)
    : sanitizeRuntimeForAgent(requestedRuntime, runtimeForProject(normalizedProjectId));
  const normalizedAttachments = normalizeSessionAttachments(attachments);
  if (normalizedAttachments.length > 0 && !runtimeSupports(normalizedRuntime, "attachments")) {
    return badRequest("当前后端暂不支持文件附件。");
  }
  const stagedAttachments = stageSessionAttachments({ sessionId, messageId, attachments: normalizedAttachments, createdAt: now });
  if (!normalizedPrompt && stagedAttachments.length === 0) {
    cleanupStagedAttachments(stagedAttachments);
    return badRequest("Session prompt or attachment is required.");
  }
  try {
    ensureOwnerStorageQuota(ownerUser, attachmentBytes(stagedAttachments));
  } catch (error) {
    cleanupStagedAttachments(stagedAttachments);
    throw error;
  }
  const title = sessionTitleFromInput(normalizedPrompt, stagedAttachments);

  const create = db.transaction(() => {
    const execution = normalizeInternalSessionExecution(internalExecution, {
      sessionId,
      projectId: normalizedProjectId,
      targetAgentId: resolvedTargetAgentId
    });
    db.prepare(`
      INSERT INTO codex_sessions (
        id, project_id, owner_user, target_agent_id, title, status, created_at, updated_at, runtime_json, execution_json
      ) VALUES (
        @id, @projectId, @ownerUser, @targetAgentId, @title, 'queued', @now, @now, @runtimeJson, @executionJson
      )
    `).run({
      id: sessionId,
      projectId: normalizedProjectId,
      ownerUser,
      targetAgentId: resolvedTargetAgentId,
      title,
      now,
      runtimeJson: JSON.stringify(normalizedRuntime),
      executionJson: JSON.stringify(execution)
    });

    insertSessionCommand.run({
      id: commandId,
      sessionId,
      type: "start",
      payloadJson: JSON.stringify({
        messageId,
        mode: commandMode,
        threadMode: sourceMemory ? "fork-summary" : normalizedThreadMode,
        sourceSessionId: sourceMemory?.sourceSessionId || "",
        contextPrompt
      }),
      now
    });

    insertSessionMessage.run({
      id: messageId,
      sessionId,
      role: "user",
      text: normalizedPrompt,
      commandId,
      externalKey: `user:${commandId}`,
      createdAt: now,
      updatedAt: now
    });

    for (const attachment of stagedAttachments) {
      insertSessionAttachment.run(attachment);
    }

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "user.message",
        text: normalizedPrompt,
        raw: {
          source: "mobile",
          commandId,
          type: "start",
          messageId,
          mode: commandMode,
          threadMode: sourceMemory ? "fork-summary" : normalizedThreadMode,
          sourceSessionId: sourceMemory?.sourceSessionId || "",
          attachments: attachmentRefsFromRows(stagedAttachments)
        }
      }, now)
    );
  });

  try {
    create();
  } catch (error) {
    cleanupStagedAttachments(stagedAttachments);
    throw error;
  }
  trimOldSessions();
  return sessionForUser(getSessionSummary(sessionId), user);
}

function normalizeInternalSessionExecution(value, identity = {}) {
  if (!value) return {};
  if (!value || typeof value !== "object" || value.ownerType !== "orchestration") return badRequest("Internal Session execution is invalid.");
  const execution = {
    mode: "worktree",
    ownerType: "orchestration",
    lifecycleState: "ready",
    sessionId: identity.sessionId,
    desktopAgentId: normalizeTargetAgentId(identity.targetAgentId),
    baseWorkspaceId: String(identity.projectId || "").trim().slice(0, 160),
    runId: String(value.runId || "").trim().slice(0, 160),
    itemId: String(value.itemId || "").trim().slice(0, 160),
    worktreeKind: value.worktreeKind === "integration" ? "integration" : "change",
    path: String(value.path || "").trim().slice(0, 2000),
    basePath: String(value.basePath || "").trim().slice(0, 2000),
    branchName: String(value.branchName || "").trim().slice(0, 240),
    baseBranch: String(value.baseBranch || "").trim().slice(0, 240),
    baseCommit: String(value.baseCommit || "").trim().toLowerCase().slice(0, 64),
    worktreeId: `orchestration:${String(value.runId || "").slice(0, 80)}:${String(value.itemId || "").slice(0, 80)}`,
    createdAt: String(value.createdAt || nowIso()).slice(0, 80)
  };
  if (!execution.runId || !execution.itemId || !execution.path || !execution.basePath || !execution.baseBranch || !/^[0-9a-f]{7,64}$/.test(execution.baseCommit)) {
    return badRequest("Internal orchestration execution identity is incomplete.");
  }
  return execution;
}

function completedSessionExecution(existing, reported) {
  if (!reported || typeof reported !== "object") return null;
  if (existing?.ownerType !== "orchestration") return reported;
  const merged = { ...existing, ...reported };
  for (const key of [
    "ownerType",
    "runId",
    "itemId",
    "worktreeKind",
    "path",
    "basePath",
    "baseBranch",
    "baseCommit",
    "desktopAgentId",
    "baseWorkspaceId",
    "sessionId",
    "worktreeId",
    "branchName"
  ]) {
    merged[key] = existing[key];
  }
  return merged;
}

export function listSessions(limit = 20, options = {}) {
  refreshInteractiveSessionState();
  const archived = Boolean(options.archived);
  const projectId = String(options.projectId || "").trim();
  const targetAgentId = normalizeTargetAgentId(options.targetAgentId);
  const clauses = [`archived_at ${archived ? "IS NOT NULL" : "IS NULL"}`];
  const params = {
    limit: Math.max(1, Math.min(Number(limit) || 20, 100))
  };
  addOwnerAccessClause(clauses, params, options.user);
  if (projectId) {
    clauses.push("project_id = @projectId");
    params.projectId = projectId;
  }
  if (targetAgentId) {
    clauses.push("target_agent_id = @targetAgentId");
    params.targetAgentId = targetAgentId;
  }

  const sessions = db.prepare(`
    SELECT ${summarizeSessionColumns}
    FROM codex_sessions
    WHERE ${clauses.join(" AND ")}
    ORDER BY updated_at DESC, created_at DESC
    LIMIT @limit
  `).all(params).map(summarizeSession);
  return sessions.map((session) => sessionForUser(session, options.user));
}

export function getSession(id, options = {}) {
  refreshInteractiveSessionState();

  const session = getSessionSummary(id);
  if (!session) return null;
  if (!canAccessOwner(options.user, session.ownerUser)) return null;
  const result = {
    ...session,
    events: listSessionEvents(id, {
      maxEvents: options.maxEvents,
      afterEventId: options.afterEventId,
      rawMode: options.rawMode,
      includeRaw: options.includeRaw
    })
  };
  if (options.includeMessages !== false) result.messages = listSessionMessages(id);
  if (options.includeApprovals !== false) result.approvals = listSessionApprovals(id);
  if (options.includeInteractions !== false) result.interactions = listSessionInteractions(id);
  if (options.includeArtifacts !== false) result.artifacts = listSessionArtifacts(id, options.maxArtifacts);
  return sessionForUser(result, options.user);
}

export function getSessionCommandSessionId(id) {
  return getSessionCommandSummary(id)?.sessionId || "";
}

export function requestAgentRestart(input = {}) {
  const sessionId = String(input.sessionId || "").trim();
  const agentId = normalizeAgentId(input.agentId);
  const oldInstanceId = normalizeAgentInstanceId(input.agentInstanceId || input.oldInstanceId);
  const expectedRevision = normalizeSourceRevision(input.expectedRevision);
  if (!sessionId || !agentId || !oldInstanceId) return badRequest("Session, agent, and agent instance are required for restart.");
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Session not found.");
  if (session.targetAgentId && session.targetAgentId !== agentId) return conflict("Session belongs to another desktop agent.");
  if (session.leasedBy && session.leasedBy !== agentId) return conflict("Session is leased by another desktop agent.");
  const existing = latestRestartOperation(sessionId, ["requested", "restarting", "resuming"]);
  if (existing) {
    if (existing.oldInstanceId !== oldInstanceId || existing.expectedRevision !== expectedRevision) {
      return conflict("A different restart operation is already active for this session.");
    }
    return existing;
  }
  const now = nowIso();
  const operation = {
    id: crypto.randomUUID(),
    sessionId,
    agentId,
    oldInstanceId,
    expectedRevision,
    resumeSummary: String(input.resumeSummary || "").trim().slice(0, 8000),
    now
  };
  const create = db.transaction(() => {
    db.prepare(`
      INSERT INTO codex_agent_restart_operations (
        id, session_id, agent_id, old_instance_id, expected_revision, status, resume_summary,
        created_at, updated_at
      ) VALUES (
        @id, @sessionId, @agentId, @oldInstanceId, @expectedRevision, 'requested', @resumeSummary,
        @now, @now
      )
    `).run(operation);
    insertSessionEvent.run(normalizeSessionEvent(sessionId, {
      type: "agent.restart.requested",
      text: "Desktop agent restart was checkpointed and will begin after this turn is saved.",
      raw: { source: "relay", operationId: operation.id, expectedRevision }
    }, now));
    db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
  });
  create();
  return latestRestartOperation(sessionId);
}

export function armAgentRestart(input = {}) {
  const sessionId = String(input.sessionId || "").trim();
  const agentId = normalizeAgentId(input.agentId);
  const oldInstanceId = normalizeAgentInstanceId(input.agentInstanceId || input.oldInstanceId);
  const operation = latestRestartOperation(sessionId, ["requested", "restarting"]);
  const operationId = String(input.operationId || input.id || "").trim();
  if (
    !operation ||
    (operationId && operation.id !== operationId) ||
    operation.agentId !== agentId ||
    operation.oldInstanceId !== oldInstanceId
  ) return null;
  if (operation.status === "restarting") return operation;
  const now = nowIso();
  const arm = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE codex_agent_restart_operations
      SET status = 'restarting', updated_at = @now
      WHERE id = @id AND status = 'requested'
    `).run({ id: operation.id, now });
    if (updated.changes === 0) return false;
    insertSessionEvent.run(normalizeSessionEvent(sessionId, {
      type: "agent.restart.restarting",
      text: "Desktop agent is restarting. This conversation will remain available after it reconnects.",
      raw: { source: "relay", operationId: operation.id, expectedRevision: operation.expectedRevision }
    }, now));
    db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    return true;
  });
  return arm() ? latestRestartOperation(sessionId) : null;
}

export function pendingAgentRestart(input = {}) {
  const sessionId = String(input.sessionId || "").trim();
  const agentId = normalizeAgentId(input.agentId);
  const oldInstanceId = normalizeAgentInstanceId(input.agentInstanceId || input.oldInstanceId);
  const operation = latestRestartOperation(sessionId, ["requested"]);
  if (!operation || operation.agentId !== agentId || operation.oldInstanceId !== oldInstanceId) return null;
  return operation;
}

export function reconcileAgentRestarts(input = {}) {
  const agentId = normalizeAgentId(input.id || input.agentId);
  const newInstanceId = normalizeAgentInstanceId(input.agentInstanceId || input.instanceId);
  const sourceRevision = normalizeSourceRevision(input.runtime?.sourceRevision || input.sourceRevision);
  if (!agentId || !newInstanceId) return [];
  const timeoutError = "Desktop agent did not reconnect within the restart timeout.";
  const operations = db.prepare(`
    SELECT * FROM codex_agent_restart_operations
    WHERE agent_id = ? AND old_instance_id <> ?
      AND (status = 'restarting' OR (status = 'failed' AND error = ?))
    ORDER BY created_at ASC
  `).all(agentId, newInstanceId, timeoutError).map(parseRestartOperation);
  const outcomes = [];
  for (const operation of operations) {
    const now = nowIso();
    if (operation.expectedRevision && sourceRevision !== operation.expectedRevision) {
      const error = sourceRevision
        ? `Restarted desktop agent revision ${sourceRevision} does not match expected revision ${operation.expectedRevision}.`
        : "Restarted desktop agent did not advertise a source revision.";
      const fail = db.transaction(() => {
        db.prepare(`
          UPDATE codex_agent_restart_operations
          SET status = 'failed', new_instance_id = @newInstanceId, actual_revision = @sourceRevision,
              error = @error, completed_at = @now, updated_at = @now
          WHERE id = @id AND status IN ('restarting', 'failed')
        `).run({ id: operation.id, newInstanceId, sourceRevision, error, now });
        insertSessionEvent.run(normalizeSessionEvent(operation.sessionId, {
          type: "agent.restart.failed",
          text: error,
          raw: { source: "relay", operationId: operation.id, newInstanceId, sourceRevision }
        }, now));
        db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(now, operation.sessionId);
      });
      fail();
      outcomes.push(latestRestartOperation(operation.sessionId));
      continue;
    }
    const complete = db.transaction(() => {
      const updated = db.prepare(`
        UPDATE codex_agent_restart_operations
        SET status = 'completed', new_instance_id = @newInstanceId, actual_revision = @sourceRevision,
            continuation_command_id = '', error = '', completed_at = @now, updated_at = @now
        WHERE id = @id AND status IN ('restarting', 'failed')
      `).run({ id: operation.id, newInstanceId, sourceRevision, now });
      if (updated.changes === 0) return false;
      db.prepare(`
        UPDATE codex_sessions
        SET status = CASE WHEN status IN ('starting', 'running') THEN 'active' ELSE status END,
            active_turn_id = NULL,
            last_error = CASE WHEN last_error = @previousError THEN '' ELSE last_error END,
            leased_by = NULL,
            leased_instance_id = '', lease_expires_at = NULL, updated_at = @now
        WHERE id = @sessionId
      `).run({ sessionId: operation.sessionId, previousError: operation.error, now });
      insertSessionEvent.run(normalizeSessionEvent(operation.sessionId, {
        type: "agent.restart.completed",
        text: `Desktop agent restarted and reconnected at revision ${sourceRevision || "unknown"}.`,
        raw: { source: "relay", operationId: operation.id, newInstanceId, sourceRevision }
      }, now));
      return true;
    });
    if (complete()) outcomes.push(latestRestartOperation(operation.sessionId));
  }
  return outcomes;
}

export function expireAgentRestarts() {
  return expireStaleAgentRestarts();
}

export function getSessionAttachmentContent(id, options = {}) {
  const attachment = getSessionAttachment(id);
  if (!attachment) return null;
  const session = getSessionSummary(attachment.sessionId);
  if (!canAccessSessionContent(session, options)) return null;
  return {
    ...attachment,
    filePath: attachmentAbsolutePath(attachment.storageKey)
  };
}

export function getSessionArtifactContent(id, options = {}) {
  const artifact = getSessionArtifact(id);
  if (!artifact) return null;
  const session = getSessionSummary(artifact.sessionId);
  if (!canAccessSessionContent(session, options)) return null;
  return {
    ...artifact,
    filePath: artifactAbsolutePath(artifact.storageKey)
  };
}

export function archiveSession(id, input = {}) {
  refreshInteractiveSessionState();
  const session = getSessionSummary(id);
  if (!session) return notFound("Session not found.");
  if (!canAccessOwner(input.user, session.ownerUser)) return notFound("Session not found.");

  const archive = input.archived !== false;
  if (
    archive &&
    (["queued", "starting", "running"].includes(session.status) ||
      session.pendingCommandCount > 0 ||
      session.pendingApprovalCount > 0 ||
      session.pendingInteractionCount > 0)
  ) {
    return conflict("Running sessions cannot be archived yet.");
  }
  if (!archive && session.pendingCommandCount > 0) {
    return conflict("Wait for the pending session command to finish before restoring it.");
  }

  const now = nowIso();
  const commandId = shouldQueueNativeArchiveSessionCommand(session) ? crypto.randomUUID() : "";
  const write = db.transaction(() => {
    if (commandId) {
      insertSessionCommand.run({
        id: commandId,
        sessionId: id,
        type: "archive",
        payloadJson: JSON.stringify({ archived: archive }),
        now
      });
    }

    db.prepare(`
      UPDATE codex_sessions
      SET archived_at = @archivedAt,
          updated_at = @now
      WHERE id = @id
    `).run({
      id,
      archivedAt: archive ? now : null,
      now
    });

    insertSessionEvent.run(
      normalizeSessionEvent(id, {
        type: archive ? "session.archived" : "session.restored",
        text: archive ? "Session archived." : "Session restored.",
        raw: {
          source: "mobile",
          commandId,
          type: "archive",
          archived: archive,
          nativeSyncQueued: Boolean(commandId)
        }
      }, now)
    );
  });

  write();

  return getSessionSummary(id);
}

export function deleteSession(id, input = {}) {
  refreshInteractiveSessionState();
  const session = getSessionSummary(id);
  if (!session) return notFound("Session not found.");
  if (!canAccessOwner(input.user, session.ownerUser)) return notFound("Session not found.");
  if (!session.archivedAt) return conflict("Archive this session before deleting it.");
  if (
    ["queued", "starting", "running"].includes(session.status) ||
    session.pendingCommandCount > 0 ||
    session.pendingApprovalCount > 0 ||
    session.pendingInteractionCount > 0
  ) {
    return conflict("Wait for this archived session to finish pending work before deleting it.");
  }

  const attachmentKeys = db.prepare(`
    SELECT storage_key AS storageKey
    FROM codex_session_attachments
    WHERE session_id = ?
  `).all(id).map((row) => row.storageKey);
  const artifactKeys = db.prepare(`
    SELECT storage_key AS storageKey
    FROM codex_session_artifacts
    WHERE session_id = ?
  `).all(id).map((row) => row.storageKey);

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM codex_sessions WHERE id = ?").run(id);
  });
  remove();
  cleanupAttachmentStorageKeys(attachmentKeys);
  cleanupArtifactStorageKeys(artifactKeys);
  return {
    id,
    deleted: true,
    attachmentCount: attachmentKeys.length,
    artifactCount: artifactKeys.length
  };
}

export function enqueueSessionMessage(sessionId, input = {}) {
  refreshInteractiveSessionState();
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Session not found.");
  if (!canAccessOwner(input.user, session.ownerUser)) return notFound("Session not found.");
  const expectedProjectId = String(input.projectId || input.expectedProjectId || "").trim();
  if (expectedProjectId && session.projectId !== expectedProjectId) {
    return conflict("This session belongs to a different project.");
  }
  const expectedTargetAgentId = normalizeTargetAgentId(input.targetAgentId || input.expectedTargetAgentId);
  if (expectedTargetAgentId && session.targetAgentId && session.targetAgentId !== expectedTargetAgentId) {
    return conflict("This session belongs to a different desktop environment.");
  }
  if (session.archivedAt) return conflict("Restore this session before continuing it.");
  const recoverableFailure = session.status === "failed" && sessionCanRecoverFailure(session);
  if (["cancelled", "closed", "stale"].includes(session.status) || (session.status === "failed" && !recoverableFailure)) {
    return conflict("This session is no longer active.");
  }
  if (sessionHasClosedWorktree(session)) {
    return conflict("This session worktree is no longer available for follow-up. Start a new isolated session to continue.");
  }

  const now = nowIso();
  const commandId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const message = String(input.text || input.prompt || "").trim();
  const mode = normalizeSessionMode(input.mode);
  const reuseSessionRuntime = input.reuseSessionRuntime === true;
  const storedPreference = reuseSessionRuntime ? null : selectWorkspaceRuntimePreference(session.ownerUser || "local", session.targetAgentId, session.projectId);
  const requestedRuntime = reuseSessionRuntime ? session.runtime : (storedPreference || (Object.keys(input.runtime || {}).length > 0 ? input.runtime : session.runtime));
  const runtime = reuseSessionRuntime ? session.runtime : (session.targetAgentId || input.user
    ? resolveSessionRuntimeForProject(requestedRuntime, session.projectId, session.targetAgentId)
    : sanitizeRuntimeForAgent(requestedRuntime, runtimeForProject(session.projectId)));
  const backendChanged = sessionBackendChanged(session.runtime, runtime);
  const resetForAssistantImageArtifacts = !backendChanged && sessionHasUnresetAssistantImageArtifact(sessionId);
  const normalizedAttachments = normalizeSessionAttachments(input.attachments);
  if (normalizedAttachments.length > 0 && !runtimeSupports(runtime, "attachments")) {
    return badRequest("当前后端暂不支持文件附件。");
  }
  const stagedAttachments = stageSessionAttachments({ sessionId, messageId, attachments: normalizedAttachments, createdAt: now });
  if (!message && stagedAttachments.length === 0) {
    cleanupStagedAttachments(stagedAttachments);
    return badRequest("Session message or attachment is required.");
  }
  try {
    ensureOwnerStorageQuota(session.ownerUser, attachmentBytes(stagedAttachments));
  } catch (error) {
    cleanupStagedAttachments(stagedAttachments);
    throw error;
  }

  const enqueue = db.transaction(() => {
    insertSessionCommand.run({
      id: commandId,
      sessionId,
      type: "message",
      payloadJson: JSON.stringify({
        messageId,
        mode,
        resetThread: backendChanged || resetForAssistantImageArtifacts,
        resetReason: backendChanged ? "backend-switch" : resetForAssistantImageArtifacts ? "assistant-image-artifact" : ""
      }),
      now
    });

    const clearLastError = recoverableFailure || isRecoverableSessionNotice(session.lastError);
    db.prepare(`
      UPDATE codex_sessions
      SET updated_at = @now,
          runtime_json = @runtimeJson,
          app_thread_id = CASE WHEN @backendChanged = 1 THEN NULL ELSE app_thread_id END,
          active_turn_id = CASE WHEN @backendChanged = 1 THEN NULL ELSE active_turn_id END,
          status = CASE WHEN @recoverableFailure = 1 THEN 'active' WHEN status = 'queued' THEN 'queued' ELSE status END,
          last_error = CASE WHEN @clearLastError = 1 THEN '' ELSE last_error END
      WHERE id = @sessionId
    `).run({
      sessionId,
      now,
      runtimeJson: JSON.stringify(runtime),
      recoverableFailure: recoverableFailure ? 1 : 0,
      clearLastError: clearLastError ? 1 : 0,
      backendChanged: backendChanged ? 1 : 0
    });

    insertSessionMessage.run({
      id: messageId,
      sessionId,
      role: "user",
      text: message,
      commandId,
      externalKey: `user:${commandId}`,
      createdAt: now,
      updatedAt: now
    });

    for (const attachment of stagedAttachments) {
      insertSessionAttachment.run(attachment);
    }

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "user.message",
        text: message,
        raw: { source: "mobile", commandId, type: "message", messageId, mode, attachments: attachmentRefsFromRows(stagedAttachments) }
      }, now)
    );

    if (resetForAssistantImageArtifacts) {
      insertSessionEvent.run(
        normalizeSessionEvent(sessionId, {
          type: "session.context.reset.queued",
          text: "Echo will start a fresh local Codex thread before this follow-up so generated image bytes do not stay in model context.",
          raw: {
            source: "relay",
            commandId,
            resetThread: true,
            resetReason: "assistant-image-artifact"
          }
        }, now)
      );
    }

    if (backendChanged) {
      insertSessionEvent.run(
        normalizeSessionEvent(sessionId, {
          type: "session.backend.switched",
          text: `Backend switched from ${runtimeBackendLabel(session.runtime)} to ${runtimeBackendLabel(runtime)}; Echo will rebuild context in a fresh backend session.`,
          raw: {
            source: "relay",
            commandId,
            resetThread: true,
            resetReason: "backend-switch",
            previousRuntime: compactRuntimeBackendRef(session.runtime),
            nextRuntime: compactRuntimeBackendRef(runtime)
          }
        }, now)
      );
    }
  });

  try {
    enqueue();
  } catch (error) {
    cleanupStagedAttachments(stagedAttachments);
    throw error;
  }
  return getSession(sessionId);
}

export function compactSession(sessionId, input = {}) {
  if (input.skipRefresh !== true) refreshInteractiveSessionState();
  const resultSession = () => input.skipRefresh === true ? getSessionSummary(sessionId) : getSession(sessionId);
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Session not found.");
  if (!canAccessOwner(input.user, session.ownerUser)) return notFound("Session not found.");

  const automatic = Boolean(input.automatic);
  const reason = String(input.reason || "").trim().slice(0, 240);
  if (automatic) {
    if (!shouldQueueAutomaticCompaction(sessionId, session)) return resultSession();
  } else {
    if (session.archivedAt) return conflict("Restore this session before compacting it.");
    if (!runtimeSupports(session.runtime, "compaction")) return conflict("当前后端暂不支持远程上下文压缩。");
    if (!session.appThreadId) return conflict("This session has no backend thread to compact yet.");
    if (!sessionCanCompact(session)) return conflict("Wait for the current agent turn to finish before compacting context.");
  }

  const now = nowIso();
  const commandId = crypto.randomUUID();

  const enqueue = db.transaction(() => {
    insertSessionCommand.run({
      id: commandId,
      sessionId,
      type: "compact",
      payloadJson: JSON.stringify({ automatic, reason }),
      now
    });

    db.prepare(`
      UPDATE codex_sessions
      SET updated_at = @now
      WHERE id = @sessionId
    `).run({ sessionId, now });

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "context.compaction.queued",
        text: automatic ? "Context compaction queued automatically." : "Context compaction requested from mobile.",
        raw: { source: "mobile", commandId, type: "compact", automatic, reason }
      }, now)
    );
  });

  enqueue();
  return resultSession();
}

export function cancelSession(sessionId, input = {}) {
  refreshInteractiveSessionState();
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Session not found.");
  if (!canAccessOwner(input.user, session.ownerUser)) return notFound("Session not found.");
  if (session.archivedAt) return conflict("Restore this session before cancelling it.");
  if (["closed", "cancelled", "stale"].includes(session.status)) return session;

  const now = nowIso();
  const reason = String(input.reason || "Cancelled from mobile.").trim().slice(0, 240) || "Cancelled from mobile.";

  if (session.status === "queued" && !session.leasedBy && !session.appThreadId) {
    const cancelQueued = db.transaction(() => {
      db.prepare(`
        UPDATE codex_session_commands
        SET status = 'failed',
            error = @reason,
            updated_at = @now
        WHERE session_id = @sessionId
          AND status = 'queued'
      `).run({ sessionId, reason, now });

      db.prepare(`
        UPDATE codex_sessions
        SET status = 'cancelled',
            active_turn_id = NULL,
            leased_by = NULL,
            leased_instance_id = '',
            lease_expires_at = NULL,
            last_error = '',
            updated_at = @now
        WHERE id = @sessionId
      `).run({ sessionId, now });

      denyPendingSessionApprovals(sessionId, now, "cancelled");
      cancelPendingSessionInteractions(sessionId, now, "cancelled");

      insertSessionEvent.run(
        normalizeSessionEvent(sessionId, {
          type: "session.cancelled",
          text: reason,
          raw: { source: "mobile", reason }
        }, now)
      );
    });
    cancelQueued();
    return getSession(sessionId);
  }

  if (!session.activeTurnId && session.status !== "starting" && session.status !== "running" && session.pendingCommandCount === 0) {
    return conflict("This session does not have an active turn to cancel.");
  }

  const enqueueStop = db.transaction(() => {
    db.prepare(`
      UPDATE codex_session_commands
      SET status = 'failed',
          error = @reason,
          updated_at = @now
      WHERE session_id = @sessionId
        AND status = 'queued'
        AND type <> 'stop'
    `).run({ sessionId, reason, now });

    if (!sessionHasQueuedStopCommand(sessionId)) {
      insertSessionCommand.run({
        id: crypto.randomUUID(),
        sessionId,
        type: "stop",
        payloadJson: JSON.stringify({ reason }),
        now
      });
    }

    db.prepare(`
      UPDATE codex_sessions
      SET updated_at = @now
      WHERE id = @sessionId
    `).run({ sessionId, now });

    denyPendingSessionApprovals(sessionId, now, "cancelled");
    cancelPendingSessionInteractions(sessionId, now, "cancelled");

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: "turn.cancel.requested",
        text: reason,
        raw: { source: "mobile", type: "stop", reason }
      }, now)
    );
  });

  enqueueStop();
  return getSession(sessionId);
}

export function queueSessionWorktreeAction(sessionId, input = {}) {
  refreshInteractiveSessionState();
  const session = getSessionSummary(sessionId);
  if (!session) return notFound("Session not found.");
  if (!canAccessOwner(input.user, session.ownerUser)) return notFound("Session not found.");
  if (session.archivedAt) return conflict("Restore this session before changing its worktree.");
  if (["queued", "starting", "running", "cancelled", "closed", "stale"].includes(session.status)) {
    return conflict("This session cannot change its worktree while it is queued, running, or closed.");
  }
  if (session.pendingCommandCount > 0) return conflict("Wait for the current session command to finish first.");

  const execution = session.execution && typeof session.execution === "object" ? session.execution : {};
  if (execution.mode !== "worktree" || (!execution.worktreeId && !execution.sessionId && !execution.path)) {
    return conflict("This session is not running in an isolated worktree.");
  }
  const worktreeState = String(execution.lifecycleState || execution.cleanupState || "").trim().toLowerCase();
  if (["unavailable", "cleanup-failed", "cleanup-pending"].includes(worktreeState)) {
    return conflict("This session worktree is no longer available for apply or discard.");
  }

  const action = normalizeWorktreeAction(input.action);
  if (!action) return badRequest("Worktree action must be setup, apply, or discard.");
  if (action === "setup" && worktreeState !== "failed" && execution.setupStatus !== "failed") {
    return conflict("This session worktree does not need setup recovery.");
  }
  if (worktreeState === "applied") {
    return action === "apply" ? getSession(sessionId, { user: input.user }) : conflict("This session worktree has already been applied.");
  }
  if (worktreeState === "discarded") {
    return action === "discard" ? getSession(sessionId, { user: input.user }) : conflict("This session worktree has already been discarded.");
  }

  const now = nowIso();
  const commandId = crypto.randomUUID();
  const enqueue = db.transaction(() => {
    insertSessionCommand.run({
      id: commandId,
      sessionId,
      type: "worktree",
      payloadJson: JSON.stringify({ action }),
      now
    });

    db.prepare(`
      UPDATE codex_sessions
      SET updated_at = @now
      WHERE id = @sessionId
    `).run({ sessionId, now });

    insertSessionEvent.run(
      normalizeSessionEvent(sessionId, {
        type: `worktree.${action}.queued`,
        text:
          action === "apply"
            ? "Worktree apply requested from mobile."
            : action === "discard"
              ? "Worktree discard requested from mobile."
              : "Worktree setup retry requested from mobile.",
        raw: { source: "mobile", commandId, type: "worktree", action }
      }, now)
    );
  });

  enqueue();
  return getSession(sessionId, { user: input.user });
}

export function createWorkspaceCommand(input = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const name = normalizeWorkspaceName(input.name || input.label);
  if (!name) return badRequest("Workspace name is required.");

  const now = nowIso();
  const requestedTargetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const targetAgentId = requestedTargetAgentId || defaultOnlineAgentIdForUser(input.user);
  if (input.user && !targetAgentId) return conflict("Desktop agent is not online.");
  if (input.user && requestedTargetAgentId && !onlineAgentForUser(requestedTargetAgentId, input.user)) {
    return conflict("Desktop agent is not online.");
  }

  const command = {
    id: crypto.randomUUID(),
    type: "create",
    ownerUser: normalizeOwnerUser(input.ownerUser || input.requestedBy),
    targetAgentId,
    payloadJson: JSON.stringify({
      name,
      label: name,
      requestedBy: String(input.requestedBy || "mobile").slice(0, 120)
    }),
    now
  };

  insertWorkspaceCommand.run(command);
  return getWorkspaceCommand(command.id);
}

export function createWorkspaceImportListCommand(input = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const rootId = normalizeWorkspaceImportRootId(input.rootId);
  const importPath = normalizeWorkspaceImportPath(input.path || input.relativePath);
  const now = nowIso();
  const requestedTargetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const targetAgentId = requestedTargetAgentId || defaultOnlineAgentIdForUser(input.user);
  if (input.user && !targetAgentId) return conflict("Desktop agent is not online.");
  if (input.user && requestedTargetAgentId && !onlineAgentForUser(requestedTargetAgentId, input.user)) {
    return conflict("Desktop agent is not online.");
  }

  const command = {
    id: crypto.randomUUID(),
    type: "import.list",
    ownerUser: normalizeOwnerUser(input.ownerUser || input.requestedBy),
    targetAgentId,
    payloadJson: JSON.stringify({
      rootId,
      path: importPath,
      requestedBy: String(input.requestedBy || "mobile").slice(0, 120)
    }),
    now
  };

  insertWorkspaceCommand.run(command);
  return getWorkspaceCommand(command.id);
}

export function createWorkspaceRegisterCommand(input = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const rootId = normalizeWorkspaceImportRootId(input.rootId);
  const importPath = normalizeWorkspaceImportPath(input.path || input.relativePath);
  const now = nowIso();
  const requestedTargetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const targetAgentId = requestedTargetAgentId || defaultOnlineAgentIdForUser(input.user);
  if (input.user && !targetAgentId) return conflict("Desktop agent is not online.");
  if (input.user && requestedTargetAgentId && !onlineAgentForUser(requestedTargetAgentId, input.user)) {
    return conflict("Desktop agent is not online.");
  }

  const command = {
    id: crypto.randomUUID(),
    type: "register",
    ownerUser: normalizeOwnerUser(input.ownerUser || input.requestedBy),
    targetAgentId,
    payloadJson: JSON.stringify({
      rootId,
      path: importPath,
      requestedBy: String(input.requestedBy || "mobile").slice(0, 120)
    }),
    now
  };

  insertWorkspaceCommand.run(command);
  return getWorkspaceCommand(command.id);
}

export function createMcpApplyCommand(input = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const profileId = normalizeMcpProfileId(input.profileId);
  if (!profileId) return badRequest("MCP profile is required.");

  const now = nowIso();
  const requestedTargetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const targetAgentId = requestedTargetAgentId || defaultOnlineAgentIdForUser(input.user);
  if (input.user && !targetAgentId) return conflict("Desktop agent is not online.");
  if (input.user && requestedTargetAgentId && !onlineAgentForUser(requestedTargetAgentId, input.user)) {
    return conflict("Desktop agent is not online.");
  }
  const requestedTargetClients = input.targetClients ?? input.targets;
  const targetClients = normalizeMcpTargetClients(
    requestedTargetClients,
    requestedTargetClients == null ? config.mcp.defaultTargets : []
  );
  if (targetClients.length === 0) return badRequest("At least one MCP target client is required.");

  const command = {
    id: crypto.randomUUID(),
    type: "mcp.apply",
    ownerUser: normalizeOwnerUser(input.ownerUser || input.requestedBy),
    targetAgentId,
    payloadJson: JSON.stringify({
      profileId,
      targetClients,
      restartDesktopAgent: input.restartDesktopAgent !== false,
      requestedBy: String(input.requestedBy || "mobile").slice(0, 120)
    }),
    now
  };

  insertWorkspaceCommand.run(command);
  return getWorkspaceCommand(command.id);
}

export function createAgentSkillCommand(input = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const type = normalizeAgentSkillCommandType(input.type || input.action);
  const now = nowIso();
  const requestedTargetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const targetAgentId = requestedTargetAgentId || defaultOnlineAgentIdForUser(input.user);
  if (input.user && !targetAgentId) return conflict("Desktop agent is not online.");
  const agent = targetAgentId ? onlineAgentForUser(targetAgentId, input.user) : null;
  if (input.user && requestedTargetAgentId && !agent) return conflict("Desktop agent is not online.");
  if (input.user && !agent) return conflict("Desktop agent is not online.");

  const registry = advertisedAgentSkillRegistry(agent);
  if (!registry.canManage) return conflict("Desktop agent has not advertised Agent Skill management.");

  const payload = {
    requestedBy: String(input.requestedBy || "mobile").slice(0, 120)
  };

  if (type !== "agent-skill.list" && type !== "agent-skill.import") {
    const skillId = normalizeAgentSkillId(input.skillId);
    if (!skillId) return badRequest("Agent skill is required.");
    if (!registry.skillIds.has(skillId)) return badRequest("Unknown agent skill.");
    payload.skillId = skillId;
  }

  if (type === "agent-skill.update") {
    if (hasOwn(input, "enabled")) payload.enabled = input.enabled === true;
    if (hasOwn(input, "showInComposer")) payload.showInComposer = input.showInComposer === true;
    if (hasOwn(input, "targetProviders")) {
      payload.targetProviders = normalizeAgentSkillTargetProviders(input.targetProviders, registry.providerIds);
      if (payload.targetProviders.length === 0 && input.enabled !== false) {
        return badRequest("At least one advertised backend is required.");
      }
    }
  }

  if (type === "agent-skill.import") {
    const sourceUrl = String(input.sourceUrl || input.url || "").trim().slice(0, 2000);
    if (!sourceUrl) return badRequest("GitHub Skill URL is required.");
    payload.sourceUrl = sourceUrl;
    payload.enabled = input.enabled !== false;
    payload.showInComposer = input.showInComposer !== false;
    if (hasOwn(input, "targetProviders")) {
      payload.targetProviders = normalizeAgentSkillTargetProviders(input.targetProviders, registry.providerIds);
      if (payload.targetProviders.length === 0 && payload.enabled !== false) {
        return badRequest("At least one advertised backend is required.");
      }
    }
  }

  const command = {
    id: crypto.randomUUID(),
    type,
    ownerUser: normalizeOwnerUser(input.ownerUser || input.requestedBy),
    targetAgentId,
    payloadJson: JSON.stringify(payload),
    now
  };

  insertWorkspaceCommand.run(command);
  return getWorkspaceCommand(command.id);
}

export function createDesktopPluginCommand(input = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const type = normalizeDesktopPluginCommandType(input.type || input.action);
  const now = nowIso();
  const requestedTargetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const targetAgentId = requestedTargetAgentId || defaultOnlineAgentIdForUser(input.user);
  if (input.user && !targetAgentId) return conflict("Desktop agent is not online.");
  const agent = targetAgentId ? onlineAgentForUser(targetAgentId, input.user) : null;
  if (input.user && !agent) return conflict("Desktop agent is not online.");

  const registry = advertisedDesktopPluginRegistry(agent);
  if (!registry.canManage) return conflict("Desktop agent has not advertised plugin management.");
  const payload = { requestedBy: String(input.requestedBy || "mobile").slice(0, 120) };

  if (type === "plugin.update") {
    const pluginId = normalizeDesktopPluginId(input.pluginId || input.id);
    if (!pluginId) return badRequest("Desktop plugin is required.");
    if (!registry.pluginIds.has(pluginId)) return badRequest("Unknown desktop plugin.");
    if (typeof input.enabled !== "boolean") return badRequest("Plugin enabled state is required.");
    const plugin = registry.plugins.get(pluginId);
    if (input.enabled) {
      const missingPlugin = plugin.requires.find((id) => !registry.enabledPluginIds.has(id));
      if (missingPlugin) return conflict(`Desktop plugin dependency is disabled: ${missingPlugin}.`);
      if (plugin.prerequisites.managedWorktree !== true) {
        return conflict("Desktop managed Worktree capability is unavailable.");
      }
    } else {
      const dependent = [...registry.plugins.values()].find(
        (item) => item.enabled && item.requires.includes(pluginId)
      );
      if (dependent) return conflict(`Disable dependent desktop plugin first: ${dependent.id}.`);
    }
    payload.pluginId = pluginId;
    payload.enabled = input.enabled;
  }

  const command = {
    id: crypto.randomUUID(),
    type,
    ownerUser: normalizeOwnerUser(input.ownerUser || input.requestedBy),
    targetAgentId,
    payloadJson: JSON.stringify(payload),
    now
  };
  insertWorkspaceCommand.run(command);
  return getWorkspaceCommand(command.id);
}

export function updateWorkspaceVisibility(input = {}) {
  const workspaceId = String(input.workspaceId || input.projectId || "").trim().slice(0, 160);
  if (!workspaceId) return badRequest("Workspace is required.");

  const targetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const ownerUser = workspaceVisibilityOwner(input);
  if (!ownerUser) return badRequest("User is required.");

  const visibleInSidebar = input.visible === false || input.visibleInSidebar === false ? 0 : 1;
  const now = nowIso();
  const projectKey = workspaceKey(targetAgentId, workspaceId);
  upsertWorkspaceVisibility.run({
    ownerUser,
    projectKey,
    workspaceId,
    targetAgentId,
    visibleInSidebar,
    hiddenAt: visibleInSidebar ? "" : now,
    source: String(input.source || (visibleInSidebar ? "shown" : "mobile-hidden")).slice(0, 80),
    now
  });

  return getWorkspaceVisibility({ ownerUser, projectKey });
}

export function getWorkspaceCommand(id, options = {}) {
  reclaimExpiredWorkspaceCommandLeases();
  const row = db.prepare(`
    SELECT ${summarizeWorkspaceCommandColumns}
    FROM codex_workspace_commands
    WHERE id = ?
  `).get(id);
  const command = row ? summarizeWorkspaceCommand(row) : null;
  if (command && !canAccessOwner(options.user, command.ownerUser)) return null;
  return command;
}

export function acquireNextWorkspaceCommand({ agentId } = {}) {
  reclaimExpiredWorkspaceCommandLeases();

  const leaseHolder = normalizeAgentId(agentId);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();

  const acquire = db.transaction(() => {
    const command = db.prepare(`
      SELECT ${summarizeWorkspaceCommandColumns}
      FROM codex_workspace_commands
      WHERE status = 'queued'
        AND (target_agent_id = '' OR target_agent_id = @leaseHolder)
      ORDER BY created_at ASC
      LIMIT 1
    `).get({ leaseHolder });

    if (!command) return null;

    db.prepare(`
      UPDATE codex_workspace_commands
      SET status = 'leased',
          leased_by = @leasedBy,
          lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE id = @id
        AND status = 'queued'
    `).run({
      id: command.id,
      leasedBy: leaseHolder,
      leaseExpiresAt,
      now
    });

    return getWorkspaceCommand(command.id);
  });

  return acquire();
}

export function completeWorkspaceCommand(commandId, result = {}, options = {}) {
  const command = getWorkspaceCommand(commandId);
  if (!command) return false;
  const providedAgentId = normalizeAgentId(options.agentId);
  if (command.status !== "leased" || command.leasedBy !== providedAgentId) return false;

  const now = nowIso();
  const ok = result.ok === true;
  const error = String(result.error || "").slice(0, 12000);
  db.prepare(`
    UPDATE codex_workspace_commands
    SET status = @status,
        result_json = @resultJson,
        error = @error,
        leased_by = NULL,
        lease_expires_at = NULL,
        updated_at = @now
    WHERE id = @commandId
      AND status = 'leased'
      AND leased_by = @leasedBy
  `).run({
    commandId,
    status: ok ? "done" : "failed",
    resultJson: JSON.stringify(result || {}).slice(0, 30000),
    error,
    now,
    leasedBy: providedAgentId
  });

  return true;
}

export function createFileRequest(input = {}) {
  expireFileRequests();

  const type = normalizeFileRequestType(input.type);
  const projectId = normalizeFileRequestProjectId(input.projectId);
  const ownerUser = normalizeOwnerUser(input.ownerUser || input.requestedBy);
  const targetAgentId = normalizeTargetAgentId(input.targetAgentId);
  const requestPath = type === "open-spec-summary" || type === "orchestration-plan" ? "" : normalizeFileRequestPath(input.path);
  const workspace = onlineWorkspaceForProject(projectId, { targetAgentId, user: input.user });
  if (workspace?.ambiguous) return conflict("Multiple desktop environments expose this workspace. Choose an environment before browsing files.");
  if (!workspace) return conflict("Desktop agent is not online for this workspace.");
  if (type === "open-spec-summary" || type === "orchestration-plan") {
    const agent = onlineAgentForUser(workspace.agentId, input.user);
    const plugins = advertisedDesktopPluginRegistry(agent);
    if (!plugins.enabledPluginIds.has("open-spec")) {
      return conflict("OpenSpec plugin is disabled or unavailable on the desktop agent.");
    }
    if (type === "orchestration-plan" && !plugins.enabledPluginIds.has("orchestration")) {
      return conflict("Orchestration plugin is disabled or unavailable on the desktop agent.");
    }
  }

  const payload = normalizeFileRequestPayload(type, input);
  const now = nowIso();
  const request = {
    id: crypto.randomUUID(),
    type,
    projectId,
    ownerUser,
    targetAgentId: targetAgentId || workspace.agentId || "",
    path: requestPath,
    payloadJson: JSON.stringify(payload),
    now,
    expiresAt: new Date(Date.now() + fileRequestTtlMs).toISOString(),
    requestedBy: String(input.requestedBy || "mobile").slice(0, 120)
  };

  insertFileRequest.run(request);
  return getFileRequest(request.id);
}

export function getFileRequest(id) {
  expireFileRequests();
  const row = db.prepare(`
    SELECT ${summarizeFileRequestColumns}
    FROM codex_file_requests
    WHERE id = ?
  `).get(id);
  return row ? summarizeFileRequest(row) : null;
}

export function acquireNextFileRequest({ agentId, workspaces = [] } = {}) {
  expireFileRequests();

  const workspaceIds = workspaces.map((workspace) => String(workspace?.id || "").trim()).filter(Boolean);
  if (workspaceIds.length === 0) return null;

  const leaseHolder = normalizeAgentId(agentId);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const placeholders = workspaceIds.map(() => "?").join(",");

  const acquire = db.transaction(() => {
    const request = db.prepare(`
      SELECT ${summarizeFileRequestColumns}
      FROM codex_file_requests
      WHERE status = 'queued'
        AND expires_at > ?
        AND project_id IN (${placeholders})
        AND (target_agent_id = '' OR target_agent_id = ?)
      ORDER BY created_at ASC
      LIMIT 1
    `).get(now, ...workspaceIds, leaseHolder);

    if (!request) return null;

    db.prepare(`
      UPDATE codex_file_requests
      SET status = 'leased',
          leased_by = @leasedBy,
          lease_expires_at = @leaseExpiresAt,
          updated_at = @now
      WHERE id = @id
        AND status = 'queued'
        AND expires_at > @now
    `).run({
      id: request.id,
      leasedBy: leaseHolder,
      leaseExpiresAt,
      now
    });

    return getFileRequest(request.id);
  });

  return acquire();
}

export function completeFileRequest(requestId, result = {}, options = {}) {
  const request = getFileRequest(requestId);
  if (!request) return false;
  const providedAgentId = normalizeAgentId(options.agentId);
  if (request.status !== "leased" || request.leasedBy !== providedAgentId) return false;

  const now = nowIso();
  const ok = result.ok === true;
  const error = String(result.error || "").slice(0, 12000);
  const resultJson = JSON.stringify(result || {}).slice(0, maxStoredFileRequestResultBytes);
  db.prepare(`
    UPDATE codex_file_requests
    SET status = @status,
        result_json = @resultJson,
        error = @error,
        leased_by = NULL,
        lease_expires_at = NULL,
        updated_at = @now
    WHERE id = @requestId
      AND status = 'leased'
      AND leased_by = @leasedBy
  `).run({
    requestId,
    status: ok ? "done" : "failed",
    resultJson,
    error,
    now,
    leasedBy: providedAgentId
  });

  return true;
}

export function recoverLostRunningSessionsForAgent({
  agentId,
  agentInstanceId = "",
  busySessionIds = [],
  runningSessionIds = [],
  sessionActivitySnapshotAt = ""
} = {}) {
  refreshInteractiveSessionState();

  const leaseHolder = normalizeAgentId(agentId);
  const activeAgentInstanceId = normalizeAgentInstanceId(agentInstanceId);
  const activeSessionIds = new Set([...normalizeIdSet(busySessionIds), ...normalizeIdSet(runningSessionIds)]);
  const snapshotAtMs = parseIsoMs(sessionActivitySnapshotAt);
  const nowMs = Date.now();
  const recoveryCutoffMs = Math.min(
    snapshotAtMs === null ? nowMs : snapshotAtMs,
    nowMs - runningSessionRecoveryGraceMs
  );
  const candidates = db.prepare(`
    SELECT
      id,
      status,
      app_thread_id AS appThreadId,
      active_turn_id AS activeTurnId,
      leased_by AS leasedBy,
      leased_instance_id AS leasedInstanceId,
      updated_at AS updatedAt
    FROM codex_sessions
    WHERE leased_by = @leaseHolder
      AND lease_expires_at IS NOT NULL
      AND status IN ('starting', 'running')
      AND (
        TRIM(COALESCE(active_turn_id, '')) <> ''
        OR ${sessionHasRecoverableDesktopWorkSql("@leaseHolder")}
      )
    ORDER BY updated_at ASC
  `).all({ leaseHolder });
  const lostSessions = candidates.filter((session) => {
    if (activeSessionIds.has(session.id)) return false;
    if (activeAgentInstanceId && session.leasedInstanceId === activeAgentInstanceId) return false;
    const sessionUpdatedAtMs = parseIsoMs(session.updatedAt);
    return sessionUpdatedAtMs !== null && sessionUpdatedAtMs <= recoveryCutoffMs;
  });
  if (lostSessions.length === 0) return [];

  const now = nowIso();
  const recoveryError = "Desktop agent restarted before this turn reported completion; you can continue the same conversation.";
  const recover = db.transaction((sessions) => {
    const recoveredSessionIds = [];
    for (const session of sessions) {
      const commands = db.prepare(`
        SELECT id, type
        FROM codex_session_commands
        WHERE session_id = @sessionId
          AND status IN ('leased', 'reconciling')
          AND leased_by = @leaseHolder
        ORDER BY created_at ASC
      `).all({ sessionId: session.id, leaseHolder });
      const hasQueuedContinuation = sessionHasQueuedContinuationCommand(session.id);
      const recoveryLastError = hasQueuedContinuation ? "" : recoveryError;

      db.prepare(`
        UPDATE codex_session_commands
        SET status = 'failed',
            error = @error,
            leased_by = NULL,
            leased_instance_id = '',
            lease_expires_at = NULL,
            updated_at = @now
        WHERE session_id = @sessionId
          AND status IN ('leased', 'reconciling')
          AND leased_by = @leaseHolder
      `).run({
        sessionId: session.id,
        leaseHolder,
        error: recoveryError,
        now
      });

      denyPendingSessionApprovals(session.id, now, "agent-recovered");
      cancelPendingSessionInteractions(session.id, now, "agent-recovered");

      const updated = db.prepare(`
        UPDATE codex_sessions
        SET status = 'active',
            active_turn_id = NULL,
            leased_by = NULL,
            leased_instance_id = '',
            lease_expires_at = NULL,
            last_error = @lastError,
            updated_at = @now
        WHERE id = @sessionId
          AND leased_by = @leaseHolder
          AND status IN ('starting', 'running')
      `).run({
        sessionId: session.id,
        leaseHolder,
        lastError: recoveryLastError,
        now
      });
      if (updated.changes === 0) continue;

      insertSessionEvent.run(
        normalizeSessionEvent(session.id, {
          type: "session.agent.recovered",
          text: `Desktop agent ${leaseHolder} reconnected without this running turn; the conversation is ready to continue.`,
          raw: {
            source: "relay",
            agentId: leaseHolder,
            activeAgentInstanceId,
            recoveredLeaseInstanceId: session.leasedInstanceId || "",
            interruptedCommandIds: commands.map((command) => command.id),
            interruptedCommandTypes: commands.map((command) => command.type)
          }
        }, now)
      );
      recoveredSessionIds.push(session.id);
    }
    return recoveredSessionIds;
  });

  return recover(lostSessions);
}

export function acquireNextSessionCommand({
  agentId,
  agentInstanceId = "",
  workspaces = [],
  busySessionIds = [],
  busyProjectIds = [],
  runningSessionIds = [],
  commandTypes = []
} = {}) {
  refreshInteractiveSessionState();

  const workspaceIds = workspaces.map((workspace) => workspace.id).filter(Boolean);
  if (workspaceIds.length === 0) return null;

  const leaseHolder = normalizeAgentId(agentId);
  const leasedInstanceId = normalizeAgentInstanceId(agentInstanceId);
  const blockedSessionIds = normalizeIdSet(busySessionIds);
  const blockedProjectIds = normalizeIdSet(busyProjectIds);
  const activeRunningSessionIds = normalizeIdSet(runningSessionIds);
  const allowedCommandTypes = normalizeSessionCommandTypes(commandTypes);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const placeholders = workspaceIds.map(() => "?").join(",");
  const typePlaceholders = allowedCommandTypes.map(() => "?").join(",");
  const typeFilter = allowedCommandTypes.length > 0 ? `AND c.type IN (${typePlaceholders})` : "";

  const acquire = db.transaction(() => {
    const candidates = db.prepare(`
      SELECT
        c.id,
        c.session_id AS sessionId,
        c.type,
        c.payload_json AS payloadJson,
        c.status,
        c.created_at AS createdAt,
        c.updated_at AS updatedAt,
        c.leased_by AS leasedBy,
        c.attempt,
        c.lease_expires_at AS leaseExpiresAt,
        c.error,
        s.project_id AS projectId,
        s.app_thread_id AS appThreadId,
        s.active_turn_id AS activeTurnId,
        s.runtime_json AS runtimeJson,
        s.execution_json AS executionJson,
        s.memory_json AS memoryJson,
        s.target_agent_id AS targetAgentId
      FROM codex_session_commands c
      JOIN codex_sessions s ON s.id = c.session_id
      WHERE c.status = 'queued'
        AND (c.available_at = '' OR c.available_at <= ?)
        ${typeFilter}
        AND s.status NOT IN ('closed', 'failed', 'cancelled', 'stale')
        AND s.project_id IN (${placeholders})
        AND (s.target_agent_id = '' OR s.target_agent_id = ?)
        AND (
          c.type <> 'stop'
          OR s.leased_by IS NULL
          OR s.leased_by = ?
        )
        AND (
          c.type = 'stop'
          OR NOT EXISTS (
            SELECT 1
            FROM codex_session_commands leased
            WHERE leased.session_id = c.session_id
              AND leased.status IN ('leased', 'reconciling')
          )
        )
      ORDER BY CASE WHEN c.type = 'stop' THEN 0 ELSE 1 END, c.created_at ASC
      LIMIT 50
    `).all(now, ...allowedCommandTypes, ...workspaceIds, leaseHolder, leaseHolder);

    for (const command of candidates) {
      const agentRuntime = runtimeForAgentAndProject(leaseHolder, command.projectId);
      const runtime = resolveRuntimeForAgent(parseJson(command.runtimeJson, {}), agentRuntime);
      if (
        shouldSkipSessionCommandForBusyDesktop(command, runtime, {
          blockedSessionIds,
          blockedProjectIds,
          activeRunningSessionIds
        })
      ) {
        continue;
      }

      const runtimeJson = JSON.stringify(runtime);

      const leased = db.prepare(`
        UPDATE codex_session_commands
        SET status = 'leased',
            leased_by = @leasedBy,
            leased_instance_id = @leasedInstanceId,
            lease_expires_at = @leaseExpiresAt,
            updated_at = @now
        WHERE id = @id
          AND status = 'queued'
          AND (
            @isStop = 1
            OR NOT EXISTS (
              SELECT 1
              FROM codex_session_commands active
              WHERE active.session_id = @sessionId
                AND active.status IN ('leased', 'reconciling')
            )
          )
      `).run({
        id: command.id,
        sessionId: command.sessionId,
        isStop: command.type === "stop" ? 1 : 0,
        leasedBy: leaseHolder,
        leasedInstanceId,
        leaseExpiresAt,
        now
      });
      if (leased.changes === 0) continue;

      db.prepare(`
        UPDATE codex_sessions
        SET runtime_json = @runtimeJson,
            execution_json = @executionJson
        WHERE id = @sessionId
      `).run({
        sessionId: command.sessionId,
        runtimeJson,
        executionJson: command.executionJson || "{}"
      });

      command.runtimeJson = runtimeJson;

      db.prepare(`
        UPDATE codex_sessions
        SET status = @status,
            leased_by = @leasedBy,
            leased_instance_id = @leasedInstanceId,
            lease_expires_at = @leaseExpiresAt,
            last_error = CASE WHEN @clearLastError = 1 THEN '' ELSE last_error END,
            updated_at = @now
        WHERE id = @sessionId
      `).run({
        sessionId: command.sessionId,
        status: command.type === "start" ? "starting" : "running",
        leasedBy: leaseHolder,
        leasedInstanceId,
        leaseExpiresAt,
        clearLastError: command.type === "start" ? 0 : 1,
        now
      });

      insertSessionEvent.run(
        normalizeSessionEvent(command.sessionId, {
          type: "command.acquired",
          text: `Desktop agent ${leaseHolder} acquired ${command.type}.`
        }, now)
      );

      return buildAgentSessionCommand(command);
    }

    return null;
  });

  return acquire();
}

export function listSessionCommandReconciliations({ agentId } = {}) {
  refreshInteractiveSessionState();
  const leasedBy = normalizeAgentId(agentId);
  if (!leasedBy) return [];
  return db.prepare(`
    SELECT id AS commandId, session_id AS sessionId, type, attempt,
      leased_instance_id AS leasedInstanceId, lease_expires_at AS reconcileBy
    FROM codex_session_commands
    WHERE status = 'reconciling' AND leased_by = ?
    ORDER BY updated_at ASC
    LIMIT 100
  `).all(leasedBy);
}

export function reconcileSessionCommands({ agentId, agentInstanceId = "", states = [] } = {}) {
  refreshInteractiveSessionState();
  const leasedBy = normalizeAgentId(agentId);
  const nextInstanceId = normalizeAgentInstanceId(agentInstanceId);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const outcomes = [];

  const reconcile = db.transaction(() => {
    for (const state of (Array.isArray(states) ? states : []).slice(0, 100)) {
      const commandId = String(state?.commandId || state?.id || "").trim();
      const attempt = Number(state?.attempt);
      const localState = String(state?.state || "unknown").trim().toLowerCase();
      const command = getSessionCommandSummary(commandId);
      if (
        !command ||
        command.status !== "reconciling" ||
        command.leasedBy !== leasedBy ||
        !Number.isInteger(attempt) ||
        attempt !== command.attempt
      ) {
        outcomes.push({ commandId, attempt, outcome: "rejected" });
        continue;
      }

      if (localState === "running") {
        db.prepare(`
          UPDATE codex_session_commands
          SET status = 'leased', leased_instance_id = @instanceId,
              lease_expires_at = @leaseExpiresAt, updated_at = @now
          WHERE id = @commandId AND status = 'reconciling'
        `).run({ commandId, instanceId: nextInstanceId, leaseExpiresAt, now });
        db.prepare(`
          UPDATE codex_sessions
          SET leased_by = @leasedBy, leased_instance_id = @instanceId,
              lease_expires_at = @leaseExpiresAt, updated_at = @now
          WHERE id = @sessionId
        `).run({ sessionId: command.sessionId, leasedBy, instanceId: nextInstanceId, leaseExpiresAt, now });
        insertSessionEvent.run(normalizeSessionEvent(command.sessionId, {
          type: "command.reconciliation.running",
          text: `Desktop agent ${leasedBy} confirmed ${command.type} is still running.`,
          raw: { source: "relay", commandId, attempt, outcome: "running" }
        }, now));
        outcomes.push({ commandId, attempt, outcome: "running" });
        continue;
      }

      if (localState === "not_started") {
        db.prepare(`
          UPDATE codex_session_commands
          SET status = 'queued', attempt = attempt + 1, leased_by = NULL,
              leased_instance_id = '', lease_expires_at = NULL, updated_at = @now
          WHERE id = @commandId AND status = 'reconciling'
        `).run({ commandId, now });
        db.prepare(`
          UPDATE codex_sessions
          SET status = @status, leased_by = NULL, leased_instance_id = '',
              lease_expires_at = NULL, updated_at = @now
          WHERE id = @sessionId
        `).run({ sessionId: command.sessionId, status: command.type === "start" ? "queued" : "active", now });
        insertSessionEvent.run(normalizeSessionEvent(command.sessionId, {
          type: "command.reconciliation.requeued",
          text: `Desktop agent ${leasedBy} confirmed ${command.type} never started; Relay returned it to the queue.`,
          raw: { source: "relay", commandId, attempt, nextAttempt: attempt + 1, outcome: "not_started" }
        }, now));
        outcomes.push({ commandId, attempt, outcome: "requeued", nextAttempt: attempt + 1 });
        continue;
      }

      const error = `Desktop agent ${leasedBy} could not confirm the expired ${command.type} command state.`;
      db.prepare(`
        UPDATE codex_session_commands
        SET status = 'failed', error = @error, result_json = @resultJson,
            completed_by = @completedBy, leased_by = NULL, leased_instance_id = '',
            lease_expires_at = NULL, updated_at = @now
        WHERE id = @commandId AND status = 'reconciling'
      `).run({
        commandId,
        error,
        resultJson: JSON.stringify({ ok: false, error, reconciliation: localState || "unknown" }),
        completedBy: leasedBy,
        now
      });
      db.prepare(`
        UPDATE codex_sessions
        SET status = 'failed', active_turn_id = NULL, last_error = @error,
            leased_by = NULL, leased_instance_id = '', lease_expires_at = NULL, updated_at = @now
        WHERE id = @sessionId
      `).run({ sessionId: command.sessionId, error, now });
      denyPendingSessionApprovals(command.sessionId, now, "agent-reconciliation");
      cancelPendingSessionInteractions(command.sessionId, now, "agent-reconciliation");
      insertSessionEvent.run(normalizeSessionEvent(command.sessionId, {
        type: "command.reconciliation.failed",
        text: error,
        raw: { source: "relay", commandId, attempt, outcome: localState || "unknown" }
      }, now));
      outcomes.push({ commandId, attempt, outcome: "failed" });
    }
  });
  reconcile();
  return outcomes;
}

export function appendSessionEvents(sessionId, incomingEvents = [], options = {}) {
  const session = getSessionSummary(sessionId);
  if (!session) return false;

  const protocolRefs = sessionEventProtocolRefs(incomingEvents, options);
  const protocolAuthorized = protocolRefs.length > 0 && protocolRefs.every((ref) =>
    canReportSessionCommand(ref.commandId, ref.attempt, sessionId, options.agentId, options.agentInstanceId)
  );
  if (protocolRefs.length > 0 && !protocolAuthorized) return false;
  if (protocolRefs.length === 0 && !canMutateSessionLease(session, options.agentId, options.agentInstanceId)) return false;

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const baseIncomingEvents = incomingEvents.slice(0, 80).filter((event) => {
    const eventKey = protocolSessionEventKey(event);
    if (!eventKey) return true;
    return !db.prepare(`
      SELECT 1
      FROM codex_session_events
      WHERE session_id = ? AND event_key = ?
    `).get(sessionId, eventKey);
  });
  const events = [];
  const storedIncomingEvents = [];
  const eventsForMemory = [];
  for (const event of baseIncomingEvents) {
    const normalized = normalizeSessionEventForStorage(sessionId, event, now);
    events.push(normalized);
    const storedRaw = parseJson(normalized.row.rawJson, {});
    const storedEvent = {
      ...event,
      at: normalized.row.at,
      text: normalized.row.text,
      finalMessage:
        storedRaw?.params?.item?.type === "agentMessage"
          ? String(storedRaw.params.item.text || normalized.row.text || "")
          : event.finalMessage && String(event.finalMessage) === String(event.text || "")
            ? normalized.row.text
            : event.finalMessage,
      raw: storedRaw
    };
    storedIncomingEvents.push(storedEvent);
    eventsForMemory.push(storedEvent);
    const testSummary = testSummaryFromEvent(storedEvent);
    if (testSummary) {
      const testEvent = {
        at: storedEvent.at,
        type: "test.summary",
        text: formatTestSummaryEventText(testSummary),
        raw: {
          source: "relay",
          method: "test.summary",
          testSummary
        }
      };
      eventsForMemory.push(testEvent);
      events.push(normalizeSessionEventForStorage(sessionId, testEvent, now));
    }
  }
  const update = deriveSessionUpdate(storedIncomingEvents, session);
  const nextExecution = deriveSessionExecutionUpdate(storedIncomingEvents, session.execution);
  const hasLeasedCommand = sessionHasLeasedCommand(sessionId);
  const providedAgentInstanceId = normalizeAgentInstanceId(options.agentInstanceId);
  const retryPlan = hasLeasedCommand
    ? null
    : buildSessionEventRetryPlan({
        session,
        update,
        agentId: options.agentId || options.agent?.id || session.leasedBy,
        now
      });
  const releaseLease = retryPlan || (update.releaseLease && !hasLeasedCommand);
  const assistantMessages = buildAssistantMessages(sessionId, storedIncomingEvents, now);
  const resolvedServerRequests = serverRequestResolutionsFromEvents(storedIncomingEvents);
  const nextMemory = shouldRefreshSessionMemory(eventsForMemory) ? buildSessionMemory(sessionId, session, eventsForMemory, now) : null;
  ensureOwnerStorageQuota(session.ownerUser, artifactBytes(events.flatMap((event) => event.artifacts || [])));

  const write = db.transaction(() => {
    db.prepare(`
      UPDATE codex_sessions
      SET leased_by = CASE WHEN @releaseLease = 1 THEN NULL ELSE leased_by END,
          leased_instance_id = CASE
            WHEN @releaseLease = 1 THEN ''
            WHEN @agentInstanceId <> '' AND leased_instance_id = '' THEN @agentInstanceId
            ELSE leased_instance_id
          END,
          lease_expires_at = CASE WHEN @releaseLease = 1 THEN NULL ELSE @leaseExpiresAt END,
          updated_at = @now,
          status = COALESCE(@retryStatus, @status, status),
          app_thread_id = COALESCE(@appThreadId, app_thread_id),
          active_turn_id = CASE WHEN @clearActiveTurnId = 1 OR @retryStatus IS NOT NULL THEN NULL ELSE COALESCE(@activeTurnId, active_turn_id) END,
          last_error = COALESCE(@retryLastError, @lastError, last_error),
          final_message = COALESCE(@finalMessage, final_message),
          execution_json = COALESCE(@executionJson, execution_json),
          memory_json = COALESCE(@memoryJson, memory_json)
      WHERE id = @sessionId
        AND leased_by = @leasedBy
    `).run({
      sessionId,
      now,
      leaseExpiresAt,
      leasedBy: session.leasedBy,
      agentInstanceId: providedAgentInstanceId,
      retryStatus: retryPlan ? "queued" : null,
      status: update.status,
      appThreadId: update.appThreadId,
      activeTurnId: update.activeTurnId,
      clearActiveTurnId: update.clearActiveTurnId ? 1 : 0,
      releaseLease: releaseLease ? 1 : 0,
      lastError: update.lastError,
      retryLastError: retryPlan?.lastError || null,
      finalMessage: update.finalMessage,
      executionJson: nextExecution ? JSON.stringify(nextExecution) : null,
      memoryJson: nextMemory ? JSON.stringify(nextMemory).slice(0, 30000) : null
    });

    if (retryPlan) {
      db.prepare(`
        UPDATE codex_session_commands
        SET status = 'queued',
            payload_json = @payloadJson,
            error = @error,
            available_at = @availableAt,
            updated_at = @now,
            leased_by = NULL,
            leased_instance_id = '',
            lease_expires_at = NULL
        WHERE id = @commandId
          AND status IN ('done', 'failed')
      `).run({
        commandId: retryPlan.command.id,
        payloadJson: JSON.stringify(retryPlan.payload),
        error: retryPlan.error,
        availableAt: retryPlan.availableAt,
        now
      });
    }

    for (const event of events) {
      const inserted = insertSessionEvent.run(event.row);
      for (const artifact of event.artifacts) {
        persistSessionArtifact({
          ...artifact,
          sessionId,
          eventId: Number(inserted.lastInsertRowid),
          createdAt: event.row.at
        });
      }
    }
    for (const resolution of resolvedServerRequests) {
      resolvePendingServerRequest(sessionId, resolution.requestId, now);
    }
    for (const message of assistantMessages) {
      insertSessionMessageIgnore.run(message);
    }
    if (retryPlan) {
      insertSessionEvent.run(
        normalizeSessionEvent(sessionId, {
          type: "command.retry.scheduled",
          text: retryPlan.text,
          raw: {
            source: "relay",
            commandId: retryPlan.command.id,
            commandType: retryPlan.command.type,
            attempt: retryPlan.attempt,
            maxAttempts: retryPlan.maxAttempts,
            availableAt: retryPlan.availableAt,
            delayMs: retryPlan.delayMs,
            error: retryPlan.error,
            model: retryPlan.runtimeOverride.model,
            reasoningEffort: retryPlan.runtimeOverride.reasoningEffort,
            downgradedReasoning: retryPlan.downgradedReasoning
          }
        }, now)
      );
    }
    touchSessionCommandLeasesForAgent(sessionId, session.leasedBy, { now, leaseExpiresAt, agentInstanceId: providedAgentInstanceId });
    trimSessionEvents.run(sessionId, sessionId, config.codex.maxEvents);
    return true;
  });

  return write();
}

export function completeSessionCommand(commandId, result = {}, options = {}) {
  const command = getSessionCommandSummary(commandId);
  if (!command) return false;
  const providedAgentId = normalizeAgentId(options.agentId);
  const providedAttempt = options.attempt === undefined
    ? command.attempt
    : Number(options.attempt);
  if (!Number.isInteger(providedAttempt) || providedAttempt !== command.attempt) return false;
  const resultJson = JSON.stringify(result || {}).slice(0, 120000);
  if (["done", "failed"].includes(command.status)) {
    return command.completedBy === providedAgentId && command.resultJson === resultJson;
  }
  if (!["leased", "reconciling"].includes(command.status) || command.leasedBy !== providedAgentId) return false;
  const providedAgentInstanceId = normalizeAgentInstanceId(options.agentInstanceId);
  if (providedAgentInstanceId && command.leasedInstanceId && command.leasedInstanceId !== providedAgentInstanceId) return false;

  const session = getSessionSummary(command.sessionId);
  if (!session || !canMutateSessionLease(session, providedAgentId, providedAgentInstanceId)) return false;

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const ok = result.ok === true;
  const error = String(result.error || "");
  const status = ok ? "done" : "failed";
  const resultSessionStatus = ok
    ? result.sessionStatus || (result.activeTurnId ? "running" : "active")
    : command.type === "compact"
      ? "active"
      : "failed";
  const completedAsyncWork =
    ok && resultSessionStatus === "running"
      ? sessionCompletedAsyncWorkSince(command.sessionId, command.updatedAt, result.activeTurnId, command.type, result.appThreadId || session.appThreadId)
      : null;
  const sessionStatus = completedAsyncWork ? completedAsyncWork.status : resultSessionStatus;
  const activeTurnId = completedAsyncWork ? null : result.activeTurnId || null;
  const clearActiveTurnId = sessionStatus !== "running";
  const releaseLease = sessionStatus !== "running";
  const lastError =
    completedAsyncWork?.status === "failed"
      ? String(session.lastError || completedAsyncWork.error || error).slice(0, 12000)
      : error;
  const completedExecution = completedSessionExecution(session.execution, result.execution);
  const executionJson = completedExecution ? JSON.stringify(completedExecution) : null;
  const retryPlan = buildSessionCommandRetryPlan({
    command,
    session,
    result,
    agentId: providedAgentId,
    error: lastError || error,
    now
  });

  if (retryPlan) {
    const scheduleRetry = db.transaction(() => {
      const update = db.prepare(`
        UPDATE codex_session_commands
        SET status = 'queued',
            attempt = attempt + 1,
            payload_json = @payloadJson,
            error = @error,
            available_at = @availableAt,
            updated_at = @now,
            leased_by = NULL,
            leased_instance_id = '',
            lease_expires_at = NULL,
            result_json = '',
            completed_by = ''
          WHERE id = @commandId
            AND status IN ('leased', 'reconciling')
            AND leased_by = @leasedBy
      `).run({
        commandId,
        payloadJson: JSON.stringify(retryPlan.payload),
        error: retryPlan.error,
        availableAt: retryPlan.availableAt,
        now,
        leasedBy: providedAgentId
      });

      if (update.changes === 0) return false;

      db.prepare(`
        UPDATE codex_sessions
        SET status = 'queued',
            app_thread_id = COALESCE(@appThreadId, app_thread_id),
            active_turn_id = NULL,
            last_error = @lastError,
            execution_json = COALESCE(@executionJson, execution_json),
            leased_by = NULL,
            leased_instance_id = '',
            lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @sessionId
          AND leased_by = @leasedBy
      `).run({
        sessionId: command.sessionId,
        appThreadId: result.appThreadId || null,
        lastError: retryPlan.lastError,
        executionJson,
        now,
        leasedBy: providedAgentId
      });

      insertSessionEvent.run(
        normalizeSessionEvent(command.sessionId, {
          type: "command.retry.scheduled",
          text: retryPlan.text,
          raw: {
            source: "relay",
            commandId,
            commandType: command.type,
            attempt: retryPlan.attempt,
            maxAttempts: retryPlan.maxAttempts,
            availableAt: retryPlan.availableAt,
            delayMs: retryPlan.delayMs,
            error: retryPlan.error,
            model: retryPlan.runtimeOverride.model,
            reasoningEffort: retryPlan.runtimeOverride.reasoningEffort,
            downgradedReasoning: retryPlan.downgradedReasoning
          }
        }, now)
      );
      return true;
    });

    if (!scheduleRetry()) return false;
    trimOldSessions();
    return true;
  }

  const complete = db.transaction(() => {
    db.prepare(`
      UPDATE codex_session_commands
      SET status = @status,
          error = @error,
          result_json = @resultJson,
          completed_by = @completedBy,
          updated_at = @now,
          leased_by = NULL,
          leased_instance_id = '',
          lease_expires_at = NULL
      WHERE id = @commandId
        AND status IN ('leased', 'reconciling')
        AND leased_by = @leasedBy
    `).run({
      commandId,
      status,
      error,
      resultJson,
      completedBy: providedAgentId,
      now,
      leasedBy: providedAgentId
    });

  if (command.type === "stop" && ok) {
    db.prepare(`
      UPDATE codex_session_commands
      SET status = 'failed',
          error = CASE WHEN COALESCE(error, '') = '' THEN @error ELSE error END,
          leased_by = NULL,
          leased_instance_id = '',
          lease_expires_at = NULL,
          updated_at = @now
        WHERE session_id = @sessionId
          AND id <> @commandId
          AND status IN ('leased', 'reconciling')
          AND leased_by = @leasedBy
      `).run({
        sessionId: command.sessionId,
        commandId,
        leasedBy: providedAgentId,
        error: error || command.payload?.reason || "Interrupted by mobile cancellation.",
        now
      });
    }

    db.prepare(`
      UPDATE codex_sessions
      SET status = @sessionStatus,
          app_thread_id = COALESCE(@appThreadId, app_thread_id),
          active_turn_id = CASE WHEN @clearActiveTurnId = 1 THEN NULL ELSE COALESCE(@activeTurnId, active_turn_id) END,
          last_error = @lastError,
          final_message = COALESCE(@finalMessage, final_message),
            execution_json = COALESCE(@executionJson, execution_json),
            leased_by = CASE WHEN @releaseLease = 1 THEN NULL ELSE leased_by END,
            leased_instance_id = CASE
              WHEN @releaseLease = 1 THEN ''
              WHEN @agentInstanceId <> '' AND leased_instance_id = '' THEN @agentInstanceId
              ELSE leased_instance_id
            END,
            lease_expires_at = CASE WHEN @releaseLease = 1 THEN NULL ELSE @leaseExpiresAt END,
          updated_at = @now
      WHERE id = @sessionId
        AND leased_by = @leasedBy
    `).run({
      sessionId: command.sessionId,
      sessionStatus,
      appThreadId: result.appThreadId || null,
      activeTurnId,
      clearActiveTurnId: clearActiveTurnId ? 1 : 0,
      releaseLease: releaseLease ? 1 : 0,
      agentInstanceId: providedAgentInstanceId,
      leaseExpiresAt,
      lastError,
      finalMessage: result.finalMessage || null,
      executionJson,
      now,
      leasedBy: providedAgentId
    });

    insertSessionEvent.run(
      normalizeSessionEvent(command.sessionId, {
        type: ok ? "command.completed" : "command.failed",
        text: ok ? `${command.type} accepted by backend.` : error || `${command.type} failed.`
      }, now)
    );
  });

  complete();
  trimOldSessions();
  return true;
}

export function createSessionApproval(input = {}, options = {}) {
  const session = getSessionSummary(input.sessionId);
  if (!session) return notFound("Session not found.");
  if (!canMutateSessionLease(session, options.agentId, options.agentInstanceId)) return false;

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const approval = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    appRequestId: String(input.appRequestId || ""),
    method: String(input.method || ""),
    prompt: String(input.prompt || "").slice(0, 12000),
    payloadJson: JSON.stringify(input.payload || {}).slice(0, 30000),
    requestedBy: normalizeAgentId(options.agentId),
    now
  };

  const create = db.transaction(() => {
    touchSessionLeaseForAgent(approval.sessionId, approval.requestedBy, {
      now,
      leaseExpiresAt,
      agentInstanceId: options.agentInstanceId
    });

    const existing = db.prepare(`
      SELECT ${summarizeSessionApprovalColumns}
      FROM codex_session_approvals
      WHERE session_id = ?
        AND app_request_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(approval.sessionId, approval.appRequestId);

    if (existing) return summarizeSessionApproval(existing);

    insertSessionApproval.run(approval);

    insertSessionEvent.run(
      normalizeSessionEvent(approval.sessionId, {
        type: "approval.requested",
        text: approval.prompt || `${approval.method} approval requested.`,
        raw: {
          approvalId: approval.id,
          appRequestId: approval.appRequestId,
          method: approval.method,
          payload: input.payload || {}
        }
      }, now)
    );

    return getSessionApprovalSummary(approval.id);
  });

  return create();
}

export function decideSessionApproval(id, input = {}, options = {}) {
  const approval = getSessionApprovalSummary(id);
  if (!approval) return notFound("Approval not found.");
  if (input.sessionId && approval.sessionId !== input.sessionId) return notFound("Approval not found.");
  const session = getSessionSummary(approval.sessionId);
  if (!session || !canAccessOwner(options.user, session.ownerUser)) return notFound("Approval not found.");
  if (approval.status !== "pending") return approval;

  const now = nowIso();
  const status = normalizeApprovalStatus(input.decision);
  const response = buildApprovalResponse(approval.method, status);
  const decidedBy = String(options.user?.username || options.user?.displayName || "mobile").slice(0, 120);

  const decide = db.transaction(() => {
    db.prepare(`
      UPDATE codex_session_approvals
      SET status = @status,
          response_json = @responseJson,
          decided_at = @now,
          decided_by = @decidedBy,
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id,
      status,
      responseJson: JSON.stringify(response),
      now,
      decidedBy
    });

    insertSessionEvent.run(
      normalizeSessionEvent(approval.sessionId, {
        type: status === "approved" ? "approval.approved" : "approval.denied",
        text: `${approval.method} ${status}.`,
        raw: { approvalId: approval.id, response }
      }, now)
    );

    return getSessionApprovalSummary(id);
  });

  return decide();
}

export function createSessionInteraction(input = {}, options = {}) {
  const session = getSessionSummary(input.sessionId);
  if (!session) return notFound("Session not found.");
  if (!canMutateSessionLease(session, options.agentId, options.agentInstanceId)) return false;

  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const interaction = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    appRequestId: String(input.appRequestId || ""),
    method: String(input.method || ""),
    kind: normalizeInteractionKind(input.kind || input.method),
    prompt: String(input.prompt || "").slice(0, 12000),
    payloadJson: JSON.stringify(input.payload || {}).slice(0, 30000),
    requestedBy: normalizeAgentId(options.agentId),
    now
  };

  const create = db.transaction(() => {
    touchSessionLeaseForAgent(interaction.sessionId, interaction.requestedBy, {
      now,
      leaseExpiresAt,
      agentInstanceId: options.agentInstanceId
    });

    const existing = db.prepare(`
      SELECT ${summarizeSessionInteractionColumns}
      FROM codex_session_interactions
      WHERE session_id = ?
        AND app_request_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(interaction.sessionId, interaction.appRequestId);

    if (existing) return summarizeSessionInteraction(existing);

    insertSessionInteraction.run(interaction);

    insertSessionEvent.run(
      normalizeSessionEvent(interaction.sessionId, {
        type: "interaction.requested",
        text: interaction.prompt || `${interaction.method} requested input.`,
        raw: {
          interactionId: interaction.id,
          appRequestId: interaction.appRequestId,
          method: interaction.method,
          kind: interaction.kind,
          payload: input.payload || {}
        }
      }, now)
    );

    return getSessionInteractionSummary(interaction.id);
  });

  return create();
}

export function decideSessionInteraction(id, input = {}, options = {}) {
  const interaction = getSessionInteractionSummary(id);
  if (!interaction) return notFound("Interaction not found.");
  if (input.sessionId && interaction.sessionId !== input.sessionId) return notFound("Interaction not found.");
  const session = getSessionSummary(interaction.sessionId);
  if (!session || !canAccessOwner(options.user, session.ownerUser)) return notFound("Interaction not found.");
  if (interaction.status !== "pending") return interaction;

  const now = nowIso();
  const status = normalizeInteractionStatus(input.decision);
  const response = buildInteractionResponse(interaction, input, status);
  const answeredBy = String(options.user?.username || options.user?.displayName || "mobile").slice(0, 120);

  const decide = db.transaction(() => {
    db.prepare(`
      UPDATE codex_session_interactions
      SET status = @status,
          response_json = @responseJson,
          answered_at = @now,
          answered_by = @answeredBy,
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id,
      status,
      responseJson: JSON.stringify(response).slice(0, 30000),
      now,
      answeredBy
    });

    insertSessionEvent.run(
      normalizeSessionEvent(interaction.sessionId, {
        type: status === "answered" ? "interaction.answered" : `interaction.${status}`,
        text: interaction.method ? `${interaction.method} ${status}.` : `Interaction ${status}.`,
        raw: { interactionId: interaction.id, response: redactInteractionResponseForEvent(interaction, response) }
      }, now)
    );

    return getSessionInteractionSummary(id);
  });

  return decide();
}

export function waitForSessionApprovalDecision(id, options = {}) {
  expireOldApprovals();
  const approval = getSessionApprovalSummary(id);
  if (!approval) return null;
  const agentId = normalizeAgentId(options.agentId);
  if (agentId && approval.requestedBy !== agentId) return null;
  if (approval.status === "pending" && agentId) touchSessionLeaseForAgent(approval.sessionId, agentId, { agentInstanceId: options.agentInstanceId });
  return approval.status === "pending" ? null : approval;
}

export function waitForSessionInteractionDecision(id, options = {}) {
  expireOldInteractions();
  const interaction = getSessionInteractionSummary(id);
  if (!interaction) return null;
  const agentId = normalizeAgentId(options.agentId);
  if (agentId && interaction.requestedBy !== agentId) return null;
  if (interaction.status === "pending" && agentId) touchSessionLeaseForAgent(interaction.sessionId, agentId, { agentInstanceId: options.agentInstanceId });
  return interaction.status === "pending" ? null : interaction;
}

export function listQuickSkills(options = {}) {
  ensureDefaultQuickSkills();
  const projectId = normalizeQuickSkillProjectId(options.projectId);
  const targetAgentId = normalizeTargetAgentId(options.targetAgentId);
  const rows = db.prepare(`
    SELECT ${summarizeQuickSkillColumns}
    FROM codex_quick_skills
    WHERE archived_at IS NULL
      AND (
        scope = 'global'
        OR (
          scope = 'project'
          AND project_id = @projectId
          AND (
            target_agent_id = ''
            OR @targetAgentId = ''
            OR target_agent_id = @targetAgentId
          )
        )
      )
    ORDER BY
      CASE scope WHEN 'global' THEN 0 ELSE 1 END,
      CASE WHEN target_agent_id = @targetAgentId AND @targetAgentId <> '' THEN 0 ELSE 1 END,
      sort_order ASC,
      created_at ASC
  `).all({ projectId, targetAgentId });
  return rows.map(summarizeQuickSkill);
}

export function createQuickSkill(input = {}) {
  const now = nowIso();
  const skill = normalizeQuickSkillInput(input);
  const sortOrder = Number.isFinite(Number(input.sortOrder))
    ? Math.round(Number(input.sortOrder))
    : nextQuickSkillSortOrder(skill.scope, skill.projectId, skill.targetAgentId);
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO codex_quick_skills (
      id, scope, project_id, target_agent_id, title, description, prompt, mode, requires_session, sort_order, created_at, updated_at, archived_at
    ) VALUES (
      @id, @scope, @projectId, @targetAgentId, @title, @description, @prompt, @mode, @requiresSession, @sortOrder, @now, @now, NULL
    )
  `).run({
    id,
    ...skill,
    requiresSession: skill.requiresSession ? 1 : 0,
    sortOrder,
    now
  });

  return getQuickSkill(id);
}

export function updateQuickSkill(id, input = {}) {
  ensureDefaultQuickSkills();
  const existing = getQuickSkill(id);
  if (!existing || existing.archivedAt) return notFound("Quick skill not found.");

  const now = nowIso();
  const next = normalizeQuickSkillInput(input, existing);
  const sortOrder = Number.isFinite(Number(input.sortOrder)) ? Math.round(Number(input.sortOrder)) : existing.sortOrder;
  db.prepare(`
    UPDATE codex_quick_skills
    SET scope = @scope,
        project_id = @projectId,
        target_agent_id = @targetAgentId,
        title = @title,
        description = @description,
        prompt = @prompt,
        mode = @mode,
        requires_session = @requiresSession,
        sort_order = @sortOrder,
        updated_at = @now
    WHERE id = @id
      AND archived_at IS NULL
  `).run({
    id,
    ...next,
    requiresSession: next.requiresSession ? 1 : 0,
    sortOrder,
    now
  });

  return getQuickSkill(id);
}

export function deleteQuickSkill(id) {
  ensureDefaultQuickSkills();
  const existing = getQuickSkill(id);
  if (!existing || existing.archivedAt) return notFound("Quick skill not found.");

  const now = nowIso();
  db.prepare(`
    UPDATE codex_quick_skills
    SET archived_at = @now,
        updated_at = @now
    WHERE id = @id
      AND archived_at IS NULL
  `).run({ id, now });
  return { ...existing, archivedAt: now };
}

export function ownerStorageUsage(ownerUser) {
  const owner = normalizeOwnerUser(ownerUser);
  if (!owner) {
    return { ownerUser: "", attachmentBytes: 0, artifactBytes: 0, totalBytes: 0, quotaBytes: 0 };
  }
  const attachmentBytesValue = Number(db.prepare(`
    SELECT COALESCE(SUM(a.size_bytes), 0) AS bytes
    FROM codex_session_attachments a
    JOIN codex_sessions s ON s.id = a.session_id
    WHERE s.owner_user = ?
  `).get(owner)?.bytes || 0);
  const artifactBytesValue = Number(db.prepare(`
    SELECT COALESCE(SUM(a.size_bytes), 0) AS bytes
    FROM codex_session_artifacts a
    JOIN codex_sessions s ON s.id = a.session_id
    WHERE s.owner_user = ?
  `).get(owner)?.bytes || 0);
  const quotaBytes = getStorageQuotaBytes(owner);
  return {
    ownerUser: owner,
    attachmentBytes: attachmentBytesValue,
    artifactBytes: artifactBytesValue,
    totalBytes: attachmentBytesValue + artifactBytesValue,
    quotaBytes,
    remainingBytes: quotaBytes > 0 ? Math.max(0, quotaBytes - attachmentBytesValue - artifactBytesValue) : null
  };
}

export function deleteOwnerData(ownerUser) {
  const owner = normalizeOwnerUser(ownerUser);
  if (!owner) return badRequest("Owner user is required.");

  const sessionIds = db.prepare("SELECT id FROM codex_sessions WHERE owner_user = ?").all(owner).map((row) => row.id);
  const attachmentKeys = db.prepare(`
    SELECT a.storage_key AS storageKey
    FROM codex_session_attachments a
    JOIN codex_sessions s ON s.id = a.session_id
    WHERE s.owner_user = ?
  `).all(owner).map((row) => row.storageKey);
  const artifactKeys = db.prepare(`
    SELECT a.storage_key AS storageKey
    FROM codex_session_artifacts a
    JOIN codex_sessions s ON s.id = a.session_id
    WHERE s.owner_user = ?
  `).all(owner).map((row) => row.storageKey);

  const remove = db.transaction(() => {
    const workspaceRuntimePreferences = db.prepare("DELETE FROM workspace_runtime_preferences WHERE owner_user = ?").run(owner).changes;
    const fileRequests = db.prepare("DELETE FROM codex_file_requests WHERE owner_user = ?").run(owner).changes;
    const workspaceCommands = db.prepare("DELETE FROM codex_workspace_commands WHERE owner_user = ?").run(owner).changes;
    const workspaceVisibility = db.prepare("DELETE FROM codex_workspace_visibility WHERE owner_user = ?").run(owner).changes;
    const agents = db.prepare("DELETE FROM codex_agents WHERE owner_user = ?").run(owner).changes;
    const sessions = db.prepare("DELETE FROM codex_sessions WHERE owner_user = ?").run(owner).changes;
    return { sessions, fileRequests, workspaceCommands, workspaceVisibility, workspaceRuntimePreferences, agents };
  });

  const counts = remove();
  cleanupAttachmentStorageKeys(attachmentKeys);
  cleanupArtifactStorageKeys(artifactKeys);
  return {
    ownerUser: owner,
    deleted: {
      ...counts,
      attachments: attachmentKeys.length,
      artifacts: artifactKeys.length,
      sessionIds
    }
  };
}

export function resetStoreForTest() {
  db.prepare("DELETE FROM workspace_runtime_preferences").run();
  db.prepare("DELETE FROM codex_quick_skills").run();
  db.prepare("DELETE FROM codex_workspace_visibility").run();
  db.prepare("DELETE FROM codex_file_requests").run();
  db.prepare("DELETE FROM codex_workspace_commands").run();
  db.prepare("DELETE FROM codex_session_artifacts").run();
  db.prepare("DELETE FROM codex_session_attachments").run();
  db.prepare("DELETE FROM codex_session_messages").run();
  db.prepare("DELETE FROM codex_session_interactions").run();
  db.prepare("DELETE FROM codex_session_approvals").run();
  db.prepare("DELETE FROM codex_session_events").run();
  db.prepare("DELETE FROM codex_agent_restart_operations").run();
  db.prepare("DELETE FROM codex_session_commands").run();
  db.prepare("DELETE FROM codex_sessions").run();
  db.prepare("DELETE FROM codex_events").run();
  db.prepare("DELETE FROM codex_jobs").run();
  db.prepare("DELETE FROM codex_agents").run();
  fs.rmSync(attachmentStorageDir, { recursive: true, force: true });
  fs.rmSync(artifactStorageDir, { recursive: true, force: true });
  fs.mkdirSync(attachmentStorageDir, { recursive: true });
  fs.mkdirSync(artifactStorageDir, { recursive: true });
  ensureDefaultQuickSkills();
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS echo_schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codex_jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'stale')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      error TEXT NOT NULL DEFAULT '',
      final_message TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      lease_expires_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_codex_jobs_status_created
      ON codex_jobs(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_jobs_lease
      ON codex_jobs(status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS codex_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES codex_jobs(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      raw_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_codex_events_job_id
      ON codex_events(job_id, id);

    CREATE TABLE IF NOT EXISTS codex_agents (
      id TEXT PRIMARY KEY,
      owner_user TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      instance_id TEXT NOT NULL DEFAULT '',
      instance_started_at TEXT NOT NULL DEFAULT '',
      last_seen_at TEXT NOT NULL,
      workspaces_json TEXT NOT NULL DEFAULT '[]',
      runtime_json TEXT NOT NULL DEFAULT '{}',
      snapshot_updated_at TEXT NOT NULL DEFAULT '',
      workspaces_updated_at TEXT NOT NULL DEFAULT '',
      runtime_updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS codex_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_user TEXT NOT NULL DEFAULT '',
      target_agent_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'active', 'running', 'failed', 'cancelled', 'closed', 'stale')),
      app_thread_id TEXT,
      active_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      final_message TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      leased_instance_id TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT,
      archived_at TEXT,
      runtime_json TEXT NOT NULL DEFAULT '{}',
      execution_json TEXT NOT NULL DEFAULT '{}',
      memory_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_status_updated
      ON codex_sessions(status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_thread
      ON codex_sessions(app_thread_id);

    CREATE TABLE IF NOT EXISTS codex_agent_restart_operations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      old_instance_id TEXT NOT NULL,
      new_instance_id TEXT NOT NULL DEFAULT '',
      expected_revision TEXT NOT NULL DEFAULT '',
      actual_revision TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('requested', 'restarting', 'resuming', 'completed', 'failed', 'cancelled')),
      resume_summary TEXT NOT NULL DEFAULT '',
      continuation_command_id TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_codex_agent_restarts_agent_status
      ON codex_agent_restart_operations(agent_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_agent_restarts_session_created
      ON codex_agent_restart_operations(session_id, created_at);

    CREATE TABLE IF NOT EXISTS codex_session_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('start', 'message', 'stop', 'compact', 'worktree', 'archive')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'reconciling', 'done', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      available_at TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      leased_instance_id TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT '',
      attempt INTEGER NOT NULL DEFAULT 1,
      result_json TEXT NOT NULL DEFAULT '',
      completed_by TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_status_created
      ON codex_session_commands(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_session
      ON codex_session_commands(session_id, created_at);

    CREATE TABLE IF NOT EXISTS codex_workspace_commands (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('create', 'mcp.apply', 'import.list', 'register', 'agent-skill.list', 'agent-skill.update', 'agent-skill.sync', 'agent-skill.import', 'plugin.list', 'plugin.update')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      owner_user TEXT NOT NULL DEFAULT '',
      target_agent_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed')),
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_codex_workspace_commands_status_created
      ON codex_workspace_commands(status, created_at);

    CREATE TABLE IF NOT EXISTS codex_workspace_visibility (
      owner_user TEXT NOT NULL,
      project_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL DEFAULT '',
      visible_in_sidebar INTEGER NOT NULL DEFAULT 1,
      hidden_at TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_user, project_key)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_workspace_visibility_owner_visible
      ON codex_workspace_visibility(owner_user, visible_in_sidebar, updated_at);

    CREATE TABLE IF NOT EXISTS workspace_runtime_preferences (
      owner_user TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      preference_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_user, target_agent_id, workspace_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_runtime_preferences_owner_updated
      ON workspace_runtime_preferences(owner_user, updated_at);

    CREATE TABLE IF NOT EXISTS codex_file_requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('list', 'read', 'open-spec-summary', 'orchestration-plan')),
      project_id TEXT NOT NULL,
      owner_user TEXT NOT NULL DEFAULT '',
      target_agent_id TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'expired')),
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_status_created
      ON codex_file_requests(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_expires
      ON codex_file_requests(expires_at);

    CREATE TABLE IF NOT EXISTS codex_session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      raw_json TEXT,
      event_key TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_events_session_id
      ON codex_session_events(session_id, id);

    CREATE TABLE IF NOT EXISTS codex_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      text TEXT NOT NULL DEFAULT '',
      command_id TEXT,
      external_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, external_key)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_messages_session
      ON codex_session_messages(session_id, created_at, id);

    CREATE TABLE IF NOT EXISTS codex_session_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES codex_session_messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('image', 'file')),
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(storage_key)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_attachments_message
      ON codex_session_attachments(message_id, created_at, id);

    CREATE TABLE IF NOT EXISTS codex_session_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      event_id INTEGER REFERENCES codex_session_events(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(storage_key)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_artifacts_session
      ON codex_session_artifacts(session_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_artifacts_event
      ON codex_session_artifacts(event_id);

    CREATE TABLE IF NOT EXISTS codex_session_approvals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      app_request_id TEXT NOT NULL,
      method TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'timed_out')),
      prompt TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT '',
      UNIQUE(session_id, app_request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_session
      ON codex_session_approvals(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_status
      ON codex_session_approvals(status, created_at);

    CREATE TABLE IF NOT EXISTS codex_session_interactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      app_request_id TEXT NOT NULL,
      method TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('user_input', 'unknown')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'timed_out')),
      prompt TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      answered_at TEXT,
      answered_by TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT '',
      UNIQUE(session_id, app_request_id)
    );

    CREATE INDEX IF NOT EXISTS idx_codex_session_interactions_session
      ON codex_session_interactions(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_interactions_status
      ON codex_session_interactions(status, created_at);

    CREATE TABLE IF NOT EXISTS codex_quick_skills (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      project_id TEXT NOT NULL DEFAULT '',
      target_agent_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('execute', 'plan')) DEFAULT 'execute',
      requires_session INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_codex_quick_skills_scope_project_order
      ON codex_quick_skills(scope, project_id, target_agent_id, archived_at, sort_order, created_at);

    CREATE INDEX IF NOT EXISTS idx_workspace_runtime_preferences_owner_updated
      ON workspace_runtime_preferences(owner_user, updated_at);
  `);
  const previousSchemaVersion = Number(
    db.prepare("SELECT value FROM echo_schema_meta WHERE key = 'schema_version'").get()?.value || 0
  );

  ensureColumn("codex_sessions", "archived_at", "TEXT");
  ensureColumn("codex_agents", "owner_user", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_agents", "display_name", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_agents", "instance_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_agents", "instance_started_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_agents", "snapshot_updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_agents", "workspaces_updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_agents", "runtime_updated_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_sessions", "owner_user", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_sessions", "target_agent_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_sessions", "runtime_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("codex_sessions", "execution_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("codex_sessions", "memory_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("codex_session_commands", "available_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_sessions", "leased_instance_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_session_commands", "leased_instance_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_session_commands", "attempt", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("codex_session_commands", "result_json", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_session_commands", "completed_by", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_session_events", "event_key", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_workspace_commands", "owner_user", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_workspace_commands", "target_agent_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_file_requests", "owner_user", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_file_requests", "target_agent_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("codex_quick_skills", "target_agent_id", "TEXT NOT NULL DEFAULT ''");
  ensureSessionStatuses();
  repairSessionForeignKeyReferences();
  ensureSessionAttachmentTypes();
  ensureSessionCommandTypes();
  ensureWorkspaceCommandTypes();
  ensureFileRequestTypes();
  repairSessionForeignKeyReferences();
  migrateWorkspacePermissionsToFull(previousSchemaVersion);
  setSchemaVersion(schemaVersion);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_codex_sessions_status_updated
      ON codex_sessions(status, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_thread
      ON codex_sessions(app_thread_id);

    CREATE INDEX IF NOT EXISTS idx_codex_agent_restarts_agent_status
      ON codex_agent_restart_operations(agent_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_agent_restarts_session_created
      ON codex_agent_restart_operations(session_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_agents_owner_last_seen
      ON codex_agents(owner_user, last_seen_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_owner_target_updated
      ON codex_sessions(owner_user, target_agent_id, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_owner_archived_updated
      ON codex_sessions(owner_user, archived_at, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_archived_updated
      ON codex_sessions(archived_at, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_project_archived_updated
      ON codex_sessions(project_id, archived_at, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_target_project
      ON codex_sessions(target_agent_id, project_id, archived_at, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_status_created
      ON codex_session_commands(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_session
      ON codex_session_commands(session_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_status_created
      ON codex_file_requests(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_expires
      ON codex_file_requests(expires_at);

    CREATE INDEX IF NOT EXISTS idx_codex_workspace_commands_owner_target_updated
      ON codex_workspace_commands(owner_user, target_agent_id, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_owner_target_updated
      ON codex_file_requests(owner_user, target_agent_id, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_target_status_created
      ON codex_file_requests(target_agent_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_events_session_id
      ON codex_session_events(session_id, id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_session_events_protocol_key
      ON codex_session_events(session_id, event_key)
      WHERE event_key <> '';

    CREATE INDEX IF NOT EXISTS idx_codex_session_messages_session
      ON codex_session_messages(session_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_attachments_message
      ON codex_session_attachments(message_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_artifacts_session
      ON codex_session_artifacts(session_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_artifacts_event
      ON codex_session_artifacts(event_id);

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_session
      ON codex_session_approvals(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_approvals_status
      ON codex_session_approvals(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_interactions_session
      ON codex_session_interactions(session_id, status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_interactions_status
      ON codex_session_interactions(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_quick_skills_scope_project_order
      ON codex_quick_skills(scope, project_id, target_agent_id, archived_at, sort_order, created_at);
  `);
  ensureDefaultQuickSkills();
}

function ensureColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function setSchemaVersion(version) {
  db.prepare(`
    INSERT INTO echo_schema_meta (key, value, updated_at)
    VALUES ('schema_version', @value, @now)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run({
    value: String(version),
    now: nowIso()
  });
}

function migrateWorkspacePermissionsToFull(previousSchemaVersion) {
  if (previousSchemaVersion >= 9) return;
  const rows = db.prepare(`
    SELECT owner_user AS ownerUser,
           target_agent_id AS targetAgentId,
           workspace_id AS workspaceId,
           preference_json AS preferenceJson
    FROM workspace_runtime_preferences
  `).all();
  if (rows.length === 0) return;

  const update = db.prepare(`
    UPDATE workspace_runtime_preferences
    SET preference_json = @preferenceJson,
        version = version + 1,
        updated_at = @now
    WHERE owner_user = @ownerUser
      AND target_agent_id = @targetAgentId
      AND workspace_id = @workspaceId
  `);
  const migrateRows = db.transaction(() => {
    const now = nowIso();
    for (const row of rows) {
      update.run({
        ...row,
        preferenceJson: JSON.stringify({ ...parseJson(row.preferenceJson, {}), permissionMode: "full" }),
        now
      });
    }
  });
  migrateRows();
}

function ensureSessionStatuses() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_sessions'").get()?.sql || "";
  if (schema.includes("'cancelled'")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN TRANSACTION;
    ALTER TABLE codex_sessions RENAME TO codex_sessions_old;
    CREATE TABLE codex_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      owner_user TEXT NOT NULL DEFAULT '',
      target_agent_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'active', 'running', 'failed', 'cancelled', 'closed', 'stale')),
      app_thread_id TEXT,
      active_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      final_message TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      lease_expires_at TEXT,
      archived_at TEXT,
      runtime_json TEXT NOT NULL DEFAULT '{}',
      execution_json TEXT NOT NULL DEFAULT '{}',
      memory_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO codex_sessions (
      id,
      project_id,
      owner_user,
      target_agent_id,
      title,
      status,
      app_thread_id,
      active_turn_id,
      created_at,
      updated_at,
      last_error,
      final_message,
      leased_by,
      lease_expires_at,
      archived_at,
      runtime_json,
      execution_json,
      memory_json
    )
    SELECT
      id,
      project_id,
      COALESCE(owner_user, '') AS owner_user,
      COALESCE(target_agent_id, '') AS target_agent_id,
      title,
      status,
      app_thread_id,
      active_turn_id,
      created_at,
      updated_at,
      last_error,
      final_message,
      leased_by,
      lease_expires_at,
      archived_at,
      runtime_json,
      execution_json,
      COALESCE(memory_json, '{}') AS memory_json
    FROM codex_sessions_old;
    DROP TABLE codex_sessions_old;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;
  `);
}

function ensureSessionAttachmentTypes() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_session_attachments'").get()?.sql || "";
  if (!schema || schema.includes("'file'")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN TRANSACTION;
    ALTER TABLE codex_session_attachments RENAME TO codex_session_attachments_old;
    CREATE TABLE codex_session_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES codex_session_messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('image', 'file')),
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(storage_key)
    );
    INSERT INTO codex_session_attachments (
      id, session_id, message_id, type, original_name, mime_type, size_bytes, sha256, storage_key, created_at
    )
    SELECT id, session_id, message_id, type, original_name, mime_type, size_bytes, sha256, storage_key, created_at
    FROM codex_session_attachments_old;
    DROP TABLE codex_session_attachments_old;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;

    CREATE INDEX IF NOT EXISTS idx_codex_session_attachments_message
      ON codex_session_attachments(message_id, created_at, id);
  `);
  db.pragma("foreign_keys = ON");
}

function repairSessionForeignKeyReferences() {
  const brokenTables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND sql LIKE '%codex_sessions_old%'
  `).all();
  if (brokenTables.length === 0) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
  `);

  try {
    const repair = db.transaction(() => {
      const names = brokenTables.map((table) => table.name).filter((name) => sessionChildTableSchema(name));
      for (const name of names) {
        const backupName = repairTableName(name);
        db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(backupName)}`);
        db.exec(`ALTER TABLE ${quoteIdentifier(name)} RENAME TO ${quoteIdentifier(backupName)}`);
      }
      for (const name of names) {
        db.exec(sessionChildTableSchema(name));
        copyCommonColumns(repairTableName(name), name);
        db.exec(`DROP TABLE ${quoteIdentifier(repairTableName(name))}`);
      }
    });
    repair();
  } finally {
    db.exec(`
      PRAGMA legacy_alter_table = OFF;
      PRAGMA foreign_keys = ON;
    `);
  }
}

function sessionChildTableSchema(name) {
  if (name === "codex_agent_restart_operations") {
    return `
      CREATE TABLE codex_agent_restart_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        old_instance_id TEXT NOT NULL,
        new_instance_id TEXT NOT NULL DEFAULT '',
        expected_revision TEXT NOT NULL DEFAULT '',
        actual_revision TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('requested', 'restarting', 'resuming', 'completed', 'failed', 'cancelled')),
        resume_summary TEXT NOT NULL DEFAULT '',
        continuation_command_id TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )
    `;
  }
  if (name === "codex_session_commands") {
    return `
      CREATE TABLE codex_session_commands (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('start', 'message', 'stop', 'compact', 'worktree', 'archive')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'reconciling', 'done', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        available_at TEXT NOT NULL DEFAULT '',
        leased_by TEXT,
        leased_instance_id TEXT NOT NULL DEFAULT '',
        lease_expires_at TEXT,
        error TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL DEFAULT '',
        completed_by TEXT NOT NULL DEFAULT ''
      )
    `;
  }
  if (name === "codex_session_events") {
    return `
      CREATE TABLE codex_session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        raw_json TEXT,
        event_key TEXT NOT NULL DEFAULT ''
      )
    `;
  }
  if (name === "codex_session_messages") {
    return `
      CREATE TABLE codex_session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        text TEXT NOT NULL DEFAULT '',
        command_id TEXT,
        external_key TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(session_id, external_key)
      )
    `;
  }
  if (name === "codex_session_attachments") {
    return `
      CREATE TABLE codex_session_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES codex_session_messages(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('image', 'file')),
        original_name TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(storage_key)
      )
    `;
  }
  if (name === "codex_session_artifacts") {
    return `
      CREATE TABLE codex_session_artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES codex_session_events(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT 'text/plain; charset=utf-8',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(storage_key)
      )
    `;
  }
  if (name === "codex_session_approvals") {
    return `
      CREATE TABLE codex_session_approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        app_request_id TEXT NOT NULL,
        method TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'timed_out')),
        prompt TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL DEFAULT '',
        UNIQUE(session_id, app_request_id)
      )
    `;
  }
  if (name === "codex_session_interactions") {
    return `
      CREATE TABLE codex_session_interactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
        app_request_id TEXT NOT NULL,
        method TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user_input', 'unknown')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'cancelled', 'timed_out')),
        prompt TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        answered_at TEXT,
        answered_by TEXT NOT NULL DEFAULT '',
        requested_by TEXT NOT NULL DEFAULT '',
        UNIQUE(session_id, app_request_id)
      )
    `;
  }
  return "";
}

function copyCommonColumns(fromTable, toTable) {
  const fromColumns = tableColumns(fromTable);
  const toColumns = tableColumns(toTable);
  const fromColumnNames = new Set(fromColumns.map((column) => column.name));
  const commonColumns = toColumns.map((column) => column.name).filter((name) => fromColumnNames.has(name));
  if (commonColumns.length === 0) return;

  const columnList = commonColumns.map(quoteIdentifier).join(", ");
  db.prepare(`
    INSERT INTO ${quoteIdentifier(toTable)} (${columnList})
    SELECT ${columnList}
    FROM ${quoteIdentifier(fromTable)}
  `).run();
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all();
}

function repairTableName(name) {
  return `__echo_repair_${name}`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function ensureSessionCommandTypes() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_session_commands'").get()?.sql || "";
  if (
    schema.includes("'compact'") &&
    schema.includes("'worktree'") &&
    schema.includes("'archive'") &&
    schema.includes("'reconciling'")
  ) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN TRANSACTION;
    ALTER TABLE codex_session_commands RENAME TO codex_session_commands_old;
    CREATE TABLE codex_session_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('start', 'message', 'stop', 'compact', 'worktree', 'archive')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'reconciling', 'done', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      available_at TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      leased_instance_id TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT '',
      attempt INTEGER NOT NULL DEFAULT 1,
      result_json TEXT NOT NULL DEFAULT '',
      completed_by TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO codex_session_commands (
      id, session_id, type, payload_json, status, created_at, updated_at, available_at,
      leased_by, leased_instance_id, lease_expires_at, error, attempt, result_json, completed_by
    )
    SELECT id, session_id, type, payload_json, status, created_at, updated_at,
      COALESCE(available_at, created_at), leased_by, COALESCE(leased_instance_id, ''), lease_expires_at,
      error, COALESCE(attempt, 1), COALESCE(result_json, ''), COALESCE(completed_by, '')
    FROM codex_session_commands_old;
    DROP TABLE codex_session_commands_old;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_status_created
      ON codex_session_commands(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_session_commands_session
      ON codex_session_commands(session_id, created_at);
  `);
  db.pragma("foreign_keys = ON");
}

function ensureWorkspaceCommandTypes() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_workspace_commands'").get()?.sql || "";
  if (
    schema.includes("'mcp.apply'") &&
    schema.includes("'import.list'") &&
    schema.includes("'register'") &&
    schema.includes("'agent-skill.update'") &&
    schema.includes("'agent-skill.import'") &&
    schema.includes("'plugin.update'")
  ) {
    return;
  }

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN TRANSACTION;
    ALTER TABLE codex_workspace_commands RENAME TO codex_workspace_commands_old;
    CREATE TABLE codex_workspace_commands (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('create', 'mcp.apply', 'import.list', 'register', 'agent-skill.list', 'agent-skill.update', 'agent-skill.sync', 'agent-skill.import', 'plugin.list', 'plugin.update')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      owner_user TEXT NOT NULL DEFAULT '',
      target_agent_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed')),
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO codex_workspace_commands (
      id, type, payload_json, owner_user, target_agent_id, status, result_json, created_at, updated_at, leased_by, lease_expires_at, error
    )
    SELECT
      id,
      type,
      payload_json,
      COALESCE(owner_user, '') AS owner_user,
      COALESCE(target_agent_id, '') AS target_agent_id,
      status,
      result_json,
      created_at,
      updated_at,
      leased_by,
      lease_expires_at,
      error
    FROM codex_workspace_commands_old;
    DROP TABLE codex_workspace_commands_old;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;

    CREATE INDEX IF NOT EXISTS idx_codex_workspace_commands_status_created
      ON codex_workspace_commands(status, created_at);
  `);
  db.pragma("foreign_keys = ON");
}

function ensureFileRequestTypes() {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_file_requests'").get()?.sql || "";
  if (schema.includes("'open-spec-summary'") && schema.includes("'orchestration-plan'")) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    PRAGMA legacy_alter_table = ON;
    BEGIN TRANSACTION;
    ALTER TABLE codex_file_requests RENAME TO codex_file_requests_old;
    CREATE TABLE codex_file_requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('list', 'read', 'open-spec-summary', 'orchestration-plan')),
      project_id TEXT NOT NULL,
      owner_user TEXT NOT NULL DEFAULT '',
      target_agent_id TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'expired')),
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO codex_file_requests (
      id,
      type,
      project_id,
      owner_user,
      target_agent_id,
      path,
      payload_json,
      status,
      result_json,
      created_at,
      updated_at,
      expires_at,
      leased_by,
      lease_expires_at,
      error,
      requested_by
    )
    SELECT
      id,
      type,
      project_id,
      COALESCE(owner_user, '') AS owner_user,
      COALESCE(target_agent_id, '') AS target_agent_id,
      path,
      payload_json,
      status,
      result_json,
      created_at,
      updated_at,
      expires_at,
      leased_by,
      lease_expires_at,
      error,
      requested_by
    FROM codex_file_requests_old;
    DROP TABLE codex_file_requests_old;
    COMMIT;
    PRAGMA legacy_alter_table = OFF;
    PRAGMA foreign_keys = ON;

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_status_created
      ON codex_file_requests(status, created_at);

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_expires
      ON codex_file_requests(expires_at);

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_owner_target_updated
      ON codex_file_requests(owner_user, target_agent_id, updated_at);

    CREATE INDEX IF NOT EXISTS idx_codex_file_requests_target_status_created
      ON codex_file_requests(target_agent_id, status, created_at);
  `);
  db.pragma("foreign_keys = ON");
}

function reclaimExpiredLeases() {
  const now = nowIso();
  const expired = db.prepare(`
    SELECT id, leased_by AS leasedBy
    FROM codex_jobs
    WHERE status = 'running'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
  `).all(now);

  if (expired.length === 0) return;

  const reclaim = db.transaction(() => {
    for (const job of expired) {
      db.prepare(`
        UPDATE codex_jobs
        SET status = 'queued',
            leased_by = NULL,
            lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @id
          AND status = 'running'
      `).run({ id: job.id, now });

      insertInternalEvents(job.id, [
        {
          type: "lease.expired",
          text: `Desktop agent ${job.leasedBy || "unknown"} stopped renewing this job; it returned to the queue.`
        }
      ]);
    }
  });

  reclaim();
}

function listAgents() {
  return db.prepare(`
    SELECT id, owner_user AS ownerUser, display_name AS displayName,
           instance_id AS instanceId, instance_started_at AS instanceStartedAt, last_seen_at AS lastSeenAt,
           workspaces_json AS workspacesJson, runtime_json AS runtimeJson,
           snapshot_updated_at AS snapshotUpdatedAt, workspaces_updated_at AS workspacesUpdatedAt, runtime_updated_at AS runtimeUpdatedAt
    FROM codex_agents
    ORDER BY last_seen_at DESC
    LIMIT 10
  `).all().map(parseAgent);
}

function isAgentOnline(agent, nowMs = Date.now()) {
  const lastSeenMs = Date.parse(agent?.lastSeenAt || "");
  return Number.isFinite(lastSeenMs) && nowMs - lastSeenMs < agentOnlineTtlMs;
}

function mergeAgentWorkspaces(agents) {
  const byKey = new Map();
  for (const agent of agents) {
    for (const workspace of agent.workspaces || []) {
      const key = workspaceKey(agent.id, workspace.id);
      if (byKey.has(key)) continue;
      byKey.set(key, {
        ...workspace,
        workspaceId: workspace.id,
        key,
        agentId: agent.id,
        agentLabel: agent.displayName || agent.id,
        agentOwnerUser: agent.ownerUser || "",
        agentLastSeenAt: agent.lastSeenAt,
        agentSnapshotUpdatedAt: agent.snapshotUpdatedAt || "",
        workspaceUpdatedAt: agent.workspacesUpdatedAt || agent.snapshotUpdatedAt || ""
      });
    }
  }
  return Array.from(byKey.values());
}

function filterVisibleAgentWorkspaces(agent = {}, hiddenWorkspaceKeys = new Set()) {
  if (!hiddenWorkspaceKeys || hiddenWorkspaceKeys.size === 0) return agent.workspaces || [];
  return (agent.workspaces || []).filter((workspace) => {
    const key = workspaceKey(agent.id, workspace.id);
    return !hiddenWorkspaceKeys.has(key);
  });
}

function hiddenWorkspaceKeySet(ownerUser = "") {
  const owner = normalizeOwnerUser(ownerUser);
  if (!owner) return new Set();
  return new Set(
    db.prepare(`
      SELECT project_key AS projectKey
      FROM codex_workspace_visibility
      WHERE owner_user = ?
        AND visible_in_sidebar = 0
    `).all(owner).map((row) => row.projectKey)
  );
}

function getWorkspaceVisibility({ ownerUser = "", projectKey = "" } = {}) {
  const owner = normalizeOwnerUser(ownerUser);
  const key = String(projectKey || "").trim();
  if (!owner || !key) return null;
  const row = db.prepare(`
    SELECT owner_user AS ownerUser,
           project_key AS projectKey,
           workspace_id AS workspaceId,
           target_agent_id AS targetAgentId,
           visible_in_sidebar AS visibleInSidebar,
           hidden_at AS hiddenAt,
           source,
           updated_at AS updatedAt
    FROM codex_workspace_visibility
    WHERE owner_user = ?
      AND project_key = ?
  `).get(owner, key);
  return row
    ? {
        ...row,
        visibleInSidebar: Boolean(row.visibleInSidebar)
      }
    : null;
}

function mergeAgentRuntimes(agents, primaryRuntime = {}) {
  const primary = normalizeRuntimeBackend(primaryRuntime);
  const mergedBackends = new Map();
  for (const agent of agents || []) {
    for (const backend of normalizeRuntimeBackends(agent.runtime?.backends, agent.runtime || {})) {
      const existing = mergedBackends.get(backend.backendId);
      if (!existing) {
        mergedBackends.set(backend.backendId, backend);
        continue;
      }
      const supportedModels = new Map();
      for (const model of [...(existing.supportedModels || []), ...(backend.supportedModels || [])]) {
        if (model?.id) supportedModels.set(model.id, model);
      }
      const unsupportedModels = new Set([...(existing.unsupportedModels || []), ...(backend.unsupportedModels || [])]);
      mergedBackends.set(backend.backendId, {
        ...existing,
        ...backend,
        supportedModels: Array.from(supportedModels.values()),
        unsupportedModels: Array.from(unsupportedModels)
      });
    }
  }
  const backends = Array.from(mergedBackends.values());
  const selected =
    backends.find((backend) => backend.backendId === primary.backendId) ||
    backends[0] ||
    primary;
  return {
    ...selected,
    defaultBackendId: selected.backendId,
    mcp: primary.mcp || selected.mcp || {},
    backends
  };
}

function getJobSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeJobColumns}
    FROM codex_jobs
    WHERE id = ?
  `).get(id);
  return row ? summarizeJob(row) : null;
}

function summarizeJob(row) {
  const lastEvent = db.prepare(`
    SELECT id, at, type, text, raw_json AS rawJson
    FROM codex_events
    WHERE job_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(row.id);

  const eventCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_events
    WHERE job_id = ?
  `).get(row.id).count;

  return {
    ...row,
    eventCount,
    lastEvent: lastEvent ? parseEvent(lastEvent, { includeRaw: false }) : null
  };
}

function sessionStatusSnapshot(options = {}) {
  refreshInteractiveSessionState();

  const clauses = [];
  const params = {};
  addOwnerAccessClause(clauses, params, options.user, "s");
  const sessionWhere = clauses.length ? `AND ${clauses.join(" AND ")}` : "";
  const queuedCommands = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_commands c
    JOIN codex_sessions s ON s.id = c.session_id
    WHERE c.status = 'queued'
      AND s.status NOT IN ('closed', 'failed', 'cancelled', 'stale')
      ${sessionWhere}
  `).get(params).count;
  const activeSessions = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_sessions s
    WHERE status IN ('starting', 'active', 'running')
      AND archived_at IS NULL
      ${sessionWhere}
  `).get(params).count;
  const pendingApprovals = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_approvals a
    JOIN codex_sessions s ON s.id = a.session_id
    WHERE a.status = 'pending'
      ${sessionWhere}
  `).get(params).count;
  const pendingInteractions = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_interactions i
    JOIN codex_sessions s ON s.id = i.session_id
    WHERE i.status = 'pending'
      ${sessionWhere}
  `).get(params).count;
  const archivedSessions = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_sessions s
    WHERE archived_at IS NOT NULL
      ${sessionWhere}
  `).get(params).count;

  return {
    queuedCommands,
    activeSessions,
    pendingApprovals,
    pendingInteractions,
    archivedSessions,
    recent: []
  };
}

function getSessionSummary(id) {
  expireStaleAgentRestarts();
  const row = db.prepare(`
    SELECT ${summarizeSessionColumns}
    FROM codex_sessions
    WHERE id = ?
  `).get(id);
  return row ? summarizeSession(row) : null;
}

function getSessionCommandSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionCommandColumns}
    FROM codex_session_commands
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionCommand(row) : null;
}

function summarizeSession(row) {
  const lastEvent = db.prepare(`
    SELECT id, at, type, text, raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(row.id);

  const eventCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_events
    WHERE session_id = ?
  `).get(row.id).count;

  const commandCounts = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM codex_session_commands
    WHERE session_id = ?
      AND status IN ('queued', 'leased', 'reconciling')
    GROUP BY status
  `).all(row.id);
  const queuedCommandCount = commandCounts.find((item) => item.status === "queued")?.count || 0;
  const leasedCommandCount = commandCounts.find((item) => item.status === "leased")?.count || 0;
  const reconcilingCommandCount = commandCounts.find((item) => item.status === "reconciling")?.count || 0;
  const pendingCommandCount = queuedCommandCount + leasedCommandCount + reconcilingCommandCount;
  const pendingApprovalCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_approvals
    WHERE session_id = ?
      AND status = 'pending'
  `).get(row.id).count;
  const pendingInteractionCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_interactions
    WHERE session_id = ?
      AND status = 'pending'
  `).get(row.id).count;
  const pendingUserInputCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_interactions
    WHERE session_id = ?
      AND status = 'pending'
      AND kind = 'user_input'
  `).get(row.id).count;
  const messageCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM codex_session_messages
    WHERE session_id = ?
  `).get(row.id).count;
  const artifactStats = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS sizeBytes
    FROM codex_session_artifacts
    WHERE session_id = ?
  `).get(row.id);
  const contextUsage = latestSessionContextUsage(row.id);
  const composerMode = latestSessionComposerMode(row.id);

  return {
    ...row,
    runtime: parseJson(row.runtimeJson, {}),
    execution: parseJson(row.executionJson, {}),
    memory: parseJson(row.memoryJson, {}),
    restartOperation: latestRestartOperation(row.id),
    composerMode,
    contextUsage,
    eventCount,
    lastEventId: lastEvent?.id || 0,
    messageCount,
    artifactCount: artifactStats.count || 0,
    artifactBytes: artifactStats.sizeBytes || 0,
    metrics: sessionMetrics(row, {
      eventCount,
      messageCount,
      artifactCount: artifactStats.count || 0,
      artifactBytes: artifactStats.sizeBytes || 0,
      contextUsage
    }),
    pendingCommandCount,
    queuedCommandCount,
    leasedCommandCount,
    reconcilingCommandCount,
    pendingApprovalCount,
    pendingInteractionCount,
    pendingUserInputCount,
    queueBlocker: sessionQueueBlocker(row, {
      queuedCommandCount,
      pendingCommandCount
    }),
    lastEvent: lastEvent ? parseEvent(lastEvent, { includeRaw: false }) : null
  };
}

function sessionForUser(session, user) {
  if (!session || !user) return session;
  const execution = session.execution && typeof session.execution === "object" ? session.execution : {};
  if (execution.mode !== "worktree") return session;
  const { path: _path, basePath: _basePath, appliedTo: _appliedTo, ...publicExecution } = execution;
  return { ...session, execution: publicExecution };
}

function sessionQueueBlocker(row, counts = {}) {
  const queuedCommandCount = Number(counts.queuedCommandCount || 0) || 0;
  const pendingCommandCount = Number(counts.pendingCommandCount || 0) || 0;
  if (row.status !== "queued" && queuedCommandCount <= 0) return null;
  if (pendingCommandCount <= 0 && row.status !== "queued") return null;

  const projectId = String(row.projectId || "").trim();
  if (!projectId || sessionUsesIsolatedExecution(row)) return null;

  const blockers = db.prepare(`
    SELECT ${summarizeSessionColumns}
    FROM codex_sessions
    WHERE id <> @id
      AND project_id = @projectId
      AND archived_at IS NULL
      AND status IN ('starting', 'running')
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 5
  `).all({ id: row.id, projectId });

  const blocker = blockers.find((item) => !sessionUsesIsolatedExecution(item));
  if (!blocker) return null;

  return {
    type: "project_busy",
    projectId,
    blockedBySessionId: blocker.id,
    blockedByTitle: String(blocker.title || "").slice(0, 160),
    blockedByStatus: blocker.status,
    blockedByAgentId: String(blocker.leasedBy || "").trim(),
    text: "Another turn is using this project's main checkout."
  };
}

function sessionUsesIsolatedExecution(row = {}) {
  const execution = parseJson(row.executionJson, {});
  if (String(execution.mode || "").trim() === "worktree") return true;
  if (String(execution.path || "").trim()) return true;

  const runtime = parseJson(row.runtimeJson, {});
  return String(runtime.worktreeMode || "").trim() === "always";
}

function latestSessionContextUsage(sessionId, options = {}) {
  const row = selectLatestSessionContextUsage.get(sessionId);
  if (!row) return null;
  const reset = selectLatestSessionContextReset.get(sessionId);
  if (reset && Number(row.id || 0) <= Number(reset.id || 0)) return null;
  const raw = parseJson(row.rawJson, null);
  const contextUsage = normalizeContextUsagePayload(raw);
  if (!contextUsage) return null;
  const usage = {
    source: String(contextUsage.source || raw?.source || "backend"),
    at: row.at || "",
    threadId: String(contextUsage.threadId || "").slice(0, 200),
    turnId: String(contextUsage.turnId || "").slice(0, 200),
    ...contextUsage
  };
  if (options.includeEventId) usage.eventId = Number(row.id || 0) || 0;
  return usage;
}

function shouldQueueAutomaticCompaction(sessionId, session = {}) {
  if (session.archivedAt) return false;
  if (!runtimeSupports(session.runtime, "compaction") || !runtimeSupports(session.runtime, "contextUsage")) return false;
  if (!session.appThreadId) return false;
  if (!sessionCanCompact(session)) return false;
  if (selectPendingSessionCompactCommand.get(sessionId)) return false;

  const contextUsage = latestSessionContextUsage(sessionId, { includeEventId: true });
  if (!contextUsage) return false;

  const marker = selectLatestSessionCompactionMarker.get(sessionId);
  if (marker && Number(contextUsage.eventId || 0) <= Number(marker.id || 0)) return false;

  const percent = contextUsagePercent(contextUsage);
  return Number.isFinite(percent) && percent >= autoCompactContextPercent;
}

function latestSessionComposerMode(sessionId) {
  const row = db.prepare(`
    SELECT payload_json AS payloadJson
    FROM codex_session_commands
    WHERE session_id = ?
      AND type IN ('start', 'message')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(sessionId);
  if (!row) return "execute";
  return normalizeSessionMode(parseJson(row.payloadJson, {})?.mode);
}

function latestSessionComposerModeBefore(sessionId, commandId) {
  const row = db.prepare(`
    SELECT payload_json AS payloadJson
    FROM codex_session_commands
    WHERE session_id = ?
      AND id <> ?
      AND type IN ('start', 'message')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(sessionId, commandId);
  if (!row) return "execute";
  return normalizeSessionMode(parseJson(row.payloadJson, {})?.mode);
}

function sessionHadPlanModeBefore(sessionId, commandId) {
  const rows = db.prepare(`
    SELECT payload_json AS payloadJson
    FROM codex_session_commands
    WHERE session_id = ?
      AND id <> ?
      AND type IN ('start', 'message')
  `).all(sessionId, commandId);
  return rows.some((row) => normalizeSessionMode(parseJson(row.payloadJson, {})?.mode) === "plan");
}

function summarizeSessionCommand(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    result: parseJson(row.resultJson, null)
  };
}

function buildSessionCommandRetryPlan({ command = {}, session = {}, result = {}, agentId = "", error = "", now = nowIso() } = {}) {
  if (!config.codex.retryTransientErrors) return null;
  if (!["start", "message"].includes(command.type)) return null;
  if (session.archivedAt || ["closed", "cancelled", "stale"].includes(session.status)) return null;

  const retryError = retryableUpstreamError(error || result.error || session.lastError || "");
  if (!retryError) return null;

  const currentPayload = command.payload && typeof command.payload === "object" ? command.payload : parseJson(command.payloadJson, {});
  const commandRuntime = parseJson(command.runtimeJson, command.runtime || {});
  const agentRuntime = runtimeForAgentAndProject(agentId, session.projectId || command.projectId);
  const sessionRuntime = session.runtime && typeof session.runtime === "object" ? session.runtime : parseJson(session.runtimeJson, {});
  if (!isCodexRuntime(commandRuntime) && !isCodexRuntime(sessionRuntime) && !isCodexRuntime(agentRuntime)) return null;
  const previousRetry = currentPayload.retry && typeof currentPayload.retry === "object" ? currentPayload.retry : {};
  const attempt = Math.max(0, Number(previousRetry.attempt || 0) || 0) + 1;
  const maxAttempts = Math.max(0, Number(config.codex.retryMaxAttempts || 0) || 0);
  if (attempt > maxAttempts) return null;

  const retryContext = retryRuntimeContext({ command, session, currentPayload, previousRetry, agentRuntime });
  const downgradeReasoning = Boolean(config.codex.retryDowngradeReasoning && attempt > 1);
  const nextReasoningEffort = downgradeReasoning
    ? downgradedReasoningEffort(retryContext.originalReasoningEffort)
    : retryContext.originalReasoningEffort;
  const runtimeOverride = {
    model: retryContext.originalModel,
    reasoningEffort: nextReasoningEffort
  };
  const delayMs = Math.max(1000, Number(config.codex.retryDelayMs || 60000) || 60000);
  const availableAt = new Date(Date.parse(now) + delayMs).toISOString();
  const payload = {
    ...currentPayload,
    retry: {
      attempt,
      maxAttempts,
      availableAt,
      delayMs,
      error: retryError.slice(0, 12000),
      originalModel: retryContext.originalModel,
      originalReasoningEffort: retryContext.originalReasoningEffort,
      runtimeOverride,
      downgradedReasoning: downgradeReasoning && nextReasoningEffort !== retryContext.originalReasoningEffort
    }
  };

  return {
    command,
    attempt,
    maxAttempts,
    delayMs,
    availableAt,
    error: retryError.slice(0, 12000),
    lastError: `Transient Codex upstream error; retrying attempt ${attempt}/${maxAttempts} at ${availableAt}. ${retryError}`.slice(0, 12000),
    text: retryScheduledText({ attempt, maxAttempts, delayMs, retryError, runtimeOverride, downgradedReasoning: payload.retry.downgradedReasoning }),
    payload,
    runtimeOverride,
    downgradedReasoning: payload.retry.downgradedReasoning
  };
}

function buildSessionEventRetryPlan({ session = {}, update = {}, agentId = "", now = nowIso() } = {}) {
  if (!update || update.status !== "failed") return null;
  const retryError = retryableUpstreamError(update.lastError || session.lastError || "");
  if (!retryError) return null;

  const command = latestRetryableCompletedSessionCommand(session.id);
  if (!command) return null;
  return buildSessionCommandRetryPlan({
    command,
    session,
    result: {
      ok: false,
      error: retryError,
      appThreadId: update.appThreadId || session.appThreadId || ""
    },
    agentId,
    error: retryError,
    now
  });
}

function latestRetryableCompletedSessionCommand(sessionId) {
  const row = db.prepare(`
    SELECT
      c.id,
      c.session_id AS sessionId,
      c.type,
      c.payload_json AS payloadJson,
      c.status,
      c.created_at AS createdAt,
      c.updated_at AS updatedAt,
      c.available_at AS availableAt,
      c.leased_by AS leasedBy,
      c.lease_expires_at AS leaseExpiresAt,
      c.error,
      s.project_id AS projectId,
      s.runtime_json AS runtimeJson,
      s.app_thread_id AS appThreadId,
      s.active_turn_id AS activeTurnId
    FROM codex_session_commands c
    JOIN codex_sessions s ON s.id = c.session_id
    WHERE c.session_id = ?
      AND c.type IN ('start', 'message')
      AND c.status IN ('done', 'failed')
    ORDER BY c.updated_at DESC, c.created_at DESC
    LIMIT 1
  `).get(sessionId);
  return row ? summarizeSessionCommand(row) : null;
}

function retryRuntimeContext({ command = {}, session = {}, currentPayload = {}, previousRetry = {}, agentRuntime = {} } = {}) {
  const previousOverride = previousRetry.runtimeOverride && typeof previousRetry.runtimeOverride === "object" ? previousRetry.runtimeOverride : {};
  const commandRuntime = parseJson(command.runtimeJson, command.runtime || {});
  const sessionRuntime = session.runtime && typeof session.runtime === "object" ? session.runtime : parseJson(session.runtimeJson, {});
  const originalModel = String(
    previousRetry.originalModel ||
      previousOverride.model ||
      commandRuntime.retryOverride?.model ||
      commandRuntime.model ||
      sessionRuntime.model ||
      agentRuntime.model ||
      ""
  ).trim();
  const originalReasoningEffort = normalizeReasoningEffort(
    previousRetry.originalReasoningEffort ||
      previousOverride.reasoningEffort ||
      commandRuntime.retryOverride?.reasoningEffort ||
      commandRuntime.reasoningEffort ||
      commandRuntime.effort ||
      sessionRuntime.reasoningEffort ||
      sessionRuntime.effort ||
      agentRuntime.reasoningEffort ||
      currentPayload.reasoningEffort ||
      ""
  );
  return { originalModel, originalReasoningEffort };
}

function retryableUpstreamError(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/\b(?:HTTP\s*)?(?:429|500|502|503|504)\b/i.test(text)) return text;
  if (/too many requests|rate[ _-]?limit|rate limited|rate_limited|temporarily unavailable|service unavailable|bad gateway|gateway timeout|overloaded|capacity|upstream|限流|速率限制|请求过多|暂时不可用/i.test(text)) {
    return text;
  }
  return "";
}

function downgradedReasoningEffort(value) {
  const normalized = normalizeReasoningEffort(value);
  if (!normalized) return "";
  const index = reasoningEffortOrder.indexOf(normalized);
  if (index <= 0) return normalized;
  return reasoningEffortOrder[index - 1];
}

function retryScheduledText({ attempt, maxAttempts, delayMs, retryError, runtimeOverride = {}, downgradedReasoning = false }) {
  const delaySeconds = Math.max(1, Math.round(delayMs / 1000));
  const parts = [`Transient Codex upstream error; retry ${attempt}/${maxAttempts} scheduled in ${delaySeconds}s.`];
  if (runtimeOverride.model) parts.push(`model=${runtimeOverride.model}`);
  if (runtimeOverride.reasoningEffort) parts.push(`reasoning=${runtimeOverride.reasoningEffort}${downgradedReasoning ? " (downgraded)" : ""}`);
  parts.push(String(retryError || "").slice(0, 500));
  return parts.filter(Boolean).join(" ");
}

function summarizeWorkspaceCommand(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    result: parseJson(row.resultJson, {})
  };
}

function summarizeFileRequest(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    result: parseJson(row.resultJson, {})
  };
}

function summarizeQuickSkill(row) {
  return {
    ...row,
    requiresSession: Boolean(row.requiresSession)
  };
}

function summarizeSessionMessage(row, attachments = []) {
  return {
    ...row,
    attachments
  };
}

function summarizeSessionAttachment(row) {
  return {
    ...row,
    name: row.originalName,
    downloadPath: `/api/codex/attachments/${encodeURIComponent(row.id)}`
  };
}

function summarizeSessionArtifact(row) {
  return {
    ...row,
    name: row.label,
    downloadPath: `/api/codex/artifacts/${encodeURIComponent(row.id)}`
  };
}

function sessionMetrics(row, stats = {}) {
  const startedAt = row.startedAt || row.createdAt || "";
  const finishedAt = row.completedAt || "";
  const startMs = Date.parse(startedAt);
  const endMs = Date.parse(["queued", "starting", "running"].includes(row.status) ? new Date().toISOString() : finishedAt || row.updatedAt || "");
  const elapsedMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : 0;
  const contextPercent = contextUsagePercent(stats.contextUsage);
  const risk = sessionRiskLevel({
    eventCount: stats.eventCount,
    messageCount: stats.messageCount,
    artifactBytes: stats.artifactBytes,
    contextPercent
  });

  return {
    elapsedMs,
    eventCount: stats.eventCount || 0,
    messageCount: stats.messageCount || 0,
    artifactCount: stats.artifactCount || 0,
    artifactBytes: stats.artifactBytes || 0,
    contextPercent,
    risk
  };
}

function contextUsagePercent(contextUsage) {
  const used = Number(contextUsage?.last?.totalTokens || contextUsage?.usedTokens || 0);
  const limit = Number(contextUsage?.modelContextWindow || contextUsage?.limitTokens || 0);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || used <= 0 || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

function sessionRiskLevel({ eventCount = 0, messageCount = 0, artifactBytes = 0, contextPercent = null } = {}) {
  if (Number(contextPercent) >= 85 || Number(eventCount) >= 160 || Number(messageCount) >= 28 || Number(artifactBytes) >= 2 * 1024 * 1024) {
    return "high";
  }
  if (Number(contextPercent) >= 70 || Number(eventCount) >= 100 || Number(messageCount) >= 18 || Number(artifactBytes) >= 768 * 1024) {
    return "warn";
  }
  return "normal";
}

function shouldRefreshSessionMemory(events = []) {
  return events.some((event) => {
    const method = event?.raw?.method || event?.type || "";
    return method === "turn/completed" || method === "thread/compacted" || method === "git.summary" || method === "test.summary";
  });
}

function buildSessionMemory(sessionId, session = {}, events = [], fallbackAt = nowIso()) {
  const messages = listSessionMessages(sessionId)
    .filter((message) => ["user", "assistant"].includes(message.role))
    .filter((message) => String(message.text || "").trim());
  const userMessages = messages.filter((message) => message.role === "user").map((message) => String(message.text || "").trim());
  const assistantMessages = messages.filter((message) => message.role === "assistant").map((message) => String(message.text || "").trim());
  const incomingAssistant = events
    .map((event) => String(memoryAssistantTextFromEvent(event)).trim())
    .filter(Boolean)
    .at(-1);
  const latestAssistant = incomingAssistant || assistantMessages.at(-1) || session.finalMessage || "";
  const gitSummary = latestRawValue(events, "git.summary", "gitSummary");
  const testSummary = latestRawValue(events, "test.summary", "testSummary");
  const plan = events
    .map((event) => event.type === "turn/plan/updated" || event.raw?.params?.item?.type === "plan" ? String(event.text || event.raw?.params?.item?.text || "").trim() : "")
    .filter(Boolean)
    .at(-1) || "";
  const previousMemory = parseJson(session.memoryJson, {});

  const memory = {
    version: 1,
    sourceSessionId: sessionId,
    projectId: session.projectId || "",
    updatedAt: String(fallbackAt || nowIso()),
    title: session.title || userMessages[0] || "agent session",
    goal: previousMemory.goal || userMessages[0] || session.title || "",
    recentUserRequests: userMessages.slice(-6).map((text) => text.slice(0, 1200)),
    latestAssistantResult: String(latestAssistant || "").slice(0, 2400),
    latestPlan: plan.slice(0, 2000),
    gitSummary: compactMemoryGitSummary(gitSummary),
    testSummary: compactMemoryTestSummary(testSummary),
    notes: []
  };
  memory.summary = formatSessionMemory(memory);
  return memory;
}

function memoryAssistantTextFromEvent(event = {}) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
  const item = raw.params?.item;
  if (assistantImageArtifactRefs(raw).length > 0) return assistantImageEventDisplayText(raw, event.text);
  if (item?.type === "agentMessage") return item.text || event.finalMessage || event.text || "";
  return event.finalMessage || "";
}

function latestRawValue(events, eventType, key) {
  for (const event of [...(events || [])].reverse()) {
    if (event.type !== eventType) continue;
    const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
    if (raw[key]) return raw[key];
    if (raw.method === eventType && raw[key]) return raw[key];
  }
  return null;
}

function compactMemoryGitSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const changedDuringTurn = summary.changedDuringTurn && typeof summary.changedDuringTurn === "object" ? summary.changedDuringTurn : null;
  return {
    branch: String(summary.branch || "").slice(0, 120),
    commit: String(summary.commit || "").slice(0, 80),
    changedFiles: (changedDuringTurn?.changedFiles || summary.changedFiles || []).slice(0, 40),
    changedThisTurn: Boolean(changedDuringTurn),
    worktreeRoot: String(summary.root || "").slice(0, 500)
  };
}

function compactMemoryTestSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  return {
    level: String(summary.level || "").slice(0, 80),
    status: String(summary.status || "").slice(0, 80),
    command: String(summary.command || "").slice(0, 500),
    failures: Array.isArray(summary.failures) ? summary.failures.slice(0, 5) : []
  };
}

function formatSessionMemory(memory) {
  const lines = [];
  if (memory.goal) lines.push(`Goal: ${memory.goal}`);
  if (memory.recentUserRequests?.length) {
    lines.push("Recent user requests:");
    for (const request of memory.recentUserRequests.slice(-4)) lines.push(`- ${request}`);
  }
  if (memory.latestAssistantResult) lines.push(`Latest agent result: ${memory.latestAssistantResult}`);
  if (memory.latestPlan) lines.push(`Latest plan: ${memory.latestPlan}`);
  if (memory.gitSummary) {
    const files = memory.gitSummary.changedFiles || [];
    lines.push(`Git: ${memory.gitSummary.branch || "unknown"} ${memory.gitSummary.commit || ""}`.trim());
    if (files.length) lines.push(`Changed files: ${files.slice(0, 12).join(", ")}`);
  }
  if (memory.testSummary) {
    lines.push(`Tests: ${memory.testSummary.level || "checks"} ${memory.testSummary.status || ""} ${memory.testSummary.command || ""}`.trim());
    for (const failure of memory.testSummary.failures || []) lines.push(`- ${failure}`);
  }
  return lines.join("\n").slice(0, 8000);
}

function sourceSessionMemory(sourceSessionId, projectId, ownerUser = "", targetAgentId = "") {
  const sourceId = String(sourceSessionId || "").trim();
  if (!sourceId) return null;
  const source = getSessionSummary(sourceId);
  if (!source || source.projectId !== projectId) return null;
  if (normalizeOwnerUser(source.ownerUser) !== normalizeOwnerUser(ownerUser)) return null;
  if (normalizeTargetAgentId(targetAgentId) && source.targetAgentId && source.targetAgentId !== normalizeTargetAgentId(targetAgentId)) return null;
  const memory = source.memory && typeof source.memory === "object" && source.memory.summary ? source.memory : buildSessionMemory(source.id, source, [], nowIso());
  return {
    ...memory,
    sourceSessionId: source.id
  };
}

function forkSummaryPrompt(prompt, memory) {
  return [
    "这是从 Echo 旧会话摘要继续的新后端会话。完整历史不可见，请只依赖下面摘要和当前用户请求继续；不要要求用户重复上下文，除非摘要不足以安全执行。",
    "",
    "旧会话摘要：",
    memory.summary || formatSessionMemory(memory),
    "",
    "当前用户请求：",
    String(prompt || "").trim() || "（本条消息只有附件，请结合附件继续。）"
  ].join("\n").slice(0, 12000);
}

function getSessionApprovalSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionApproval(row) : null;
}

function getSessionInteractionSummary(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionInteraction(row) : null;
}

function summarizeSessionApproval(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    response: parseJson(row.responseJson, null)
  };
}

function summarizeSessionInteraction(row) {
  return {
    ...row,
    payload: parseJson(row.payloadJson, {}),
    response: parseJson(row.responseJson, null)
  };
}

function listEvents(jobId) {
  return db.prepare(`
    SELECT id, at, type, text, raw_json AS rawJson
    FROM codex_events
    WHERE job_id = ?
    ORDER BY id ASC
  `).all(jobId).map(parseEvent);
}

function listSessionEvents(sessionId, options = {}) {
  const maxEvents = Number(options.maxEvents || 0);
  const afterEventId = Math.max(0, Math.floor(Number(options.afterEventId || 0) || 0));
  if (afterEventId > 0) {
    const limit = Math.min(Math.max(1, Math.round(maxEvents || config.codex.maxEvents)), config.codex.maxEvents);
    return db.prepare(`
      SELECT id, at, type, text, raw_json AS rawJson
      FROM codex_session_events
      WHERE session_id = ?
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(sessionId, afterEventId, limit).map((row) => parseEvent(row, options));
  }
  if (maxEvents > 0) {
    return db.prepare(`
      SELECT id, at, type, text, rawJson
      FROM (
        SELECT id, at, type, text, raw_json AS rawJson
        FROM codex_session_events
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `).all(sessionId, Math.min(Math.max(1, Math.round(maxEvents)), config.codex.maxEvents)).map((row) => parseEvent(row, options));
  }
  return db.prepare(`
    SELECT id, at, type, text, raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId).map((row) => parseEvent(row, options));
}

function listSessionMessages(sessionId) {
  const rows = db.prepare(`
    SELECT ${summarizeSessionMessageColumns}
    FROM codex_session_messages
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(sessionId);
  const attachmentsByMessageId = listSessionAttachmentsBySession(sessionId);
  return rows.map((row) => summarizeSessionMessage(row, attachmentsByMessageId.get(row.id) || []));
}

function getSessionMessage(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionMessageColumns}
    FROM codex_session_messages
    WHERE id = ?
  `).get(id);
  if (!row) return null;
  return summarizeSessionMessage(row, listMessageAttachments(id));
}

function getSessionAttachment(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionAttachmentColumns}
    FROM codex_session_attachments
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionAttachment(row) : null;
}

function getSessionArtifact(id) {
  const row = db.prepare(`
    SELECT ${summarizeSessionArtifactColumns}
    FROM codex_session_artifacts
    WHERE id = ?
  `).get(id);
  return row ? summarizeSessionArtifact(row) : null;
}

function getQuickSkill(id) {
  const row = db.prepare(`
    SELECT ${summarizeQuickSkillColumns}
    FROM codex_quick_skills
    WHERE id = ?
  `).get(String(id || "").trim());
  return row ? summarizeQuickSkill(row) : null;
}

function ensureDefaultQuickSkills() {
  const now = nowIso();
  const quickDeployPrompt = defaultQuickDeployPrompt();
  db.prepare(`
    INSERT OR IGNORE INTO codex_quick_skills (
      id, scope, project_id, target_agent_id, title, description, prompt, mode, requires_session, sort_order, created_at, updated_at, archived_at
    ) VALUES (
      'builtin.quick-deploy',
      'global',
      '',
      '',
      '提交推送部署',
      '提交当前结果，合入主部署分支并等待部署完成。',
      @prompt,
      'execute',
      1,
      10,
      @now,
      @now,
      NULL
    )
  `).run({ prompt: quickDeployPrompt, now });

  db.prepare(`
    UPDATE codex_quick_skills
    SET archived_at = @now,
        updated_at = @now
    WHERE id = 'builtin.echo-relay-deploy'
      AND archived_at IS NULL
  `).run({ now });
}

function nextQuickSkillSortOrder(scope, projectId, targetAgentId = "") {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) AS maxOrder
    FROM codex_quick_skills
    WHERE scope = ?
      AND project_id = ?
      AND target_agent_id = ?
      AND archived_at IS NULL
  `).get(scope, projectId, targetAgentId);
  return Number(row?.maxOrder || 0) + 10;
}

function normalizeQuickSkillInput(input = {}, existing = null) {
  const scope = normalizeQuickSkillScope(input.scope ?? existing?.scope ?? "");
  const projectId = scope === "project" ? normalizeQuickSkillProjectId(input.projectId ?? existing?.projectId ?? "") : "";
  const targetAgentId = scope === "project" ? normalizeTargetAgentId(input.targetAgentId ?? existing?.targetAgentId ?? "") : "";
  if (scope === "project" && !projectId) return badRequest("Project quick skills require a project id.");

  const title = String(input.title ?? existing?.title ?? "").trim().slice(0, 80);
  if (!title) return badRequest("Quick skill title is required.");

  const prompt = String(input.prompt ?? existing?.prompt ?? "").trim().slice(0, 12000);
  if (!prompt) return badRequest("Quick skill prompt is required.");

  return {
    scope,
    projectId,
    targetAgentId,
    title,
    description: String(input.description ?? existing?.description ?? "").trim().slice(0, 240),
    prompt,
    mode: normalizeSessionMode(input.mode ?? existing?.mode ?? "execute"),
    requiresSession:
      input.requiresSession === undefined && existing
        ? Boolean(existing.requiresSession)
        : input.requiresSession === true || input.requiresSession === "true" || input.requiresSession === 1
  };
}

function normalizeQuickSkillScope(value) {
  const scope = String(value || "").trim().toLowerCase();
  return scope === "global" ? "global" : "project";
}

function normalizeQuickSkillProjectId(value) {
  return String(value || "").trim().slice(0, 160);
}

function listMessageAttachments(messageId) {
  return db.prepare(`
    SELECT ${summarizeSessionAttachmentColumns}
    FROM codex_session_attachments
    WHERE message_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(messageId).map(summarizeSessionAttachment);
}

function listSessionAttachmentsBySession(sessionId) {
  const rows = db.prepare(`
    SELECT ${summarizeSessionAttachmentColumns}
    FROM codex_session_attachments
    WHERE session_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(sessionId);
  const byMessageId = new Map();
  for (const row of rows) {
    const attachment = summarizeSessionAttachment(row);
    const existing = byMessageId.get(attachment.messageId) || [];
    existing.push(attachment);
    byMessageId.set(attachment.messageId, existing);
  }
  return byMessageId;
}

function listSessionArtifacts(sessionId, limit = 30) {
  return db.prepare(`
    SELECT ${summarizeSessionArtifactColumns}
    FROM codex_session_artifacts
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(sessionId, Math.max(1, Math.min(Number(limit) || 30, 100))).map(summarizeSessionArtifact);
}

function listSessionApprovals(sessionId) {
  return db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE session_id = ?
      AND status = 'pending'
    ORDER BY created_at ASC
  `).all(sessionId).map(summarizeSessionApproval);
}

function listSessionInteractions(sessionId) {
  return db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE session_id = ?
      AND status = 'pending'
    ORDER BY created_at ASC
  `).all(sessionId).map(summarizeSessionInteraction);
}

function sessionHasLeasedCommand(sessionId) {
  return (
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM codex_session_commands
      WHERE session_id = ?
        AND status IN ('leased', 'reconciling')
    `).get(sessionId).count > 0
  );
}

function sessionCompletedAsyncWorkSince(sessionId, sinceAt = "", expectedTurnId = "", commandType = "", expectedThreadId = "") {
  const normalizedExpectedTurnId = String(expectedTurnId || "");
  const normalizedExpectedThreadId = String(expectedThreadId || "");
  const allowCompactionCompletion = commandType === "compact";
  const rows = db.prepare(`
    SELECT type, raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
      AND (? = '' OR at >= ?)
    ORDER BY id DESC
    LIMIT 120
  `).all(sessionId, String(sinceAt || ""), String(sinceAt || ""));

  for (const row of rows) {
    const raw = parseJson(row.rawJson, {});
    const method = raw?.method || row.type || "";
    const params = raw?.params || {};
    const threadId = String(params.threadId || params.thread?.id || params.item?.threadId || "");
    const turnId = String(params.turn?.id || params.turnId || "");
    const itemType = raw?.params?.item?.type || "";
    if (
      method === "turn/completed" &&
      threadMatchesExpected(threadId, normalizedExpectedThreadId) &&
      turnMatchesExpected(turnId, normalizedExpectedTurnId)
    ) {
      const status = params.turn?.status === "failed" ? "failed" : "active";
      return {
        status,
        error: String(params.turn?.error?.message || "").slice(0, 12000)
      };
    }
    if (
      allowCompactionCompletion &&
      threadMatchesExpected(threadId, normalizedExpectedThreadId) &&
      method === "thread/compacted"
    ) {
      return { status: "active", error: "" };
    }
    if (
      allowCompactionCompletion &&
      threadMatchesExpected(threadId, normalizedExpectedThreadId) &&
      method === "item/completed" &&
      itemType === "contextCompaction"
    ) {
      return { status: "active", error: "" };
    }
  }

  return null;
}

function turnMatchesExpected(turnId, expectedTurnId) {
  return !expectedTurnId || !turnId || turnId === expectedTurnId;
}

function threadMatchesExpected(threadId, expectedThreadId) {
  return !expectedThreadId || !threadId || threadId === expectedThreadId;
}

function sessionHasQueuedStopCommand(sessionId) {
  return (
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM codex_session_commands
      WHERE session_id = ?
        AND type = 'stop'
        AND status IN ('queued', 'leased', 'reconciling')
    `).get(sessionId).count > 0
  );
}

function sessionHasQueuedContinuationCommand(sessionId) {
  const row = db.prepare(`
    SELECT 1
    FROM codex_session_commands
    WHERE session_id = ?
      AND status = 'queued'
      AND type <> 'start'
    LIMIT 1
  `).get(sessionId);
  return Boolean(row);
}

function sessionHasRecoverableDesktopWorkSql(leaseHolderRef) {
  return `EXISTS (
          SELECT 1
          FROM codex_session_commands c
          WHERE c.session_id = codex_sessions.id
            AND c.status IN ('leased', 'reconciling')
            AND c.leased_by = ${leaseHolderRef}
        )
        OR EXISTS (
          SELECT 1
          FROM codex_session_approvals a
          WHERE a.session_id = codex_sessions.id
            AND a.status = 'pending'
            AND a.requested_by = ${leaseHolderRef}
        )
        OR EXISTS (
          SELECT 1
          FROM codex_session_interactions i
          WHERE i.session_id = codex_sessions.id
            AND i.status = 'pending'
            AND i.requested_by = ${leaseHolderRef}
        )`;
}

function denyPendingSessionApprovals(sessionId, now, decidedBy) {
  const approvals = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE session_id = ?
      AND status = 'pending'
  `).all(sessionId).map(summarizeSessionApproval);

  for (const approval of approvals) {
    const response = buildApprovalResponse(approval.method, "denied");
    db.prepare(`
      UPDATE codex_session_approvals
      SET status = 'denied',
          response_json = @responseJson,
          decided_at = @now,
          decided_by = @decidedBy,
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id: approval.id,
      responseJson: JSON.stringify(response),
      now,
      decidedBy
    });

    insertSessionEvent.run(
      normalizeSessionEvent(approval.sessionId, {
        type: "approval.denied",
        text: `${approval.method} denied by cancellation.`,
        raw: { approvalId: approval.id, response }
      }, now)
    );
  }
}

function cancelPendingSessionInteractions(sessionId, now, answeredBy) {
  const interactions = db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE session_id = ?
      AND status = 'pending'
  `).all(sessionId).map(summarizeSessionInteraction);

  for (const interaction of interactions) {
    const response = buildInteractionResponse(interaction, {}, "cancelled");
    db.prepare(`
      UPDATE codex_session_interactions
      SET status = 'cancelled',
          response_json = @responseJson,
          answered_at = @now,
          answered_by = @answeredBy,
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id: interaction.id,
      responseJson: JSON.stringify(response),
      now,
      answeredBy
    });

    insertSessionEvent.run(
      normalizeSessionEvent(interaction.sessionId, {
        type: "interaction.cancelled",
        text: `${interaction.method || "Interaction"} cancelled.`,
        raw: { interactionId: interaction.id, response: redactInteractionResponseForEvent(interaction, response) }
      }, now)
    );
  }
}

function serverRequestResolutionsFromEvents(events = []) {
  return events
    .map((event) => {
      const raw = event?.raw || {};
      const method = raw.method || event?.type || "";
      if (method !== "serverRequest/resolved") return null;
      const requestId = raw.params?.requestId;
      if (requestId === undefined || requestId === null) return null;
      return { requestId: String(requestId) };
    })
    .filter(Boolean);
}

function testSummaryFromEvent(event = {}) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
  const method = raw.method || event.type || "";
  if (method !== "item/completed") return null;
  const item = raw.params?.item;
  if (!item || item.type !== "commandExecution") return null;

  const command = Array.isArray(item.command) ? item.command.join(" ") : String(item.command || "");
  if (!isTestCommand(command)) return null;

  const statusText = String(item.status || "").toLowerCase();
  const output = String(item.aggregatedOutput || "");
  const failed = statusText.includes("fail") || statusText.includes("error") || /(^|\n)\s*(FAIL|Failed|Error:|AssertionError|TimeoutError)\b/.test(output);
  const outputArtifact = item.outputArtifact && typeof item.outputArtifact === "object" ? compactArtifactRef(item.outputArtifact) : null;
  return {
    level: testCommandLevel(command),
    command: command.slice(0, 1000),
    status: failed ? "failed" : statusText.includes("cancel") ? "cancelled" : "passed",
    outputBytes: byteLength(output),
    outputArtifact,
    failures: extractTestFailures(output),
    turnId: String(raw.params?.turnId || raw.params?.turn?.id || "").slice(0, 200)
  };
}

function isTestCommand(command) {
  const text = String(command || "").toLowerCase();
  return /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|check|lint|typecheck|tsc)\b/.test(text) ||
    /\b(node\s+--test|pytest|vitest|jest|playwright|cypress|ava|mocha|tap)\b/.test(text);
}

function testCommandLevel(command) {
  const text = String(command || "").toLowerCase();
  if (/\b(e2e|playwright|cypress)\b/.test(text)) return "e2e";
  if (/\b(smoke|browser)\b/.test(text)) return "browser-smoke";
  if (/\b(integration|integ)\b/.test(text)) return "integration";
  return "quick";
}

function extractTestFailures(output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const failures = [];
  for (const line of lines) {
    if (!/(FAIL|Failed|Error:|AssertionError|TimeoutError|expected|received|not ok)/i.test(line)) continue;
    failures.push(line.replace(/\b(token|secret|password|api[_-]?key)\b\s*[:=]\s*[^,\s]+/gi, "$1=***").slice(0, 240));
    if (failures.length >= 8) break;
  }
  return failures;
}

function formatTestSummaryEventText(summary) {
  const label = {
    quick: "Quick checks",
    integration: "Integration checks",
    "browser-smoke": "Browser smoke",
    e2e: "E2E"
  }[summary.level] || "Checks";
  const lines = [`${label}: ${summary.status}`, summary.command];
  if (summary.failures?.length) lines.push(...summary.failures.slice(0, 5).map((failure) => `- ${failure}`));
  if (summary.outputArtifact?.downloadPath) lines.push(`Full output: ${summary.outputArtifact.downloadPath}`);
  return lines.filter(Boolean).join("\n");
}

function resolvePendingServerRequest(sessionId, appRequestId, now) {
  const requestId = String(appRequestId || "");
  if (!requestId) return;

  const interactions = db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE session_id = ?
      AND app_request_id = ?
      AND status = 'pending'
  `).all(sessionId, requestId).map(summarizeSessionInteraction);

  for (const interaction of interactions) {
    const response = buildInteractionResponse(interaction, {}, "cancelled");
    db.prepare(`
      UPDATE codex_session_interactions
      SET status = 'cancelled',
          response_json = @responseJson,
          answered_at = @now,
          answered_by = 'serverRequest/resolved',
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id: interaction.id,
      responseJson: JSON.stringify(response),
      now
    });
  }

  const approvals = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE session_id = ?
      AND app_request_id = ?
      AND status = 'pending'
  `).all(sessionId, requestId).map(summarizeSessionApproval);

  for (const approval of approvals) {
    const response = buildApprovalResponse(approval.method, "denied");
    db.prepare(`
      UPDATE codex_session_approvals
      SET status = 'denied',
          response_json = @responseJson,
          decided_at = @now,
          decided_by = 'serverRequest/resolved',
          updated_at = @now
      WHERE id = @id
        AND status = 'pending'
    `).run({
      id: approval.id,
      responseJson: JSON.stringify(response),
      now
    });
  }
}

function insertInternalEvents(jobId, events) {
  const at = nowIso();
  for (const event of events) insertEvent.run(normalizeEvent(jobId, event, at));
  trimEvents.run(jobId, jobId, config.codex.maxEvents);
}

function normalizeEvent(jobId, event = {}, fallbackAt) {
  const redaction = event.raw && typeof event.raw === "object" ? redactSensitiveJson(event.raw) : { value: undefined, redacted: false };
  const type = String(event.type || "output").slice(0, 120);
  const text = truncateUtf8(String(event.text || ""), 8000);
  let raw = withEventDataMetadata(redaction.value, { redacted: redaction.redacted });
  let rawJson = raw ? JSON.stringify(raw) : null;
  if (storedEventBytes(type, text, rawJson) > maxStoredSessionEventBytes) {
    raw = boundedEventRaw(raw, type, { redacted: redaction.redacted, originalBytes: byteLength(rawJson) });
    rawJson = JSON.stringify(raw);
  }
  return {
    jobId,
    at: String(event.at || fallbackAt || nowIso()),
    type,
    text,
    rawJson
  };
}

function normalizeSessionEvent(sessionId, event = {}, fallbackAt) {
  const redaction = event.raw && typeof event.raw === "object" ? redactSensitiveJson(event.raw) : { value: undefined, redacted: false };
  const type = String(event.type || "output").slice(0, 120);
  const text = truncateUtf8(String(event.text || ""), 12000);
  let raw = withEventDataMetadata(redaction.value, { redacted: redaction.redacted });
  let rawJson = raw ? JSON.stringify(raw) : null;
  if (storedEventBytes(type, text, rawJson) > maxStoredSessionEventBytes) {
    raw = boundedEventRaw(raw, type, { redacted: redaction.redacted, originalBytes: byteLength(rawJson) });
    rawJson = JSON.stringify(raw);
  }
  return {
    sessionId,
    at: String(event.at || fallbackAt || nowIso()),
    type,
    text,
    rawJson,
    eventKey: protocolSessionEventKey(event)
  };
}

function normalizeSessionEventForStorage(sessionId, event = {}, fallbackAt) {
  const at = String(event.at || fallbackAt || nowIso());
  const type = String(event.type || "output").slice(0, 120);
  const artifacts = [];
  let text = String(event.text || "");
  const initialRedaction = event.raw && typeof event.raw === "object" ? redactSensitiveJson(event.raw) : { value: undefined, redacted: false };
  let redacted = initialRedaction.redacted;
  let truncated = false;
  let raw = initialRedaction.value;
  if (Array.isArray(event.attachments) && event.attachments.length > 0) {
    raw = raw && typeof raw === "object" ? { ...raw, attachments: event.attachments } : { attachments: event.attachments };
  }

  const finalRedaction = raw && typeof raw === "object" ? redactSensitiveJson(raw) : { value: raw, redacted: false };
  raw = finalRedaction.value;
  redacted ||= finalRedaction.redacted;

  const imageExtraction = extractImageArtifactsFromRaw(raw, { sessionId, createdAt: at });
  if (imageExtraction.artifacts.length > 0) {
    raw = imageExtraction.raw;
    artifacts.push(...imageExtraction.artifacts);
    text = assistantImageEventDisplayText(raw, text);
  }

  const assistantTextImageExtraction = extractAssistantImageArtifactsFromText(raw, text, { sessionId, createdAt: at });
  if (assistantTextImageExtraction.artifacts.length > 0 || assistantTextImageExtraction.text !== text) {
    raw = assistantTextImageExtraction.raw;
    text = assistantTextImageExtraction.text;
    artifacts.push(...assistantTextImageExtraction.artifacts);
  }

  const commandOutput = commandOutputFromRaw(raw);
  if (commandOutput && byteLength(commandOutput) > 4096) {
    const artifact = buildTextArtifact({
      sessionId,
      kind: "command_output",
      label: commandArtifactLabel(raw),
      content: commandOutput,
      createdAt: at
    });
    artifacts.push(artifact);
    const preview = tailPreview(commandOutput, 1600);
    raw = rawWithCommandOutputArtifact(raw, artifact, preview);
    text = commandEventText(raw, preview);
    truncated = true;
  }

  if (byteLength(text) > 12000) {
    const artifact = buildTextArtifact({
      sessionId,
      kind: "event_text",
      label: `${type} text`,
      content: text,
      createdAt: at
    });
    artifacts.push(artifact);
    text = `${headPreview(text, 800)}\n\n[Full text saved as artifact ${artifact.id}; ${artifact.sizeBytes} bytes]`;
    truncated = true;
  }

  raw = withEventDataMetadata(raw, {
    redacted,
    truncated,
    artifactized: artifacts.length > 0
  });
  let rawJson = raw ? JSON.stringify(raw) : null;
  if (rawJson && byteLength(rawJson) > 60000) {
    const originalBytes = byteLength(rawJson);
    raw = boundedEventRaw(raw, type, {
      redacted,
      artifactized: artifacts.length > 0,
      originalBytes
    });
    rawJson = JSON.stringify(raw);
    truncated = true;
  }

  if (storedEventBytes(type, text, rawJson) > maxStoredSessionEventBytes) {
    raw = boundedEventRaw(raw, type, {
      redacted,
      artifactized: artifacts.length > 0,
      originalBytes: storedEventBytes(type, text, rawJson)
    });
    rawJson = JSON.stringify(raw);
    truncated = true;
  }

  if (truncated && raw && !raw.truncated) {
    raw = { ...raw, truncated: true };
    rawJson = JSON.stringify(raw);
  }

  return {
    row: {
      sessionId,
      at,
      type,
      text: truncateUtf8(text, 12000),
      rawJson,
      eventKey: protocolSessionEventKey(event)
    },
    artifacts
  };
}

function commandOutputFromRaw(raw) {
  const item = raw?.params?.item;
  if (!item || item.type !== "commandExecution") return "";
  return String(item.aggregatedOutput || "");
}

function commandArtifactLabel(raw) {
  const item = raw?.params?.item || {};
  const command = compactCommand(item.command);
  const text = Array.isArray(command) ? command.join(" ") : command;
  return text ? `Command output: ${String(text).slice(0, 160)}` : "Command output";
}

function commandEventText(raw, preview) {
  const item = raw?.params?.item || {};
  const command = compactCommand(item.command);
  const commandText = Array.isArray(command) ? command.join(" ") : command || "command";
  const status = item.status || "completed";
  return `${commandText} ${status}\n${preview}`;
}

function rawWithCommandOutputArtifact(raw, artifact, preview) {
  const next = cloneJson(raw || {});
  const item = next?.params?.item;
  if (item && item.type === "commandExecution") {
    item.aggregatedOutput = preview;
    item.aggregatedOutputTruncated = true;
    item.outputArtifact = artifactRef(artifact);
  }
  return next;
}

function extractImageArtifactsFromRaw(raw, options = {}) {
  if (!raw || typeof raw !== "object") return { raw, artifacts: [] };

  const next = cloneJson(raw);
  const artifacts = [];
  const refs = [];

  const visit = (value, path = "", inheritedLabel = "") => {
    if (!value || artifacts.length >= maxImageArtifactsPerEvent) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, inheritedLabel));
      return;
    }
    if (typeof value !== "object") return;

    const candidate = imageArtifactCandidate(value, inheritedLabel);
    if (candidate) {
      if (candidate.buffer.length <= maxInlineImageArtifactBytes) {
        const artifact = buildBinaryArtifact({
          sessionId: options.sessionId,
          kind: "assistant_image",
          label: candidate.label,
          buffer: candidate.buffer,
          mimeType: candidate.mimeType,
          extension: candidate.extension,
          createdAt: options.createdAt
        });
        artifacts.push(artifact);
        const ref = artifactRef(artifact);
        refs.push(ref);
        replaceInlineImagePayload(value, ref);
      } else {
        replaceOversizedImagePayload(value, candidate);
      }
      return;
    }

    const nextLabel = imageLabelFromObject(value) || inheritedLabel;
    for (const [key, child] of Object.entries(value)) {
      if (key === "artifact" || key === "imageArtifact" || key === "imageArtifacts" || key === "outputArtifact") continue;
      visit(child, path ? `${path}.${key}` : key, nextLabel);
      if (artifacts.length >= maxImageArtifactsPerEvent) break;
    }
  };

  visit(next);

  if (refs.length > 0) {
    next.imageArtifacts = mergeArtifactRefs(next.imageArtifacts, refs);
    if (next.params?.item && typeof next.params.item === "object") {
      next.params.item.imageArtifacts = mergeArtifactRefs(next.params.item.imageArtifacts, refs);
    }
  }

  return { raw: next, artifacts };
}

function extractAssistantImageArtifactsFromText(raw, text, options = {}) {
  const item = raw?.params?.item;
  if (!raw || typeof raw !== "object" || !isAssistantImageTextEvent(raw)) {
    return { raw, text, artifacts: [] };
  }

  const sourceText = String(item?.type === "agentMessage" ? item.text || text || "" : text || item?.text || item?.result || "");
  const candidate = imageArtifactCandidateFromText(sourceText);
  if (!candidate) return { raw, text, artifacts: [] };

  const next = cloneJson(raw);
  const nextItem = next.params?.item;
  const displayText = assistantImageDisplayText(candidate.cleanText);
  if (nextItem && typeof nextItem === "object") {
    if (nextItem.type === "agentMessage" || typeof nextItem.text === "string") nextItem.text = displayText;
    nextItem.inlineImagePayloadOmitted = true;
  } else {
    next.inlineImagePayloadOmitted = true;
  }

  if (assistantImageArtifactRefs(next).length > 0) {
    return { raw: next, text: displayText, artifacts: [] };
  }

  if (candidate.buffer.length > maxInlineImageArtifactBytes) {
    nextItem.imageOmitted = "Image exceeded Echo inline image artifact size limit.";
    return { raw: next, text: displayText, artifacts: [] };
  }

  const artifact = buildBinaryArtifact({
    sessionId: options.sessionId,
    kind: "assistant_image",
    label: candidate.label,
    buffer: candidate.buffer,
    mimeType: candidate.mimeType,
    extension: candidate.extension,
    createdAt: options.createdAt
  });
  const ref = artifactRef(artifact);
  next.imageArtifacts = mergeArtifactRefs(next.imageArtifacts, [ref]);
  if (nextItem && typeof nextItem === "object") {
    nextItem.imageArtifacts = mergeArtifactRefs(nextItem.imageArtifacts, [ref]);
  }
  return { raw: next, text: displayText, artifacts: [artifact] };
}

function isAssistantImageTextEvent(raw = {}) {
  if (!raw || typeof raw !== "object") return false;
  const method = String(raw.method || "");
  const item = raw.params?.item;
  if (method !== "item/completed" || !item || typeof item !== "object") return false;
  return item.type === "agentMessage" || isImageGenerationItemType(item.type);
}

function assistantImageArtifactRefs(raw = {}) {
  const item = raw?.params?.item;
  return [
    ...(Array.isArray(raw.imageArtifacts) ? raw.imageArtifacts : []),
    ...(Array.isArray(item?.imageArtifacts) ? item.imageArtifacts : [])
  ].filter((artifact) => artifact?.kind === "assistant_image" || String(artifact?.mimeType || "").startsWith("image/"));
}

function imageArtifactCandidate(value = {}, inheritedLabel = "") {
  const source = value && typeof value === "object" ? value : {};
  const dataUrl = imageDataUrlFromObject(source);
  if (dataUrl) {
    const parsed = parseImageDataUrlForArtifact(dataUrl);
    if (!parsed) return null;
    return {
      ...parsed,
      label: imageLabelFromObject(source) || inheritedLabel || "Assistant image"
    };
  }

  const declaredMimeType = imageMimeTypeFromObject(source);
  const base64 = imageBase64FromObject(source);
  if (!base64) return null;
  const buffer = bufferFromBase64(base64);
  if (!buffer) return null;
  const detectedMimeType = imageMimeTypeFromBuffer(buffer);
  const mimeType = detectedMimeType || declaredMimeType;
  if (!mimeType) return null;
  return {
    buffer,
    mimeType,
    extension: attachmentExtensionFromMimeType(mimeType),
    label: imageLabelFromObject(source) || inheritedLabel || "Assistant image"
  };
}

function imageDataUrlFromObject(source = {}) {
  const direct = [
    source.dataUrl,
    source.data_url,
    source.url,
    source.imageUrl,
    source.image_url,
    source.result,
    source.output,
    source.data,
    source.content
  ];
  for (const value of direct) {
    if (typeof value === "string" && value.trim().startsWith("data:image/")) return value;
  }
  const nested = [source.image_url?.url, source.image?.url, source.source?.url, source.source?.data, source.image?.dataUrl];
  for (const value of nested) {
    if (typeof value === "string" && value.trim().startsWith("data:image/")) return value;
  }
  return "";
}

function imageMimeTypeFromObject(source = {}) {
  const mimeType = String(
    source.mimeType ||
      source.mime_type ||
      source.mediaType ||
      source.media_type ||
      source.contentType ||
      source.content_type ||
      source.image?.mimeType ||
      source.image?.mime_type ||
      source.source?.mimeType ||
      source.source?.mime_type ||
      ""
  )
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mimeType.startsWith("image/")) return mimeType;
  return "";
}

function imageBase64FromObject(source = {}) {
  const candidates = [
    source.result,
    source.output,
    source.base64,
    source.b64,
    source.b64_json,
    source.imageBase64,
    source.image_base64,
    source.image?.base64,
    source.image?.b64_json,
    source.image?.data,
    source.image?.result,
    source.source?.base64,
    source.source?.data,
    source.source?.result
  ];
  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (text && !text.startsWith("data:")) return text;
  }
  return "";
}

function parseImageDataUrlForArtifact(dataUrl) {
  const match = /^data:(image\/[a-z0-9.+_-]+);base64,([a-z0-9+/=\s]+)$/i.exec(String(dataUrl || "").trim());
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const buffer = bufferFromBase64(match[2]);
  if (!buffer) return null;
  return {
    buffer,
    mimeType,
    extension: attachmentExtensionFromMimeType(mimeType)
  };
}

function bufferFromBase64(value) {
  const compact = String(value || "").replace(/\s+/g, "");
  if (!compact || !/^[a-z0-9+/]+={0,2}$/i.test(compact)) return null;
  return Buffer.from(compact, "base64");
}

function imageLabelFromObject(source = {}) {
  return String(
    source.label ||
      source.name ||
      source.fileName ||
      source.filename ||
      source.title ||
      source.alt ||
      source.path ||
      source.filePath ||
      source.localPath ||
      ""
  )
    .trim()
    .slice(0, 240);
}

function replaceInlineImagePayload(target = {}, ref = {}) {
  delete target.dataUrl;
  delete target.data_url;
  delete target.base64;
  delete target.b64;
  delete target.b64_json;
  delete target.imageBase64;
  delete target.image_base64;
  if (typeof target.data === "string" && target.data.trim().startsWith("data:image/")) delete target.data;
  if (typeof target.content === "string" && target.content.trim().startsWith("data:image/")) delete target.content;
  if (typeof target.result === "string" && inlineImagePayloadFromText(target.result)) target.result = ref.downloadPath;
  if (typeof target.output === "string" && inlineImagePayloadFromText(target.output)) target.output = ref.downloadPath;
  if (typeof target.url === "string" && target.url.trim().startsWith("data:image/")) target.url = ref.downloadPath;
  if (typeof target.imageUrl === "string" && target.imageUrl.trim().startsWith("data:image/")) target.imageUrl = ref.downloadPath;
  if (typeof target.image_url === "string" && target.image_url.trim().startsWith("data:image/")) target.image_url = ref.downloadPath;
  if (target.image_url?.url && String(target.image_url.url).startsWith("data:image/")) target.image_url.url = ref.downloadPath;
  if (target.image?.url && String(target.image.url).startsWith("data:image/")) target.image.url = ref.downloadPath;
  if (target.image?.dataUrl) delete target.image.dataUrl;
  if (target.image?.base64) delete target.image.base64;
  if (target.image?.b64_json) delete target.image.b64_json;
  if (typeof target.image?.data === "string" && inlineImagePayloadFromText(target.image.data)) delete target.image.data;
  if (typeof target.image?.result === "string" && inlineImagePayloadFromText(target.image.result)) target.image.result = ref.downloadPath;
  if (target.source?.data) delete target.source.data;
  if (typeof target.source?.result === "string" && inlineImagePayloadFromText(target.source.result)) target.source.result = ref.downloadPath;
  if (target.source?.url && String(target.source.url).startsWith("data:image/")) target.source.url = ref.downloadPath;
  target.artifact = ref;
  target.imageArtifact = ref;
  target.downloadPath = ref.downloadPath;
  target.mimeType = ref.mimeType;
  target.sizeBytes = ref.sizeBytes;
  target.sha256 = ref.sha256;
}

function replaceOversizedImagePayload(target = {}, candidate = {}) {
  replaceInlineImagePayload(target, {
    id: "",
    kind: "assistant_image",
    label: candidate.label || "Assistant image",
    mimeType: candidate.mimeType || "image/png",
    sizeBytes: candidate.buffer?.length || 0,
    sha256: "",
    downloadPath: ""
  });
  target.imageOmitted = "Image exceeded Echo inline image artifact size limit.";
}

function assistantImageEventDisplayText(raw = {}, text = "") {
  if (assistantImageArtifactRefs(raw).length === 0) return text;
  const item = raw?.params?.item;
  const current = String(text || "").trim();
  const payload = inlineImagePayloadFromText(current);
  if (payload) return assistantImageDisplayText(payload.cleanText);
  if (isImageGenerationItemType(item?.type)) return "图片已生成。";
  return current || "图片已生成。";
}

function inlineImagePayloadFromText(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const dataUrlPayload = imageDataUrlPayloadFromText(text);
  if (dataUrlPayload) return { kind: "data-url", ...dataUrlPayload };
  const base64Payload = base64ImagePayloadFromText(text);
  if (!base64Payload) return null;
  const buffer = bufferFromBase64(base64Payload.base64);
  return buffer && imageMimeTypeFromBuffer(buffer) ? { kind: "base64", ...base64Payload } : null;
}

function isImageGenerationItemType(value) {
  const normalized = String(value || "").replace(/[-_\s]+/g, "").toLowerCase();
  return ["imagegenerationcall", "imagegeneration", "generatedimage", "outputimage", "assistantimage"].includes(normalized);
}

function mergeArtifactRefs(existing = [], refs = []) {
  const byId = new Map();
  for (const ref of [...(Array.isArray(existing) ? existing : []), ...refs]) {
    if (ref?.id) byId.set(ref.id, ref);
  }
  return Array.from(byId.values());
}

function buildTextArtifact({ sessionId, kind, label, content, mimeType = "text/plain; charset=utf-8", createdAt }) {
  const buffer = Buffer.from(String(content || ""), "utf8");
  const extension = mimeType.includes("json") ? "json" : "txt";
  return buildArtifact({
    sessionId,
    kind,
    label,
    buffer,
    mimeType,
    extension,
    createdAt
  });
}

function buildBinaryArtifact({ sessionId, kind, label, buffer, mimeType, extension, createdAt }) {
  return buildArtifact({
    sessionId,
    kind,
    label,
    buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || ""),
    mimeType,
    extension,
    createdAt
  });
}

function buildArtifact({ sessionId, kind, label, buffer, mimeType = "application/octet-stream", extension = "bin", createdAt }) {
  const id = crypto.randomUUID();
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  return {
    id,
    sessionId,
    eventId: null,
    kind: String(kind || "text").slice(0, 80),
    label: String(label || kind || "artifact").slice(0, 240),
    mimeType,
    sizeBytes: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    storageKey: artifactStorageKey(sessionId, id, extension),
    createdAt: createdAt || nowIso(),
    content
  };
}

function persistSessionArtifact(artifact) {
  const absolutePath = artifactAbsolutePath(artifact.storageKey);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, artifact.content, { mode: 0o600 });
  insertSessionArtifact.run({
    id: artifact.id,
    sessionId: artifact.sessionId,
    eventId: artifact.eventId,
    kind: artifact.kind,
    label: artifact.label,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    storageKey: artifact.storageKey,
    createdAt: artifact.createdAt
  });
}

function artifactRef(artifact) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    label: artifact.label,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    downloadPath: `/api/codex/artifacts/${encodeURIComponent(artifact.id)}`
  };
}

function cloneJson(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function redactSensitiveJson(value) {
  const state = { redacted: false };
  return {
    value: redactSensitiveJsonValue(value, "", state),
    redacted: state.redacted
  };
}

function redactSensitiveJsonValue(value, key, state) {
  if (value === null || value === undefined) return value;
  if (isSensitiveKey(key)) {
    state.redacted = true;
    return "[redacted]";
  }
  if (typeof value === "string") {
    const redacted = redactSensitiveString(value);
    if (redacted !== value) state.redacted = true;
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveJsonValue(item, "", state));
  if (typeof value !== "object") return value;

  const next = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    next[childKey] = redactSensitiveJsonValue(childValue, childKey, state);
  }
  return next;
}

function isSensitiveKey(key) {
  const normalized = String(key || "").replace(/[-_]/g, "").toLowerCase();
  return (
    [
      "token",
      "authtoken",
      "apikey",
      "secret",
      "password",
      "passwd",
      "authorization",
      "cookie",
      "setcookie",
      "env",
      "environment",
      "credential",
      "privatekey"
    ].includes(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("apikey")
  );
}

function redactSensitiveString(value) {
  return String(value || "")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "sk-[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "xox-[redacted]");
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || "");
  if (byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, midpoint)) <= maxBytes) low = midpoint;
    else high = midpoint - 1;
  }
  return text.slice(0, low);
}

function storedEventBytes(type, text, rawJson) {
  return byteLength(JSON.stringify({ type, text, raw: rawJson ? parseJson(rawJson, null) : null }));
}

function withEventDataMetadata(raw, metadata = {}) {
  if (!raw || typeof raw !== "object") {
    if (!metadata.redacted && !metadata.truncated && !metadata.artifactized) return raw;
    raw = {};
  }
  const next = { ...raw };
  if (metadata.redacted || raw.redacted) next.redacted = true;
  if (metadata.truncated || raw.truncated) next.truncated = true;
  if (metadata.artifactized || raw.artifactized) next.artifactized = true;
  return next;
}

function boundedEventRaw(raw, type, metadata = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const params = source.params && typeof source.params === "object" ? source.params : {};
  const turn = params.turn && typeof params.turn === "object" ? params.turn : null;
  const item = params.item && typeof params.item === "object" ? params.item : null;
  const boundedParams = {};
  if (params.threadId) boundedParams.threadId = truncateUtf8(params.threadId, 500);
  if (params.turnId) boundedParams.turnId = truncateUtf8(params.turnId, 500);
  if (turn) {
    boundedParams.turn = {
      id: truncateUtf8(turn.id, 500),
      status: truncateUtf8(turn.status, 120)
    };
    const errorMessage = turn.error?.message || turn.error;
    if (errorMessage) boundedParams.turn.error = { message: truncateUtf8(errorMessage, 2000) };
  }
  if (item) {
    boundedParams.item = {
      id: truncateUtf8(item.id, 500),
      type: truncateUtf8(item.type, 120),
      status: truncateUtf8(item.status, 120)
    };
  }

  const bounded = {
    method: truncateUtf8(source.method || type, 500),
    redacted: Boolean(metadata.redacted || source.redacted),
    truncated: true,
    artifactized: Boolean(metadata.artifactized || source.artifactized || source.artifact),
    originalBytes: Math.max(0, Number(metadata.originalBytes || source.originalBytes || 0) || 0)
  };
  if (Object.keys(boundedParams).length > 0) bounded.params = boundedParams;
  if (source.artifact && typeof source.artifact === "object") bounded.artifact = source.artifact;
  return bounded;
}

function headPreview(value, limit) {
  const text = String(value || "");
  return text.length > limit ? text.slice(0, limit).trimEnd() : text;
}

function tailPreview(value, limit) {
  const text = String(value || "");
  return text.length > limit ? text.slice(-limit).trimStart() : text;
}

function parseEvent(row, options = {}) {
  const raw = options.includeRaw === false ? null : parseJson(row.rawJson);
  return {
    id: Number(row.id || 0) || undefined,
    at: row.at,
    type: row.type,
    text: row.text,
    raw: options.rawMode === "client" ? compactClientEventRaw(row.type, raw) : raw
  };
}

function compactClientEventRaw(type, raw) {
  if (!raw || typeof raw !== "object") return null;
  const compact = compactClientEventRawPayload(type, raw);
  if (!compact || typeof compact !== "object") return compact;
  if (raw.redacted) compact.redacted = true;
  if (raw.truncated) compact.truncated = true;
  if (raw.artifactized) compact.artifactized = true;
  if (raw.originalBytes) compact.originalBytes = Number(raw.originalBytes) || 0;
  return compact;
}

function compactClientEventRawPayload(type, raw) {
  const method = String(raw.method || type || "");
  const params = raw.params && typeof raw.params === "object" ? raw.params : {};
  if (method === "git.summary" || raw.gitSummary) {
    const summary = raw.gitSummary || {};
    const changedFiles = Array.isArray(summary.changedFiles) ? summary.changedFiles : [];
    const changedDuringTurn = summary.changedDuringTurn && typeof summary.changedDuringTurn === "object" ? summary.changedDuringTurn : null;
    return {
      source: raw.source || "",
      gitSummary: {
        root: summary.root || "",
        branch: summary.branch || "",
        commit: summary.commit || "",
        changedDuringTurn: changedDuringTurn
          ? {
              changedFileCount: Array.isArray(changedDuringTurn.changedFiles) ? changedDuringTurn.changedFiles.length : 0,
              changedFiles: Array.isArray(changedDuringTurn.changedFiles) ? changedDuringTurn.changedFiles.slice(0, 20) : [],
              commitChanged: Boolean(changedDuringTurn.commitChanged),
              commitBefore: changedDuringTurn.commitBefore || "",
              commitAfter: changedDuringTurn.commitAfter || ""
            }
          : null,
        changedFileCount: Number.isFinite(Number(summary.changedFileCount)) ? Number(summary.changedFileCount) : changedFiles.length,
        changedFiles: changedFiles.slice(0, 20)
      }
    };
  }
  if (method === "test.summary" || raw.testSummary) {
    const summary = raw.testSummary || {};
    return {
      source: raw.source || "",
      method: "test.summary",
      testSummary: {
        level: summary.level || "",
        status: summary.status || "",
        command: String(summary.command || "").slice(0, 500),
        turnId: String(summary.turnId || "").slice(0, 200),
        outputBytes: Number(summary.outputBytes || 0) || 0,
        outputArtifact: summary.outputArtifact ? compactArtifactRef(summary.outputArtifact) : null,
        failures: Array.isArray(summary.failures) ? summary.failures.slice(0, 5) : []
      }
    };
  }
  if (method === "thread/status/changed") return { method };
  if (method === "thread/tokenUsage/updated") {
    return {
      method,
      params: compactTokenUsageParams(params)
    };
  }
  if (method === "context.usage.updated" || method === "context/usage/updated") {
    return {
      method,
      source: raw.source || params.source || "",
      params: compactContextUsageParams(params, raw)
    };
  }
  if (method === "thread/compacted") {
    return {
      method,
      params: {
        threadId: String(params.threadId || "").slice(0, 200),
        turnId: String(params.turnId || params.turn?.id || "").slice(0, 200)
      }
    };
  }
  if (method === "turn/started" || method === "turn/completed") {
    return { method, params: compactTurnParams(params) };
  }
  if (method === "turn/plan/updated") {
    return {
      method,
      params: {
        threadId: params.threadId || "",
        turnId: params.turnId || params.turn?.id || ""
      }
    };
  }
  if (isDeltaEventType(method)) {
    return {
      method,
      params: {
        threadId: params.threadId || "",
        turnId: params.turnId || "",
        itemId: params.itemId || ""
      }
    };
  }
  if (method === "item/completed" || method === "item/started") {
    const compact = { method, params: compactItemParams(params) };
    if (Array.isArray(raw.imageArtifacts)) compact.imageArtifacts = raw.imageArtifacts.map(compactArtifactRef).filter((item) => item.id);
    return compact;
  }
  if (method === "item/commandExecution/requestApproval") {
    return {
      method,
      params: {
        threadId: params.threadId || "",
        turnId: params.turnId || "",
        command: compactCommand(params.command)
      }
    };
  }
  if (method === "thread/start" || method === "thread/resume") {
    return { method };
  }
  if (method === "user.message") {
    const mode = String(raw.mode || "").trim().toLowerCase();
    return {
      source: raw.source || "",
      type: raw.type || "",
      mode: mode === "plan" || mode === "execute" ? mode : "",
      attachments: Array.isArray(raw.attachments) ? raw.attachments.map(compactClientAttachment).filter(Boolean) : []
    };
  }
  if (Array.isArray(raw.attachments)) {
    return {
      attachments: raw.attachments.map(compactClientAttachment).filter(Boolean)
    };
  }
  return { method };
}

function compactTurnParams(params = {}) {
  const turn = params.turn && typeof params.turn === "object" ? params.turn : {};
  return {
    threadId: params.threadId || "",
    turn: {
      id: turn.id || params.turnId || "",
      status: turn.status || "",
      error: turn.error?.message ? { message: String(turn.error.message).slice(0, 1000) } : null
    }
  };
}

function compactItemParams(params = {}) {
  const item = params.item && typeof params.item === "object" ? params.item : {};
  const compactItem = {
    id: item.id || "",
    type: item.type || "",
    status: item.status || ""
  };
  if (item.type === "agentMessage" || item.type === "plan") compactItem.text = String(item.text || "").slice(0, 12000);
  if (isImageGenerationItemType(item.type)) {
    compactItem.text = "图片已生成。";
    compactItem.revisedPrompt = String(item.revisedPrompt || item.revised_prompt || "").slice(0, 2000);
    compactItem.savedPath = String(item.savedPath || item.saved_path || "").slice(0, 1000);
  }
  if (Array.isArray(item.imageArtifacts)) {
    compactItem.imageArtifacts = item.imageArtifacts.map(compactArtifactRef).filter((artifact) => artifact.id);
  }
  if (item.artifact && typeof item.artifact === "object") {
    compactItem.artifact = compactArtifactRef(item.artifact);
  }
  if (item.imageArtifact && typeof item.imageArtifact === "object") {
    compactItem.imageArtifact = compactArtifactRef(item.imageArtifact);
  }
  if (item.type === "commandExecution") {
    compactItem.command = compactCommand(item.command);
    compactItem.aggregatedOutput = String(item.aggregatedOutput || "").slice(-1200);
    compactItem.aggregatedOutputTruncated = Boolean(item.aggregatedOutputTruncated);
    if (item.outputArtifact && typeof item.outputArtifact === "object") {
      compactItem.outputArtifact = compactArtifactRef(item.outputArtifact);
    }
  }
  if (item.type === "fileChange") {
    compactItem.changes = (Array.isArray(item.changes) ? item.changes : [])
      .map((change) => ({
        path: String(change?.path || change?.file || "").slice(0, 1000),
        changeType: String(change?.changeType || change?.kind || change?.type || "modified").slice(0, 80)
      }))
      .filter((change) => change.path)
      .slice(0, 20);
  }
  return {
    threadId: params.threadId || "",
    turnId: params.turnId || params.turn?.id || "",
    item: compactItem
  };
}

function compactTokenUsageParams(params = {}) {
  return {
    threadId: String(params.threadId || "").slice(0, 200),
    turnId: String(params.turnId || params.turn?.id || "").slice(0, 200),
    tokenUsage: normalizeThreadTokenUsage(params.tokenUsage)
  };
}

function compactContextUsageParams(params = {}, raw = {}) {
  const usage = normalizeContextUsagePayload({ ...raw, params });
  return {
    threadId: String(params.threadId || raw.threadId || usage?.threadId || "").slice(0, 200),
    turnId: String(params.turnId || params.turn?.id || raw.turnId || usage?.turnId || "").slice(0, 200),
    source: String(params.source || raw.source || usage?.source || "").slice(0, 120),
    usage: usage
      ? {
          total: usage.total,
          last: usage.last,
          modelContextWindow: usage.modelContextWindow
        }
      : null
  };
}

function normalizeContextUsagePayload(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const method = String(raw.method || raw.type || "");
  const params = raw.params && typeof raw.params === "object" ? raw.params : {};
  const source = String(raw.source || params.source || (method === "thread/tokenUsage/updated" ? "codex-app-server" : "backend")).trim();
  const threadId = String(params.threadId || raw.threadId || "").slice(0, 200);
  const turnId = String(params.turnId || params.turn?.id || raw.turnId || "").slice(0, 200);
  const usageInput = params.tokenUsage || params.usage || raw.usage || raw.contextUsage || raw.tokenUsage;
  const tokenUsage = normalizeThreadTokenUsage(usageInput) || normalizeFlatTokenUsage(usageInput);
  if (!tokenUsage) return null;
  return {
    source: source || "backend",
    threadId,
    turnId,
    ...tokenUsage
  };
}

function normalizeThreadTokenUsage(input) {
  if (!input || typeof input !== "object") return null;
  const hasTotal = input.total && typeof input.total === "object";
  const hasLast = input.last && typeof input.last === "object";
  if (!hasTotal && !hasLast) return null;
  const modelContextWindow = tokenCount(input.modelContextWindow ?? input.model_context_window);
  return {
    total: normalizeTokenUsageBreakdown(input.total),
    last: normalizeTokenUsageBreakdown(input.last),
    modelContextWindow: modelContextWindow > 0 ? modelContextWindow : null
  };
}

function normalizeFlatTokenUsage(input) {
  if (!input || typeof input !== "object") return null;
  const last = normalizeTokenUsageBreakdown(input);
  if (!last.totalTokens) return null;
  const totalInput = input.accumulated && typeof input.accumulated === "object" ? input.accumulated : input.totalUsage;
  const total = normalizeTokenUsageBreakdown(totalInput && typeof totalInput === "object" ? totalInput : input);
  const modelContextWindow = tokenCount(input.modelContextWindow ?? input.model_context_window ?? input.contextWindowTokens);
  return {
    total,
    last,
    modelContextWindow: modelContextWindow > 0 ? modelContextWindow : null
  };
}

function normalizeTokenUsageBreakdown(input = {}) {
  const usage = input && typeof input === "object" ? input : {};
  const inputTokens = tokenCount(usage.inputTokens ?? usage.input_tokens);
  const cachedInputTokens = tokenCount(
    usage.cachedInputTokens ??
      usage.cached_input_tokens ??
      usage.cacheReadInputTokens ??
      usage.cache_read_input_tokens ??
      usage.cacheCreationInputTokens ??
      usage.cache_creation_input_tokens
  );
  const outputTokens = tokenCount(usage.outputTokens ?? usage.output_tokens);
  const reasoningOutputTokens = tokenCount(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens);
  const explicitTotal = tokenCount(usage.totalTokens ?? usage.total_tokens);
  return {
    totalTokens: explicitTotal || inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens
  };
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function isDeltaEventType(method) {
  return (
    method === "item/agentMessage/delta" ||
    method === "item/plan/delta" ||
    method === "command/exec/outputDelta" ||
    method === "item/commandExecution/outputDelta"
  );
}

function compactCommand(command) {
  if (Array.isArray(command)) return command.map((part) => String(part || "").slice(0, 200)).slice(0, 40);
  return String(command || "").slice(0, 1000);
}

function compactClientAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") return null;
  return {
    type: attachment.type || "",
    name: attachment.name || "",
    id: attachment.id || "",
    downloadPath: attachment.downloadPath || ""
  };
}

function compactArtifactRef(artifact) {
  return {
    id: String(artifact.id || "").slice(0, 120),
    kind: String(artifact.kind || "").slice(0, 80),
    label: String(artifact.label || "").slice(0, 240),
    mimeType: String(artifact.mimeType || artifact.mime_type || "").slice(0, 120),
    sizeBytes: Number(artifact.sizeBytes || 0) || 0,
    downloadPath: String(artifact.downloadPath || "").slice(0, 500)
  };
}

function buildAgentSessionCommand(command) {
  const parsed = summarizeSessionCommand(command);
  const messageId = String(parsed.payload?.messageId || "").trim();
  const message = messageId ? getSessionMessage(messageId) : null;
  const mode = normalizeSessionMode(parsed.payload?.mode);
  const agentText = message ? String(message.text || "").trim() : "";
  const contextPrompt = String(parsed.payload?.contextPrompt || "").trim();
  const commandText = contextPrompt || agentText;
  const payload = {
    ...parsed.payload,
    ...(message
      ? parsed.type === "start"
        ? { prompt: commandText, displayText: message.text, attachments: commandAttachmentsFromMessage(message) }
        : { text: commandText, displayText: message.text, attachments: commandAttachmentsFromMessage(message) }
      : commandText
        ? parsed.type === "start"
          ? { prompt: commandText, displayText: "", attachments: [] }
          : { text: commandText, displayText: "", attachments: [] }
        : {})
  };
  if (parsed.type === "message") {
    payload.previousComposerMode = latestSessionComposerModeBefore(parsed.sessionId, parsed.id);
    payload.hasPriorPlanMode = sessionHadPlanModeBefore(parsed.sessionId, parsed.id);
    payload.history = commandHistoryForSession(parsed.sessionId, message?.id);
    payload.recoveryContext = commandRecoveryContext(command, payload.history);
  }
  return {
    id: parsed.id,
    sessionId: parsed.sessionId,
    type: parsed.type,
    projectId: command.projectId,
    desktopAgentId: command.leasedBy || "",
    appThreadId: command.appThreadId || "",
    activeTurnId: command.activeTurnId || "",
    runtime: runtimeWithCommandRetryOverride(parseJson(command.runtimeJson, {}), parsed.payload),
    execution: parseJson(command.executionJson, {}),
    payload,
    attempt: Math.max(1, Number(parsed.attempt || 1) || 1),
    createdAt: parsed.createdAt
  };
}

function protocolSessionEventKey(event = {}) {
  const eventId = String(event.eventId || event.protocolEventId || "").trim().slice(0, 160);
  if (!eventId) return "";
  const commandId = String(event.commandId || "").trim().slice(0, 160);
  const attempt = Math.max(0, Number(event.attempt || 0) || 0);
  return `${commandId}:${attempt}:${eventId}`.slice(0, 500);
}

function runtimeWithCommandRetryOverride(runtime = {}, payload = {}) {
  const retry = payload?.retry && typeof payload.retry === "object" ? payload.retry : {};
  const override = retry.runtimeOverride && typeof retry.runtimeOverride === "object" ? retry.runtimeOverride : null;
  if (!override) return runtime;
  const model = String(override.model || "").trim();
  const reasoningEffort = normalizeReasoningEffort(override.reasoningEffort || override.effort);
  if (!model && !reasoningEffort) return runtime;
  return {
    ...runtime,
    retryOverride: {
      model,
      reasoningEffort
    }
  };
}

function normalizeSessionMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "plan" ? "plan" : "execute";
}

function normalizeWorktreeAction(value) {
  const action = String(value || "").trim().toLowerCase();
  return ["setup", "apply", "discard"].includes(action) ? action : "";
}

function normalizeThreadMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "fork-summary" || mode === "fork_summary" || mode === "summary") return "fork-summary";
  if (mode === "fresh" || mode === "new") return "fresh";
  return "continue";
}

function commandHistoryForSession(sessionId, currentMessageId) {
  return listSessionMessages(sessionId)
    .filter((message) => message.id !== currentMessageId)
    .filter((message) => ["user", "assistant"].includes(message.role))
    .filter((message) => String(message.text || "").trim())
    .slice(-12)
    .map((message) => ({
      role: message.role,
      text: String(message.text || "").trim().slice(0, 4000),
      createdAt: message.createdAt
    }));
}

function commandRecoveryContext(command = {}, history = []) {
  const memory = parseJson(command.memoryJson, {});
  const summary = String(memory.summary || "").trim().slice(0, 8000);
  const historyMessageCount = Array.isArray(history) ? history.length : 0;
  return {
    source: summary ? "echo-session-memory" : historyMessageCount > 0 ? "visible-history" : "current-message-only",
    summary,
    sourceSessionId: String(memory.sourceSessionId || command.sessionId || "").trim(),
    memoryUpdatedAt: String(memory.updatedAt || "").trim(),
    historyMessageCount
  };
}

function deriveSessionUpdate(events, session) {
  const update = {
    status: null,
    appThreadId: null,
    activeTurnId: null,
    clearActiveTurnId: false,
    releaseLease: false,
    lastError: null,
    finalMessage: null
  };
  const completedAgentMessages = completedAgentMessageRefs(session.id);
  const completedAgentItems = new Set(completedAgentMessages.itemKeys);
  const completedAgentTurns = new Set(completedAgentMessages.turnKeys);
  let nextFinalMessage = String(session.finalMessage || "");
  let currentDraftTurnKey =
    session.appThreadId && session.activeTurnId ? [String(session.appThreadId), String(session.activeTurnId)].join("\u001f") : "";

  for (const event of events || []) {
    const raw = event.raw || {};
    const method = raw.method || event.type;
    const compactionCompletion = isContextCompactionCompletionEvent(event);
    const standaloneCompactionCompletion =
      compactionCompletion && (isExplicitCompactionCommandEvent(event) || !currentSessionActiveTurnId(session, update));
    if (event.sessionStatus && (!compactionCompletion || standaloneCompactionCompletion)) update.status = String(event.sessionStatus);
    if (event.appThreadId) update.appThreadId = String(event.appThreadId);
    if (event.activeTurnId) update.activeTurnId = String(event.activeTurnId);
    if (event.clearActiveTurnId && (!compactionCompletion || standaloneCompactionCompletion)) update.clearActiveTurnId = true;
    if (event.error) update.lastError = String(event.error).slice(0, 12000);
    if (event.finalMessage && method !== "item/agentMessage/delta") {
      update.finalMessage = String(event.finalMessage).slice(0, 12000);
    }
    if (method === "turn/started") {
      update.status = "running";
      update.activeTurnId = raw.params?.turn?.id || event.activeTurnId || update.activeTurnId;
      currentDraftTurnKey = sessionEventTurnKey(event);
      nextFinalMessage = "";
      update.finalMessage = "";
    }
    if (method === "turn/completed") {
      const turnStatus = raw.params?.turn?.status;
      update.clearActiveTurnId = true;
      update.releaseLease = true;
      update.status = turnStatus === "failed" ? "failed" : "active";
      const message = raw.params?.turn?.error?.message;
      if (message) update.lastError = String(message).slice(0, 12000);
      const turnKey = sessionEventTurnKey(event);
      if (turnKey) completedAgentTurns.add(turnKey);
    }
    if (method === "turn/interrupt") {
      update.clearActiveTurnId = true;
      update.releaseLease = true;
      update.status = "active";
    }
    if (method === "thread/compacted" && standaloneCompactionCompletion) {
      update.clearActiveTurnId = true;
      update.releaseLease = true;
      update.status = "active";
    }
    if (method === "item/completed" && raw.params?.item?.type === "contextCompaction" && standaloneCompactionCompletion) {
      update.clearActiveTurnId = true;
      update.releaseLease = true;
      update.status = "active";
    }
    if (
      method === "item/agentMessage/delta" &&
      event.text &&
      !sessionEventMatchesCompletedAssistant(event, completedAgentItems, completedAgentTurns)
    ) {
      const turnKey = sessionEventTurnKey(event);
      if (turnKey && currentDraftTurnKey && turnKey !== currentDraftTurnKey) nextFinalMessage = "";
      if (turnKey && !currentDraftTurnKey) {
        const eventTurnId = sessionEventTurnId(event);
        const activeTurnId = String(update.activeTurnId || session.activeTurnId || "").trim();
        if (!activeTurnId || (eventTurnId && eventTurnId !== activeTurnId)) nextFinalMessage = "";
      }
      if (turnKey) currentDraftTurnKey = turnKey;
      nextFinalMessage = `${nextFinalMessage}${event.text}`.slice(0, 12000);
      update.finalMessage = nextFinalMessage;
    }
    if (method === "item/completed" && assistantImageArtifactRefs(raw).length > 0) {
      const displayText = assistantImageEventDisplayText(raw, event.text);
      nextFinalMessage = String(displayText || "图片已生成。").slice(0, 12000);
      update.finalMessage = nextFinalMessage;
    }
    if (method === "item/completed" && raw.params?.item?.type === "agentMessage") {
      nextFinalMessage = String(raw.params.item.text || "").slice(0, 12000);
      update.finalMessage = nextFinalMessage;
      const itemKey = sessionEventAssistantItemKey(event);
      const turnKey = sessionEventTurnKey(event);
      if (itemKey) completedAgentItems.add(itemKey);
      if (turnKey) completedAgentTurns.add(turnKey);
    }
  }

  return update;
}

function deriveSessionExecutionUpdate(events = [], execution = {}) {
  if (!execution || typeof execution !== "object" || execution.mode !== "worktree") return null;
  let next = null;
  for (const event of events || []) {
    const raw = event.raw || {};
    const method = raw.method || event.type;
    if (method === "turn/started") {
      next = {
        ...(next || execution),
        lifecycleState: "running",
        lastRunStartedAt: event.at || new Date().toISOString()
      };
    }
    if (method === "turn/completed") {
      const failed = raw.params?.turn?.status === "failed";
      next = {
        ...(next || execution),
        lifecycleState: failed ? "failed" : "completed",
        lastRunFinishedAt: event.at || new Date().toISOString()
      };
    }
  }
  return next;
}

function isContextCompactionCompletionEvent(event = {}) {
  const method = event.raw?.method || event.type || "";
  return method === "thread/compacted" || (method === "item/completed" && event.raw?.params?.item?.type === "contextCompaction");
}

function isExplicitCompactionCommandEvent(event = {}) {
  return event.explicitCompactionCommand === true || event.raw?.echoExplicitCompactionCommand === true;
}

function currentSessionActiveTurnId(session = {}, update = {}) {
  return String(update.activeTurnId || session.activeTurnId || "").trim();
}

function completedAgentMessageRefs(sessionId) {
  const rows = db.prepare(`
    SELECT raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ?
      AND type IN ('item/completed', 'turn/completed')
    ORDER BY id DESC
    LIMIT 40
  `).all(sessionId);

  const itemKeys = [];
  const turnKeys = [];
  for (const row of rows) {
    const raw = parseJson(row.rawJson, {});
    const method = raw?.method || "";
    if (method !== "turn/completed" && raw?.params?.item?.type !== "agentMessage") continue;
    const event = { type: method || "item/completed", raw };
    const itemKey = sessionEventAssistantItemKey(event);
    const turnKey = sessionEventTurnKey(event);
    if (method !== "turn/completed" && itemKey) itemKeys.push(itemKey);
    if (turnKey) turnKeys.push(turnKey);
  }
  return { itemKeys, turnKeys };
}

function sessionEventMatchesCompletedAssistant(event, completedItems, completedTurns) {
  const itemKey = sessionEventAssistantItemKey(event);
  const turnKey = sessionEventTurnKey(event);
  return Boolean((itemKey && completedItems.has(itemKey)) || (turnKey && completedTurns.has(turnKey)));
}

function sessionEventAssistantItemKey(event = {}) {
  const params = event.raw?.params || {};
  const item = params.item || {};
  const threadId = String(params.threadId || params.thread?.id || item.threadId || "").trim();
  const turnId = String(params.turnId || params.turn?.id || item.turnId || "").trim();
  const itemId = String(params.itemId || item.id || "").trim();
  if (!threadId && !turnId && !itemId) return "";
  return [threadId, turnId, itemId].join("\u001f");
}

function sessionEventTurnKey(event = {}) {
  const params = event.raw?.params || {};
  const item = params.item || {};
  const threadId = String(params.threadId || params.thread?.id || item.threadId || "").trim();
  const turnId = sessionEventTurnId(event);
  if (!threadId && !turnId) return "";
  return [threadId, turnId].join("\u001f");
}

function sessionEventTurnId(event = {}) {
  const params = event.raw?.params || {};
  const item = params.item || {};
  return String(params.turnId || params.turn?.id || item.turnId || event.activeTurnId || "").trim();
}

function latestRestartOperation(sessionId, statuses = []) {
  const normalizedStatuses = Array.isArray(statuses)
    ? statuses.filter((status) => ["requested", "restarting", "resuming", "completed", "failed", "cancelled"].includes(status))
    : [];
  const statusClause = normalizedStatuses.length
    ? `AND status IN (${normalizedStatuses.map(() => "?").join(", ")})`
    : "";
  const row = db.prepare(`
    SELECT * FROM codex_agent_restart_operations
    WHERE session_id = ? ${statusClause}
    ORDER BY created_at DESC
    LIMIT 1
  `).get(sessionId, ...normalizedStatuses);
  return row ? parseRestartOperation(row) : null;
}

function expireStaleAgentRestarts(now = nowIso()) {
  const restartingCutoff = new Date(Date.parse(now) - 2 * 60 * 1000).toISOString();
  const requestedCutoff = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
  const stale = db.prepare(`
    SELECT * FROM codex_agent_restart_operations
    WHERE (status = 'restarting' AND updated_at < @restartingCutoff)
       OR (status = 'requested' AND updated_at < @requestedCutoff)
  `).all({ restartingCutoff, requestedCutoff }).map(parseRestartOperation);
  if (!stale.length) return [];
  const expire = db.transaction(() => {
    for (const operation of stale) {
      const error = operation.status === "restarting"
        ? "Desktop agent did not reconnect within the restart timeout."
        : "Desktop agent did not finish draining before the restart timeout.";
      const updated = db.prepare(`
        UPDATE codex_agent_restart_operations
        SET status = 'failed', error = @error, completed_at = @now, updated_at = @now
        WHERE id = @id AND status = @status
      `).run({ id: operation.id, status: operation.status, error, now });
      if (updated.changes === 0) continue;
      insertSessionEvent.run(normalizeSessionEvent(operation.sessionId, {
        type: "agent.restart.failed",
        text: error,
        raw: { source: "relay", operationId: operation.id, timeout: true }
      }, now));
      db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(now, operation.sessionId);
    }
  });
  expire();
  return stale.map((operation) => operation.sessionId);
}

function parseRestartOperation(row = {}) {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    oldInstanceId: row.old_instance_id,
    newInstanceId: row.new_instance_id || "",
    expectedRevision: row.expected_revision || "",
    actualRevision: row.actual_revision || "",
    status: row.status,
    resumeSummary: row.resume_summary || "",
    continuationCommandId: row.continuation_command_id || "",
    error: row.error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || ""
  };
}

function parseAgent(row) {
  return {
    id: row.id,
    ownerUser: row.ownerUser || "",
    displayName: row.displayName || row.id,
    instanceId: row.instanceId || "",
    instanceStartedAt: row.instanceStartedAt || "",
    lastSeenAt: row.lastSeenAt,
    snapshotUpdatedAt: row.snapshotUpdatedAt || "",
    workspacesUpdatedAt: row.workspacesUpdatedAt || "",
    runtimeUpdatedAt: row.runtimeUpdatedAt || "",
    workspaces: parseJson(row.workspacesJson, []),
    runtime: parseJson(row.runtimeJson, {})
  };
}

function normalizeSourceRevision(value) {
  const revision = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(revision) ? revision : "";
}

function resolveSessionRuntimeForProject(runtime, projectId, targetAgentId = "") {
  const capability = runtimeForProject(projectId, targetAgentId);
  assertWorkspaceWorktreePreference(runtime, capability, projectId);
  return resolveRuntimeForAgent(runtime, capability);
}

function assertWorkspaceWorktreePreference(runtime = {}, agentRuntime = {}, workspaceId = "") {
  if (String(runtime.worktreeMode || "off").trim().toLowerCase() !== "always") return;
  const availability = String(agentRuntime.capabilities?.worktreeByWorkspace?.[workspaceId]?.availability || "").trim().toLowerCase();
  if (!["disabled", "unavailable"].includes(availability)) return;
  const error = new Error("Worktree execution is not available for this Workspace.");
  error.statusCode = 422;
  error.code = "runtime.worktree.unsupported";
  throw error;
}

function sessionBackendChanged(previousRuntime = {}, nextRuntime = {}) {
  const previous = runtimeBackendKey(previousRuntime);
  const next = runtimeBackendKey(nextRuntime);
  return Boolean(previous && next && previous !== next);
}

function runtimeBackendKey(runtime = {}) {
  const source = runtime && typeof runtime === "object" ? runtime : {};
  return String(source.backendId || source.provider || source.backendName || "").trim().toLowerCase();
}

function runtimeBackendLabel(runtime = {}) {
  const source = runtime && typeof runtime === "object" ? runtime : {};
  return String(source.backendName || source.backendId || source.provider || "backend").trim() || "backend";
}

function compactRuntimeBackendRef(runtime = {}) {
  const source = runtime && typeof runtime === "object" ? runtime : {};
  return {
    backendId: String(source.backendId || "").trim(),
    provider: String(source.provider || "").trim(),
    backendName: String(source.backendName || "").trim(),
    model: String(source.model || "").trim(),
    reasoningEffort: String(source.reasoningEffort || source.effort || "").trim(),
    permissionMode: String(source.permissionMode || source.profile || "").trim()
  };
}

function runtimeSupports(runtime = {}, feature = "") {
  const key = String(feature || "").trim();
  if (!key) return false;
  const source = runtime && typeof runtime === "object" ? runtime : {};
  const supports = source.capabilities?.supports && typeof source.capabilities.supports === "object" ? source.capabilities.supports : {};
  if (typeof supports[key] === "boolean") return supports[key];
  const legacyKey = {
    attachments: "supportsAttachments",
    compaction: "supportsCompaction",
    contextUsage: "supportsContextUsage",
    approvalRequests: "supportsApprovalRequests",
    interactionRequests: "supportsInteractionRequests",
    gitSummary: "supportsGitSummary",
    worktree: "supportsWorktree",
    threadArchive: "supportsThreadArchive"
  }[key];
  if (legacyKey && typeof source[legacyKey] === "boolean") return source[legacyKey];
  if (
    isCodexRuntime(source) &&
    [
      "attachments",
      "compaction",
      "contextUsage",
      "approvalRequests",
      "interactionRequests",
      "gitSummary",
      "worktree",
      "threadArchive"
    ].includes(key)
  ) {
    return true;
  }
  return key === "text" || key === "cancellation";
}

function sessionHasClosedWorktree(session = {}) {
  const execution = session.execution && typeof session.execution === "object" ? session.execution : {};
  if (execution.mode !== "worktree") return false;
  const state = String(execution.lifecycleState || execution.cleanupState || "").trim().toLowerCase();
  return ["applied", "discarded", "unavailable", "cleanup-pending"].includes(state);
}

function shouldQueueNativeArchiveSessionCommand(session = {}) {
  return Boolean(String(session.appThreadId || "").trim() && runtimeSupports(session.runtime, "threadArchive"));
}

function isCodexRuntime(runtime = {}) {
  const label = `${runtime.backendId || ""} ${runtime.provider || ""} ${runtime.backendName || ""}`;
  return /\bcodex\b/i.test(label);
}

function runtimeForProject(projectId, targetAgentId = "") {
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedTargetAgentId = normalizeTargetAgentId(targetAgentId);
  const nowMs = Date.now();
  const agent = listAgents()
    .filter((item) => isAgentOnline(item, nowMs))
    .filter((item) => !normalizedTargetAgentId || item.id === normalizedTargetAgentId)
    .find((item) => (item.workspaces || []).some((workspace) => workspace.id === normalizedProjectId));
  return agent?.runtime || fallbackRuntimeForSanitization();
}

function runtimeForAgentAndProject(agentId, projectId) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedProjectId = String(projectId || "").trim();
  const agent = listAgents().find((item) => item.id === normalizedAgentId);
  if (!agent || !(agent.workspaces || []).some((workspace) => workspace.id === normalizedProjectId)) {
    return fallbackRuntimeForSanitization();
  }
  return agent.runtime || fallbackRuntimeForSanitization();
}

function fallbackRuntimeForSanitization() {
  return {
    backendId: "codex",
    provider: "codex",
    backendName: "Codex",
    sandbox: config.codex.sandbox,
    approvalPolicy: config.codex.approvalPolicy,
    model: "",
    worktreeMode: config.codex.worktreeMode,
    unsupportedModels: [],
    supportedModels: [],
    allowedPermissionModes: normalizeAllowedPermissionModes()
  };
}

function parseJson(value, fallback = undefined) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function latestIso(values = []) {
  let latest = "";
  let latestMs = -Infinity;
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text) continue;
    const ms = Date.parse(text);
    if (!Number.isFinite(ms) || ms < latestMs) continue;
    latest = text;
    latestMs = ms;
  }
  return latest;
}

function statusVersionFor(snapshot = {}) {
  const payload = JSON.stringify({
    statusUpdatedAt: snapshot.statusUpdatedAt || "",
    workspacesUpdatedAt: snapshot.workspacesUpdatedAt || "",
    runtimeUpdatedAt: snapshot.runtimeUpdatedAt || "",
    hiddenWorkspaceKeys: Array.from(snapshot.hiddenWorkspaceKeys || []).sort(),
    agents: (snapshot.agents || []).map((agent) => ({
      id: agent.id,
      lastSeenAt: agent.lastSeenAt,
      snapshotUpdatedAt: agent.snapshotUpdatedAt,
      workspacesUpdatedAt: agent.workspacesUpdatedAt,
      runtimeUpdatedAt: agent.runtimeUpdatedAt,
      online: agent.online
    }))
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function imageArtifactCandidateFromText(value) {
  const text = stripMarkdownCodeFence(String(value || "").trim());
  if (!text) return null;

  const dataUrlPayload = imageDataUrlPayloadFromText(text);
  if (dataUrlPayload) {
    const parsed = parseImageDataUrlForArtifact(dataUrlPayload.dataUrl);
    if (!parsed) return null;
    return {
      ...parsed,
      label: "Assistant image",
      cleanText: dataUrlPayload.cleanText
    };
  }

  const payload = base64ImagePayloadFromText(text);
  if (!payload) return null;
  const buffer = bufferFromBase64(payload.base64);
  if (!buffer) return null;
  const mimeType = imageMimeTypeFromBuffer(buffer);
  if (!mimeType) return null;
  return {
    buffer,
    mimeType,
    extension: attachmentExtensionFromMimeType(mimeType),
    label: "Assistant image",
    cleanText: payload.cleanText
  };
}

function stripMarkdownCodeFence(value) {
  const text = String(value || "").trim();
  const match = /^```(?:[a-z0-9_-]+)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

function imageDataUrlPayloadFromText(value) {
  const text = String(value || "").trim();
  if (/^data:image\/[a-z0-9.+_-]+;base64,/i.test(text)) return { dataUrl: text, cleanText: "" };
  const match = /data:image\/[a-z0-9.+_-]+;base64,[a-z0-9+/=\r\n]+/i.exec(text);
  if (!match) return null;
  const cleanText = text
    .replace(match[0], "")
    .replace(/!\[[^\]]*]\(\s*\)/g, "")
    .trim();
  return { dataUrl: match[0], cleanText };
}

function base64ImagePayloadFromText(value) {
  const text = String(value || "").trim();
  const direct = text.replace(/\s+/g, "");
  if (isPlausibleBase64Payload(direct)) return { base64: direct, cleanText: "" };

  const lines = text.split(/\r?\n/);
  let best = null;
  let current = null;
  const finishBlock = () => {
    if (!current) return;
    const base64 = current.lines.join("");
    if (isPlausibleBase64Payload(base64) && (!best || base64.length > best.base64.length)) {
      best = { ...current, base64 };
    }
    current = null;
  };

  lines.forEach((line, index) => {
    const compact = line.trim().replace(/\s+/g, "");
    if (/^[a-z0-9+/=]{16,}$/i.test(compact)) {
      current ||= { start: index, end: index, lines: [] };
      current.end = index;
      current.lines.push(compact);
      return;
    }
    finishBlock();
  });
  finishBlock();

  if (!best) return null;
  const cleanText = lines
    .filter((_, index) => index < best.start || index > best.end)
    .join("\n")
    .trim();
  return { base64: best.base64, cleanText };
}

function isPlausibleBase64Payload(value) {
  const text = String(value || "");
  if (text.length < 64 || text.length % 4 === 1) return false;
  return /^[a-z0-9+/]+={0,2}$/i.test(text);
}

function imageMimeTypeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const header6 = buffer.subarray(0, 6).toString("ascii");
  if (header6 === "GIF87a" || header6 === "GIF89a") return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  const prefix = buffer.subarray(0, Math.min(buffer.length, 256)).toString("utf8").trimStart().toLowerCase();
  if (prefix.startsWith("<svg")) return "image/svg+xml";
  return "";
}

function assistantImageDisplayText(cleanText = "") {
  const text = String(cleanText || "").trim();
  return text || "图片已生成。";
}

function normalizeAgentId(value) {
  return String(value || "default-agent").trim().slice(0, 120) || "default-agent";
}

function normalizeAgentInstanceId(value) {
  return String(value || "").trim().slice(0, 120);
}

function normalizeTargetAgentId(value) {
  return String(value || "").trim().slice(0, 120);
}

function normalizeWorkspaceImportRootId(value) {
  const rootId = String(value || "").trim().slice(0, 160);
  if (!rootId) return badRequest("Import root is required.");
  if (!/^[a-zA-Z0-9_.:-]+$/.test(rootId)) return badRequest("Import root is invalid.");
  return rootId;
}

function normalizeWorkspaceImportPath(value) {
  const raw = String(value || "").replaceAll("\\", "/").trim();
  if (!raw || raw === "." || raw === "/") return "";
  if (raw.includes("\0")) return badRequest("Directory path is invalid.");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || raw.startsWith("~/") || raw === "~") {
    return badRequest("Import paths must be relative to the selected root.");
  }

  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return badRequest("Import paths must stay inside the selected root.");
    parts.push(part);
  }
  return parts.join("/").slice(0, 1000);
}

function normalizeOwnerUser(value) {
  return String(value || "").trim().toLowerCase().slice(0, 120);
}

function workspaceVisibilityOwner(input = {}) {
  const user = input.user;
  return normalizeOwnerUser(input.ownerUser || user?.username || user?.displayName || input.requestedBy);
}

function workspaceKey(agentId, workspaceId) {
  const agent = normalizeTargetAgentId(agentId) || "default-agent";
  const workspace = String(workspaceId || "").trim();
  return `${agent}:${workspace}`;
}

function canAccessOwner(user = null, ownerUser = "") {
  if (!user) return true;
  if (String(user.role || "").toLowerCase() === "owner") return true;
  const username = normalizeOwnerUser(user.username || user.displayName);
  const owner = normalizeOwnerUser(ownerUser);
  if (!owner) return false;
  return Boolean(username && owner && username === owner);
}

function canAccessAgent(user = null, agent = {}) {
  return canAccessAgentOwner(user, {
    agentId: agent.id || agent.agentId,
    ownerUser: agent.ownerUser || agent.ownerUsername
  });
}

function canAccessSessionContent(session, options = {}) {
  if (!session) return false;
  const agentId = normalizeTargetAgentId(options.agentId);
  if (agentId && session.targetAgentId && session.targetAgentId === agentId) return true;
  return canAccessOwner(options.user, session.ownerUser);
}

function addOwnerAccessClause(clauses, params, user = null, alias = "") {
  if (!user || String(user.role || "").toLowerCase() === "owner") return;
  const username = normalizeOwnerUser(user.username || user.displayName);
  const prefix = alias ? `${alias}.` : "";
  clauses.push(`${prefix}owner_user = @ownerUser`);
  params.ownerUser = username || "__no_user__";
}

function normalizeIdSet(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return new Set(items.map((item) => String(item || "").trim()).filter(Boolean));
}

function normalizeSessionCommandTypes(value) {
  const allowed = new Set(["start", "message", "stop", "compact", "worktree", "archive"]);
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(
    new Set(items.map((item) => String(item || "").trim().toLowerCase()).filter((item) => allowed.has(item)))
  );
}

function shouldSkipSessionCommandForBusyDesktop(
  command,
  runtime,
  { blockedSessionIds = new Set(), blockedProjectIds = new Set(), activeRunningSessionIds = new Set() } = {}
) {
  if (command.type === "stop") return false;
  if (command.type === "archive") return false;
  if (command.type === "worktree") {
    const action = normalizeWorktreeAction(parseJson(command.payloadJson, {})?.action);
    if (action === "discard") return false;
    return blockedProjectIds.has(command.projectId);
  }
  if (blockedSessionIds.has(command.sessionId)) return true;
  if (!blockedProjectIds.has(command.projectId)) return false;
  if (activeRunningSessionIds.has(command.sessionId)) return false;
  return String(runtime?.worktreeMode || "").trim() !== "always";
}

function canMutateSession(session, agentId) {
  const providedAgentId = String(agentId || "").trim();
  if (!session.leasedBy || !providedAgentId) return false;
  return session.leasedBy === normalizeAgentId(providedAgentId);
}

function canMutateSessionLease(session, agentId, agentInstanceId = "") {
  if (!canMutateSession(session, agentId)) return false;
  const providedInstanceId = normalizeAgentInstanceId(agentInstanceId);
  return !providedInstanceId || !session.leasedInstanceId || session.leasedInstanceId === providedInstanceId;
}

function sessionEventProtocolRefs(events = [], options = {}) {
  const refs = [];
  const optionCommandId = String(options.commandId || "").trim();
  if (optionCommandId) refs.push({ commandId: optionCommandId, attempt: options.attempt });
  for (const event of events || []) {
    const commandId = String(event?.commandId || "").trim();
    if (commandId) refs.push({ commandId, attempt: event.attempt });
  }
  return refs;
}

function canReportSessionCommand(commandId, attempt, sessionId, agentId, agentInstanceId = "") {
  const command = getSessionCommandSummary(commandId);
  const providedAgentId = normalizeAgentId(agentId);
  const providedAttempt = Number(attempt);
  if (!command || command.sessionId !== sessionId || !Number.isInteger(providedAttempt) || providedAttempt !== command.attempt) {
    return false;
  }
  if (["done", "failed"].includes(command.status)) return command.completedBy === providedAgentId;
  if (!["leased", "reconciling"].includes(command.status) || command.leasedBy !== providedAgentId) return false;
  const providedInstanceId = normalizeAgentInstanceId(agentInstanceId);
  return !providedInstanceId || !command.leasedInstanceId || command.leasedInstanceId === providedInstanceId;
}

function touchSessionLeaseForAgent(sessionId, agentId, options = {}) {
  const leasedBy = normalizeAgentId(agentId);
  if (!sessionId || !leasedBy) return false;
  const agentInstanceId = normalizeAgentInstanceId(options.agentInstanceId);
  const now = options.now || nowIso();
  const leaseExpiresAt = options.leaseExpiresAt || new Date(Date.now() + config.codex.leaseMs).toISOString();
  const updated = db.prepare(`
    UPDATE codex_sessions
    SET lease_expires_at = @leaseExpiresAt,
        leased_instance_id = CASE
          WHEN @agentInstanceId <> '' AND leased_instance_id = '' THEN @agentInstanceId
          ELSE leased_instance_id
        END,
        updated_at = @now
    WHERE id = @sessionId
      AND leased_by = @leasedBy
      AND (@agentInstanceId = '' OR leased_instance_id = '' OR leased_instance_id = @agentInstanceId)
  `).run({
    sessionId,
    leasedBy,
    agentInstanceId,
    leaseExpiresAt,
    now
  });
  const commandUpdates = touchSessionCommandLeasesForAgent(sessionId, leasedBy, { now, leaseExpiresAt, agentInstanceId });
  return updated.changes > 0 || commandUpdates > 0;
}

function touchSessionCommandLeasesForAgent(sessionId, agentId, options = {}) {
  const leasedBy = normalizeAgentId(agentId);
  if (!sessionId || !leasedBy) return 0;
  const agentInstanceId = normalizeAgentInstanceId(options.agentInstanceId);
  const now = options.now || nowIso();
  const leaseExpiresAt = options.leaseExpiresAt || new Date(Date.now() + config.codex.leaseMs).toISOString();
  const updated = db.prepare(`
    UPDATE codex_session_commands
    SET status = 'leased',
        lease_expires_at = @leaseExpiresAt,
        leased_instance_id = CASE
          WHEN @agentInstanceId <> '' AND leased_instance_id = '' THEN @agentInstanceId
          ELSE leased_instance_id
        END,
        updated_at = @now
    WHERE session_id = @sessionId
      AND status IN ('leased', 'reconciling')
      AND leased_by = @leasedBy
      AND (@agentInstanceId = '' OR leased_instance_id = '' OR leased_instance_id = @agentInstanceId)
  `).run({
    sessionId,
    leasedBy,
    agentInstanceId,
    leaseExpiresAt,
    now
  });
  return updated.changes;
}

function sessionCanRecoverFailure(session = {}) {
  const error = String(session.lastError || session.error || "");
  if (
    /thread not found|requires a newer version of Codex|Please upgrade to the latest app or CLI|rate[ _-]?limit|rate limited|rate_limited|too many requests|\b429\b|quota|temporarily unavailable|overloaded|capacity|限流|速率限制|请求过多/i.test(
      error
    )
  ) {
    return true;
  }
  if (String(session.appThreadId || "").trim()) return true;
  return sessionHasRecoverableHistory(session.id);
}

function sessionHasUnresetAssistantImageArtifact(sessionId) {
  const row = db.prepare(`
    SELECT 1
    FROM codex_session_artifacts artifact
    WHERE artifact.session_id = ?
      AND artifact.kind = 'assistant_image'
      AND NOT EXISTS (
        SELECT 1
        FROM codex_session_events event
        WHERE event.session_id = artifact.session_id
          AND event.id > COALESCE(artifact.event_id, 0)
          AND event.type IN ('thread.restarted', 'session.context.reset.queued', 'session.backend.switched', 'context.compaction.queued', 'thread/compacted')
      )
    LIMIT 1
  `).get(sessionId);
  return Boolean(row);
}

function isRecoverableSessionNotice(error = "") {
  const text = String(error || "");
  return (
    /Desktop agent restarted before this turn reported completion/i.test(text) ||
    /\bDesktop agent\b.*\bstopped renewing this (turn|session)\b/i.test(text)
  );
}

function sessionHasRecoverableHistory(sessionId) {
  if (!sessionId) return false;
  const row = db.prepare(`
    SELECT 1
    FROM codex_session_messages m
    WHERE m.session_id = ?
      AND m.role IN ('user', 'assistant')
      AND (
        TRIM(COALESCE(m.text, '')) <> ''
        OR EXISTS (
          SELECT 1
          FROM codex_session_attachments a
          WHERE a.message_id = m.id
        )
      )
    LIMIT 1
  `).get(sessionId);
  return Boolean(row);
}

function sessionCanCompact(session = {}) {
  if (["queued", "starting", "running", "failed", "closed", "stale", "cancelled"].includes(session.status)) return false;
  return (
    Number(session.pendingCommandCount || 0) === 0 &&
    Number(session.pendingApprovalCount || 0) === 0 &&
    Number(session.pendingInteractionCount || 0) === 0
  );
}

function canMutateRunningJob(job, agentId) {
  const providedAgentId = String(agentId || "").trim();
  if (job.status !== "running" || !job.leasedBy || !providedAgentId) return false;
  return job.leasedBy === normalizeAgentId(providedAgentId);
}

function normalizeWorkspaceName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function normalizeMcpProfileId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeMcpTargetClients(value, fallback = []) {
  const allowed = new Set(["codex", "claude-code"]);
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const targets = raw.map((item) => String(item || "").trim()).filter((item) => allowed.has(item));
  const normalized = targets.length
    ? targets
    : fallback.map((item) => String(item || "").trim()).filter((item) => allowed.has(item));
  return Array.from(new Set(normalized));
}

function normalizeAgentSkillCommandType(value) {
  const type = String(value || "agent-skill.list").trim().toLowerCase();
  if (type === "list" || type === "refresh" || type === "agent-skill.list") return "agent-skill.list";
  if (type === "update" || type === "agent-skill.update") return "agent-skill.update";
  if (type === "sync" || type === "retry" || type === "agent-skill.sync") return "agent-skill.sync";
  if (type === "import" || type === "add" || type === "agent-skill.import") return "agent-skill.import";
  return badRequest("Unsupported Agent Skill command type.");
}

function normalizeAgentSkillId(value) {
  return String(value || "").trim().slice(0, 160);
}

function normalizeAgentSkillProviderId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeAgentSkillTargetProviders(value, allowedProviders = new Set()) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const requested = raw.map(normalizeAgentSkillProviderId).filter(Boolean);
  const unknown = requested.find((provider) => !allowedProviders.has(provider));
  if (unknown) return badRequest("Unknown Agent Skill backend.");
  return Array.from(new Set(requested)).slice(0, 8);
}

function normalizeDesktopPluginCommandType(value) {
  const type = String(value || "plugin.list").trim().toLowerCase();
  if (type === "list" || type === "refresh" || type === "plugin.list") return "plugin.list";
  if (type === "update" || type === "plugin.update") return "plugin.update";
  return badRequest("Unsupported desktop plugin command type.");
}

function normalizeDesktopPluginId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function advertisedDesktopPluginRegistry(agent = null) {
  const runtime = agent?.runtime && typeof agent.runtime === "object" ? agent.runtime : {};
  const snapshot = runtime.plugins && typeof runtime.plugins === "object" ? runtime.plugins : {};
  const plugins = Array.isArray(snapshot.plugins) ? snapshot.plugins : [];
  const normalized = plugins
    .map((plugin) => ({
      id: normalizeDesktopPluginId(plugin?.id),
      enabled: plugin?.enabled === true,
      requires: Array.isArray(plugin?.requires) ? plugin.requires.map(normalizeDesktopPluginId).filter(Boolean).slice(0, 8) : [],
      prerequisites: {
        managedWorktree: plugin?.prerequisites?.managedWorktree === true
      }
    }))
    .filter((plugin) => plugin.id);
  return {
    canManage: Boolean(snapshot.capability?.canManage),
    plugins: new Map(normalized.map((plugin) => [plugin.id, plugin])),
    pluginIds: new Set(normalized.map((plugin) => plugin.id)),
    enabledPluginIds: new Set(normalized.filter((plugin) => plugin.enabled).map((plugin) => plugin.id))
  };
}

function advertisedAgentSkillRegistry(agent = null) {
  const runtime = agent?.runtime && typeof agent.runtime === "object" ? agent.runtime : {};
  const snapshot = runtime.agentSkills && typeof runtime.agentSkills === "object" ? runtime.agentSkills : {};
  const skills = Array.isArray(snapshot.skills)
    ? snapshot.skills
    : Array.isArray(runtime.installedSkills)
      ? runtime.installedSkills
      : [];
  const providers = Array.isArray(snapshot.capability?.providers)
    ? snapshot.capability.providers
    : advertisedAgentSkillProvidersFromSkills(skills);
  const providerIds = new Set(
    providers
      .map((provider) => normalizeAgentSkillProviderId(provider.provider || provider.id))
      .filter(Boolean)
  );
  const skillIds = new Set(skills.map((skill) => normalizeAgentSkillId(skill.id)).filter(Boolean));
  return {
    canManage: Boolean(snapshot.capability?.canManage),
    providerIds,
    skillIds
  };
}

function advertisedAgentSkillProvidersFromSkills(skills = []) {
  const byProvider = new Map();
  for (const skill of skills) {
    for (const provider of Array.isArray(skill.providers) ? skill.providers : []) {
      const id = normalizeAgentSkillProviderId(provider.provider || provider.id);
      if (id) byProvider.set(id, { provider: id, label: String(provider.label || id).trim() });
    }
  }
  return Array.from(byProvider.values());
}

function normalizeFileRequestType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "list" || type === "read" || type === "open-spec-summary" || type === "orchestration-plan") return type;
  return badRequest("Unsupported file browser request type.");
}

function normalizeFileRequestProjectId(value) {
  const projectId = String(value || "").trim().slice(0, 160);
  if (!projectId) return badRequest("Project is required.");
  return projectId;
}

function normalizeFileRequestPath(value) {
  const raw = String(value || "").replaceAll("\\", "/").trim();
  if (!raw || raw === "." || raw === "/") return "";
  if (raw.includes("\0")) return badRequest("File path is invalid.");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || raw.startsWith("~/") || raw === "~") {
    return badRequest("File browser paths must be relative to the selected workspace.");
  }

  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return badRequest("File browser paths must stay inside the selected workspace.");
    parts.push(part);
  }
  return parts.join("/").slice(0, 1000);
}

function normalizeFileRequestPayload(type, input = {}) {
  if (type === "open-spec-summary") {
    return {
      path: "",
      maxChanges: clampInteger(input.maxChanges, 1, 200, 80),
      maxSpecs: clampInteger(input.maxSpecs, 1, 240, 120)
    };
  }

  if (type === "orchestration-plan") {
    const items = Array.isArray(input.items) ? input.items : [];
    if (items.length < 1 || items.length > 50) return badRequest("Orchestration plan requires 1-50 change Items.");
    const normalizedItems = items.map((item) => ({
      changeId: normalizeDesktopPluginId(item?.changeId || item?.id),
      dependsOn: Array.isArray(item?.dependsOn)
        ? [...new Set(item.dependsOn.map(normalizeDesktopPluginId).filter(Boolean))].slice(0, 50)
        : []
    }));
    if (normalizedItems.some((item) => !item.changeId)) return badRequest("Every orchestration Item requires a change id.");
    return {
      path: "",
      items: normalizedItems
    };
  }

  const payload = { path: normalizeFileRequestPath(input.path) };
  const sessionContext = input.sessionContext && typeof input.sessionContext === "object" ? input.sessionContext : null;
  if (sessionContext?.sessionId) {
    payload.sessionContext = {
      sessionId: String(sessionContext.sessionId).slice(0, 120),
      executionTarget: sessionContext.executionTarget === "session-worktree" ? "session-worktree" : "workspace",
      baseWorkspaceId: String(sessionContext.baseWorkspaceId || "").slice(0, 240),
      desktopAgentId: String(sessionContext.desktopAgentId || "").slice(0, 240),
      lifecycleState: String(sessionContext.lifecycleState || "").slice(0, 80)
    };
  }
  if (type === "list") {
    payload.maxEntries = clampInteger(input.maxEntries, 1, 500, 240);
  }
  if (type === "read") {
    payload.maxBytes = clampInteger(input.maxBytes, 1024, 320 * 1024, 160 * 1024);
  }
  return payload;
}

function onlineWorkspaceForProject(projectId, options = {}) {
  const normalizedProjectId = String(projectId || "").trim();
  const targetAgentId = normalizeTargetAgentId(options.targetAgentId);
  const nowMs = Date.now();
  const matches = [];
  for (const agent of listAgents()) {
    if (!isAgentOnline(agent, nowMs)) continue;
    if (!canAccessAgent(options.user, agent)) continue;
    if (targetAgentId && agent.id !== targetAgentId) continue;
    const workspace = (agent.workspaces || []).find((item) => item.id === normalizedProjectId);
    if (workspace) matches.push({ ...workspace, agentId: agent.id, agentOwnerUser: agent.ownerUser });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 && !targetAgentId) return { ambiguous: true, matches };
  return matches[0] || null;
}

function workspacePreferenceOwner(input = {}) {
  const ownerUser = normalizeOwnerUser(input.ownerUser || input.user?.username || "local");
  if (!ownerUser) return badRequest("Owner user is required.");
  return ownerUser;
}

function assertKnownWorkspacePreferenceScope({ ownerUser, targetAgentId, workspaceId, user, requireOnline = false } = {}) {
  const nowMs = Date.now();
  const agent = listAgents().find((item) => {
    if (item.id !== targetAgentId || !canAccessAgent(user, item)) return false;
    if (requireOnline && !isAgentOnline(item, nowMs)) return false;
    return (item.workspaces || []).some((workspace) => workspace.id === workspaceId);
  });
  if (!agent) {
    return requireOnline
      ? conflict("Desktop agent is not online for this Workspace.")
      : notFound("Desktop agent or Workspace was not found.");
  }
  return agent;
}

function selectWorkspaceRuntimePreference(ownerUser, targetAgentId, workspaceId) {
  const row = db.prepare(`
    SELECT owner_user AS ownerUser,
           target_agent_id AS targetAgentId,
           workspace_id AS workspaceId,
           preference_json AS preferenceJson,
           version,
           created_at AS createdAt,
           updated_at AS updatedAt
    FROM workspace_runtime_preferences
    WHERE owner_user = ?
      AND target_agent_id = ?
      AND workspace_id = ?
  `).get(ownerUser, targetAgentId, workspaceId);
  if (!row) return null;
  return {
    ownerUser: row.ownerUser,
    targetAgentId: row.targetAgentId,
    workspaceId: row.workspaceId,
    ...parseJson(row.preferenceJson, {}),
    version: Number(row.version || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function defaultOnlineAgentIdForUser(user = null) {
  const nowMs = Date.now();
  const agent = listAgents().find((item) => isAgentOnline(item, nowMs) && canAccessAgent(user, item));
  return agent?.id || "";
}

function onlineAgentForUser(agentId, user = null) {
  const targetAgentId = normalizeTargetAgentId(agentId);
  if (!targetAgentId) return null;
  const nowMs = Date.now();
  return listAgents().find((item) => item.id === targetAgentId && isAgentOnline(item, nowMs) && canAccessAgent(user, item)) || null;
}

function normalizeWorkspaces(workspaces = []) {
  return Array.isArray(workspaces)
    ? workspaces
        .map((workspace) => ({
          id: String(workspace.id || "").trim(),
          label: String(workspace.label || workspace.id || "").trim(),
          path: String(workspace.path || "").trim()
        }))
        .filter((workspace) => workspace.id && workspace.path)
    : [];
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeRuntime(runtime = {}) {
  const source = runtime && typeof runtime === "object" ? runtime : {};
  const unsupportedModels = Array.isArray(runtime.unsupportedModels)
    ? runtime.unsupportedModels.map((model) => String(model || "").trim()).filter(Boolean)
    : [];
  const supportedModels = normalizeSupportedModels(runtime.supportedModels);
  const allowedPermissionModes = Array.isArray(runtime.allowedPermissionModes)
    ? normalizeAllowedPermissionModes(runtime.allowedPermissionModes)
    : [];
  const permissionMode = normalizePermissionMode(
    runtime.permissionMode || runtime.permissionsMode || runtime.profile || permissionModeFromRuntime(runtime)
  );
  const backendId = String(runtime.backendId || runtime.provider || "codex").trim() || "codex";
  const provider = String(runtime.provider || runtime.backendId || backendId).trim() || backendId;
  const backendName = String(
    runtime.backendName ||
      runtime.name ||
      (backendId === "codex" || provider === "codex" ? "Codex" : "")
  ).trim();
  const backends = normalizeRuntimeBackends(runtime.backends, runtime).map(normalizeRuntimeContractFields);
  return runtime && typeof runtime === "object"
    ? normalizeRuntimeContractFields({
        ...source,
        backendId,
        provider,
        backendName: backendName || ((backendId === "codex" || provider === "codex") ? "Codex" : ""),
        defaultBackendId: String(runtime.defaultBackendId || backendId).trim() || backendId,
        backends,
        command: String(runtime.command || "").trim(),
        sandbox: String(runtime.sandbox || "").trim(),
        approvalPolicy: String(runtime.approvalPolicy || "").trim(),
        model: codexCompatibleModel(runtime.model),
        unsupportedModels,
        supportedModels,
        allowedPermissionModes,
        reasoningEffort: normalizeReasoningEffort(runtime.reasoningEffort || runtime.effort),
        profile: String(runtime.profile || permissionMode || "").trim(),
        permissionMode,
        worktreeMode: String(runtime.worktreeMode || "").trim(),
        modelCapabilitySource: String(runtime.modelCapabilitySource || "").trim(),
        modelCapabilityCheckedAt: String(runtime.modelCapabilityCheckedAt || "").trim(),
        modelCapabilityError: String(runtime.modelCapabilityError || "").trim(),
        timeoutMs: Number(runtime.timeoutMs || 0) || null
      })
    : {};
}

function normalizeRuntimeContractFields(runtime = {}) {
  const source = runtime && typeof runtime === "object" ? runtime : {};
  const capabilityDefaults = isCodexBackend(source.backendId, source.provider)
    ? {
        supports: {
          text: true,
          attachments: true,
          cancellation: true,
          contextUsage: true,
          compaction: true,
          approvalRequests: true,
          interactionRequests: true,
          gitSummary: true,
          worktree: true
        }
      }
    : {};
  const capabilities = normalizeBackendCapabilities(source.capabilities, capabilityDefaults);
  const unsupportedFeatures = normalizeStringList(source.unsupportedFeatures || capabilities.unsupportedFeatures);
  return {
    ...source,
    contractVersion: String(source.contractVersion || backendAdapterContractVersion).trim(),
    capabilities: {
      ...capabilities,
      unsupportedFeatures
    },
    unsupportedFeatures,
    health: normalizeBackendHealth(source.health, {
      backendId: source.backendId,
      provider: source.provider,
      backendName: source.backendName,
      state: source.command ? "ready" : "unavailable",
      ok: Boolean(source.command)
    })
  };
}

function isCodexBackend(backendId, provider) {
  const normalizedBackendId = String(backendId || "").trim().toLowerCase();
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  return normalizedBackendId === "codex" || normalizedProvider === "codex";
}

function stageSessionAttachments({ sessionId, messageId, attachments = [], createdAt }) {
  const normalized = normalizeSessionAttachments(attachments);
  const staged = [];

  for (const attachment of normalized) {
    const content = parseAttachmentDataUrl(attachment.url, attachment.mimeType);
    if (!content) continue;
    const attachmentId = crypto.randomUUID();
    const type = content.mimeType.startsWith("image/") ? "image" : attachment.type === "image" ? "image" : "file";
    const extension = attachmentExtensionForUpload(attachment.name, content.mimeType);
    const storageKey = attachmentStorageKey(sessionId, attachmentId, extension);
    const absolutePath = attachmentAbsolutePath(storageKey);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content.buffer, { mode: 0o600 });
    staged.push({
      id: attachmentId,
      sessionId,
      messageId,
      type,
      originalName: String(attachment.name || "").trim(),
      mimeType: content.mimeType,
      sizeBytes: clampAttachmentSizeBytes(attachment.sizeBytes || content.buffer.length),
      sha256: crypto.createHash("sha256").update(content.buffer).digest("hex"),
      storageKey,
      createdAt,
      absolutePath
    });
  }

  return staged;
}

function cleanupStagedAttachments(attachments = []) {
  for (const attachment of attachments) {
    if (!attachment?.absolutePath) continue;
    try {
      fs.rmSync(attachment.absolutePath, { force: true });
    } catch {
      // Ignore best-effort cleanup errors for staged attachment files.
    }
  }
}

function cleanupAttachmentStorageKeys(storageKeys = []) {
  for (const storageKey of storageKeys) {
    if (!storageKey) continue;
    try {
      fs.rmSync(attachmentAbsolutePath(storageKey), { force: true });
    } catch {
      // Ignore best-effort cleanup errors for persisted attachment files.
    }
  }
}

function cleanupArtifactStorageKeys(storageKeys = []) {
  for (const storageKey of storageKeys) {
    if (!storageKey) continue;
    try {
      fs.rmSync(artifactAbsolutePath(storageKey), { force: true });
    } catch {
      // Ignore best-effort cleanup errors for persisted artifact files.
    }
  }
}

function ensureOwnerStorageQuota(ownerUser, additionalBytes = 0) {
  const owner = normalizeOwnerUser(ownerUser);
  const bytes = Math.max(0, Number(additionalBytes || 0) || 0);
  if (!owner || bytes <= 0) return;
  const quotaBytes = getStorageQuotaBytes(owner);
  if (!quotaBytes) return;
  const usage = ownerStorageUsage(owner);
  if (usage.totalBytes + bytes <= quotaBytes) return;
  throwHttpError(413, `Storage quota exceeded for ${owner}.`);
}

function attachmentBytes(attachments = []) {
  return attachments.reduce((sum, item) => sum + Math.max(0, Number(item?.sizeBytes || 0) || 0), 0);
}

function artifactBytes(artifacts = []) {
  return artifacts.reduce((sum, item) => sum + Math.max(0, Number(item?.sizeBytes || 0) || 0), 0);
}

function attachmentRefsFromRows(rows = []) {
  return rows.map((row) => {
    const attachment = summarizeSessionAttachment(row);
    return {
      id: attachment.id,
      type: attachment.type,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      downloadPath: attachment.downloadPath
    };
  });
}

function commandAttachmentsFromMessage(message) {
  return (message.attachments || []).map((attachment) => ({
    type: attachment.type || "file",
    id: attachment.id,
    attachmentId: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    sha256: attachment.sha256,
    downloadPath: `/api/agent/codex/attachments/${encodeURIComponent(attachment.id)}`
  }));
}

function attachmentStorageKey(sessionId, attachmentId, extension) {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeAttachmentId = String(attachmentId || "attachment").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeExtension = String(extension || "bin").replace(/[^a-z0-9]+/gi, "").toLowerCase() || "bin";
  return `${safeSessionId}/${safeAttachmentId}.${safeExtension}`;
}

function attachmentAbsolutePath(storageKey) {
  return path.join(attachmentStorageDir, ...String(storageKey || "").split("/"));
}

function artifactStorageKey(sessionId, artifactId, extension) {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeArtifactId = String(artifactId || "artifact").replace(/[^a-zA-Z0-9._-]+/g, "-");
  const safeExtension = String(extension || "txt").replace(/[^a-z0-9]+/gi, "").toLowerCase() || "txt";
  return `${safeSessionId}/${safeArtifactId}.${safeExtension}`;
}

function artifactAbsolutePath(storageKey) {
  return path.join(artifactStorageDir, ...String(storageKey || "").split("/"));
}

function parseAttachmentDataUrl(url, fallbackMimeType = "") {
  const match = /^data:([^;,]*)(?:;[a-z0-9=.+_-]+)*;base64,([a-z0-9+/=\s]+)$/i.exec(String(url || "").trim());
  if (!match) return null;
  const mimeType = normalizeAttachmentMimeType(fallbackMimeType || match[1]);
  const base64 = match[2].replace(/\s+/g, "");
  if (!base64) return null;
  return {
    mimeType,
    buffer: Buffer.from(base64, "base64")
  };
}

function normalizeAttachmentMimeType(value) {
  const mimeType = String(value || "").split(";")[0].trim().toLowerCase();
  if (/^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/i.test(mimeType)) return mimeType;
  return "application/octet-stream";
}

function attachmentExtensionForUpload(name, mimeType) {
  const fromName = path.extname(String(name || "").trim()).replace(/^\./, "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
  if (fromName) return fromName.slice(0, 24);
  return attachmentExtensionFromMimeType(mimeType);
}

function attachmentExtensionFromMimeType(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "text/plain") return "txt";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/json") return "json";
  if (mimeType === "text/csv") return "csv";
  if (mimeType === "application/zip") return "zip";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (mimeType === "application/msword") return "doc";
  if (mimeType === "application/vnd.ms-excel") return "xls";
  if (mimeType === "application/vnd.ms-powerpoint") return "ppt";
  return mimeType.split("/")[1]?.replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 24) || "bin";
}

function buildAssistantMessages(sessionId, incomingEvents = [], fallbackAt) {
  const messages = [];
  for (const event of incomingEvents || []) {
    const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
    const item = raw.params?.item;
    if ((raw.method || event.type) !== "item/completed" || !isStoredAssistantMessageItem(raw, event)) continue;
    const text = String(item?.text || event.finalMessage || event.text || "").trim();
    if (!text) continue;
    const turnId = String(raw.params?.turnId || raw.params?.turn?.id || "").trim();
    const itemId = String(item.id || "").trim();
    const keySeed = itemId || crypto.createHash("sha1").update(`${turnId}\n${text}`).digest("hex").slice(0, 16);
    messages.push({
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      text,
      commandId: null,
      externalKey: `assistant:${turnId || "turn"}:${keySeed}`,
      createdAt: String(event.at || fallbackAt || nowIso()),
      updatedAt: String(fallbackAt || nowIso())
    });
  }
  return messages;
}

function isStoredAssistantMessageItem(raw = {}, event = {}) {
  const item = raw.params?.item;
  if (!item || typeof item !== "object") return false;
  if (item.type === "agentMessage") return true;
  return assistantImageArtifactRefs(raw).length > 0 && Boolean(String(event.text || "").trim());
}

function normalizeSessionAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];

  const normalized = [];
  for (const attachment of attachments) {
    if (normalized.length >= 3) break;
    const declaredType = String(attachment?.type || "").trim().toLowerCase();
    const url = String(attachment.url || "").trim();
    if (!url.startsWith("data:")) continue;
    if (url.length > 10_000_000) continue;
    const mimeType = normalizeAttachmentMimeType(attachment.mimeType);
    const type = declaredType === "image" || url.startsWith("data:image/") || mimeType.startsWith("image/") ? "image" : declaredType === "file" ? "file" : "";
    if (!type) continue;
    const fallbackName = type === "image" ? `截图 ${normalized.length + 1}` : `附件 ${normalized.length + 1}`;
    normalized.push({
      type,
      url,
      name: String(attachment.name || fallbackName).trim().slice(0, 120) || fallbackName,
      mimeType: String(attachment.mimeType || mimeType).trim().slice(0, 120),
      sizeBytes: clampAttachmentSizeBytes(attachment.sizeBytes)
    });
  }

  return normalized;
}

function clampAttachmentSizeBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.min(Math.round(size), 20 * 1024 * 1024);
}

function sessionTitleFromInput(prompt, attachments = []) {
  const normalizedPrompt = String(prompt || "").split(/\s+/).join(" ").slice(0, 120);
  if (normalizedPrompt) return normalizedPrompt;
  const imageOnly = attachments.length > 0 && attachments.every((attachment) => attachment?.type === "image");
  if (attachments.length === 1) return imageOnly ? "1 张截图" : "1 个附件";
  if (attachments.length > 1) return imageOnly ? `${attachments.length} 张截图` : `${attachments.length} 个附件`;
  return "agent session";
}

function trimOldJobs() {
  const ids = db.prepare(`
    SELECT id
    FROM codex_jobs
    WHERE status IN ('completed', 'failed', 'cancelled', 'stale')
      AND id NOT IN (
        SELECT id
        FROM codex_jobs
        ORDER BY created_at DESC
        LIMIT 100
      )
  `).all().map((row) => row.id);

  if (ids.length === 0) return;

  const remove = db.prepare("DELETE FROM codex_jobs WHERE id = ?");
  const removeMany = db.transaction((jobIds) => {
    for (const id of jobIds) remove.run(id);
  });
  removeMany(ids);
}

function reclaimExpiredSessionCommandLeases() {
  const now = nowIso();
  const reconciliationExpiresAt = new Date(Date.now() + config.codex.leaseMs).toISOString();
  const expired = db.prepare(`
    SELECT c.id, c.session_id AS sessionId, c.type, c.leased_by AS leasedBy
    FROM codex_session_commands c
    WHERE c.status = 'leased'
      AND c.lease_expires_at IS NOT NULL
      AND c.lease_expires_at < ?
  `).all(now);

  if (expired.length === 0) return;

  const reclaim = db.transaction(() => {
    for (const command of expired) {
      db.prepare(`
        UPDATE codex_session_commands
        SET status = 'reconciling',
            lease_expires_at = @reconciliationExpiresAt,
            updated_at = @now
        WHERE id = @id
          AND status = 'leased'
      `).run({ id: command.id, reconciliationExpiresAt, now });

      insertSessionEvent.run(
        normalizeSessionEvent(command.sessionId, {
          type: "command.reconciliation.started",
          text: `Desktop agent ${command.leasedBy || "unknown"} stopped renewing ${command.type}; Relay is reconciling its local state.`
        }, now)
      );
    }
  });

  reclaim();
}

function expireStaleSessionCommandReconciliations() {
  const now = nowIso();
  const commands = db.prepare(`
    SELECT id, session_id AS sessionId, type, leased_by AS leasedBy
    FROM codex_session_commands
    WHERE status = 'reconciling'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
  `).all(now);
  if (commands.length === 0) return;

  const fail = db.transaction(() => {
    for (const command of commands) {
      const error = `Desktop agent ${command.leasedBy || "unknown"} did not reconcile the expired ${command.type} command.`;
      const updated = db.prepare(`
        UPDATE codex_session_commands
        SET status = 'failed', error = @error, result_json = @resultJson,
            completed_by = @completedBy, leased_by = NULL, leased_instance_id = '',
            lease_expires_at = NULL, updated_at = @now
        WHERE id = @id AND status = 'reconciling'
      `).run({
        id: command.id,
        error,
        resultJson: JSON.stringify({ ok: false, error, reconciliation: "timed_out" }),
        completedBy: command.leasedBy || "relay",
        now
      });
      if (updated.changes === 0) continue;
      db.prepare(`
        UPDATE codex_sessions
        SET status = 'failed', active_turn_id = NULL, last_error = @error,
            leased_by = NULL, leased_instance_id = '', lease_expires_at = NULL, updated_at = @now
        WHERE id = @sessionId
      `).run({ sessionId: command.sessionId, error, now });
      insertSessionEvent.run(normalizeSessionEvent(command.sessionId, {
        type: "command.reconciliation.failed",
        text: error,
        raw: { source: "relay", commandId: command.id, outcome: "timed_out" }
      }, now));
    }
  });
  fail();
}

function reclaimExpiredWorkspaceCommandLeases() {
  const now = nowIso();
  db.prepare(`
    UPDATE codex_workspace_commands
    SET status = 'queued',
        leased_by = NULL,
        lease_expires_at = NULL,
        updated_at = @now
    WHERE status = 'leased'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < @now
  `).run({ now });
}

function expireFileRequests() {
  const now = nowIso();
  db.prepare(`
    UPDATE codex_file_requests
    SET status = 'expired',
        leased_by = NULL,
        lease_expires_at = NULL,
        error = CASE WHEN error = '' THEN 'File browser request expired.' ELSE error END,
        updated_at = @now
    WHERE status IN ('queued', 'leased')
      AND expires_at <= @now
  `).run({ now });

  const cutoff = new Date(Date.now() - fileRequestRetentionMs).toISOString();
  db.prepare(`
    DELETE FROM codex_file_requests
    WHERE expires_at < @cutoff
      AND status IN ('done', 'failed', 'expired')
  `).run({ cutoff });
}

function reclaimExpiredSessionLeases() {
  const now = nowIso();
  const expired = db.prepare(`
    SELECT
      s.id,
      s.status,
      s.app_thread_id AS appThreadId,
      s.leased_by AS leasedBy
    FROM codex_sessions s
    WHERE s.leased_by IS NOT NULL
      AND s.lease_expires_at IS NOT NULL
      AND s.lease_expires_at < ?
      AND NOT EXISTS (
        SELECT 1
        FROM codex_session_commands c
        WHERE c.session_id = s.id
          AND c.status IN ('leased', 'reconciling')
      )
  `).all(now);

  if (expired.length === 0) return;

  const reclaim = db.transaction(() => {
    for (const session of expired) {
      const resetToQueued = session.status === "starting" && !session.appThreadId;
      const nextStatus = resetToQueued ? "queued" : "active";
      const hasQueuedContinuation = nextStatus === "active" && sessionHasQueuedContinuationCommand(session.id);
      const leaseError =
        nextStatus === "active" && !hasQueuedContinuation
          ? `Desktop agent ${session.leasedBy || "unknown"} stopped renewing this session; the last turn may have been interrupted.`
          : "";

      db.prepare(`
        UPDATE codex_sessions
          SET status = @status,
              active_turn_id = CASE WHEN @clearActiveTurnId = 1 THEN NULL ELSE active_turn_id END,
              last_error = CASE WHEN @clearLastError = 1 THEN '' WHEN @lastError = '' THEN last_error ELSE @lastError END,
              leased_by = NULL,
              leased_instance_id = '',
              lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @sessionId
      `).run({
        sessionId: session.id,
        status: nextStatus,
        clearActiveTurnId: nextStatus === "active" ? 1 : 0,
        clearLastError: hasQueuedContinuation ? 1 : 0,
        lastError: leaseError,
        now
      });

      insertSessionEvent.run(
        normalizeSessionEvent(session.id, {
          type: "session.lease.expired",
          text:
            nextStatus === "queued"
              ? `Desktop agent ${session.leasedBy || "unknown"} stopped renewing this session before the backend started; it returned to the queue.`
              : `Desktop agent ${session.leasedBy || "unknown"} stopped renewing this session; the conversation is ready to continue.`
        }, now)
      );
    }
  });

  reclaim();
}

function refreshInteractiveSessionState() {
  reclaimExpiredSessionCommandLeases();
  expireStaleSessionCommandReconciliations();
  discardTerminalSessionCommands();
  reclaimExpiredSessionLeases();
  reconcileCompletedRunningSessions();
  expireOldApprovals();
  expireOldInteractions();
}

function discardTerminalSessionCommands() {
  const now = nowIso();
  db.prepare(`
      UPDATE codex_session_commands
      SET status = 'failed',
          leased_by = NULL,
          leased_instance_id = '',
          lease_expires_at = NULL,
        error = CASE WHEN error = '' THEN 'Session is no longer runnable; command discarded.' ELSE error END,
        updated_at = @now
    WHERE status IN ('queued', 'leased', 'reconciling')
      AND session_id IN (
        SELECT id
        FROM codex_sessions
        WHERE status IN ('failed', 'closed', 'cancelled', 'stale')
      )
  `).run({ now });
}

function reconcileCompletedRunningSessions() {
  const rows = db.prepare(`
    SELECT
      s.id,
      s.app_thread_id AS appThreadId,
      s.active_turn_id AS activeTurnId,
      s.last_error AS lastError
    FROM codex_sessions s
    WHERE s.status = 'running'
      AND s.active_turn_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM codex_session_commands c
        WHERE c.session_id = s.id
          AND c.status IN ('leased', 'reconciling')
      )
  `).all();
  const completedSessions = rows
    .map((session) => ({
      ...session,
      completed: sessionCompletedAsyncWorkSince(session.id, "", session.activeTurnId, "", session.appThreadId)
    }))
    .filter((session) => session.completed);
  if (completedSessions.length === 0) return;

  const now = nowIso();
  const reconcile = db.transaction((sessions) => {
    for (const session of sessions) {
      const lastError =
        session.completed.status === "failed"
          ? String(session.lastError || session.completed.error || "").slice(0, 12000)
          : "";
      const update = db.prepare(`
        UPDATE codex_sessions
          SET status = @status,
              active_turn_id = NULL,
              last_error = @lastError,
              leased_by = NULL,
              leased_instance_id = '',
              lease_expires_at = NULL,
            updated_at = @now
        WHERE id = @sessionId
          AND status = 'running'
          AND active_turn_id = @activeTurnId
      `).run({
        sessionId: session.id,
        activeTurnId: session.activeTurnId,
        status: session.completed.status,
        lastError,
        now
      });
      if (update.changes === 0) continue;
      insertSessionEvent.run(
        normalizeSessionEvent(session.id, {
          type: session.completed.status === "failed" ? "session.reconciled.failed" : "session.reconciled",
          text:
            session.completed.status === "failed"
              ? "Relay reconciled a completed failed backend turn."
              : "Relay reconciled a completed backend turn."
        }, now)
      );
    }
  });
  reconcile(completedSessions);
}

function trimOldSessions() {
  const ids = db.prepare(`
    SELECT id
    FROM codex_sessions
    WHERE status IN ('failed', 'closed', 'stale')
      AND id NOT IN (
        SELECT id
        FROM codex_sessions
        ORDER BY updated_at DESC
        LIMIT 100
      )
  `).all().map((row) => row.id);

  if (ids.length === 0) return;

  const attachmentStorageKeys = db.prepare(`
    SELECT storage_key AS storageKey
    FROM codex_session_attachments
    WHERE session_id = ?
  `);
  const artifactStorageKeys = db.prepare(`
    SELECT storage_key AS storageKey
    FROM codex_session_artifacts
    WHERE session_id = ?
  `);
  const remove = db.prepare("DELETE FROM codex_sessions WHERE id = ?");
  const removeMany = db.transaction((sessionIds) => {
    const attachmentKeys = [];
    const artifactKeys = [];
    for (const id of sessionIds) {
      attachmentKeys.push(...attachmentStorageKeys.all(id).map((row) => row.storageKey));
      artifactKeys.push(...artifactStorageKeys.all(id).map((row) => row.storageKey));
      remove.run(id);
    }
    return { attachmentKeys, artifactKeys };
  });
  const keys = removeMany(ids);
  cleanupAttachmentStorageKeys(keys.attachmentKeys);
  cleanupArtifactStorageKeys(keys.artifactKeys);
}

function expireOldApprovals() {
  const cutoff = new Date(Date.now() - config.codex.approvalTimeoutMs).toISOString();
  const expired = db.prepare(`
    SELECT ${summarizeSessionApprovalColumns}
    FROM codex_session_approvals
    WHERE status = 'pending'
      AND created_at < ?
  `).all(cutoff).map(summarizeSessionApproval);

  if (expired.length === 0) return;

  const expire = db.transaction(() => {
    const now = nowIso();
    for (const approval of expired) {
      const response = buildApprovalResponse(approval.method, "timed_out");
      db.prepare(`
        UPDATE codex_session_approvals
        SET status = 'timed_out',
            response_json = @responseJson,
            decided_at = @now,
            decided_by = 'timeout',
            updated_at = @now
        WHERE id = @id
          AND status = 'pending'
      `).run({
        id: approval.id,
        responseJson: JSON.stringify(response),
        now
      });

      insertSessionEvent.run(
        normalizeSessionEvent(approval.sessionId, {
          type: "approval.timed_out",
          text: `${approval.method} approval timed out.`,
          raw: { approvalId: approval.id, response }
        }, now)
      );
    }
  });

  expire();
}

function expireOldInteractions() {
  const cutoff = new Date(Date.now() - config.codex.approvalTimeoutMs).toISOString();
  const expired = db.prepare(`
    SELECT ${summarizeSessionInteractionColumns}
    FROM codex_session_interactions
    WHERE status = 'pending'
      AND created_at < ?
  `).all(cutoff).map(summarizeSessionInteraction);

  if (expired.length === 0) return;

  const expire = db.transaction(() => {
    const now = nowIso();
    for (const interaction of expired) {
      const response = buildInteractionResponse(interaction, {}, "timed_out");
      db.prepare(`
        UPDATE codex_session_interactions
        SET status = 'timed_out',
            response_json = @responseJson,
            answered_at = @now,
            answered_by = 'timeout',
            updated_at = @now
        WHERE id = @id
          AND status = 'pending'
      `).run({
        id: interaction.id,
        responseJson: JSON.stringify(response),
        now
      });

      insertSessionEvent.run(
        normalizeSessionEvent(interaction.sessionId, {
          type: "interaction.timed_out",
          text: `${interaction.method || "Interaction"} timed out.`,
          raw: { interactionId: interaction.id, response: redactInteractionResponseForEvent(interaction, response) }
        }, now)
      );
    }
  });

  expire();
}

function normalizeApprovalStatus(value) {
  const decision = String(value || "").toLowerCase();
  if (["approve", "approved", "accept", "yes", "allow"].includes(decision)) return "approved";
  if (["timeout", "timed_out"].includes(decision)) return "timed_out";
  return "denied";
}

function buildApprovalResponse(method, status) {
  const approved = status === "approved";
  if (method === "item/commandExecution/requestApproval") return { decision: approved ? "accept" : status === "timed_out" ? "cancel" : "decline" };
  if (method === "item/fileChange/requestApproval") return { decision: approved ? "accept" : status === "timed_out" ? "cancel" : "decline" };
  if (method === "execCommandApproval") return { decision: approved ? "approved" : status === "timed_out" ? "timed_out" : "denied" };
  if (method === "applyPatchApproval") return { decision: approved ? "approved" : status === "timed_out" ? "timed_out" : "denied" };
  return { decision: approved ? "accept" : "decline" };
}

function normalizeInteractionKind(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "user_input" || normalized.includes("requestuserinput")) return "user_input";
  return "unknown";
}

function normalizeInteractionStatus(value) {
  const decision = String(value || "").trim().toLowerCase();
  if (["cancel", "cancelled", "canceled", "decline", "denied"].includes(decision)) return "cancelled";
  if (["timeout", "timed_out"].includes(decision)) return "timed_out";
  return "answered";
}

function buildInteractionResponse(interaction, input = {}, status = "answered") {
  if (interaction.kind !== "user_input") return input.response && typeof input.response === "object" ? input.response : {};
  if (status !== "answered") return emptyUserInputResponse();

  const directResponse = input.response && typeof input.response === "object" ? input.response : null;
  const sourceAnswers = input.answers || directResponse?.answers || {};
  return normalizeUserInputResponse(sourceAnswers, interaction.payload?.questions || []);
}

function normalizeUserInputResponse(sourceAnswers = {}, questions = []) {
  const answers = {};
  const source = sourceAnswers && typeof sourceAnswers === "object" ? sourceAnswers : {};
  const knownQuestions = Array.isArray(questions) ? questions : [];
  for (const question of knownQuestions) {
    const id = String(question?.id || "").trim();
    if (!id) continue;
    const values = normalizeUserInputAnswerValues(source[id]);
    if (values.length > 0) answers[id] = { answers: values };
  }

  for (const [id, value] of Object.entries(source)) {
    const normalizedId = String(id || "").trim();
    if (!normalizedId || answers[normalizedId]) continue;
    const values = normalizeUserInputAnswerValues(value);
    if (values.length > 0) answers[normalizedId] = { answers: values };
  }

  return { answers };
}

function normalizeUserInputAnswerValues(value) {
  const rawValues = Array.isArray(value?.answers) ? value.answers : Array.isArray(value) ? value : [value?.answer ?? value?.value ?? value];
  return rawValues
    .map((item) => String(item ?? "").slice(0, 4000))
    .filter((item) => item.length > 0)
    .slice(0, 10);
}

function emptyUserInputResponse() {
  return { answers: {} };
}

function redactInteractionResponseForEvent(interaction, response) {
  if (!interactionHasSecretQuestion(interaction)) return response;
  return { answers: "[redacted]" };
}

function interactionHasSecretQuestion(interaction = {}) {
  const questions = Array.isArray(interaction.payload?.questions) ? interaction.payload.questions : [];
  return questions.some((question) => Boolean(question?.isSecret || question?.is_secret));
}

function badRequest(message) {
  throwHttpError(400, message);
}

function notFound(message) {
  throwHttpError(404, message);
}

function conflict(message) {
  throwHttpError(409, message);
}

function throwHttpError(statusCode, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, details);
  throw error;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

function nowIso() {
  return new Date().toISOString();
}

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}
