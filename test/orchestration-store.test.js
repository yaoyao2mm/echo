import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { OrchestrationStore, orchestrationLimits } from "../src/lib/orchestrationStore.js";

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-orchestration-store-"));
  const store = new OrchestrationStore({ dbPath: path.join(root, "echo.sqlite") });
  return {
    root,
    store,
    close() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function createRun(store, overrides = {}) {
  return store.createRun({
    ownerUser: "alice",
    targetAgentId: "desktop-a",
    projectId: "echo",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    runtimePolicy: { backendId: "codex", permissionMode: "edit", maxConcurrency: 2 },
    items: [
      { changeId: "change-a", title: "Change A", snapshot: { proposal: "A" } },
      { changeId: "change-b", title: "Change B", dependsOn: ["change-a"], snapshot: { proposal: "B" } }
    ],
    ...overrides
  });
}

test("orchestration migration appends the persistent Run model", () => {
  const fixture = createStore();
  try {
    const tables = new Set(fixture.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of [
      "orchestration_runs",
      "orchestration_items",
      "orchestration_attempts",
      "orchestration_dependencies",
      "orchestration_artifacts"
    ]) assert.equal(tables.has(table), true);
  } finally {
    fixture.close();
  }
});

test("Run creation fixes snapshots, ordering, dependencies, and base commit atomically", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store);
    assert.equal(run.status, "queued");
    assert.equal(run.baseCommit, "a".repeat(40));
    assert.deepEqual(run.items.map((item) => item.changeId), ["change-a", "change-b"]);
    assert.equal(run.items[0].status, "queued");
    assert.equal(run.items[1].status, "blocked");
    assert.deepEqual(run.items[1].dependsOn, ["change-a"]);
    assert.equal(run.items[0].snapshot.proposal, "A");
    assert.equal(run.runtimePolicy.worktreeMode, "always");

    assert.throws(
      () => createRun(fixture.store, {
        items: [
          { changeId: "a", dependsOn: ["b"] },
          { changeId: "b", dependsOn: ["a"] }
        ]
      }),
      /acyclic/
    );
  } finally {
    fixture.close();
  }
});

test("atomic claim respects dependency readiness and prevents duplicate Attempts", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store);
    const first = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-a" });
    assert.equal(first.itemId, run.items[0].id);
    assert.equal(first.attemptNumber, 1);
    assert.equal(fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-b" }), null);

    const renewed = fixture.store.renewAttemptLease(first.id, { leaseOwner: "worker-a" });
    assert.equal(renewed.status, "running");
    fixture.store.completeAttempt(first.id, { status: "succeeded", leaseOwner: "worker-a" });

    for (const artifact of [
      ["git-summary", "info"],
      ["validation", "passed"],
      ["verifier", "passed"]
    ]) {
      fixture.store.addArtifact({ runId: run.id, itemId: run.items[0].id, attemptId: first.id, kind: artifact[0], status: artifact[1] });
    }
    fixture.store.markItemReady(run.items[0].id, { commit: "b".repeat(40), verifierConclusion: "passed" });

    const second = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-b" });
    assert.equal(second.itemId, run.items[1].id);
  } finally {
    fixture.close();
  }
});

test("independent Items fill the advertised Run concurrency while dependencies remain blocked", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, {
      runtimePolicy: { backendId: "codex", permissionMode: "edit", maxConcurrency: 3 },
      items: [
        { changeId: "change-a", snapshot: {} },
        { changeId: "change-b", snapshot: {} },
        { changeId: "change-c", snapshot: {} },
        { changeId: "change-d", dependsOn: ["change-a"], snapshot: {} }
      ]
    });

    const claimed = ["worker-a", "worker-b", "worker-c"]
      .map((leaseOwner) => fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner }));

    assert.deepEqual(claimed.map((attempt) => attempt.itemId), run.items.slice(0, 3).map((item) => item.id));
    assert.equal(fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-d" }), null);
    assert.equal(fixture.store.getRun(run.id, { ownerUser: "alice" }).items[3].status, "blocked");
  } finally {
    fixture.close();
  }
});

test("pause, resume, cancel, and transient retry transitions are bounded and idempotent", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    assert.equal(fixture.store.controlRun(run.id, "pause", { ownerUser: "alice" }).status, "paused");
    assert.equal(fixture.store.controlRun(run.id, "pause", { ownerUser: "alice" }).status, "paused");
    assert.equal(fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" }), null);
    assert.equal(fixture.store.controlRun(run.id, "resume", { ownerUser: "alice" }).status, "running");

    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    fixture.store.completeAttempt(attempt.id, {
      status: "failed",
      leaseOwner: "worker",
      failureClass: "agent-failed",
      errorSummary: "temporary agent failure",
      retryable: false
    });
    let snapshot = fixture.store.getRun(run.id, { ownerUser: "alice" });
    assert.equal(snapshot.items[0].status, "attention");
    snapshot = fixture.store.retryItem(run.id, snapshot.items[0].id, { ownerUser: "alice" });
    assert.equal(snapshot.items[0].status, "queued");
    assert.equal(fixture.store.controlRun(run.id, "cancel", { ownerUser: "alice" }).status, "cancelled");
    assert.equal(fixture.store.controlRun(run.id, "cancel", { ownerUser: "alice" }).status, "cancelled");
  } finally {
    fixture.close();
  }
});

