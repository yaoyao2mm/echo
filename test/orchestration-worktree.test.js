import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyOrchestrationIntegration,
  cleanupOrchestrationWorktree,
  completeOrchestrationIntegrationRepair,
  finalizeOrchestrationChangeWorktree,
  integrateOrchestrationCommit,
  materializeOrchestrationChangeSnapshot,
  prepareOrchestrationChangeWorktree,
  prepareOrchestrationIntegrationWorktree,
  prepareOrchestrationWorktreeDependencies
} from "../src/lib/orchestrationWorktree.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-orchestration-git-"));
  const workspacePath = path.join(root, "workspace");
  const managedRoot = path.join(root, "managed");
  fs.mkdirSync(workspacePath, { recursive: true });
  git(workspacePath, "init", "-b", "main");
  git(workspacePath, "config", "user.email", "echo@example.test");
  git(workspacePath, "config", "user.name", "Echo Test");
  fs.writeFileSync(path.join(workspacePath, "base.txt"), "base\n");
  git(workspacePath, "add", ".");
  git(workspacePath, "commit", "-m", "base");
  const baseCommit = git(workspacePath, "rev-parse", "HEAD");
  return {
    root,
    workspacePath,
    managedRoot,
    baseCommit,
    identity: {
      desktopAgentId: "desktop-a",
      projectId: "echo",
      runId: "run-1",
      workspacePath,
      managedRoot,
      baseBranch: "main",
      baseCommit
    }
  };
}

function checkoutState(workspacePath) {
  return {
    head: git(workspacePath, "rev-parse", "HEAD"),
    branch: git(workspacePath, "branch", "--show-current"),
    status: git(workspacePath, "status", "--porcelain")
  };
}

function commitFile(worktreePath, name, content, message) {
  fs.writeFileSync(path.join(worktreePath, name), content);
  git(worktreePath, "add", name);
  git(worktreePath, "commit", "-m", message);
  return git(worktreePath, "rev-parse", "HEAD");
}

