import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("configuredWorkspaces follows .env changes when startup value came from .env", async () => {
  const context = createWorkspaceConfigTestContext();
  try {
    const firstPath = path.join(context.root, "first");
    const secondPath = path.join(context.root, "second");
    fs.mkdirSync(firstPath);
    fs.mkdirSync(secondPath);
    fs.writeFileSync(context.envFile, `ECHO_CODEX_WORKSPACES=first=${firstPath}\n`, "utf8");
    process.env.ECHO_CODEX_WORKSPACES = `first=${firstPath}`;
    process.chdir(context.root);

    const workspaceConfig = await importWorkspaceConfig(context.root, "follow");
    assert.deepEqual(workspaceConfig.configuredWorkspaces(), [
      { id: "first", label: "first", path: firstPath }
    ]);

    fs.writeFileSync(context.envFile, `ECHO_CODEX_WORKSPACES=second=${secondPath}\n`, "utf8");
    assert.deepEqual(workspaceConfig.configuredWorkspaces(), [
      { id: "second", label: "second", path: secondPath }
    ]);
  } finally {
    context.restore();
  }
});

test("configuredWorkspaces follows .env after first settings save", async () => {
  const context = createWorkspaceConfigTestContext();
  try {
    const addedPath = path.join(context.root, "added");
    fs.mkdirSync(addedPath);
    delete process.env.ECHO_CODEX_WORKSPACES;
    process.chdir(context.root);

    const workspaceConfig = await importWorkspaceConfig(context.root, "created");
    assert.equal(workspaceConfig.configuredWorkspaces().length, 1);

    fs.writeFileSync(context.envFile, `ECHO_CODEX_WORKSPACES=added=${addedPath}\n`, "utf8");
    assert.deepEqual(workspaceConfig.configuredWorkspaces(), [
      { id: "added", label: "added", path: addedPath }
    ]);
  } finally {
    context.restore();
  }
});

test("configuredWorkspaces keeps explicit environment override over .env reloads", async () => {
  const context = createWorkspaceConfigTestContext();
  try {
    const envPath = path.join(context.root, "env-file");
    const overridePath = path.join(context.root, "override");
    const changedPath = path.join(context.root, "changed");
    fs.mkdirSync(envPath);
    fs.mkdirSync(overridePath);
    fs.mkdirSync(changedPath);
    fs.writeFileSync(context.envFile, `ECHO_CODEX_WORKSPACES=env-file=${envPath}\n`, "utf8");
    process.env.ECHO_CODEX_WORKSPACES = `override=${overridePath}`;
    process.chdir(context.root);

    const workspaceConfig = await importWorkspaceConfig(context.root, "override");
    assert.deepEqual(workspaceConfig.configuredWorkspaces(), [
      { id: "override", label: "override", path: overridePath }
    ]);

    fs.writeFileSync(context.envFile, `ECHO_CODEX_WORKSPACES=changed=${changedPath}\n`, "utf8");
    assert.deepEqual(workspaceConfig.configuredWorkspaces(), [
      { id: "override", label: "override", path: overridePath }
    ]);
  } finally {
    context.restore();
  }
});

function createWorkspaceConfigTestContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-workspace-config-"));
  const previousCwd = process.cwd();
  const previousWorkspaceEnv = process.env.ECHO_CODEX_WORKSPACES;
  return {
    root,
    envFile: path.join(root, ".env"),
    restore() {
      process.chdir(previousCwd);
      if (previousWorkspaceEnv === undefined) {
        delete process.env.ECHO_CODEX_WORKSPACES;
      } else {
        process.env.ECHO_CODEX_WORKSPACES = previousWorkspaceEnv;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

async function importWorkspaceConfig(root, name) {
  const modulePath = path.join(repoRoot, "src/lib/codexWorkspaceConfig.js");
  return import(`${pathToFileURL(modulePath).href}?test=${name}-${encodeURIComponent(root)}`);
}
