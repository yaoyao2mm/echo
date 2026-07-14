import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-orchestration-service-"));
process.env.HOME = tempHome;
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";

const { OrchestrationStore } = await import("../src/lib/orchestrationStore.js");
const service = await import("../src/lib/orchestrationService.js");
const codexStore = await import("../src/lib/codexStore.js");
const codexQueue = await import("../src/lib/codexQueue.js");

test("orchestration service binds a managed Worktree Session and converges through integration", () => {
  codexStore.resetStoreForTest();
  codexQueue.updateCodexAgent({
    id: "desktop-a",
    ownerUser: "alice",
    workspaces: [{ id: "echo", path: "/workspace/echo" }],
    runtime: { backendId: "codex", allowedPermissionModes: ["strict", "approve", "full"] }
  });
  const store = new OrchestrationStore({ dbPath: path.join(tempHome, "orchestration.sqlite") });
  service.setOrchestrationStoreForTest(store);
  try {
    const run = service.createOrchestrationRun({
      ownerUser: "alice",
      targetAgentId: "desktop-a",
      projectId: "echo",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      runtimePolicy: { backendId: "codex", permissionMode: "approve", maxConcurrency: 1 },
      items: [{ changeId: "change-a", snapshot: { proposal: "A" } }]
    });
    const work = service.claimOrchestrationWork({ targetAgentId: "desktop-a", leaseOwner: "desktop-a:worker" });
    const session = service.createOrchestrationAttemptSession(work.attempt.id, {
      agentId: "desktop-a",
      leaseOwner: "desktop-a:worker",
      execution: {
        path: "/managed/change-a",
        basePath: "/workspace/echo",
        branchName: "echo/orchestration-change-a"
      }
    });
    assert.equal(session.execution.ownerType, "orchestration");
    assert.equal(session.execution.runId, run.id);
    assert.equal(session.execution.itemId, run.items[0].id);
    assert.equal(session.execution.desktopAgentId, "desktop-a");
    assert.match(session.title, /apply OpenSpec change/i);

    const command = codexStore.acquireNextSessionCommand({
      agentId: "desktop-a",
      agentInstanceId: "desktop-instance-a",
      workspaces: [{ id: "echo" }]
    });
    assert.equal(command.sessionId, session.id);
    assert.match(JSON.stringify(command.payload), /纯人工、浏览器、移动端或视觉验收/);
    assert.equal(codexStore.completeSessionCommand(command.id, {
      ok: true,
      sessionStatus: "active",
      execution: {
        mode: "worktree",
        lifecycleState: "completed",
        sessionId: session.id,
        branchName: session.execution.branchName
      }
    }, {
      agentId: "desktop-a",
      agentInstanceId: "desktop-instance-a"
    }), true);
    const completedSession = codexStore.getSession(session.id);
    assert.equal(completedSession.execution.ownerType, "orchestration");
    assert.equal(completedSession.execution.runId, run.id);
    assert.equal(completedSession.execution.itemId, run.items[0].id);

    assert.throws(
      () => codexQueue.queueCodexSessionWorktreeAction(session.id, { action: "apply" }),
      /applied automatically by their Run/
    );
    assert.equal(service.orchestrationAttemptSession(work.attempt.id, { agentId: "desktop-b", leaseOwner: "desktop-a:worker" }).id, session.id);
    assert.equal(service.orchestrationAttemptSession(work.attempt.id, { agentId: "desktop-a", leaseOwner: "stale-worker" }), null);

    for (const [kind, status] of [["git-summary", "info"], ["validation", "passed"], ["verifier", "passed"]]) {
      service.addOrchestrationArtifact({ runId: run.id, itemId: run.items[0].id, attemptId: work.attempt.id, kind, status });
    }
    service.completeOrchestrationAttempt(work.attempt.id, {
      agentId: "desktop-a",
      leaseOwner: "desktop-a:worker",
      status: "succeeded",
      sessionId: session.id
    });
    service.markOrchestrationItemReady(run.items[0].id, { commit: "b".repeat(40), verifierConclusion: "passed" });

    const integration = service.claimOrchestrationWork({ targetAgentId: "desktop-a", leaseOwner: "desktop-a:worker" });
    assert.equal(integration.attempt.kind, "integrate");
    const completed = service.completeOrchestrationIntegration(integration.attempt.id, {
      agentId: "desktop-a",
      leaseOwner: "desktop-a:worker",
      ok: true,
      branch: "echo/orchestration-run",
      commit: "c".repeat(40),
      validationSummary: "passed"
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.branch, "echo/orchestration-run");
  } finally {
    service.setOrchestrationStoreForTest(null);
    store.close();
  }
});

test("cancelling an orchestration Run interrupts its active Session", () => {
  codexStore.resetStoreForTest();
  codexQueue.updateCodexAgent({
    id: "desktop-cancel",
    ownerUser: "alice",
    workspaces: [{ id: "echo", path: "/workspace/echo" }],
    runtime: { backendId: "codex", allowedPermissionModes: ["strict", "approve", "full"] }
  });
  const store = new OrchestrationStore({ dbPath: path.join(tempHome, "orchestration-cancel.sqlite") });
  service.setOrchestrationStoreForTest(store);
  try {
    const run = service.createOrchestrationRun({
      ownerUser: "alice",
      targetAgentId: "desktop-cancel",
      projectId: "echo",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      runtimePolicy: { backendId: "codex", permissionMode: "approve", maxConcurrency: 1 },
      items: [{ changeId: "change-cancel", snapshot: { proposal: "Cancel" } }]
    });
    const work = service.claimOrchestrationWork({ targetAgentId: "desktop-cancel", leaseOwner: "desktop-cancel:worker" });
    const session = service.createOrchestrationAttemptSession(work.attempt.id, {
      agentId: "desktop-cancel",
      leaseOwner: "desktop-cancel:worker",
      execution: {
        path: "/managed/change-cancel",
        basePath: "/workspace/echo",
        branchName: "echo/orchestration-change-cancel"
      }
    });
    assert.equal(session.status, "queued");

    const cancelled = service.controlOrchestrationRun(run.id, "cancel", { ownerUser: "alice" });

    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.items[0].attempts[0].status, "cancelled");
    assert.equal(codexStore.getSession(session.id).status, "cancelled");
  } finally {
    service.setOrchestrationStoreForTest(null);
    store.close();
  }
});

