import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Relay HTTP keeps session events and completion idempotent across retries", async (t) => {
  const relay = await startRelay(t);
  const session = await createSession(relay, "complete exactly once");
  const command = await leaseSessionCommand(relay, "instance-completion");
  assert.equal(command.sessionId, session.id);
  assert.equal(command.attempt, 1);

  const eventBody = {
    id: session.id,
    agentId: relay.agentId,
    agentInstanceId: "instance-completion",
    events: [{
      eventId: "http-terminal-event",
      commandId: command.id,
      attempt: command.attempt,
      type: "turn.completed",
      text: "terminal event once",
      sessionStatus: "active",
      raw: { method: "turn/completed", params: { turn: { id: "turn-http" } } }
    }]
  };
  assert.equal((await agentJson(relay, "/api/agent/codex/sessions/events", eventBody)).ok, true);
  assert.equal((await agentJson(relay, "/api/agent/codex/sessions/events", eventBody)).ok, true);

  const completionBody = {
    id: command.id,
    attempt: command.attempt,
    agentId: relay.agentId,
    agentInstanceId: "instance-completion",
    result: { ok: true, sessionId: session.id, sessionStatus: "active", finalMessage: "finished" }
  };
  const firstCompletion = await agentJson(relay, "/api/agent/codex/sessions/commands/complete", completionBody);
  assert.equal(firstCompletion.ok, true);
  const retriedCompletion = await agentJson(relay, "/api/agent/codex/sessions/commands/complete", completionBody);
  assert.equal(retriedCompletion.ok, true);

  const detail = await phoneJson(relay, `/api/codex/sessions/${encodeURIComponent(session.id)}`);
  assert.equal(detail.session.events.filter((event) => event.text === "terminal event once").length, 1);
  assert.equal(detail.session.events.filter((event) => event.type === "command.completed").length, 1);
});

test("Relay HTTP reconciles an expired lease before allowing another execution", async (t) => {
  const relay = await startRelay(t, { leaseMs: 500 });
  const session = await createSession(relay, "survive disconnect");
  const command = await leaseSessionCommand(relay, "instance-before-disconnect");
  await delay(650);

  const reconnected = await pollSessionCommand(relay, "instance-after-reconnect");
  assert.equal(reconnected.command, null);
  assert.equal(reconnected.reconciliation.length, 1);
  assert.equal(reconnected.reconciliation[0].commandId, command.id);
  assert.equal(reconnected.reconciliation[0].attempt, command.attempt);

  const reconciliation = await agentJson(relay, "/api/agent/codex/sessions/reconcile", {
    agentId: relay.agentId,
    agentInstanceId: "instance-after-reconnect",
    states: [{ commandId: command.id, attempt: command.attempt, state: "running" }]
  });
  assert.equal(reconciliation.outcomes[0].outcome, "running");

  const concurrent = await pollSessionCommand(relay, "another-instance", 20);
  assert.equal(concurrent.command, null);
  const completion = await agentJson(relay, "/api/agent/codex/sessions/commands/complete", {
    id: command.id,
    attempt: command.attempt,
    agentId: relay.agentId,
    agentInstanceId: "instance-after-reconnect",
    result: { ok: true, sessionId: session.id, sessionStatus: "active" }
  });
  assert.equal(completion.ok, true);
});

test("Relay HTTP makes a restarted Desktop's unknown command terminal", async (t) => {
  const relay = await startRelay(t, { leaseMs: 500 });
  const session = await createSession(relay, "desktop restarts");
  const command = await leaseSessionCommand(relay, "old-process");
  await delay(650);

  const restarted = await pollSessionCommand(relay, "new-process");
  assert.equal(restarted.command, null);
  const reconciliation = await agentJson(relay, "/api/agent/codex/sessions/reconcile", {
    agentId: relay.agentId,
    agentInstanceId: "new-process",
    states: [{ commandId: command.id, attempt: command.attempt, state: "unknown" }]
  });
  assert.equal(reconciliation.outcomes[0].outcome, "failed");

  const detail = await phoneJson(relay, `/api/codex/sessions/${encodeURIComponent(session.id)}`);
  assert.equal(detail.session.status, "failed");
  assert.equal(detail.session.events.some((event) => event.type === "command.reconciliation.failed"), true);
});

