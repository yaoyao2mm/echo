import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("desktop restart request script checkpoints the current session without killing the agent", async (t) => {
  const received = {};
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      received.url = req.url;
      received.token = req.headers["x-echo-agent-token"];
      received.body = JSON.parse(body || "{}");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, restart: { id: "restart-script-op", status: "requested" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "echo-restart-script-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const result = await execFileAsync(process.execPath, [
    "scripts/request-desktop-agent-restart.js",
    "--session", "session-script",
    "--summary", "resume this work"
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      ECHO_RELAY_URL: `http://127.0.0.1:${port}`,
      ECHO_AGENT_TOKEN: "restart-script-token",
      ECHO_AGENT_ID: "restart-script-agent",
      ECHO_AGENT_INSTANCE_ID: "restart-script-instance",
      ECHO_DESKTOP_RESTART_PROTOCOL_VERSION: "1",
      ECHO_SOURCE_REVISION: "0".repeat(40)
    }
  });

  assert.match(result.stdout, /checkpoint saved/);
  assert.equal(received.url, "/api/agent/codex/restarts");
  assert.equal(received.token, "restart-script-token");
  assert.equal(received.body.sessionId, "session-script");
  assert.equal(received.body.agentInstanceId, "restart-script-instance");
  assert.equal(received.body.protocolVersion, "1");
  assert.equal(received.body.runningRevision, "0".repeat(40));
  assert.equal(received.body.resumeSummary, "resume this work");
  assert.equal(received.body.expectedRevision, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
});

test("desktop restart request refuses a stale runtime that cannot complete the checkpoint protocol", async (t) => {
  let requestCount = 0;
  const server = http.createServer((_req, res) => {
    requestCount += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, restart: { id: "unexpected" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "echo-restart-script-stale-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/request-desktop-agent-restart.js",
      "--session", "session-script"
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        ECHO_RELAY_URL: `http://127.0.0.1:${port}`,
        ECHO_AGENT_TOKEN: "restart-script-token",
        ECHO_AGENT_ID: "restart-script-agent",
        ECHO_AGENT_INSTANCE_ID: "stale-instance",
        ECHO_DESKTOP_RESTART_PROTOCOL_VERSION: "",
        ECHO_SOURCE_REVISION: ""
      }
    }),
    (error) => {
      assert.match(error.stderr, /does not support checkpointed restart/i);
      return true;
    }
  );
  assert.equal(requestCount, 0);
});
