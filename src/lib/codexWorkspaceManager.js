import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { configuredWorkspaces } from "./codexWorkspaceConfig.js";

const managedWorkspaceFile = path.resolve(
  expandHome(process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE || path.join(config.dataDir, "codex-workspaces.json"))
);

export function managedWorkspaceFilePath() {
  return managedWorkspaceFile;
}

export function managedWorkspaces() {
  return readManagedWorkspaces().map(toPublicWorkspace);
}

export function createManagedWorkspace(input = {}) {
  const label = normalizeLabel(input.label || input.name);
  if (!label) {
    throw new Error("Workspace name is required.");
  }

  const root = workspaceCreationRoot();
  fs.mkdirSync(root, { recursive: true });

  const directoryName = sanitizeDirectoryName(input.directoryName || label);
  const workspacePath = createUniqueDirectory(root, directoryName);
  const existing = [...configuredWorkspaces(), ...readManagedWorkspaces()];
  const workspace = {
    id: uniqueWorkspaceId(slug(label), existing),
    label,
    path: workspacePath,
    source: "mobile",
    createdAt: new Date().toISOString()
  };

  writeManagedWorkspaces([...readManagedWorkspaces(), workspace]);
  return toPublicWorkspace(workspace);
}

export function registerManagedWorkspace(input = {}) {
  const resolved = resolveImportDirectory(input);
  const label = normalizeLabel(input.label || path.basename(resolved.realPath) || resolved.root.label);
  if (!label) throw publicError("Workspace label is required.", "WORKSPACE_LABEL_REQUIRED");

  const existing = [...configuredWorkspaces(), ...readManagedWorkspaces()];
  const duplicate = existing.find((workspace) => sameRealPath(workspace.path, resolved.realPath));
  if (duplicate) {
    throw publicError("This directory is already registered as an Echo project.", "DUPLICATE_WORKSPACE");
  }

  const workspace = {
    id: uniqueWorkspaceId(slug(label), existing),
    label,
    path: resolved.realPath,
    source: "registered",
    createdAt: new Date().toISOString()
  };

  writeManagedWorkspaces([...readManagedWorkspaces(), workspace]);
  return toPublicWorkspace(workspace);
}

export function workspaceImportRoots() {
  const candidates = [
    ...configuredImportRoots(),
    workspaceCreationRoot(),
    ...configuredWorkspaces().map((workspace) => path.dirname(workspace.path)),
    ...readManagedWorkspaces().map((workspace) => path.dirname(workspace.path))
  ];
  const byPath = new Map();
  for (const candidate of candidates) {
    const root = importRootForPath(candidate);
    if (!root || byPath.has(root.realPath)) continue;
    byPath.set(root.realPath, root);
  }
  return Array.from(byPath.values()).map(publicImportRoot);
}

export function listWorkspaceImportDirectories(input = {}) {
  const resolved = resolveImportDirectory(input);
  const projectShape = projectShapeForDirectory(resolved.realPath);
  const entries = fs.readdirSync(resolved.realPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => directoryEntryForImport(resolved, entry))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(Number(input.maxEntries || 120) || 120, 300)));

  return {
    ok: true,
    root: publicImportRoot(resolved.root),
    rootId: resolved.root.id,
    path: resolved.path,
    label: resolved.path ? path.basename(resolved.realPath) : resolved.root.label,
    parentPath: parentImportPath(resolved.path),
    canSelect: true,
    looksLikeProject: projectShape.looksLikeProject,
    projectMarkers: projectShape.markers,
    entries
  };
}

export function workspaceCreationRoot() {
  const configuredRoot = String(process.env.ECHO_CODEX_WORKSPACE_ROOT || "").trim();
  if (configuredRoot) return path.resolve(expandHome(configuredRoot));

  const firstWorkspacePath = configuredWorkspaces().find((workspace) => workspace.path)?.path;
  if (firstWorkspacePath) return path.dirname(firstWorkspacePath);

  return path.join(os.homedir(), "workspace", "projects");
}

function configuredImportRoots() {
  const configuredRoots = String(process.env.ECHO_CODEX_IMPORT_ROOTS || "").trim();
  if (configuredRoots) return parsePathList(configuredRoots);

  const home = os.homedir();
  return [
    path.join(home, "workspace", "projects"),
    path.join(home, "workspace"),
    path.join(home, "Projects"),
    path.join(home, "Developer"),
    path.join(home, "src"),
    path.join(home, "code"),
    path.join(home, "repos")
  ];
}

function parsePathList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(expandHome);
}

function importRootForPath(value) {
  try {
    const rootPath = path.resolve(expandHome(String(value || "")));
    if (!fs.existsSync(rootPath)) return null;
    const realPath = fs.realpathSync(rootPath);
    if (!fs.statSync(realPath).isDirectory()) return null;
    const id = importRootId(realPath);
    return {
      id,
      label: path.basename(realPath) || realPath,
      path: realPath,
      realPath
    };
  } catch {
    return null;
  }
}

function publicImportRoot(root = {}) {
  return {
    id: root.id,
    label: root.label || path.basename(root.realPath || root.path || "") || "Projects",
    pathLabel: root.path || root.realPath || ""
  };
}

function importRootId(rootPath) {
  return createHash("sha256").update(path.resolve(rootPath)).digest("hex").slice(0, 18);
}

