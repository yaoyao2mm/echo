import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("HTTP orchestration creation round-trips a desktop plan and exposes claimable work", async (t) => {
  const port = await freePort();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-orchestration-http-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const phoneToken = "orchestration-phone-token";
  const agentToken = "orchestration-agent-token";
  const agentId = "orchestration-agent";
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
      ECHO_AGENT_OWNER_USERNAME: "",
      ECHO_AUTH_ENABLED: "false"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  t.after(() => {
    child.kill();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
  await waitForServer(baseUrl, () => stderr);

  const agentSnapshot = {
    agentId,
    workspaces: [{ id: "echo", label: "Echo", path: process.cwd() }],
    runtime: {
      command: "fake-codex",
      plugins: {
        capability: { canManage: true, commandTypes: ["plugin.list", "plugin.update"] },
        plugins: [
          { id: "open-spec", enabled: true, requires: [], prerequisites: {} },
          { id: "orchestration", enabled: true, requires: ["open-spec"], prerequisites: { managedWorktree: true } }
        ]
      }
    }
  };
  await agentJson(baseUrl, agentToken, "/api/agent/codex/heartbeat", { method: "POST", body: agentSnapshot });

  const creating = apiJson(baseUrl, phoneToken, "/api/codex/orchestrations?wait=5000", {
    method: "POST",
    body: {
      projectId: "echo",
      targetAgentId: agentId,
      items: [{ changeId: "change-a", dependsOn: [] }],
      runtimePolicy: { backendId: "codex", permissionMode: "approve", maxConcurrency: 1 }
    }
  });
  const leased = await agentJson(baseUrl, agentToken, "/api/agent/codex/files/next?wait=1000", {
    method: "POST",
    body: agentSnapshot
  });
  assert.equal(leased.request.type, "orchestration-plan");
  assert.deepEqual(leased.request.payload.items, [{ changeId: "change-a", dependsOn: [] }]);

  const plan = {
    projectId: "echo",
    baseBranch: "main",
    baseCommit: "a".repeat(40),
    generatedAt: new Date().toISOString(),
    items: [{
      changeId: "change-a",
      title: "Change A",
      dependsOn: [],
      snapshot: { proposal: "A", tasks: ["Implement A"], specs: ["echo"] },
      fingerprint: "b".repeat(64)
    }]
  };
  const completion = await agentJson(baseUrl, agentToken, "/api/agent/codex/files/requests/complete", {
    method: "POST",
    body: { ...agentSnapshot, id: leased.request.id, result: { ok: true, plan } }
  });
  assert.equal(completion.ok, true);

  const created = await creating;
  assert.equal(created.run.status, "queued");
  assert.equal(created.run.items[0].changeId, "change-a");
  assert.equal(created.run.baseCommit, plan.baseCommit);

  const claimed = await agentJson(baseUrl, agentToken, "/api/agent/codex/orchestrations/next", {
    method: "POST",
    body: { ...agentSnapshot, workerId: "worker-1" }
  });
  assert.equal(claimed.work.attempt.kind, "implement");
  assert.equal(claimed.work.run.id, created.run.id);
  assert.equal(claimed.work.item.changeId, "change-a");
  assert.equal(claimed.leaseOwner, `${agentId}:worker-1`);
  assert.equal(claimed.leaseOwner, claimed.work.attempt.leaseOwner);
  const heartbeat = await agentJson(baseUrl, agentToken, `/api/agent/codex/orchestrations/${claimed.work.attempt.id}/heartbeat`, {
    method: "POST",
    body: { ...agentSnapshot, leaseOwner: claimed.leaseOwner }
  });
  assert.equal(heartbeat.attempt.leaseOwner, claimed.leaseOwner);
  const reconciled = await agentJson(baseUrl, agentToken, `/api/agent/codex/orchestrations/${claimed.work.attempt.id}/reconcile`, {
    method: "POST",
    body: {
      ...agentSnapshot,
      leaseOwner: claimed.leaseOwner,
      completedChangeIds: ["change-a"],
      branch: "main",
      commit: "c".repeat(40)
    }
  });
  assert.equal(reconciled.run.status, "completed");
  assert.equal(reconciled.run.progress.completed, 1);
  assert.equal(reconciled.run.progress.integrated, 1);
});

async function apiJson(baseUrl, token, pathname, options = {}) {
  return requestJson(baseUrl, pathname, { ...options, token, tokenHeader: "X-Echo-Token" });
}

async function agentJson(baseUrl, token, pathname, options = {}) {
  return requestJson(baseUrl, pathname, { ...options, token, tokenHeader: "X-Echo-Agent-Token" });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json", [options.tokenHeader]: options.token },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
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
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
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