test("deterministic orchestration failures cannot be retried", () => {
  const fixture = createStore();
  try {
    const run = fixture.store.createRun({
      ownerUser: "alice",
      targetAgentId: "desktop-a",
      projectId: "echo",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      items: [{ changeId: "already-done", snapshot: {} }]
    });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    fixture.store.completeAttempt(attempt.id, {
      status: "failed",
      leaseOwner: "worker",
      failureClass: "worktree-no-changes",
      errorSummary: "No committed result.",
      retryable: false
    });
    assert.throws(
      () => fixture.store.retryItem(run.id, run.items[0].id, { ownerUser: "alice" }),
      /needs Agent recovery/i
    );
    const snapshot = fixture.store.getRun(run.id, { ownerUser: "alice" });
    assert.deepEqual(snapshot.items[0].availableActions, ["recover", "finish-run"]);
  } finally {
    fixture.close();
  }
});

test("deterministic validation failures use bounded Agent recovery and can finish the Run", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    fixture.store.completeAttempt(attempt.id, {
      status: "failed",
      leaseOwner: "worker",
      failureClass: "validation-failed",
      errorSummary: "two project-specific checks still fail",
      retryable: false
    });

    let snapshot = fixture.store.getRun(run.id, { ownerUser: "alice" });
    assert.deepEqual(snapshot.items[0].availableActions, ["recover", "finish-run"]);
    assert.equal(snapshot.items[0].availableActions.includes("retry"), false);
    assert.deepEqual(snapshot.availableActions, ["finish"]);

    snapshot = fixture.store.recoverItem(run.id, run.items[0].id, { ownerUser: "alice" });
    assert.equal(snapshot.items[0].status, "queued");
    const recovery = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "recovery-worker" });
    assert.equal(recovery.kind, "repair");

    snapshot = fixture.store.controlRun(run.id, "finish", { ownerUser: "alice" });
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.desiredState, "cancelled");
    assert.deepEqual(snapshot.availableActions, []);
    assert.equal(fixture.store.listRuns({ ownerUser: "alice", activeOnly: true }).length, 0);
    assert.equal(fixture.store.controlRun(run.id, "finish", { ownerUser: "alice" }).status, "failed");
  } finally {
    fixture.close();
  }
});

test("resuming a Run with attention Items does not advertise false execution progress", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    fixture.store.completeAttempt(attempt.id, {
      status: "failed",
      leaseOwner: "worker",
      failureClass: "validation-failed",
      errorSummary: "deterministic check failed",
      retryable: false
    });
    fixture.store.controlRun(run.id, "pause", { ownerUser: "alice" });

    const resumed = fixture.store.controlRun(run.id, "resume", { ownerUser: "alice" });

    assert.equal(resumed.desiredState, "running");
    assert.equal(resumed.status, "attention");
    assert.equal(resumed.items[0].status, "attention");
    assert.deepEqual(resumed.availableActions, ["finish"]);
    assert.deepEqual(resumed.items[0].availableActions, ["recover", "finish-run"]);
    assert.equal(fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-2" }), null);
  } finally {
    fixture.close();
  }
});

test("scheduler reconciliation repairs legacy running Runs with attention Items", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    fixture.store.completeAttempt(attempt.id, {
      status: "failed",
      leaseOwner: "worker",
      failureClass: "validation-failed",
      errorSummary: "deterministic check failed",
      retryable: false
    });
    fixture.store.db.prepare("UPDATE orchestration_runs SET status = 'running', desired_state = 'running' WHERE id = ?").run(run.id);

    const repairedIds = fixture.store.reconcileRunStatuses();

    assert.deepEqual(repairedIds, [run.id]);
    const repaired = fixture.store.getRun(run.id);
    assert.equal(repaired.status, "attention");
    assert.deepEqual(repaired.items[0].availableActions, ["recover", "finish-run"]);
    assert.deepEqual(fixture.store.reconcileRunStatuses(), []);
  } finally {
    fixture.close();
  }
});