test("Relay HTTP arms restart only after drain and completes on verified heartbeat", async (t) => {
  const relay = await startRelay(t);
  const session = await createSession(relay, "restart without losing this conversation");
  const oldInstanceId = "graceful-http-old";
  const expectedRevision = "d".repeat(40);
  const command = await leaseSessionCommand(relay, oldInstanceId);

  const requested = await agentJson(relay, "/api/agent/codex/restarts", {
    agentId: relay.agentId,
    agentInstanceId: oldInstanceId,
    sessionId: session.id,
    expectedRevision,
    resumeSummary: "Continue the deployment report."
  });
  assert.equal(requested.restart.status, "requested");

  const completion = await agentJson(relay, "/api/agent/codex/sessions/commands/complete", {
    id: command.id,
    attempt: command.attempt,
    agentId: relay.agentId,
    agentInstanceId: oldInstanceId,
    restartArmMode: "desktop-exit",
    result: { ok: true, sessionId: session.id, sessionStatus: "active", finalMessage: "checkpoint saved" }
  });
  assert.equal(completion.ok, true);
  assert.equal(completion.restart.status, "requested");
  assert.equal(completion.restart.shouldExit, true);

  const armed = await agentJson(relay, `/api/agent/codex/restarts/${encodeURIComponent(requested.restart.id)}/arm`, {
    agentId: relay.agentId,
    agentInstanceId: oldInstanceId,
    sessionId: session.id
  });
  assert.equal(armed.restart.status, "restarting");
  assert.equal(armed.restart.shouldExit, true);

  const heartbeat = await agentJson(relay, "/api/agent/codex/heartbeat", {
    agentId: relay.agentId,
    agentInstanceId: "graceful-http-new",
    workspaces: [{ id: "echo", label: "Echo", path: process.cwd() }],
    runtime: { command: "fake-codex", sourceRevision: expectedRevision }
  });
  assert.equal(heartbeat.restarts[0].status, "completed");
  const repeatedHeartbeat = await agentJson(relay, "/api/agent/codex/heartbeat", {
    agentId: relay.agentId,
    agentInstanceId: "graceful-http-new",
    workspaces: [{ id: "echo", label: "Echo", path: process.cwd() }],
    runtime: { command: "fake-codex", sourceRevision: expectedRevision }
  });
  assert.deepEqual(repeatedHeartbeat.restarts, []);

  const detail = await phoneJson(relay, `/api/codex/sessions/${encodeURIComponent(session.id)}`);
  assert.equal(detail.session.restartOperation.status, "completed");
  assert.equal(detail.session.pendingCommandCount, 0);
  assert.equal(detail.session.lastError, "");
});

async function startRelay(t, options = {}) {
  const port = await freePort();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-state-protocol-http-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const phoneToken = "state-protocol-phone-token";
  const agentToken = "state-protocol-agent-token";
  const agentId = "state-protocol-agent";
  let stderr = "";
  const child = spawn(process.execPath, ["src/server.js", "--relay"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tempHome,
      ECHO_HOST: "127.0.0.1",
      ECHO_PORT: String(port),
      ECHO_MODE: "relay",
      ECHO_PUBLIC_URL: baseUrl,
      ECHO_TOKEN: phoneToken,
      ECHO_AGENT_TOKEN: agentToken,
      ECHO_AGENT_ID: agentId,
      ECHO_AUTH_ENABLED: "false",
      ECHO_CODEX_LEASE_MS: String(options.leaseMs || 60000),
      ECHO_CODEX_WORKSPACES: `echo=${process.cwd()}`
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    child.kill();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
  await waitForServer(baseUrl, () => stderr);
  return { baseUrl, phoneToken, agentToken, agentId };
}

async function createSession(relay, prompt) {
  const created = await phoneJson(relay, "/api/codex/sessions", {
    method: "POST",
    body: { projectId: "echo", prompt, runtime: {} }
  });
  return created.session;
}

async function leaseSessionCommand(relay, agentInstanceId) {
  const leased = await pollSessionCommand(relay, agentInstanceId);
  assert.ok(leased.command);
  return leased.command;
}

function pollSessionCommand(relay, agentInstanceId, wait = 1000) {
  return agentJson(relay, `/api/agent/codex/sessions/next?wait=${wait}`, {
    agentId: relay.agentId,
    agentInstanceId,
    workspaces: [{ id: "echo", label: "Echo", path: process.cwd() }],
    runtime: { command: "fake-codex" },
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: new Date().toISOString()
  });
}

function phoneJson(relay, pathname, options = {}) {
  return requestJson(relay.baseUrl, relay.phoneToken, "X-Echo-Token", pathname, options.method || "GET", options.body);
}

function agentJson(relay, pathname, body) {
  return requestJson(relay.baseUrl, relay.agentToken, "X-Echo-Agent-Token", pathname, "POST", body);
}

async function requestJson(baseUrl, token, header, pathname, method, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", [header]: token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, data.error || `HTTP ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, stderrText) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/config`);
      if (response.ok) return;
    } catch {
      // Relay is still starting.
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for test relay server. ${stderrText()}`);
}

async function freePort() {
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
