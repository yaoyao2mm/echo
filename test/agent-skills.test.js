import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentSkillRegistry,
  importAgentSkill,
  listInstalledAgentSkills,
  updateAgentSkillState
} from "../src/lib/agentSkills.js";

test("installed agent skills are discovered and merged across providers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-agent-skills-"));
  const codexRoot = path.join(root, "codex");
  const claudeRoot = path.join(root, "claude");
  writeSkill(path.join(codexRoot, "taste-skill"), {
    name: "design-taste-frontend",
    description: "Premium frontend design rules."
  });
  writeSkill(path.join(claudeRoot, "design-taste-frontend"), {
    name: "design-taste-frontend",
    description: "Claude copy should merge."
  });
  writeSkill(path.join(codexRoot, ".system", "hidden-system"), {
    name: "hidden-system",
    description: "should be skipped"
  });

  const skills = listInstalledAgentSkills({
    roots: [
      { provider: "codex", label: "Codex", root: codexRoot },
      { provider: "claude-code", label: "Claude Code", root: claudeRoot }
    ]
  });

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "design-taste-frontend");
  assert.equal(skills[0].description, "Premium frontend design rules.");
  assert.equal(skills[0].paths, undefined);
  assert.deepEqual(
    skills[0].providers.map((provider) => provider.provider).sort(),
    ["claude-code", "codex"]
  );

  const skillsWithPaths = listInstalledAgentSkills({
    includePaths: true,
    roots: [
      { provider: "codex", label: "Codex", root: codexRoot },
      { provider: "claude-code", label: "Claude Code", root: claudeRoot }
    ]
  });
  assert.equal(skillsWithPaths[0].paths.length, 2);
});

test("agent skill registry tracks desired state and composer visibility", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-agent-skill-state-"));
  const codexRoot = path.join(root, "codex");
  const statePath = path.join(root, "state.json");
  writeSkill(path.join(codexRoot, "taste-skill"), {
    name: "design-taste-frontend",
    description: "Premium frontend design rules."
  });

  const roots = [{ provider: "codex", label: "Codex", root: codexRoot }];
  const first = agentSkillRegistry({ roots, statePath });
  assert.equal(first.summary.total, 1);
  assert.equal(first.summary.enabled, 1);
  assert.equal(first.skills[0].showInComposer, true);

  const updated = updateAgentSkillState(
    {
      skillId: first.skills[0].id,
      enabled: true,
      showInComposer: false,
      targetProviders: ["codex"]
    },
    { roots, statePath }
  );

  assert.equal(updated.ok, true);
  const next = agentSkillRegistry({ roots, statePath });
  assert.equal(next.skills[0].enabled, true);
  assert.equal(next.skills[0].showInComposer, false);
  assert.deepEqual(next.skills[0].targetProviders, ["codex"]);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).skills[first.skills[0].id].showInComposer, false);
});

test("shared registry sync rejects symlinked skill files without leaking paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-agent-skill-sync-"));
  const sharedRoot = path.join(root, "shared");
  const codexRoot = path.join(root, "codex");
  const outside = path.join(root, "outside-secret.md");
  const statePath = path.join(root, "state.json");
  const skillDir = path.join(sharedRoot, "danger-skill");
  writeSkill(skillDir, {
    name: "danger-skill",
    description: "Should not materialize symlinks."
  });
  fs.writeFileSync(outside, "secret\n", "utf8");
  fs.symlinkSync(outside, path.join(skillDir, "linked-secret.md"));

  const roots = [
    { provider: "echo-shared", label: "Echo shared registry", root: sharedRoot, sourceKind: "echo-shared", target: false },
    { provider: "codex", label: "Codex", root: codexRoot, sourceKind: "codex", target: true }
  ];
  const registry = agentSkillRegistry({ roots, statePath });
  const result = updateAgentSkillState(
    {
      skillId: registry.skills[0].id,
      enabled: true,
      showInComposer: true,
      targetProviders: ["codex"]
    },
    { roots, statePath }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /Symlinked Skill files/);
  assert.doesNotMatch(result.error, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("agent skill import materializes GitHub skill into shared registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "echo-agent-skill-import-"));
  const sharedRoot = path.join(root, "shared");
  const codexRoot = path.join(root, "codex");
  const statePath = path.join(root, "state.json");
  const sourceRepo = path.join(root, "source");
  writeSkill(path.join(sourceRepo, "skills", "taste-skill"), {
    name: "design-taste-frontend",
    description: "Premium frontend design rules."
  });

  const roots = [
    { provider: "echo-shared", label: "Echo shared registry", root: sharedRoot, sourceKind: "echo-shared", target: false },
    { provider: "codex", label: "Codex", root: codexRoot, sourceKind: "codex", target: true }
  ];
  const result = await importAgentSkill(
    {
      sourceUrl: "https://github.com/example/skills/tree/main/skills/taste-skill",
      targetProviders: ["codex"]
    },
    {
      roots,
      statePath,
      cloneGit: async (_source, cloneDir) => {
        copyFixtureDirectory(sourceRepo, cloneDir);
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.skill.name, "design-taste-frontend");
  assert.equal(result.skill.enabled, true);
  assert.equal(result.skill.showInComposer, true);
  assert.equal(agentSkillRegistry({ roots, statePath }).summary.total, 1);
  assert.equal(fs.readdirSync(sharedRoot).length, 1);
  assert.equal(fs.readdirSync(codexRoot).length, 1);
});

function writeSkill(dir, frontmatter) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${frontmatter.name}\ndescription: ${frontmatter.description}\n---\n\n# ${frontmatter.name}\n`,
    "utf8"
  );
}

function copyFixtureDirectory(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) copyFixtureDirectory(sourcePath, targetPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath);
  }
}
