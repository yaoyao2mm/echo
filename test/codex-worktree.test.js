import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-worktree-test-"));
const tempHome = path.join(tempRoot, "home");
const workspacePath = path.join(tempRoot, "workspace");
const worktreeRoot = path.join(tempRoot, "worktrees");

fs.mkdirSync(tempHome, { recursive: true });
fs.mkdirSync(workspacePath, { recursive: true });
process.env.HOME = tempHome;
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_CODEX_WORKSPACES = `demo=${workspacePath}`;
process.env.ECHO_CODEX_WORKTREE_MODE = "optional";
process.env.ECHO_CODEX_WORKTREE_ROOT = worktreeRoot;

const { formatGitSummary, gitWorkspaceSnapshot, summarizeGitWorkspace } = await import("../src/lib/codexGitSummary.js");
const { sanitizeRuntimeForAgent } = await import("../src/lib/codexRuntime.js");
const { config } = await import("../src/config.js");
const {
  applyCodexSessionWorktree,
  calculateCodexWorktreeSetupKey,
  cleanupCodexSessionWorktrees,
  codexWorktreeCapability,
  discardCodexSessionWorktree,
  maintainCodexWarmWorktreePool,
  prepareCodexSessionWorktree,
  publicCodexWorktreeExecution,
  readCodexSessionWorktreeMetadata,
  resolveCodexSessionFileTarget
} = await import("../src/lib/codexWorktree.js");

test("public worktree execution preserves orchestration ownership", () => {
  const execution = publicCodexWorktreeExecution({
    mode: "worktree",
    lifecycleState: "completed",
    sessionId: "session-orchestration",
    ownerType: "orchestration",
    runId: "run-1",
    itemId: "item-1",
    worktreeKind: "change"
  });

  assert.equal(execution.ownerType, "orchestration");
  assert.equal(execution.runId, "run-1");
  assert.equal(execution.itemId, "item-1");
  assert.equal(execution.worktreeKind, "change");
});

