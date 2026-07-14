import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";

const metadataVersion = 1;
const maxConflictFiles = 80;
const maxSnapshotFiles = 800;
const maxSnapshotBytes = 8 * 1024 * 1024;

export async function prepareOrchestrationChangeWorktree(input = {}) {
  return prepareManagedWorktree({ ...input, kind: "change" });
}

export async function materializeOrchestrationChangeSnapshot(input = {}) {
  const identity = normalizeIdentity({ ...input, kind: "change" });
  const metadata = await readAndAssertMetadata(identity);
  const changeId = normalizeChangeId(input.changeId);
  const fingerprint = bounded(input.fingerprint, 128);
  if (!changeId) throw operationError("A bounded OpenSpec change id is required.", "INVALID_CHANGE_ID");
  if (metadata.changeSnapshot) {
    if (metadata.changeSnapshot.changeId !== changeId || metadata.changeSnapshot.fingerprint !== fingerprint) {
      throw operationError("The existing change snapshot does not match this orchestration Item.", "CHANGE_SNAPSHOT_MISMATCH");
    }
    return publicWorktreeResult(metadata, { ok: true, idempotent: true });
  }
  const status = await git(metadata.path, ["status", "--porcelain"]);
  if (status.trim()) throw operationError("Cannot materialize a change snapshot over Worktree changes.", "WORKTREE_DIRTY");

  const source = await locateOpenSpecChange(identity.workspacePath, changeId);
  const before = await digestDirectory(source.absolutePath);
  const targetPath = path.resolve(metadata.path, source.relativePath);
  assertPathInside(targetPath, metadata.path, "Change snapshot target escapes its Worktree.");
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(source.absolutePath, targetPath, { recursive: true, force: true, errorOnExist: false });
  const [after, copied] = await Promise.all([
    digestDirectory(source.absolutePath),
    digestDirectory(targetPath)
  ]);
  if (before.digest !== after.digest || before.digest !== copied.digest) {
    await fs.rm(targetPath, { recursive: true, force: true });
    throw operationError("OpenSpec change changed while its snapshot was being created.", "CHANGE_SNAPSHOT_CHANGED");
  }

  const next = {
    ...metadata,
    changeSnapshot: {
      changeId,
      relativePath: source.relativePath,
      fingerprint,
      digest: copied.digest,
      fileCount: copied.fileCount,
      totalBytes: copied.totalBytes,
      materializedAt: nowIso()
    },
    updatedAt: nowIso()
  };
  await writeMetadata(identity, next);
  return publicWorktreeResult(next, { ok: true, idempotent: false });
}

export async function prepareOrchestrationIntegrationWorktree(input = {}) {
  const identity = normalizeIdentity({ ...input, kind: "integration", itemId: "integration" });
  await prepareManagedWorktree({ ...input, kind: "integration", itemId: "integration" });
  return synchronizeIntegrationBase(identity);
}

export async function integrateOrchestrationCommit(input = {}) {
  const identity = normalizeIdentity({ ...input, kind: "integration", itemId: "integration" });
  const metadata = await readAndAssertMetadata(identity);
  const commit = normalizeCommit(input.commit);
  const sourceItemId = normalizeSegment(input.sourceItemId || input.itemId, "Item id");
  if (!commit || !sourceItemId) throw operationError("Commit and source Item id are required.", "INVALID_INTEGRATION_INPUT");
  const applied = Array.isArray(metadata.appliedCommits) ? metadata.appliedCommits : [];
  const existing = applied.find((entry) => entry.sourceItemId === sourceItemId);
  if (existing) {
    if (existing.sourceCommit !== commit) throw operationError("Item was already integrated from a different commit.", "INTEGRATION_IDENTITY_MISMATCH");
    return publicWorktreeResult(metadata, { ok: true, idempotent: true, integrationCommit: existing.integrationCommit });
  }
  if (metadata.lifecycleState === "conflict") {
    return publicWorktreeResult(metadata, { ok: false, code: "INTEGRATION_CONFLICT", conflictFiles: metadata.conflictFiles || [] });
  }
  await git(metadata.workspacePath, ["cat-file", "-e", `${commit}^{commit}`]);
  const result = await gitResult(metadata.path, ["cherry-pick", commit]);
  if (!result.ok) {
    const conflictFiles = (await git(metadata.path, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }))
      .split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(0, maxConflictFiles);
    const conflicted = {
      ...metadata,
      lifecycleState: "conflict",
      conflictFiles,
      pendingIntegration: { kind: "item", sourceItemId, sourceCommit: commit },
      updatedAt: nowIso()
    };
    await writeMetadata(identity, conflicted);
    return publicWorktreeResult(conflicted, {
      ok: false,
      code: "INTEGRATION_CONFLICT",
      error: bounded(result.stderr || result.stdout, 1200),
      conflictFiles
    });
  }
  const integrationCommit = (await git(metadata.path, ["rev-parse", "HEAD"])).trim();
  const next = {
    ...metadata,
    lifecycleState: "ready",
    appliedCommits: [...applied, { sourceItemId, sourceCommit: commit, integrationCommit, integratedAt: nowIso() }],
    updatedAt: nowIso()
  };
  await writeMetadata(identity, next);
  return publicWorktreeResult(next, { ok: true, idempotent: false, integrationCommit });
}

