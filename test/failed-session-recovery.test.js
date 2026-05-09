import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installCodex } from "../public/app/codex.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-failed-session-recovery-"));
process.env.HOME = tempHome;
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_CODEX_LEASE_MS = "60000";

const store = await import("../src/lib/codexStore.js");
const queue = await import("../src/lib/codexQueue.js");

test("failed sessions without a saved thread can still queue a follow-up from saved history", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "threadless-recovery-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "先看看这个限流问题" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(startCommand.id, { ok: false, error: "provider temporarily failed" }, { agentId: agent.id });

  const failed = queue.getCodexSession(session.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.appThreadId, null);
  assert.equal(failed.lastError, "provider temporarily failed");

  const continued = queue.enqueueCodexSessionMessage(session.id, { text: "恢复后继续这条上下文" });
  assert.equal(continued.status, "active");
  assert.equal(continued.lastError, "");
  assert.equal(continued.pendingCommandCount, 1);

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "");
  assert.equal(messageCommand.payload.text, "恢复后继续这条上下文");
  assert.equal(messageCommand.payload.history.some((message) => message.text === "先看看这个限流问题"), true);
});

test("composer keeps failed sessions as follow-up targets when saved history exists", async () => {
  const calls = [];
  const app = createRoutingApp(calls);
  app.state.selectedCodexJobId = "session-failed-history";
  app.state.selectedCodexSession = {
    id: "session-failed-history",
    projectId: "echo",
    status: "failed",
    lastError: "provider temporarily failed",
    messages: [{ role: "user", text: "先看看这个限流问题", attachments: [] }]
  };

  assert.equal(app.sessionCanRecoverFailure(app.state.selectedCodexSession), true);
  assert.equal(app.sessionCanAcceptFollowUp(app.state.selectedCodexSession), true);

  await app.sendCodexPrompt({
    projectId: "echo",
    prompt: "恢复后继续这条上下文",
    runtime: {},
    attachments: [],
    mode: "execute"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/codex/sessions/session-failed-history/messages");
  assert.equal(calls[0].body.text, "恢复后继续这条上下文");
});

function createRoutingApp(calls) {
  const app = {
    constants: {},
    elements: {},
    state: {
      selectedCodexJobId: "",
      selectedCodexSession: null,
      composingNewSession: false
    },
    currentProjectId: () => "echo",
    sessionBelongsToCurrentProject: (session) => Boolean(session?.id && session.projectId === "echo"),
    apiPost: async (path, body) => {
      calls.push({ path, body });
      return {
        session: {
          id: path.endsWith("/messages") ? "session-failed-history" : "session-new",
          projectId: body.projectId,
          status: "queued"
        }
      };
    }
  };
  installCodex(app);
  return app;
}