test("worktree setup profiles use keyed readiness, bounded events, and shared cache runtime", async () => {
  initRepo(workspacePath);
  const originalHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspacePath, encoding: "utf8" }).trim();
  let prepared;
  fs.writeFileSync(path.join(workspacePath, "package-lock.json"), "lock-v1\n", "utf8");
  execGit(workspacePath, ["add", "package-lock.json"]);
  commit(workspacePath, "add lockfile");
  const cachePath = path.join(tempRoot, "npm-cache");
  config.codex.worktreeRuntime.demo = {
    setupProfiles: [
      {
        id: "node-setup",
        label: "Node setup",
        command: process.execPath,
        args: ["-e", "require('node:fs').appendFileSync('setup-runs.txt', process.env.npm_config_cache + '\\n'); console.log('x'.repeat(2400))"],
        automatic: true,
        timeoutMs: 5000
      }
    ],
    defaultSetupProfileId: "node-setup",
    cacheEnv: { npm_config_cache: cachePath },
    extraSetupKeyFiles: [],
    warmPool: { maxCount: 0, ttlHours: 24 }
  };

  try {
    const events = [];
    prepared = await prepareCodexSessionWorktree(worktreeStart("session-setup-profile"), {
      onEvent: (event) => events.push(event)
    });
    assert.equal(prepared.execution.setupStatus, "succeeded");
    assert.equal(prepared.runtime.worktreeCacheEnv.npm_config_cache, cachePath);
    assert.deepEqual(events.map((event) => event.type), [
      "worktree.setup.queued",
      "worktree.setup.running",
      "worktree.setup.succeeded"
    ]);
    assert.equal(events.at(-1).raw.setup.summary.length <= 2000, true);
    assert.equal(events.at(-1).raw.setup.command, undefined);
    assert.equal(events.at(-1).raw.setup.cachePath, undefined);
    assert.equal(fs.readFileSync(path.join(prepared.execution.path, "setup-runs.txt"), "utf8").trim(), cachePath);

    const firstKey = await calculateCodexWorktreeSetupKey(prepared.execution.path);
    fs.writeFileSync(path.join(prepared.execution.path, "package-lock.json"), "lock-v2\n", "utf8");
    const secondKey = await calculateCodexWorktreeSetupKey(prepared.execution.path);
    assert.notEqual(firstKey, secondKey);

    const followUpEvents = [];
    const followUp = await prepareCodexSessionWorktree(
      { ...prepared, id: "cmd-setup-follow-up", type: "message", payload: { text: "continue" } },
      { onEvent: (event) => followUpEvents.push(event) }
    );
    assert.equal(followUp.execution.lifecycleState, "running");
    assert.equal(followUp.execution.setupKey, secondKey);
    assert.deepEqual(followUpEvents.map((event) => event.type), [
      "worktree.setup.invalidated",
      "worktree.setup.queued",
      "worktree.setup.running",
      "worktree.setup.succeeded"
    ]);
    assert.equal(fs.readFileSync(path.join(prepared.execution.path, "setup-runs.txt"), "utf8").trim().split("\n").length, 2);

    const capability = codexWorktreeCapability({ id: "demo" });
    assert.deepEqual(capability.setupProfiles, [{ id: "node-setup", label: "Node setup", automatic: true }]);
    assert.deepEqual(capability.cachePolicy, { enabled: true, families: ["node"] });
    assert.equal(JSON.stringify(capability).includes(cachePath), false);
    assert.equal(JSON.stringify(capability).includes(process.execPath), false);
  } finally {
    if (prepared?.execution?.path) {
      await discardCodexSessionWorktree({
        ...prepared,
        type: "worktree",
        payload: { action: "discard" }
      }).catch(() => {});
    }
    delete config.codex.worktreeRuntime.demo;
    execGit(workspacePath, ["reset", "--hard", originalHead]);
    resetWorkspace();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("warm worktree pool prepares, assigns, invalidates, and expires managed worktrees", async () => {
  initRepo(workspacePath);
  fs.writeFileSync(path.join(workspacePath, "package-lock.json"), "lock-v1\n", "utf8");
  execGit(workspacePath, ["add", "package-lock.json"]);
  commit(workspacePath, "add warm pool lockfile");
  const cachePath = path.join(tempRoot, "warm-npm-cache");
  config.codex.worktreeRuntime.demo = {
    setupProfiles: [{
      id: "warm-setup",
      label: "Warm setup",
      command: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('warm-ready.txt', process.env.npm_config_cache)"],
      automatic: true,
      timeoutMs: 5000
    }],
    defaultSetupProfileId: "warm-setup",
    cacheEnv: { npm_config_cache: cachePath },
    extraSetupKeyFiles: [],
    warmPool: { maxCount: 1, ttlHours: 1 }
  };

  let assigned;
  try {
    const nowMs = Date.now();
    const preparedPool = await maintainCodexWarmWorktreePool({ nowMs });
    assert.equal(preparedPool.created, 1, preparedPool.workspaces.demo.lastError);
    assert.equal(preparedPool.workspaces.demo.ready, 1);
    assert.equal(codexWorktreeCapability({ id: "demo" }).warmPool.readyCount, 1);

    const warmRoot = path.join(worktreeRoot, "demo", ".warm-pool");
    const firstWarmPath = path.join(warmRoot, fs.readdirSync(warmRoot)[0]);
    assert.equal(firstWarmPath.startsWith(path.resolve(worktreeRoot) + path.sep), true);
    assert.equal(fs.readFileSync(path.join(firstWarmPath, "warm-ready.txt"), "utf8"), cachePath);

    assigned = await prepareCodexSessionWorktree(worktreeStart("session-warm-assignment"));
    assert.equal(assigned.execution.warmPoolSource, "warm-pool");
    assert.equal(assigned.execution.path, path.join(worktreeRoot, "demo", "session-warm-assignment"));
    assert.equal(fs.existsSync(firstWarmPath), false);
    assert.equal(fs.readFileSync(path.join(assigned.execution.path, "warm-ready.txt"), "utf8"), cachePath);
    assert.equal(codexWorktreeCapability({ id: "demo" }).warmPool.readyCount, 0);
    await discardCodexSessionWorktree({ ...assigned, type: "worktree", payload: { action: "discard" } });
    assigned = null;

    const replenished = await maintainCodexWarmWorktreePool({ nowMs: nowMs + 1000 });
    assert.equal(replenished.created, 1, replenished.workspaces.demo.lastError);
    const beforeSetupChange = fs.readdirSync(warmRoot)[0];
    fs.writeFileSync(path.join(workspacePath, "package-lock.json"), "lock-v2\n", "utf8");
    execGit(workspacePath, ["add", "package-lock.json"]);
    commit(workspacePath, "change warm pool setup key");
    const setupInvalidated = await maintainCodexWarmWorktreePool({ nowMs: nowMs + 2000 });
    assert.equal(setupInvalidated.removed, 1);
    assert.equal(setupInvalidated.created, 1, setupInvalidated.workspaces.demo.lastError);
    assert.notEqual(fs.readdirSync(warmRoot)[0], beforeSetupChange);

    const beforePolicyChange = fs.readdirSync(warmRoot)[0];
    config.codex.worktreeRuntime.demo.cacheEnv = { npm_config_cache: `${cachePath}-changed` };
    const policyInvalidated = await maintainCodexWarmWorktreePool({ nowMs: nowMs + 3000 });
    assert.equal(policyInvalidated.removed, 1);
    assert.equal(policyInvalidated.created, 1, policyInvalidated.workspaces.demo.lastError);
    assert.notEqual(fs.readdirSync(warmRoot)[0], beforePolicyChange);

    const beforeExpiry = fs.readdirSync(warmRoot)[0];
    const expired = await maintainCodexWarmWorktreePool({ nowMs: nowMs + 2 * 60 * 60 * 1000 });
    assert.equal(expired.removed, 1);
    assert.equal(expired.created, 1, expired.workspaces.demo.lastError);
    assert.notEqual(fs.readdirSync(warmRoot)[0], beforeExpiry);
  } finally {
    if (assigned?.execution?.path) {
      await discardCodexSessionWorktree({ ...assigned, type: "worktree", payload: { action: "discard" } }).catch(() => {});
    }
    config.codex.worktreeRuntime.demo.warmPool.maxCount = 0;
    await maintainCodexWarmWorktreePool({ nowMs: Date.now() + 3 * 60 * 60 * 1000 }).catch(() => {});
    delete config.codex.worktreeRuntime.demo;
    resetWorkspace();
    fs.rmSync(workspacePath, { recursive: true, force: true });
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("prepareCodexSessionWorktree fails closed for a non-Git workspace", async () => {
  const command = {
    id: "cmd-plain",
    sessionId: "session-plain-workspace",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "change files" }
  };
  const prepared = await prepareCodexSessionWorktree(command);

  assert.equal(prepared.execution.lifecycleState, "unavailable");
  assert.equal(prepared.execution.errorCode, "not-git");
  assert.equal(prepared.runtime.worktreeMode, "always");
  assert.equal(prepared.worktreeUnavailableResult.events[0].type, "worktree.unavailable");
});

test("prepareCodexSessionWorktree fails closed for an empty Git workspace", async () => {
  execGit(workspacePath, ["init"]);
  try {
    const command = {
      id: "cmd-empty-git",
      sessionId: "session-empty-git",
      type: "start",
      projectId: "demo",
      runtime: { worktreeMode: "always" },
      payload: { prompt: "change files" }
    };
    const prepared = await prepareCodexSessionWorktree(command);

    assert.equal(prepared.execution.lifecycleState, "unavailable");
    assert.equal(prepared.execution.errorCode, "no-git-commit");
    assert.equal(prepared.runtime.worktreeMode, "always");
  } finally {
    fs.rmSync(path.join(workspacePath, ".git"), { recursive: true, force: true });
  }
});

test("prepareCodexSessionWorktree creates and reuses an isolated Git worktree for a clean workspace", async () => {
  initRepo(workspacePath);

  const command = {
    id: "cmd-1",
    sessionId: "session-worktree-123456",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "change files" }
  };
  const prepared = await prepareCodexSessionWorktree(command);

  assert.equal(prepared.execution.mode, "worktree");
  assert.equal(prepared.execution.lifecycleState, "ready", prepared.execution.errorCode || prepared.execution.errorSummary);
  assert.equal(prepared.execution.basePath, fs.realpathSync(workspacePath));
  assert.equal(prepared.execution.branchName, "echo/job-sessionworkt");
  assert.equal(prepared.execution.path.startsWith(path.join(fs.realpathSync(worktreeRoot), "demo")), true);
  assert.equal(fs.existsSync(path.join(prepared.execution.path, "README.md")), true);

  fs.appendFileSync(path.join(workspacePath, "README.md"), "dirty base after crash\n", "utf8");
  const retried = await prepareCodexSessionWorktree(command);
  assert.equal(retried.execution.mode, "worktree");
  assert.equal(retried.execution.reused, true);
  assert.equal(retried.execution.lifecycleState, "ready");
  assert.equal(retried.execution.path, prepared.execution.path);
  assert.equal(retried.execution.branchName, prepared.execution.branchName);

  const fileTarget = await resolveCodexSessionFileTarget({
    sessionId: command.sessionId,
    projectId: command.projectId,
    desktopAgentId: prepared.execution.desktopAgentId,
    lifecycleState: "ready"
  });
  assert.equal(fileTarget.path, prepared.execution.path);
  await assert.rejects(
    () => resolveCodexSessionFileTarget({ sessionId: command.sessionId, projectId: "other", lifecycleState: "ready" }),
    /no longer available/
  );
  await assert.rejects(
    () => resolveCodexSessionFileTarget({ sessionId: command.sessionId, projectId: command.projectId, lifecycleState: "discarded" }),
    /no longer available/
  );

  const followUp = await prepareCodexSessionWorktree({
    ...command,
    id: "cmd-1-follow-up",
    type: "message",
    execution: prepared.execution,
    payload: { text: "continue in the same worktree" }
  });
  assert.equal(followUp.execution.path, prepared.execution.path);
  assert.equal(followUp.execution.reused, true);
  assert.equal(followUp.execution.lifecycleState, "running");

  const publicExecution = publicCodexWorktreeExecution(prepared.execution);
  assert.equal(publicExecution.path, undefined);
  assert.equal(publicExecution.basePath, undefined);
  assert.match(publicExecution.worktreeId, /^wt_[a-f0-9]{16}$/);
  const opaqueFollowUp = await prepareCodexSessionWorktree({
    ...command,
    id: "cmd-1-opaque-follow-up",
    type: "message",
    execution: publicExecution,
    payload: { text: "continue from opaque relay state" }
  });
  assert.equal(opaqueFollowUp.execution.path, prepared.execution.path);
  assert.equal(opaqueFollowUp.execution.reused, true);
});

test("sanitizeRuntimeForAgent keeps optional desktop worktree policy as explicit opt-in", () => {
  assert.equal(
    sanitizeRuntimeForAgent({ worktreeMode: "always" }, { worktreeMode: "optional", sandbox: "workspace-write" }).worktreeMode,
    "always"
  );
  assert.equal(sanitizeRuntimeForAgent({}, { worktreeMode: "optional", sandbox: "workspace-write" }).worktreeMode, "off");
  assert.equal(
    sanitizeRuntimeForAgent({ worktreeMode: "off" }, { worktreeMode: "optional", sandbox: "workspace-write" }).worktreeMode,
    "off"
  );
  assert.equal(
    sanitizeRuntimeForAgent({ worktreeMode: "off" }, { worktreeMode: "always", sandbox: "workspace-write" }).worktreeMode,
    "always"
  );
  assert.equal(
    sanitizeRuntimeForAgent({ worktreeMode: "always" }, { worktreeMode: "off", sandbox: "workspace-write" }).worktreeMode,
    "off"
  );
});

test("cleanupCodexSessionWorktrees removes only old clean worktrees", async () => {
  execGit(workspacePath, ["add", "README.md"]);
  execGit(workspacePath, ["-c", "user.name=Echo Test", "-c", "user.email=echo@example.test", "commit", "-m", "checkpoint"]);

  const clean = await prepareCodexSessionWorktree({
    id: "cmd-clean",
    sessionId: "session-clean-worktree",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "clean" }
  });
  const dirty = await prepareCodexSessionWorktree({
    id: "cmd-dirty",
    sessionId: "session-dirty-worktree",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "dirty" }
  });

  fs.writeFileSync(path.join(dirty.execution.path, "DIRTY.md"), "keep me\n", "utf8");
  const future = Date.now() + 15 * 24 * 60 * 60 * 1000;
  const result = await cleanupCodexSessionWorktrees({ nowMs: future, retentionDays: 14 });

  assert.equal(result.removed >= 1, true);
  assert.equal(result.skippedDirty >= 1, true);
  assert.equal(fs.existsSync(clean.execution.path), false);
  assert.equal(fs.existsSync(dirty.execution.path), true);
});