test("reconciliation automatically reclaims the same Attempt and Session", () => {
  codexStore.resetStoreForTest();
  codexQueue.updateCodexAgent({
    id: "desktop-repair",
    ownerUser: "alice",
    workspaces: [{ id: "echo", path: "/workspace/echo" }],
    runtime: { backendId: "codex", allowedPermissionModes: ["strict", "approve", "full"] }
  });
  const store = new OrchestrationStore({ dbPath: path.join(tempHome, "orchestration-repair.sqlite") });
  service.setOrchestrationStoreForTest(store);
  try {
    const run = service.createOrchestrationRun({
      ownerUser: "alice",
      targetAgentId: "desktop-repair",
      projectId: "echo",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      runtimePolicy: { backendId: "codex", permissionMode: "approve", maxConcurrency: 1 },
      items: [{ changeId: "change-repair", snapshot: { proposal: "Repair" } }]
    });
    const first = service.claimOrchestrationWork({ targetAgentId: "desktop-repair", leaseOwner: "desktop-repair:first" });
    const firstSession = service.createOrchestrationAttemptSession(first.attempt.id, {
      agentId: "desktop-repair",
      leaseOwner: "desktop-repair:first",
      execution: {
        path: "/managed/change-repair",
        basePath: "/workspace/echo",
        branchName: "echo/orchestration-change-repair"
      }
    });
    store.reconcileExpiredLeases({ now: "2999-01-01T00:00:00.000Z" });

    const reclaimed = service.claimOrchestrationWork({ targetAgentId: "desktop-repair", leaseOwner: "desktop-repair:reclaimed" });
    assert.equal(reclaimed.attempt.id, first.attempt.id);
    assert.equal(reclaimed.attempt.kind, "implement");
    assert.equal(reclaimed.attempt.sessionId, firstSession.id);
    assert.equal(codexStore.getSession(firstSession.id).status, "queued");
    assert.equal(
      service.orchestrationAttemptSession(reclaimed.attempt.id, {
        agentId: "desktop-repair",
        leaseOwner: "desktop-repair:reclaimed"
      }).id,
      firstSession.id
    );
  } finally {
    service.setOrchestrationStoreForTest(null);
    store.close();
  }
});

