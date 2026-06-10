import fs from "node:fs/promises";
import path from "node:path";

const openSpecDirectoryCandidates = [".OpenSpec", "openspec", ".openspec", "OpenSpec"];
const defaultMaxChanges = 80;
const defaultMaxSpecs = 120;
const defaultMaxTasksBytes = 96 * 1024;
const defaultMaxProposalBytes = 72 * 1024;
const defaultMaxDesignBytes = 32 * 1024;
const defaultMaxSpecBytes = 40 * 1024;
const excerptLength = 420;

export async function summarizeOpenSpecWorkspace({ projectId, workspaces = [], limits = {} } = {}) {
  const workspace = workspaceForProject(projectId, workspaces);
  const workspacePath = path.resolve(workspace.path);
  const workspaceRealPath = await realpathOrPublicError(workspacePath, "Workspace was not found.", "WORKSPACE_NOT_FOUND");
  const warnings = [];
  const detected = await detectOpenSpecDirectory({ workspacePath, workspaceRealPath, warnings });
  const generatedAt = new Date().toISOString();

  if (!detected) {
    return {
      ok: true,
      openSpec: emptyOpenSpecSummary({
        workspace,
        generatedAt,
        warnings
      })
    };
  }

  const changes = await summarizeChanges({ root: detected, limits, warnings });
  const specs = await summarizeSpecs({ root: detected, changes, limits, warnings });
  const overview = buildOverview({ changes, specs, truncated: changes.truncated || specs.truncated });

  return {
    ok: true,
    openSpec: {
      projectId: workspace.id,
      workspace: publicWorkspace(workspace),
      available: true,
      directoryName: detected.name,
      directoryPath: detected.relativePath,
      generatedAt,
      overview,
      changes: changes.items,
      specs: specs.items,
      warnings
    }
  };
}

export function parseOpenSpecTasks(markdown = "") {
  const groups = [];
  let currentHeading = "Tasks";
  let currentGroup = null;
  let completed = 0;
  let total = 0;

  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const headingMatch = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      currentHeading = cleanMarkdownInline(headingMatch[1]);
      currentGroup = null;
      continue;
    }

    const taskMatch = rawLine.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!taskMatch) continue;

    if (!currentGroup) {
      currentGroup = { title: currentHeading, tasks: [] };
      groups.push(currentGroup);
    }

    const checked = taskMatch[1].toLowerCase() === "x";
    const text = cleanMarkdownInline(taskMatch[2]);
    currentGroup.tasks.push({ text, checked });
    total += 1;
    if (checked) completed += 1;
  }

  return {
    groups,
    completed,
    total,
    percent: total > 0 ? Math.round((completed / total) * 100) : null
  };
}

export function parseOpenSpecProposal(markdown = "", fallbackTitle = "") {
  const text = String(markdown || "");
  const title = firstDocumentTitle(text) || titleFromChangeId(fallbackTitle);
  const why = sectionExcerpt(text, "Why");
  const what = sectionBullets(text, "What Changes", 4);
  const capabilities = affectedSpecsFromText(text);
  const excerpt = why || what.join(" ") || firstParagraph(text) || "";

  return {
    title,
    why,
    whatChanges: what,
    affectedSpecs: capabilities,
    excerpt: clampText(excerpt, excerptLength)
  };
}

