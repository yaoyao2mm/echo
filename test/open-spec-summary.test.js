import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseOpenSpecProposal,
  parseOpenSpecTasks,
  summarizeOpenSpecWorkspace
} from "../src/lib/openSpecSummary.js";

test("OpenSpec task parser groups checkbox progress by markdown heading", () => {
  const parsed = parseOpenSpecTasks(`
## 1. Reader

- [x] 1.1 Detect OpenSpec
- [ ] 1.2 Parse tasks

## 2. Mobile

- [X] 2.1 Render sheet
`);

  assert.equal(parsed.completed, 2);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.percent, 67);
  assert.deepEqual(parsed.groups.map((group) => group.title), ["1. Reader", "2. Mobile"]);
  assert.deepEqual(parsed.groups[0].tasks.map((task) => task.checked), [true, false]);
});

test("OpenSpec proposal parser extracts title, why, changes, and affected specs", () => {
  const parsed = parseOpenSpecProposal(`
# Mobile OpenSpec Progress

## Why
Mobile users need read-only project progress while Codex runs.

## What Changes
- Add a mobile sheet.
- Parse tasks for \`mobile-open-spec-progress\`.
`);

  assert.equal(parsed.title, "Mobile OpenSpec Progress");
  assert.match(parsed.why, /read-only project progress/);
  assert.deepEqual(parsed.whatChanges, ["Add a mobile sheet.", "Parse tasks for mobile-open-spec-progress."]);
  assert.deepEqual(parsed.affectedSpecs, ["mobile-open-spec-progress"]);
});