test("Agent recovery receives the latest failure evidence in the managed Session", () => {
  codexStore.resetStoreForTest();
  codexQueue.updateCodexAgent({
    id: "desktop-recovery",
    ownerUser: "alice",
    workspaces: [{ id: "echo", path: "/workspace/echo" }],
    runtime: { backendId: "codex", allowedPermissionModes: ["strict", "approve", "full"] }
  });
  const store = new OrchestrationStore({ dbPath: path.join(tempHome, "orchestration-evidence.sqlite") });
  service.setOrchestrationStoreForTest(store);
  try {
    const run = service.createOrchestrationRun({
      ownerUser: "alice",
      targetAgentId: "desktop-recovery",
      projectId: "echo",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      runtimePolicy: { backendId: "codex", permissionMode: "approve", maxConcurrency: 1 },
      items: [{ changeId: "metio-checks", snapshot: { proposal: "Make checks converge" } }]
    });
    const first = service.claimOrchestrationWork({ targetAgentId: "desktop-recovery", leaseOwner: "desktop-recovery:first" });
    const firstSession = service.createOrchestrationAttemptSession(first.attempt.id, {
      leaseOwner: "desktop-recovery:first",
      execution: { path: "/managed/metio", basePath: "/workspace/echo", branchName: "echo/metio" }
    });
    const initialCommand = codexStore.acquireNextSessionCommand({
      agentId: "desktop-recovery",
      agentInstanceId: "desktop-recovery-instance",
      workspaces: [{ id: "echo" }]
    });
    codexStore.completeSessionCommand(initialCommand.id, {
      ok: true,
      sessionStatus: "active",
      execution: { mode: "worktree", lifecycleState: "completed", sessionId: firstSession.id, branchName: "echo/metio" }
    }, { agentId: "desktop-recovery", agentInstanceId: "desktop-recovery-instance" });
    store.addArtifact({
      runId: run.id,
      itemId: run.items[0].id,
      attemptId: first.attempt.id,
      kind: "validation",
      status: "failed",
      summary: "check alpha and check beta cannot pass"
    });
    store.completeAttempt(first.attempt.id, {
      status: "failed",
      leaseOwner: "desktop-recovery:first",
      sessionId: firstSession.id,
      failureClass: "validation-failed",
      errorSummary: "project validation is deterministic",
      retryable: false
    });

    service.recoverOrchestrationItem(run.id, run.items[0].id, { ownerUser: "alice" });
    const recovery = service.claimOrchestrationWork({ targetAgentId: "desktop-recovery", leaseOwner: "desktop-recovery:recover" });
    service.createOrchestrationAttemptSession(recovery.attempt.id, {
      leaseOwner: "desktop-recovery:recover",
      execution: { path: "/managed/metio", basePath: "/workspace/echo", branchName: "echo/metio" }
    });
    const command = codexStore.acquireNextSessionCommand({
      agentId: "desktop-recovery",
      agentInstanceId: "desktop-recovery-instance",
      workspaces: [{ id: "echo" }]
    });
    assert.equal(command.sessionId, firstSession.id);
    assert.match(JSON.stringify(command.payload), /validation-failed/);
    assert.match(JSON.stringify(command.payload), /project validation is deterministic/);
    assert.match(JSON.stringify(command.payload), /check alpha and check beta cannot pass/);
    assert.match(JSON.stringify(command.payload), /可以修正已经过时或不适用的 OpenSpec/);
  } finally {
    service.setOrchestrationStoreForTest(null);
    store.close();
  }
});

test.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