export async function completeOrchestrationIntegrationRepair(input = {}) {
  const identity = normalizeIdentity({ ...input, kind: "integration", itemId: "integration" });
  const metadata = await readAndAssertMetadata(identity);
  if (metadata.lifecycleState !== "conflict" || !metadata.pendingIntegration) {
    return publicWorktreeResult(metadata, { ok: true, idempotent: true });
  }
  const unresolved = (await git(metadata.path, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }))
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (unresolved.length) return publicWorktreeResult(metadata, { ok: false, code: "INTEGRATION_CONFLICT", conflictFiles: unresolved.slice(0, maxConflictFiles) });
  const cherryPickHead = await git(metadata.path, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], { allowFailure: true });
  const mergeHead = await git(metadata.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFailure: true });
  if (cherryPickHead) {
    const continued = await gitResult(metadata.path, ["-c", "core.editor=true", "cherry-pick", "--continue"]);
    if (!continued.ok) return publicWorktreeResult(metadata, { ok: false, code: "INTEGRATION_REPAIR_FAILED", error: bounded(continued.stderr, 1200) });
  } else if (mergeHead) {
    const continued = await gitResult(metadata.path, ["-c", "core.editor=true", "merge", "--continue"]);
    if (!continued.ok) return publicWorktreeResult(metadata, { ok: false, code: "INTEGRATION_REPAIR_FAILED", error: bounded(continued.stderr, 1200) });
  }
  const integrationCommit = (await git(metadata.path, ["rev-parse", "HEAD"])).trim();
  const pending = metadata.pendingIntegration;
  const next = {
    ...metadata,
    lifecycleState: "ready",
    conflictFiles: [],
    pendingIntegration: null,
    integratedBaseCommit: pending.kind === "base-sync" ? pending.sourceCommit : metadata.integratedBaseCommit,
    appliedCommits: pending.kind === "base-sync"
      ? (metadata.appliedCommits || [])
      : [
          ...(metadata.appliedCommits || []),
          { ...pending, integrationCommit, integratedAt: nowIso(), repaired: true }
        ],
    updatedAt: nowIso()
  };
  await writeMetadata(identity, next);
  return publicWorktreeResult(next, { ok: true, integrationCommit });
}

