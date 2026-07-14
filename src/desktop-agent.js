import crypto from "node:crypto";
import { watchFile } from "node:fs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { loadDesktopAgentId } from "./lib/agentIdentity.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./lib/codexFileBrowser.js";
import { publicWorkspaces } from "./lib/codexRunner.js";
import { summarizeOpenSpecWorkspace } from "./lib/openSpecSummary.js";
import {
  completeNonBlockingManualTasks,
  completedBaselineChangeIds,
  orchestrationItemFingerprint,
  readyIntegrationItems
} from "./lib/orchestrationBaseline.js";
import {
  applyCodexSessionWorktree,
  codexWorktreeCapability,
  discardCodexSessionWorktree,
  maintainCodexWarmWorktreePool,
  maybeCleanupCodexSessionWorktrees,
  prepareCodexSessionWorktree,
  publicCodexWorktreeExecution,
  resolveCodexSessionFileTarget
} from "./lib/codexWorktree.js";
import {
  applyOrchestrationIntegration,
  finalizeOrchestrationChangeWorktree,
  completeOrchestrationIntegrationRepair,
  integrateOrchestrationCommit,
  materializeOrchestrationChangeSnapshot,
  prepareOrchestrationChangeWorktree,
  prepareOrchestrationIntegrationWorktree,
  prepareOrchestrationWorktreeDependencies,
  readOrchestrationWorktree
} from "./lib/orchestrationWorktree.js";
import { workspaceConfigFilePath } from "./lib/codexWorkspaceConfig.js";
import {
  createManagedWorkspace,
  listWorkspaceImportDirectories,
  managedWorkspaceFilePath,
  registerManagedWorkspace,
  workspaceCreationRoot,
  workspaceImportRoots
} from "./lib/codexWorkspaceManager.js";
import {
  createDesktopBackends,
  createDesktopRuntimeMap,
  desktopRuntimeSnapshot,
  refreshDesktopBackendCapabilities
} from "./lib/desktopBackendRegistry.js";
import {
  agentSkillRegistry,
  agentSkillStatePath,
  importAgentSkill,
  syncAgentSkill,
  updateAgentSkillState
} from "./lib/agentSkills.js";
import { createAgentProfileSupervisor } from "./lib/agentProfileSupervisor.js";
import {
  desktopPluginRegistry,
  desktopPluginStatePath,
  isDesktopPluginEnabled,
  updateDesktopPluginState
} from "./lib/desktopPlugins.js";
import { describeHttpNetwork, formatFetchError, httpFetch, isLikelyNetworkError } from "./lib/http.js";
import { postDesktopSessionEvents } from "./lib/desktopSessionEvents.js";
import { applyMcpProfile } from "./lib/mcpConfig.js";

if (!config.relayUrl) {
  console.error("Missing ECHO_RELAY_URL. Example: ECHO_RELAY_URL=https://voice.example.com ECHO_AGENT_TOKEN=... pnpm run desktop");
  process.exit(1);
}

if (shouldRunAgentProfileSupervisor()) {
  await runAgentProfileSupervisor(config.agent.profiles);
}

if (!process.env.ECHO_AGENT_TOKEN && !process.env.ECHO_TOKEN) {
  console.error("Missing ECHO_AGENT_TOKEN. Use an agent token configured on the relay server.");
  process.exit(1);
}

const agentId = config.agent.id || (await loadDesktopAgentId());
const agentInstanceId = crypto.randomUUID();
const desktopAgentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRevision = await gitOutput(desktopAgentRoot, ["rev-parse", "HEAD"]).catch(() => "");
process.env.ECHO_AGENT_ID = agentId;
process.env.ECHO_AGENT_INSTANCE_ID = agentInstanceId;
process.env.ECHO_SOURCE_REVISION = sourceRevision;
process.env.ECHO_DESKTOP_RESTART_PROTOCOL_VERSION = "1";
const desktopBackends = createDesktopBackends({ agentId });
let codexRuntimeRefreshPromise = null;
let codexRuntimeRefreshTimer = null;
let activeCodexCommandCount = 0;
let activeOrchestrationAttemptCount = 0;
const activeSessionCommands = new Map();
const runningSessionHeartbeats = new Map();
const runningSessionStates = new Map();
const pendingSessionEventRetries = new Map();
const sessionEventRetryOutboxPath = path.join(config.dataDir, "desktop-session-event-outbox.json");
let sessionEventRetryTimer = null;
let sessionEventOutboxSaveTimer = null;
let agentSnapshotPostPromise = null;
let agentSnapshotPostAgain = false;
let lastPostedAgentSnapshotSignature = "";
let lastAgentSnapshotError = "";
let desktopAgentRestartTimer = null;
let desktopAgentRestartArmPromise = null;
let pendingDesktopAgentRestart = null;

function shouldRunAgentProfileSupervisor() {
  return process.env.ECHO_AGENT_PROFILE_WORKER !== "1" && config.agent.profiles.length > 0;
}

async function runAgentProfileSupervisor(profiles = []) {
  console.log("Echo desktop agent supervisor is running.");
  console.log(`Relay: ${config.relayUrl}`);
  console.log(`Network: ${formatNetworkStatus(describeHttpNetwork(config.relayUrl))}`);
  console.log(`Agent profiles: ${profiles.length}`);
  for (const profile of profiles) {
    console.log(`  ${profile.agentId}: ${profile.username}; ${profile.workspaces.length} workspace${profile.workspaces.length === 1 ? "" : "s"}`);
  }
  console.log("");

  const supervisor = createAgentProfileSupervisor({
    profiles,
    spawnWorker: (profile) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: process.cwd(),
        env: agentProfileWorkerEnv(profile),
        stdio: ["ignore", "pipe", "pipe"]
      });
      pipeProfileWorkerOutput(child.stdout, profile, "log");
      pipeProfileWorkerOutput(child.stderr, profile, "error");
      return child;
    },
    onWorkerError: ({ profile, error }) => {
      console.error(`[${profile.agentId}] worker failed to start: ${error.message}`);
    },
    onWorkerExit: ({ profile, code, signal, delayMs, gracefulRestart }) => {
      const exitLabel = signal ? `signal=${signal}` : `code=${code ?? "unknown"}`;
      const message = `[${profile.agentId}] worker exited (${exitLabel}); restarting in ${delayMs}ms`;
      if (gracefulRestart) console.log(`${message} after checkpoint`);
      else console.error(message);
    }
  });

  process.on("SIGINT", () => {
    supervisor.stop("SIGINT");
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    supervisor.stop("SIGTERM");
    process.exit(143);
  });

  supervisor.start();
  await new Promise(() => {});
}