test("OpenSpec summary detects directory priority and summarizes bounded progress", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-openspec-workspace-"));
  fs.mkdirSync(path.join(workspacePath, ".OpenSpec", "changes", "add-mobile-open-spec"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, ".OpenSpec", "changes", "archive"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, ".OpenSpec", "changes", "later-change"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, ".OpenSpec", "specs", "mobile-open-spec-progress"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "openspec", "changes", "ignored-lowercase"), { recursive: true });

  fs.writeFileSync(
    path.join(workspacePath, ".OpenSpec", "changes", "add-mobile-open-spec", "tasks.md"),
    `
## 1. Reader

- [x] 1.1 Detect .OpenSpec
- [ ] 1.2 Render progress

## 2. UI

- [ ] 2.1 Add timeline
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspacePath, ".OpenSpec", "changes", "add-mobile-open-spec", "proposal.md"),
    `
# Add Mobile OpenSpec Progress

## Why
Phone users need a compact story of active OpenSpec work.

## What Changes
- Surface \`mobile-open-spec-progress\`.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspacePath, ".OpenSpec", "specs", "mobile-open-spec-progress", "spec.md"),
    `
# Mobile OpenSpec Progress

### Requirement: Mobile Summary
The PWA SHALL render OpenSpec progress when available.
`,
    "utf8"
  );

  const result = await summarizeOpenSpecWorkspace({
    projectId: "demo",
    workspaces: [{ id: "demo", label: "Demo", path: workspacePath }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.openSpec.available, true);
  assert.equal(result.openSpec.directoryName, ".OpenSpec");
  assert.equal(result.openSpec.overview.totalChanges, 2);
  assert.equal(result.openSpec.overview.totalChangeEntries, 2);
  assert.equal(result.openSpec.overview.totalTasks, 3);
  assert.equal(result.openSpec.overview.completedTasks, 1);
  assert.equal(result.openSpec.overview.percentComplete, 33);
  assert.equal(result.openSpec.changes[0].id, "add-mobile-open-spec");
  assert.equal(result.openSpec.changes.some((change) => change.id === "archive"), false);
  assert.equal(result.openSpec.changes[0].progress.percent, 33);
  assert.deepEqual(result.openSpec.changes[0].affectedSpecs, ["mobile-open-spec-progress"]);
  assert.equal(result.openSpec.specs[0].requirementCount, 1);
});

test("OpenSpec summary returns unavailable when no supported directory exists", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-openspec-empty-"));
  const result = await summarizeOpenSpecWorkspace({
    projectId: "demo",
    workspaces: [{ id: "demo", label: "Demo", path: workspacePath }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.openSpec.available, false);
  assert.deepEqual(result.openSpec.changes, []);
});

test("OpenSpec summary supports CLI-created archive and change-local specs", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-openspec-cli-shape-"));
  fs.mkdirSync(path.join(workspacePath, "openspec", "changes", "add-mobile-progress", "specs", "mobile-progress"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "openspec", "changes", "archive", "2026-06-06-shipped-mobile-progress", "specs", "mobile-progress"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "openspec", "specs"), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "openspec", "changes", "add-mobile-progress", ".openspec.yaml"), "schema: spec-driven\n", "utf8");
  fs.writeFileSync(path.join(workspacePath, "openspec", "changes", "add-mobile-progress", "tasks.md"), "- [ ] Build active timeline\n", "utf8");
  fs.writeFileSync(
    path.join(workspacePath, "openspec", "changes", "add-mobile-progress", "specs", "mobile-progress", "spec.md"),
    `
# Mobile Progress

### Requirement: Change-local spec
The system SHALL count specs nested under active changes.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspacePath, "openspec", "changes", "archive", "2026-06-06-shipped-mobile-progress", "proposal.md"),
    `
# Shipped Mobile Progress

## Why
Archive completed work without losing the timeline.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspacePath, "openspec", "changes", "archive", "2026-06-06-shipped-mobile-progress", "tasks.md"),
    "- [x] Ship archived timeline\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspacePath, "openspec", "changes", "archive", "2026-06-06-shipped-mobile-progress", "specs", "mobile-progress", "spec.md"),
    `
# Mobile Progress

### Requirement: Archived spec
The system SHALL count specs nested under archived changes.
`,
    "utf8"
  );

  const result = await summarizeOpenSpecWorkspace({
    projectId: "demo",
    workspaces: [{ id: "demo", label: "Demo", path: workspacePath }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.openSpec.available, true);
  assert.equal(result.openSpec.overview.totalChanges, 2);
  assert.equal(result.openSpec.overview.totalChangeEntries, 2);
  assert.equal(result.openSpec.overview.activeChanges, 1);
  assert.equal(result.openSpec.overview.archivedChanges, 1);
  assert.equal(result.openSpec.overview.totalTasks, 1);
  assert.equal(result.openSpec.overview.completedTasks, 0);
  assert.equal(result.openSpec.overview.specCount, 1);
  assert.deepEqual(result.openSpec.changes.map((change) => change.id), ["add-mobile-progress", "shipped-mobile-progress"]);
  assert.deepEqual(result.openSpec.changes.map((change) => change.status), ["planned", "archived"]);
  assert.deepEqual(result.openSpec.changes.map((change) => change.archived), [false, true]);
  assert.equal(result.openSpec.changes.some((change) => change.id === "archive"), false);
  assert.deepEqual(result.openSpec.changes[0].affectedSpecs, ["mobile-progress"]);
  assert.equal(result.openSpec.specs[0].id, "mobile-progress");
  assert.equal(result.openSpec.specs[0].path, "openspec/changes/add-mobile-progress/specs/mobile-progress/spec.md");
});

test("OpenSpec summary enforces limits without leaking symlink escapes", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-openspec-limits-"));
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-openspec-outside-"));
  fs.mkdirSync(path.join(workspacePath, "openspec", "changes"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "openspec", "specs"), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "openspec", "changes", "visible-change"), { recursive: true });
  fs.mkdirSync(path.join(outsidePath, "escaped-change"), { recursive: true });

  fs.writeFileSync(path.join(workspacePath, "openspec", "changes", "visible-change", "tasks.md"), "- [ ] visible\n", "utf8");
  fs.writeFileSync(path.join(outsidePath, "escaped-change", "tasks.md"), "- [x] secret outside\n", "utf8");
  fs.symlinkSync(path.join(outsidePath, "escaped-change"), path.join(workspacePath, "openspec", "changes", "z-escaped"));

  const result = await summarizeOpenSpecWorkspace({
    projectId: "demo",
    workspaces: [{ id: "demo", label: "Demo", path: workspacePath }],
    limits: { maxChanges: 1, maxSpecs: 1 }
  });

  assert.equal(result.ok, true);
  assert.equal(result.openSpec.available, true);
  assert.deepEqual(result.openSpec.changes.map((change) => change.id), ["visible-change"]);
  assert.equal(result.openSpec.overview.truncated, false);
  assert.equal(JSON.stringify(result.openSpec).includes("secret outside"), false);
});

test("OpenSpec summary ignores an OpenSpec directory symlink that resolves outside the workspace", async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-openspec-rootlink-"));
  const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "echo-openspec-rootlink-outside-"));
  fs.mkdirSync(path.join(outsidePath, "changes", "outside-change"), { recursive: true });
  fs.writeFileSync(path.join(outsidePath, "changes", "outside-change", "tasks.md"), "- [x] escaped\n", "utf8");
  fs.symlinkSync(outsidePath, path.join(workspacePath, ".OpenSpec"));

  const result = await summarizeOpenSpecWorkspace({
    projectId: "demo",
    workspaces: [{ id: "demo", label: "Demo", path: workspacePath }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.openSpec.available, false);
  assert.equal(result.openSpec.warnings.some((warning) => warning.includes("resolves outside")), true);
  assert.equal(JSON.stringify(result.openSpec).includes("escaped"), false);
});