test("Change and Integration Worktrees preserve the current checkout and integrate in stable order", async () => {
  const fixture = createRepository();
  const before = checkoutState(fixture.workspacePath);
  try {
    const changeA = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    const changeB = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-b" });
    const integration = await prepareOrchestrationIntegrationWorktree(fixture.identity);
    assert.equal(changeA.baseCommit, fixture.baseCommit);
    assert.equal(changeB.baseCommit, fixture.baseCommit);
    assert.match(integration.branchName, /^echo\/orchestration-/);

    const commitA = commitFile(changeA.path, "a.txt", "A\n", "change a");
    const commitB = commitFile(changeB.path, "b.txt", "B\n", "change b");
    const resultA = await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-a", commit: commitA });
    const resultB = await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-b", commit: commitB });
    assert.equal(resultA.ok, true);
    assert.equal(resultB.ok, true);
    assert.equal(fs.readFileSync(path.join(integration.path, "a.txt"), "utf8"), "A\n");
    assert.equal(fs.readFileSync(path.join(integration.path, "b.txt"), "utf8"), "B\n");
    assert.deepEqual(resultB.appliedCommits.map((entry) => entry.sourceItemId), ["item-a", "item-b"]);

    const duplicate = await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-b", commit: commitB });
    assert.equal(duplicate.idempotent, true);
    assert.deepEqual(checkoutState(fixture.workspacePath), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("completed integration fast-forwards the unchanged base checkout", async () => {
  const fixture = createRepository();
  try {
    const change = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    await prepareOrchestrationIntegrationWorktree(fixture.identity);
    const sourceCommit = commitFile(change.path, "result.txt", "done\n", "change result");
    const integrated = await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-a", commit: sourceCommit });

    const applied = await applyOrchestrationIntegration(fixture.identity);

    assert.equal(applied.ok, true);
    assert.equal(applied.commit, integrated.integrationCommit);
    assert.equal(checkoutState(fixture.workspacePath).head, integrated.integrationCommit);
    assert.equal(fs.readFileSync(path.join(fixture.workspacePath, "result.txt"), "utf8"), "done\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a validated change without a commit reports a deterministic no-result error", async () => {
  const fixture = createRepository();
  try {
    await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    await assert.rejects(
      () => finalizeOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" }),
      (error) => error?.code === "WORKTREE_NO_CHANGES" && /already be implemented/i.test(error.message)
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("untracked OpenSpec changes are snapshotted into Worktrees and safely integrated", async () => {
  const fixture = createRepository();
  const changePath = path.join(fixture.workspacePath, "openspec", "changes", "untracked-change");
  fs.mkdirSync(changePath, { recursive: true });
  fs.writeFileSync(path.join(changePath, "proposal.md"), "# Untracked change\n");
  fs.writeFileSync(path.join(changePath, "tasks.md"), "- [ ] Implement it\n");
  fs.writeFileSync(path.join(fixture.workspacePath, "local-notes.txt"), "preserve me\n");

  try {
    const change = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-untracked" });
    const snapshot = await materializeOrchestrationChangeSnapshot({
      ...fixture.identity,
      itemId: "item-untracked",
      changeId: "untracked-change",
      fingerprint: "fingerprint-a"
    });
    assert.equal(snapshot.changeSnapshot.changeId, "untracked-change");
    assert.equal(fs.readFileSync(path.join(change.path, "openspec", "changes", "untracked-change", "proposal.md"), "utf8"), "# Untracked change\n");

    fs.writeFileSync(path.join(change.path, "openspec", "changes", "untracked-change", "tasks.md"), "- [x] Implement it\n");
    fs.writeFileSync(path.join(change.path, "result.txt"), "done\n");
    const finalized = await finalizeOrchestrationChangeWorktree({
      ...fixture.identity,
      itemId: "item-untracked",
      message: "apply untracked change"
    });
    await prepareOrchestrationIntegrationWorktree(fixture.identity);
    await integrateOrchestrationCommit({
      ...fixture.identity,
      sourceItemId: "item-untracked",
      commit: finalized.commit
    });

    const applied = await applyOrchestrationIntegration(fixture.identity);
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(path.join(fixture.workspacePath, "result.txt"), "utf8"), "done\n");
    assert.equal(fs.readFileSync(path.join(fixture.workspacePath, "local-notes.txt"), "utf8"), "preserve me\n");
    assert.match(git(fixture.workspacePath, "status", "--porcelain"), /\?\? local-notes\.txt/);
    assert.equal(git(fixture.workspacePath, "ls-files", "openspec/changes/untracked-change/tasks.md"), "openspec/changes/untracked-change/tasks.md");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a materialized change snapshot is frozen across retries", async () => {
  const fixture = createRepository();
  const changePath = path.join(fixture.workspacePath, "openspec", "changes", "frozen-change");
  fs.mkdirSync(changePath, { recursive: true });
  fs.writeFileSync(path.join(changePath, "tasks.md"), "- [ ] Original\n");
  try {
    const change = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-frozen" });
    await materializeOrchestrationChangeSnapshot({
      ...fixture.identity,
      itemId: "item-frozen",
      changeId: "frozen-change",
      fingerprint: "fingerprint-a"
    });
    fs.writeFileSync(path.join(changePath, "tasks.md"), "- [ ] Changed later\n");
    const repeated = await materializeOrchestrationChangeSnapshot({
      ...fixture.identity,
      itemId: "item-frozen",
      changeId: "frozen-change",
      fingerprint: "fingerprint-a"
    });
    assert.equal(repeated.idempotent, true);
    assert.equal(fs.readFileSync(path.join(change.path, "openspec", "changes", "frozen-change", "tasks.md"), "utf8"), "- [ ] Original\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("tracked OpenSpec changes with local edits are snapshotted and integrated", async () => {
  const fixture = createRepository();
  const changePath = path.join(fixture.workspacePath, "openspec", "changes", "tracked-dirty-change");
  fs.mkdirSync(changePath, { recursive: true });
  fs.writeFileSync(path.join(changePath, "tasks.md"), "- [ ] Baseline task\n");
  git(fixture.workspacePath, "add", ".");
  git(fixture.workspacePath, "commit", "-m", "add tracked change");
  fixture.baseCommit = git(fixture.workspacePath, "rev-parse", "HEAD");
  fixture.identity.baseCommit = fixture.baseCommit;
  fs.writeFileSync(path.join(changePath, "tasks.md"), "- [ ] Locally refined task\n");

  try {
    const change = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-tracked-dirty" });
    await materializeOrchestrationChangeSnapshot({
      ...fixture.identity,
      itemId: "item-tracked-dirty",
      changeId: "tracked-dirty-change",
      fingerprint: "fingerprint-a"
    });
    assert.equal(fs.readFileSync(path.join(change.path, "openspec", "changes", "tracked-dirty-change", "tasks.md"), "utf8"), "- [ ] Locally refined task\n");
    fs.writeFileSync(path.join(change.path, "openspec", "changes", "tracked-dirty-change", "tasks.md"), "- [x] Locally refined task\n");
    const finalized = await finalizeOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-tracked-dirty" });
    await prepareOrchestrationIntegrationWorktree(fixture.identity);
    await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-tracked-dirty", commit: finalized.commit });

    const applied = await applyOrchestrationIntegration(fixture.identity);
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(path.join(changePath, "tasks.md"), "utf8"), "- [x] Locally refined task\n");
    assert.equal(git(fixture.workspacePath, "status", "--porcelain"), "");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("integration refuses to overwrite a snapshotted change edited after the Run started", async () => {
  const fixture = createRepository();
  const changePath = path.join(fixture.workspacePath, "openspec", "changes", "changed-later");
  fs.mkdirSync(changePath, { recursive: true });
  fs.writeFileSync(path.join(changePath, "tasks.md"), "- [ ] Original\n");
  try {
    const change = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-changed-later" });
    await materializeOrchestrationChangeSnapshot({
      ...fixture.identity,
      itemId: "item-changed-later",
      changeId: "changed-later",
      fingerprint: "fingerprint-a"
    });
    fs.writeFileSync(path.join(change.path, "openspec", "changes", "changed-later", "tasks.md"), "- [x] Original\n");
    const finalized = await finalizeOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-changed-later" });
    await prepareOrchestrationIntegrationWorktree(fixture.identity);
    await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-changed-later", commit: finalized.commit });

    fs.writeFileSync(path.join(changePath, "tasks.md"), "- [ ] User changed it later\n");
    await assert.rejects(
      () => applyOrchestrationIntegration(fixture.identity),
      (error) => error.code === "BASE_CHANGE_SNAPSHOT_CHANGED"
    );
    assert.equal(fs.readFileSync(path.join(changePath, "tasks.md"), "utf8"), "- [ ] User changed it later\n");
    assert.equal(checkoutState(fixture.workspacePath).head, fixture.baseCommit);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("integration automatically follows a clean base branch that advanced", async () => {
  const fixture = createRepository();
  try {
    const change = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    await prepareOrchestrationIntegrationWorktree(fixture.identity);
    const sourceCommit = commitFile(change.path, "result.txt", "done\n", "change result");
    await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-a", commit: sourceCommit });

    commitFile(fixture.workspacePath, "unrelated.txt", "new base work\n", "advance main");
    const advancedHead = git(fixture.workspacePath, "rev-parse", "HEAD");
    const synchronized = await prepareOrchestrationIntegrationWorktree(fixture.identity);
    assert.equal(synchronized.lifecycleState, "ready");
    assert.equal(synchronized.integratedBaseCommit, advancedHead);

    const applied = await applyOrchestrationIntegration(fixture.identity);
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(path.join(fixture.workspacePath, "result.txt"), "utf8"), "done\n");
    assert.equal(fs.readFileSync(path.join(fixture.workspacePath, "unrelated.txt"), "utf8"), "new base work\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("advanced base conflicts resume through the orchestration repair flow", async () => {
  const fixture = createRepository();
  try {
    const change = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    const integration = await prepareOrchestrationIntegrationWorktree(fixture.identity);
    const sourceCommit = commitFile(change.path, "base.txt", "from change\n", "change base");
    await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-a", commit: sourceCommit });
    commitFile(fixture.workspacePath, "base.txt", "from main\n", "advance main with conflict");

    const conflict = await prepareOrchestrationIntegrationWorktree(fixture.identity);
    assert.equal(conflict.lifecycleState, "conflict");
    assert.deepEqual(conflict.conflictFiles, ["base.txt"]);

    fs.writeFileSync(path.join(integration.path, "base.txt"), "resolved automatically\n");
    git(integration.path, "add", "base.txt");
    const repaired = await completeOrchestrationIntegrationRepair(fixture.identity);
    assert.equal(repaired.ok, true);
    assert.equal(repaired.lifecycleState, "ready");

    const applied = await applyOrchestrationIntegration(fixture.identity);
    assert.equal(applied.ok, true);
    assert.equal(fs.readFileSync(path.join(fixture.workspacePath, "base.txt"), "utf8"), "resolved automatically\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("integration apply preserves overlapping uncommitted files", async () => {
  const fixture = createRepository();
  try {
    const change = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    await prepareOrchestrationIntegrationWorktree(fixture.identity);
    const sourceCommit = commitFile(change.path, "result.txt", "done\n", "change result");
    await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-a", commit: sourceCommit });
    fs.writeFileSync(path.join(fixture.workspacePath, "result.txt"), "local version\n");

    await assert.rejects(() => applyOrchestrationIntegration(fixture.identity), (error) => error.code === "INTEGRATION_APPLY_FAILED");
    assert.equal(checkoutState(fixture.workspacePath).head, fixture.baseCommit);
    assert.equal(fs.readFileSync(path.join(fixture.workspacePath, "result.txt"), "utf8"), "local version\n");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Integration conflicts are bounded and never modify the current checkout", async () => {
  const fixture = createRepository();
  const before = checkoutState(fixture.workspacePath);
  try {
    const changeA = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    const changeB = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-b" });
    await prepareOrchestrationIntegrationWorktree(fixture.identity);
    const commitA = commitFile(changeA.path, "base.txt", "from A\n", "change base a");
    const commitB = commitFile(changeB.path, "base.txt", "from B\n", "change base b");
    assert.equal((await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-a", commit: commitA })).ok, true);
    const conflict = await integrateOrchestrationCommit({ ...fixture.identity, sourceItemId: "item-b", commit: commitB });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, "INTEGRATION_CONFLICT");
    assert.deepEqual(conflict.conflictFiles, ["base.txt"]);
    assert.deepEqual(checkoutState(fixture.workspacePath), before);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Worktree owner metadata rejects mismatched identity and cleanup is explicit and idempotent", async () => {
  const fixture = createRepository();
  try {
    const worktree = await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    await assert.rejects(
      () => prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a", desktopAgentId: "desktop-b" }),
      /desktopAgentId does not match/
    );
    await assert.rejects(
      () => cleanupOrchestrationWorktree({ ...fixture.identity, itemId: "item-a", activeAttempt: true }),
      /active Attempt/
    );
    const cleaned = await cleanupOrchestrationWorktree({ ...fixture.identity, itemId: "item-a" });
    assert.equal(cleaned.lifecycleState, "cleaned");
    assert.equal(fs.existsSync(worktree.path), false);
    const duplicate = await cleanupOrchestrationWorktree({ ...fixture.identity, itemId: "item-a" });
    assert.equal(duplicate.idempotent, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("orchestration dependency setup is a safe no-op without a supported lockfile", async () => {
  const fixture = createRepository();
  try {
    await prepareOrchestrationChangeWorktree({ ...fixture.identity, itemId: "item-a" });
    const setup = await prepareOrchestrationWorktreeDependencies({ ...fixture.identity, itemId: "item-a", kind: "change" });
    assert.equal(setup.ok, true);
    assert.equal(setup.setupStatus, "skipped");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