function resolveImportDirectory(input = {}) {
  const rootId = String(input.rootId || "").trim();
  if (!rootId) throw publicError("Import root is required.", "IMPORT_ROOT_REQUIRED");
  const root = importRootById(rootId);
  if (!root) throw publicError("Import root is no longer available.", "IMPORT_ROOT_UNAVAILABLE");

  const relativePath = normalizeImportPath(input.path || input.relativePath);
  const candidate = path.resolve(root.realPath, relativePath || ".");
  let realPath = "";
  try {
    realPath = fs.realpathSync(candidate);
  } catch {
    throw publicError("Directory is not available.", "DIRECTORY_UNAVAILABLE");
  }
  if (!isInsideOrEqual(realPath, root.realPath)) {
    throw publicError("Directory must stay inside the selected import root.", "PATH_ESCAPE");
  }
  const stat = fs.statSync(realPath);
  if (!stat.isDirectory()) throw publicError("Choose a directory.", "NOT_DIRECTORY");

  return { root, path: relativePath, realPath };
}

function importRootById(rootId) {
  return workspaceImportRoots()
    .map((root) => ({ ...root, realPath: root.pathLabel || root.path || "" }))
    .find((root) => root.id === rootId) || null;
}

function normalizeImportPath(value) {
  const raw = String(value || "").replaceAll("\\", "/").trim();
  if (!raw || raw === "." || raw === "/") return "";
  if (raw.includes("\0")) throw publicError("Directory path is invalid.", "INVALID_PATH");
  if (raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw) || raw.startsWith("~/") || raw === "~") {
    throw publicError("Import paths must be relative to the selected root.", "ABSOLUTE_PATH");
  }

  const parts = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw publicError("Import paths must stay inside the selected root.", "PATH_ESCAPE");
    parts.push(part);
  }
  return parts.join("/");
}

function directoryEntryForImport(resolved, entry) {
  const childPath = path.join(resolved.realPath, entry.name);
  let childRealPath = "";
  try {
    childRealPath = fs.realpathSync(childPath);
  } catch {
    return null;
  }
  if (!isInsideOrEqual(childRealPath, resolved.root.realPath)) return null;
  try {
    if (!fs.statSync(childRealPath).isDirectory()) return null;
  } catch {
    return null;
  }
  const childRelativePath = [resolved.path, entry.name].filter(Boolean).join("/");
  return {
    name: entry.name,
    path: childRelativePath,
    kind: "directory"
  };
}

function parentImportPath(value) {
  const normalized = normalizeImportPath(value);
  if (!normalized) return "";
  const parent = path.posix.dirname(normalized);
  return parent === "." ? "" : parent;
}

function sameRealPath(left, right) {
  try {
    return fs.realpathSync(path.resolve(expandHome(String(left || "")))) === fs.realpathSync(path.resolve(expandHome(String(right || ""))));
  } catch {
    return path.resolve(expandHome(String(left || ""))) === path.resolve(expandHome(String(right || "")));
  }
}

function isInsideOrEqual(candidate, root) {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectShapeForDirectory(directoryPath) {
  const markers = [
    ".git",
    "AGENTS.md",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "README.md",
    "README"
  ];
  const found = markers.filter((marker) => fs.existsSync(path.join(directoryPath, marker)));
  return {
    looksLikeProject: found.length > 0,
    markers: found.slice(0, 5)
  };
}

function publicError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readManagedWorkspaces() {
  try {
    const content = fs.readFileSync(managedWorkspaceFile, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.workspaces)
      ? parsed.workspaces.map(normalizeStoredWorkspace).filter(Boolean)
      : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.warn("Could not read managed Codex workspaces:", error.message);
    return [];
  }
}

function writeManagedWorkspaces(workspaces) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const byPath = new Map();
  for (const workspace of workspaces.map(normalizeStoredWorkspace).filter(Boolean)) {
    byPath.set(workspace.path, workspace);
  }
  fs.writeFileSync(
    managedWorkspaceFile,
    `${JSON.stringify({ workspaces: Array.from(byPath.values()) }, null, 2)}\n`,
    "utf8"
  );
}

function normalizeStoredWorkspace(workspace = {}) {
  const workspacePath = String(workspace.path || "").trim();
  const label = normalizeLabel(workspace.label || workspace.id || path.basename(workspacePath));
  if (!workspacePath || !label) return null;
  return {
    id: slug(workspace.id || label),
    label,
    path: path.resolve(expandHome(workspacePath)),
    source: String(workspace.source || "mobile"),
    createdAt: String(workspace.createdAt || "")
  };
}

function toPublicWorkspace(workspace) {
  return {
    id: workspace.id,
    label: workspace.label,
    path: workspace.path
  };
}

function normalizeLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
}

function sanitizeDirectoryName(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") return "project";
  return cleaned;
}

function createUniqueDirectory(root, preferredName) {
  for (let index = 0; index < 200; index += 1) {
    const directoryName = index === 0 ? preferredName : `${preferredName}-${index + 1}`;
    const workspacePath = path.join(root, directoryName);
    try {
      fs.mkdirSync(workspacePath);
      return workspacePath;
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not allocate a unique workspace directory.");
}

function uniqueWorkspaceId(preferredId, workspaces) {
  const ids = new Set(workspaces.map((workspace) => workspace.id).filter(Boolean));
  const base = preferredId || "workspace";
  if (!ids.has(base)) return base;
  for (let index = 2; index < 200; index += 1) {
    const candidate = `${base}-${index}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workspace";
}
