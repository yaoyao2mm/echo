import assert from "node:assert/strict";
import test from "node:test";
import {
  completeNonBlockingManualTasks,
  completedBaselineChangeIds,
  orchestrationItemFingerprint,
  readyIntegrationItems
} from "../src/lib/orchestrationBaseline.js";

const completed = (id) => ({
  id,
  status: "complete",
  progress: { completedTasks: 2, totalTasks: 2 }
});

test("baseline reconciliation ignores dirty OpenSpec changes outside the current Run", () => {
  assert.deepEqual(completedBaselineChangeIds({
    changes: [completed("run-change"), completed("unrelated-change")],
    runItems: [{ changeId: "run-change" }],
    porcelain: "?? openspec/changes/unrelated-change/proposal.md\n"
  }), ["run-change"]);
});

test("baseline reconciliation rejects a Run change with uncommitted OpenSpec state", () => {
  assert.deepEqual(completedBaselineChangeIds({
    changes: [completed("run-change")],
    runItems: [{ changeId: "run-change" }],
    porcelain: " M openspec/changes/run-change/tasks.md\n"
  }), []);
});

test("manual verification tasks are completed without hiding implementation work", () => {
  const result = completeNonBlockingManualTasks([
    "- [ ] Implement responsive search layout.",
    "- [ ] Start a local dev server and browser-check `/search` at desktop and mobile widths.",
    "- [ ] 人工验收手机端视觉布局。",
    "- [x] Existing completed task."
  ].join("\n"));

  assert.equal(result.completedCount, 2);
  assert.match(result.markdown, /- \[ \] Implement responsive search layout\./);
  assert.match(result.markdown, /- \[x\] Start a local dev server and browser-check/);
  assert.match(result.markdown, /- \[x\] 人工验收手机端视觉布局/);
});

test("integration replays only ready Items in stable order", () => {
  const ready = readyIntegrationItems([
    { id: "completed", status: "completed", position: 0, finalCommit: "a".repeat(40) },
    { id: "ready-b", status: "ready", position: 2, finalCommit: "c".repeat(40) },
    { id: "attention", status: "attention", position: 1, finalCommit: "" },
    { id: "ready-a", status: "ready", position: 1, finalCommit: "b".repeat(40) }
  ]);

  assert.deepEqual(ready.map((item) => item.id), ["ready-a", "ready-b"]);
});

test("Desktop reads the public Relay snapshot fingerprint contract", () => {
  assert.equal(orchestrationItemFingerprint({ snapshotFingerprint: "relay-fingerprint" }), "relay-fingerprint");
  assert.equal(orchestrationItemFingerprint({ fingerprint: "legacy-fingerprint" }), "legacy-fingerprint");
});