export async function applyOrchestrationIntegration(input = {}) {
  const identity = normalizeIdentity({ ...input, kind: "integration", itemId: "integration" });
  const metadata = await readAndAssertMetadata(identity);
  if (metadata.lifecycleState === "conflict") {
    throw operationError("Integration Worktree has unresolved conflicts.", "INTEGRATION_CONFLICT");
  }
  if (metadata.lifecycleState === "applied") {
    return publicWorktreeResult(metadata, { ok: true, idempotent: true, commit: metadata.appliedCommit });
  }
  const [branch, head, integrationCommit] = await Promise.all([
    git(metadata.workspacePath, ["branch", "--show-current"]),
    git(metadata.workspacePath, ["rev-parse", "HEAD"]),
    git(metadata.path, ["rev-parse", "HEAD"])
  ]);
  if (branch !== identity.baseBranch) {
    throw operationError("Base Workspace is no longer on the orchestration branch.", "BASE_BRANCH_CHANGED");
  }
  const expectedBaseCommit = metadata.integratedBaseCommit || identity.baseCommit;
  if (head !== expectedBaseCommit) {
    throw operationError("Base Workspace advanced after orchestration started.", "BASE_COMMIT_CHANGED");
  }
  const backups = await stageBaseSnapshotBackups(identity, metadata);
  const merged = await gitResult(metadata.workspacePath, ["merge", "--ff-only", integrationCommit]);
  if (!merged.ok) {
    await restoreBaseSnapshotBackups(backups);
    throw operationError(bounded(merged.stderr || merged.stdout, 1200), "INTEGRATION_APPLY_FAILED");
  }
  await discardBaseSnapshotBackups(backups);
  const next = {
    ...metadata,
    lifecycleState: "applied",
    appliedCommit: integrationCommit,
    appliedAt: nowIso(),
    updatedAt: nowIso()
  };
  await writeMetadata(identity, next);
  return publicWorktreeResult(next, { ok: true, idempotent: false, commit: integrationCommit });
}

export async function cleanupOrchestrationWorktree(input = {}) {
  const identity = normalizeIdentity(input);
  const metadata = await readMetadata(identity);
  if (!metadata) return { ok: true, idempotent: true, lifecycleState: "cleaned" };
  assertMetadataIdentity(metadata, identity);
  if (input.activeAttempt === true) throw operationError("Cannot clean an orchestration Worktree with an active Attempt.", "ACTIVE_ATTEMPT");
  const targetPath = assertManagedPath(metadata.path, identity.managedRoot);
  if (metadata.lifecycleState === "cleaned" || !(await exists(targetPath))) {
    const cleaned = { ...metadata, lifecycleState: "cleaned", cleanedAt: metadata.cleanedAt || nowIso(), updatedAt: nowIso() };
    await writeMetadata(identity, cleaned);
    return publicWorktreeResult(cleaned, { ok: true, idempotent: true });
  }
  const status = await git(targetPath, ["status", "--porcelain"], { allowFailure: true });
  if (status.trim()) throw operationError("Orchestration Worktree has uncommitted changes and was preserved.", "WORKTREE_DIRTY");
  const removed = await gitResult(metadata.workspacePath, ["worktree", "remove", targetPath]);
  if (!removed.ok) throw operationError(bounded(removed.stderr || removed.stdout, 1200), "WORKTREE_REMOVE_FAILED");
  const cleaned = { ...metadata, lifecycleState: "cleaned", cleanedAt: nowIso(), updatedAt: nowIso() };
  await writeMetadata(identity, cleaned);
  return publicWorktreeResult(cleaned, { ok: true, idempotent: false });
}

export async function readOrchestrationWorktree(input = {}) {
  const identity = normalizeIdentity(input);
  const metadata = await readMetadata(identity);
  if (!metadata) return null;
  assertMetadataIdentity(metadata, identity);
  return publicWorktreeResult(metadata, { ok: true });
}

export async function finalizeOrchestrationChangeWorktree(input = {}) {
  const identity = normalizeIdentity({ ...input, kind: "change" });
  const metadata = await readAndAssertMetadata(identity);
  if (metadata.lifecycleState === "conflict") throw operationError("Change Worktree has unresolved conflicts.", "WORKTREE_CONFLICT");
  const statusBefore = await git(metadata.path, ["status", "--porcelain"]);
  if (statusBefore.trim()) {
    await git(metadata.path, ["add", "--all"]);
    const committed = await gitResult(metadata.path, ["commit", "-m", bounded(input.message || `Apply OpenSpec change ${identity.itemId}`, 240)]);
    if (!committed.ok) throw operationError(bounded(committed.stderr || committed.stdout, 1200), "WORKTREE_COMMIT_FAILED");
  }
  const commit = (await git(metadata.path, ["rev-parse", "HEAD"])).trim();
  if (commit === identity.baseCommit) {
    throw operationError(
      "Change Worktree has no committed result. The change may already be implemented or require manual verification.",
      "WORKTREE_NO_CHANGES"
    );
  }
  const changedFiles = (await git(metadata.path, ["diff", "--name-only", `${identity.baseCommit}..${commit}`]))
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(0, 200);
  const stat = bounded(await git(metadata.path, ["diff", "--stat", `${identity.baseCommit}..${commit}`]), 8_000);
  const next = { ...metadata, lifecycleState: "completed", finalCommit: commit, updatedAt: nowIso() };
  await writeMetadata(identity, next);
  return publicWorktreeResult(next, { ok: true, commit, changedFiles, stat });
}