function agentProfileWorkerEnv(profile) {
  return {
    ...process.env,
    ...(profile.env || {}),
    ECHO_AGENT_PROFILE_WORKER: "1",
    ECHO_AGENT_PROFILES_JSON: "",
    ECHO_AGENT_TOKEN: profile.token,
    ECHO_AGENT_TOKEN_SHA256: "",
    ECHO_AGENT_ID: profile.agentId,
    ECHO_AGENT_DISPLAY_NAME: profile.displayName || profile.agentId,
    ECHO_AGENT_OWNER_USERNAME: profile.username,
    ECHO_CODEX_MANAGED_WORKSPACES_FILE:
      profile.env?.ECHO_CODEX_MANAGED_WORKSPACES_FILE || profileManagedWorkspaceFile(profile),
    ECHO_CODEX_WORKSPACES: profile.workspacesText
  };
}

function profileManagedWorkspaceFile(profile) {
  const safeAgentId = String(profile.agentId || "agent")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agent";
  return path.join(config.dataDir, `codex-workspaces-${safeAgentId}.json`);
}

function pipeProfileWorkerOutput(stream, profile, method) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) continue;
      console[method](`[${profile.agentId}] ${line}`);
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    if (line) console[method](`[${profile.agentId}] ${line}`);
  });
}

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
  const codexSessionRuntimes = createDesktopRuntimeMap(desktopBackends, {
    onEvents: postCodexSessionEvents,
    requestApproval: requestCodexApproval,
    requestInteraction: requestCodexInteraction
  });
  startAgentSnapshotSync();
  startWarmWorktreePoolMaintenance();
  setInterval(() => {
    scheduleCodexRuntimeRefresh();
  }, 10 * 60 * 1000).unref?.();
  scheduleCodexRuntimeRefresh({ delayMs: 30000 });
  runCodexWorkspaceLoop();
  runCodexFileLoop();
  runCodexSessionLoops(codexSessionRuntimes);
  runCodexSessionInterruptLoop(codexSessionRuntimes);
  runOrchestrationLoops();
}

function runOrchestrationLoops() {
  const concurrency = Math.max(1, Number(config.codex.sessionConcurrency || 1));
  for (let workerId = 1; workerId <= concurrency; workerId += 1) {
    runOrchestrationLoop(workerId).catch((error) => console.error(`[orchestration worker ${workerId}] stopped: ${error.message}`));
  }
}

async function runOrchestrationLoop(workerId) {
  const retryBackoff = createRetryBackoff({ baseMs: 3000, maxMs: 30000 });
  while (true) {
    let work = null;
    let leaseOwner = "";
    try {
      const response = await postJson("/api/agent/codex/orchestrations/next", {
        agentId,
        agentInstanceId,
        workerId: `${agentInstanceId}:${workerId}`,
        workspaces: publicWorkspaces(),
        runtime: currentCodexRuntime()
      });
      retryBackoff.reset();
      if (!response.work) {
        await sleep(3000);
        continue;
      }
      work = response.work;
      leaseOwner = work.attempt?.leaseOwner || response.leaseOwner;
      const heartbeat = startOrchestrationHeartbeat(work.attempt.id, leaseOwner);
      activeOrchestrationAttemptCount += 1;
      try {
        if (work.attempt.kind === "integrate") await executeOrchestrationIntegration(work, leaseOwner);
        else await executeOrchestrationItem(work, leaseOwner);
      } finally {
        clearInterval(heartbeat);
        activeOrchestrationAttemptCount = Math.max(0, activeOrchestrationAttemptCount - 1);
        maybeExitForDesktopAgentRestart();
      }
    } catch (error) {
      if (work?.attempt?.id && leaseOwner) {
        const failure = orchestrationDesktopFailure(error);
        await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(work.attempt.id)}/complete`, work.attempt.kind === "integrate"
          ? { integration: true, leaseOwner, ok: false, failureClass: "desktop-error", errorSummary: String(error.message || error).slice(0, 1200) }
          : { leaseOwner, status: "failed", ...failure }
        ).catch(() => {});
      }
      const delayMs = retryBackoff.nextDelay(error);
      console.error(`[orchestration ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, delayMs)}`);
      await sleep(delayMs);
    }
  }
}

function startOrchestrationHeartbeat(attemptId, leaseOwner) {
  const heartbeat = setInterval(() => {
    postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attemptId)}/heartbeat`, { leaseOwner }).catch(() => {});
  }, 30000);
  heartbeat.unref?.();
  return heartbeat;
}

async function executeOrchestrationItem(work, leaseOwner) {
  const { run, item, attempt } = work;
  const workspace = publicWorkspaces().find((candidate) => candidate.id === run.projectId);
  if (!workspace) throw new Error("Orchestration Workspace is not advertised by this Desktop agent.");
  if (await reconcileOrchestrationBaseline(work, leaseOwner, workspace)) return;
  const execution = await prepareOrchestrationChangeWorktree({
    desktopAgentId: agentId,
    projectId: run.projectId,
    runId: run.id,
    itemId: item.id,
    workspacePath: workspace.path,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit
  });
  if (!execution.changeSnapshot) {
    const currentSummary = await summarizeOpenSpecWorkspace({ projectId: run.projectId, workspaces: publicWorkspaces() });
    const currentChange = currentSummary.openSpec?.changes?.find((change) => change.id === item.changeId && !change.archived);
    if (!currentChange || orchestrationChangeFingerprint(currentChange) !== orchestrationItemFingerprint(item)) {
      const error = new Error(`OpenSpec change changed after this Run was planned: ${item.changeId}.`);
      error.code = "CHANGE_SNAPSHOT_CHANGED";
      throw error;
    }
  }
  const snapshottedExecution = await materializeOrchestrationChangeSnapshot({
    desktopAgentId: agentId,
    projectId: run.projectId,
    runId: run.id,
    itemId: item.id,
    workspacePath: workspace.path,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit,
    changeId: item.changeId,
    fingerprint: orchestrationItemFingerprint(item)
  });
  const setup = await prepareOrchestrationWorktreeDependencies({
    kind: "change",
    desktopAgentId: agentId,
    projectId: run.projectId,
    runId: run.id,
    itemId: item.id,
    workspacePath: workspace.path,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit
  });
  if (!setup.ok) throw new Error(`Worktree dependency setup failed: ${setup.setupSummary}`);
  let session = attempt.sessionId ? (await getOrchestrationAttemptSession(attempt.id, leaseOwner)) : null;
  if (!session) {
    const created = await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/session`, {
      agentId,
      agentInstanceId,
      leaseOwner,
      execution: {
        path: snapshottedExecution.path,
        basePath: workspace.path,
        branchName: snapshottedExecution.branchName,
        createdAt: snapshottedExecution.createdAt
      }
    });
    session = created.session;
  }
  session = await waitForOrchestrationSession(session.id, attempt.id, leaseOwner);
  if (!session || session.status === "failed" || session.status === "cancelled" || session.status === "stale") {
    await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/complete`, {
      leaseOwner,
      status: "failed",
      failureClass: "agent-failed",
      errorSummary: session?.lastError || "Agent Session failed.",
      retryable: item.retryCount < 2,
      retryCount: item.retryCount
    });
    return;
  }
  const manualTasks = await completeOrchestrationManualTasks(snapshottedExecution.path, run.projectId, item.changeId);
  const validations = await validateOrchestrationWorktree(snapshottedExecution.path, item.changeId);
  if (!validations.ok) {
    await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/complete`, {
      leaseOwner,
      status: "failed",
      failureClass: "validation-failed",
      errorSummary: validations.summary,
      retryable: item.retryCount < 2,
      retryCount: item.retryCount,
      artifacts: validations.artifacts.map((artifact) => ({ ...artifact, runId: run.id, itemId: item.id }))
    });
    return;
  }
  const finalized = await finalizeOrchestrationChangeWorktree({
    desktopAgentId: agentId,
    projectId: run.projectId,
    runId: run.id,
    itemId: item.id,
    workspacePath: workspace.path,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit,
    message: `Apply OpenSpec change ${item.changeId}`
  });
  await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/complete`, {
    leaseOwner,
    status: "succeeded",
    sessionId: session.id,
    commit: finalized.commit,
    verifierConclusion: "Desktop validation passed.",
    artifacts: [
      { runId: run.id, itemId: item.id, kind: "git-summary", status: "info", summary: finalized.stat, data: { changedFiles: finalized.changedFiles, commit: finalized.commit } },
      ...(manualTasks.completedCount ? [{ runId: run.id, itemId: item.id, kind: "validation", status: "passed", summary: `${manualTasks.completedCount} 项提交后人工验收已按非阻塞策略完成。` }] : []),
      ...validations.artifacts.map((artifact) => ({ ...artifact, runId: run.id, itemId: item.id })),
      { runId: run.id, itemId: item.id, kind: "verifier", status: "passed", summary: "Desktop validation passed." }
    ]
  });
}

