import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const script = fs.readFileSync("scripts/macos-desktop-agent.sh", "utf8");
const desktopAppMain = fs.readFileSync("desktop-app/main.cjs", "utf8");

test("macOS LaunchAgent script propagates built-in Claude backend env keys", () => {
  const requiredKeys = [
    "ECHO_CLAUDE_ENABLED",
    "ECHO_CLAUDE_COMMAND",
    "ECHO_CLAUDE_BASE_URL",
    "ECHO_CLAUDE_AUTH_TOKEN",
    "ECHO_CLAUDE_MODEL",
    "ECHO_CLAUDE_SUPPORTED_MODELS",
    "ECHO_CLAUDE_PERMISSION_MODE",
    "ECHO_CLAUDE_PROFILE",
    "ECHO_CLAUDE_ALLOWED_PERMISSION_MODES",
    "ECHO_CLAUDE_REASONING_EFFORT",
    "ECHO_CLAUDE_APPROVAL_TIMEOUT_MS",
    "ECHO_CLAUDE_TIMEOUT_MS",
    "ECHO_CLAUDE_WORKTREE_MODE",
    "ECHO_CLAUDE_SUBAGENT_MODEL",
    "ECHO_CLAUDE_AGENT_TEAMS_ENABLED",
    "ECHO_AGENT_BACKENDS_JSON"
  ];

  for (const key of requiredKeys) {
    assert.match(script, new RegExp(`"${key}"`), `${key} must be accepted from .env`);
    assert.match(script, new RegExp(`env_entry "${key}"`), `${key} must be written to the LaunchAgent plist`);
    assert.match(script, new RegExp(`${key}=\\$|${key}=\\$\\{${key}:\\+<set>\\}`), `${key} must appear in print-env`);
  }
});

test("macOS LaunchAgent script propagates Volcengine Coding Plan backend env keys", () => {
  const requiredKeys = [
    "ECHO_VOLCENGINE_CODING_ENABLED",
    "ECHO_VOLCENGINE_CODING_BACKEND_ID",
    "ECHO_VOLCENGINE_CODING_BASE_URL",
    "ECHO_VOLCENGINE_CODING_COMMAND",
    "ECHO_VOLCENGINE_CODING_MODEL",
    "ECHO_VOLCENGINE_CODING_PERMISSION_MODE",
    "ECHO_VOLCENGINE_CODING_PROFILE",
    "ECHO_VOLCENGINE_CODING_REASONING_EFFORT",
    "ECHO_VOLCENGINE_CODING_APPROVAL_TIMEOUT_MS",
    "ECHO_VOLCENGINE_CODING_TIMEOUT_MS",
    "ECHO_VOLCENGINE_CODING_SUPPORTED_MODELS",
    "ECHO_VOLCENGINE_CODING_ALLOWED_PERMISSION_MODES",
    "ECHO_VOLCENGINE_CODING_WORKTREE_MODE",
    "ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL",
    "ECHO_VOLCENGINE_CODING_AGENT_TEAMS_ENABLED",
    "ECHO_VOLCENGINE_CODING_API_KEY"
  ];

  for (const key of requiredKeys) {
    assert.match(script, new RegExp(`"${key}"`), `${key} must be accepted from .env`);
    assert.match(script, new RegExp(`env_entry "${key}"`), `${key} must be written to the LaunchAgent plist`);
    assert.match(script, new RegExp(`${key}=\\$|${key}=\\$\\{${key}:\\+<set>\\}`), `${key} must appear in print-env`);
  }
  assert.match(
    script,
    /: "\$\{ECHO_VOLCENGINE_CODING_PERMISSION_MODE:=approve\}"/,
    "Volcengine Coding Plan should default to editable Claude permissions in LaunchAgent mode"
  );
});

test("app-managed desktop agent merges repo .env before spawning the agent", () => {
  assert.match(desktopAppMain, /function readDotEnvFile\(\)/, "desktop app should parse the repo .env explicitly");
  assert.match(
    desktopAppMain,
    /const env = buildDesktopEnv\(\{\s*\.\.\.readDotEnvFile\(\),\s*\.\.\.process\.env,\s*ELECTRON_RUN_AS_NODE: "1"\s*\}\);/s,
    "app agent environment should include .env values before process env overrides"
  );
  assert.match(desktopAppMain, /spawn\(process\.execPath, \[desktopAgentScript\], \{\s*cwd: rootDir,\s*env,/s);
});