export async function prepareOrchestrationWorktreeDependencies(input = {}) {
  const identity = normalizeIdentity(input);
  const metadata = await readAndAssertMetadata(identity);
  const lockfiles = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];
  const available = [];
  for (const name of lockfiles) if (await exists(path.join(metadata.path, name))) available.push(name);
  if (!available.length) return publicWorktreeResult(metadata, { ok: true, setupStatus: "skipped", setupSummary: "No supported lockfile." });
  const lockfile = available[0];
  const command = lockfile === "pnpm-lock.yaml"
    ? ["pnpm", ["install", "--frozen-lockfile"]]
    : lockfile === "package-lock.json"
      ? ["npm", ["ci"]]
      : ["yarn", ["install", "--frozen-lockfile"]];
  const setupKey = shortHash(`${lockfile}:${(await fs.stat(path.join(metadata.path, lockfile))).mtimeMs}`);
  if (metadata.setupStatus === "succeeded" && metadata.setupKey === setupKey) {
    return publicWorktreeResult(metadata, { ok: true, setupStatus: "succeeded", setupSummary: "Dependencies are current." });
  }
  const result = await processResult(command[0], command[1], metadata.path);
  const next = {
    ...metadata,
    setupStatus: result.ok ? "succeeded" : "failed",
    setupKey,
    setupSummary: bounded(result.output, 8_000),
    updatedAt: nowIso()
  };
  await writeMetadata(identity, next);
  return publicWorktreeResult(next, { ok: result.ok, setupStatus: next.setupStatus, setupSummary: next.setupSummary });
}

async function synchronizeIntegrationBase(identity) {
  const metadata = await readAndAssertMetadata(identity);
  if (["conflict", "applied"].includes(metadata.lifecycleState)) return publicWorktreeResult(metadata, { ok: metadata.lifecycleState !== "conflict", idempotent: true });
  const [branch, head] = await Promise.all([
    git(metadata.workspacePath, ["branch", "--show-current"]),
    git(metadata.workspacePath, ["rev-parse", "HEAD"])
  ]);
  if (branch !== identity.baseBranch) throw operationError("Base Workspace is no longer on the orchestration branch.", "BASE_BRANCH_CHANGED");
  const integratedBaseCommit = metadata.integratedBaseCommit || identity.baseCommit;
  if (head === integratedBaseCommit) return publicWorktreeResult(metadata, { ok: true, idempotent: true });
  const advanced = await gitResult(metadata.workspacePath, ["merge-base", "--is-ancestor", integratedBaseCommit, head]);
  if (!advanced.ok) throw operationError("Base Workspace diverged from the orchestration base.", "BASE_COMMIT_DIVERGED");
  const result = await gitResult(metadata.path, ["merge", "--no-edit", head]);
  if (!result.ok) {
    const conflictFiles = (await git(metadata.path, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true }))
      .split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(0, maxConflictFiles);
    const conflicted = {
      ...metadata,
      lifecycleState: "conflict",
      conflictFiles,
      pendingIntegration: { kind: "base-sync", sourceCommit: head },
      updatedAt: nowIso()
    };
    await writeMetadata(identity, conflicted);
    return publicWorktreeResult(conflicted, {
      ok: false,
      code: "INTEGRATION_CONFLICT",
      error: bounded(result.stderr || result.stdout, 1200),
      conflictFiles
    });
  }
  const next = {
    ...metadata,
    lifecycleState: "ready",
    integratedBaseCommit: head,
    conflictFiles: [],
    pendingIntegration: null,
    updatedAt: nowIso()
  };
  await writeMetadata(identity, next);
  return publicWorktreeResult(next, { ok: true, idempotent: false });
}