test("applyCodexSessionWorktree copies changed files back to a clean base workspace", async () => {
  execGit(workspacePath, ["reset", "--hard"]);
  execGit(workspacePath, ["clean", "-fd"]);

  const prepared = await prepareCodexSessionWorktree({
    id: "cmd-apply",
    sessionId: "session-apply-worktree",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "apply" }
  });

  fs.appendFileSync(path.join(prepared.execution.path, "README.md"), "applied from worktree\n", "utf8");
  fs.writeFileSync(path.join(prepared.execution.path, "NEW.md"), "new from worktree\n", "utf8");

  const result = await applyCodexSessionWorktree({
    ...prepared,
    type: "worktree",
    payload: { action: "apply" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.execution.cleanupState, "applied");
  assert.equal(result.execution.lifecycleState, "applied");
  assert.match(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8"), /applied from worktree/);
  assert.equal(fs.readFileSync(path.join(workspacePath, "NEW.md"), "utf8"), "new from worktree\n");
  assert.equal(result.events[0].type, "worktree.applied");

  const repeated = await applyCodexSessionWorktree({ ...prepared, execution: result.execution, type: "worktree" });
  assert.equal(repeated.idempotent, true);
  assert.deepEqual(repeated.events, []);
});

test("applyCodexSessionWorktree includes changes committed inside the isolated branch", async () => {
  resetWorkspace();
  const prepared = await prepareCodexSessionWorktree(worktreeStart("session-committed-change"));
  fs.writeFileSync(path.join(prepared.execution.path, "COMMITTED.md"), "committed in worktree\n", "utf8");
  execGit(prepared.execution.path, ["add", "COMMITTED.md"]);
  commit(prepared.execution.path, "commit isolated change");

  const result = await applyCodexSessionWorktree({ ...prepared, type: "worktree" });
  assert.equal(result.operationSucceeded ?? true, true);
  assert.equal(fs.readFileSync(path.join(workspacePath, "COMMITTED.md"), "utf8"), "committed in worktree\n");
});

test("applyCodexSessionWorktree blocks an advanced base without modifying files", async () => {
  resetWorkspace();
  const prepared = await prepareCodexSessionWorktree(worktreeStart("session-base-advanced"));
  fs.appendFileSync(path.join(prepared.execution.path, "README.md"), "isolated change\n", "utf8");
  fs.writeFileSync(path.join(workspacePath, "BASE.md"), "base commit\n", "utf8");
  execGit(workspacePath, ["add", "BASE.md"]);
  commit(workspacePath, "advance base");

  const before = fs.readFileSync(path.join(workspacePath, "README.md"), "utf8");
  const result = await applyCodexSessionWorktree({ ...prepared, type: "worktree" });

  assert.equal(result.operationSucceeded, false);
  assert.equal(result.execution.lifecycleState, "apply-blocked");
  assert.equal(result.execution.errorCode, "base-advanced");
  assert.equal(fs.readFileSync(path.join(workspacePath, "README.md"), "utf8"), before);
  assert.equal(result.events[0].raw.worktree.path, undefined);
  assert.equal(result.events[0].raw.worktree.basePath, undefined);
});

test("applyCodexSessionWorktree distinguishes diverged and dirty bases", async () => {
  resetWorkspace();
  const prepared = await prepareCodexSessionWorktree(worktreeStart("session-base-diverged"));
  fs.appendFileSync(path.join(prepared.execution.path, "README.md"), "isolated change\n", "utf8");
  execGit(workspacePath, ["reset", "--hard", "HEAD~1"]);
  fs.writeFileSync(path.join(workspacePath, "DIVERGED.md"), "new history\n", "utf8");
  execGit(workspacePath, ["add", "DIVERGED.md"]);
  commit(workspacePath, "diverge base");
  const diverged = await applyCodexSessionWorktree({ ...prepared, type: "worktree" });
  assert.equal(diverged.execution.errorCode, "base-diverged");

  execGit(workspacePath, ["reset", "--hard", prepared.execution.baseCommit]);
  fs.appendFileSync(path.join(workspacePath, "README.md"), "dirty base\n", "utf8");
  const dirty = await applyCodexSessionWorktree({ ...prepared, type: "worktree", execution: prepared.execution });
  assert.equal(dirty.execution.errorCode, "dirty-base");
});

test("applyCodexSessionWorktree rejects ownership and managed-root mismatches", async () => {
  resetWorkspace();
  const prepared = await prepareCodexSessionWorktree({ ...worktreeStart("session-owned"), desktopAgentId: "agent-a" });
  await assert.rejects(
    () => applyCodexSessionWorktree({ ...prepared, desktopAgentId: "agent-b", type: "worktree" }),
    /different desktop agent/
  );
  await assert.rejects(
    () => applyCodexSessionWorktree({ ...prepared, type: "worktree", execution: { ...prepared.execution, path: workspacePath } }),
    /outside the desktop-controlled/
  );
});

test("discardCodexSessionWorktree removes the isolated worktree", async () => {
  resetWorkspace();

  const prepared = await prepareCodexSessionWorktree({
    id: "cmd-discard",
    sessionId: "session-discard-worktree",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "discard" }
  });
  fs.writeFileSync(path.join(prepared.execution.path, "THROWAWAY.md"), "discard me\n", "utf8");

  const result = await discardCodexSessionWorktree({
    ...prepared,
    type: "worktree",
    payload: { action: "discard" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.execution.cleanupState, "discarded");
  assert.equal(result.execution.lifecycleState, "discarded");
  assert.equal(fs.existsSync(prepared.execution.path), false);
  assert.equal(result.events[0].type, "worktree.discarded");

  const metadata = await readCodexSessionWorktreeMetadata("demo", "session-discard-worktree");
  assert.equal(metadata.lifecycleState, "discarded");
  assert.equal(metadata.cleanupState, "discarded");
  assert.ok(metadata.discardedAt);

  const repeated = await discardCodexSessionWorktree({ ...prepared, execution: result.execution, type: "worktree" });
  assert.equal(repeated.idempotent, true);
});

test("prepareCodexSessionWorktree rejects unavailable or closed session worktrees instead of creating a second one", async () => {
  execGit(workspacePath, ["reset", "--hard"]);
  execGit(workspacePath, ["clean", "-fd"]);

  const prepared = await prepareCodexSessionWorktree({
    id: "cmd-unavailable",
    sessionId: "session-unavailable-worktree",
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "isolate" }
  });

  await assert.rejects(
    () =>
      prepareCodexSessionWorktree({
        ...prepared,
        id: "cmd-wrong-session-follow-up",
        type: "message",
        execution: { ...prepared.execution, sessionId: "some-other-session" },
        payload: { text: "continue" }
      }),
    /not owned/
  );

  await assert.rejects(
    () =>
      prepareCodexSessionWorktree({
        ...prepared,
        id: "cmd-applied-follow-up",
        type: "message",
        execution: { ...prepared.execution, lifecycleState: "applied", appliedAt: new Date().toISOString() },
        payload: { text: "continue" }
      }),
    /already been applied/
  );

  await assert.rejects(
    () =>
      prepareCodexSessionWorktree({
        ...prepared,
        id: "cmd-discarded-follow-up",
        type: "message",
        execution: { ...prepared.execution, lifecycleState: "discarded", discardedAt: new Date().toISOString() },
        payload: { text: "continue" }
      }),
    /discarded/
  );

  fs.rmSync(prepared.execution.path, { recursive: true, force: true });
  await assert.rejects(
    () =>
      prepareCodexSessionWorktree({
        ...prepared,
        id: "cmd-missing-follow-up",
        type: "message",
        execution: prepared.execution,
        payload: { text: "continue" }
      }),
    /no longer available/
  );

  const metadata = await readCodexSessionWorktreeMetadata("demo", "session-unavailable-worktree");
  assert.equal(metadata.lifecycleState, "unavailable");
});

test("summarizeGitWorkspace reports changed files and diff stats", async () => {
  const repoPath = path.join(tempRoot, "summary-repo");
  initRepo(repoPath);
  fs.appendFileSync(path.join(repoPath, "README.md"), "changed\n", "utf8");

  const summary = await summarizeGitWorkspace(repoPath);
  assert.equal(summary.changedFiles.includes("README.md"), true);
  assert.match(summary.diffStat, /README\.md/);
  assert.match(formatGitSummary(summary), /Changed files: 1/);
});

test("summarizeGitWorkspace reports changes made after a turn baseline", async () => {
  const repoPath = path.join(tempRoot, "baseline-summary-repo");
  initRepo(repoPath);

  const baseline = await gitWorkspaceSnapshot(repoPath);
  fs.appendFileSync(path.join(repoPath, "README.md"), "changed during turn\n", "utf8");
  fs.writeFileSync(path.join(repoPath, "NEW.md"), "new file\n", "utf8");

  const summary = await summarizeGitWorkspace(repoPath, { baseline });
  assert.equal(summary.baseline.commit, baseline.commit);
  assert.equal(summary.changedDuringTurn.changedFiles.includes("README.md"), true);
  assert.equal(summary.changedDuringTurn.changedFiles.includes("NEW.md"), true);
  assert.equal(summary.changedDuringTurn.commitChanged, false);
  assert.equal(summary.changedFileCount, 2);
  assert.match(formatGitSummary(summary), /Changed this turn: 2/);
});

function initRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  execGit(repoPath, ["init"]);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# demo\n", "utf8");
  execGit(repoPath, ["add", "README.md"]);
  execGit(repoPath, ["-c", "user.name=Echo Test", "-c", "user.email=echo@example.test", "commit", "-m", "init"]);
}

function resetWorkspace() {
  execGit(workspacePath, ["reset", "--hard"]);
  execGit(workspacePath, ["clean", "-fd"]);
}

function worktreeStart(sessionId) {
  return {
    id: `cmd-${sessionId}`,
    sessionId,
    type: "start",
    projectId: "demo",
    runtime: { worktreeMode: "always" },
    payload: { prompt: "isolate" }
  };
}

function commit(repoPath, message) {
  execGit(repoPath, ["-c", "user.name=Echo Test", "-c", "user.email=echo@example.test", "commit", "-m", message]);
}

function execGit(repoPath, args) {
  return execFileSync("git", args, {
    cwd: repoPath,
    stdio: "ignore"
  });
}
