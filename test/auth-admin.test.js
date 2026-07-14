import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("owner admin API issues scoped pairing and agent tokens", async (t) => {
  const port = await freePort();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-auth-admin-"));
  const baseUrl = `http://127.0.0.1:${port}`;
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
      ECHO_TOKEN: "bootstrap-phone-token",
      ECHO_AGENT_TOKEN: "bootstrap-agent-token",
      ECHO_AUTH_ENABLED: "true",
      ECHO_USERS_JSON: JSON.stringify([
        { username: "owner", password: "owner-pass", role: "owner", displayName: "Owner" },
        { username: "alice", password: "alice-pass", role: "user", displayName: "Alice" },
        { username: "bob", password: "bob-pass", role: "user", displayName: "Bob" }
      ])
    },
    stdio: ["ignore", "ignore", "pipe"]
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  t.after(() => {
    child.kill();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, () => stderr);

  const owner = await login(baseUrl, "owner", "owner-pass");
  const alice = await login(baseUrl, "alice", "alice-pass");
  const bob = await login(baseUrl, "bob", "bob-pass");

  await requestJson(baseUrl, "/api/agent/codex/heartbeat", {
    method: "POST",
    agentToken: "bootstrap-agent-token",
    body: {
      agentId: "legacy-agent",
      workspaces: [{ id: "legacy", label: "Legacy", path: "/legacy/project" }],
      runtime: { command: "fake-codex" }
    }
  });

  const pairing = await requestJson(baseUrl, "/api/admin/pairing-tokens", {
    method: "POST",
    sessionToken: owner.sessionToken,
    body: { ownerUsername: "alice", label: "Alice phone" }
  });
  assert.match(pairing.token, /^ept_/);
  assert.equal(pairing.item.ownerUser, "alice");
  assert.equal(Object.hasOwn(pairing.item, "token"), false);

  const aliceStatus = await requestJson(baseUrl, "/api/status", {
    sessionToken: alice.sessionToken,
    echoToken: pairing.token
  });
  assert.equal(aliceStatus.user.username, "alice");
  assert.deepEqual(aliceStatus.codex.agents.map((agent) => agent.id), []);
  assert.deepEqual(aliceStatus.codex.workspaces.map((workspace) => workspace.key), []);

  const aliceStatusWithoutPairing = await requestJson(baseUrl, "/api/status", {
    sessionToken: alice.sessionToken
  });
  assert.equal(aliceStatusWithoutPairing.user.username, "alice");
  assert.deepEqual(aliceStatusWithoutPairing.codex.agents.map((agent) => agent.id), []);
  assert.deepEqual(aliceStatusWithoutPairing.codex.workspaces.map((workspace) => workspace.key), []);

  const bobWithAliceToken = await requestJson(baseUrl, "/api/status", {
    sessionToken: bob.sessionToken,
    echoToken: pairing.token,
    ok: false
  });
  assert.equal(bobWithAliceToken.status, 200);
  assert.deepEqual(bobWithAliceToken.data.codex.agents.map((agent) => agent.id), []);

  const agentToken = await requestJson(baseUrl, "/api/admin/agent-tokens", {
    method: "POST",
    sessionToken: owner.sessionToken,
    body: { ownerUsername: "alice", agentId: "alice-mac", displayName: "Alice Mac" }
  });
  assert.match(agentToken.token, /^eat_/);
  assert.equal(Object.hasOwn(agentToken.item, "token"), false);

  const heartbeat = await requestJson(baseUrl, "/api/agent/codex/heartbeat", {
    method: "POST",
    agentToken: agentToken.token,
    body: {
      agentId: "forged-agent",
      workspaces: [{ id: "echo", label: "Echo", path: "/alice/echo" }],
      runtime: { command: "fake-codex" }
    }
  });
  assert.equal(heartbeat.agent.id, "alice-mac");
  assert.deepEqual(heartbeat.codex.workspaces.map((workspace) => workspace.key), ["alice-mac:echo"]);

  const ownerAgentToken = await requestJson(baseUrl, "/api/admin/agent-tokens", {
    method: "POST",
    sessionToken: owner.sessionToken,
    body: { ownerUsername: "owner", agentId: "owner-mac", displayName: "Owner Mac" }
  });
  await requestJson(baseUrl, "/api/agent/codex/heartbeat", {
    method: "POST",
    agentToken: ownerAgentToken.token,
    body: {
      workspaces: [{ id: "echo", label: "Echo", path: "/owner/echo" }],
      runtime: { command: "fake-codex" }
    }
  });
  const ownerPairing = await requestJson(baseUrl, "/api/admin/pairing-tokens", {
    method: "POST",
    sessionToken: owner.sessionToken,
    body: { ownerUsername: "owner", label: "Owner phone" }
  });
  const ownerWorkbenchStatus = await requestJson(baseUrl, "/api/status", {
    sessionToken: owner.sessionToken,
    echoToken: ownerPairing.token
  });
  assert.deepEqual(ownerWorkbenchStatus.codex.agents.map((agent) => agent.id), ["owner-mac"]);
  assert.deepEqual(ownerWorkbenchStatus.codex.workspaces.map((workspace) => workspace.key), ["owner-mac:echo"]);

  const ownerWorkbenchStatusWithoutPairing = await requestJson(baseUrl, "/api/status", {
    sessionToken: owner.sessionToken
  });
  assert.deepEqual(ownerWorkbenchStatusWithoutPairing.codex.agents.map((agent) => agent.id), ["owner-mac"]);
  assert.deepEqual(ownerWorkbenchStatusWithoutPairing.codex.workspaces.map((workspace) => workspace.key), ["owner-mac:echo"]);

  const bobPairing = await requestJson(baseUrl, "/api/admin/pairing-tokens", {
    method: "POST",
    sessionToken: owner.sessionToken,
    body: { ownerUsername: "bob", label: "Bob phone before approval" }
  });
  const bobBeforeApproval = await requestJson(baseUrl, "/api/status", {
    sessionToken: bob.sessionToken,
    echoToken: bobPairing.token
  });
  assert.deepEqual(bobBeforeApproval.codex.agents.map((agent) => agent.id), []);

  const approval = await requestJson(baseUrl, "/api/admin/agent-approvals", {
    method: "POST",
    sessionToken: owner.sessionToken,
    body: { username: "bob", agentId: "owner-mac", ownerUsername: "owner", label: "Bob Safari" }
  });
  assert.match(approval.token, /^ept_/);
  assert.equal(approval.grant.granteeUser, "bob");
  assert.equal(approval.grant.agentId, "owner-mac");
  const bobAfterApproval = await requestJson(baseUrl, "/api/status", {
    sessionToken: bob.sessionToken,
    echoToken: approval.token
  });
  assert.deepEqual(bobAfterApproval.codex.agents.map((agent) => agent.id), ["owner-mac"]);
  assert.deepEqual(bobAfterApproval.codex.workspaces.map((workspace) => workspace.key), ["owner-mac:echo"]);

  const bobAfterApprovalWithoutPairing = await requestJson(baseUrl, "/api/status", {
    sessionToken: bob.sessionToken
  });
  assert.deepEqual(bobAfterApprovalWithoutPairing.codex.agents.map((agent) => agent.id), ["owner-mac"]);
  assert.deepEqual(bobAfterApprovalWithoutPairing.codex.workspaces.map((workspace) => workspace.key), ["owner-mac:echo"]);

  await requestJson(baseUrl, `/api/admin/agent-tokens/${encodeURIComponent(agentToken.item.id)}/revoke`, {
    method: "POST",
    sessionToken: owner.sessionToken,
    body: {}
  });
  const revokedAgent = await requestJson(baseUrl, "/api/agent/codex/heartbeat", {
    method: "POST",
    agentToken: agentToken.token,
    body: { workspaces: [] },
    ok: false
  });
  assert.equal(revokedAgent.status, 401);

  await requestJson(baseUrl, `/api/admin/pairing-tokens/${encodeURIComponent(pairing.item.id)}/disable`, {
    method: "POST",
    sessionToken: owner.sessionToken,
    body: { disabled: true }
  });
  const disabledPairing = await requestJson(baseUrl, "/api/status", {
    sessionToken: alice.sessionToken,
    echoToken: pairing.token
  });
  assert.deepEqual(disabledPairing.codex.agents.map((agent) => agent.id), ["alice-mac"]);

  const summary = await requestJson(baseUrl, "/api/admin/summary", {
    sessionToken: owner.sessionToken
  });
  assert.equal(summary.users.some((user) => user.username === "alice"), true);
  assert.equal(summary.tokens.pairingTokens.some((item) => item.id === pairing.item.id && item.disabledAt), true);
  assert.equal(summary.tokens.agentTokens.some((item) => item.id === agentToken.item.id && item.revokedAt), true);
  assert.equal(summary.tokens.agentAccessGrants.some((item) => item.agentId === "owner-mac" && item.granteeUser === "bob"), true);
});

async function login(baseUrl, username, password) {
  return requestJson(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, password }
  });
}

async function requestJson(baseUrl, pathName, options = {}) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (options.sessionToken) headers.Authorization = `Bearer ${options.sessionToken}`;
  if (options.echoToken) headers["X-Echo-Token"] = options.echoToken;
  if (options.agentToken) headers["X-Echo-Agent-Token"] = options.agentToken;
  const response = await fetch(`${baseUrl}${pathName}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (options.ok === false) return { status: response.status, data };
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
      // Server is still starting.
    }
    await delay(80);
  }
  throw new Error(`Timed out waiting for test relay server. ${stderrText()}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