async function prepareManagedWorktree(input) {
  const identity = normalizeIdentity(input);
  const existing = await readMetadata(identity);
  if (existing) {
    assertMetadataIdentity(existing, identity);
    if (existing.lifecycleState === "cleaned") throw operationError("Cleaned orchestration Worktrees cannot be silently recreated.", "WORKTREE_CLEANED");
    if (!(await exists(existing.path))) throw operationError("Orchestration Worktree metadata exists but its path is missing.", "WORKTREE_MISSING");
    return publicWorktreeResult(existing, { ok: true, idempotent: true });
  }
  await assertWorkspace(identity.workspacePath);
  await git(identity.workspacePath, ["cat-file", "-e", `${identity.baseCommit}^{commit}`]);
  const worktreePath = managedWorktreePath(identity);
  assertManagedPath(worktreePath, identity.managedRoot);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true, mode: 0o700 });
  const branchName = branchFor(identity);
  const result = await gitResult(identity.workspacePath, ["worktree", "add", "-b", branchName, worktreePath, identity.baseCommit]);
  if (!result.ok) throw operationError(bounded(result.stderr || result.stdout, 1200), "WORKTREE_CREATE_FAILED");
  const metadata = {
    version: metadataVersion,
    kind: identity.kind,
    desktopAgentId: identity.desktopAgentId,
    projectId: identity.projectId,
    runId: identity.runId,
    itemId: identity.itemId,
    workspacePath: identity.workspacePath,
    path: worktreePath,
    branchName,
    baseBranch: identity.baseBranch,
    baseCommit: identity.baseCommit,
    lifecycleState: "ready",
    integratedBaseCommit: identity.baseCommit,
    appliedCommits: [],
    conflictFiles: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  await writeMetadata(identity, metadata);
  return publicWorktreeResult(metadata, { ok: true, idempotent: false });
}

function normalizeIdentity(input = {}) {
  const kind = input.kind === "integration" ? "integration" : "change";
  const desktopAgentId = normalizeSegment(input.desktopAgentId, "Desktop agent id");
  const projectId = normalizeSegment(input.projectId, "Workspace id");
  const runId = normalizeSegment(input.runId, "Run id");
  const itemId = normalizeSegment(kind === "integration" ? "integration" : input.itemId, "Item id");
  const workspacePath = path.resolve(String(input.workspacePath || ""));
  const managedRoot = path.resolve(input.managedRoot || config.codex.worktreeRoot);
  const baseBranch = bounded(input.baseBranch, 240);
  const baseCommit = normalizeCommit(input.baseCommit);
  if (!desktopAgentId || !projectId || !runId || !itemId || !input.workspacePath || !baseBranch || !baseCommit) {
    throw operationError("Complete orchestration Worktree identity is required.", "INVALID_WORKTREE_IDENTITY");
  }
  return { kind, desktopAgentId, projectId, runId, itemId, workspacePath, managedRoot, baseBranch, baseCommit };
}

function assertMetadataIdentity(metadata, identity) {
  for (const key of ["kind", "desktopAgentId", "projectId", "runId", "itemId", "workspacePath", "baseBranch", "baseCommit"]) {
    if (metadata[key] !== identity[key]) throw operationError(`Orchestration Worktree ${key} does not match owner metadata.`, "WORKTREE_IDENTITY_MISMATCH");
  }
  assertManagedPath(metadata.path, identity.managedRoot);
}

async function readAndAssertMetadata(identity) {
  const metadata = await readMetadata(identity);
  if (!metadata) throw operationError("Orchestration Worktree metadata was not found.", "WORKTREE_NOT_FOUND");
  assertMetadataIdentity(metadata, identity);
  if (metadata.lifecycleState === "cleaned") throw operationError("Orchestration Worktree was cleaned.", "WORKTREE_CLEANED");
  return metadata;
}

