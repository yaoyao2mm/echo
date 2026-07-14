import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAgentProcessEnv, normalizeAgentPath } from "../src/lib/agentProcessEnv.js";
import { buildClaudeEnv } from "../src/lib/claudeCodeRunner.js";
import { buildCodexEnv } from "../src/lib/codexRunner.js";

test("agent process PATH adds common developer tools before system directories", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-agent-path-"));
  const wrapperDir = path.join(tempRoot, "codex-wrapper");
  const leanPath = [wrapperDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
  const env = buildAgentProcessEnv({ HOME: tempRoot, PATH: leanPath, USER: "agent", LOGNAME: "agent" });
  const segments = pathSegments(env.PATH);

  assert.equal(segments[0], wrapperDir);
  assertIncludesBeforeSystem(segments, path.join(tempRoot, ".local", "bin"));
  assertIncludesBeforeSystem(segments, path.join(tempRoot, "Library", "pnpm"));
  assertIncludesBeforeSystem(segments, path.join(tempRoot, ".cargo", "bin"));
  assertIncludesBeforeSystem(segments, path.join(tempRoot, ".bun", "bin"));
  assertIncludesBeforeSystem(segments, "/opt/homebrew/opt/python/libexec/bin");
  assertIncludesBeforeSystem(segments, "/opt/homebrew/bin");
  assertIncludesBeforeSystem(segments, "/usr/local/bin");
  assert.equal(new Set(segments).size, segments.length);
});

test("agent process PATH moves known developer segments ahead of system directories", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-agent-path-move-"));
  const pnpmDir = path.join(tempRoot, "Library", "pnpm");
  const value = ["/usr/bin", pnpmDir, "/bin"].join(path.delimiter);
  const segments = pathSegments(normalizeAgentPath(value, tempRoot));

  assertIncludesBeforeSystem(segments, pnpmDir);
  assert.equal(segments.filter((segment) => segment === pnpmDir).length, 1);
});

test("Codex and Claude runtime environments normalize PATH for agent child processes", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-path-"));
  const leanPath = [path.join(tempRoot, "arg0"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter);
  const sourceEnv = {
    HOME: tempRoot,
    PATH: leanPath,
    USER: "agent",
    LOGNAME: "agent",
    SHELL: "/bin/zsh"
  };
  const codexEnv = buildCodexEnv(sourceEnv);
  const claudeEnv = buildClaudeEnv({}, sourceEnv);

  for (const env of [codexEnv, claudeEnv]) {
    const segments = pathSegments(env.PATH);
    assert.equal(segments[0], path.join(tempRoot, "arg0"));
    assertIncludesBeforeSystem(segments, "/opt/homebrew/bin");
    assertIncludesBeforeSystem(segments, "/opt/homebrew/opt/python/libexec/bin");
    assertIncludesBeforeSystem(segments, path.join(tempRoot, "Library", "pnpm"));
    assert.equal(env.HOME, tempRoot);
    assert.equal(env.SHELL, "/bin/zsh");
    assert.equal(env.LANG, "en_US.UTF-8");
  }
  assert.equal(codexEnv.CODEX_HOME, path.join(tempRoot, ".codex"));
});

function pathSegments(value) {
  return String(value || "").split(path.delimiter).filter(Boolean);
}

function assertIncludesBeforeSystem(segments, expected) {
  assert.ok(segments.includes(expected), `${expected} should be on PATH`);
  assert.ok(segments.indexOf(expected) < segments.indexOf("/usr/bin"), `${expected} should precede /usr/bin`);
}
