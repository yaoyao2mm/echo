import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { publicWorkspaces } from "./codexRunner.js";

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 15000;
const cleanupIntervalMs = 6 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;
let nextCleanupAt = 0;

export async function prepareCodexSessionWorktree(command) {
  if (command.execution?.path) {
    await touchCodexSessionWorktree(command);
    return command;
  }
  if (command.type !== "start") return command;
  if (!shouldUseWorktree(command)) return command;

  const baseWorkspace = publicWorkspaces().find((workspace) => workspace.id === command.projectId);
  if (!baseWorkspace) throw new Error(`Project is not allowed on this desktop agent: ${command.projectId}`);

  const basePath = baseWorkspace.path;
  const root = (await git(basePath, ["rev-parse", "--show-toplevel"])).trim();
  const baseCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  const baseBranch = (await git(root, ["branch", "--show-current"]).catch(() => "")).trim();
  const branchName = `echo/job-${shortId(command.sessionId)}`;
  const worktreePath = path.join(config.codex.worktreeRoot, sanitizePathSegment(baseWorkspace.id), command.sessionId);
  const existing = await existingWorktreeExecution(worktreePath, {
    sessionId: command.sessionId,
    baseWorkspace,
    root,
    branchName,
    baseBranch,
    baseCommit
  });
  if (existing) {
    await writeWorktreeMetadata(existing);
    return {
      ...command,
      execution: existing
    };
  }

  const status = await git(root, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(
      `Cannot create an isolated Codex worktree for ${baseWorkspace.label || baseWorkspace.id} because the base workspace has uncommitted changes.`
    );
  }

  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  if (await branchExists(root, branchName)) {
    await git(root, ["worktree", "add", worktreePath, branchName]);
  } else {
    await git(root, ["worktree", "add", "-b", branchName, worktreePath, baseCommit]);
  }
  const createdWorktreeRoot = (await git(worktreePath, ["rev-parse", "--show-toplevel"])).trim();

  const prepared = {
    ...command,
    execution: {
      mode: "worktree",
      sessionId: command.sessionId,
      baseWorkspaceId: baseWorkspace.id,
      basePath: root,
      path: createdWorktreeRoot || worktreePath,
      branchName,
      baseBranch,
      baseCommit,
      createdAt: new Date().toISOString()
    }
  };
  await writeWorktreeMetadata(prepared.execution);
  return prepared;
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

  return {
    mode: "worktree",
    sessionId: metadata.sessionId,
    baseWorkspaceId: metadata.baseWorkspace.id,
    basePath: metadata.root,
    path: worktreeRoot || worktreePath,
    branchName: metadata.branchName,
    baseBranch: metadata.baseBranch,
    baseCommit: metadata.baseCommit,
    createdAt: new Date().toISOString(),
    reused: true
  };
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
    return { checked: 0, removed: 0, skippedDirty: 0, skippedYoung: 0, skippedInvalid: 0 };
  }

  const root = comparablePath(config.codex.worktreeRoot);
  const nowMs = Number(options.nowMs || Date.now());
  const cutoffMs = nowMs - retentionDays * dayMs;
  const result = { checked: 0, removed: 0, skippedDirty: 0, skippedYoung: 0, skippedInvalid: 0 };

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
      await git(removeCwd, ["worktree", "remove", "--force", resolvedPath]).catch(async () => {
        await fs.rm(resolvedPath, { recursive: true, force: true });
        await git(removeCwd, ["worktree", "prune"]).catch(() => "");
      });
      await removeWorktreeMetadata(projectEntry.name, sessionEntry.name);
      result.removed += 1;
    }
  }

  return result;
}

export async function touchCodexSessionWorktree(commandOrExecution) {
  const execution = commandOrExecution?.execution || commandOrExecution;
  if (execution?.mode !== "worktree" || !execution.path) return false;
  await writeWorktreeMetadata(execution);
  return true;
}

export async function applyCodexSessionWorktree(command) {
  const execution = validateWorktreeExecution(command);
  const basePath = await resolveExistingGitRoot(execution.basePath);
  const worktreePath = await resolveExistingGitRoot(execution.path);
  const baseStatus = await git(basePath, ["status", "--porcelain"]);
  if (baseStatus.trim()) {
    throw new Error("Cannot apply this worktree because the base workspace has uncommitted changes.");
  }

  const entries = await worktreeStatusEntries(worktreePath);
  const changedPaths = uniqueChangedPaths(entries);
  for (const entry of entries) {
    await applyWorktreeEntry({ basePath, worktreePath, entry });
  }

  const appliedAt = new Date().toISOString();
  const nextExecution = {
    ...execution,
    appliedAt,
    appliedTo: basePath,
    cleanupState: "applied"
  };
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
  const execution = validateWorktreeExecution(command);
  const resolvedRoot = comparablePath(config.codex.worktreeRoot);
  const resolvedPath = comparablePath(execution.path);
  if (!isPathInside(resolvedPath, resolvedRoot)) {
    throw new Error("Codex worktree discard path is outside the desktop-controlled worktree root.");
  }

  const basePath = execution.basePath && (await pathExists(execution.basePath)) ? execution.basePath : resolvedPath;
  await git(basePath, ["worktree", "remove", "--force", resolvedPath]).catch(async () => {
    await fs.rm(resolvedPath, { recursive: true, force: true });
    await git(basePath, ["worktree", "prune"]).catch(() => "");
  });

  const branchName = String(execution.branchName || "").trim();
  if (branchName && execution.basePath && (await pathExists(execution.basePath))) {
    await git(execution.basePath, ["branch", "-D", branchName]).catch(() => "");
  }
  await removeWorktreeMetadata(
    sanitizePathSegment(execution.baseWorkspaceId || command.projectId || path.basename(path.dirname(resolvedPath))),
    execution.sessionId || command.sessionId || path.basename(resolvedPath)
  );

  const discardedAt = new Date().toISOString();
  const nextExecution = {
    ...execution,
    discardedAt,
    cleanupState: "discarded"
  };

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

function safeRelativePath(value) {
  const relativePath = String(value || "").trim();
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Unsafe worktree file path: ${relativePath || "(empty)"}`);
  }
  return relativePath;
}

function compactWorktreeExecution(execution = {}) {
  return {
    mode: "worktree",
    sessionId: execution.sessionId || "",
    baseWorkspaceId: execution.baseWorkspaceId || "",
    basePath: execution.basePath || "",
    path: execution.path || "",
    branchName: execution.branchName || "",
    baseBranch: execution.baseBranch || "",
    baseCommit: execution.baseCommit || "",
    appliedAt: execution.appliedAt || "",
    discardedAt: execution.discardedAt || "",
    cleanupState: execution.cleanupState || ""
  };
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
        sessionId,
        baseWorkspaceId: execution.baseWorkspaceId || "",
        path: resolvedPath,
        branchName: execution.branchName || "",
        basePath: execution.basePath || "",
        baseBranch: execution.baseBranch || "",
        baseCommit: execution.baseCommit || "",
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