async function readMetadata(identity) {
  try { return JSON.parse(await fs.readFile(metadataPath(identity), "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeMetadata(identity, metadata) {
  const filePath = metadataPath(identity);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(metadata, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function metadataPath(identity) {
  return path.join(identity.managedRoot, ".orchestration", identity.projectId, identity.runId, `${identity.itemId}.json`);
}

function managedWorktreePath(identity) {
  return path.join(identity.managedRoot, "orchestration", identity.projectId, identity.runId, identity.kind === "integration" ? "integration" : identity.itemId);
}

function branchFor(identity) {
  const suffix = shortHash(`${identity.desktopAgentId}:${identity.projectId}:${identity.runId}:${identity.itemId}`);
  return identity.kind === "integration"
    ? `echo/orchestration-${sanitizeBranch(identity.runId)}-${suffix}`
    : `echo/orchestration-${sanitizeBranch(identity.runId)}-${sanitizeBranch(identity.itemId)}-${suffix}`;
}

async function assertWorkspace(workspacePath) {
  const root = await fs.realpath(path.resolve((await git(workspacePath, ["rev-parse", "--show-toplevel"])).trim()));
  const requested = await fs.realpath(workspacePath);
  if (root !== requested) throw operationError("Workspace path must be the Git root.", "WORKSPACE_IDENTITY_MISMATCH");
}

function assertManagedPath(candidate, managedRoot) {
  const resolved = path.resolve(candidate);
  const root = path.resolve(managedRoot);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw operationError("Orchestration Worktree path escapes the managed root.", "WORKTREE_PATH_ESCAPE");
  }
  return resolved;
}

async function git(cwd, args, options = {}) {
  const result = await gitResult(cwd, args);
  if (!result.ok && !options.allowFailure) throw operationError(bounded(result.stderr || result.stdout, 1200), "GIT_FAILED");
  return result.stdout.trim();
}

function gitResult(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

function processResult(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.slice(-8_000).trim() }));
  });
}

function publicWorktreeResult(metadata, extra = {}) {
  return {
    kind: metadata.kind,
    projectId: metadata.projectId,
    runId: metadata.runId,
    itemId: metadata.itemId,
    path: metadata.path,
    branchName: metadata.branchName,
    baseBranch: metadata.baseBranch,
    baseCommit: metadata.baseCommit,
    integratedBaseCommit: metadata.integratedBaseCommit || metadata.baseCommit,
    lifecycleState: metadata.lifecycleState,
    appliedCommits: (metadata.appliedCommits || []).map((entry) => ({ ...entry })),
    conflictFiles: (metadata.conflictFiles || []).slice(0, maxConflictFiles),
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    cleanedAt: metadata.cleanedAt || "",
    setupStatus: metadata.setupStatus || "",
    setupSummary: bounded(metadata.setupSummary, 8_000),
    changeSnapshot: metadata.changeSnapshot ? { ...metadata.changeSnapshot } : null,
    ...extra
  };
}

function normalizeSegment(value, label) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  if (!normalized) throw operationError(`${label} is required.`, "INVALID_WORKTREE_IDENTITY");
  return normalized;
}
function normalizeCommit(value) {
  const commit = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(commit) ? commit : "";
}
function normalizeChangeId(value) {
  const changeId = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(changeId) ? changeId : "";
}
function sanitizeBranch(value) { return String(value || "run").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 40) || "run"; }
function shortHash(value) { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 10); }
function bounded(value, max) { return String(value || "").trim().slice(0, max); }
function nowIso() { return new Date().toISOString(); }
async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
function operationError(message, code) { const error = new Error(message || code); error.code = code; return error; }

