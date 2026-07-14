import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const managerModuleUrl = pathToFileURL(path.resolve("src/lib/codexWorkspaceManager.js")).href;

test("managed workspace file can be scoped per desktop agent profile", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-managed-workspaces-"));
  const previousValue = process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE;
  const scopedFile = path.join(tempDir, "codex-workspaces-huahua.json");
  process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = scopedFile;
  try {
    const manager = await import(`${managerModuleUrl}?scoped=${encodeURIComponent(scopedFile)}`);
    assert.equal(manager.managedWorkspaceFilePath(), scopedFile);
  } finally {
    if (previousValue === undefined) {
      delete process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE;
    } else {
      process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = previousValue;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("existing workspace registration validates import roots, escapes, and duplicates", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-workspace-import-"));
  const previousManagedFile = process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE;
  const previousWorkspaceRoot = process.env.ECHO_CODEX_WORKSPACE_ROOT;
  const previousWorkspaces = process.env.ECHO_CODEX_WORKSPACES;
  const managedFile = path.join(tempDir, "managed.json");
  const root = path.join(tempDir, "projects");
  const validProject = path.join(root, "valid");
  const outside = path.join(tempDir, "outside");
  fs.mkdirSync(validProject, { recursive: true });
  fs.writeFileSync(path.join(validProject, "package.json"), "{}\n", "utf8");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "package.json"), "{}\n", "utf8");
  fs.symlinkSync(outside, path.join(root, "escape"));
  process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = managedFile;
  process.env.ECHO_CODEX_WORKSPACE_ROOT = root;
  process.env.ECHO_CODEX_WORKSPACES = "";

  try {
    const manager = await import(`${managerModuleUrl}?import=${encodeURIComponent(managedFile)}`);
    const roots = manager.workspaceImportRoots();
    const rootEntry = roots.find((item) => item.pathLabel === fs.realpathSync(root));
    assert.equal(Boolean(rootEntry), true);

    const listed = manager.listWorkspaceImportDirectories({ rootId: rootEntry.id, path: "" });
    assert.equal(listed.entries.some((entry) => entry.name === "valid"), true);
    assert.equal(listed.entries.some((entry) => entry.name === "escape"), false);
    assert.equal(listed.looksLikeProject, false);

    assert.throws(
      () => manager.registerManagedWorkspace({ rootId: rootEntry.id, path: "escape" }),
      /inside the selected import root/
    );
    const firstRegistered = manager.registerManagedWorkspace({ rootId: rootEntry.id, path: "valid" });
    assert.equal(firstRegistered.path, fs.realpathSync(validProject));
    const validTree = manager.listWorkspaceImportDirectories({ rootId: rootEntry.id, path: "valid" });
    assert.equal(validTree.looksLikeProject, true);
    assert.deepEqual(validTree.projectMarkers, ["package.json"]);
    assert.throws(
      () => manager.registerManagedWorkspace({ rootId: rootEntry.id, path: "valid" }),
      /already registered/
    );

    const otherProject = path.join(root, "other");
    fs.mkdirSync(otherProject, { recursive: true });
    fs.writeFileSync(path.join(otherProject, "README.md"), "# Other\n", "utf8");
    const registered = manager.registerManagedWorkspace({ rootId: rootEntry.id, path: "other" });
    assert.equal(registered.label, "other");
    assert.equal(registered.path, fs.realpathSync(otherProject));
  } finally {
    if (previousManagedFile === undefined) delete process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE;
    else process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = previousManagedFile;
    if (previousWorkspaceRoot === undefined) delete process.env.ECHO_CODEX_WORKSPACE_ROOT;
    else process.env.ECHO_CODEX_WORKSPACE_ROOT = previousWorkspaceRoot;
    if (previousWorkspaces === undefined) delete process.env.ECHO_CODEX_WORKSPACES;
    else process.env.ECHO_CODEX_WORKSPACES = previousWorkspaces;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workspace import roots include common project directories by default", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-import-home-"));
  const previousHome = process.env.HOME;
  const previousManagedFile = process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE;
  const previousWorkspaceRoot = process.env.ECHO_CODEX_WORKSPACE_ROOT;
  const previousWorkspaces = process.env.ECHO_CODEX_WORKSPACES;
  const previousImportRoots = process.env.ECHO_CODEX_IMPORT_ROOTS;
  const managedFile = path.join(tempDir, "managed.json");
  const workspaceRoot = path.join(tempDir, "workspace", "projects");
  const workspaceParent = path.join(tempDir, "workspace");
  const projectsRoot = path.join(tempDir, "Projects");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  process.env.HOME = tempDir;
  process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = managedFile;
  delete process.env.ECHO_CODEX_WORKSPACE_ROOT;
  process.env.ECHO_CODEX_WORKSPACES = "";
  delete process.env.ECHO_CODEX_IMPORT_ROOTS;

  try {
    const manager = await import(`${managerModuleUrl}?common-roots=${encodeURIComponent(tempDir)}`);
    const rootPaths = manager.workspaceImportRoots().map((item) => item.pathLabel);
    assert.equal(rootPaths.includes(fs.realpathSync(workspaceRoot)), true);
    assert.equal(rootPaths.includes(fs.realpathSync(workspaceParent)), true);
    assert.equal(rootPaths.includes(fs.realpathSync(projectsRoot)), true);
    assert.equal(rootPaths.includes(path.join(tempDir, "Documents")), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousManagedFile === undefined) delete process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE;
    else process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = previousManagedFile;
    if (previousWorkspaceRoot === undefined) delete process.env.ECHO_CODEX_WORKSPACE_ROOT;
    else process.env.ECHO_CODEX_WORKSPACE_ROOT = previousWorkspaceRoot;
    if (previousWorkspaces === undefined) delete process.env.ECHO_CODEX_WORKSPACES;
    else process.env.ECHO_CODEX_WORKSPACES = previousWorkspaces;
    if (previousImportRoots === undefined) delete process.env.ECHO_CODEX_IMPORT_ROOTS;
    else process.env.ECHO_CODEX_IMPORT_ROOTS = previousImportRoots;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("workspace import roots can be configured without allowing absolute mobile paths", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-import-roots-"));
  const previousManagedFile = process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE;
  const previousWorkspaceRoot = process.env.ECHO_CODEX_WORKSPACE_ROOT;
  const previousWorkspaces = process.env.ECHO_CODEX_WORKSPACES;
  const previousImportRoots = process.env.ECHO_CODEX_IMPORT_ROOTS;
  const managedFile = path.join(tempDir, "managed.json");
  const importRoot = path.join(tempDir, "repos");
  const creationRoot = path.join(tempDir, "created");
  const project = path.join(importRoot, "project");
  const emptyDirectory = path.join(importRoot, "empty");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(emptyDirectory, { recursive: true });
  fs.mkdirSync(creationRoot, { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "# Project\n", "utf8");
  process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = managedFile;
  process.env.ECHO_CODEX_WORKSPACE_ROOT = creationRoot;
  process.env.ECHO_CODEX_WORKSPACES = "";
  process.env.ECHO_CODEX_IMPORT_ROOTS = importRoot;

  try {
    const manager = await import(`${managerModuleUrl}?custom-roots=${encodeURIComponent(managedFile)}`);
    const roots = manager.workspaceImportRoots();
    assert.deepEqual(roots.slice(0, 2).map((item) => item.pathLabel), [fs.realpathSync(importRoot), fs.realpathSync(creationRoot)]);
    const rootEntry = roots.find((item) => item.pathLabel === fs.realpathSync(importRoot));

    assert.throws(
      () => manager.listWorkspaceImportDirectories({ rootId: rootEntry.id, path: project }),
      /relative to the selected root/
    );
    const emptyTree = manager.listWorkspaceImportDirectories({ rootId: rootEntry.id, path: "empty" });
    assert.equal(emptyTree.looksLikeProject, false);
    assert.deepEqual(emptyTree.projectMarkers, []);
    assert.equal(manager.registerManagedWorkspace({ rootId: rootEntry.id, path: "empty" }).path, fs.realpathSync(emptyDirectory));
    assert.equal(manager.registerManagedWorkspace({ rootId: rootEntry.id, path: "project" }).path, fs.realpathSync(project));
  } finally {
    if (previousManagedFile === undefined) delete process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE;
    else process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = previousManagedFile;
    if (previousWorkspaceRoot === undefined) delete process.env.ECHO_CODEX_WORKSPACE_ROOT;
    else process.env.ECHO_CODEX_WORKSPACE_ROOT = previousWorkspaceRoot;
    if (previousWorkspaces === undefined) delete process.env.ECHO_CODEX_WORKSPACES;
    else process.env.ECHO_CODEX_WORKSPACES = previousWorkspaces;
    if (previousImportRoots === undefined) delete process.env.ECHO_CODEX_IMPORT_ROOTS;
    else process.env.ECHO_CODEX_IMPORT_ROOTS = previousImportRoots;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