async function detectOpenSpecDirectory({ workspacePath, workspaceRealPath, warnings }) {
  for (const name of openSpecDirectoryCandidates) {
    const absolutePath = path.join(workspacePath, name);
    let stats = null;
    let realPath = "";
    try {
      stats = await fs.stat(absolutePath);
      realPath = await fs.realpath(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      warnings.push(`Could not inspect ${name}: ${error.message}`);
      continue;
    }

    if (!isPathInsideOrSame(realPath, workspaceRealPath)) {
      warnings.push(`Ignored ${name} because it resolves outside the workspace.`);
      continue;
    }
    if (!stats.isDirectory()) continue;

    return {
      name,
      absolutePath,
      realPath,
      relativePath: name
    };
  }
  return null;
}

async function summarizeChanges({ root, limits, warnings }) {
  const changesPath = path.join(root.absolutePath, "changes");
  const maxChanges = clampNumber(limits.maxChanges, defaultMaxChanges, 1, 200);
  const dirents = await readDirectory(changesPath, warnings, root.realPath);
  const activeChangeDirs = dirents
    .filter((dirent) => dirent.isDirectory() && isActiveChangeDirectoryName(dirent.name))
    .sort(compareDirentNames);
  const archiveDirs = dirents
    .filter((dirent) => dirent.isDirectory() && isArchiveDirectoryName(dirent.name))
    .sort(compareDirentNames);
  const archivedChangeEntries = [];

  for (const archiveDir of archiveDirs) {
    const archivePath = path.join(changesPath, archiveDir.name);
    const archivedDirents = await readDirectory(archivePath, warnings, root.realPath);
    const archivedChangeDirs = archivedDirents
      .filter((dirent) => dirent.isDirectory() && isChangeDirectoryName(dirent.name))
      .sort(compareArchiveDirentNames);
    for (const dirent of archivedChangeDirs) {
      archivedChangeEntries.push({
        archived: true,
        archiveId: dirent.name,
        archivedAt: archivedAtFromDirectoryName(dirent.name),
        changeId: changeIdFromArchiveDirectoryName(dirent.name),
        changePath: path.join(archivePath, dirent.name),
        relativePath: path.posix.join(root.relativePath, "changes", archiveDir.name, dirent.name)
      });
    }
  }

  const changeEntries = [
    ...activeChangeDirs.map((dirent) => ({
      archived: false,
      archiveId: "",
      archivedAt: "",
      changeId: dirent.name,
      changePath: path.join(changesPath, dirent.name),
      relativePath: path.posix.join(root.relativePath, "changes", dirent.name)
    })),
    ...archivedChangeEntries
  ];
  const visible = changeEntries.slice(0, maxChanges);
  const items = [];
  const specItems = [];
  let specsTruncated = false;

  for (const entry of visible) {
    const item = await summarizeChange({
      root,
      changeId: entry.changeId,
      changePath: entry.changePath,
      relativePath: entry.relativePath,
      archived: entry.archived,
      archiveId: entry.archiveId,
      archivedAt: entry.archivedAt,
      limits,
      warnings
    });
    if (item) {
      const { specs = [], specsTruncated: itemSpecsTruncated = false, ...publicItem } = item;
      items.push(publicItem);
      specItems.push(...specs);
      specsTruncated = specsTruncated || itemSpecsTruncated;
    }
  }

  items.sort(compareChanges);
  return {
    items,
    specItems,
    specsTruncated,
    truncated: changeEntries.length > visible.length,
    totalEntries: changeEntries.length
  };
}

async function summarizeChange({ root, changeId, changePath, relativePath, archived = false, archiveId = "", archivedAt = "", limits, warnings }) {
  const publicPath = relativePath || path.posix.join(root.relativePath, "changes", changeId);
  const safe = await realpathInside(changePath, root.realPath);
  if (!safe.ok) {
    warnings.push(`Ignored change ${changeId} because it resolves outside the OpenSpec directory.`);
    return null;
  }

  const [tasksFile, proposalFile, designFile, configFile, dirStats] = await Promise.all([
    readKnownTextFile(path.join(changePath, "tasks.md"), defaultMaxTasksBytes, limits.maxTasksBytes, root.realPath),
    readKnownTextFile(path.join(changePath, "proposal.md"), defaultMaxProposalBytes, limits.maxProposalBytes, root.realPath),
    readKnownTextFile(path.join(changePath, "design.md"), defaultMaxDesignBytes, limits.maxDesignBytes, root.realPath),
    readKnownTextFile(path.join(changePath, ".openspec.yaml"), 8 * 1024, limits.maxConfigBytes, root.realPath),
    fs.stat(changePath).catch(() => null)
  ]);

  const changeSpecs = await summarizeSpecDirectory({
    specsPath: path.join(changePath, "specs"),
    relativeSpecsPath: path.posix.join(publicPath, "specs"),
    limits,
    warnings,
    rootRealPath: root.realPath
  });
  const taskSummary = parseOpenSpecTasks(tasksFile.content);
  const proposal = parseOpenSpecProposal(proposalFile.content, changeId);
  const designExcerpt = designFile.exists ? sectionExcerpt(designFile.content, "Context") || firstParagraph(designFile.content) : "";
  const affectedSpecs = uniqueStrings([
    ...proposal.affectedSpecs,
    ...affectedSpecsFromText(designFile.content),
    ...affectedSpecsFromText(configFile.content),
    ...changeSpecs.items.map((item) => item.id)
  ]).slice(0, 12);
  const mtimes = [tasksFile.mtime, proposalFile.mtime, designFile.mtime, configFile.mtime, dirStats?.mtime?.toISOString?.()].filter(Boolean);
  const updatedAt = latestIso(mtimes) || "";
  const status = archived ? "archived" : changeStatus(taskSummary);

  return {
    id: changeId,
    title: proposal.title || titleFromChangeId(changeId),
    path: publicPath,
    status,
    archived: Boolean(archived),
    archiveId: String(archiveId || ""),
    archivedAt: String(archivedAt || ""),
    updatedAt,
    progress: {
      completedTasks: taskSummary.completed,
      totalTasks: taskSummary.total,
      percent: taskSummary.percent
    },
    tasks: {
      groups: taskSummary.groups,
      truncated: tasksFile.truncated
    },
    proposal: {
      why: proposal.why,
      whatChanges: proposal.whatChanges,
      excerpt: proposal.excerpt,
      truncated: proposalFile.truncated,
      path: proposalFile.exists ? path.posix.join(publicPath, "proposal.md") : ""
    },
    design: {
      excerpt: clampText(designExcerpt, excerptLength),
      truncated: designFile.truncated,
      path: designFile.exists ? path.posix.join(publicPath, "design.md") : ""
    },
    affectedSpecs,
    specs: changeSpecs.items,
    specsTruncated: changeSpecs.truncated,
    hasDesign: designFile.exists,
    hasProposal: proposalFile.exists,
    hasTasks: tasksFile.exists
  };
}

async function summarizeSpecs({ root, changes, limits, warnings }) {
  const maxSpecs = clampNumber(limits.maxSpecs, defaultMaxSpecs, 1, 240);
  const rootSpecs = await summarizeSpecDirectory({
    specsPath: path.join(root.absolutePath, "specs"),
    relativeSpecsPath: path.posix.join(root.relativePath, "specs"),
    limits,
    warnings,
    rootRealPath: root.realPath
  });
  const merged = mergeSpecItems([...rootSpecs.items, ...(changes.specItems || [])]);
  const visible = merged.slice(0, maxSpecs);

  return {
    items: visible,
    truncated: rootSpecs.truncated || changes.specsTruncated || merged.length > visible.length,
    totalEntries: merged.length
  };
}

async function summarizeSpecDirectory({ specsPath, relativeSpecsPath, limits, warnings, rootRealPath }) {
  const maxSpecs = clampNumber(limits.maxSpecs, defaultMaxSpecs, 1, 240);
  const dirents = await readDirectory(specsPath, warnings, rootRealPath);
  const specDirs = dirents
    .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" }));
  const visible = specDirs.slice(0, maxSpecs);
  const items = [];

  for (const dirent of visible) {
    const specPath = path.join(specsPath, dirent.name);
    const safe = await realpathInside(specPath, rootRealPath);
    if (!safe.ok) {
      warnings.push(`Ignored spec ${dirent.name} because it resolves outside the OpenSpec directory.`);
      continue;
    }
    const file = await readKnownTextFile(path.join(specPath, "spec.md"), defaultMaxSpecBytes, limits.maxSpecBytes, rootRealPath);
    items.push({
      id: dirent.name,
      title: firstHeading(file.content) || titleFromChangeId(dirent.name),
      path: path.posix.join(relativeSpecsPath, dirent.name, "spec.md"),
      updatedAt: file.mtime,
      requirementCount: countRequirements(file.content),
      truncated: file.truncated
    });
  }

  return {
    items,
    truncated: specDirs.length > visible.length,
    totalEntries: specDirs.length
  };
}

function isActiveChangeDirectoryName(name = "") {
  const value = String(name || "").trim();
  return isChangeDirectoryName(value) && !isArchiveDirectoryName(value);
}

function isChangeDirectoryName(name = "") {
  const value = String(name || "").trim();
  return Boolean(value) && !value.startsWith(".");
}

function isArchiveDirectoryName(name = "") {
  return String(name || "").trim().toLowerCase() === "archive";
}

function changeIdFromArchiveDirectoryName(name = "") {
  const value = String(name || "").trim();
  const match = value.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  return match?.[1] || value;
}

function archivedAtFromDirectoryName(name = "") {
  const match = String(name || "").trim().match(/^(\d{4}-\d{2}-\d{2})-/);
  return match ? `${match[1]}T00:00:00.000Z` : "";
}

function compareDirentNames(left, right) {
  return left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" });
}

function compareArchiveDirentNames(left, right) {
  return right.name.localeCompare(left.name, "en", { numeric: true, sensitivity: "base" });
}

function mergeSpecItems(items = []) {
  const merged = new Map();
  for (const item of items) {
    const id = String(item?.id || "").trim();
    if (!id) continue;
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, { ...item, id });
      continue;
    }
    existing.updatedAt = latestIso([existing.updatedAt, item.updatedAt]);
    existing.requirementCount = Math.max(Number(existing.requirementCount || 0), Number(item.requirementCount || 0));
    existing.truncated = Boolean(existing.truncated || item.truncated);
    if (!existing.path && item.path) existing.path = item.path;
    if (!existing.title && item.title) existing.title = item.title;
  }
  return Array.from(merged.values()).sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true, sensitivity: "base" }));
}