test("expired leases automatically reclaim the same Attempt without a duplicate write claim", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker", leaseMs: 10_000 });
    assert.equal(fixture.store.reconcileExpiredLeases({ now: "2999-01-01T00:00:00.000Z" }), 1);
    const snapshot = fixture.store.getRun(run.id, { ownerUser: "alice" });
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.items[0].status, "preparing");
    assert.equal(snapshot.items[0].attempts[0].status, "reconciling");
    assert.equal(attempt.id, snapshot.items[0].currentAttemptId);
    assert.equal(fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-2" }), null);
    const reclaimed = fixture.store.claimReconciliation({ targetAgentId: "desktop-a", leaseOwner: "worker-2" });
    assert.equal(reclaimed.id, attempt.id);
    assert.equal(reclaimed.kind, "implement");
    assert.equal(reclaimed.leaseOwner, "worker-2");
  } finally {
    fixture.close();
  }
});

test("Attempt Session binding renews ownership and integration completes only after every Item is ready", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    const bound = fixture.store.bindAttemptSession(attempt.id, { leaseOwner: "worker", sessionId: "session-a" });
    assert.equal(bound.sessionId, "session-a");
    assert.equal(fixture.store.renewAttemptLease(attempt.id, { leaseOwner: "worker" }).status, "running");
    assert.throws(() => fixture.store.bindAttemptSession(attempt.id, { leaseOwner: "other", sessionId: "session-b" }), /lease owner/);
    fixture.store.completeAttempt(attempt.id, { status: "succeeded", leaseOwner: "worker" });
    for (const [kind, status] of [["git-summary", "info"], ["validation", "passed"], ["verifier", "passed"]]) {
      fixture.store.addArtifact({ runId: run.id, itemId: run.items[0].id, attemptId: attempt.id, kind, status });
    }
    fixture.store.markItemReady(run.items[0].id, { commit: "b".repeat(40), verifierConclusion: "passed" });
    assert.equal(fixture.store.getRun(run.id).progress.completed, 1);
    assert.equal(fixture.store.getRun(run.id).progress.integrated, 0);
    const integration = fixture.store.claimIntegration({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    assert.equal(integration.kind, "integrate");
    const completed = fixture.store.completeIntegration(integration.id, {
      leaseOwner: "worker",
      ok: true,
      branch: "echo/orchestration-run",
      commit: "c".repeat(40),
      validationSummary: "passed"
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.items[0].status, "completed");
    assert.equal(completed.progress.integrated, 1);
    assert.equal(completed.result.commit, "c".repeat(40));
  } finally {
    fixture.close();
  }
});

test("integration claims mixed completed and ready Items without replaying completed work", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store);
    const first = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-a" });
    fixture.store.reconcileBaseline(first.id, {
      leaseOwner: "worker-a",
      completedChangeIds: ["change-a"],
      branch: "main",
      commit: "c".repeat(40)
    });
    const second = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-b" });
    fixture.store.completeAttempt(second.id, { status: "succeeded", leaseOwner: "worker-b" });
    for (const [kind, status] of [["git-summary", "info"], ["validation", "passed"], ["verifier", "passed"]]) {
      fixture.store.addArtifact({ runId: run.id, itemId: run.items[1].id, attemptId: second.id, kind, status });
    }
    fixture.store.markItemReady(run.items[1].id, { commit: "d".repeat(40), verifierConclusion: "passed" });

    const before = fixture.store.getRun(run.id);
    assert.deepEqual(before.items.map((item) => item.status), ["completed", "ready"]);
    const integration = fixture.store.claimIntegration({ targetAgentId: "desktop-a", leaseOwner: "worker-c" });
    assert.equal(integration.kind, "integrate");

    const completed = fixture.store.completeIntegration(integration.id, {
      leaseOwner: "worker-c",
      ok: true,
      branch: "echo/orchestration-run",
      commit: "e".repeat(40),
      validationSummary: "passed"
    });
    assert.deepEqual(completed.items.map((item) => item.status), ["completed", "completed"]);
    assert.equal(completed.status, "completed");
  } finally {
    fixture.close();
  }
});

test("resuming a failed Integration makes ready Items claimable again", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-a" });
    fixture.store.completeAttempt(attempt.id, { status: "succeeded", leaseOwner: "worker-a" });
    for (const [kind, status] of [["git-summary", "info"], ["validation", "passed"], ["verifier", "passed"]]) {
      fixture.store.addArtifact({ runId: run.id, itemId: run.items[0].id, attemptId: attempt.id, kind, status });
    }
    fixture.store.markItemReady(run.items[0].id, { commit: "b".repeat(40), verifierConclusion: "passed" });
    const firstIntegration = fixture.store.claimIntegration({ targetAgentId: "desktop-a", leaseOwner: "worker-b" });
    fixture.store.completeIntegration(firstIntegration.id, {
      leaseOwner: "worker-b",
      ok: false,
      failureClass: "integration-conflict",
      errorSummary: "conflict"
    });
    fixture.store.controlRun(run.id, "pause", { ownerUser: "alice" });

    const resumed = fixture.store.controlRun(run.id, "resume", { ownerUser: "alice" });
    assert.equal(resumed.status, "running");
    assert.equal(resumed.items[0].status, "ready");
    assert.equal(fixture.store.claimIntegration({ targetAgentId: "desktop-a", leaseOwner: "worker-c" }).kind, "integrate");
  } finally {
    fixture.close();
  }
});