async function executeOrchestrationIntegration(work, leaseOwner) {
  const { run, attempt } = work;
  const workspace = publicWorkspaces().find((candidate) => candidate.id === run.projectId);
  if (!workspace) throw new Error("Orchestration Workspace is not advertised by this Desktop agent.");
  if (await reconcileOrchestrationBaseline(work, leaseOwner, workspace)) return;
  const integration = await prepareOrchestrationIntegrationWorktree({
    desktopAgentId: agentId,
    projectId: run.projectId,
    runId: run.id,
    workspacePath: workspace.path,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit
  });
  if (integration.lifecycleState === "conflict") {
    let session = attempt.sessionId ? await getOrchestrationAttemptSession(attempt.id, leaseOwner) : null;
    if (!session) {
      const created = await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/session`, {
        agentId,
        agentInstanceId,
        leaseOwner,
        execution: {
          path: integration.path,
          basePath: workspace.path,
          branchName: integration.branchName,
          createdAt: integration.createdAt
        }
      });
      session = created.session;
    }
    session = await waitForOrchestrationSession(session.id, attempt.id, leaseOwner);
    if (!session || ["failed", "cancelled", "stale"].includes(session.status)) {
      throw new Error(session?.lastError || "Integration repair Session failed.");
    }
    const repaired = await completeOrchestrationIntegrationRepair({
      desktopAgentId: agentId,
      projectId: run.projectId,
      runId: run.id,
      workspacePath: workspace.path,
      baseBranch: run.baseBranch,
      baseCommit: run.baseCommit
    });
    if (!repaired.ok) throw new Error(repaired.error || `Unresolved conflicts: ${(repaired.conflictFiles || []).join(", ")}`);
  }
  const setup = await prepareOrchestrationWorktreeDependencies({
    kind: "integration",
    desktopAgentId: agentId,
    projectId: run.projectId,
    runId: run.id,
    workspacePath: workspace.path,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit
  });
  if (!setup.ok) throw new Error(`Integration dependency setup failed: ${setup.setupSummary}`);
  for (const item of readyIntegrationItems(run.items)) {
    await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/heartbeat`, { leaseOwner });
    const result = await integrateOrchestrationCommit({
      desktopAgentId: agentId,
      projectId: run.projectId,
      runId: run.id,
      workspacePath: workspace.path,
      baseBranch: run.baseBranch,
      baseCommit: run.baseCommit,
      sourceItemId: item.id,
      commit: item.finalCommit
    });
    if (!result.ok) {
      await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/complete`, {
        integration: true,
        leaseOwner,
        ok: false,
        failureClass: "integration-conflict",
        errorSummary: result.conflictFiles?.length ? `冲突文件：${result.conflictFiles.join(", ")}` : result.error
      });
      return;
    }
  }
  await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/heartbeat`, { leaseOwner });
  const validations = await validateOrchestrationWorktree(integration.path, "");
  if (!validations.ok) {
    await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/complete`, {
      integration: true,
      leaseOwner,
      ok: false,
      failureClass: "aggregate-validation-failed",
      errorSummary: validations.summary
    });
    return;
  }
  const commit = await gitText(integration.path, ["rev-parse", "HEAD"]);
  const applied = await applyOrchestrationIntegration({
    desktopAgentId: agentId,
    projectId: run.projectId,
    runId: run.id,
    workspacePath: workspace.path,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit
  });
  await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/complete`, {
    integration: true,
    leaseOwner,
    ok: true,
    branch: integration.branchName,
    commit: applied.commit || commit,
    validationSummary: validations.summary
  });
}

async function reconcileOrchestrationBaseline(work, leaseOwner, workspace) {
  const { run, item, attempt } = work;
  const [branch, commit, status, summary] = await Promise.all([
    gitText(workspace.path, ["branch", "--show-current"]),
    gitText(workspace.path, ["rev-parse", "HEAD"]),
    gitText(workspace.path, ["status", "--porcelain"]),
    summarizeOpenSpecWorkspace({ projectId: run.projectId, workspaces: publicWorkspaces() })
  ]);
  const completedChangeIds = branch === run.baseBranch
    ? completedBaselineChangeIds({ changes: summary.openSpec?.changes, runItems: run.items, porcelain: status })
    : [];

  if (completedChangeIds.length) {
    const response = await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/reconcile`, {
      leaseOwner,
      completedChangeIds,
      branch,
      commit
    });
    const reconciledItem = item ? response.run?.items?.find((candidate) => candidate.id === item.id) : null;
    if (response.run?.status === "completed" || reconciledItem?.status === "completed") return true;
  }

  const worktree = await readOrchestrationWorktree({
    kind: item ? "change" : "integration",
    desktopAgentId: agentId,
    projectId: run.projectId,
    runId: run.id,
    itemId: item?.id || "integration",
    workspacePath: workspace.path,
    baseBranch: run.baseBranch,
    baseCommit: run.baseCommit
  });
  if (worktree?.lifecycleState !== "cleaned") return false;

  await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attempt.id)}/reconcile`, {
    leaseOwner,
    unavailable: true,
    errorSummary: "The managed Worktree was cleaned before the Run reached a persisted terminal state."
  });
  return true;
}

async function getOrchestrationAttemptSession(attemptId, leaseOwner) {
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/orchestrations/${encodeURIComponent(attemptId)}/session?leaseOwner=${encodeURIComponent(leaseOwner)}`, {
    headers: authHeaders(), timeoutMs: 30000
  });
  if (response.status === 404) return null;
  return (await parseApiResponse(response)).session || null;
}

async function waitForOrchestrationSession(sessionId, attemptId, leaseOwner) {
  for (;;) {
    await postJson(`/api/agent/codex/orchestrations/${encodeURIComponent(attemptId)}/heartbeat`, { leaseOwner });
    const session = await getOrchestrationAttemptSession(attemptId, leaseOwner);
    if (!session) throw new Error(`Orchestration Session disappeared: ${sessionId}`);
    if (!["queued", "starting", "running"].includes(session.status) && session.pendingCommandCount === 0) return session;
    await sleep(3000);
  }
}

async function validateOrchestrationWorktree(worktreePath, changeId) {
  const commands = [];
  if (changeId) commands.push(["pnpm", ["exec", "openspec", "validate", changeId, "--strict"], "OpenSpec strict validation"]);
  else commands.push(["pnpm", ["exec", "openspec", "validate", "--all", "--strict"], "OpenSpec aggregate validation"]);
  const packageJson = await fs.readFile(path.join(worktreePath, "package.json"), "utf8").then(JSON.parse).catch(() => null);
  if (packageJson?.scripts?.test) commands.push(["pnpm", ["test"], "Project tests"]);
  const artifacts = [];
  for (const [command, args, label] of commands) {
    const result = await processResult(command, args, worktreePath);
    artifacts.push({ kind: changeId ? (label.startsWith("OpenSpec") ? "open-spec-validation" : "validation") : "validation", status: result.ok ? "passed" : "failed", summary: `${label}: ${result.ok ? "passed" : "failed"}\n${result.output}`.slice(0, 8000) });
    if (!result.ok) return { ok: false, summary: `${label} failed: ${result.output}`.slice(0, 1200), artifacts };
  }
  const summary = artifacts.map((artifact) => artifact.summary.split("\n")[0]).join("; ");
  if (changeId) artifacts.push({ kind: "validation", status: "passed", summary: summary || "Desktop validation passed." });
  return { ok: true, summary, artifacts };
}

async function completeOrchestrationManualTasks(worktreePath, projectId, changeId) {
  const summary = await summarizeOpenSpecWorkspace({
    projectId,
    workspaces: [{ id: projectId, path: worktreePath }],
    limits: { maxChanges: 200, maxSpecs: 240 }
  });
  const change = summary.openSpec?.changes?.find((candidate) => candidate.id === changeId && !candidate.archived);
  if (!change?.hasTasks || !change.path) return { completedCount: 0 };
  const tasksPath = path.resolve(worktreePath, change.path, "tasks.md");
  if (!tasksPath.startsWith(`${path.resolve(worktreePath)}${path.sep}`)) throw new Error("OpenSpec tasks path escapes its Worktree.");
  const markdown = await fs.readFile(tasksPath, "utf8");
  const result = completeNonBlockingManualTasks(markdown);
  if (result.completedCount) await fs.writeFile(tasksPath, result.markdown, "utf8");
  return { completedCount: result.completedCount };
}

function processResult(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.slice(-8000).trim() }));
  });
}

async function gitText(cwd, args) {
  const result = await processResult("git", args, cwd);
  if (!result.ok) throw new Error(result.output || `git ${args[0]} failed`);
  return result.output.trim();
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
        agentInstanceId,
        result,
        workspaces: publicWorkspaces(),
        runtime: currentCodexRuntime()
      });
      console.log(`  workspace ${command.type} ${result.ok ? "completed" : "failed"}`);
      if (result.restartDesktopAgent) scheduleDesktopAgentRestart(result.restartReason || command.type);
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[workspace ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (command?.id && !handledLocally) {
        await postJson("/api/agent/codex/workspaces/commands/complete", {
          id: command.id,
          agentId,
          agentInstanceId,
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
        agentInstanceId,
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
          agentInstanceId,
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

function runCodexSessionLoops(runtimes) {
  const concurrency = Math.max(1, Number(config.codex.sessionConcurrency || 1));
  for (let index = 0; index < concurrency; index += 1) {
    runCodexSessionWorker(runtimes, index + 1).catch((error) => {
      console.error(`[session worker ${index + 1}] stopped unexpectedly: ${error.message}`);
    });
  }
}

function runCodexSessionInterruptLoop(runtimes) {
  runCodexSessionInterruptWorker(runtimes).catch((error) => {
    console.error(`[session interrupt worker] stopped unexpectedly: ${error.message}`);
  });
}

async function runCodexSessionWorker(runtimes, workerId) {
  const retryBackoff = createRetryBackoff();

  while (true) {
    let command = null;
    let handledLocally = false;
    try {
      if (pendingDesktopAgentRestart) {
        await sleep(250);
        maybeExitForDesktopAgentRestart();
        continue;
      }
      await maybeCleanupWorktrees();
      command = await pollNextCodexSessionCommand();
      retryBackoff.reset();
      if (!command) continue;

      console.log(`[${new Date().toLocaleTimeString()}] session ${command.sessionId} ${command.type} worker=${workerId}`);
      activeCodexCommandCount += 1;
      rememberActiveSessionCommand(command);
      const heartbeat = startCodexSessionHeartbeat(command);
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
        if (completed?.restart?.shouldExit) scheduleDesktopAgentRestart(`session ${command.sessionId}`, completed.restart);
        console.log(`  session ${command.type} ${result.ok ? "accepted" : "failed"}`);
      } finally {
        clearInterval(heartbeat);
        forgetActiveSessionCommand(command.id);
        activeCodexCommandCount = Math.max(0, activeCodexCommandCount - 1);
        maybeExitForDesktopAgentRestart();
      }
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[session ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (command?.sessionId) stopRunningSessionHeartbeat(command.sessionId);
      if (command?.id && !handledLocally) {
        await postJson("/api/agent/codex/sessions/commands/complete", {
          id: command.id,
          attempt: command.attempt,
          agentId,
          agentInstanceId,
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

async function runCodexSessionInterruptWorker(runtimes) {
  const retryBackoff = createRetryBackoff();

  while (true) {
    let command = null;
    let handledLocally = false;
    try {
      command = await pollNextCodexSessionInterruptCommand();
      retryBackoff.reset();
      if (!command) continue;

      if (command.type !== "stop") {
        await postJson("/api/agent/codex/sessions/commands/complete", {
          id: command.id,
          attempt: command.attempt,
          agentId,
          agentInstanceId,
          result: {
            ok: false,
            sessionId: command.sessionId,
            error: `Interrupt worker cannot handle ${command.type}.`
          }
        }).catch(() => {});
        continue;
      }

      console.log(`[${new Date().toLocaleTimeString()}] session ${command.sessionId} stop interrupt`);
      rememberActiveSessionCommand(command);
      const heartbeat = startCodexSessionHeartbeat(command);
      try {
        const result = await runCodexSessionCommand(runtimes, command);
        handledLocally = true;
        if (!result.projectId) result.projectId = command.projectId;
        const completed = await postSessionCommandCompletion(command, result);
        if (completed?.ok === false) {
          console.warn("  session stop completion was no longer accepted by relay.");
          continue;
        }
        updateRunningSessionHeartbeatFromResult(result.sessionId, result, command);
        console.log(`  session stop ${result.ok ? "accepted" : "failed"}`);
      } finally {
        clearInterval(heartbeat);
        forgetActiveSessionCommand(command.id);
      }
    } catch (error) {
      const retryDelayMs = retryBackoff.nextDelay(error);
      console.error(`[session interrupt ${new Date().toLocaleTimeString()}] ${formatFetchError(error)}${retryNote(error, retryDelayMs)}`);
      if (command?.id && !handledLocally) {
        await postJson("/api/agent/codex/sessions/commands/complete", {
          id: command.id,
          attempt: command.attempt,
          agentId,
          agentInstanceId,
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
        attempt: command.attempt,
        agentId,
        agentInstanceId,
        restartArmMode: "desktop-exit",
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
  let preparedCommand = await prepareCodexSessionWorktree(
    { ...command, desktopAgentId: agentId },
    { onEvent: (event) => postCodexSessionEvents(command.sessionId, [event], command) }
  );
  preparedCommand = withDesktopRestartProtocol(preparedCommand);
  const commandId = String(preparedCommand.id || "").trim();
  if (commandId && activeSessionCommands.has(commandId)) rememberActiveSessionCommand(preparedCommand);
  if (preparedCommand.worktreeUnavailableResult) {
    const result = preparedCommand.worktreeUnavailableResult;
    if (result.events?.length) await postCodexSessionEvents(command.sessionId, result.events, command);
    return { ...result, execution: publicCodexWorktreeExecution(result.execution) };
  }
  if (preparedCommand.type === "worktree" && preparedCommand.payload?.action === "setup") {
    return {
      ok: true,
      sessionStatus: "active",
      execution: withCompletedSetupState(preparedCommand.execution)
    };
  }
  if (preparedCommand.type === "worktree") return handleCodexWorktreeCommand(preparedCommand);
  const backendId = String(preparedCommand.runtime?.backendId || "codex").trim() || "codex";
  const runtime = runtimes.get(backendId) || runtimes.get("codex") || runtimes.values().next().value;
  if (!runtime) throw new Error(`No desktop runtime is available for backend ${backendId}.`);
  const result = await runtime.handleCommand(preparedCommand);
  result.execution = worktreeExecutionForResult(preparedCommand, result);
  result.sessionId = preparedCommand.sessionId || command.sessionId;
  result.projectId = preparedCommand.projectId || command.projectId;
  return result;
}

function withCompletedSetupState(execution = {}) {
  return publicCodexWorktreeExecution({ ...execution, lifecycleState: "ready", errorCode: "", errorSummary: "" });
}

async function handleCodexWorktreeCommand(command) {
  const action = String(command.payload?.action || "").trim().toLowerCase();
  const result = action === "discard" ? await discardCodexSessionWorktree(command) : await applyCodexSessionWorktree(command);
  if (result.events?.length) await postCodexSessionEvents(command.sessionId, result.events, command);
  return { ...result, execution: publicCodexWorktreeExecution(result.execution) };
}

function worktreeExecutionForResult(command = {}, result = {}) {
  const execution = result.execution || command.execution;
  if (!execution || typeof execution !== "object" || execution.mode !== "worktree") return result.execution;
  const lifecycleState = worktreeLifecycleStateForResult(result, execution.lifecycleState);
  return publicCodexWorktreeExecution({
    ...execution,
    lifecycleState
  });
}

function worktreeLifecycleStateForResult(result = {}, fallback = "") {
  const cleanupState = String(result.execution?.cleanupState || "").trim().toLowerCase();
  if (cleanupState === "applied" || cleanupState === "discarded") return cleanupState;
  const existing = String(result.execution?.lifecycleState || fallback || "").trim().toLowerCase();
  if (["applied", "discarded", "unavailable", "apply-blocked", "cleanup-failed", "cleanup-pending"].includes(existing)) return existing;
  if (result.ok === false || result.error) return "failed";
  if (result.sessionStatus === "running" || result.activeTurnId) return "running";
  return "completed";
}

async function postCodexSessionEvents(sessionId, events = [], command = {}) {
  const protocolEvents = (events || []).map((event) => ({
    ...event,
    eventId: String(event?.eventId || crypto.randomUUID()),
    commandId: String(event?.commandId || command.id || ""),
    attempt: Number(event?.attempt || command.attempt || 0) || 0
  }));
  return postDesktopSessionEvents({
    sessionId,
    events: protocolEvents,
    postEvents: (id, nextEvents) => postJson("/api/agent/codex/sessions/events", { id, agentId, agentInstanceId, events: nextEvents }),
    updateLocalState: updateRunningSessionHeartbeatFromEvents,
    queueRetry: queueSessionEventRetry
  });
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
      const posted = await postJson("/api/agent/codex/sessions/events", { id: sessionId, agentId, agentInstanceId, events });
      if (posted?.ok === false) {
        console.error("[session events retry] Relay rejected stale Codex session events; dropping them.");
        if (pending.events.length === 0) pendingSessionEventRetries.delete(sessionId);
        else pendingSessionEventRetries.set(sessionId, { ...pending, attempts: 0 });
        scheduleSessionEventOutboxSave();
        continue;
      }
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
  if (command.type === "create") {
    const workspace = createManagedWorkspace(command.payload || {});
    return { ok: true, workspace };
  }
  if (command.type === "import.list") {
    const tree = listWorkspaceImportDirectories(command.payload || {});
    return { ok: true, tree };
  }
  if (command.type === "register") {
    const workspace = registerManagedWorkspace(command.payload || {});
    return { ok: true, workspace };
  }
  if (command.type === "mcp.apply") {
    const payload = command.payload || {};
    const result = await applyMcpProfile(payload);
    const restartDesktopAgent = result.ok === true && payload.restartDesktopAgent === true;
    await postAgentSnapshot("mcp config changed", { force: true }).catch(() => {});
    return {
      ...result,
      restartRequired: result.ok === true,
      restartDesktopAgent,
      restartReason: restartDesktopAgent ? "MCP config changed" : ""
    };
  }
  if (command.type === "agent-skill.list") {
    const registry = agentSkillRegistry({ agentId, dataDir: config.dataDir });
    await postAgentSnapshot("agent skills refreshed", { force: true }).catch(() => {});
    return { ok: true, agentSkills: registry };
  }
  if (command.type === "agent-skill.update") {
    const payload = command.payload || {};
    const result = updateAgentSkillState(payload, { agentId, dataDir: config.dataDir });
    await postAgentSnapshot("agent skills updated", { force: true }).catch(() => {});
    return result;
  }
  if (command.type === "agent-skill.sync") {
    const payload = command.payload || {};
    const result = syncAgentSkill(payload.skillId, { agentId, dataDir: config.dataDir });
    const registry = agentSkillRegistry({ agentId, dataDir: config.dataDir });
    await postAgentSnapshot("agent skills synced", { force: true }).catch(() => {});
    return { ...result, agentSkills: registry };
  }
  if (command.type === "agent-skill.import") {
    const payload = command.payload || {};
    const result = await importAgentSkill(payload, { agentId, dataDir: config.dataDir });
    const registry = agentSkillRegistry({ agentId, dataDir: config.dataDir });
    await postAgentSnapshot("agent skill imported", { force: true }).catch(() => {});
    return { ...result, agentSkills: registry };
  }
  if (command.type === "plugin.list") {
    const plugins = desktopPluginRegistry(desktopPluginOptions());
    await postAgentSnapshot("desktop plugins refreshed", { force: true }).catch(() => {});
    return { ok: true, plugins };
  }
  if (command.type === "plugin.update") {
    const result = updateDesktopPluginState(command.payload || {}, desktopPluginOptions());
    await postAgentSnapshot("desktop plugin updated", { force: true }).catch(() => {});
    return result;
  }
  return { ok: false, error: `Unsupported workspace command: ${command.type}` };
}

function desktopPluginOptions() {
  return {
    agentId,
    dataDir: config.dataDir,
    managedWorktreeAvailable: publicWorkspaces().some(
      (workspace) => codexWorktreeCapability(workspace).availability === "optional"
    )
  };
}

function scheduleDesktopAgentRestart(reason, restart = {}) {
  if (!pendingDesktopAgentRestart) {
    pendingDesktopAgentRestart = { reason, restart, requestedAt: new Date().toISOString() };
  }
  maybeExitForDesktopAgentRestart();
}

function maybeExitForDesktopAgentRestart() {
  if (
    !pendingDesktopAgentRestart ||
    desktopAgentRestartTimer ||
    desktopAgentRestartArmPromise ||
    activeCodexCommandCount > 0 ||
    activeSessionCommands.size > 0 ||
    runningSessionHeartbeats.size > 0 ||
    activeOrchestrationAttemptCount > 0
  ) return;
  const restartId = String(pendingDesktopAgentRestart.restart?.id || "").trim();
  const sessionId = String(pendingDesktopAgentRestart.restart?.sessionId || "").trim();
  if (!restartId || !sessionId) {
    scheduleDesktopAgentExit(pendingDesktopAgentRestart.reason);
    return;
  }
  desktopAgentRestartArmPromise = armPendingDesktopAgentRestart();
}

async function armPendingDesktopAgentRestart() {
  const pending = pendingDesktopAgentRestart;
  const restartId = String(pending?.restart?.id || "").trim();
  const sessionId = String(pending?.restart?.sessionId || "").trim();
  try {
    if (!restartId || !sessionId) throw new Error("Desktop restart checkpoint identity is missing.");
    const armed = await postJson(`/api/agent/codex/restarts/${encodeURIComponent(restartId)}/arm`, {
      agentId,
      agentInstanceId,
      sessionId
    });
    if (!armed?.restart?.shouldExit) throw new Error("Relay did not arm the desktop restart checkpoint.");
    scheduleDesktopAgentExit(pending.reason, { checkpointed: true });
  } catch (error) {
    console.error(`[desktop restart] ${formatFetchError(error)}; retrying in 3s`);
    desktopAgentRestartArmPromise = null;
    const retry = setTimeout(maybeExitForDesktopAgentRestart, 3000);
    retry.unref?.();
  }
}

function scheduleDesktopAgentExit(reason, options = {}) {
  const suffix = options.checkpointed ? " after persisted checkpoint" : " after local drain";
  console.log(`  restarting desktop agent${suffix}: ${reason}`);
  desktopAgentRestartTimer = setTimeout(() => process.exit(75), 250);
  desktopAgentRestartTimer.unref?.();
}

function withDesktopRestartProtocol(command = {}) {
  if (!["start", "message"].includes(command.type) || command.payload?.restartOperationId) return command;
  const scriptPath = path.join(desktopAgentRoot, "scripts", "request-desktop-agent-restart.js");
  const instruction = [
    "<echo_desktop_restart_protocol>",
    "When this task requires restarting Echo's desktop agent, never kill the agent process and never call the desktop settings restart endpoint.",
    "Finish every other local action first. As the final tool action, request a checkpointed restart with:",
    `node ${JSON.stringify(scriptPath)} --session ${JSON.stringify(command.sessionId)} --summary ${JSON.stringify("Briefly describe completed work and what must continue after restart.")}`,
    "After that command succeeds, reply briefly that the checkpoint is saved and restart is beginning. Relay will persist that reply before the process exits, verify the new agent instance, and keep this Conversation available to continue.",
    "</echo_desktop_restart_protocol>"
  ].join("\n");
  const payload = { ...(command.payload || {}) };
  if (command.type === "start") payload.prompt = [payload.prompt || "", instruction].filter(Boolean).join("\n\n");
  else payload.text = [payload.text || payload.contextPrompt || "", instruction].filter(Boolean).join("\n\n");
  return { ...command, payload };
}

async function handleCodexFileRequest(request) {
  const payload = request.payload || {};
  try {
    const workspaces = await fileRequestWorkspaces(request, payload);
    if (request.type === "list") {
      return await listWorkspaceFiles({
        projectId: request.projectId,
        relativePath: payload.path ?? request.path,
        maxEntries: payload.maxEntries,
        workspaces
      });
    }
    if (request.type === "read") {
      return await readWorkspaceFile({
        projectId: request.projectId,
        relativePath: payload.path ?? request.path,
        maxBytes: payload.maxBytes,
        workspaces
      });
    }
    if (request.type === "open-spec-summary") {
      if (!isDesktopPluginEnabled("open-spec", { agentId, dataDir: config.dataDir })) {
        return { ok: false, error: "OpenSpec plugin is disabled on the desktop agent.", code: "PLUGIN_DISABLED" };
      }
      return await summarizeOpenSpecWorkspace({
        projectId: request.projectId,
        workspaces: publicWorkspaces(),
        limits: {
          maxChanges: payload.maxChanges,
          maxSpecs: payload.maxSpecs
        }
      });
    }
    if (request.type === "orchestration-plan") {
      const pluginOptions = desktopPluginOptions();
      if (!isDesktopPluginEnabled("open-spec", pluginOptions) || !isDesktopPluginEnabled("orchestration", pluginOptions)) {
        return { ok: false, error: "Orchestration plugin or dependency is disabled.", code: "PLUGIN_DISABLED" };
      }
      return await buildOrchestrationPlan({
        projectId: request.projectId,
        items: payload.items,
        workspaces: publicWorkspaces()
      });
    }
    return { ok: false, error: `Unsupported file browser request: ${request.type}` };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code || "" };
  }
}

async function buildOrchestrationPlan({ projectId, items = [], workspaces = [] } = {}) {
  const workspace = workspaces.find((item) => item.id === projectId);
  if (!workspace) return { ok: false, error: "Workspace is not advertised by this desktop agent.", code: "WORKSPACE_NOT_FOUND" };
  const summaryResult = await summarizeOpenSpecWorkspace({ projectId, workspaces, limits: { maxChanges: 200, maxSpecs: 240 } });
  if (!summaryResult.ok || !summaryResult.openSpec?.available) {
    return { ok: false, error: "OpenSpec is not available in this Workspace.", code: "OPEN_SPEC_UNAVAILABLE" };
  }
  const activeChanges = new Map(
    summaryResult.openSpec.changes.filter((change) => !change.archived).map((change) => [change.id, change])
  );
  const changeIds = new Set();
  const normalizedItems = items.map((item) => {
    const changeId = String(item?.changeId || "").trim();
    const change = activeChanges.get(changeId);
    if (!change || changeIds.has(changeId)) throw new Error(`OpenSpec change is unavailable: ${changeId || "unknown"}.`);
    changeIds.add(changeId);
    return {
      changeId,
      title: String(change.title || change.id).slice(0, 240),
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [],
      snapshot: {
        proposal: String(change.proposal?.excerpt || change.proposal?.why || "").slice(0, 8_000),
        tasks: (change.tasks?.groups || []).flatMap((group) => group.tasks || []).slice(0, 200).map((task) => String(task.text || "").slice(0, 500)),
        specs: (change.affectedSpecs || []).slice(0, 100).map((spec) => String(spec || "").slice(0, 240))
      },
      fingerprint: orchestrationChangeFingerprint(change)
    };
  });
  for (const item of normalizedItems) {
    const unknown = item.dependsOn.find((dependency) => !changeIds.has(dependency));
    if (unknown) throw new Error(`OpenSpec dependency is not selected: ${unknown}.`);
  }
  const [baseBranch, baseCommit] = await Promise.all([
    gitOutput(workspace.path, ["branch", "--show-current"]),
    gitOutput(workspace.path, ["rev-parse", "HEAD"])
  ]);
  if (!baseBranch || !/^[0-9a-f]{40,64}$/i.test(baseCommit)) throw new Error("Workspace must have a named Git branch and commit.");
  return {
    ok: true,
    plan: {
      projectId,
      baseBranch,
      baseCommit: baseCommit.toLowerCase(),
      generatedAt: new Date().toISOString(),
      items: normalizedItems
    }
  };
}

function orchestrationDesktopFailure(error) {
  if (error?.code === "WORKTREE_NO_CHANGES") {
    return {
      failureClass: "worktree-no-changes",
      errorSummary: "Change 未产生任何提交。它可能已经实现，或只剩人工验收；请更新或归档 OpenSpec change 后重新创建编排。",
      retryable: false
    };
  }
  if (error?.code === "CHANGE_SNAPSHOT_CHANGED" || error?.code === "BASE_CHANGE_SNAPSHOT_CHANGED") {
    return {
      failureClass: "change-snapshot-changed",
      errorSummary: String(error.message || error).slice(0, 1200),
      retryable: false
    };
  }
  return {
    failureClass: "desktop-error",
    errorSummary: String(error?.message || error).slice(0, 1200),
    retryable: false
  };
}

function orchestrationChangeFingerprint(change) {
  return crypto.createHash("sha256").update(JSON.stringify({
    id: change.id,
    updatedAt: change.updatedAt,
    proposal: change.proposal,
    tasks: change.tasks,
    affectedSpecs: change.affectedSpecs
  })).digest("hex");
}

function gitOutput(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `git ${args[0]} failed`)));
  });
}

async function fileRequestWorkspaces(request, payload) {
  const context = payload.sessionContext || {};
  if (context.executionTarget !== "session-worktree") return publicWorkspaces();
  const target = await resolveCodexSessionFileTarget({
    sessionId: context.sessionId,
    projectId: request.projectId,
    desktopAgentId: agentId,
    lifecycleState: context.lifecycleState
  });
  return publicWorkspaces().map((workspace) =>
    workspace.id === request.projectId ? { ...workspace, path: target.path } : workspace
  );
}

async function requestCodexApproval(approval) {
  const created = await postJson("/api/agent/codex/sessions/approvals", {
    agentId,
    agentInstanceId,
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
      agentInstanceId,
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
    agentInstanceId,
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
      agentInstanceId,
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
      agentInstanceId,
      workspaces: publicWorkspaces(),
      runtime: currentCodexRuntime()
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  return data.command || null;
}

async function reportSessionCommandReconciliation(commands = []) {
  const states = commands.map((command) => {
    const active = activeSessionCommands.get(String(command.commandId || ""));
    const sameAttempt = active && Number(active.attempt) === Number(command.attempt);
    return {
      commandId: command.commandId,
      attempt: command.attempt,
      state: sameAttempt ? "running" : "unknown"
    };
  });
  if (states.length === 0) return;
  await postJson("/api/agent/codex/sessions/reconcile", { agentId, agentInstanceId, states });
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
      agentInstanceId,
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
      agentInstanceId,
      workspaces: publicWorkspaces(),
      runtime: currentCodexRuntime(),
      ...scheduling
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  if (Array.isArray(data.reconciliation) && data.reconciliation.length > 0) {
    await reportSessionCommandReconciliation(data.reconciliation);
  }
  return data.command || null;
}

async function pollNextCodexSessionInterruptCommand() {
  const scheduling = codexSchedulingSnapshot();
  const response = await httpFetch(`${config.relayUrl}/api/agent/codex/sessions/next?wait=25000`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    body: JSON.stringify({
      agentId,
      agentInstanceId,
      workspaces: publicWorkspaces(),
      runtime: currentCodexRuntime(),
      commandTypes: ["stop"],
      ...scheduling
    }),
    timeoutMs: 35000
  });
  const data = await parseApiResponse(response);
  if (Array.isArray(data.reconciliation) && data.reconciliation.length > 0) {
    await reportSessionCommandReconciliation(data.reconciliation);
  }
  return data.command || null;
}

async function maybeCleanupWorktrees() {
  const result = await maybeCleanupCodexSessionWorktrees().catch((error) => {
    console.error(`[worktree cleanup] ${error.message}`);
    return null;
  });
  if (result?.cleanupFailed) {
    console.error(`[worktree cleanup] failed to safely remove ${result.cleanupFailed} managed worktree${result.cleanupFailed === 1 ? "" : "s"}`);
  }
  if (!result?.removed) return;
  console.log(
    `[worktree cleanup] removed ${result.removed} old clean worktree${result.removed === 1 ? "" : "s"}`
  );
}

function startWarmWorktreePoolMaintenance() {
  const run = () => {
    maintainCodexWarmWorktreePool()
      .then((warmPool) => logWarmWorktreePoolMaintenance({ warmPool }))
      .catch((error) => console.error(`[worktree warm pool] ${error.message}`));
  };
  run();
  const interval = setInterval(run, 6 * 60 * 60 * 1000);
  interval.unref?.();
}

function logWarmWorktreePoolMaintenance(result = {}) {
  if (result?.warmPool?.failed) {
    const summaries = Object.entries(result.warmPool.workspaces || {})
      .filter(([, workspace]) => workspace.failed > 0)
      .map(([workspaceId, workspace]) => `${workspaceId}: ${workspace.lastError || "maintenance failed"}`)
      .join("; ");
    console.error(`[worktree warm pool] ${result.warmPool.failed} operation${result.warmPool.failed === 1 ? "" : "s"} failed${summaries ? ` (${summaries})` : ""}`);
  }
  if (result?.warmPool?.created || result?.warmPool?.removed) {
    console.log(`[worktree warm pool] prepared ${result.warmPool.created}, removed ${result.warmPool.removed}`);
  }
}

function startCodexSessionHeartbeat(commandOrSessionId) {
  const command = commandOrSessionId && typeof commandOrSessionId === "object" ? commandOrSessionId : {};
  const sessionId = String(command.sessionId || commandOrSessionId || "").trim();
  const intervalMs = Math.max(15000, Math.min(Math.floor(config.codex.leaseMs / 2), 30000));
  const heartbeat = setInterval(() => {
    postJson("/api/agent/codex/sessions/events", {
      id: sessionId,
      commandId: command.id,
      attempt: command.attempt,
      agentId,
      agentInstanceId,
      events: []
    }).catch(() => {});
  }, intervalMs);
  heartbeat.unref?.();
  return heartbeat;
}

function startRunningSessionHeartbeat(sessionId, details = {}) {
  if (!sessionId || runningSessionHeartbeats.has(sessionId)) return;
  runningSessionHeartbeats.set(sessionId, startCodexSessionHeartbeat({ ...details, id: details.commandId, sessionId }));
  rememberRunningSessionState(sessionId, details);
}

function stopRunningSessionHeartbeat(sessionId) {
  const heartbeat = runningSessionHeartbeats.get(sessionId);
  if (heartbeat) {
    clearInterval(heartbeat);
    runningSessionHeartbeats.delete(sessionId);
  }
  runningSessionStates.delete(sessionId);
  maybeExitForDesktopAgentRestart();
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
    runningSessionIds: runningCodexSessionIds(),
    sessionActivitySnapshotAt: new Date().toISOString()
  };
}

function sessionWorkStateFromCommand(command = {}, result = {}) {
  const execution = result.execution || command.execution || {};
  return {
    commandId: String(command.id || "").trim(),
    attempt: Math.max(1, Number(command.attempt || 1) || 1),
    sessionId: String(result.sessionId || command.sessionId || "").trim(),
    projectId: String(result.projectId || command.projectId || execution.baseWorkspaceId || "").trim(),
    isolated: isIsolatedSessionExecution(command, result)
  };
}

function isIsolatedSessionExecution(command = {}, result = {}) {
  const execution = result.execution || command.execution || {};
  if (result.worktreeFallback || command.worktreeFallback) return false;
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
  return { "X-Echo-Agent-Token": config.agent.token };
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
  const workspaces = publicWorkspaces();
  const worktreeByWorkspace = Object.fromEntries(
    workspaces.map((workspace) => [workspace.id, codexWorktreeCapability(workspace)])
  );
  const runtime = desktopRuntimeSnapshot(desktopBackends, {
    agentId,
    dataDir: config.dataDir,
    sessionConcurrency: config.codex.sessionConcurrency,
    managedWorktreeAvailable: Object.values(worktreeByWorkspace).some((capability) => capability.availability === "optional")
  });
  if (!runtime || typeof runtime !== "object") return runtime;
  const roots = workspaceImportRoots();
  return {
    ...runtime,
    sourceRevision,
    projectImport: { roots },
    capabilities: {
      ...(runtime.capabilities || {}),
      projectImport: { roots },
      worktreeByWorkspace
    }
  };
}

function startAgentSnapshotSync() {
  postAgentSnapshot("startup", { force: true }).catch(() => {});

  const interval = setInterval(() => {
    postAgentSnapshot("periodic", { force: true }).catch(() => {});
  }, 30000);
  interval.unref?.();

  watchAgentSnapshotFile(workspaceConfigFilePath());
  watchAgentSnapshotFile(managedWorkspaceFilePath());
  watchAgentSnapshotFile(agentSkillStatePath({ agentId, dataDir: config.dataDir }));
  watchAgentSnapshotFile(desktopPluginStatePath({ agentId, dataDir: config.dataDir }));
}

function watchAgentSnapshotFile(filePath) {
  if (!filePath) return;
  const watcher = watchFile(filePath, { interval: 2000 }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    postAgentSnapshot(`workspace config changed: ${path.basename(filePath)}`, { force: true }).catch(() => {});
  });
  watcher.unref?.();
}

async function postAgentSnapshot(reason = "heartbeat", options = {}) {
  if (agentSnapshotPostPromise) {
    agentSnapshotPostAgain = Boolean(options.force || agentSnapshotPostAgain);
    return agentSnapshotPostPromise;
  }

  const snapshot = {
    agentId,
    agentInstanceId,
    workspaces: publicWorkspaces(),
    runtime: currentCodexRuntime()
  };
  const signature = JSON.stringify({
    workspaces: snapshot.workspaces,
    runtime: snapshot.runtime
  });

  if (!options.force && signature === lastPostedAgentSnapshotSignature) return null;

  agentSnapshotPostPromise = postJson("/api/agent/codex/heartbeat", snapshot)
    .then((result) => {
      lastPostedAgentSnapshotSignature = signature;
      lastAgentSnapshotError = "";
      if (reason !== "periodic") {
        console.log(`[agent snapshot] ${reason}; ${snapshot.workspaces.length} workspace${snapshot.workspaces.length === 1 ? "" : "s"} advertised.`);
      }
      logRestartReconciliations(result?.restarts);
      return result;
    })
    .catch((error) => {
      const message = formatFetchError(error);
      if (message !== lastAgentSnapshotError) {
        console.error(`[agent snapshot] ${message}`);
      }
      lastAgentSnapshotError = message;
      return null;
    })
    .finally(() => {
      agentSnapshotPostPromise = null;
      if (agentSnapshotPostAgain) {
        agentSnapshotPostAgain = false;
        postAgentSnapshot("workspace config changed", { force: true }).catch(() => {});
      }
    });

  return agentSnapshotPostPromise;
}

function logRestartReconciliations(restarts = []) {
  for (const restart of Array.isArray(restarts) ? restarts : []) {
    const operationId = String(restart?.id || "unknown");
    const instance = String(restart?.newInstanceId || agentInstanceId || "unknown");
    const revision = String(restart?.actualRevision || sourceRevision || "unknown");
    const status = String(restart?.status || "unknown");
    const message = `[desktop restart] operation=${operationId} status=${status} instance=${instance} revision=${revision}`;
    if (status === "failed") console.error(`${message} error=${String(restart?.error || "unknown")}`);
    else console.log(message);
  }
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