function buildOverview({ changes, specs, truncated }) {
  const activeChanges = changes.items.filter((change) => !change.archived);
  const totalTasks = activeChanges.reduce((sum, change) => sum + change.progress.totalTasks, 0);
  const completedTasks = activeChanges.reduce((sum, change) => sum + change.progress.completedTasks, 0);
  const changesWithTasks = activeChanges.filter((change) => change.progress.totalTasks > 0);
  const completedChanges = changesWithTasks.filter((change) => change.progress.completedTasks === change.progress.totalTasks).length;

  return {
    totalChanges: changes.items.length,
    totalChangeEntries: changes.totalEntries,
    activeChanges: activeChanges.filter((change) => change.status !== "complete").length,
    archivedChanges: changes.items.filter((change) => change.archived).length,
    completedChanges,
    changesWithTasks: changesWithTasks.length,
    totalTasks,
    completedTasks,
    percentComplete: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : null,
    specCount: specs.items.length,
    totalSpecEntries: specs.totalEntries,
    truncated: Boolean(truncated)
  };
}

function emptyOpenSpecSummary({ workspace, generatedAt, warnings }) {
  return {
    projectId: workspace.id,
    workspace: publicWorkspace(workspace),
    available: false,
    directoryName: "",
    directoryPath: "",
    generatedAt,
    overview: {
      totalChanges: 0,
      totalChangeEntries: 0,
      activeChanges: 0,
      archivedChanges: 0,
      completedChanges: 0,
      changesWithTasks: 0,
      totalTasks: 0,
      completedTasks: 0,
      percentComplete: null,
      specCount: 0,
      totalSpecEntries: 0,
      truncated: false
    },
    changes: [],
    specs: [],
    warnings
  };
}

