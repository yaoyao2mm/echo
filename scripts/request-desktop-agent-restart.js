#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { loadDesktopAgentId } from "../src/lib/agentIdentity.js";

const args = parseArgs(process.argv.slice(2));
const sessionId = String(args.session || "").trim();
const agentInstanceId = String(process.env.ECHO_AGENT_INSTANCE_ID || "").trim();
const agentId = String(process.env.ECHO_AGENT_ID || config.agent.id || await loadDesktopAgentId()).trim();
const runningRevision = String(process.env.ECHO_SOURCE_REVISION || "").trim().toLowerCase();
const expectedRevision = String(currentRevision() || runningRevision).trim().toLowerCase();
const protocolVersion = supportedProtocolVersion();

if (!sessionId) fail("Missing --session.");
if (!config.relayUrl || !config.agent.token) fail("Echo relay URL and agent token are required.");
if (!agentId || !agentInstanceId) fail("This command must run inside an Echo desktop agent session.");
if (!protocolVersion) {
  fail("The running Echo desktop agent does not support checkpointed restart. Complete this turn without restarting, then relaunch Echo once to activate the protocol.");
}
if (!/^[0-9a-f]{7,64}$/.test(expectedRevision)) fail("Could not determine the Echo source revision.");

const response = await fetch(`${config.relayUrl}/api/agent/codex/restarts`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Echo-Agent-Token": config.agent.token
  },
  body: JSON.stringify({
    agentId,
    agentInstanceId,
    sessionId,
    protocolVersion,
    runningRevision,
    expectedRevision,
    resumeSummary: String(args.summary || "").trim().slice(0, 8000)
  })
});
const data = await response.json().catch(() => ({}));
if (!response.ok || !data.restart?.id) fail(data.error || `Relay returned HTTP ${response.status}.`);

console.log(`Echo desktop restart checkpoint saved: ${data.restart.id}`);
console.log("The desktop agent will restart only after this turn has been persisted by Relay.");

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key?.startsWith("--")) continue;
    parsed[key.slice(2)] = values[index + 1] || "";
    index += 1;
  }
  return parsed;
}

function currentRevision() {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function supportedProtocolVersion() {
  if (String(process.env.ECHO_DESKTOP_RESTART_PROTOCOL_VERSION || "").trim() === "1") return "1";
  if (!/^[0-9a-f]{40}$/.test(runningRevision)) return "";
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    execFileSync("git", ["merge-base", "--is-ancestor", "7a608053ee74707021b97948d0cb6680afc74b12", runningRevision], {
      cwd: root,
      stdio: "ignore"
    });
    return "1";
  } catch {
    return "";
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