async function locateOpenSpecChange(workspacePath, changeId) {
  const candidates = [".OpenSpec", "openspec", ".openspec", "OpenSpec"];
  const workspaceRealPath = await fs.realpath(workspacePath);
  for (const root of candidates) {
    const absolutePath = path.join(workspacePath, root, "changes", changeId);
    const stats = await fs.lstat(absolutePath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!stats) continue;
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw operationError("OpenSpec change must be a real directory inside the Workspace.", "INVALID_CHANGE_PATH");
    }
    const realPath = await fs.realpath(absolutePath);
    assertPathInside(realPath, workspaceRealPath, "OpenSpec change resolves outside the Workspace.");
    return { absolutePath, relativePath: path.posix.join(root, "changes", changeId) };
  }
  throw operationError(`OpenSpec change was not found: ${changeId}.`, "CHANGE_NOT_FOUND");
}

async function digestDirectory(rootPath) {
  const hash = crypto.createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;
  async function visit(currentPath, relativePath = "") {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const nextRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const nextPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) throw operationError("OpenSpec change snapshots cannot contain symlinks.", "INVALID_CHANGE_SNAPSHOT");
      if (entry.isDirectory()) {
        hash.update(`d\0${nextRelative}\0`);
        await visit(nextPath, nextRelative);
        continue;
      }
      if (!entry.isFile()) throw operationError("OpenSpec change snapshots can contain only files and directories.", "INVALID_CHANGE_SNAPSHOT");
      const content = await fs.readFile(nextPath);
      fileCount += 1;
      totalBytes += content.length;
      if (fileCount > maxSnapshotFiles || totalBytes > maxSnapshotBytes) {
        throw operationError("OpenSpec change snapshot exceeds the bounded file or byte limit.", "CHANGE_SNAPSHOT_TOO_LARGE");
      }
      hash.update(`f\0${nextRelative}\0${content.length}\0`);
      hash.update(content);
    }
  }
  await visit(rootPath);
  return { digest: hash.digest("hex"), fileCount, totalBytes };
}

async function stageBaseSnapshotBackups(identity, integrationMetadata) {
  const backups = [];
  const sourceItems = integrationMetadata.appliedCommits || [];
  try {
    for (const entry of sourceItems) {
      const itemIdentity = normalizeIdentity({ ...identity, kind: "change", itemId: entry.sourceItemId });
      const itemMetadata = await readMetadata(itemIdentity);
      const snapshot = itemMetadata?.changeSnapshot;
      if (!snapshot) continue;
      const targetPath = path.resolve(identity.workspacePath, snapshot.relativePath);
      assertPathInside(targetPath, identity.workspacePath, "Change snapshot path escapes the base Workspace.");
      if (!(await exists(targetPath))) {
        throw operationError(`Snapshotted change disappeared from the base Workspace: ${snapshot.changeId}.`, "BASE_CHANGE_SNAPSHOT_CHANGED");
      }
      const current = await digestDirectory(targetPath);
      if (current.digest !== snapshot.digest) {
        throw operationError(`Snapshotted change changed after orchestration started: ${snapshot.changeId}.`, "BASE_CHANGE_SNAPSHOT_CHANGED");
      }
      const backupPath = path.join(identity.managedRoot, ".orchestration-backups", identity.projectId, identity.runId, `${entry.sourceItemId}-${crypto.randomUUID()}`);
      assertManagedPath(backupPath, identity.managedRoot);
      await fs.mkdir(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      await fs.rename(targetPath, backupPath);
      backups.push({ targetPath, backupPath });
      const tracked = await git(identity.workspacePath, ["ls-files", "--", snapshot.relativePath]);
      if (tracked) await git(identity.workspacePath, ["restore", "--source=HEAD", "--worktree", "--", snapshot.relativePath]);
    }
  } catch (error) {
    await restoreBaseSnapshotBackups(backups);
    throw error;
  }
  return backups;
}

async function restoreBaseSnapshotBackups(backups) {
  for (const backup of [...backups].reverse()) {
    await fs.rm(backup.targetPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(backup.targetPath), { recursive: true });
    await fs.rename(backup.backupPath, backup.targetPath);
  }
}

async function discardBaseSnapshotBackups(backups) {
  for (const backup of backups) await fs.rm(backup.backupPath, { recursive: true, force: true });
}

function assertPathInside(candidate, root, message) {
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw operationError(message, "PATH_ESCAPE");
  }
  return resolved;
}

export const orchestrationWorktreeLimits = Object.freeze({ maxConflictFiles });