async function readDirectory(absolutePath, warnings, rootRealPath = "") {
  try {
    if (rootRealPath) {
      const realPath = await fs.realpath(absolutePath).catch((error) => {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "";
        throw error;
      });
      if (!realPath) return [];
      if (!isPathInsideOrSame(realPath, rootRealPath)) {
        warnings.push(`Ignored ${path.basename(absolutePath)} because it resolves outside the OpenSpec directory.`);
        return [];
      }
    }
    return await fs.readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    warnings.push(`Could not read ${path.basename(absolutePath)}: ${error.message}`);
    return [];
  }
}

async function readKnownTextFile(absolutePath, defaultBytes, requestedBytes, rootRealPath = "") {
  const limit = clampNumber(requestedBytes, defaultBytes, 1024, 128 * 1024);
  let stats = null;
  try {
    stats = await fs.stat(absolutePath);
    if (!stats.isFile()) return missingTextFile();
    if (rootRealPath) {
      const safe = await realpathInside(absolutePath, rootRealPath);
      if (!safe.ok) return missingTextFile();
    }
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return missingTextFile();
    return missingTextFile();
  }

  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(limit + 1, Math.max(limit, 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const contentBuffer = buffer.subarray(0, Math.min(bytesRead, limit));
    return {
      exists: true,
      content: contentBuffer.toString("utf8"),
      truncated: bytesRead > limit || stats.size > limit,
      size: stats.size,
      mtime: stats.mtime.toISOString()
    };
  } finally {
    await handle.close();
  }
}

function missingTextFile() {
  return {
    exists: false,
    content: "",
    truncated: false,
    size: 0,
    mtime: ""
  };
}

function workspaceForProject(projectId, workspaces = []) {
  const normalizedProjectId = String(projectId || "").trim();
  const workspace = (workspaces || []).find((item) => String(item?.id || "").trim() === normalizedProjectId);
  if (!normalizedProjectId) throw publicError("Codex project is required.", "PROJECT_REQUIRED");
  if (!workspace?.path) throw publicError("Workspace is not advertised by this desktop agent.", "WORKSPACE_NOT_FOUND");
  return {
    id: String(workspace.id || "").trim(),
    label: String(workspace.label || workspace.id || "").trim(),
    path: String(workspace.path || "").trim()
  };
}

async function realpathOrPublicError(absolutePath, message, code) {
  try {
    return await fs.realpath(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw publicError(message, code);
    throw error;
  }
}

async function realpathInside(absolutePath, rootRealPath) {
  try {
    const realPath = await fs.realpath(absolutePath);
    return { ok: isPathInsideOrSame(realPath, rootRealPath), realPath };
  } catch {
    return { ok: false, realPath: "" };
  }
}

function changeStatus(taskSummary) {
  if (taskSummary.total <= 0) return "no-tasks";
  if (taskSummary.completed >= taskSummary.total) return "complete";
  if (taskSummary.completed > 0) return "in-progress";
  return "planned";
}

function compareChanges(left, right) {
  const statusDelta = changeRank(left.status) - changeRank(right.status);
  if (statusDelta !== 0) return statusDelta;
  return Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "");
}

function changeRank(status) {
  if (status === "in-progress") return 0;
  if (status === "planned") return 1;
  if (status === "no-tasks") return 2;
  return 3;
}

function firstHeading(markdown = "") {
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) return cleanMarkdownInline(match[1]);
  }
  return "";
}