test("integration does not claim an already completed Run", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-a" });
    fixture.store.reconcileBaseline(attempt.id, {
      leaseOwner: "worker-a",
      completedChangeIds: ["change-a"],
      branch: "main",
      commit: "c".repeat(40)
    });

    assert.equal(fixture.store.getRun(run.id).status, "completed");
    assert.equal(fixture.store.claimIntegration({ targetAgentId: "desktop-a", leaseOwner: "worker-b" }), null);
  } finally {
    fixture.close();
  }
});

test("desktop baseline reconciliation completes already-integrated Items and terminates their Attempts", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store);
    const first = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-a" });
    const reconciledFirst = fixture.store.reconcileBaseline(first.id, {
      leaseOwner: "worker-a",
      completedChangeIds: ["change-a"],
      branch: "main",
      commit: "c".repeat(40)
    });
    assert.equal(reconciledFirst.items[0].status, "completed");
    assert.equal(reconciledFirst.items[0].attempts[0].status, "succeeded");
    assert.equal(reconciledFirst.items[1].status, "blocked");
    assert.equal(reconciledFirst.progress.completed, 1);

    const second = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-b" });
    const completed = fixture.store.reconcileBaseline(second.id, {
      leaseOwner: "worker-b",
      completedChangeIds: ["change-a", "change-b"],
      branch: "main",
      commit: "d".repeat(40)
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.progress.completed, 2);
    assert.equal(completed.result.branch, "main");
    assert.equal(completed.result.commit, "d".repeat(40));
  } finally {
    fixture.close();
  }
});

test("unrecoverable cleaned Worktree stops the Run instead of being reclaimed forever", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    const stopped = fixture.store.reconcileBaseline(attempt.id, {
      leaseOwner: "worker",
      unavailable: true,
      errorSummary: "The managed Worktree was cleaned before integration."
    });
    assert.equal(stopped.status, "attention");
    assert.equal(stopped.items[0].status, "attention");
    assert.equal(stopped.items[0].attempts[0].status, "failed");
    assert.equal(fixture.store.claimReconciliation({ targetAgentId: "desktop-a", leaseOwner: "worker-2" }), null);
    assert.equal(fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker-2" }), null);
  } finally {
    fixture.close();
  }
});

test("a late successful Attempt cannot revive a cancelled Run", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const attempt = fixture.store.claimNextItem({ targetAgentId: "desktop-a", leaseOwner: "worker" });
    fixture.store.controlRun(run.id, "cancel", { ownerUser: "alice" });
    const completed = fixture.store.completeAttempt(attempt.id, { status: "succeeded", leaseOwner: "worker" });
    assert.equal(completed.status, "cancelled");
    const snapshot = fixture.store.getRun(run.id, { ownerUser: "alice" });
    assert.equal(snapshot.status, "cancelled");
    assert.equal(snapshot.items[0].status, "cancelled");
  } finally {
    fixture.close();
  }
});

test("Artifact normalization truncates secret-heavy unbounded payloads", () => {
  const fixture = createStore();
  try {
    const run = createRun(fixture.store, { items: [{ changeId: "change-a" }] });
    const artifact = fixture.store.addArtifact({
      runId: run.id,
      itemId: run.items[0].id,
      kind: "validation",
      status: "failed",
      summary: "s".repeat(orchestrationLimits.maxArtifactSummaryLength + 100),
      data: { raw: "x".repeat(orchestrationLimits.maxArtifactDataLength + 100) }
    });
    assert.equal(artifact.summary.length, orchestrationLimits.maxArtifactSummaryLength);
    assert.equal(artifact.data.truncated, true);
  } finally {
    fixture.close();
  }
});

test("migration is compatible with an existing Echo SQLite database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-orchestration-migrate-"));
  const dbPath = path.join(root, "echo.sqlite");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE existing_data (id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO existing_data VALUES ('keep', 'yes');");
  db.close();
  const store = new OrchestrationStore({ dbPath });
  try {
    assert.equal(store.db.prepare("SELECT value FROM existing_data WHERE id = 'keep'").get().value, "yes");
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'orchestration_runs'").get().name, "orchestration_runs");
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
