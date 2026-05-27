import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syncAuditScript = path.join(repoRoot, "scripts/sync-audit.js");

test("sync audit handles unrelated public/private histories and reports review signals", () => {
  const fixture = createGitFixture();
  try {
    const publicInitial = commitFiles(fixture.root, {
      "README.md": "# Echo\n",
      "src/server.js": "const relayToken = process.env.ECHO_TOKEN;\n",
      "public/app/codex.js": "export const mode = 'public';\n",
      "deleted-public-only.txt": "removed downstream\n"
    }, "Initial public release");

    commitFiles(fixture.root, {
      "src/lib/codexWorkspaceConfig.js": "export function configuredWorkspaces() { return []; }\n",
      "src/server.js": "const relayToken = process.env.ECHO_TOKEN;\nexport const hotReload = true;\n"
    }, "Hot reload workspace config");
    git(fixture.root, ["branch", "public-main"]);

    git(fixture.root, ["checkout", "--orphan", "private-main"]);
    removeAllFiles(fixture.root);
    git(fixture.root, ["rm", "-r", "--cached", "."], { allowFailure: true });
    commitFiles(fixture.root, {
      "README.md": "# Echo private\n",
      "src/server.js": "const relayToken = process.env.ECHO_TOKEN;\nexport const hotReload = true;\nexport const privateOnly = true;\n",
      "src/lib/codexWorkspaceConfig.js": "export function configuredWorkspaces() { return []; }\n",
      "public/app/codex.js": "export const mode = 'private';\n",
      "src/lib/codexStore.js": "export const schema = 'private';\n"
    }, "Initial private release");

    const json = runSyncAudit(fixture.root, [
      "--",
      "--public",
      "public-main",
      "--private",
      "private-main",
      "--json",
      "--max-commits",
      "5"
    ]);

    assert.equal(json.histories.commonAncestor, null);
    assert.equal(json.histories.unrelated, true);
    assert.deepEqual(json.histories.symmetricCounts, { publicOnly: 2, privateOnly: 1 });
    assert.equal(json.treeDiff.totals.files, 5);
    assert.ok(json.secretReviewFiles.includes("src/server.js"));
    assert.ok(!json.secretReviewFiles.includes("deleted-public-only.txt"));
    assert.ok(json.reviewGroups.some((group) => group.label === "relay/session state" && group.files.includes("src/server.js")));
    assert.ok(json.reviewGroups.some((group) => group.label === "mobile approval/runtime UX" && group.files.includes("public/app/codex.js")));

    const hotReload = json.publicCommitAbsorption.find((commit) => commit.subject === "Hot reload workspace config");
    assert.ok(hotReload);
    assert.equal(hotReload.counts.identical, 1);
    assert.equal(hotReload.counts.drifted, 1);
    assert.deepEqual(hotReload.driftedFiles, ["src/server.js"]);

    const initial = json.publicCommitAbsorption.find((commit) => commit.sha === publicInitial);
    assert.ok(initial);
    assert.equal(initial.counts.missingInPrivate, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createGitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-sync-audit-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "sync-audit@example.invalid"]);
  git(root, ["config", "user.name", "Sync Audit Test"]);
  return { root };
}

function commitFiles(root, files, message) {
  for (const [name, content] of Object.entries(files)) {
    const fullPath = path.join(root, name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", message]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  return sha;
}

function removeAllFiles(root) {
  for (const entry of fs.readdirSync(root)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(root, entry), { recursive: true, force: true });
  }
}

function runSyncAudit(cwd, args) {
  const output = execFileSync(process.execPath, [syncAuditScript, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(output);
}

function git(cwd, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "pipe"]
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}