function firstDocumentTitle(markdown = "") {
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/);
    if (match) return cleanMarkdownInline(match[1]);
  }
  return "";
}

function sectionExcerpt(markdown = "", headingName = "") {
  const section = markdownSection(markdown, headingName);
  if (!section) return "";
  return clampText(firstParagraph(section) || sectionBulletsFromSection(section, 2).join(" "), excerptLength);
}

function sectionBullets(markdown = "", headingName = "", limit = 4) {
  const section = markdownSection(markdown, headingName);
  return section ? sectionBulletsFromSection(section, limit) : [];
}

function markdownSection(markdown = "", headingName = "") {
  const target = normalizeHeading(headingName);
  const lines = String(markdown || "").split(/\r?\n/);
  let capture = false;
  let level = 0;
  const section = [];

  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const currentLevel = heading[1].length;
      const currentName = normalizeHeading(heading[2]);
      if (capture && currentLevel <= level) break;
      if (currentName === target) {
        capture = true;
        level = currentLevel;
        continue;
      }
    }
    if (capture) section.push(line);
  }

  return section.join("\n").trim();
}

function sectionBulletsFromSection(section = "", limit = 4) {
  const bullets = [];
  for (const line of String(section || "").split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!match) continue;
    bullets.push(clampText(cleanMarkdownInline(match[1]), 180));
    if (bullets.length >= limit) break;
  }
  return bullets;
}

function firstParagraph(markdown = "") {
  const lines = [];
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (lines.length) break;
      continue;
    }
    if (line.startsWith("#") || line.startsWith("- ") || line.startsWith("* ") || line.startsWith("```")) continue;
    lines.push(cleanMarkdownInline(line));
  }
  return clampText(lines.join(" "), excerptLength);
}

function affectedSpecsFromText(text = "") {
  const specs = [];
  const source = String(text || "");
  const codeSpanPattern = /`([a-z0-9][a-z0-9._-]{1,120})`/gi;
  const pathPattern = /(?:^|[/(])specs\/([a-z0-9][a-z0-9._-]{1,120})(?:\/spec\.md)?/gi;
  let match = null;
  while ((match = codeSpanPattern.exec(source))) {
    if (looksLikeSpecId(match[1])) specs.push(match[1]);
  }
  while ((match = pathPattern.exec(source))) {
    if (looksLikeSpecId(match[1])) specs.push(match[1]);
  }
  return uniqueStrings(specs);
}

function looksLikeSpecId(value = "") {
  const text = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._-]{1,120}$/.test(text) && text.includes("-");
}

function countRequirements(markdown = "") {
  return (String(markdown || "").match(/^### Requirement:/gm) || []).length;
}

function normalizeHeading(value = "") {
  return cleanMarkdownInline(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanMarkdownInline(value = "") {
  return String(value || "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromChangeId(value = "") {
  const text = String(value || "").trim();
  if (!text) return "OpenSpec change";
  return text
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function clampText(value = "", limit = excerptLength) {
  const text = cleanMarkdownInline(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function uniqueStrings(values = []) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function latestIso(values = []) {
  let latest = "";
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = value;
      latestMs = ms;
    }
  }
  return latest;
}

function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    label: workspace.label || workspace.id,
    path: workspace.path
  };
}

function isPathInsideOrSame(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(Math.floor(number), max));
}

function publicError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
