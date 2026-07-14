import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { publicWorkspaces } from "./codexRunner.js";
import { readOrchestrationWorktree } from "./orchestrationWorktree.js";

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 15000;
const cleanupIntervalMs = 6 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;
const setupKeyFiles = [
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "uv.lock", "poetry.lock",
  "Cargo.lock", "go.sum", "Gemfile.lock", ".nvmrc", ".node-version", ".tool-versions"
];
let nextCleanupAt = 0;
let warmPoolMaintenancePromise = null;
let warmPoolOperationTail = Promise.resolve();
const warmPoolReadyCounts = new Map();

export async function prepareCodexSessionWorktree(command, options = {}) {
  if (command.execution?.ownerType === "orchestration") return reuseOrchestrationWorktree(command);
  if (command.execution?.path) {
    return reusePreparedCodexSessionWorktree(command, options);
  }
  if (command.execution?.mode === "worktree") {
    const stored = await readWorktreeMetadata(command.projectId, command.sessionId);
    if (!stored) {
      throw new Error("This Codex session worktree is no longer available on the desktop. Choose an explicit recovery action before continuing.");
    }
    return reusePreparedCodexSessionWorktree(
      { ...command, execution: { ...stored, ...command.execution, path: stored.path, basePath: stored.basePath } },
      options
    );
  }
  if (command.type !== "start") return command;
  if (!shouldUseWorktree(command)) return command;

  const baseWorkspace = publicWorkspaces().find((workspace) => workspace.id === command.projectId);
  if (!baseWorkspace) return worktreeUnavailableCommand(command, "workspace-not-allowed");

  const basePath = baseWorkspace.path;
  const root = await optionalGitRoot(basePath);
  if (!root) return worktreeUnavailableCommand(command, "not-git", { baseWorkspace });
  const baseCommit = await optionalGitHead(root);
  if (!baseCommit) return worktreeUnavailableCommand(command, "no-git-commit", { baseWorkspace });
  const baseBranch = (await git(root, ["branch", "--show-current"]).catch(() => "")).trim();
  if (!baseBranch) return worktreeUnavailableCommand(command, "missing-base-branch", { baseWorkspace, basePath: root, baseCommit });
  const branchName = `echo/job-${shortId(command.sessionId)}`;
  const worktreePath = path.join(config.codex.worktreeRoot, sanitizePathSegment(baseWorkspace.id), command.sessionId);
  const existing = await existingWorktreeExecution(worktreePath, {
    sessionId: command.sessionId,
    desktopAgentId: String(command.desktopAgentId || "").trim(),
    baseWorkspace,
    root,
    branchName,
    baseBranch,
    baseCommit
  });
  if (existing) {
    const setup = await prepareWorktreeSetup(existing, options);
    if (!setup.ok) return setupFailureCommand(command, setup.execution, options.onEvent ? [] : setup.events);
    await writeWorktreeMetadata(withWorktreeState(setup.execution, "ready"));
    return {
      ...command,
      runtime: withWorktreeCacheRuntime(command.runtime, setup.execution.baseWorkspaceId),
      execution: withWorktreeState(setup.execution, "ready")
    };
  }

  const status = await git(root, ["status", "--porcelain"]);
  if (status.trim()) {
    return worktreeUnavailableCommand(command, "dirty-base", { baseWorkspace, basePath: root, baseBranch, baseCommit });
  }

  const warmExecution = await claimReadyWarmWorktree({
    command,
    baseWorkspace,
    root,
    baseBranch,
    baseCommit,
    branchName,
    worktreePath
  });
  if (warmExecution) {
    const setup = await prepareWorktreeSetup(warmExecution, options);
    if (!setup.ok) return setupFailureCommand(command, setup.execution, options.onEvent ? [] : setup.events);
    const execution = withWorktreeState(setup.execution, "ready");
    await writeWorktreeMetadata(execution);
    return {
      ...command,
      runtime: withWorktreeCacheRuntime(command.runtime, execution.baseWorkspaceId),
      execution
    };
  }

  try {
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    if (await branchExists(root, branchName)) {
      await git(root, ["worktree", "add", worktreePath, branchName]);
    } else {
      await git(root, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
    }
  } catch {
    return worktreeUnavailableCommand(command, "create-failed", { baseWorkspace, basePath: root, baseBranch, baseCommit });
  }
  const createdWorktreeRoot = (await git(worktreePath, ["rev-parse", "--show-toplevel"])).trim();

  let prepared = {
    ...command,
    execution: {
      mode: "worktree",
      lifecycleState: "ready",
      sessionId: command.sessionId,
      baseWorkspaceId: baseWorkspace.id,
      desktopAgentId: String(command.desktopAgentId || "").trim(),
      basePath: root,
      path: createdWorktreeRoot || worktreePath,
      branchName,
      baseBranch,
      baseCommit,
      worktreeId: opaqueWorktreeId(command.sessionId),
      createdAt: new Date().toISOString()
    }
  };
  await writeWorktreeMetadata(prepared.execution);
  const setup = await prepareWorktreeSetup(prepared.execution, options);
  if (!setup.ok) return setupFailureCommand(command, setup.execution, options.onEvent ? [] : setup.events);
  prepared = { ...prepared, runtime: withWorktreeCacheRuntime(command.runtime, setup.execution.baseWorkspaceId), execution: setup.execution };
  return prepared;
}

async function reuseOrchestrationWorktree(command) {
  const execution = command.execution || {};
  const workspace = publicWorkspaces().find((item) => item.id === command.projectId);
  if (!workspace) throw new Error("The orchestration Workspace is no longer advertised by this Desktop agent.");
  const managed = await readOrchestrationWorktree({
    kind: execution.worktreeKind === "integration" ? "integration" : "change",
    desktopAgentId: command.desktopAgentId,
    projectId: command.projectId,
    runId: execution.runId,
    itemId: execution.itemId,
    workspacePath: workspace.path,
    baseBranch: execution.baseBranch,
    baseCommit: execution.baseCommit
  });
  if (!managed || managed.path !== execution.path || managed.branchName !== execution.branchName || managed.lifecycleState === "cleaned") {
    throw new Error("The orchestration Worktree does not match Desktop owner metadata.");
  }
  return {
    ...command,
    execution: {
      ...execution,
      sessionId: command.sessionId,
      path: managed.path,
      lifecycleState: "running",
      reused: true
    }
  };
}

export async function calculateCodexWorktreeSetupKey(workspacePath, extraFiles = []) {
  const hash = crypto.createHash("sha256");
  const candidates = [...setupKeyFiles, ...extraFiles];
  const requirements = await fs.readdir(workspacePath).catch(() => []);
  candidates.push(...requirements.filter((name) => /^requirements.*\.txt$/i.test(name)));
  for (const relativePath of [...new Set(candidates)].sort()) {
    const filePath = path.join(workspacePath, relativePath);
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function codexWorktreeRuntimePolicy(workspaceId) {
  return config.codex.worktreeRuntime?.[String(workspaceId || "").trim()] || null;
}

export function codexWorktreeCacheEnv(workspaceId) {
  return { ...(codexWorktreeRuntimePolicy(workspaceId)?.cacheEnv || {}) };
}

export function codexWorktreeSharedCacheEnv() {
  const merged = {};
  for (const policy of Object.values(config.codex.worktreeRuntime || {})) {
    for (const [key, value] of Object.entries(policy?.cacheEnv || {})) {
      if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
}

export function codexWorktreeCapability(workspace) {
  const policy = codexWorktreeRuntimePolicy(workspace?.id);
  const available = config.codex.worktreeMode !== "off";
  return {
    availability: available ? "optional" : "disabled",
    setupProfiles: (policy?.setupProfiles || []).map((profile) => ({
      id: profile.id,
      label: profile.label,
      automatic: profile.automatic
    })),
    defaultSetupProfileId: policy?.defaultSetupProfileId || "",
    cachePolicy: { enabled: Object.keys(policy?.cacheEnv || {}).length > 0, families: cacheFamilies(policy?.cacheEnv) },
    warmPool: {
      enabled: Number(policy?.warmPool?.maxCount || 0) > 0,
      maxCount: Number(policy?.warmPool?.maxCount || 0),
      readyCount: warmPoolReadyCounts.get(String(workspace?.id || "").trim()) || 0
    },
    supportsApply: available,
    supportsDiscard: available
  };
}

export function publicCodexWorktreeExecution(execution = {}) {
  return compactWorktreeExecution(execution);
}

async function prepareWorktreeSetup(execution, options = {}) {
  const policy = codexWorktreeRuntimePolicy(execution.baseWorkspaceId);
  const profileId = String(options.setupProfileId || policy?.defaultSetupProfileId || "").trim();
  const profile = (policy?.setupProfiles || []).find((item) => item.id === profileId);
  if (!profile || (profile.automatic === false && options.requireSetup !== true)) {
    const skipped = withWorktreeState(execution, "ready", { setupStatus: "skipped", setupProfileId: profile?.id || "" });
    await emitSetupEvent(options, skipped, "skipped", "Worktree setup was not required.");
    return { ok: true, execution: skipped, events: [] };
  }
  const setupKey = await calculateCodexWorktreeSetupKey(execution.path, policy.extraSetupKeyFiles);
  if (execution.setupStatus === "succeeded" && execution.setupKey === setupKey && execution.setupProfileId === profile.id) {
    const ready = withWorktreeState(execution, "ready");
    await emitSetupEvent(options, ready, "skipped", "Worktree setup is already current.");
    return { ok: true, execution: ready, events: [] };
  }
  if (execution.setupKey && (execution.setupKey !== setupKey || execution.setupProfileId !== profile.id)) {
    const invalidated = withWorktreeState(execution, "setting-up", { setupStatus: "invalidated", setupKey });
    await persistSetupExecution(options, invalidated);
    await emitSetupEvent(options, invalidated, "invalidated", "Worktree setup inputs changed; setup will run again.");
  }
  const startedAt = new Date().toISOString();
  let running = withWorktreeState(execution, "setting-up", {
    setupProfileId: profile.id,
    setupKey,
    setupStatus: "running",
    setupStartedAt: startedAt,
    setupFinishedAt: "",
    errorCode: "",
    errorSummary: ""
  });
  await persistSetupExecution(options, running);
  await emitSetupEvent(options, running, "queued", `Worktree setup queued for ${profile.label}.`);
  await emitSetupEvent(options, running, "running", `Preparing worktree with ${profile.label}.`);
  try {
    const result = await execFileAsync(profile.command, profile.args, {
      cwd: execution.path,
      env: { ...process.env, ...codexWorktreeCacheEnv(execution.baseWorkspaceId) },
      timeout: profile.timeoutMs,
      maxBuffer: 256 * 1024
    });
    running = withWorktreeState(running, "ready", {
      setupStatus: "succeeded",
      setupFinishedAt: new Date().toISOString(),
      setupSummary: boundedSetupOutput(result.stdout || result.stderr)
    });
    await persistSetupExecution(options, running);
    const event = setupEvent(running, "succeeded", `Worktree setup completed with ${profile.label}.`);
    await emitSetupEvent(options, running, "succeeded", event.text, event.raw.setup.summary);
    return { ok: true, execution: running, events: [event] };
  } catch (error) {
    const summary = boundedSetupOutput(error.stderr || error.stdout || error.message);
    const failed = withWorktreeState(running, "failed", {
      setupStatus: "failed",
      setupFinishedAt: new Date().toISOString(),
      errorCode: error.killed ? "setup-timeout" : "setup-failed",
      errorSummary: summary || "Desktop worktree setup failed."
    });
    await persistSetupExecution(options, failed);
    const event = setupEvent(failed, "failed", "Worktree setup failed.", summary, Number(error.code) || null);
    await emitSetupEvent(options, failed, "failed", event.text, summary, Number(error.code) || null);
    return { ok: false, execution: failed, events: [event] };
  }
}

async function persistSetupExecution(options, execution) {
  if (typeof options.persistExecution === "function") return options.persistExecution(execution);
  return writeWorktreeMetadata(execution);
}

async function emitSetupEvent(options, execution, status, text, summary = "", exitCode = null) {
  if (typeof options.onEvent !== "function") return;
  await options.onEvent(setupEvent(execution, status, text, summary, exitCode));
}

function setupEvent(execution, status, text, summary = "", exitCode = null) {
  return {
    type: `worktree.setup.${status}`,
    text,
    raw: {
      source: "desktop-agent",
      method: `worktree.setup.${status}`,
      setup: { status, profileId: execution.setupProfileId || "", summary: boundedSetupOutput(summary), exitCode },
      worktree: compactWorktreeExecution(execution)
    }
  };
}

function setupFailureCommand(command, execution, events) {
  return {
    ...command,
    execution,
    worktreeUnavailableResult: { ok: false, sessionStatus: "failed", execution, error: execution.errorSummary, events }
  };
}

function boundedSetupOutput(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "").trim().slice(-2000);
}

function cacheFamilies(env = {}) {
  const keys = Object.keys(env).map((key) => key.toUpperCase());
  const families = [];
  if (keys.some((key) => /NPM|PNPM|YARN|BUN/.test(key))) families.push("node");
  if (keys.some((key) => /PIP|UV/.test(key))) families.push("python");
  if (keys.some((key) => /CARGO|RUST/.test(key))) families.push("rust");
  if (keys.some((key) => /GOMODCACHE|GOCACHE/.test(key))) families.push("go");
  if (keys.some((key) => /CCACHE|SCCACHE|BUILD/.test(key))) families.push("build");
  return families;
}

function withWorktreeCacheRuntime(runtime = {}, workspaceId) {
  const cacheEnv = codexWorktreeCacheEnv(workspaceId);
  return Object.keys(cacheEnv).length > 0 ? { ...runtime, worktreeCacheEnv: cacheEnv } : runtime;
}

function opaqueWorktreeId(sessionId) {
  return `wt_${crypto.createHash("sha256").update(String(sessionId || "")).digest("hex").slice(0, 16)}`;
}

export async function resolveCodexSessionFileTarget(input = {}) {
  const sessionId = String(input.sessionId || "").trim();
  const projectId = String(input.projectId || "").trim();
  const desktopAgentId = String(input.desktopAgentId || "").trim();
  const lifecycleState = String(input.lifecycleState || "").trim().toLowerCase();
  if (!sessionId || !projectId) throw publicWorktreeFileError("Worktree file target is invalid.", "WORKTREE_INVALID");
  if (["discarded", "applied", "unavailable", "cleanup-failed", "cleanup-pending"].includes(lifecycleState)) {
    throw publicWorktreeFileError("This session worktree is no longer available.", "WORKTREE_UNAVAILABLE");
  }
  const metadata = await readWorktreeMetadata(projectId, sessionId);
  if (!metadata) throw publicWorktreeFileError("This session worktree is no longer available.", "WORKTREE_UNAVAILABLE");
  const metadataState = String(metadata.lifecycleState || metadata.cleanupState || "").trim().toLowerCase();
  if (["discarded", "applied", "unavailable", "cleanup-failed", "cleanup-pending"].includes(metadataState)) {
    throw publicWorktreeFileError("This session worktree is no longer available.", "WORKTREE_UNAVAILABLE");
  }
  validateWorktreeOwnership(metadata, { sessionId, projectId, desktopAgentId });
  const resolvedPath = comparablePath(metadata.path);
  if (!isPathInside(resolvedPath, comparablePath(config.codex.worktreeRoot))) {
    throw publicWorktreeFileError("Worktree file target is outside the desktop-managed root.", "WORKTREE_INVALID");
  }
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat?.isDirectory()) throw publicWorktreeFileError("This session worktree is no longer available.", "WORKTREE_UNAVAILABLE");
  return { path: resolvedPath };
}

function publicWorktreeFileError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function reusePreparedCodexSessionWorktree(command, options = {}) {
  const execution = normalizeWorktreeExecution(command.execution);
  if (!execution) return command;
  validateWorktreeOwnership(execution, command);
  if (execution.lifecycleState === "discarded" || execution.cleanupState === "discarded" || execution.discardedAt) {
    throw new Error("This Codex session worktree has been discarded. Choose an explicit recovery action before continuing.");
  }
  if (execution.lifecycleState === "applied" || execution.cleanupState === "applied" || execution.appliedAt) {
    throw new Error("This Codex session worktree has already been applied. Start a new isolated session before making more worktree changes.");
  }

  const resolvedPath = comparablePath(execution.path);
  const resolvedRoot = comparablePath(config.codex.worktreeRoot);
  if (!isPathInside(resolvedPath, resolvedRoot)) {
    throw new Error("Codex worktree path is outside the desktop-controlled worktree root.");
  }
  if (!(await pathExists(resolvedPath))) {
    const unavailable = withWorktreeState(execution, "unavailable", {
      unavailableAt: new Date().toISOString()
    });
    await writeWorktreeMetadata(unavailable);
    throw new Error("This Codex session worktree is no longer available on the desktop. Choose an explicit recovery action before continuing.");
  }
  let gitRoot = "";
  try {
    gitRoot = (await git(resolvedPath, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    const unavailable = withWorktreeState(execution, "unavailable", {
      unavailableAt: new Date().toISOString()
    });
    await writeWorktreeMetadata(unavailable);
    throw new Error("This Codex session worktree is invalid. Choose an explicit recovery action before continuing.");
  }

  let reusedExecution = withWorktreeState(
    {
      ...execution,
      path: gitRoot || resolvedPath,
      reused: true
    },
    command.type === "worktree" ? execution.lifecycleState || "ready" : "running"
  );
  await writeWorktreeMetadata(reusedExecution);
  const setup = await prepareWorktreeSetup(reusedExecution, options);
  if (!setup.ok) return setupFailureCommand(command, setup.execution, options.onEvent ? [] : setup.events);
  reusedExecution = withWorktreeState(
    setup.execution,
    command.type === "worktree" ? setup.execution.lifecycleState || "ready" : "running"
  );
  await writeWorktreeMetadata(reusedExecution);
  return {
    ...command,
    runtime: withWorktreeCacheRuntime(command.runtime, reusedExecution.baseWorkspaceId),
    execution: reusedExecution
  };
}

async function existingWorktreeExecution(worktreePath, metadata) {
  try {
    const stat = await fs.stat(worktreePath);
    if (!stat.isDirectory()) {
      throw new Error(`Codex worktree path already exists and is not a directory: ${worktreePath}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  let worktreeRoot = "";
  try {
    worktreeRoot = (await git(worktreePath, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new Error(`Codex worktree path already exists but is not a Git worktree: ${worktreePath}`);
  }

  const stored = await readWorktreeMetadata(metadata.baseWorkspace.id, metadata.sessionId);
  if (stored) {
    validateWorktreeOwnership(stored, {
      sessionId: metadata.sessionId,
      projectId: metadata.baseWorkspace.id,
      desktopAgentId: metadata.desktopAgentId
    });
    if (comparablePath(stored.path) !== comparablePath(worktreeRoot || worktreePath)) {
      throw new Error("Existing Codex worktree metadata does not match the managed worktree path.");
    }
    return { ...stored, path: worktreeRoot || worktreePath, reused: true };
  }

  return {
    mode: "worktree",
    lifecycleState: "ready",
    sessionId: metadata.sessionId,
    baseWorkspaceId: metadata.baseWorkspace.id,
    desktopAgentId: metadata.desktopAgentId || "",
    basePath: metadata.root,
    path: worktreeRoot || worktreePath,
    branchName: metadata.branchName,
    baseBranch: metadata.baseBranch,
    baseCommit: metadata.baseCommit,
    createdAt: new Date().toISOString(),
    reused: true
  };
}

export async function maintainCodexWarmWorktreePool(options = {}) {
  if (warmPoolMaintenancePromise) return warmPoolMaintenancePromise;
  warmPoolMaintenancePromise = withWarmPoolLock(() => maintainCodexWarmWorktreePoolInternal(options)).finally(() => {
    warmPoolMaintenancePromise = null;
  });
  return warmPoolMaintenancePromise;
}

function withWarmPoolLock(operation) {
  const result = warmPoolOperationTail.then(operation, operation);
  warmPoolOperationTail = result.catch(() => {});
  return result;
}

async function maintainCodexWarmWorktreePoolInternal(options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const summary = { checked: 0, created: 0, removed: 0, failed: 0, workspaces: {} };
  const advertised = new Map(publicWorkspaces().map((workspace) => [String(workspace.id || "").trim(), workspace]));
  await fs.mkdir(config.codex.worktreeRoot, { recursive: true });

  for (const [workspaceId, workspace] of advertised) {
    const workspaceSummary = { ready: 0, created: 0, removed: 0, failed: 0, lastError: "" };
    summary.workspaces[workspaceId] = workspaceSummary;
    const policy = codexWorktreeRuntimePolicy(workspaceId);
    const maxCount = config.codex.worktreeMode === "off" ? 0 : Number(policy?.warmPool?.maxCount || 0);
    const ttlHours = Number(policy?.warmPool?.ttlHours || 24);
    const basePath = await optionalGitRoot(workspace.path).catch(() => "");
    const baseCommit = basePath ? await optionalGitHead(basePath).catch(() => "") : "";
    const baseBranch = basePath ? (await git(basePath, ["branch", "--show-current"]).catch(() => "")).trim() : "";
    const setupKey = basePath
      ? await calculateCodexWorktreeSetupKey(basePath, policy?.extraSetupKeyFiles || []).catch(() => "")
      : "";
    const policyKey = warmPoolPolicyKey(policy);
    const context = { workspace, workspaceId, policy, maxCount, ttlHours, basePath, baseCommit, baseBranch, setupKey, policyKey, nowMs };
    const entries = await listWarmWorktreeMetadata(workspaceId);

    for (const entry of entries) {
      summary.checked += 1;
      if (workspaceSummary.ready < maxCount && await isReadyWarmWorktree(entry, context)) {
        workspaceSummary.ready += 1;
        continue;
      }
      const removed = await removeWarmWorktree(entry, basePath);
      if (removed) {
        summary.removed += 1;
        workspaceSummary.removed += 1;
      } else {
        summary.failed += 1;
        workspaceSummary.failed += 1;
      }
    }

    const baseClean = basePath ? !(await git(basePath, ["status", "--porcelain"]).catch(() => "invalid")) : false;
    while (
      workspaceSummary.ready < maxCount &&
      basePath &&
      baseCommit &&
      baseBranch &&
      setupKey &&
      baseClean
    ) {
      const created = await createWarmWorktree(context);
      if (!created.ok) {
        summary.failed += 1;
        workspaceSummary.failed += 1;
        workspaceSummary.lastError = created.error;
        break;
      }
      summary.created += 1;
      workspaceSummary.created += 1;
      workspaceSummary.ready += 1;
    }
    warmPoolReadyCounts.set(workspaceId, workspaceSummary.ready);
  }

  const advertisedMetadataIds = new Set([...advertised.keys()].map(sanitizePathSegment));
  for (const workspaceId of await listWarmPoolWorkspaceIds()) {
    if (advertisedMetadataIds.has(sanitizePathSegment(workspaceId))) continue;
    const workspaceSummary = { ready: 0, created: 0, removed: 0, failed: 0, lastError: "Workspace is no longer advertised." };
    summary.workspaces[workspaceId] = workspaceSummary;
    for (const entry of await listWarmWorktreeMetadata(workspaceId)) {
      summary.checked += 1;
      const removed = await removeWarmWorktree(entry);
      if (removed) {
        summary.removed += 1;
        workspaceSummary.removed += 1;
      } else {
        summary.failed += 1;
        workspaceSummary.failed += 1;
      }
    }
  }

  for (const workspaceId of [...warmPoolReadyCounts.keys()]) {
    if (!advertised.has(workspaceId)) warmPoolReadyCounts.delete(workspaceId);
  }
  return summary;
}

async function createWarmWorktree(context) {
  const warmId = crypto.randomBytes(8).toString("hex");
  const poolRoot = warmWorktreePoolRoot(context.workspaceId);
  const worktreePath = path.join(poolRoot, warmId);
  const branchName = `echo/warm-${sanitizePathSegment(context.workspaceId)}-${warmId}`;
  if (!isPathInside(comparablePath(worktreePath), comparablePath(config.codex.worktreeRoot))) {
    return { ok: false, error: "Warm worktree path is outside the desktop-managed root." };
  }

  let execution = {
    mode: "worktree",
    lifecycleState: "setting-up",
    baseWorkspaceId: context.workspaceId,
    basePath: context.basePath,
    path: worktreePath,
    branchName,
    baseBranch: context.baseBranch,
    baseCommit: context.baseCommit,
    warmId,
    warmPoolSource: "prepared",
    warmPoolPolicyKey: context.policyKey,
    createdAt: new Date(context.nowMs).toISOString()
  };
  try {
    await fs.mkdir(poolRoot, { recursive: true });
    await git(context.basePath, ["worktree", "add", "-b", branchName, worktreePath, context.baseCommit]);
    const setup = await prepareWorktreeSetup(execution, {
      setupProfileId: context.policy?.warmPool?.setupProfileId,
      requireSetup: true,
      persistExecution: (nextExecution) => writeWarmWorktreeMetadata({ ...nextExecution, warmId })
    });
    if (!setup.ok) {
      await removeWarmWorktree({ ...setup.execution, warmId }, context.basePath);
      return { ok: false, error: boundedSetupOutput(setup.execution.errorSummary || "Warm worktree setup failed.") };
    }
    execution = {
      ...setup.execution,
      lifecycleState: "ready",
      setupKey: context.setupKey,
      warmPoolPolicyKey: context.policyKey,
      readyAt: new Date(context.nowMs).toISOString()
    };
    await writeWarmWorktreeMetadata(execution);
    return { ok: true, execution };
  } catch (error) {
    await removeWarmWorktree(execution, context.basePath).catch(() => false);
    return { ok: false, error: boundedSetupOutput(error?.message || "Warm worktree preparation failed.") };
  }
}

async function claimReadyWarmWorktree(input) {
  if (warmPoolMaintenancePromise) return null;
  return withWarmPoolLock(() => claimReadyWarmWorktreeInternal(input));
}

async function claimReadyWarmWorktreeInternal(input) {
  const policy = codexWorktreeRuntimePolicy(input.baseWorkspace.id);
  if (Number(policy?.warmPool?.maxCount || 0) <= 0) return null;
  if (await branchExists(input.root, input.branchName)) return null;
  const setupKey = await calculateCodexWorktreeSetupKey(input.root, policy.extraSetupKeyFiles || []);
  const context = {
    workspace: input.baseWorkspace,
    workspaceId: input.baseWorkspace.id,
    policy,
    maxCount: policy.warmPool.maxCount,
    ttlHours: policy.warmPool.ttlHours,
    basePath: input.root,
    baseCommit: input.baseCommit,
    baseBranch: input.baseBranch,
    setupKey,
    policyKey: warmPoolPolicyKey(policy),
    nowMs: Date.now()
  };

  for (const entry of await listWarmWorktreeMetadata(input.baseWorkspace.id)) {
    if (!(await isReadyWarmWorktree(entry, context))) continue;
    const metadataPath = warmWorktreeMetadataPath(input.baseWorkspace.id, entry.warmId);
    const claimedPath = `${metadataPath}.claim-${sanitizePathSegment(input.command.sessionId)}`;
    try {
      await fs.rename(metadataPath, claimedPath);
    } catch {
      continue;
    }

    try {
      await fs.mkdir(path.dirname(input.worktreePath), { recursive: true });
      await git(input.root, ["worktree", "move", entry.path, input.worktreePath]);
      await git(input.worktreePath, ["branch", "-m", input.branchName]);
      await fs.rm(claimedPath, { force: true }).catch(() => {});
      warmPoolReadyCounts.set(input.baseWorkspace.id, Math.max(0, (warmPoolReadyCounts.get(input.baseWorkspace.id) || 1) - 1));
      queueMicrotask(() => {
        maintainCodexWarmWorktreePool().catch(() => {});
      });
      return {
        ...entry,
        lifecycleState: "ready",
        sessionId: input.command.sessionId,
        desktopAgentId: String(input.command.desktopAgentId || "").trim(),
        path: input.worktreePath,
        branchName: input.branchName,
        worktreeId: opaqueWorktreeId(input.command.sessionId),
        warmPoolSource: "warm-pool",
        assignedAt: new Date().toISOString(),
        reused: false
      };
    } catch {
      await fs.rm(claimedPath, { force: true }).catch(() => {});
      const cleanupPath = (await pathExists(input.worktreePath)) ? input.worktreePath : entry.path;
      await removeWarmWorktree({ ...entry, path: cleanupPath }, input.root).catch(() => false);
    }
  }
  return null;
}

async function isReadyWarmWorktree(entry, context) {
  if (!entry || entry.lifecycleState !== "ready" || !entry.warmId) return false;
  if (context.maxCount <= 0 || !context.basePath || !context.baseCommit || !context.baseBranch || !context.setupKey) return false;
  if (entry.baseWorkspaceId !== context.workspaceId) return false;
  if (entry.basePath !== context.basePath || entry.baseBranch !== context.baseBranch || entry.baseCommit !== context.baseCommit) return false;
  if (entry.setupKey !== context.setupKey || entry.warmPoolPolicyKey !== context.policyKey) return false;
  const readyAtMs = Date.parse(entry.readyAt || entry.createdAt || "");
  if (!Number.isFinite(readyAtMs) || readyAtMs + context.ttlHours * hourMs <= context.nowMs) return false;
  const expectedPath = path.join(warmWorktreePoolRoot(context.workspaceId), sanitizePathSegment(entry.warmId));
  if (comparablePath(entry.path) !== comparablePath(expectedPath)) return false;
  if (!isPathInside(comparablePath(entry.path), comparablePath(config.codex.worktreeRoot))) return false;
  if (!(await pathExists(entry.path))) return false;
  const head = await optionalGitHead(entry.path).catch(() => "");
  const branch = (await git(entry.path, ["branch", "--show-current"]).catch(() => "")).trim();
  return head === context.baseCommit && branch === entry.branchName;
}

async function removeWarmWorktree(entry, fallbackBasePath = "") {
  const workspaceId = String(entry?.baseWorkspaceId || "").trim();
  const warmId = String(entry?.warmId || "").trim();
  const worktreePath = comparablePath(entry?.path || "");
  if (!workspaceId || !warmId || !isPathInside(worktreePath, comparablePath(warmWorktreePoolRoot(workspaceId)))) return false;
  const basePath = entry.basePath && (await pathExists(entry.basePath)) ? entry.basePath : fallbackBasePath;
  try {
    if (await pathExists(worktreePath)) {
      if (!basePath) return false;
      await git(basePath, ["worktree", "remove", "--force", worktreePath]);
    }
    if (entry.branchName && basePath && (await branchExists(basePath, entry.branchName))) {
      await git(basePath, ["branch", "-D", entry.branchName]);
    }
    await fs.rm(warmWorktreeMetadataPath(workspaceId, warmId), { force: true });
    if (entry.metadataPath) await fs.rm(entry.metadataPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function warmPoolPolicyKey(policy = {}) {
  const profile = (policy?.setupProfiles || []).find((item) => item.id === policy.defaultSetupProfileId) || null;
  const payload = {
    profile,
    extraSetupKeyFiles: policy?.extraSetupKeyFiles || [],
    cacheEnv: policy?.cacheEnv || {},
    warmPool: policy?.warmPool || { maxCount: 0, ttlHours: 24 }
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function listWarmWorktreeMetadata(workspaceId) {
  const directory = warmWorktreeMetadataRoot(workspaceId);
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const entries = [];
  for (const file of files) {
    if (!file.isFile() || (!file.name.endsWith(".json") && !file.name.includes(".json.claim-"))) continue;
    const metadataPath = path.join(directory, file.name);
    const warmId = file.name.split(".json", 1)[0];
    const entry = await fs.readFile(metadataPath, "utf8").then(JSON.parse).catch(() => null);
    entries.push(entry ? {
      ...entry,
      lifecycleState: file.name.includes(".json.claim-") ? "invalid" : entry.lifecycleState,
      metadataPath
    } : {
      baseWorkspaceId: workspaceId,
      warmId,
      path: path.join(warmWorktreePoolRoot(workspaceId), warmId),
      metadataPath,
      lifecycleState: "invalid"
    });
  }
  return entries;
}

async function listWarmPoolWorkspaceIds() {
  const entries = await fs.readdir(path.join(comparablePath(config.codex.worktreeRoot), ".warm-pool-metadata"), {
    withFileTypes: true
  }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name);
}

async function writeWarmWorktreeMetadata(execution = {}) {
  const workspaceId = sanitizePathSegment(execution.baseWorkspaceId);
  const warmId = sanitizePathSegment(execution.warmId);
  const worktreePath = comparablePath(execution.path);
  if (!workspaceId || !warmId || !isPathInside(worktreePath, comparablePath(warmWorktreePoolRoot(workspaceId)))) return;
  const metadataPath = warmWorktreeMetadataPath(workspaceId, warmId);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify({ ...execution, path: worktreePath }, null, 2), "utf8");
}

function warmWorktreePoolRoot(workspaceId) {
  return path.join(comparablePath(config.codex.worktreeRoot), sanitizePathSegment(workspaceId), ".warm-pool");
}

function warmWorktreeMetadataRoot(workspaceId) {
  return path.join(comparablePath(config.codex.worktreeRoot), ".warm-pool-metadata", sanitizePathSegment(workspaceId));
}

function warmWorktreeMetadataPath(workspaceId, warmId) {
  return path.join(warmWorktreeMetadataRoot(workspaceId), `${sanitizePathSegment(warmId)}.json`);
}

export async function maybeCleanupCodexSessionWorktrees(options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  if (!options.force && nowMs < nextCleanupAt) return null;
  nextCleanupAt = nowMs + cleanupIntervalMs;
  return cleanupCodexSessionWorktrees({ ...options, nowMs });
}

export async function cleanupCodexSessionWorktrees(options = {}) {
  const retentionDays = Number(options.retentionDays ?? config.codex.worktreeRetentionDays ?? 14);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { checked: 0, removed: 0, cleanupFailed: 0, skippedDirty: 0, skippedYoung: 0, skippedInvalid: 0 };
  }

  const root = comparablePath(config.codex.worktreeRoot);
  const nowMs = Number(options.nowMs || Date.now());
  const cutoffMs = nowMs - retentionDays * dayMs;
  const result = { checked: 0, removed: 0, cleanupFailed: 0, skippedDirty: 0, skippedYoung: 0, skippedInvalid: 0 };

  let projects = [];
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }

  for (const projectEntry of projects) {
    if (!projectEntry.isDirectory() || projectEntry.name.startsWith(".")) continue;
    const projectPath = path.join(root, projectEntry.name);
    let sessions = [];
    try {
      sessions = await fs.readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionEntry of sessions) {
      if (!sessionEntry.isDirectory() || sessionEntry.name.startsWith(".")) continue;
      const worktreePath = path.join(projectPath, sessionEntry.name);
      const resolvedPath = comparablePath(worktreePath);
      if (!isPathInside(resolvedPath, root)) {
        result.skippedInvalid += 1;
        continue;
      }

      result.checked += 1;
      const metadata = await readWorktreeMetadata(projectEntry.name, sessionEntry.name);
      const touchedAtMs = metadata?.touchedAt ? Date.parse(metadata.touchedAt) : NaN;
      const fallbackStat = await fs.stat(resolvedPath).catch(() => null);
      const lastSeenMs = Number.isFinite(touchedAtMs) ? touchedAtMs : fallbackStat?.mtimeMs || nowMs;
      if (lastSeenMs > cutoffMs) {
        result.skippedYoung += 1;
        continue;
      }

      const status = await git(resolvedPath, ["status", "--porcelain"]).catch(() => null);
      if (status === null) {
        result.skippedInvalid += 1;
        continue;
      }
      if (status.trim()) {
        result.skippedDirty += 1;
        continue;
      }

      const removeCwd = metadata?.basePath && (await pathExists(metadata.basePath)) ? metadata.basePath : resolvedPath;
      try {
        await git(removeCwd, ["worktree", "remove", "--force", resolvedPath]);
      } catch {
        result.cleanupFailed += 1;
        if (metadata) {
          await writeWorktreeMetadata(withWorktreeState(metadata, "cleanup-failed", {
            cleanupState: "cleanup-failed",
            errorCode: "worktree-remove-failed",
            errorSummary: "Desktop could not safely remove the managed worktree."
          }));
        }
        continue;
      }
      await removeWorktreeMetadata(projectEntry.name, sessionEntry.name);
      result.removed += 1;
    }
  }

  return result;
}

export async function touchCodexSessionWorktree(commandOrExecution) {
  const execution = commandOrExecution?.execution || commandOrExecution;
  if (execution?.mode !== "worktree" || !execution.path) return false;
  await writeWorktreeMetadata(withWorktreeState(execution, execution.lifecycleState || "ready"));
  return true;
}

export async function readCodexSessionWorktreeMetadata(projectId, sessionId) {
  return readWorktreeMetadata(sanitizePathSegment(projectId), sessionId);
}

export async function applyCodexSessionWorktree(command) {
  const existing = normalizeWorktreeExecution(command.execution);
  validateWorktreeOwnership(existing || {}, command);
  if (isAppliedExecution(existing)) return terminalWorktreeResult(existing, "applied");
  const execution = validateWorktreeExecution(command);
  const preflight = await preflightWorktreeApply(command, execution);
  if (!preflight.ok) return persistBlockedWorktreeApplyResult(execution, preflight);

  const { basePath, worktreePath, entries, changedPaths } = preflight;
  const backupRoot = path.join(config.codex.worktreeRoot, ".apply-backups", sanitizePathSegment(command.sessionId));
  await fs.rm(backupRoot, { recursive: true, force: true });
  await fs.mkdir(backupRoot, { recursive: true });
  const backups = await backupApplyTargets(basePath, backupRoot, entries);
  try {
    for (const entry of entries) await applyWorktreeEntry({ basePath, worktreePath, entry });
  } catch (error) {
    await restoreApplyTargets(basePath, backups);
    await fs.rm(backupRoot, { recursive: true, force: true });
    return persistBlockedWorktreeApplyResult(execution, {
      code: "apply-failed",
      message: "Applying the worktree failed; the base workspace was restored.",
      changedPaths
    });
  }
  await fs.rm(backupRoot, { recursive: true, force: true });

  const appliedAt = new Date().toISOString();
  const nextExecution = withWorktreeState(execution, "applied", {
    appliedAt,
    appliedTo: basePath,
    cleanupState: "applied",
    errorCode: "",
    errorSummary: "",
    conflictSummary: null
  });
  await writeWorktreeMetadata(nextExecution);

  return {
    ok: true,
    sessionStatus: "active",
    execution: nextExecution,
    events: [
      {
        type: "worktree.applied",
        text:
          changedPaths.length > 0
            ? `Applied ${changedPaths.length} worktree change${changedPaths.length === 1 ? "" : "s"} to the base workspace.`
            : "Worktree had no changes to apply.",
        raw: {
          source: "desktop-agent",
          method: "worktree.applied",
          worktree: compactWorktreeExecution(nextExecution),
          changedFiles: changedPaths
        }
      }
    ]
  };
}

export async function discardCodexSessionWorktree(command) {
  const existing = normalizeWorktreeExecution(command.execution);
  validateWorktreeOwnership(existing || {}, command);
  if (isDiscardedExecution(existing)) return terminalWorktreeResult(existing, "discarded");
  const execution = validateWorktreeExecution(command);
  const resolvedRoot = comparablePath(config.codex.worktreeRoot);
  const resolvedPath = comparablePath(execution.path);
  if (!isPathInside(resolvedPath, resolvedRoot)) {
    throw new Error("Codex worktree discard path is outside the desktop-controlled worktree root.");
  }

  const basePath = execution.basePath && (await pathExists(execution.basePath)) ? execution.basePath : resolvedPath;
  try {
    await git(basePath, ["worktree", "remove", "--force", resolvedPath]);
  } catch (error) {
    const failed = withWorktreeState(execution, "cleanup-failed", {
      cleanupState: "cleanup-failed",
      errorCode: "worktree-remove-failed",
      errorSummary: "Desktop could not safely remove the managed worktree."
    });
    await writeWorktreeMetadata(failed);
    return worktreeFailureResult(failed, "worktree.cleanup-failed");
  }

  const branchName = String(execution.branchName || "").trim();
  if (branchName && execution.basePath && (await pathExists(execution.basePath))) {
    try {
      await git(execution.basePath, ["branch", "-D", branchName]);
    } catch {
      const failed = withWorktreeState(execution, "cleanup-failed", {
        cleanupState: "cleanup-failed",
        errorCode: "worktree-branch-delete-failed",
        errorSummary: "The worktree was removed, but its managed branch could not be deleted."
      });
      await writeWorktreeMetadata(failed);
      return worktreeFailureResult(failed, "worktree.cleanup-failed");
    }
  }
  const discardedAt = new Date().toISOString();
  const nextExecution = withWorktreeState(execution, "discarded", {
    discardedAt,
    cleanupState: "discarded",
    errorCode: "",
    errorSummary: "",
    conflictSummary: null
  });
  await writeWorktreeMetadata(nextExecution);

  return {
    ok: true,
    sessionStatus: "active",
    execution: nextExecution,
    events: [
      {
        type: "worktree.discarded",
        text: "Discarded the isolated worktree.",
        raw: {
          source: "desktop-agent",
          method: "worktree.discarded",
          worktree: compactWorktreeExecution(nextExecution)
        }
      }
    ]
  };
}

function shouldUseWorktree(command) {
  if (config.codex.worktreeMode === "always") return true;
  return config.codex.worktreeMode === "optional" && String(command.runtime?.worktreeMode || "").trim() === "always";
}

async function optionalGitRoot(basePath) {
  try {
    return (await git(basePath, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (isNotGitRepositoryError(error)) return "";
    throw error;
  }
}

async function optionalGitHead(root) {
  try {
    return (await git(root, ["rev-parse", "HEAD"])).trim();
  } catch (error) {
    if (isMissingGitHeadError(error)) return "";
    throw error;
  }
}

function worktreeUnavailableCommand(command, reason, options = {}) {
  const now = new Date().toISOString();
  return {
    ...command,
    worktreeUnavailable: true,
    execution: {
      mode: "worktree",
      lifecycleState: "unavailable",
      cleanupState: "unavailable",
      sessionId: command.sessionId,
      baseWorkspaceId: options.baseWorkspace?.id || command.projectId || "",
      desktopAgentId: String(command.desktopAgentId || "").trim(),
      baseCommit: options.baseCommit || "",
      baseBranch: options.baseBranch || "",
      unavailableAt: now,
      errorCode: reason || "unavailable",
      errorSummary: worktreeErrorMessage(reason)
    },
    worktreeUnavailableResult: worktreeFailureResult({
      mode: "worktree",
      lifecycleState: "unavailable",
      cleanupState: "unavailable",
      sessionId: command.sessionId,
      baseWorkspaceId: options.baseWorkspace?.id || command.projectId || "",
      desktopAgentId: String(command.desktopAgentId || "").trim(),
      baseCommit: options.baseCommit || "",
      baseBranch: options.baseBranch || "",
      unavailableAt: now,
      errorCode: reason || "unavailable",
      errorSummary: worktreeErrorMessage(reason)
    }, "worktree.unavailable")
  };
}

function isNotGitRepositoryError(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  return /not a git repository|not a gitdir|not inside a git work tree/i.test(text);
}

function isMissingGitHeadError(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}\n${error?.stdout || ""}`;
  return /ambiguous argument ['"]?HEAD|unknown revision|Needed a single revision|bad revision/i.test(text);
}

async function preflightWorktreeApply(command, execution) {
  const baseWorkspace = publicWorkspaces().find((workspace) => workspace.id === execution.baseWorkspaceId);
  if (!baseWorkspace || execution.baseWorkspaceId !== command.projectId) {
    return applyPreflightFailure("workspace-mismatch", "The worktree does not belong to this workspace.");
  }
  if (execution.desktopAgentId && execution.desktopAgentId !== String(command.desktopAgentId || "").trim()) {
    return applyPreflightFailure("agent-mismatch", "The worktree belongs to a different desktop agent.");
  }
  if (!execution.baseCommit) return applyPreflightFailure("missing-base-commit", "The recorded worktree base commit is missing.");
  if (!execution.baseBranch) return applyPreflightFailure("missing-base-branch", "The recorded base branch is missing.");

  let basePath;
  let worktreePath;
  try {
    basePath = await resolveExistingGitRoot(baseWorkspace.path);
    worktreePath = await resolveExistingGitRoot(execution.path);
  } catch {
    return applyPreflightFailure("missing-ref", "The base workspace or isolated worktree is no longer available.");
  }
  if (comparablePath(basePath) !== comparablePath(execution.basePath)) {
    return applyPreflightFailure("workspace-mismatch", "The recorded base workspace identity no longer matches.");
  }
  if (!isPathInside(comparablePath(worktreePath), comparablePath(config.codex.worktreeRoot))) {
    return applyPreflightFailure("path-outside-managed-root", "The isolated worktree is outside the desktop-managed root.");
  }

  const metadata = await readWorktreeMetadata(execution.baseWorkspaceId, command.sessionId);
  if (
    !metadata ||
    metadata.sessionId !== command.sessionId ||
    metadata.baseWorkspaceId !== execution.baseWorkspaceId ||
    comparablePath(metadata.path) !== comparablePath(worktreePath)
  ) {
    return applyPreflightFailure("ownership-mismatch", "Desktop ownership metadata does not match this worktree.");
  }

  const currentBranch = (await git(basePath, ["branch", "--show-current"]).catch(() => "")).trim();
  if (!currentBranch) return applyPreflightFailure("missing-ref", "The base workspace is detached or its branch is unavailable.");
  if (currentBranch !== execution.baseBranch) {
    return applyPreflightFailure("base-branch-changed", "The base workspace is now on a different branch.");
  }
  const worktreeBranch = (await git(worktreePath, ["branch", "--show-current"]).catch(() => "")).trim();
  if (!worktreeBranch || worktreeBranch !== execution.branchName) {
    return applyPreflightFailure("worktree-branch-changed", "The isolated worktree branch no longer matches its recorded branch.");
  }

  const baseStatus = await git(basePath, ["status", "--porcelain"]);
  if (baseStatus.trim()) return applyPreflightFailure("dirty-base", "The base workspace has uncommitted changes.");
  const currentHead = await optionalGitHead(basePath);
  if (!currentHead) return applyPreflightFailure("missing-ref", "The base workspace HEAD is unavailable.");
  if (currentHead !== execution.baseCommit) {
    const advanced = await gitIsAncestor(basePath, execution.baseCommit, currentHead);
    return applyPreflightFailure(
      advanced ? "base-advanced" : "base-diverged",
      advanced ? "The base branch has advanced since this worktree was created." : "The base branch has diverged from this worktree's recorded base.",
      { baseCommit: shortCommit(execution.baseCommit), currentHead: shortCommit(currentHead) }
    );
  }

  let entries;
  try {
    entries = await worktreeChangeEntries(worktreePath, execution.baseCommit);
    for (const entry of entries) {
      safeRelativePath(entry.path);
      if (entry.oldPath) safeRelativePath(entry.oldPath);
    }
  } catch {
    return applyPreflightFailure("unsafe-change-path", "The worktree change list contains an unsafe path.");
  }
  const changedPaths = uniqueChangedPaths(entries).slice(0, 100);
  return { ok: true, basePath, worktreePath, entries, changedPaths };
}

function applyPreflightFailure(code, message, summary = {}) {
  return { ok: false, code, message, summary };
}

async function gitIsAncestor(cwd, ancestor, descendant) {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function persistBlockedWorktreeApplyResult(execution, failure = {}) {
  const changedPaths = Array.isArray(failure.changedPaths) ? failure.changedPaths.slice(0, 100) : [];
  const nextExecution = withWorktreeState(execution, "apply-blocked", {
    cleanupState: "apply-blocked",
    errorCode: failure.code || "apply-blocked",
    errorSummary: String(failure.message || "The worktree could not be applied.").slice(0, 500),
    conflictSummary: {
      ...(failure.summary || {}),
      changedFileCount: changedPaths.length,
      changedFiles: changedPaths
    }
  });
  await writeWorktreeMetadata(nextExecution);
  return worktreeFailureResult(nextExecution, "worktree.apply-blocked");
}

function worktreeFailureResult(execution, eventType) {
  return {
    ok: true,
    sessionStatus: "active",
    operationSucceeded: false,
    errorCode: execution.errorCode || "worktree-unavailable",
    error: execution.errorSummary || "The worktree operation could not be completed.",
    execution,
    events: [{
      type: eventType,
      text: execution.errorSummary || "The worktree operation could not be completed.",
      raw: {
        source: "desktop-agent",
        method: eventType,
        errorCode: execution.errorCode || "worktree-unavailable",
        conflictSummary: execution.conflictSummary || null,
        worktree: compactWorktreeExecution(execution)
      }
    }]
  };
}

function terminalWorktreeResult(execution, state) {
  return {
    ok: true,
    sessionStatus: "active",
    operationSucceeded: true,
    idempotent: true,
    execution,
    events: []
  };
}

function isAppliedExecution(execution) {
  return Boolean(execution && (execution.lifecycleState === "applied" || execution.cleanupState === "applied" || execution.appliedAt));
}

function isDiscardedExecution(execution) {
  return Boolean(execution && (execution.lifecycleState === "discarded" || execution.cleanupState === "discarded" || execution.discardedAt));
}

function worktreeErrorMessage(code) {
  return {
    "workspace-not-allowed": "The selected workspace is not available on this desktop.",
    "not-git": "Worktree isolation requires a Git workspace.",
    "no-git-commit": "Worktree isolation requires an initial Git commit.",
    "dirty-base": "Worktree isolation requires a clean base workspace.",
    "missing-base-branch": "Worktree isolation requires the base workspace to be on a branch.",
    "create-failed": "Desktop could not create the isolated worktree."
  }[code] || "Worktree isolation is unavailable on this desktop.";
}

function shortCommit(value) {
  return String(value || "").slice(0, 12);
}

function validateWorktreeExecution(command = {}) {
  const execution = command.execution && typeof command.execution === "object" ? command.execution : {};
  if (execution.mode !== "worktree" || !execution.path) {
    throw new Error("This Codex session does not have a desktop-managed worktree.");
  }
  const resolvedPath = comparablePath(execution.path);
  const resolvedRoot = comparablePath(config.codex.worktreeRoot);
  if (!isPathInside(resolvedPath, resolvedRoot)) {
    throw new Error("Codex worktree path is outside the desktop-controlled worktree root.");
  }
  validateWorktreeOwnership(execution, command);
  if (execution.lifecycleState === "discarded" || execution.cleanupState === "discarded" || execution.discardedAt) {
    throw new Error("This Codex session worktree has been discarded.");
  }
  if (execution.lifecycleState === "applied" || execution.cleanupState === "applied" || execution.appliedAt) {
    throw new Error("This Codex session worktree has already been applied.");
  }
  if (execution.lifecycleState === "unavailable") {
    throw new Error("This Codex session worktree is unavailable.");
  }
  return {
    ...execution,
    path: resolvedPath
  };
}

async function resolveExistingGitRoot(candidatePath) {
  const rawPath = String(candidatePath || "").trim();
  if (!rawPath) throw new Error("Git workspace path is required.");
  const resolved = path.resolve(rawPath);
  if (!(await pathExists(resolved))) throw new Error(`Git workspace does not exist: ${rawPath}`);
  return (await git(resolved, ["rev-parse", "--show-toplevel"])).trim();
}

async function worktreeStatusEntries(worktreePath) {
  const output = await git(worktreePath, ["status", "--porcelain=v1", "-z"]);
  const records = output.split("\0");
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (!filePath) continue;
    let oldPath = "";
    if (status.includes("R") || status.includes("C")) {
      oldPath = records[index + 1] || "";
      index += 1;
    }
    entries.push({ status, path: filePath, oldPath });
  }
  return entries;
}

async function worktreeChangeEntries(worktreePath, baseCommit) {
  const committed = await worktreeDiffEntries(worktreePath, baseCommit);
  const uncommitted = await worktreeStatusEntries(worktreePath);
  const byPath = new Map();
  for (const entry of [...committed, ...uncommitted]) byPath.set(`${entry.oldPath || ""}\0${entry.path}`, entry);
  return [...byPath.values()];
}

async function worktreeDiffEntries(worktreePath, baseCommit) {
  const output = await git(worktreePath, ["diff", "--name-status", "-z", baseCommit, "--"]);
  const records = output.split("\0");
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = records[++index] || "";
      const filePath = records[++index] || "";
      if (filePath) entries.push({ status: status[0], path: filePath, oldPath });
      continue;
    }
    const filePath = records[++index] || "";
    if (filePath) entries.push({ status: status[0], path: filePath, oldPath: "" });
  }
  return entries;
}

function uniqueChangedPaths(entries = []) {
  return Array.from(new Set(entries.map((entry) => entry.path).filter(Boolean))).sort();
}

async function applyWorktreeEntry({ basePath, worktreePath, entry }) {
  const targetPath = safeRelativePath(entry.path);
  const sourcePath = path.join(worktreePath, targetPath);
  const destinationPath = path.join(basePath, targetPath);

  if (entry.oldPath) {
    const oldTargetPath = safeRelativePath(entry.oldPath);
    if (oldTargetPath !== targetPath) await fs.rm(path.join(basePath, oldTargetPath), { recursive: true, force: true });
  }

  const sourceStat = await fs.lstat(sourcePath).catch(() => null);
  if (!sourceStat || entry.status.includes("D")) {
    await fs.rm(destinationPath, { recursive: true, force: true });
    return;
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.rm(destinationPath, { recursive: true, force: true }).catch(() => {});
  if (sourceStat.isSymbolicLink()) {
    const linkTarget = await fs.readlink(sourcePath);
    await fs.symlink(linkTarget, destinationPath);
    return;
  }
  if (sourceStat.isDirectory()) {
    await fs.cp(sourcePath, destinationPath, { recursive: true });
    return;
  }
  await fs.copyFile(sourcePath, destinationPath);
  await fs.chmod(destinationPath, sourceStat.mode).catch(() => {});
}

async function backupApplyTargets(basePath, backupRoot, entries) {
  const targets = new Set();
  for (const entry of entries) {
    targets.add(safeRelativePath(entry.path));
    if (entry.oldPath) targets.add(safeRelativePath(entry.oldPath));
  }
  const backups = [];
  let index = 0;
  for (const relativePath of targets) {
    const sourcePath = path.join(basePath, relativePath);
    const stat = await fs.lstat(sourcePath).catch(() => null);
    const backupPath = path.join(backupRoot, String(index++));
    if (stat) await fs.cp(sourcePath, backupPath, { recursive: true, preserveTimestamps: true });
    backups.push({ relativePath, backupPath, existed: Boolean(stat) });
  }
  return backups;
}

async function restoreApplyTargets(basePath, backups) {
  for (const backup of backups) {
    const destinationPath = path.join(basePath, backup.relativePath);
    await fs.rm(destinationPath, { recursive: true, force: true });
    if (!backup.existed) continue;
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.cp(backup.backupPath, destinationPath, { recursive: true, preserveTimestamps: true });
  }
}

function safeRelativePath(value) {
  const relativePath = String(value || "").trim();
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Unsafe worktree file path: ${relativePath || "(empty)"}`);
  }
  return relativePath;
}

function compactWorktreeExecution(execution = {}) {
  const compact = {
    mode: "worktree",
    lifecycleState: execution.lifecycleState || "",
    sessionId: execution.sessionId || "",
    baseWorkspaceId: execution.baseWorkspaceId || "",
    desktopAgentId: execution.desktopAgentId || "",
    worktreeId: execution.worktreeId || opaqueWorktreeId(execution.sessionId),
    branchName: execution.branchName || "",
    baseBranch: execution.baseBranch || "",
    baseCommit: execution.baseCommit || "",
    appliedAt: execution.appliedAt || "",
    discardedAt: execution.discardedAt || "",
    cleanupState: execution.cleanupState || "",
    setupStatus: execution.setupStatus || "",
    setupSummary: boundedSetupOutput(execution.setupSummary || execution.errorSummary),
    warmPoolSource: execution.warmPoolSource || "",
    cleanupStatus: execution.cleanupStatus || "",
    errorCode: execution.errorCode || "",
    errorSummary: execution.errorSummary || "",
    conflictSummary: execution.conflictSummary || null
  };
  if (execution.ownerType === "orchestration") {
    compact.ownerType = "orchestration";
    compact.runId = String(execution.runId || "").slice(0, 160);
    compact.itemId = String(execution.itemId || "").slice(0, 160);
    compact.worktreeKind = execution.worktreeKind === "integration" ? "integration" : "change";
  }
  return compact;
}

async function branchExists(cwd, branchName) {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd, args) {
  const result = await execFileAsync("git", args, {
    cwd,
    timeout: gitTimeoutMs,
    maxBuffer: 1024 * 1024
  });
  return result.stdout;
}

async function writeWorktreeMetadata(execution = {}) {
  const worktreePath = String(execution.path || "").trim();
  if (!worktreePath) return;
  const resolvedPath = comparablePath(worktreePath);
  const root = comparablePath(config.codex.worktreeRoot);
  if (!isPathInside(resolvedPath, root)) return;

  const sessionId = String(execution.sessionId || path.basename(resolvedPath) || "").trim();
  const projectId = sanitizePathSegment(execution.baseWorkspaceId || path.basename(path.dirname(resolvedPath)));
  if (!sessionId || !projectId) return;

  const metadataPath = worktreeMetadataPath(projectId, sessionId);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    metadataPath,
    JSON.stringify(
      {
        mode: "worktree",
        lifecycleState: execution.lifecycleState || "ready",
        sessionId,
        baseWorkspaceId: execution.baseWorkspaceId || "",
        desktopAgentId: execution.desktopAgentId || "",
        worktreeId: execution.worktreeId || opaqueWorktreeId(sessionId),
        path: resolvedPath,
        branchName: execution.branchName || "",
        basePath: execution.basePath || "",
        baseBranch: execution.baseBranch || "",
        baseCommit: execution.baseCommit || "",
        setupProfileId: execution.setupProfileId || "",
        setupKey: execution.setupKey || "",
        setupStatus: execution.setupStatus || "",
        setupStartedAt: execution.setupStartedAt || "",
        setupFinishedAt: execution.setupFinishedAt || "",
        setupSummary: boundedSetupOutput(execution.setupSummary || ""),
        warmPoolSource: execution.warmPoolSource || "",
        cleanupState: execution.cleanupState || "",
        cleanupStatus: execution.cleanupStatus || "",
        retentionExpiresAt: execution.retentionExpiresAt || "",
        appliedAt: execution.appliedAt || "",
        discardedAt: execution.discardedAt || "",
        unavailableAt: execution.unavailableAt || "",
        errorCode: execution.errorCode || "",
        errorSummary: execution.errorSummary || "",
        conflictSummary: execution.conflictSummary || null,
        createdAt: execution.createdAt || now,
        touchedAt: now
      },
      null,
      2
    ),
    "utf8"
  );
}

async function readWorktreeMetadata(projectId, sessionId) {
  try {
    const text = await fs.readFile(worktreeMetadataPath(projectId, sessionId), "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function removeWorktreeMetadata(projectId, sessionId) {
  await fs.rm(worktreeMetadataPath(projectId, sessionId), { force: true }).catch(() => {});
}

function worktreeMetadataPath(projectId, sessionId) {
  return path.join(config.codex.worktreeRoot, ".metadata", sanitizePathSegment(projectId), `${sanitizePathSegment(sessionId)}.json`);
}

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function comparablePath(candidatePath) {
  const resolved = path.resolve(String(candidatePath || ""));
  try {
    return fsSync.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeWorktreeExecution(execution = {}) {
  if (!execution || typeof execution !== "object" || execution.mode !== "worktree" || !execution.path) return null;
  return {
    ...execution,
    lifecycleState: normalizeLifecycleState(execution.lifecycleState || lifecycleStateFromLegacyExecution(execution))
  };
}

function withWorktreeState(execution = {}, lifecycleState, extra = {}) {
  const normalized = normalizeLifecycleState(lifecycleState || execution.lifecycleState || lifecycleStateFromLegacyExecution(execution));
  return {
    ...execution,
    lifecycleState: normalized,
    ...extra
  };
}

function lifecycleStateFromLegacyExecution(execution = {}) {
  if (execution.discardedAt || execution.cleanupState === "discarded") return "discarded";
  if (execution.appliedAt || execution.cleanupState === "applied") return "applied";
  return "ready";
}

function validateWorktreeOwnership(execution = {}, command = {}) {
  const executionSessionId = String(execution.sessionId || "").trim();
  const commandSessionId = String(command.sessionId || "").trim();
  if (executionSessionId && commandSessionId && executionSessionId !== commandSessionId) {
    throw new Error("This Codex session worktree is not owned by the requested session.");
  }
  const executionWorkspaceId = String(execution.baseWorkspaceId || "").trim();
  const commandWorkspaceId = String(command.projectId || "").trim();
  if (executionWorkspaceId && commandWorkspaceId && executionWorkspaceId !== commandWorkspaceId) {
    throw new Error("This Codex session worktree belongs to a different workspace.");
  }
  const executionAgentId = String(execution.desktopAgentId || "").trim();
  const commandAgentId = String(command.desktopAgentId || "").trim();
  if (executionAgentId && commandAgentId && executionAgentId !== commandAgentId) {
    throw new Error("This Codex session worktree belongs to a different desktop agent.");
  }
}

function normalizeLifecycleState(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return [
    "creating",
    "setting-up",
    "ready",
    "running",
    "completed",
    "failed",
    "applied",
    "discarded",
    "cleanup-pending",
    "unavailable",
    "apply-blocked",
    "cleanup-failed"
  ].includes(normalized)
    ? normalized
    : "ready";
}

function shortId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .slice(0, 12) || Date.now().toString(36);
}

function sanitizePathSegment(value) {
  return String(value || "workspace")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workspace";
}
