import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const desktopAppMain = fs.readFileSync("desktop-app/main.cjs", "utf8");
const desktopSettings = fs.readFileSync("scripts/desktop-settings.js", "utf8");
const desktopAgent = fs.readFileSync("src/desktop-agent.js", "utf8");
const agentProfileSupervisor = fs.readFileSync("src/lib/agentProfileSupervisor.js", "utf8");
const relayServer = fs.readFileSync("src/server.js", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

test("desktop app-managed agent merges repo .env before spawning the agent", () => {
  assert.match(desktopAppMain, /function readDotEnvFile\(\)/, "desktop app should parse the repo .env explicitly");
  assert.match(
    desktopAppMain,
    /const env = buildDesktopEnv\(\{\s*\.\.\.readDotEnvFile\(\),\s*\.\.\.process\.env,\s*ELECTRON_RUN_AS_NODE: "1"\s*\}\);/s,
    "app agent environment should include .env values before process env overrides"
  );
  assert.match(desktopAppMain, /spawn\(process\.execPath, \[desktopAgentScript\], \{\s*cwd: rootDir,\s*env,/s);
});

test("desktop app login startup keeps common macOS developer commands on PATH", () => {
  assert.match(desktopAppMain, /function normalizeDesktopPath\(value, home\)/);
  assert.match(desktopAppMain, /PATH: normalizeDesktopPath\(env\.PATH, home\)/);
  assert.match(desktopAppMain, /path\.join\(home, "Library", "pnpm"\)/);
  assert.match(desktopAppMain, /"\/opt\/homebrew\/bin"/);
  assert.match(
    desktopAppMain,
    /env: buildDesktopEnv\(\{\s*\.\.\.readDotEnvFile\(\),\s*\.\.\.process\.env,\s*ELECTRON_RUN_AS_NODE: "1",\s*ECHO_SETTINGS_HOST: "127\.0\.0\.1",\s*ECHO_SETTINGS_PORT: "0"\s*\}\)/s
  );
  assert.match(desktopSettings, /function buildDesktopCommandEnv\(env = \{\}\)/);
  assert.match(desktopSettings, /env: buildDesktopCommandEnv\(env\)/);
});

test("desktop app is the only user-facing local agent entrypoint", () => {
  assert.equal(packageJson.scripts["desktop:mac"], undefined);
  assert.doesNotMatch(desktopAppMain, /macos-desktop-agent\.sh|launchctl|LaunchAgent|launchd/);
  assert.doesNotMatch(desktopSettings, /macos-desktop-agent\.sh|launchctl|LaunchAgent|launchd/);
});

test("desktop settings restart asks the desktop app to restart the app-managed agent", () => {
  assert.match(desktopSettings, /function notifyDesktopAgentRestart\(\)/);
  assert.match(desktopSettings, /ECHO_DESKTOP_AGENT_RESTART_REQUESTED/);
  assert.match(desktopAppMain, /settings service requested app agent restart/);
  assert.match(desktopAppMain, /restartAppAgent\(\);/);
});

test("desktop app quickly replaces an agent that exits after a persisted restart checkpoint", () => {
  assert.match(desktopAppMain, /const restartDelayMs = code === 75 \? 500 : 3000/);
  assert.match(desktopAppMain, /setTimeout\(\(\) => startAppAgent\(\), restartDelayMs\)/);
});

test("profile supervisor treats checkpointed exit 75 as a fast expected restart", () => {
  assert.match(agentProfileSupervisor, /code === gracefulDesktopRestartExitCode \? 500 : 2000/);
  assert.match(desktopAgent, /restarting in \$\{delayMs\}ms/);
  assert.match(desktopAgent, /after checkpoint/);
});

test("desktop agent restart is requested through a persisted session checkpoint", () => {
  assert.match(desktopAgent, /request-desktop-agent-restart\.js/);
  assert.match(desktopAgent, /completed\?\.restart\?\.shouldExit/);
  assert.match(desktopAgent, /process\.exit\(75\)/);
  assert.match(desktopAgent, /ECHO_DESKTOP_RESTART_PROTOCOL_VERSION = "1"/);
  assert.match(desktopAgent, /logRestartReconciliations\(result\?\.restarts\)/);
  assert.match(desktopAgent, /postJson\(`\/api\/agent\/codex\/restarts\/\$\{encodeURIComponent\(restartId\)\}\/arm`/);
  assert.match(
    desktopAgent,
    /activeCodexCommandCount > 0[\s\S]*activeSessionCommands\.size > 0[\s\S]*runningSessionHeartbeats\.size > 0[\s\S]*activeOrchestrationAttemptCount > 0/
  );
  assert.match(desktopAgent, /function stopRunningSessionHeartbeat[\s\S]*maybeExitForDesktopAgentRestart\(\)/);
  assert.match(desktopAgent, /if \(!restartId \|\| !sessionId\) \{\s*scheduleDesktopAgentExit\(pendingDesktopAgentRestart\.reason\)/);
});

test("relay advances durable desktop restart timeouts without a session read", () => {
  assert.match(relayServer, /setInterval\(\(\) => \{[\s\S]*expireCodexAgentRestarts\(\)[\s\S]*\}, 15000\)/);
  assert.match(relayServer, /agentRestartExpirationSweep\?\.unref\?\.\(\)/);
});
