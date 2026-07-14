import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-queue-test-"));
process.env.HOME = tempHome;
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_CODEX_LEASE_MS = "60000";
process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = path.join(tempHome, ".echo-voice", "managed-workspaces.json");

const store = await import("../src/lib/codexStore.js");
const queue = await import("../src/lib/codexQueue.js");
const authStore = await import("../src/lib/authStore.js");
const db = new Database(path.join(tempHome, ".echo-voice", "echo.sqlite"));

test("status snapshot preserves backend contract metadata from desktop agents", () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "contract-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: {
      backendId: "claude-code",
      provider: "deepseek-via-claude",
      backendName: "Claude Code",
      command: "claude",
      model: "deepseek-v4-flash",
      supportedModels: [{ id: "deepseek-v4-flash", displayName: "DeepSeek-V4-Flash" }],
      allowedPermissionModes: ["strict"],
      contractVersion: "echo.backend-adapter.v1",
      capabilities: {
        commands: ["start", "message", "stop", "compact"],
        events: ["thread.started", "turn.started", "item.completed", "git.summary"],
        resultEvents: ["item.completed", "git.summary", "turn.completed"],
        supports: {
          attachments: false,
          cancellation: true,
          compaction: false,
          approvalRequests: false,
          interactionRequests: false,
          gitSummary: true,
          worktree: true
        },
        unsupportedFeatures: ["attachments", "remote-context-compaction"]
      },
      unsupportedFeatures: ["attachments", "remote-context-compaction"],
      installedSkills: [
        {
          name: "design-taste-frontend",
          description: "Premium frontend design rules.",
          providers: [{ provider: "codex", label: "Codex" }]
        }
      ],
      health: {
        ok: true,
        state: "ready",
        backendId: "claude-code",
        provider: "deepseek-via-claude",
        backendName: "Claude Code",
        checkedAt: "2026-05-07T00:00:00.000Z",
        reason: "",
        checks: { command: true, modelProbe: true }
      },
      mcp: {
        activeProfileId: "memory",
        snapshotHash: "current-mcp-hash",
        appliedSnapshotHash: "previous-mcp-hash",
        hasUpdates: true,
        profiles: [{ id: "memory", label: "Memory", serverIds: ["memory"] }],
        targetClients: ["codex"]
      }
    }
  });

  const status = queue.codexStatus();
  assert.equal(status.runtime.contractVersion, "echo.backend-adapter.v1");
  assert.equal(status.runtime.health.state, "ready");
  assert.equal(status.runtime.health.ok, true);
  assert.equal(status.runtime.capabilities.supports.worktree, true);
  assert.equal(status.runtime.capabilities.supports.gitSummary, true);
  assert.equal(status.runtime.unsupportedFeatures.includes("remote-context-compaction"), true);
  assert.equal(status.runtime.installedSkills[0].name, "design-taste-frontend");
  assert.equal(status.runtime.mcp.activeProfileId, "memory");
  assert.equal(status.runtime.mcp.snapshotHash, "current-mcp-hash");
  assert.equal(status.runtime.mcp.appliedSnapshotHash, "previous-mcp-hash");
  assert.equal(status.runtime.mcp.hasUpdates, true);
  assert.equal(status.runtime.mcp.profiles[0].label, "Memory");
});

test("agent skill commands validate owner advertised skill and provider", () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "skill-agent",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: {
      command: "fake-codex",
      agentSkills: {
        capability: {
          canManage: true,
          providers: [{ provider: "codex", label: "Codex" }]
        },
        skills: [
          {
            id: "skill:known",
            name: "design-taste-frontend",
            enabled: true,
            showInComposer: true,
            providers: [{ provider: "codex", label: "Codex", enabled: true }]
          }
        ]
      }
    }
  });

  const user = { username: "alice", displayName: "Alice", role: "user" };
  const command = queue.createCodexAgentSkillCommand({
    type: "agent-skill.update",
    targetAgentId: "skill-agent",
    skillId: "skill:known",
    enabled: true,
    showInComposer: false,
    targetProviders: ["codex"],
    requestedBy: "alice",
    ownerUser: "alice",
    path: "/tmp/should-not-forward",
    content: "SKILL.md body",
    user
  });

  assert.equal(command.type, "agent-skill.update");
  assert.deepEqual(command.payload, {
    requestedBy: "alice",
    skillId: "skill:known",
    enabled: true,
    showInComposer: false,
    targetProviders: ["codex"]
  });

  assert.throws(
    () =>
      queue.createCodexAgentSkillCommand({
        type: "agent-skill.update",
        targetAgentId: "skill-agent",
        skillId: "skill:unknown",
        targetProviders: ["codex"],
        user
      }),
    /Unknown agent skill/
  );
  assert.throws(
    () =>
      queue.createCodexAgentSkillCommand({
        type: "agent-skill.update",
        targetAgentId: "skill-agent",
        skillId: "skill:known",
        targetProviders: ["claude-code"],
        user
      }),
    /Unknown Agent Skill backend/
  );
  assert.throws(
    () =>
      queue.createCodexAgentSkillCommand({
        type: "agent-skill.update",
        targetAgentId: "skill-agent",
        skillId: "skill:known",
        targetProviders: ["codex"],
        user: { username: "bob", role: "user" }
      }),
    /Desktop agent is not online/
  );
});

test("agent skill import command only forwards controlled GitHub payload", () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "skill-import-agent",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: {
      command: "fake-codex",
      agentSkills: {
        capability: {
          canManage: true,
          providers: [
            { provider: "codex", label: "Codex" },
            { provider: "claude-code", label: "Claude Code" }
          ]
        },
        skills: []
      }
    }
  });

  const command = queue.createCodexAgentSkillCommand({
    type: "agent-skill.import",
    targetAgentId: "skill-import-agent",
    sourceUrl: "https://github.com/example/skills/tree/main/browser",
    targetProviders: ["codex"],
    requestedBy: "alice",
    ownerUser: "alice",
    path: "/tmp/should-not-forward",
    content: "SKILL.md body",
    user: { username: "alice", displayName: "Alice", role: "user" }
  });

  assert.equal(command.type, "agent-skill.import");
  assert.deepEqual(command.payload, {
    requestedBy: "alice",
    sourceUrl: "https://github.com/example/skills/tree/main/browser",
    enabled: true,
    showInComposer: true,
    targetProviders: ["codex"]
  });

  assert.throws(
    () =>
      queue.createCodexAgentSkillCommand({
        type: "agent-skill.import",
        targetAgentId: "skill-import-agent",
        sourceUrl: "https://github.com/example/skills",
        targetProviders: ["external"],
        user: { username: "alice", role: "user" }
      }),
    /Unknown Agent Skill backend/
  );
});

test("desktop plugin commands only accept advertised ids and bounded state", () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "plugin-agent",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: {
      command: "fake-codex",
      plugins: {
        capability: { canManage: true, commandTypes: ["plugin.list", "plugin.update"] },
        plugins: [{ id: "open-spec", name: "OpenSpec", enabled: true }]
      }
    }
  });

  const user = { username: "alice", displayName: "Alice", role: "user" };
  const command = queue.createCodexDesktopPluginCommand({
    type: "plugin.update",
    targetAgentId: "plugin-agent",
    pluginId: "open-spec",
    enabled: false,
    path: "/tmp/should-not-forward",
    content: "arbitrary plugin code",
    requestedBy: "alice",
    ownerUser: "alice",
    user
  });
  assert.equal(command.type, "plugin.update");
  assert.deepEqual(command.payload, { requestedBy: "alice", pluginId: "open-spec", enabled: false });

  assert.throws(
    () => queue.createCodexDesktopPluginCommand({ type: "plugin.update", targetAgentId: "plugin-agent", pluginId: "unknown", enabled: true, user }),
    /Unknown desktop plugin/
  );
  assert.throws(
    () => queue.createCodexDesktopPluginCommand({ type: "plugin.update", targetAgentId: "plugin-agent", pluginId: "open-spec", enabled: "yes", user }),
    /enabled state is required/
  );
});

test("orchestration plugin commands enforce advertised dependencies and Worktree capability", () => {
  const user = { username: "alice", role: "owner" };
  const agent = queue.updateCodexAgent({
    id: "orchestration-plugin-agent",
    ownerUser: "alice",
    workspaces: [{ id: "demo", path: "/tmp/demo" }],
    runtime: {
      plugins: {
        capability: { canManage: true, commandTypes: ["plugin.list", "plugin.update"] },
        plugins: [
          { id: "open-spec", enabled: true, requires: [], prerequisites: {} },
          {
            id: "orchestration",
            enabled: false,
            requires: ["open-spec"],
            prerequisites: { managedWorktree: false }
          }
        ]
      }
    }
  });

  assert.throws(
    () => queue.createCodexDesktopPluginCommand({
      type: "plugin.update",
      targetAgentId: agent.id,
      pluginId: "orchestration",
      enabled: true,
      user
    }),
    /Worktree capability is unavailable/
  );

  queue.updateCodexAgent({
    ...agent,
    runtime: {
      ...agent.runtime,
      plugins: {
        ...agent.runtime.plugins,
        plugins: agent.runtime.plugins.plugins.map((plugin) =>
          plugin.id === "orchestration"
            ? { ...plugin, prerequisites: { managedWorktree: true } }
            : plugin
        )
      }
    }
  });
  const command = queue.createCodexDesktopPluginCommand({
    type: "plugin.update",
    targetAgentId: agent.id,
    pluginId: "orchestration",
    enabled: true,
    user
  });
  assert.equal(command.payload.pluginId, "orchestration");
});

test("OpenSpec file requests require the desktop plugin to be enabled", () => {
  store.resetStoreForTest();
  const user = { username: "alice", role: "user" };
  const agent = {
    id: "plugin-files-agent",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: {
      command: "fake-codex",
      plugins: {
        capability: { canManage: true },
        plugins: [{ id: "open-spec", name: "OpenSpec", enabled: false }]
      }
    }
  };
  queue.updateCodexAgent(agent);
  assert.throws(
    () => queue.createCodexFileRequest({ type: "open-spec-summary", projectId: "echo", targetAgentId: agent.id, ownerUser: "alice", user }),
    /OpenSpec plugin is disabled/
  );

  queue.updateCodexAgent({
    ...agent,
    runtime: { ...agent.runtime, plugins: { ...agent.runtime.plugins, plugins: [{ id: "open-spec", enabled: true }] } }
  });
  const request = queue.createCodexFileRequest({
    type: "open-spec-summary",
    projectId: "echo",
    targetAgentId: agent.id,
    ownerUser: "alice",
    user
  });
  assert.equal(request.type, "open-spec-summary");
});

test("orchestration plan requests carry only bounded change identities", () => {
  const user = { username: "alice", role: "owner" };
  const agent = queue.updateCodexAgent({
    id: "orchestration-plan-agent",
    ownerUser: "alice",
    workspaces: [{ id: "demo", path: "/tmp/demo" }],
    runtime: {
      plugins: {
        capability: { canManage: true },
        plugins: [
          { id: "open-spec", enabled: true },
          { id: "orchestration", enabled: true }
        ]
      }
    }
  });
  const request = queue.createCodexFileRequest({
    type: "orchestration-plan",
    projectId: "demo",
    targetAgentId: agent.id,
    items: [{ changeId: "change-a", dependsOn: ["change-b"] }],
    ownerUser: "alice",
    user,
    path: "/tmp/ignored",
    command: "git status"
  });
  assert.equal(request.path, "");
  assert.deepEqual(request.payload, {
    path: "",
    items: [{ changeId: "change-a", dependsOn: ["change-b"] }]
  });
  assert.throws(
    () => queue.createCodexFileRequest({
      type: "orchestration-plan",
      projectId: "demo",
      targetAgentId: agent.id,
      items: [{ path: "/tmp/escape" }],
      ownerUser: "alice",
      user
    }),
    /change id/
  );
});

test("status advertises only online agent workspaces", () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "stale-agent",
    workspaces: [{ id: "e2e", label: "E2E", path: "/tmp/e2e" }],
    runtime: { command: "fake-codex" }
  });
  db.prepare("UPDATE codex_agents SET last_seen_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", "stale-agent");

  const staleStatus = queue.codexStatus();
  assert.equal(staleStatus.agentOnline, false);
  assert.deepEqual(staleStatus.workspaces, []);
  assert.equal(staleStatus.agents[0].online, false);

  queue.updateCodexAgent({
    id: "real-agent-a",
    workspaces: [
      { id: "echo", label: "Echo", path: "/workspace/echo" },
      { id: "metio", label: "Metio", path: "/workspace/metio" }
    ],
    runtime: { command: "codex", model: "gpt-5.4", unsupportedModels: ["gpt-5.5"] }
  });
  queue.updateCodexAgent({
    id: "real-agent-b",
    workspaces: [
      { id: "side", label: "Side", path: "/workspace/side" },
      { id: "echo", label: "Echo duplicate", path: "/other/echo" }
    ],
    runtime: { command: "codex", model: "gpt-5.5" }
  });

  const onlineStatus = queue.codexStatus();
  const workspaceIds = onlineStatus.workspaces.map((workspace) => workspace.id).sort();
  const workspaceKeys = onlineStatus.workspaces.map((workspace) => workspace.key).sort();
  assert.equal(onlineStatus.agentOnline, true);
  assert.deepEqual(workspaceIds, ["echo", "echo", "metio", "side"]);
  assert.deepEqual(workspaceKeys, ["real-agent-a:echo", "real-agent-a:metio", "real-agent-b:echo", "real-agent-b:side"]);
  assert.equal(onlineStatus.workspaces.filter((workspace) => workspace.id === "e2e").length, 0);
  assert.equal(new Set(onlineStatus.workspaces.filter((workspace) => workspace.id === "echo").map((workspace) => workspace.agentId)).size, 2);
  assert.match(onlineStatus.statusUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(onlineStatus.workspacesUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(onlineStatus.runtimeUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(onlineStatus.statusVersion, /^[a-f0-9]{16}$/);
  assert.equal(onlineStatus.runtime.backendId, "codex");
  assert.equal(onlineStatus.runtime.provider, "codex");
  assert.equal(onlineStatus.runtime.backendName, "Codex");
  assert.equal(onlineStatus.runtime.command, "codex");
  assert.deepEqual(onlineStatus.runtime.unsupportedModels, ["gpt-5.5"]);
  assert.equal(onlineStatus.agents.filter((agent) => agent.online).length, 2);
});

test("agent online status tolerates one missed desktop heartbeat", () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "heartbeat-jitter-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  });
  db.prepare("UPDATE codex_agents SET last_seen_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60 * 1000).toISOString(),
    "heartbeat-jitter-agent"
  );

  const status = queue.codexStatus();
  assert.equal(status.agentOnline, true);
  assert.deepEqual(status.workspaces.map((workspace) => workspace.key), ["heartbeat-jitter-agent:echo"]);
});

test("lightweight agent updates preserve advertised workspace snapshot", () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "snapshot-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex", model: "gpt-5.5" }
  });

  const firstStatus = queue.codexStatus();
  assert.deepEqual(firstStatus.workspaces.map((workspace) => workspace.key), ["snapshot-agent:echo"]);
  assert.equal(firstStatus.runtime.command, "fake-codex");

  queue.updateCodexAgent({ id: "snapshot-agent" });

  const preservedStatus = queue.codexStatus();
  assert.equal(preservedStatus.agentOnline, true);
  assert.deepEqual(preservedStatus.workspaces.map((workspace) => workspace.key), ["snapshot-agent:echo"]);
  assert.equal(preservedStatus.runtime.command, "fake-codex");
  assert.equal(preservedStatus.workspacesUpdatedAt, firstStatus.workspacesUpdatedAt);
  assert.equal(preservedStatus.runtimeUpdatedAt, firstStatus.runtimeUpdatedAt);

  queue.updateCodexAgent({
    id: "snapshot-agent",
    workspaces: [],
    runtime: { command: "updated-codex" }
  });

  const clearedStatus = queue.codexStatus();
  assert.deepEqual(clearedStatus.workspaces, []);
  assert.equal(clearedStatus.runtime.command, "updated-codex");
});

test("relay rejects unsupported Claude attachments and compaction before queueing work", () => {
  store.resetStoreForTest();

  const agent = {
    id: "claude-capability-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: claudeRosterRuntime()
  };
  queue.updateCodexAgent(agent);

  assert.throws(
    () =>
      queue.createCodexSession({
        projectId: "echo",
        prompt: "look at this screenshot",
        runtime: { backendId: "claude-code", permissionMode: "strict" },
        attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "screen.png", mimeType: "image/png", sizeBytes: 4 }]
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /文件附件/);
      return true;
    }
  );

  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "plan this safely",
    runtime: { backendId: "claude-code", permissionMode: "strict" }
  });
  assert.equal(created.runtime.backendId, "claude-code");
  assert.equal(created.runtime.capabilities.supports.attachments, false);
  assert.equal(created.runtime.capabilities.supports.compaction, false);

  assert.throws(
    () =>
      queue.enqueueCodexSessionMessage(created.id, {
        projectId: "echo",
        text: "now inspect this image",
        attachments: [{ type: "image", url: "data:image/png;base64,BBBB", name: "detail.png", mimeType: "image/png", sizeBytes: 4 }]
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /文件附件/);
      return true;
    }
  );

  const automaticCompact = queue.compactCodexSession(created.id, { automatic: true, reason: "context-threshold" });
  assert.equal(automaticCompact.id, created.id);
  assert.equal(compactCommandCount(created.id), 0);

  assert.throws(
    () => queue.compactCodexSession(created.id, { automatic: false, reason: "manual" }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /远程上下文压缩/);
      return true;
    }
  );
});

test("interactive Codex sessions are scoped to one project", () => {
  store.resetStoreForTest();

  const echoSession = queue.createCodexSession({
    projectId: "echo",
    prompt: "echo 项目的会话"
  });
  const metioSession = queue.createCodexSession({
    projectId: "metio",
    prompt: "metio 项目的会话"
  });

  assert.deepEqual(
    queue.listCodexSessions(10, { projectId: "echo" }).map((session) => session.id),
    [echoSession.id]
  );
  assert.deepEqual(
    queue.listCodexSessions(10, { projectId: "metio" }).map((session) => session.id),
    [metioSession.id]
  );
  assert.throws(
    () =>
      queue.enqueueCodexSessionMessage(echoSession.id, {
        projectId: "metio",
        text: "这条消息不能接到 echo 会话里"
      }),
    /different project/
  );

  const continued = queue.enqueueCodexSessionMessage(echoSession.id, {
    projectId: "echo",
    text: "这条消息属于 echo"
  });
  assert.equal(continued.projectId, "echo");
  assert.equal(continued.messages.filter((message) => message.role === "user").length, 2);
});

test("Codex status and sessions are scoped by owner user", () => {
  store.resetStoreForTest();

  const alice = { username: "alice", displayName: "Alice", role: "user" };
  const bob = { username: "bob", displayName: "Bob", role: "user" };
  const owner = { username: "owner", displayName: "Owner", role: "owner" };

  queue.updateCodexAgent({
    id: "alice-mac",
    ownerUser: "alice",
    displayName: "Alice Mac",
    workspaces: [{ id: "echo", label: "Echo", path: "/users/alice/echo" }],
    runtime: { command: "codex" }
  });
  queue.updateCodexAgent({
    id: "bob-pc",
    ownerUser: "bob",
    displayName: "Bob PC",
    workspaces: [
      { id: "echo", label: "Echo", path: "/users/bob/echo" },
      { id: "side", label: "Side", path: "/users/bob/side" }
    ],
    runtime: { command: "codex" }
  });

  const aliceStatus = queue.codexStatus({ user: alice });
  assert.deepEqual(aliceStatus.agents.map((agent) => agent.id), ["alice-mac"]);
  assert.deepEqual(aliceStatus.workspaces.map((workspace) => workspace.key), ["alice-mac:echo"]);

  const bobStatus = queue.codexStatus({ user: bob });
  assert.deepEqual(bobStatus.agents.map((agent) => agent.id), ["bob-pc"]);
  assert.deepEqual(
    bobStatus.workspaces.map((workspace) => workspace.key).sort(),
    ["bob-pc:echo", "bob-pc:side"]
  );

  const ownerStatus = queue.codexStatus({ user: owner });
  assert.deepEqual(
    ownerStatus.workspaces.map((workspace) => workspace.key).sort(),
    ["alice-mac:echo", "bob-pc:echo", "bob-pc:side"]
  );

  const aliceSession = queue.createCodexSession({
    projectId: "echo",
    targetAgentId: "alice-mac",
    ownerUser: "alice",
    user: alice,
    prompt: "Alice task"
  });
  const bobSession = queue.createCodexSession({
    projectId: "echo",
    targetAgentId: "bob-pc",
    ownerUser: "bob",
    user: bob,
    prompt: "Bob task"
  });

  assert.equal(queue.getCodexSession(aliceSession.id, { user: bob }), null);
  assert.equal(queue.getCodexSession(bobSession.id, { user: alice }), null);
  assert.equal(queue.getCodexSession(aliceSession.id, { user: owner })?.id, aliceSession.id);

  assert.deepEqual(
    queue.listCodexSessions(10, { projectId: "echo", targetAgentId: "alice-mac", user: alice }).map((session) => session.id),
    [aliceSession.id]
  );
  assert.deepEqual(
    queue.listCodexSessions(10, { projectId: "echo", targetAgentId: "bob-pc", user: bob }).map((session) => session.id),
    [bobSession.id]
  );
  assert.deepEqual(
    queue.listCodexSessions(10, { projectId: "echo", user: owner }).map((session) => session.id).sort(),
    [aliceSession.id, bobSession.id].sort()
  );
});

test("authenticated users do not see unowned legacy desktop agents", () => {
  store.resetStoreForTest();

  const alice = { username: "alice", displayName: "Alice", role: "user" };

  queue.updateCodexAgent({
    id: "legacy-agent",
    displayName: "Legacy Agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/legacy/echo" }],
    runtime: { command: "codex" }
  });
  queue.updateCodexAgent({
    id: "alice-mac",
    ownerUser: "alice",
    displayName: "Alice Mac",
    workspaces: [{ id: "alice", label: "Alice", path: "/alice/project" }],
    runtime: { command: "codex" }
  });

  const anonymousStatus = queue.codexStatus();
  assert.deepEqual(
    anonymousStatus.workspaces.map((workspace) => workspace.key).sort(),
    ["alice-mac:alice", "legacy-agent:echo"]
  );
  const legacySession = queue.createCodexSession({
    projectId: "echo",
    targetAgentId: "legacy-agent",
    prompt: "Legacy unowned task"
  });

  const aliceStatus = queue.codexStatus({ user: alice });
  assert.deepEqual(aliceStatus.agents.map((agent) => agent.id), ["alice-mac"]);
  assert.deepEqual(aliceStatus.workspaces.map((workspace) => workspace.key), ["alice-mac:alice"]);
  assert.equal(queue.getCodexSession(legacySession.id, { user: alice }), null);
  assert.deepEqual(queue.listCodexSessions(10, { user: alice }).map((session) => session.id), []);

  assert.throws(
    () =>
      queue.createCodexSession({
        projectId: "echo",
        targetAgentId: "legacy-agent",
        ownerUser: "alice",
        user: alice,
        prompt: "This should not reach an unowned agent"
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Desktop agent is not online/);
      return true;
    }
  );
});

test("target agent identity scopes session, file, and workspace leases", () => {
  store.resetStoreForTest();

  const alice = { username: "alice", displayName: "Alice", role: "user" };
  const bob = { username: "bob", displayName: "Bob", role: "user" };
  const agentA = {
    id: "agent-a",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/agent-a/echo" }],
    runtime: {
      command: "fake-codex",
      plugins: {
        capability: { canManage: true },
        plugins: [{ id: "open-spec", enabled: true }]
      }
    }
  };
  const agentB = {
    id: "agent-b",
    ownerUser: "bob",
    workspaces: [{ id: "echo", label: "Echo", path: "/agent-b/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agentA);
  queue.updateCodexAgent(agentB);

  const session = queue.createCodexSession({
    projectId: "echo",
    targetAgentId: "agent-a",
    ownerUser: "alice",
    user: alice,
    prompt: "Run on Alice's machine"
  });

  assert.equal(store.acquireNextSessionCommand({ agentId: "agent-b", workspaces: agentB.workspaces }), null);
  const startCommand = store.acquireNextSessionCommand({ agentId: "agent-a", workspaces: agentA.workspaces });
  assert.equal(startCommand?.sessionId, session.id);

  const fileRequest = queue.createCodexFileRequest({
    type: "list",
    projectId: "echo",
    targetAgentId: "agent-a",
    ownerUser: "alice",
    requestedBy: "alice",
    user: alice
  });
  assert.equal(store.acquireNextFileRequest({ agentId: "agent-b", workspaces: agentB.workspaces }), null);
  const leasedFileRequest = store.acquireNextFileRequest({ agentId: "agent-a", workspaces: agentA.workspaces });
  assert.equal(leasedFileRequest?.id, fileRequest.id);
  assert.equal(leasedFileRequest?.targetAgentId, "agent-a");

  const openSpecRequest = queue.createCodexFileRequest({
    type: "open-spec-summary",
    projectId: "echo",
    targetAgentId: "agent-a",
    ownerUser: "alice",
    requestedBy: "alice",
    user: alice,
    path: "../outside",
    maxChanges: 999,
    maxSpecs: 999
  });
  assert.equal(openSpecRequest.path, "");
  assert.equal(openSpecRequest.payload.path, "");
  assert.equal(openSpecRequest.payload.maxChanges, 200);
  assert.equal(openSpecRequest.payload.maxSpecs, 240);
  assert.equal(store.acquireNextFileRequest({ agentId: "agent-b", workspaces: agentB.workspaces }), null);
  const leasedOpenSpecRequest = store.acquireNextFileRequest({ agentId: "agent-a", workspaces: agentA.workspaces });
  assert.equal(leasedOpenSpecRequest?.id, openSpecRequest.id);
  assert.equal(leasedOpenSpecRequest?.type, "open-spec-summary");
  assert.equal(leasedOpenSpecRequest?.path, "");
  assert.equal(leasedOpenSpecRequest?.payload.path, "");
  assert.equal(leasedOpenSpecRequest?.targetAgentId, "agent-a");

  assert.throws(
    () =>
      queue.createCodexFileRequest({
        type: "open-spec-summary",
        projectId: "echo",
        targetAgentId: "agent-b",
        ownerUser: "alice",
        requestedBy: "alice",
        user: alice
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Desktop agent is not online/);
      return true;
    }
  );

  assert.throws(
    () =>
      queue.createCodexWorkspace({
        name: "other-user-workspace",
        targetAgentId: "agent-b",
        ownerUser: "alice",
        requestedBy: "alice",
        user: alice
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Desktop agent is not online/);
      return true;
    }
  );

  const workspaceCommand = queue.createCodexWorkspace({
    name: "alice-workspace",
    targetAgentId: "agent-a",
    ownerUser: "alice",
    requestedBy: "alice",
    user: alice
  });
  assert.equal(store.acquireNextWorkspaceCommand({ agentId: "agent-b" }), null);
  const leasedWorkspaceCommand = store.acquireNextWorkspaceCommand({ agentId: "agent-a" });
  assert.equal(leasedWorkspaceCommand?.id, workspaceCommand.id);
  assert.equal(leasedWorkspaceCommand?.targetAgentId, "agent-a");

  const ownerWorkspaceCommand = queue.createCodexWorkspace({
    name: "owner-managed-bob-workspace",
    targetAgentId: "agent-b",
    ownerUser: "owner",
    requestedBy: "owner",
    user: { username: "owner", role: "owner" }
  });
  assert.equal(store.acquireNextWorkspaceCommand({ agentId: "agent-b" })?.id, ownerWorkspaceCommand.id);
});

test("ambiguous duplicate workspace ids require an explicit target agent", () => {
  store.resetStoreForTest();

  const owner = { username: "owner", role: "owner" };
  queue.updateCodexAgent({
    id: "desk-a",
    ownerUser: "owner",
    workspaces: [{ id: "echo", label: "Echo", path: "/desk-a/echo" }],
    runtime: { command: "fake-codex" }
  });
  queue.updateCodexAgent({
    id: "desk-b",
    ownerUser: "owner",
    workspaces: [{ id: "echo", label: "Echo", path: "/desk-b/echo" }],
    runtime: { command: "fake-codex" }
  });

  assert.throws(
    () =>
      queue.createCodexSession({
        projectId: "echo",
        ownerUser: "owner",
        user: owner,
        prompt: "Run on whichever desktop"
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Multiple desktop environments/);
      return true;
    }
  );

  assert.throws(
    () =>
      queue.createCodexFileRequest({
        type: "list",
        projectId: "echo",
        ownerUser: "owner",
        requestedBy: "owner",
        user: owner
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Multiple desktop environments/);
      return true;
    }
  );

  const targeted = queue.createCodexSession({
    projectId: "echo",
    targetAgentId: "desk-b",
    ownerUser: "owner",
    user: owner,
    prompt: "Run on desk B"
  });
  assert.equal(targeted.targetAgentId, "desk-b");
});

test("attachments, approvals, and archive actions honor session ownership", () => {
  store.resetStoreForTest();

  const alice = { username: "alice", displayName: "Alice", role: "user" };
  const bob = { username: "bob", displayName: "Bob", role: "user" };
  const agent = {
    id: "alice-agent",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/alice/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);

  const session = queue.createCodexSession({
    projectId: "echo",
    targetAgentId: agent.id,
    ownerUser: "alice",
    user: alice,
    prompt: "Review this screenshot",
    attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "screen.png", mimeType: "image/png", sizeBytes: 4 }]
  });
  const detail = queue.getCodexSession(session.id, { user: alice });
  const attachmentId = detail.messages[0].attachments[0].id;
  assert.equal(queue.getCodexSessionAttachmentContent(attachmentId, { user: bob }), null);
  assert.equal(queue.getCodexSessionAttachmentContent(attachmentId, { user: bob, agentId: "other-agent" }), null);
  assert.equal(queue.getCodexSessionAttachmentContent(attachmentId, { user: bob, agentId: agent.id })?.id, attachmentId);
  assert.equal(queue.getCodexSessionAttachmentContent(attachmentId, { user: alice })?.id, attachmentId);

  const startCommand = store.acquireNextSessionCommand({ agentId: agent.id, workspaces: agent.workspaces });
  assert.equal(startCommand?.sessionId, session.id);
  const approval = queue.createCodexSessionApproval(
    {
      sessionId: session.id,
      appRequestId: "approval-owner-scope",
      method: "shell",
      prompt: "Run a command?",
      payload: { command: "pnpm test" }
    },
    { agentId: agent.id }
  );

  assert.throws(
    () => queue.decideCodexSessionApproval(approval.id, { sessionId: session.id, decision: "approved" }, { user: bob }),
    /Approval not found/
  );
  assert.equal(
    queue.decideCodexSessionApproval(approval.id, { sessionId: session.id, decision: "approved" }, { user: alice }).status,
    "approved"
  );

  assert.equal(queue.completeCodexSessionCommand(startCommand.id, { ok: true, sessionStatus: "active" }, { agentId: agent.id }), true);
  assert.throws(
    () => queue.archiveCodexSession(session.id, { archived: true, user: bob }),
    /Session not found/
  );
  assert.equal(queue.archiveCodexSession(session.id, { archived: true, user: alice }).archivedAt.length > 0, true);
});

test("per-user storage quota blocks writes and owner data deletion cleans files", () => {
  store.resetStoreForTest();
  authStore.resetAuthStoreForTest();

  const alice = { username: "alice", displayName: "Alice", role: "user" };
  const agent = {
    id: "quota-agent",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/alice/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);

  authStore.setStorageQuota("alice", 3);
  assert.throws(
    () =>
      queue.createCodexSession({
        projectId: "echo",
        targetAgentId: agent.id,
        ownerUser: "alice",
        user: alice,
        prompt: "too large",
        attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "screen.png", mimeType: "image/png", sizeBytes: 4 }]
      }),
    /Storage quota exceeded/
  );

  authStore.setStorageQuota("alice", 1024 * 1024);
  const session = queue.createCodexSession({
    projectId: "echo",
    targetAgentId: agent.id,
    ownerUser: "alice",
    user: alice,
    prompt: "within quota",
    attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "screen.png", mimeType: "image/png", sizeBytes: 4 }]
  });
  const attachmentId = queue.getCodexSession(session.id, { user: alice }).messages[0].attachments[0].id;
  const attachmentPath = queue.getCodexSessionAttachmentContent(attachmentId, { user: alice }).filePath;
  assert.equal(fs.existsSync(attachmentPath), true);

  const startCommand = store.acquireNextSessionCommand({ agentId: agent.id, workspaces: agent.workspaces });
  assert.equal(startCommand.sessionId, session.id);
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "item/completed",
          text: "image",
          raw: {
            method: "item/completed",
            params: {
              item: {
                id: "quota-image",
                type: "agentMessage",
                content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } }]
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );
  const artifactId = queue.getCodexSession(session.id, { user: alice }).artifacts[0].id;
  const artifactPath = queue.getCodexSessionArtifactContent(artifactId, { user: alice }).filePath;
  assert.equal(fs.existsSync(artifactPath), true);
  assert.equal(queue.codexOwnerStorageUsage("alice").totalBytes > 4, true);

  const deleted = queue.deleteCodexOwnerData("alice");
  assert.equal(deleted.deleted.sessions, 1);
  assert.equal(deleted.deleted.attachments, 1);
  assert.equal(deleted.deleted.artifacts, 1);
  assert.equal(queue.getCodexSession(session.id, { user: alice }), null);
  assert.equal(fs.existsSync(attachmentPath), false);
  assert.equal(fs.existsSync(artifactPath), false);
});

test("multi-user command leasing stays isolated under concurrent queue pressure", async () => {
  store.resetStoreForTest();

  const users = Array.from({ length: 12 }, (_, index) => {
    const n = index + 1;
    return {
      username: `user${n}`,
      agentId: `agent-${n}`,
      workspaceId: `project-${n}`,
      path: `/users/user${n}/project`
    };
  });

  await Promise.all(
    users.flatMap((entry) =>
      Array.from({ length: 3 }, async (_, index) => {
        queue.updateCodexAgent({
          id: entry.agentId,
          ownerUser: entry.username,
          workspaces: [{ id: entry.workspaceId, label: entry.workspaceId, path: entry.path }],
          runtime: { command: "fake-codex" }
        });
        return queue.createCodexSession({
          projectId: entry.workspaceId,
          targetAgentId: entry.agentId,
          ownerUser: entry.username,
          user: { username: entry.username, role: "user" },
          prompt: `task ${index + 1}`
        });
      })
    )
  );

  for (const entry of users) {
    const agent = { agentId: entry.agentId, workspaces: [{ id: entry.workspaceId, path: entry.path }] };
    const leased = [];
    for (;;) {
      const command = store.acquireNextSessionCommand(agent);
      if (!command) break;
      leased.push(command);
      const session = queue.getCodexSession(command.sessionId, { user: { username: entry.username, role: "user" } });
      assert.equal(session.ownerUser, entry.username);
      assert.equal(session.targetAgentId, entry.agentId);
    }
    assert.equal(leased.length, 3);
  }

  assert.equal(queue.listCodexSessions(100, { user: { username: "user1", role: "user" } }).length, 3);
  assert.equal(queue.listCodexSessions(100, { user: { username: "owner", role: "owner" } }).length, 36);
});

test("quick skills include globals and current project skills only", () => {
  store.resetStoreForTest();

  const defaults = queue.listCodexQuickSkills({ projectId: "echo" });
  assert.equal(defaults.some((skill) => skill.id === "builtin.quick-deploy" && skill.scope === "global"), true);
  assert.equal(defaults.some((skill) => skill.id === "builtin.echo-relay-deploy"), false);

  const globalSkill = queue.createCodexQuickSkill({
    scope: "global",
    title: "检查状态",
    description: "快速查看当前状态",
    prompt: "请检查当前项目状态。",
    mode: "plan"
  });
  const echoSkill = queue.createCodexQuickSkill({
    scope: "project",
    projectId: "echo",
    targetAgentId: "agent-a",
    title: "Echo 发布检查",
    prompt: "请按 Echo 的发布前检查清单执行。",
    requiresSession: true
  });
  const otherEchoSkill = queue.createCodexQuickSkill({
    scope: "project",
    projectId: "echo",
    targetAgentId: "agent-b",
    title: "Echo B 发布检查",
    prompt: "请按 Echo B 的发布前检查清单执行。"
  });
  queue.createCodexQuickSkill({
    scope: "project",
    projectId: "metio",
    title: "Metio 发布检查",
    prompt: "请按 Metio 的发布前检查清单执行。"
  });

  const echoSkills = queue.listCodexQuickSkills({ projectId: "echo", targetAgentId: "agent-a" });
  assert.equal(echoSkills.some((skill) => skill.id === globalSkill.id && skill.scope === "global" && skill.mode === "plan"), true);
  assert.equal(echoSkills.some((skill) => skill.id === echoSkill.id && skill.requiresSession && skill.targetAgentId === "agent-a"), true);
  assert.equal(echoSkills.some((skill) => skill.id === otherEchoSkill.id), false);
  assert.equal(echoSkills.some((skill) => skill.projectId === "metio"), false);
  assert.equal(queue.listCodexQuickSkills({ projectId: "echo", targetAgentId: "agent-b" }).some((skill) => skill.id === otherEchoSkill.id), true);

  const updated = queue.updateCodexQuickSkill(echoSkill.id, {
    scope: "project",
    projectId: "echo",
    title: "Echo 上线检查",
    prompt: "请执行 Echo 上线检查。"
  });
  assert.equal(updated.title, "Echo 上线检查");

  queue.deleteCodexQuickSkill(globalSkill.id);
  assert.equal(queue.listCodexQuickSkills({ projectId: "echo" }).some((skill) => skill.id === globalSkill.id), false);
});

test("session delta batches append to the visible assistant draft", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "write a long answer"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "turn/started",
          text: "Turn started.",
          raw: { method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1" } } }
        },
        {
          type: "item/agentMessage/delta",
          text: "Hello ",
          finalMessage: "Hello ",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "Hello " } }
        },
        {
          type: "item/agentMessage/delta",
          text: "from ",
          finalMessage: "from ",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "from " } }
        },
        {
          type: "item/agentMessage/delta",
          text: "Echo",
          finalMessage: "Echo",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "Echo" } }
        }
      ],
      { agentId: "session-agent" }
    ),
    true
  );

  assert.equal(queue.getCodexSession(created.id).finalMessage, "Hello from Echo");
  const streamSnapshot = queue.getCodexSession(created.id, {
    rawMode: "client",
    maxEvents: 2,
    includeMessages: false
  });
  assert.equal(streamSnapshot.messages, undefined);
  assert.equal(streamSnapshot.events.length, 2);
  assert.equal(streamSnapshot.events[0].raw.params.delta, undefined);
  assert.equal(streamSnapshot.events[1].raw.params.delta, undefined);
  assert.equal(streamSnapshot.finalMessage, "Hello from Echo");
});

test("session events redact known sensitive keys and enforce a serialized size boundary", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "bounded-event-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({ projectId: "echo", prompt: "store a bounded event" });
  await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  const secretValues = ["Bearer relay-secret-value", "cookie-secret-value", "token-secret-value", "env-secret-value"];
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "turn/completed",
          text: "Turn completed.",
          sessionStatus: "active",
          clearActiveTurnId: true,
          raw: {
            method: "turn/completed",
            authorization: secretValues[0],
            headers: { cookie: secretValues[1] },
            nested: [{ apiKey: secretValues[2] }, { env: { PRIVATE_VALUE: secretValues[3] } }],
            oversized: "x".repeat(120000),
            params: {
              threadId: "thr_bounded",
              turn: { id: "turn_bounded", status: "completed" }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const row = db.prepare(`
    SELECT type, text, raw_json AS rawJson
    FROM codex_session_events
    WHERE session_id = ? AND type = 'turn/completed'
    ORDER BY id DESC
    LIMIT 1
  `).get(created.id);
  const storedBytes = Buffer.byteLength(JSON.stringify({ type: row.type, text: row.text, raw: JSON.parse(row.rawJson) }), "utf8");
  assert.ok(storedBytes <= 64 * 1024);
  for (const secret of secretValues) assert.equal(row.rawJson.includes(secret), false);

  const detail = queue.getCodexSession(created.id, { rawMode: "client", includeMessages: false });
  const event = detail.events.find((item) => item.type === "turn/completed");
  assert.equal(event.raw.redacted, true);
  assert.equal(event.raw.truncated, true);
  assert.equal(event.raw.params.turn.id, "turn_bounded");
  assert.equal(event.raw.params.turn.status, "completed");
  assert.equal(detail.status, "active");
  assert.equal(detail.artifactCount, 0);
});

test("session deltas reset the visible assistant draft for a new turn", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "first question"
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.sessionId, created.id);

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "turn/started",
          text: "Turn started.",
          raw: { method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1" } } }
        },
        {
          type: "item/agentMessage/delta",
          text: "First draft",
          finalMessage: "First draft",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "First draft" } }
        },
        {
          type: "item/completed",
          text: "First answer",
          finalMessage: "First answer",
          raw: {
            method: "item/completed",
            params: { threadId: "thr_1", turnId: "turn_1", item: { id: "msg_1", type: "agentMessage", text: "First answer" } }
          }
        },
        {
          type: "turn/completed",
          text: "Turn completed.",
          raw: { method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } } }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );
  assert.equal(queue.completeCodexSessionCommand(startCommand.id, { ok: true, appThreadId: "thr_1", sessionStatus: "active" }, { agentId: agent.id }), true);
  assert.equal(queue.getCodexSession(created.id).finalMessage, "First answer");

  queue.enqueueCodexSessionMessage(created.id, { text: "second question" });
  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "turn/started",
          text: "Turn started.",
          raw: { method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_2" } } }
        },
        {
          type: "item/agentMessage/delta",
          text: "Second ",
          finalMessage: "Second ",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_2", delta: "Second " } }
        },
        {
          type: "item/agentMessage/delta",
          text: "draft",
          finalMessage: "draft",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_2", delta: "draft" } }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  assert.equal(queue.getCodexSession(created.id).finalMessage, "Second draft");
});

test("late deltas from a completed turn do not replace the visible assistant draft", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "first question"
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "turn/started",
          text: "Turn started.",
          raw: { method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1" } } }
        },
        {
          type: "item/completed",
          text: "First answer",
          finalMessage: "First answer",
          raw: {
            method: "item/completed",
            params: { threadId: "thr_1", turnId: "turn_1", item: { id: "msg_1", type: "agentMessage", text: "First answer" } }
          }
        },
        {
          type: "turn/completed",
          text: "Turn completed.",
          raw: { method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } } }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );
  assert.equal(queue.completeCodexSessionCommand(startCommand.id, { ok: true, appThreadId: "thr_1", sessionStatus: "active" }, { agentId: agent.id }), true);
  assert.equal(queue.getCodexSession(created.id).finalMessage, "First answer");

  queue.enqueueCodexSessionMessage(created.id, { text: "second question" });
  await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/agentMessage/delta",
          text: " stale old tail",
          finalMessage: " stale old tail",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: " stale old tail" } }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  assert.equal(queue.getCodexSession(created.id).finalMessage, "First answer");
});

test("session token usage events expose official context usage", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "measure context"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  const tokenUsage = {
    total: {
      totalTokens: 50000,
      inputTokens: 47000,
      cachedInputTokens: 3000,
      outputTokens: 3000,
      reasoningOutputTokens: 900
    },
    last: {
      totalTokens: 32000,
      inputTokens: 30000,
      cachedInputTokens: 1200,
      outputTokens: 2000,
      reasoningOutputTokens: 600
    },
    modelContextWindow: 128000
  };

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "thread/tokenUsage/updated",
          text: "Context usage updated.",
          raw: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thr_usage",
              turnId: "turn_usage",
              tokenUsage
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, {
    rawMode: "client",
    includeMessages: false
  });
  assert.equal(detail.contextUsage.source, "codex-app-server");
  assert.equal(detail.contextUsage.threadId, "thr_usage");
  assert.equal(detail.contextUsage.turnId, "turn_usage");
  assert.equal(detail.contextUsage.last.totalTokens, 32000);
  assert.equal(detail.contextUsage.total.totalTokens, 50000);
  assert.equal(detail.contextUsage.modelContextWindow, 128000);

  const usageEvent = detail.events.find((event) => event.type === "thread/tokenUsage/updated");
  assert.equal(usageEvent.raw.params.tokenUsage.last.totalTokens, 32000);
  assert.equal(usageEvent.raw.params.tokenUsage.total.totalTokens, 50000);
  assert.equal(usageEvent.raw.params.tokenUsage.modelContextWindow, 128000);

  const summary = queue.listCodexSessions(10, { projectId: "echo" })[0];
  assert.equal(summary.contextUsage.last.totalTokens, 32000);
});

test("session context usage ignores stale token usage after compaction", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "measure context before compaction"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "thread/tokenUsage/updated",
          text: "Context usage updated.",
          raw: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thr_usage_reset",
              turnId: "turn_before_compact",
              tokenUsage: {
                total: { totalTokens: 118000 },
                last: { totalTokens: 112000 },
                modelContextWindow: 128000
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  assert.equal(queue.getCodexSession(created.id, { includeMessages: false }).contextUsage.last.totalTokens, 112000);

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: "Context compaction completed.",
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_usage_reset",
              item: { type: "contextCompaction", id: "ctx_usage_reset" }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  assert.equal(queue.getCodexSession(created.id, { includeMessages: false }).contextUsage, null);
  assert.equal(queue.listCodexSessions(10, { projectId: "echo" })[0].contextUsage, null);

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "thread/tokenUsage/updated",
          text: "Context usage updated.",
          raw: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thr_usage_reset",
              turnId: "turn_after_compact",
              tokenUsage: {
                total: { totalTokens: 14000 },
                last: { totalTokens: 9000 },
                modelContextWindow: 128000
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, { includeMessages: false });
  assert.equal(detail.contextUsage.turnId, "turn_after_compact");
  assert.equal(detail.contextUsage.last.totalTokens, 9000);
});

test("Echo-native context usage events are exposed from non-Codex backends", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "context-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: claudeRosterRuntime()
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "measure Claude context",
    runtime: { backendId: "claude-code", permissionMode: "strict" }
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "context.usage.updated",
          text: "Claude Code context usage updated.",
          raw: {
            source: "claude-code",
            method: "context/usage/updated",
            params: {
              threadId: "claude_session_1",
              turnId: "claude_turn_1",
              source: "claude-code",
              usage: {
                total: {
                  totalTokens: 2048,
                  inputTokens: 1600,
                  cachedInputTokens: 128,
                  outputTokens: 320
                },
                last: {
                  totalTokens: 1024,
                  inputTokens: 800,
                  cachedInputTokens: 64,
                  outputTokens: 160
                },
                modelContextWindow: 200000
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, {
    rawMode: "client",
    includeMessages: false
  });
  assert.equal(detail.contextUsage.source, "claude-code");
  assert.equal(detail.contextUsage.threadId, "claude_session_1");
  assert.equal(detail.contextUsage.turnId, "claude_turn_1");
  assert.equal(detail.contextUsage.last.totalTokens, 1024);
  assert.equal(detail.contextUsage.total.totalTokens, 2048);
  assert.equal(detail.contextUsage.modelContextWindow, 200000);

  const usageEvent = detail.events.find((event) => event.type === "context.usage.updated");
  assert.equal(usageEvent.raw.source, "claude-code");
  assert.equal(usageEvent.raw.params.usage.last.totalTokens, 1024);
});

test("large command outputs are stored as session artifacts", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "artifact-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "run tests"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  const output = `${Array.from({ length: 900 }, (_, index) => `output line ${index}`).join("\n")}\nFAIL test/unit.test.js\nAssertionError: expected true`;
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: `pnpm test failed\n${output}`,
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_artifact",
              turnId: "turn_artifact",
              item: {
                id: "cmd_artifact",
                type: "commandExecution",
                status: "failed",
                command: ["pnpm", "test"],
                aggregatedOutput: output
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, {
    rawMode: "client",
    includeMessages: false
  });
  const event = detail.events.find((item) => item.type === "item/completed");
  assert.ok(event.id > 0);
  assert.equal(event.text.includes("output line 0"), false);
  assert.equal(event.raw.params.item.aggregatedOutputTruncated, true);
  assert.ok(event.raw.params.item.outputArtifact.id);
  const testSummary = detail.events.find((item) => item.type === "test.summary");
  assert.ok(testSummary.id > event.id);
  assert.equal(testSummary.raw.testSummary.level, "quick");
  assert.equal(testSummary.raw.testSummary.status, "failed");
  assert.equal(testSummary.raw.testSummary.turnId, "turn_artifact");
  assert.equal(testSummary.raw.testSummary.outputArtifact.id, event.raw.params.item.outputArtifact.id);
  assert.equal(testSummary.raw.testSummary.failures.some((line) => /FAIL test\/unit\.test\.js/.test(line)), true);
  assert.equal(detail.artifactCount, 1);
  assert.ok(detail.artifactBytes >= Buffer.byteLength(output));
  assert.equal(detail.metrics.artifactCount, 1);
  assert.equal(detail.metrics.risk, "normal");
  assert.equal(detail.memory.testSummary.status, "failed");
  assert.equal(detail.memory.testSummary.command, "pnpm test");

  const artifact = detail.artifacts[0];
  const content = queue.getCodexSessionArtifactContent(artifact.id);
  assert.equal(content.sizeBytes, Buffer.byteLength(output));
  assert.equal(fs.readFileSync(content.filePath, "utf8"), output);
});

test("client file-change events expose bounded transcript metadata without patch bodies", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "file-change-agent",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);
  const created = queue.createCodexSession({ projectId: "echo", prompt: "edit files" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, created.id);

  const changes = Array.from({ length: 24 }, (_, index) => ({
    path: `src/file-${index}.js`,
    changeType: index === 0 ? "added" : "modified",
    patch: `secret patch ${index}`
  }));
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: "File change completed.",
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_file_change",
              turnId: "turn_file_change",
              item: { id: "files-1", type: "fileChange", status: "completed", changes }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, { rawMode: "client", includeMessages: false });
  const event = detail.events.find((item) => item.type === "item/completed");
  assert.equal(event.raw.params.item.changes.length, 20);
  assert.deepEqual(event.raw.params.item.changes[0], { path: "src/file-0.js", changeType: "added" });
  assert.equal(JSON.stringify(event.raw).includes("secret patch"), false);
});

test("assistant inline images are stored as image artifacts", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "assistant-image-agent",
    workspaces: [{ id: "echo", path: process.cwd() }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);

  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "generate an image"
  });
  await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: "生成了一张图片。",
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_image",
              turnId: "turn_image",
              item: {
                id: "msg_image",
                type: "agentMessage",
                text: "生成了一张图片。",
                content: [
                  {
                    type: "image_url",
                    label: "preview.png",
                    image_url: {
                      url: `data:image/png;base64,${pngBase64}`
                    }
                  }
                ]
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, {
    rawMode: "client",
    includeMessages: false
  });
  const event = detail.events.find((item) => item.type === "item/completed");
  const imageArtifact = event.raw.params.item.imageArtifacts[0];
  assert.ok(imageArtifact.id);
  assert.equal(imageArtifact.kind, "assistant_image");
  assert.equal(imageArtifact.mimeType, "image/png");
  assert.ok(imageArtifact.downloadPath.startsWith("/api/codex/artifacts/"));
  assert.equal(JSON.stringify(event.raw).includes(pngBase64), false);
  assert.equal(detail.artifactCount, 1);
  assert.equal(detail.artifacts[0].mimeType, "image/png");

  const content = queue.getCodexSessionArtifactContent(imageArtifact.id);
  assert.equal(content.mimeType, "image/png");
  assert.deepEqual(fs.readFileSync(content.filePath), Buffer.from(pngBase64, "base64"));
});

test("assistant local image payloads from desktop are stored as image artifacts", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "assistant-local-image-agent",
    workspaces: [{ id: "echo", path: process.cwd() }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);

  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "send the screenshot"
  });
  await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: "直接看这张：",
          raw: {
            method: "item/completed",
            echoLocalImageArtifacts: [
              {
                source: "assistant-local-image",
                label: "当前对话界面",
                mimeType: "image/png",
                dataUrl: `data:image/png;base64,${pngBase64}`
              }
            ],
            params: {
              threadId: "thr_local_image",
              turnId: "turn_local_image",
              item: {
                id: "msg_local_image",
                type: "agentMessage",
                text: "直接看这张："
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, {
    rawMode: "client",
    includeMessages: false
  });
  const event = detail.events.find((item) => item.type === "item/completed");
  const imageArtifact = event.raw.params.item.imageArtifacts[0];
  assert.equal(event.text, "直接看这张：");
  assert.ok(imageArtifact.id);
  assert.equal(imageArtifact.kind, "assistant_image");
  assert.equal(imageArtifact.label, "当前对话界面");
  assert.equal(imageArtifact.mimeType, "image/png");
  assert.equal(JSON.stringify(event.raw).includes(pngBase64), false);

  const content = queue.getCodexSessionArtifactContent(imageArtifact.id);
  assert.equal(content.mimeType, "image/png");
  assert.deepEqual(fs.readFileSync(content.filePath), Buffer.from(pngBase64, "base64"));
});

test("assistant base64 image text is stored as an image artifact instead of visible text", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "assistant-base64-image-agent",
    workspaces: [{ id: "echo", path: process.cwd() }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);

  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "send an image"
  });
  await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: pngBase64,
          finalMessage: pngBase64,
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_text_image",
              turnId: "turn_text_image",
              item: {
                id: "msg_text_image",
                type: "agentMessage",
                text: pngBase64
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, { rawMode: "client" });
  const event = detail.events.find((item) => item.type === "item/completed");
  const imageArtifact = event.raw.params.item.imageArtifacts[0];

  assert.equal(event.text, "图片已生成。");
  assert.equal(event.raw.params.item.text, "图片已生成。");
  assert.equal(detail.finalMessage, "图片已生成。");
  assert.equal(detail.messages.some((message) => message.role === "assistant" && message.text === "图片已生成。"), true);
  assert.ok(imageArtifact.id);
  assert.equal(imageArtifact.kind, "assistant_image");
  assert.equal(imageArtifact.mimeType, "image/png");
  assert.equal(JSON.stringify(event.raw).includes(pngBase64), false);

  const content = queue.getCodexSessionArtifactContent(imageArtifact.id);
  assert.equal(content.mimeType, "image/png");
  assert.deepEqual(fs.readFileSync(content.filePath), Buffer.from(pngBase64, "base64"));
});

test("Codex image generation items are stored as image artifacts and reset the next thread", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "assistant-image-generation-agent",
    workspaces: [{ id: "echo", path: process.cwd() }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);

  const created = queue.createCodexSession({
    projectId: "echo",
    prompt: "send an image"
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_image_generation", activeTurnId: "turn_image_generation", sessionStatus: "running" },
    { agentId: agent.id }
  );

  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: pngBase64,
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_image_generation",
              turnId: "turn_image_generation",
              item: {
                id: "img_gen_1",
                type: "imageGeneration",
                status: "completed",
                result: pngBase64,
                revisedPrompt: "tiny transparent test image"
              }
            }
          }
        },
        {
          type: "turn/completed",
          text: "Turn completed.",
          raw: {
            method: "turn/completed",
            params: {
              threadId: "thr_image_generation",
              turn: { id: "turn_image_generation", status: "completed" }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const detail = queue.getCodexSession(created.id, { rawMode: "client" });
  const imageEvent = detail.events.find((item) => item.raw?.params?.item?.type === "imageGeneration");
  const imageArtifact = imageEvent.raw.params.item.imageArtifacts[0];
  const fullDetail = queue.getCodexSession(created.id);
  const fullImageEvent = fullDetail.events.find((item) => item.raw?.params?.item?.type === "imageGeneration");

  assert.equal(imageEvent.text, "图片已生成。");
  assert.equal(fullImageEvent.raw.params.item.result, imageArtifact.downloadPath);
  assert.equal(JSON.stringify(imageEvent.raw).includes(pngBase64), false);
  assert.equal(detail.finalMessage, "图片已生成。");
  assert.equal(detail.activeTurnId, null);
  assert.equal(detail.messages.some((message) => message.role === "assistant" && message.text === "图片已生成。"), true);

  const content = queue.getCodexSessionArtifactContent(imageArtifact.id);
  assert.equal(content.mimeType, "image/png");
  assert.deepEqual(fs.readFileSync(content.filePath), Buffer.from(pngBase64, "base64"));

  const continued = queue.enqueueCodexSessionMessage(created.id, { text: "继续下一句" });
  assert.equal(continued.pendingCommandCount, 1);
  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_image_generation");
  assert.equal(messageCommand.payload.resetThread, true);
  assert.equal(messageCommand.payload.resetReason, "assistant-image-artifact");
  assert.equal(messageCommand.payload.history.some((message) => message.text.includes(pngBase64)), false);
});

test("fork-summary sessions send compact memory without changing visible user text", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "fork-summary-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const source = queue.createCodexSession({
    projectId: "demo",
    prompt: "把移动端会话可靠性做完"
  });
  const sourceCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    sourceCommand.id,
    { ok: true, appThreadId: "thr_memory", activeTurnId: "turn_memory", sessionStatus: "running" },
    { agentId: agent.id }
  );
  assert.equal(
    queue.appendCodexSessionEvents(
      source.id,
      [
        {
          type: "item/completed",
          text: "已完成移动端中断和 SSE 恢复。",
          finalMessage: "已完成移动端中断和 SSE 恢复。",
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_memory",
              turnId: "turn_memory",
              item: { id: "msg_memory", type: "agentMessage", text: "已完成移动端中断和 SSE 恢复。" }
            }
          }
        },
        {
          type: "git.summary",
          text: "Changed this turn: 2",
          raw: {
            source: "desktop-agent",
            method: "git.summary",
            gitSummary: {
              root: process.cwd(),
              branch: "main",
              commit: "abc1234",
              changedFiles: ["public/app/sessions.js", "src/lib/codexStore.js"],
              changedDuringTurn: {
                changedFiles: ["public/app/sessions.js", "src/lib/codexStore.js"],
                commitChanged: false
              }
            }
          }
        },
        {
          type: "turn/completed",
          text: "Turn completed.",
          raw: { method: "turn/completed", params: { threadId: "thr_memory", turn: { id: "turn_memory", status: "completed" } } }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const sourceDetail = queue.getCodexSession(source.id);
  assert.equal(sourceDetail.memory.sourceSessionId, source.id);
  assert.match(sourceDetail.memory.summary, /移动端会话可靠性/);
  assert.equal(sourceDetail.memory.gitSummary.changedThisTurn, true);
  assert.equal(sourceDetail.memory.gitSummary.changedFiles.includes("src/lib/codexStore.js"), true);

  const forked = queue.createCodexSession({
    projectId: "demo",
    prompt: "继续按刚才方向收尾",
    sourceSessionId: source.id,
    threadMode: "fork-summary"
  });
  const forkCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(forkCommand.sessionId, forked.id);
  assert.equal(forkCommand.type, "start");
  assert.equal(forkCommand.payload.threadMode, "fork-summary");
  assert.equal(forkCommand.payload.sourceSessionId, source.id);
  assert.equal(forkCommand.payload.displayText, "继续按刚才方向收尾");
  assert.match(forkCommand.payload.prompt, /旧会话摘要/);
  assert.match(forkCommand.payload.prompt, /移动端会话可靠性/);
  assert.match(forkCommand.payload.prompt, /src\/lib\/codexStore\.js/);
  assert.match(forkCommand.payload.prompt, /当前用户请求：\n继续按刚才方向收尾/);
  assert.doesNotMatch(forkCommand.payload.prompt, /Codex thread|Latest Codex result|Codex/);

  const forkDetail = queue.getCodexSession(forked.id);
  assert.equal(forkDetail.messages[0].text, "继续按刚才方向收尾");
  const userEvent = forkDetail.events.find((event) => event.type === "user.message");
  assert.equal(userEvent.raw.threadMode, "fork-summary");
  assert.equal(userEvent.raw.sourceSessionId, source.id);
});

test("continued session commands include Echo memory for backend recovery", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "recovery-memory-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "把 Claude Code 适配做完"
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_recovery_memory", activeTurnId: "turn_recovery_memory", sessionStatus: "running" },
    { agentId: agent.id }
  );
  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "item/completed",
          text: "已完成上下文用量和压缩能力 gating。",
          finalMessage: "已完成上下文用量和压缩能力 gating。",
          raw: {
            method: "item/completed",
            params: {
              threadId: "thr_recovery_memory",
              turnId: "turn_recovery_memory",
              item: { id: "msg_recovery_memory", type: "agentMessage", text: "已完成上下文用量和压缩能力 gating。" }
            }
          }
        },
        {
          type: "turn/completed",
          text: "Turn completed.",
          raw: {
            method: "turn/completed",
            params: { threadId: "thr_recovery_memory", turn: { id: "turn_recovery_memory", status: "completed" } }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  queue.enqueueCodexSessionMessage(session.id, { text: "继续收掉恢复策略" });
  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.payload.text, "继续收掉恢复策略");
  assert.equal(messageCommand.payload.recoveryContext.source, "echo-session-memory");
  assert.equal(messageCommand.payload.recoveryContext.sourceSessionId, session.id);
  assert.match(messageCommand.payload.recoveryContext.summary, /把 Claude Code 适配做完/);
  assert.match(messageCommand.payload.recoveryContext.summary, /上下文用量和压缩能力 gating/);
  assert.equal(messageCommand.payload.recoveryContext.historyMessageCount >= 2, true);
});

test("continuing a session on a different backend resets the native thread id", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "backend-switch-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: claudeRosterRuntime()
  };
  queue.updateCodexAgent(agent);

  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "先用 Claude Code 分析问题",
    runtime: { backendId: "claude-code", permissionMode: "strict" }
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.runtime.backendId, "claude-code");

  assert.equal(
    queue.completeCodexSessionCommand(
      startCommand.id,
      { ok: true, appThreadId: "claude-thread-1", activeTurnId: "claude-turn-1", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );
  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "item/completed",
          text: "Claude Code 已定位到会话恢复问题。",
          finalMessage: "Claude Code 已定位到会话恢复问题。",
          raw: {
            method: "item/completed",
            params: {
              threadId: "claude-thread-1",
              turnId: "claude-turn-1",
              item: { id: "claude-message-1", type: "agentMessage", text: "Claude Code 已定位到会话恢复问题。" }
            }
          }
        },
        {
          type: "turn/completed",
          text: "Claude Code turn completed.",
          raw: {
            method: "turn/completed",
            params: { threadId: "claude-thread-1", turn: { id: "claude-turn-1", status: "completed" } }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const continued = queue.enqueueCodexSessionMessage(session.id, {
    text: "切到 Codex 继续修复",
    runtime: { backendId: "codex", permissionMode: "approve" }
  });
  assert.equal(continued.runtime.backendId, "codex");
  assert.equal(continued.appThreadId, null);

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.runtime.backendId, "codex");
  assert.equal(messageCommand.appThreadId, "");
  assert.equal(messageCommand.payload.resetThread, true);
  assert.equal(messageCommand.payload.resetReason, "backend-switch");
  assert.equal(messageCommand.payload.history.some((message) => message.text.includes("Claude Code 已定位")), true);

  const detail = queue.getCodexSession(session.id);
  const switched = detail.events.find((event) => event.type === "session.backend.switched");
  assert.ok(switched);
  assert.equal(switched.raw.previousRuntime.backendId, "claude-code");
  assert.equal(switched.raw.nextRuntime.backendId, "codex");
});

function claudeRosterRuntime() {
  return {
    backendId: "codex",
    provider: "codex",
    backendName: "Codex",
    command: "codex",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    allowedPermissionModes: ["strict", "approve", "full"],
    capabilities: {
      supports: {
        text: true,
        attachments: true,
        cancellation: true,
        contextUsage: true,
        compaction: true,
        approvalRequests: true,
        interactionRequests: true,
        gitSummary: true,
        worktree: true
      }
    },
    backends: [
      {
        backendId: "codex",
        provider: "codex",
        backendName: "Codex",
        command: "codex",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        allowedPermissionModes: ["strict", "approve", "full"],
        capabilities: {
          supports: {
            text: true,
            attachments: true,
            cancellation: true,
            contextUsage: true,
            compaction: true,
            approvalRequests: true,
            interactionRequests: true,
            gitSummary: true,
            worktree: true
          }
        }
      },
      {
        backendId: "claude-code",
        provider: "claude-code",
        backendName: "Claude Code",
        command: "claude",
        sandbox: "read-only",
        approvalPolicy: "on-request",
        profile: "strict",
        permissionMode: "strict",
        allowedPermissionModes: ["strict"],
        capabilities: {
          supports: {
            text: true,
            attachments: false,
            cancellation: true,
            contextUsage: true,
            compaction: false,
            approvalRequests: false,
            interactionRequests: false,
            gitSummary: true,
            worktree: true
          },
          unsupportedFeatures: ["attachments", "remote-context-compaction", "approval-requests", "interaction-requests"]
        },
        unsupportedFeatures: ["attachments", "remote-context-compaction", "approval-requests", "interaction-requests"]
      }
    ]
  };
}

test("interactive Codex sessions lease commands and keep thread state", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "session-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "先看一下这个项目",
    attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "screen.png", mimeType: "image/png", sizeBytes: 4 }],
    runtime: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      profile: "approve",
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    }
  });
  assert.equal(created.status, "queued");
  assert.equal(created.runtime.model, "");
  assert.equal(created.runtime.reasoningEffort, "");
  assert.equal(created.runtime.profile, "approve");
  assert.equal(created.runtime.sandbox, "workspace-write");
  assert.equal(created.runtime.approvalPolicy, "on-request");

  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.sessionId, created.id);
  assert.equal(startCommand.type, "start");
  assert.equal(startCommand.payload.prompt, "先看一下这个项目");
  assert.equal(startCommand.payload.attachments.length, 1);
  assert.equal(startCommand.payload.attachments[0].type, "image");
  assert.equal(startCommand.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);
  assert.equal(startCommand.payload.attachments[0].path, undefined);
  assert.equal(startCommand.runtime.model, "");
  assert.equal(startCommand.runtime.reasoningEffort, "");
  assert.equal(startCommand.runtime.profile, "approve");
  assert.equal(startCommand.runtime.sandbox, "workspace-write");
  assert.equal(startCommand.runtime.approvalPolicy, "on-request");

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [{ type: "thread.started", text: "started", appThreadId: "thr_1", sessionStatus: "active" }],
      { agentId: "session-agent" }
    ),
    true
  );
  assert.equal(
    queue.completeCodexSessionCommand(
      startCommand.id,
      { ok: true, appThreadId: "thr_1", activeTurnId: "turn_1", sessionStatus: "running" },
      { agentId: "session-agent" }
    ),
    true
  );

  const running = queue.getCodexSession(created.id);
  assert.equal(running.appThreadId, "thr_1");
  assert.equal(running.activeTurnId, "turn_1");
  assert.equal(running.status, "running");
  assert.equal(running.leasedBy, "session-agent");

  const duringRun = queue.enqueueCodexSessionMessage(created.id, {
    text: "先把这个条件也带上"
  });
  assert.equal(duringRun.status, "running");
  assert.equal(duringRun.pendingCommandCount, 1);
  assert.equal(duringRun.queuedCommandCount, 1);
  assert.equal(duringRun.leasedCommandCount, 0);

  const steeredCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(steeredCommand.type, "message");
  assert.equal(steeredCommand.appThreadId, "thr_1");
  assert.equal(steeredCommand.activeTurnId, "turn_1");
  assert.equal(steeredCommand.payload.text, "先把这个条件也带上");
  const duringSteer = queue.getCodexSession(created.id);
  assert.equal(duringSteer.pendingCommandCount, 1);
  assert.equal(duringSteer.queuedCommandCount, 0);
  assert.equal(duringSteer.leasedCommandCount, 1);
  assert.equal(
    queue.completeCodexSessionCommand(
      steeredCommand.id,
      { ok: true, appThreadId: "thr_1", activeTurnId: "turn_1", sessionStatus: "running" },
      { agentId: "session-agent" }
    ),
    true
  );

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/completed",
          text: "ECHO_INTERACTIVE_OK",
          finalMessage: "ECHO_INTERACTIVE_OK",
          raw: {
            method: "item/completed",
            params: { threadId: "thr_1", turnId: "turn_1", item: { type: "agentMessage", text: "ECHO_INTERACTIVE_OK" } }
          }
        }
      ],
      { agentId: "session-agent" }
    ),
    true
  );
  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "item/agentMessage/delta",
          text: "ECHO",
          finalMessage: "ECHO",
          raw: { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "ECHO" } }
        }
      ],
      { agentId: "session-agent" }
    ),
    true
  );
  assert.equal(queue.getCodexSession(created.id).finalMessage, "ECHO_INTERACTIVE_OK");

  assert.equal(
    queue.appendCodexSessionEvents(
      created.id,
      [
        {
          type: "turn/completed",
          text: "Turn completed.",
          raw: { method: "turn/completed", params: { threadId: "thr_1", turn: { status: "completed" } } }
        }
      ],
      { agentId: "session-agent" }
    ),
    true
  );
  assert.equal(queue.getCodexSession(created.id).status, "active");
  assert.equal(queue.getCodexSession(created.id).activeTurnId, null);
  assert.equal(queue.getCodexSession(created.id).leasedBy, null);

  const afterMessage = queue.enqueueCodexSessionMessage(created.id, {
    text: "继续修复 UI",
    attachments: [{ type: "image", url: "data:image/png;base64,BBBB", name: "detail.png", mimeType: "image/png", sizeBytes: 4 }],
    runtime: {
      model: "gpt-5.3-codex",
      reasoningEffort: "xhigh",
      profile: "strict",
      sandbox: "read-only",
      approvalPolicy: "on-request"
    }
  });
  assert.equal(afterMessage.pendingCommandCount, 1);
  assert.equal(afterMessage.runtime.model, "");
  assert.equal(afterMessage.runtime.reasoningEffort, "");
  assert.equal(afterMessage.runtime.profile, "strict");
  assert.equal(afterMessage.runtime.sandbox, "read-only");
  assert.equal(afterMessage.runtime.approvalPolicy, "on-request");

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_1");
  assert.equal(messageCommand.payload.text, "继续修复 UI");
  assert.equal(messageCommand.payload.attachments.length, 1);
  assert.equal(messageCommand.payload.attachments[0].type, "image");
  assert.equal(messageCommand.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);
  assert.equal(messageCommand.payload.attachments[0].path, undefined);
  assert.equal(messageCommand.runtime.model, "");
  assert.equal(messageCommand.runtime.reasoningEffort, "");
  assert.equal(messageCommand.runtime.profile, "strict");
  assert.equal(messageCommand.runtime.sandbox, "read-only");
  assert.equal(messageCommand.runtime.approvalPolicy, "on-request");
});

test("interactive Codex session heartbeats renew leased command leases", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "command-heartbeat-agent",
    agentInstanceId: "command-heartbeat-instance",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "长时间 plan turn" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  db.prepare("UPDATE codex_sessions SET lease_expires_at = ?, leased_instance_id = '' WHERE id = ?").run("2020-01-01T00:00:00.000Z", session.id);
  db.prepare("UPDATE codex_session_commands SET lease_expires_at = ?, leased_instance_id = '' WHERE id = ?").run(
    "2020-01-01T00:00:00.000Z",
    command.id
  );

  assert.equal(queue.appendCodexSessionEvents(session.id, [], { agentId: agent.id, agentInstanceId: agent.agentInstanceId }), true);

  const detail = queue.getCodexSession(session.id);
  const commandRow = db.prepare(`
    SELECT status, leased_by AS leasedBy, leased_instance_id AS leasedInstanceId, lease_expires_at AS leaseExpiresAt
    FROM codex_session_commands
    WHERE id = ?
  `).get(command.id);
  assert.equal(detail.leasedBy, agent.id);
  assert.equal(detail.leasedInstanceId, agent.agentInstanceId);
  assert.equal(commandRow.status, "leased");
  assert.equal(commandRow.leasedBy, agent.id);
  assert.equal(commandRow.leasedInstanceId, agent.agentInstanceId);
  assert.ok(Date.parse(commandRow.leaseExpiresAt) > Date.now());
  assert.equal(detail.events.some((event) => event.type === "command.lease.expired"), false);
});

test("interactive Codex sessions retry transient upstream failures before failing", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "upstream-retry-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    }
  };
  queue.updateCodexAgent(agent);

  const session = queue.createCodexSession({ projectId: "demo", prompt: "处理一个容易限流的任务" });
  const firstCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(firstCommand.type, "start");

  assert.equal(
    queue.completeCodexSessionCommand(
      firstCommand.id,
      { ok: false, error: "HTTP 429 Too Many Requests: rate limit reached for model gpt-5.4" },
      { agentId: agent.id }
    ),
    true
  );

  const firstRetry = queue.getCodexSession(session.id);
  assert.equal(firstRetry.status, "queued");
  assert.equal(firstRetry.pendingCommandCount, 1);
  assert.match(firstRetry.lastError, /retrying/i);
  assert.equal(firstRetry.events.some((event) => event.type === "command.retry.scheduled"), true);
  assert.equal(await queue.waitForCodexSessionCommand({ waitMs: 1000, agent }), null);

  const firstRetryRow = sessionCommandRow(firstCommand.id);
  assert.equal(firstRetryRow.status, "queued");
  assert.ok(Date.parse(firstRetryRow.availableAt) > Date.now());
  assert.equal(firstRetryRow.payload.retry.attempt, 1);
  assert.equal(firstRetryRow.payload.retry.originalReasoningEffort, "high");
  assert.equal(firstRetryRow.payload.retry.runtimeOverride.reasoningEffort, "high");

  makeSessionCommandAvailable(firstCommand.id);
  const secondCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(secondCommand.id, firstCommand.id);
  assert.equal(secondCommand.runtime.retryOverride.model, "gpt-5.4");
  assert.equal(secondCommand.runtime.retryOverride.reasoningEffort, "high");

  assert.equal(
    queue.completeCodexSessionCommand(
      secondCommand.id,
      { ok: false, error: "HTTP 503 Service Unavailable" },
      { agentId: agent.id }
    ),
    true
  );

  const secondRetryRow = sessionCommandRow(firstCommand.id);
  assert.equal(secondRetryRow.status, "queued");
  assert.equal(secondRetryRow.payload.retry.attempt, 2);
  assert.equal(secondRetryRow.payload.retry.downgradedReasoning, true);
  assert.equal(secondRetryRow.payload.retry.runtimeOverride.reasoningEffort, "medium");

  makeSessionCommandAvailable(firstCommand.id);
  const downgradedCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(downgradedCommand.runtime.retryOverride.reasoningEffort, "medium");

  queue.completeCodexSessionCommand(
    downgradedCommand.id,
    { ok: false, error: "HTTP 502 Bad Gateway" },
    { agentId: agent.id }
  );
  assert.equal(queue.getCodexSession(session.id).status, "failed");
  assert.equal(sessionCommandRow(firstCommand.id).status, "failed");
});

test("interactive Codex sessions retry failed turn completion events from upstream limits", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "upstream-turn-failed-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      model: "gpt-5.4",
      reasoningEffort: "xhigh",
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    }
  };
  queue.updateCodexAgent(agent);

  const session = queue.createCodexSession({ projectId: "demo", prompt: "启动后上游失败" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [
      { type: "thread.started", text: "started", appThreadId: "thr_retry", sessionStatus: "active" },
      {
        type: "turn/started",
        text: "Turn started.",
        raw: { method: "turn/started", params: { threadId: "thr_retry", turn: { id: "turn_retry" } } }
      },
      {
        type: "turn/completed",
        text: "Turn failed: 429 Too Many Requests",
        raw: {
          method: "turn/completed",
          params: {
            threadId: "thr_retry",
            turn: {
              id: "turn_retry",
              status: "failed",
              error: { message: "429 Too Many Requests: rate limit reached for model gpt-5.4" }
            }
          }
        }
      }
    ],
    { agentId: agent.id }
  );

  queue.completeCodexSessionCommand(
    command.id,
    { ok: true, appThreadId: "thr_retry", activeTurnId: "turn_retry", sessionStatus: "running" },
    { agentId: agent.id }
  );

  const retried = queue.getCodexSession(session.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.activeTurnId, null);
  assert.equal(retried.pendingCommandCount, 1);
  assert.equal(sessionCommandRow(command.id).payload.retry.runtimeOverride.reasoningEffort, "xhigh");
});

test("interactive Codex sessions retry late upstream failure events after command completion", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "late-upstream-turn-failed-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: {
      backendId: "codex",
      provider: "codex",
      backendName: "Codex",
      model: "gpt-5.4",
      reasoningEffort: "high",
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    }
  };
  queue.updateCodexAgent(agent);

  const session = queue.createCodexSession({ projectId: "demo", prompt: "上游容量满时自动重试" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.type, "start");

  assert.equal(
    queue.completeCodexSessionCommand(
      command.id,
      { ok: true, appThreadId: "thr_late_retry", activeTurnId: "turn_late_retry", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );
  assert.equal(sessionCommandRow(command.id).status, "done");

  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "turn/completed",
          text: "Turn failed: Selected model is at capacity.",
          raw: {
            method: "turn/completed",
            params: {
              threadId: "thr_late_retry",
              turn: {
                id: "turn_late_retry",
                status: "failed",
                error: { message: "Selected model is at capacity. Please try a different model.", codexErrorInfo: "serverOverloaded" }
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const retried = queue.getCodexSession(session.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.activeTurnId, null);
  assert.match(retried.lastError, /retrying/i);
  assert.equal(retried.events.some((event) => event.type === "command.retry.scheduled"), true);

  const retriedCommand = sessionCommandRow(command.id);
  assert.equal(retriedCommand.status, "queued");
  assert.equal(retriedCommand.payload.retry.attempt, 1);
  assert.equal(retriedCommand.payload.retry.runtimeOverride.model, "gpt-5.4");
  assert.equal(retriedCommand.payload.retry.runtimeOverride.reasoningEffort, "high");
});

test("interactive Codex leasing allows parallel sessions without re-entering one session command", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "parallel-lease-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const first = queue.createCodexSession({ projectId: "demo", prompt: "first task" });
  const second = queue.createCodexSession({ projectId: "demo", prompt: "second task" });
  const firstCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(firstCommand.sessionId, first.id);
  assert.equal(firstCommand.type, "start");

  queue.enqueueCodexSessionMessage(first.id, { text: "follow-up before the first thread exists" });

  const secondCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(secondCommand.sessionId, second.id);
  assert.equal(secondCommand.type, "start");

  const blockedSameSessionCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(blockedSameSessionCommand, null);
});

test("interactive Codex busy desktop hints protect active checkouts but allow isolated worktree sessions", async () => {
  store.resetStoreForTest();

  const directAgent = {
    id: "busy-direct-agent",
    workspaces: [
      { id: "demo", path: process.cwd() },
      { id: "docs", path: process.cwd() }
    ],
    runtime: { worktreeMode: "off", sandbox: "workspace-write", approvalPolicy: "on-request" }
  };

  queue.createCodexSession({ projectId: "demo", prompt: "change demo" });
  const docs = queue.createCodexSession({ projectId: "docs", prompt: "change docs" });
  const docsCommand = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: directAgent,
    busyProjectIds: ["demo"]
  });
  assert.equal(docsCommand.sessionId, docs.id);
  assert.equal(docsCommand.projectId, "docs");

  const blockedDemoCommand = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: directAgent,
    busyProjectIds: ["demo"]
  });
  assert.equal(blockedDemoCommand, null);

  store.resetStoreForTest();
  const running = queue.createCodexSession({ projectId: "demo", prompt: "long direct turn" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent: directAgent });
  queue.appendCodexSessionEvents(running.id, [{ type: "thread.started", text: "started", appThreadId: "thr_busy" }], {
    agentId: directAgent.id
  });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_busy", activeTurnId: "turn_busy", sessionStatus: "running" },
    { agentId: directAgent.id }
  );
  queue.enqueueCodexSessionMessage(running.id, { text: "steer the active direct turn" });

  const blockedFollowUp = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: directAgent,
    busyProjectIds: ["demo"]
  });
  assert.equal(blockedFollowUp, null);

  const allowedFollowUp = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: directAgent,
    busyProjectIds: ["demo"],
    runningSessionIds: [running.id]
  });
  assert.equal(allowedFollowUp.type, "message");
  assert.equal(allowedFollowUp.sessionId, running.id);

  store.resetStoreForTest();
  const worktreeAgent = {
    id: "busy-worktree-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { worktreeMode: "optional", sandbox: "workspace-write", approvalPolicy: "on-request" }
  };
  queue.createCodexSession({ projectId: "demo", prompt: "change demo without opt-in" });
  const blockedOptionalDefault = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: worktreeAgent,
    busyProjectIds: ["demo"]
  });
  assert.equal(blockedOptionalDefault, null);

  const isolated = queue.createCodexSession({
    projectId: "demo",
    prompt: "change demo in isolation",
    runtime: { worktreeMode: "always" }
  });
  const isolatedCommand = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: worktreeAgent,
    busyProjectIds: ["demo"]
  });
  assert.equal(isolatedCommand.sessionId, isolated.id);
  assert.equal(isolatedCommand.runtime.worktreeMode, "always");
});

test("interactive Codex follow-ups reuse persisted session worktree execution", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "worktree-reuse-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { worktreeMode: "optional", sandbox: "workspace-write", approvalPolicy: "on-request" }
  };
  const execution = {
    mode: "worktree",
    lifecycleState: "completed",
    sessionId: "",
    baseWorkspaceId: "demo",
    basePath: process.cwd(),
    path: path.join(tempHome, ".echo-voice", "worktrees", "demo", "session-reuse"),
    branchName: "echo/job-sessionreuse",
    baseBranch: "main",
    baseCommit: "abc123"
  };

  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "start isolated",
    runtime: { worktreeMode: "always" }
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.runtime.worktreeMode, "always");
  queue.completeCodexSessionCommand(
    startCommand.id,
    {
      ok: true,
      appThreadId: "thr_worktree_reuse",
      sessionStatus: "active",
      execution: { ...execution, sessionId: session.id }
    },
    { agentId: agent.id }
  );

  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.execution.path, execution.path);
  assert.equal(completed.execution.lifecycleState, "completed");

  queue.enqueueCodexSessionMessage(session.id, { text: "reuse the same isolated checkout" });
  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.execution.path, execution.path);
  assert.equal(messageCommand.execution.lifecycleState, "completed");
  assert.equal(messageCommand.runtime.worktreeMode, "always");
});

test("interactive Codex makes repeated terminal worktree actions idempotent", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "closed-worktree-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { worktreeMode: "optional", sandbox: "workspace-write", approvalPolicy: "on-request" }
  };

  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "apply isolated",
    runtime: { worktreeMode: "always" }
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    startCommand.id,
    {
      ok: true,
      appThreadId: "thr_closed_worktree",
      sessionStatus: "active",
      execution: {
        mode: "worktree",
        lifecycleState: "applied",
        cleanupState: "applied",
        sessionId: session.id,
        baseWorkspaceId: "demo",
        basePath: process.cwd(),
        path: path.join(tempHome, ".echo-voice", "worktrees", "demo", "session-applied"),
        branchName: "echo/job-sessionapplied"
      }
    },
    { agentId: agent.id }
  );

  assert.throws(
    () => queue.enqueueCodexSessionMessage(session.id, { text: "continue after apply" }),
    /no longer available/
  );
  assert.equal(queue.queueCodexSessionWorktreeAction(session.id, { action: "apply" }).execution.lifecycleState, "applied");
  assert.throws(() => queue.queueCodexSessionWorktreeAction(session.id, { action: "discard" }), /already been applied/);
});

test("interactive Codex persists structured unavailable and apply-blocked worktree states", async () => {
  store.resetStoreForTest();
  const user = { username: "alice", role: "user" };
  const agent = {
    id: "worktree-state-agent",
    ownerUser: "alice",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { worktreeMode: "optional", sandbox: "workspace-write", approvalPolicy: "on-request" }
  };
  queue.updateCodexAgent(agent);
  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "isolate",
    ownerUser: "alice",
    targetAgentId: agent.id,
    user,
    runtime: { worktreeMode: "always" }
  });
  const start = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(start.id, {
    ok: true,
    operationSucceeded: false,
    errorCode: "not-git",
    error: "Worktree isolation requires a Git workspace.",
    sessionStatus: "active",
    execution: {
      mode: "worktree",
      lifecycleState: "unavailable",
      cleanupState: "unavailable",
      sessionId: session.id,
      baseWorkspaceId: "demo",
      errorCode: "not-git",
      errorSummary: "Worktree isolation requires a Git workspace."
    }
  }, { agentId: agent.id });
  const unavailable = queue.getCodexSession(session.id, { user });
  assert.equal(unavailable.status, "active");
  assert.equal(unavailable.execution.lifecycleState, "unavailable");
  assert.equal(unavailable.execution.errorCode, "not-git");

  db.prepare("UPDATE codex_sessions SET execution_json = ? WHERE id = ?").run(JSON.stringify({
    mode: "worktree",
    lifecycleState: "apply-blocked",
    cleanupState: "apply-blocked",
    sessionId: session.id,
    baseWorkspaceId: "demo",
    path: path.join(tempHome, ".echo-voice", "worktrees", "demo", session.id),
    errorCode: "base-advanced"
  }), session.id);
  const retry = queue.queueCodexSessionWorktreeAction(session.id, { action: "apply", user });
  assert.equal(retry.pendingCommandCount, 1);
  assert.equal(retry.execution.path, undefined);
  assert.equal(retry.execution.basePath, undefined);
  const leasedRetry = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.match(leasedRetry.execution.path, /worktrees/);
});

test("queued sessions expose when they are waiting for the same project checkout", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "queue-blocker-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const running = queue.createCodexSession({ projectId: "demo", prompt: "inspect demo" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_blocker", activeTurnId: "turn_blocker", sessionStatus: "running" },
    { agentId: agent.id }
  );

  const queued = queue.createCodexSession({ projectId: "demo", prompt: "change demo next" });
  const queuedDetail = queue.getCodexSession(queued.id);
  assert.equal(queuedDetail.queueBlocker.type, "project_busy");
  assert.equal(queuedDetail.queueBlocker.projectId, "demo");
  assert.equal(queuedDetail.queueBlocker.blockedBySessionId, running.id);

  queue.updateCodexAgent({
    ...agent,
    runtime: { worktreeMode: "optional", sandbox: "workspace-write", approvalPolicy: "on-request" }
  });
  const isolated = queue.createCodexSession({
    projectId: "demo",
    prompt: "change demo in a worktree",
    runtime: { worktreeMode: "always" }
  });
  const isolatedDetail = queue.getCodexSession(isolated.id);
  assert.equal(isolatedDetail.queueBlocker, null);
});

test("interactive status ignores queued commands that cannot be leased from terminal sessions", () => {
  store.resetStoreForTest();

  const session = queue.createCodexSession({ projectId: "demo", prompt: "will fail before pickup" });
  db.prepare("UPDATE codex_sessions SET status = 'failed', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    session.id
  );

  const status = queue.codexStatus();
  assert.equal(status.interactive.queuedCommands, 0);
  const command = db.prepare("SELECT status, error FROM codex_session_commands WHERE session_id = ?").get(session.id);
  assert.equal(command.status, "failed");
  assert.match(command.error, /no longer runnable/);
});

test("interactive Codex command completion keeps turns that already completed", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "race-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "finish quickly"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  queue.appendCodexSessionEvents(
    session.id,
    [
      { type: "thread.started", text: "started", appThreadId: "thr_fast", sessionStatus: "active" },
      {
        type: "turn/started",
        text: "Turn started.",
        appThreadId: "thr_fast",
        activeTurnId: "turn_fast",
        sessionStatus: "running",
        raw: { method: "turn/started", params: { threadId: "thr_fast", turn: { id: "turn_fast" } } }
      },
      {
        type: "turn/completed",
        text: "Turn completed.",
        raw: { method: "turn/completed", params: { threadId: "thr_fast", turn: { id: "turn_fast", status: "completed" } } }
      }
    ],
    { agentId: agent.id }
  );

  const beforeCommandComplete = queue.getCodexSession(session.id);
  assert.equal(beforeCommandComplete.status, "active");
  assert.equal(beforeCommandComplete.activeTurnId, null);
  assert.equal(beforeCommandComplete.leasedBy, agent.id);

  assert.equal(
    queue.completeCodexSessionCommand(
      command.id,
      { ok: true, appThreadId: "thr_fast", activeTurnId: "turn_fast", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.activeTurnId, null);
  assert.equal(completed.leasedBy, null);

  db.prepare(`
    UPDATE codex_sessions
    SET status = 'running',
        active_turn_id = 'turn_fast',
        leased_by = ?,
        lease_expires_at = ?
    WHERE id = ?
  `).run(agent.id, new Date(Date.now() + 60000).toISOString(), session.id);
  const reconciled = queue.getCodexSession(session.id);
  assert.equal(reconciled.status, "active");
  assert.equal(reconciled.activeTurnId, null);
  assert.equal(reconciled.leasedBy, null);
  assert.equal(reconciled.events.some((event) => event.type === "session.reconciled"), true);

  const failedSession = queue.createCodexSession({
    projectId: "demo",
    prompt: "fail quickly"
  });
  const failedCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });

  queue.appendCodexSessionEvents(
    failedSession.id,
    [
      { type: "thread.started", text: "started", appThreadId: "thr_failed", sessionStatus: "active" },
      {
        type: "turn/started",
        text: "Turn started.",
        raw: { method: "turn/started", params: { threadId: "thr_failed", turn: { id: "turn_failed" } } }
      },
      {
        type: "turn/completed",
        text: "Turn failed: boom",
        raw: {
          method: "turn/completed",
          params: {
            threadId: "thr_failed",
            turn: {
              id: "turn_failed",
              status: "failed",
              error: { message: "boom" }
            }
          }
        }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(
    queue.completeCodexSessionCommand(
      failedCommand.id,
      { ok: true, appThreadId: "thr_failed", activeTurnId: "turn_failed", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const failed = queue.getCodexSession(failedSession.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.activeTurnId, null);
  assert.equal(failed.leasedBy, null);
  assert.match(failed.lastError, /boom/);
});

test("interactive Codex sessions can start from screenshots only", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "image-only-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const created = queue.createCodexSession({
    projectId: "demo",
    attachments: [{ type: "image", url: "data:image/png;base64,CCCC", name: "mobile.png", mimeType: "image/png", sizeBytes: 4 }]
  });
  assert.equal(created.title, "1 张截图");

  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.type, "start");
  assert.equal(startCommand.payload.prompt, "");
  assert.equal(startCommand.payload.attachments.length, 1);
  assert.equal(startCommand.payload.attachments[0].type, "image");
  assert.equal(startCommand.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);

  const session = queue.getCodexSession(created.id);
  assert.equal(session.messages.length >= 1, true);
  assert.equal(session.messages[0].text, "");
  assert.equal(session.messages[0].attachments.length, 1);
  assert.equal(session.messages[0].attachments[0].name, "mobile.png");
});

test("interactive Codex sessions can start from files only", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "file-only-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const fileBase64 = Buffer.from("alpha,beta\n1,2\n", "utf8").toString("base64");

  const created = queue.createCodexSession({
    projectId: "demo",
    attachments: [{ type: "file", url: `data:text/csv;base64,${fileBase64}`, name: "sample.csv", mimeType: "text/csv", sizeBytes: 15 }]
  });
  assert.equal(created.title, "1 个附件");

  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.type, "start");
  assert.equal(startCommand.payload.prompt, "");
  assert.equal(startCommand.payload.attachments.length, 1);
  assert.equal(startCommand.payload.attachments[0].type, "file");
  assert.equal(startCommand.payload.attachments[0].name, "sample.csv");
  assert.equal(startCommand.payload.attachments[0].mimeType, "text/csv");
  assert.equal(startCommand.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);

  const session = queue.getCodexSession(created.id);
  assert.equal(session.messages.length >= 1, true);
  assert.equal(session.messages[0].text, "");
  assert.equal(session.messages[0].attachments.length, 1);
  assert.equal(session.messages[0].attachments[0].type, "file");
  assert.equal(session.messages[0].attachments[0].name, "sample.csv");

  const content = queue.getCodexSessionAttachmentContent(session.messages[0].attachments[0].id);
  assert.equal(content.mimeType, "text/csv");
  assert.equal(fs.readFileSync(content.filePath, "utf8"), "alpha,beta\n1,2\n");
});

test("interactive Codex image sessions ignore mobile model overrides", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "image-fallback-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "看图说话",
    attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "vision.png", mimeType: "image/png", sizeBytes: 4 }],
    runtime: { model: "gpt-5.5", sandbox: "danger-full-access", approvalPolicy: "never", reasoningEffort: "xhigh", profile: "full" }
  });
  assert.equal(created.runtime.model, "");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.runtime.model, "");
  assert.equal(command.payload.attachments[0].type, "image");
  assert.equal(command.payload.attachments[0].downloadPath.startsWith("/api/agent/codex/attachments/"), true);
});

test("interactive Codex sessions avoid models that require a newer CLI", async () => {
  store.resetStoreForTest();
  const previousUnsupportedModels = process.env.ECHO_CODEX_UNSUPPORTED_MODELS;
  process.env.ECHO_CODEX_UNSUPPORTED_MODELS = "gpt-5.5";
  try {
    const agent = {
      id: "model-fallback-agent",
      workspaces: [{ id: "demo", path: process.cwd() }]
    };

    const created = queue.createCodexSession({
      projectId: "demo",
      prompt: "现在如何了？",
      runtime: { model: "gpt-5.5", sandbox: "danger-full-access", approvalPolicy: "never", reasoningEffort: "xhigh", profile: "full" }
    });
    assert.equal(created.runtime.model, "");
    assert.equal(created.runtime.sandbox, "danger-full-access");

    const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
    assert.equal(command.runtime.model, "");
    assert.equal(command.payload.prompt, "现在如何了？");
  } finally {
    if (previousUnsupportedModels === undefined) delete process.env.ECHO_CODEX_UNSUPPORTED_MODELS;
    else process.env.ECHO_CODEX_UNSUPPORTED_MODELS = previousUnsupportedModels;
  }
});

test("interactive Codex sessions reject model overrides until the desktop advertises them", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "supported-model-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "使用新模型",
    runtime: { model: "gpt-5.5", sandbox: "danger-full-access", approvalPolicy: "never", reasoningEffort: "xhigh", profile: "full" }
  });
  assert.equal(created.runtime.model, "");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.runtime.model, "");
  assert.equal(command.payload.prompt, "使用新模型");
});

test("interactive Codex full access can be enabled from mobile without extra Echo approval", async () => {
  store.resetStoreForTest();

  queue.updateCodexAgent({
    id: "full-access-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      allowedPermissionModes: ["strict", "approve", "full"],
      supportedModels: [{ id: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }]
    }
  });

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "全权限执行",
    runtime: { model: "gpt-5.5", sandbox: "danger-full-access", approvalPolicy: "never", reasoningEffort: "xhigh", profile: "full" }
  });

  assert.equal(created.runtime.profile, "full");
  assert.equal(created.runtime.sandbox, "danger-full-access");
  assert.equal(created.runtime.approvalPolicy, "never");
  assert.equal(created.runtime.model, "gpt-5.5");
  assert.equal(created.runtime.reasoningEffort, "xhigh");

  const command = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: {
      id: "full-access-agent",
      workspaces: [{ id: "demo", path: process.cwd() }],
      runtime: {
        allowedPermissionModes: ["strict", "approve", "full"],
        supportedModels: [{ id: "gpt-5.5", displayName: "GPT-5.5", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }]
      }
    }
  });
  assert.equal(command.runtime.profile, "full");
  assert.equal(command.runtime.sandbox, "danger-full-access");
  assert.equal(command.runtime.approvalPolicy, "never");
  assert.equal(command.runtime.model, "gpt-5.5");
  assert.equal(command.runtime.reasoningEffort, "xhigh");
});

test("interactive Codex sessions drop models not advertised by the desktop app-server", async () => {
  store.resetStoreForTest();

  const agentRuntime = {
    model: "gpt-5.4",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    allowedPermissionModes: ["strict", "approve", "full"],
    supportedModels: [{ id: "gpt-5.4", displayName: "GPT-5.4", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }]
  };
  const agent = {
    id: "supported-model-list-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: agentRuntime
  };
  queue.updateCodexAgent(agent);

  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "请求不存在的模型",
    runtime: { model: "gpt-5.5", sandbox: "workspace-write", approvalPolicy: "on-request", reasoningEffort: "xhigh", profile: "approve" }
  });
  assert.equal(created.runtime.model, "");
  assert.equal(created.runtime.reasoningEffort, "");
  assert.equal(created.runtime.profile, "approve");

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.runtime.model, "");
  assert.equal(command.runtime.reasoningEffort, "");
  assert.equal(command.runtime.sandbox, "workspace-write");
});

test("interactive Codex sessions recover expired running leases instead of looking stuck forever", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "expired-session-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "看一下这个处理中会话" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [{ type: "thread.started", text: "started", appThreadId: "thr_expired", sessionStatus: "active" }],
    { agentId: agent.id }
  );
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_expired", activeTurnId: "turn_expired", sessionStatus: "running" },
    { agentId: agent.id }
  );

  db.prepare("UPDATE codex_sessions SET lease_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", session.id);

  const recovered = queue.getCodexSession(session.id);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.activeTurnId, null);
  assert.equal(recovered.leasedBy, null);
  assert.match(recovered.lastError, /stopped renewing this session/i);
  assert.equal(recovered.events.some((event) => event.type === "session.lease.expired"), true);
});

test("desktop agent restart recovery keeps a notice until the user continues", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "restart-notice-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "部署 Echo 并重启 agent" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "turn.started",
        text: "turn started",
        appThreadId: "thr_restart_notice",
        activeTurnId: "turn_restart_notice",
        sessionStatus: "running",
        raw: {
          method: "turn/started",
          params: { threadId: "thr_restart_notice", turn: { id: "turn_restart_notice" } }
        }
      }
    ],
    { agentId: agent.id }
  );
  db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60000).toISOString(),
    session.id
  );

  const recoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    busySessionIds: [],
    runningSessionIds: []
  });
  assert.deepEqual(recoveredIds, [session.id]);

  const interrupted = db.prepare("SELECT status, error FROM codex_session_commands WHERE id = ?").get(startCommand.id);
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /Desktop agent restarted/i);

  const recovered = queue.getCodexSession(session.id);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.activeTurnId, null);
  assert.match(recovered.lastError, /Desktop agent restarted/i);
  assert.equal(recovered.events.some((event) => event.type === "session.agent.recovered"), true);

  const continued = queue.enqueueCodexSessionMessage(session.id, { text: "重启后继续同一个会话" });
  assert.equal(continued.status, "active");
  assert.equal(continued.lastError, "");
  assert.equal(continued.pendingCommandCount, 1);
});

test("desktop agent restart recovery ignores stale activity snapshots", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "stale-restart-snapshot-agent",
    agentInstanceId: "stale-restart-instance-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "start while another worker is polling" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_stale_snapshot", activeTurnId: "turn_stale_snapshot", sessionStatus: "running" },
    { agentId: agent.id }
  );

  db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run("2026-01-01T00:00:01.000Z", session.id);

  const staleRecoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(staleRecoveredIds, []);

  const stillRunning = queue.getCodexSession(session.id);
  assert.equal(stillRunning.status, "running");
  assert.equal(stillRunning.activeTurnId, "turn_stale_snapshot");
  assert.equal(stillRunning.lastError, "");

  const freshRecoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    agentInstanceId: "stale-restart-instance-b",
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: "2026-01-01T00:00:02.000Z"
  });
  assert.deepEqual(freshRecoveredIds, [session.id]);

  const recovered = queue.getCodexSession(session.id);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.activeTurnId, null);
  assert.match(recovered.lastError, /Desktop agent restarted/i);
});

test("graceful desktop restart completes without manufacturing a continuation message", async () => {
  store.resetStoreForTest();
  const oldAgent = {
    id: "graceful-restart-agent",
    agentInstanceId: "graceful-restart-old",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { sourceRevision: "a".repeat(40) }
  };
  queue.updateCodexAgent(oldAgent);
  const session = queue.createCodexSession({
    projectId: "demo",
    targetAgentId: oldAgent.id,
    prompt: "deploy Echo and restart safely"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent: oldAgent });

  const requested = queue.requestCodexAgentRestart({
    sessionId: session.id,
    agentId: oldAgent.id,
    agentInstanceId: oldAgent.agentInstanceId,
    expectedRevision: "b".repeat(40),
    resumeSummary: "Deployment passed; report restart and continue."
  });
  assert.equal(requested.status, "requested");
  assert.equal(queue.getCodexSession(session.id).restartOperation.status, "requested");

  assert.equal(queue.completeCodexSessionCommand(
    command.id,
    { ok: true, sessionId: session.id, sessionStatus: "active", finalMessage: "正在安全重启桌面 Agent。" },
    { agentId: oldAgent.id, agentInstanceId: oldAgent.agentInstanceId }
  ), true);
  const armed = queue.armCodexAgentRestart({
    sessionId: session.id,
    agentId: oldAgent.id,
    agentInstanceId: oldAgent.agentInstanceId
  });
  assert.equal(armed.status, "restarting");

  const newAgent = {
    ...oldAgent,
    agentInstanceId: "graceful-restart-new",
    runtime: { sourceRevision: "b".repeat(40) }
  };
  queue.updateCodexAgent(newAgent);
  const reconciled = queue.reconcileCodexAgentRestarts(newAgent);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].status, "completed");
  assert.equal(queue.reconcileCodexAgentRestarts(newAgent).length, 0);

  const resumedSession = queue.getCodexSession(session.id);
  assert.equal(resumedSession.restartOperation.status, "completed");
  assert.equal(resumedSession.pendingCommandCount, 0);
  assert.equal(resumedSession.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(resumedSession.lastError, "");
});

test("graceful desktop restart rejects a new instance running the wrong revision", async () => {
  store.resetStoreForTest();
  const oldAgent = {
    id: "restart-wrong-revision-agent",
    agentInstanceId: "restart-wrong-old",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { sourceRevision: "a".repeat(40) }
  };
  queue.updateCodexAgent(oldAgent);
  const session = queue.createCodexSession({ projectId: "demo", targetAgentId: oldAgent.id, prompt: "restart after update" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent: oldAgent });
  assert.equal(queue.completeCodexSessionCommand(
    command.id,
    { ok: true, sessionId: session.id, sessionStatus: "active" },
    { agentId: oldAgent.id, agentInstanceId: oldAgent.agentInstanceId }
  ), true);
  queue.requestCodexAgentRestart({
    sessionId: session.id,
    agentId: oldAgent.id,
    agentInstanceId: oldAgent.agentInstanceId,
    expectedRevision: "b".repeat(40)
  });
  queue.armCodexAgentRestart({ sessionId: session.id, agentId: oldAgent.id, agentInstanceId: oldAgent.agentInstanceId });

  const outcomes = queue.reconcileCodexAgentRestarts({
    ...oldAgent,
    agentInstanceId: "restart-wrong-new",
    runtime: { sourceRevision: "c".repeat(40) }
  });
  assert.equal(outcomes[0].status, "failed");
  assert.match(outcomes[0].error, /revision/i);
  assert.equal(queue.getCodexSession(session.id).pendingCommandCount, 0);
  assert.equal(queue.getCodexSession(session.id).lastError, "");
});

test("restart drain does not consume the reconnect timeout", () => {
  store.resetStoreForTest();
  const agent = {
    id: "restart-drain-agent",
    agentInstanceId: "restart-drain-old",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { sourceRevision: "a".repeat(40) }
  };
  queue.updateCodexAgent(agent);
  const session = queue.createCodexSession({ projectId: "demo", targetAgentId: agent.id, prompt: "drain before restart" });
  const requested = queue.requestCodexAgentRestart({
    sessionId: session.id,
    agentId: agent.id,
    agentInstanceId: agent.agentInstanceId,
    expectedRevision: "b".repeat(40)
  });
  db.prepare("UPDATE codex_agent_restart_operations SET updated_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 5 * 60 * 1000).toISOString(), requested.id);

  assert.deepEqual(queue.expireCodexAgentRestarts(), []);
  assert.equal(queue.getCodexSession(session.id).restartOperation.status, "requested");
});

test("arming a drained restart is idempotent for a lost HTTP response", () => {
  store.resetStoreForTest();
  const agent = {
    id: "restart-arm-agent",
    agentInstanceId: "restart-arm-old",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { sourceRevision: "a".repeat(40) }
  };
  queue.updateCodexAgent(agent);
  const session = queue.createCodexSession({ projectId: "demo", targetAgentId: agent.id, prompt: "arm once" });
  const requested = queue.requestCodexAgentRestart({
    sessionId: session.id,
    agentId: agent.id,
    agentInstanceId: agent.agentInstanceId,
    expectedRevision: "b".repeat(40)
  });

  const first = queue.armCodexAgentRestart({
    operationId: requested.id,
    sessionId: session.id,
    agentId: agent.id,
    agentInstanceId: agent.agentInstanceId
  });
  const repeated = queue.armCodexAgentRestart({
    operationId: requested.id,
    sessionId: session.id,
    agentId: agent.id,
    agentInstanceId: agent.agentInstanceId
  });

  assert.equal(first.status, "restarting");
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.status, "restarting");
});

test("restart reconnect timeout stays diagnostic and a late instance corrects it", async () => {
  store.resetStoreForTest();
  const oldAgent = {
    id: "restart-timeout-agent",
    agentInstanceId: "restart-timeout-old",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { sourceRevision: "a".repeat(40) }
  };
  queue.updateCodexAgent(oldAgent);
  const session = queue.createCodexSession({
    projectId: "demo",
    targetAgentId: oldAgent.id,
    prompt: "restart and resume"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent: oldAgent });
  assert.equal(queue.completeCodexSessionCommand(
    command.id,
    { ok: true, sessionId: session.id, sessionStatus: "active" },
    { agentId: oldAgent.id, agentInstanceId: oldAgent.agentInstanceId }
  ), true);
  const requested = queue.requestCodexAgentRestart({
    sessionId: session.id,
    agentId: oldAgent.id,
    agentInstanceId: oldAgent.agentInstanceId,
    expectedRevision: "b".repeat(40)
  });
  queue.armCodexAgentRestart({
    sessionId: session.id,
    agentId: oldAgent.id,
    agentInstanceId: oldAgent.agentInstanceId
  });
  db.prepare("UPDATE codex_agent_restart_operations SET updated_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", requested.id);

  let notificationCount = 0;
  const unsubscribe = queue.subscribeCodexSession(session.id, () => {
    notificationCount += 1;
  });
  assert.deepEqual(queue.expireCodexAgentRestarts(), [session.id]);
  unsubscribe();

  assert.equal(notificationCount, 1);
  const failed = queue.getCodexSession(session.id);
  assert.equal(failed.restartOperation.status, "failed");
  assert.match(failed.restartOperation.error, /did not reconnect/i);
  assert.equal(failed.lastError, "");

  const lateAgent = {
    ...oldAgent,
    agentInstanceId: "restart-timeout-late",
    runtime: { sourceRevision: "b".repeat(40) }
  };
  queue.updateCodexAgent(lateAgent);
  const corrected = queue.reconcileCodexAgentRestarts(lateAgent);
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].status, "completed");
  assert.equal(corrected[0].error, "");
  assert.equal(queue.getCodexSession(session.id).pendingCommandCount, 0);
});

test("desktop agent restart recovery ignores missing activity from the same agent instance", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "same-instance-agent",
    agentInstanceId: "same-instance-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "long turn still posting completion" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_same_instance", activeTurnId: "turn_same_instance", sessionStatus: "running" },
    { agentId: agent.id }
  );

  db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60000).toISOString(),
    session.id
  );

  const recoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    agentInstanceId: "same-instance-a",
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: new Date().toISOString()
  });
  assert.deepEqual(recoveredIds, []);

  const stillRunning = queue.getCodexSession(session.id);
  assert.equal(stillRunning.status, "running");
  assert.equal(stillRunning.activeTurnId, "turn_same_instance");
  assert.equal(stillRunning.leasedBy, agent.id);
  assert.equal(stillRunning.lastError, "");
});

test("desktop agent restart recovery is scoped to one desktop environment", async () => {
  store.resetStoreForTest();

  const agentA = {
    id: "restart-scope-agent-a",
    agentInstanceId: "restart-scope-instance-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const agentB = {
    id: "restart-scope-agent-b",
    agentInstanceId: "restart-scope-instance-b",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const user = { username: "alice", role: "user" };
  queue.updateCodexAgent({ ...agentA, ownerUser: "alice" });
  queue.updateCodexAgent({ ...agentB, ownerUser: "alice" });

  const sessionA = queue.createCodexSession({
    projectId: "demo",
    targetAgentId: agentA.id,
    ownerUser: "alice",
    user,
    prompt: "run on desktop A"
  });
  const sessionB = queue.createCodexSession({
    projectId: "demo",
    targetAgentId: agentB.id,
    ownerUser: "alice",
    user,
    prompt: "run on desktop B"
  });
  const commandA = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent: agentA });
  const commandB = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent: agentB });
  queue.completeCodexSessionCommand(
    commandA.id,
    { ok: true, appThreadId: "thr_restart_scope_a", activeTurnId: "turn_restart_scope_a", sessionStatus: "running" },
    { agentId: agentA.id, agentInstanceId: agentA.agentInstanceId }
  );
  queue.completeCodexSessionCommand(
    commandB.id,
    { ok: true, appThreadId: "thr_restart_scope_b", activeTurnId: "turn_restart_scope_b", sessionStatus: "running" },
    { agentId: agentB.id, agentInstanceId: agentB.agentInstanceId }
  );

  db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id IN (?, ?)").run(
    new Date(Date.now() - 60000).toISOString(),
    sessionA.id,
    sessionB.id
  );

  const recoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agentB.id,
    agentInstanceId: "restart-scope-instance-b-restarted",
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: new Date().toISOString()
  });
  assert.deepEqual(recoveredIds, [sessionB.id]);

  const stillRunningA = queue.getCodexSession(sessionA.id, { user });
  const recoveredB = queue.getCodexSession(sessionB.id, { user });
  assert.equal(stillRunningA.status, "running");
  assert.equal(stillRunningA.activeTurnId, "turn_restart_scope_a");
  assert.equal(stillRunningA.leasedBy, agentA.id);
  assert.equal(stillRunningA.lastError, "");
  assert.equal(recoveredB.status, "active");
  assert.match(recoveredB.lastError, /Desktop agent restarted/i);
});

test("desktop agent restart recovery ignores running sessions without an active turn", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "no-active-turn-agent",
    agentInstanceId: "no-active-turn-instance-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "等待后台状态同步" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_no_active_turn", sessionStatus: "running" },
    { agentId: agent.id, agentInstanceId: agent.agentInstanceId }
  );

  db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60000).toISOString(),
    session.id
  );

  const recoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    agentInstanceId: "no-active-turn-instance-b",
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: new Date().toISOString()
  });
  assert.deepEqual(recoveredIds, []);

  const detail = queue.getCodexSession(session.id);
  assert.equal(detail.status, "running");
  assert.equal(detail.activeTurnId, null);
  assert.equal(detail.leasedBy, agent.id);
  assert.equal(detail.lastError, "");
  assert.equal(detail.events.some((event) => event.type === "session.agent.recovered"), false);
});

test("desktop agent restart recovery clears orphaned mobile waits", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "approval-recovery-agent",
    agentInstanceId: "approval-recovery-instance-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", ownerUser: "alice", prompt: "需要审批后继续" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    command.id,
    { ok: true, appThreadId: "thr_approval_recovery", sessionStatus: "running" },
    { agentId: agent.id, agentInstanceId: agent.agentInstanceId }
  );

  const approval = queue.createCodexSessionApproval(
    {
      sessionId: session.id,
      appRequestId: "approval-recovery-request",
      method: "item/commandExecution/requestApproval",
      prompt: "Approve a command?",
      payload: { command: "pnpm test", cwd: process.cwd() }
    },
    { agentId: agent.id, agentInstanceId: agent.agentInstanceId }
  );
  assert.equal(approval.status, "pending");

  db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60000).toISOString(),
    session.id
  );

  const recoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    agentInstanceId: "approval-recovery-instance-b",
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: new Date().toISOString()
  });
  assert.deepEqual(recoveredIds, [session.id]);

  const detail = queue.getCodexSession(session.id, { user: { username: "alice", role: "user" } });
  assert.equal(detail.status, "active");
  assert.equal(detail.pendingApprovalCount, 0);
  assert.equal(detail.approvals.length, 0);
  assert.match(detail.lastError, /Desktop agent restarted/i);
  assert.equal(detail.events.some((event) => event.type === "approval.denied"), true);
  assert.equal(detail.events.some((event) => event.type === "session.agent.recovered"), true);
});

test("desktop agent restart recovery clears orphaned mobile input waits", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "interaction-recovery-agent",
    agentInstanceId: "interaction-recovery-instance-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", ownerUser: "alice", prompt: "需要用户输入后继续" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    command.id,
    { ok: true, appThreadId: "thr_interaction_recovery", sessionStatus: "running" },
    { agentId: agent.id, agentInstanceId: agent.agentInstanceId }
  );

  const interaction = queue.createCodexSessionInteraction(
    {
      sessionId: session.id,
      appRequestId: "interaction-recovery-request",
      method: "item/tool/requestUserInput",
      kind: "user_input",
      prompt: "Choose the next model",
      payload: {
        threadId: "thr_interaction_recovery",
        questions: [{ id: "model_choice", question: "Choose", options: [{ label: "A" }, { label: "B" }] }]
      }
    },
    { agentId: agent.id, agentInstanceId: agent.agentInstanceId }
  );
  assert.equal(interaction.status, "pending");

  db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60000).toISOString(),
    session.id
  );

  const recoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    agentInstanceId: "interaction-recovery-instance-b",
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: new Date().toISOString()
  });
  assert.deepEqual(recoveredIds, [session.id]);

  const detail = queue.getCodexSession(session.id, { user: { username: "alice", role: "user" } });
  assert.equal(detail.status, "active");
  assert.equal(detail.pendingInteractionCount, 0);
  assert.equal(detail.pendingUserInputCount, 0);
  assert.equal(detail.interactions.length, 0);
  assert.match(detail.lastError, /Desktop agent restarted/i);
  assert.equal(detail.events.some((event) => event.type === "interaction.cancelled"), true);
  assert.equal(detail.events.some((event) => event.type === "session.agent.recovered"), true);
});

test("desktop agent restart recovery ignores newly leased sessions when clocks are skewed", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "skewed-recovery-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "start while another worker polls" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_skewed", activeTurnId: "turn_skewed", sessionStatus: "running" },
    { agentId: agent.id }
  );

  const recoveredIds = store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  assert.deepEqual(recoveredIds, []);

  const stillRunning = queue.getCodexSession(session.id);
  assert.equal(stillRunning.status, "running");
  assert.equal(stillRunning.activeTurnId, "turn_skewed");
  assert.equal(stillRunning.leasedBy, agent.id);
});

test("desktop agent restart recovery clears stale notices when a follow-up is already queued", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "restart-recovery-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "部署 Echo 并重启 agent" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "turn.started",
        text: "turn started",
        appThreadId: "thr_restart",
        activeTurnId: "turn_restart",
        sessionStatus: "running",
        raw: {
          method: "turn/started",
          params: { threadId: "thr_restart", turn: { id: "turn_restart" } }
        }
      }
    ],
    { agentId: agent.id }
  );

  queue.enqueueCodexSessionMessage(session.id, { text: "重启后继续同一个会话" });
  db.prepare("UPDATE codex_sessions SET updated_at = ? WHERE id = ?").run(
    new Date(Date.now() - 60000).toISOString(),
    session.id
  );
  store.recoverLostRunningSessionsForAgent({
    agentId: agent.id,
    busySessionIds: [],
    runningSessionIds: [],
    sessionActivitySnapshotAt: new Date().toISOString()
  });
  const messageCommand = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent,
    busySessionIds: [],
    runningSessionIds: []
  });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.sessionId, session.id);
  assert.equal(messageCommand.appThreadId, "thr_restart");
  assert.equal(messageCommand.activeTurnId, "");
  assert.equal(messageCommand.payload.history.some((message) => message.text === "部署 Echo 并重启 agent"), true);

  const interrupted = db.prepare("SELECT status, error FROM codex_session_commands WHERE id = ?").get(startCommand.id);
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /Desktop agent restarted/i);

  const recovered = queue.getCodexSession(session.id);
  assert.equal(recovered.activeTurnId, null);
  assert.equal(recovered.lastError, "");
  assert.equal(recovered.events.some((event) => event.type === "session.agent.recovered"), true);
});

test("expired command leases reconcile before they can be leased again", async () => {
  store.resetStoreForTest();
  const agent = {
    id: "protocol-reconcile-agent",
    agentInstanceId: "protocol-instance-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "run once" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.attempt, 1);

  db.prepare("UPDATE codex_session_commands SET lease_expires_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", command.id);
  const reconciliation = store.listSessionCommandReconciliations({ agentId: agent.id });
  assert.deepEqual(reconciliation.map((item) => item.commandId), [command.id]);
  assert.equal(db.prepare("SELECT status FROM codex_session_commands WHERE id = ?").get(command.id).status, "reconciling");

  const duplicate = await queue.waitForCodexSessionCommand({
    waitMs: 10,
    agent: { ...agent, agentInstanceId: "protocol-instance-b" }
  });
  assert.equal(duplicate, null);

  const outcomes = store.reconcileSessionCommands({
    agentId: agent.id,
    agentInstanceId: "protocol-instance-a",
    states: [{ commandId: command.id, attempt: command.attempt, state: "running" }]
  });
  assert.deepEqual(outcomes, [{ commandId: command.id, attempt: 1, outcome: "running" }]);
  const renewed = db.prepare("SELECT status, attempt FROM codex_session_commands WHERE id = ?").get(command.id);
  assert.deepEqual(renewed, { status: "leased", attempt: 1 });
});

test("reconciliation only requeues work explicitly confirmed not started", async () => {
  store.resetStoreForTest();
  const agent = {
    id: "protocol-not-started-agent",
    agentInstanceId: "protocol-not-started-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "safe retry" });
  const first = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  db.prepare("UPDATE codex_session_commands SET lease_expires_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", first.id);
  store.listSessionCommandReconciliations({ agentId: agent.id });

  const outcomes = store.reconcileSessionCommands({
    agentId: agent.id,
    agentInstanceId: "protocol-not-started-b",
    states: [{ commandId: first.id, attempt: 1, state: "not_started" }]
  });
  assert.equal(outcomes[0].outcome, "requeued");
  assert.equal(outcomes[0].nextAttempt, 2);

  const second = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: { ...agent, agentInstanceId: "protocol-not-started-b" }
  });
  assert.equal(second.id, first.id);
  assert.equal(second.attempt, 2);
});

test("command completion and protocol session events are idempotent by attempt", async () => {
  store.resetStoreForTest();
  const agent = {
    id: "protocol-idempotency-agent",
    agentInstanceId: "protocol-idempotency-instance",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "report once" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  const event = {
    eventId: "stable-terminal-event",
    commandId: command.id,
    attempt: command.attempt,
    type: "turn.completed",
    text: "done",
    sessionStatus: "active",
    raw: { method: "turn/completed", params: { turn: { id: "turn-protocol" } } }
  };
  assert.equal(queue.appendCodexSessionEvents(session.id, [event], { agent }), true);
  assert.equal(queue.appendCodexSessionEvents(session.id, [event], { agent }), true);

  const result = { ok: true, sessionId: session.id, sessionStatus: "active", finalMessage: "done" };
  assert.equal(queue.completeCodexSessionCommand(command.id, result, { agent, attempt: 1 }), true);
  assert.equal(queue.completeCodexSessionCommand(command.id, result, { agent, attempt: 1 }), true);
  assert.equal(queue.completeCodexSessionCommand(command.id, { ...result, finalMessage: "different" }, { agent, attempt: 1 }), false);
  assert.equal(queue.completeCodexSessionCommand(command.id, result, { agent, attempt: 2 }), false);

  const detail = queue.getCodexSession(session.id);
  assert.equal(detail.events.filter((item) => item.text === "done").length, 1);
  assert.equal(detail.events.filter((item) => item.type === "command.completed").length, 1);
});

test("unknown reconciliation state fails the command and session explicitly", async () => {
  store.resetStoreForTest();
  const agent = {
    id: "protocol-unknown-agent",
    agentInstanceId: "protocol-unknown-a",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "restart midway" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  db.prepare("UPDATE codex_session_commands SET lease_expires_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", command.id);
  store.listSessionCommandReconciliations({ agentId: agent.id });

  const outcomes = store.reconcileSessionCommands({
    agentId: agent.id,
    agentInstanceId: "protocol-unknown-b",
    states: [{ commandId: command.id, attempt: 1, state: "unknown" }]
  });
  assert.equal(outcomes[0].outcome, "failed");
  assert.equal(db.prepare("SELECT status FROM codex_session_commands WHERE id = ?").get(command.id).status, "failed");
  assert.equal(queue.getCodexSession(session.id).status, "failed");
});

test("unanswered reconciliation expires into a terminal failure", async () => {
  store.resetStoreForTest();
  const agent = {
    id: "protocol-timeout-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "disconnect forever" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  db.prepare("UPDATE codex_session_commands SET lease_expires_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", command.id);
  store.listSessionCommandReconciliations({ agentId: agent.id });
  db.prepare("UPDATE codex_session_commands SET lease_expires_at = ? WHERE id = ?")
    .run("2020-01-01T00:00:00.000Z", command.id);

  assert.deepEqual(store.listSessionCommandReconciliations({ agentId: agent.id }), []);
  assert.equal(db.prepare("SELECT status FROM codex_session_commands WHERE id = ?").get(command.id).status, "failed");
  const detail = queue.getCodexSession(session.id);
  assert.equal(detail.status, "failed");
  assert.equal(detail.events.some((event) => event.type === "command.reconciliation.failed"), true);
});

test("interactive Codex running command completion refreshes the session lease", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "complete-renew-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "启动一个长 turn" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  db.prepare("UPDATE codex_sessions SET lease_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", session.id);

  queue.completeCodexSessionCommand(
    command.id,
    { ok: true, appThreadId: "thr_complete_renew", activeTurnId: "turn_complete_renew", sessionStatus: "running" },
    { agentId: agent.id }
  );

  const detail = queue.getCodexSession(session.id);
  assert.equal(detail.status, "running");
  assert.equal(detail.leasedBy, agent.id);
  assert.equal(detail.activeTurnId, "turn_complete_renew");
  assert.ok(Date.parse(detail.leaseExpiresAt) > Date.now());
  assert.equal(detail.events.some((event) => event.type === "session.lease.expired"), false);
});

test("interactive Codex sessions can continue after recoverable app-server failures", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "recoverable-failure-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "第一条消息" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_lost" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(startCommand.id, { ok: false, error: "thread not found: thr_lost" }, { agentId: agent.id });

  const failed = queue.getCodexSession(session.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.lastError, /thread not found/);

  const continued = queue.enqueueCodexSessionMessage(session.id, { text: "继续这条会话" });
  assert.equal(continued.status, "active");
  assert.equal(continued.lastError, "");
  assert.equal(continued.pendingCommandCount, 1);

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_lost");
  assert.equal(messageCommand.payload.text, "继续这条会话");
  assert.equal(messageCommand.payload.history.some((message) => message.text === "第一条消息"), true);
});

test("interactive Codex sessions can continue after model rate limit failures", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "rate-limit-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({ projectId: "demo", prompt: "先检查这个问题" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [
      { type: "thread.started", text: "started", appThreadId: "thr_rate", sessionStatus: "active" },
      {
        type: "turn/started",
        text: "Turn started.",
        raw: { method: "turn/started", params: { threadId: "thr_rate", turn: { id: "turn_rate" } } }
      },
      {
        type: "turn/completed",
        text: "Turn failed: 429 Too Many Requests",
        raw: {
          method: "turn/completed",
          params: {
            threadId: "thr_rate",
            turn: {
              id: "turn_rate",
              status: "failed",
              error: { message: "429 Too Many Requests: rate limit reached for model gpt-5.5" }
            }
          }
        }
      }
    ],
    { agentId: agent.id }
  );
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_rate", activeTurnId: "turn_rate", sessionStatus: "running" },
    { agentId: agent.id }
  );

  const retrying = queue.getCodexSession(session.id);
  assert.equal(retrying.status, "queued");
  assert.match(retrying.lastError, /retrying/i);

  makeSessionCommandAvailable(startCommand.id);
  const firstRetry = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(firstRetry.id, startCommand.id);
  queue.completeCodexSessionCommand(firstRetry.id, { ok: false, error: "HTTP 503 Service Unavailable" }, { agentId: agent.id });

  makeSessionCommandAvailable(startCommand.id);
  const secondRetry = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(secondRetry.id, startCommand.id);
  queue.completeCodexSessionCommand(secondRetry.id, { ok: false, error: "HTTP 502 Bad Gateway" }, { agentId: agent.id });

  const failed = queue.getCodexSession(session.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.lastError, /502|rate limit/i);

  const continued = queue.enqueueCodexSessionMessage(session.id, { text: "等限流恢复后继续" });
  assert.equal(continued.status, "active");
  assert.equal(continued.lastError, "");
  assert.equal(continued.pendingCommandCount, 1);

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
  assert.equal(messageCommand.appThreadId, "thr_rate");
  assert.equal(messageCommand.payload.text, "等限流恢复后继续");
  assert.equal(messageCommand.payload.history.some((message) => message.text === "先检查这个问题"), true);
});

test("interactive Codex approvals wait for mobile decisions", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "approval-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", ownerUser: "alice", prompt: "需要跑测试" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_a" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_a", sessionStatus: "running" }, { agentId: agent.id });

  const approval = queue.createCodexSessionApproval(
    {
      sessionId: session.id,
      appRequestId: "request-1",
      method: "item/commandExecution/requestApproval",
      prompt: "Codex requested command approval: pnpm test",
      payload: { command: "pnpm test", cwd: process.cwd() }
    },
    { agentId: agent.id }
  );
  assert.equal(approval.status, "pending");

  const waitPromise = queue.waitForCodexSessionApproval(approval.id, { waitMs: 1000, agentId: agent.id });
  const decided = queue.decideCodexSessionApproval(approval.id, { decision: "approved" }, { user: { username: "alice" } });
  assert.equal(decided.status, "approved");
  assert.deepEqual(decided.response, { decision: "accept" });

  const waited = await waitPromise;
  assert.equal(waited.id, approval.id);
  assert.equal(waited.status, "approved");
  assert.deepEqual(waited.response, { decision: "accept" });

  const detail = queue.getCodexSession(session.id);
  assert.equal(detail.pendingApprovalCount, 0);
  assert.equal(detail.approvals.length, 0);
  assert.equal(detail.events.some((event) => event.type === "approval.approved"), true);
});

test("mobile cancellation wakes pending Codex approval waits", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "approval-cancel-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "需要审批后继续" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [{ type: "turn/started", text: "started", appThreadId: "thr_cancel_approval", activeTurnId: "turn_cancel_approval" }],
    { agentId: agent.id }
  );
  queue.completeCodexSessionCommand(
    command.id,
    { ok: true, appThreadId: "thr_cancel_approval", activeTurnId: "turn_cancel_approval", sessionStatus: "running" },
    { agentId: agent.id }
  );

  const approval = queue.createCodexSessionApproval(
    {
      sessionId: session.id,
      appRequestId: "request-cancel-approval",
      method: "item/commandExecution/requestApproval",
      prompt: "Approve a long running command?",
      payload: { command: "pnpm test", cwd: process.cwd() }
    },
    { agentId: agent.id }
  );

  const waitPromise = queue.waitForCodexSessionApproval(approval.id, {
    waitMs: 1000,
    agentId: agent.id,
    sessionId: session.id
  });
  queue.cancelCodexSession(session.id, { reason: "cancel while waiting for approval" });

  const waited = await waitPromise;
  assert.equal(waited.id, approval.id);
  assert.equal(waited.status, "denied");
  assert.deepEqual(waited.response, { decision: "decline" });
});

test("interactive Codex user input waits for mobile answers", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "interaction-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", ownerUser: "alice", prompt: "需要选择模型" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_i" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_i", sessionStatus: "running" }, { agentId: agent.id });

  const interaction = queue.createCodexSessionInteraction(
    {
      sessionId: session.id,
      appRequestId: "request-input-1",
      method: "item/tool/requestUserInput",
      kind: "user_input",
      prompt: "选择接下来使用的模型",
      payload: {
        threadId: "thr_i",
        turnId: "turn_i",
        itemId: "call_i",
        questions: [
          {
            id: "model_choice",
            header: "模型",
            question: "选择接下来使用的模型",
            options: [
              { label: "A", description: "保持当前模型" },
              { label: "B", description: "切换到更强模型" }
            ]
          }
        ]
      }
    },
    { agentId: agent.id }
  );
  assert.equal(interaction.status, "pending");

  let detail = queue.getCodexSession(session.id);
  assert.equal(detail.pendingInteractionCount, 1);
  assert.equal(detail.pendingUserInputCount, 1);
  assert.equal(detail.interactions.length, 1);
  assert.equal(detail.events.some((event) => event.type === "interaction.requested"), true);

  const waitPromise = queue.waitForCodexSessionInteraction(interaction.id, { waitMs: 1000, agentId: agent.id });
  const answered = queue.decideCodexSessionInteraction(
    interaction.id,
    { answers: { model_choice: { answers: ["B"] } } },
    { user: { username: "alice" } }
  );
  assert.equal(answered.status, "answered");
  assert.deepEqual(answered.response, { answers: { model_choice: { answers: ["B"] } } });

  const waited = await waitPromise;
  assert.equal(waited.id, interaction.id);
  assert.equal(waited.status, "answered");
  assert.deepEqual(waited.response, { answers: { model_choice: { answers: ["B"] } } });

  detail = queue.getCodexSession(session.id);
  assert.equal(detail.pendingInteractionCount, 0);
  assert.equal(detail.interactions.length, 0);
  assert.equal(detail.events.some((event) => event.type === "interaction.answered"), true);
});

test("interactive Codex user input requests and waits renew running session leases", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "interaction-renew-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "计划模式需要选择" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.completeCodexSessionCommand(
    command.id,
    { ok: true, appThreadId: "thr_interaction_renew", activeTurnId: "turn_interaction_renew", sessionStatus: "running" },
    { agentId: agent.id }
  );

  db.prepare("UPDATE codex_sessions SET lease_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", session.id);
  const interaction = queue.createCodexSessionInteraction(
    {
      sessionId: session.id,
      appRequestId: "request-input-renew",
      method: "item/tool/requestUserInput",
      kind: "user_input",
      prompt: "选择下一步方案",
      payload: {
        threadId: "thr_interaction_renew",
        turnId: "turn_interaction_renew",
        questions: [{ id: "plan_choice", question: "选择下一步方案", options: [{ label: "A" }, { label: "B" }] }]
      }
    },
    { agentId: agent.id }
  );
  assert.equal(interaction.status, "pending");

  let detail = queue.getCodexSession(session.id);
  assert.equal(detail.status, "running");
  assert.equal(detail.leasedBy, agent.id);
  assert.equal(detail.pendingInteractionCount, 1);
  assert.equal(detail.events.some((event) => event.type === "session.lease.expired"), false);

  db.prepare("UPDATE codex_sessions SET lease_expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", session.id);
  const waited = await queue.waitForCodexSessionInteraction(interaction.id, {
    waitMs: 1000,
    agentId: agent.id,
    sessionId: session.id
  });
  assert.equal(waited, null);

  detail = queue.getCodexSession(session.id);
  assert.equal(detail.status, "running");
  assert.equal(detail.leasedBy, agent.id);
  assert.equal(detail.pendingInteractionCount, 1);
  assert.ok(Date.parse(detail.leaseExpiresAt) > Date.now());
  assert.equal(detail.events.some((event) => event.type === "session.lease.expired"), false);
});

test("interactive Codex user input clears when app-server resolves the request", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "interaction-resolve-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "需要选择方案" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_resolved" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_resolved", sessionStatus: "running" }, {
    agentId: agent.id
  });

  const interaction = queue.createCodexSessionInteraction(
    {
      sessionId: session.id,
      appRequestId: "request-input-resolved",
      method: "item/tool/requestUserInput",
      kind: "user_input",
      prompt: "选择下一步方案",
      payload: {
        threadId: "thr_resolved",
        turnId: "turn_resolved",
        itemId: "call_resolved",
        questions: [
          {
            id: "plan_choice",
            header: "方案",
            question: "选择下一步方案",
            options: [
              { label: "A", description: "只整理计划" },
              { label: "B", description: "继续实现" }
            ]
          }
        ]
      }
    },
    { agentId: agent.id }
  );
  assert.equal(interaction.status, "pending");

  const waitPromise = queue.waitForCodexSessionInteraction(interaction.id, {
    waitMs: 1000,
    agentId: agent.id,
    sessionId: session.id
  });
  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "serverRequest/resolved",
        text: "Request resolved.",
        appThreadId: "thr_resolved",
        raw: {
          method: "serverRequest/resolved",
          params: { threadId: "thr_resolved", requestId: "request-input-resolved" }
        }
      }
    ],
    { agentId: agent.id }
  );

  const waited = await waitPromise;
  assert.equal(waited.id, interaction.id);
  assert.equal(waited.status, "cancelled");
  assert.deepEqual(waited.response, { answers: {} });

  const detail = queue.getCodexSession(session.id);
  assert.equal(detail.pendingInteractionCount, 0);
  assert.equal(detail.interactions.length, 0);
});

function appendTestContextUsage(sessionId, agentId, { threadId, turnId, totalTokens, modelContextWindow = 100000 }) {
  assert.equal(
    queue.appendCodexSessionEvents(
      sessionId,
      [
        {
          type: "thread/tokenUsage/updated",
          text: "Context usage updated.",
          raw: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId,
              turnId,
              tokenUsage: {
                total: { totalTokens },
                last: { totalTokens },
                modelContextWindow
              }
            }
          }
        }
      ],
      { agentId }
    ),
    true
  );
}

function compactCommandCount(sessionId) {
  return db.prepare("SELECT COUNT(*) AS count FROM codex_session_commands WHERE session_id = ? AND type = 'compact'").get(sessionId).count;
}

function sessionCommandRow(commandId) {
  const row = db.prepare(`
    SELECT status, available_at AS availableAt, payload_json AS payloadJson
    FROM codex_session_commands
    WHERE id = ?
  `).get(commandId);
  return row ? { ...row, payload: JSON.parse(row.payloadJson || "{}") } : null;
}

function makeSessionCommandAvailable(commandId) {
  db.prepare("UPDATE codex_session_commands SET available_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), commandId);
}

function compactionQueuedEventCount(sessionId) {
  return db.prepare("SELECT COUNT(*) AS count FROM codex_session_events WHERE session_id = ? AND type = 'context.compaction.queued'").get(sessionId).count;
}

async function createActiveSessionForCompaction({ agentId, threadId, prompt = "long context", contextUsageTotalTokens = null }) {
  const agent = {
    id: agentId,
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: threadId }], {
    agentId: agent.id
  });
  if (contextUsageTotalTokens !== null) {
    appendTestContextUsage(session.id, agent.id, {
      threadId,
      turnId: `${threadId}_usage`,
      totalTokens: contextUsageTotalTokens
    });
  }
  queue.completeCodexSessionCommand(startCommand.id, { ok: true, appThreadId: threadId, sessionStatus: "active" }, { agentId: agent.id });
  return { agent, session };
}

test("interactive Codex sessions can request app-server context compaction", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "长对话先启动" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_compact" }], {
    agentId: agent.id
  });
  appendTestContextUsage(session.id, agent.id, {
    threadId: "thr_compact",
    turnId: "turn_before_compact",
    totalTokens: 90000
  });
  queue.completeCodexSessionCommand(startCommand.id, { ok: true, appThreadId: "thr_compact", sessionStatus: "active" }, { agentId: agent.id });

  const queued = queue.compactCodexSession(session.id, { automatic: true, reason: "test-threshold" });
  assert.equal(queued.pendingCommandCount, 1);
  assert.equal(queued.events.some((event) => event.type === "context.compaction.queued"), true);

  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");
  assert.equal(compactCommand.appThreadId, "thr_compact");
  assert.equal(compactCommand.payload.automatic, true);
  assert.equal(compactCommand.payload.reason, "test-threshold");
  queue.completeCodexSessionCommand(compactCommand.id, { ok: true, appThreadId: "thr_compact", sessionStatus: "running" }, { agentId: agent.id });

  const running = queue.getCodexSession(session.id);
  assert.equal(running.status, "running");
  assert.equal(running.leasedBy, agent.id);

  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "item/completed",
        text: "Context compaction completed.",
        raw: { method: "item/completed", params: { threadId: "thr_compact", item: { type: "contextCompaction", id: "ctx_1" } } }
      },
      {
        type: "turn/completed",
        text: "Turn completed.",
        raw: { method: "turn/completed", params: { threadId: "thr_compact", turn: { status: "completed" } } }
      }
    ],
    { agentId: agent.id }
  );

  const compacted = queue.getCodexSession(session.id);
  assert.equal(compacted.status, "active");
  assert.equal(compacted.leasedBy, null);
  assert.equal(compacted.events.some((event) => event.raw?.params?.item?.type === "contextCompaction"), true);
});

test("automatic context compaction below threshold is a no-op", async () => {
  store.resetStoreForTest();

  const { agent, session } = await createActiveSessionForCompaction({
    agentId: "auto-compact-low-agent",
    threadId: "thr_auto_low",
    prompt: "short context",
    contextUsageTotalTokens: 40000
  });

  const unchanged = queue.compactCodexSession(session.id, { automatic: true, reason: "context-threshold" });
  assert.equal(unchanged.pendingCommandCount, 0);
  assert.equal(compactCommandCount(session.id), 0);
  assert.equal(compactionQueuedEventCount(session.id), 0);
});

test("automatic context compaction queues once per fresh threshold crossing", async () => {
  store.resetStoreForTest();

  const { agent, session } = await createActiveSessionForCompaction({
    agentId: "auto-compact-once-agent",
    threadId: "thr_auto_once",
    prompt: "long context",
    contextUsageTotalTokens: 90000
  });

  const queued = queue.compactCodexSession(session.id, { automatic: true, reason: "context-threshold" });
  assert.equal(queued.pendingCommandCount, 1);
  assert.equal(compactCommandCount(session.id), 1);
  assert.equal(compactionQueuedEventCount(session.id), 1);

  const duplicate = queue.compactCodexSession(session.id, { automatic: true, reason: "context-threshold" });
  assert.equal(duplicate.pendingCommandCount, 1);
  assert.equal(compactCommandCount(session.id), 1);
  assert.equal(compactionQueuedEventCount(session.id), 1);
});

test("context usage events trigger automatic compaction without an open mobile client", async () => {
  store.resetStoreForTest();

  const agent = { id: "background-auto-compact-agent", workspaces: [{ id: "demo", path: process.cwd() }] };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "background compaction" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_background_auto" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(startCommand.id, {
    ok: true,
    appThreadId: "thr_background_auto",
    activeTurnId: "turn_background_auto",
    sessionStatus: "running"
  }, { agentId: agent.id });
  queue.appendCodexSessionEvents(session.id, [
    {
      type: "thread/tokenUsage/updated",
      text: "Context usage updated.",
      raw: {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thr_background_auto",
          turnId: "turn_background_auto",
          tokenUsage: { total: { totalTokens: 90000 }, last: { totalTokens: 90000 }, modelContextWindow: 100000 }
        }
      }
    },
    {
      type: "turn/completed",
      text: "Turn completed.",
      raw: { method: "turn/completed", params: { threadId: "thr_background_auto", turn: { id: "turn_background_auto", status: "completed" } } }
    }
  ], { agentId: agent.id });

  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");
  assert.equal(compactCommand.payload.automatic, true);
  assert.equal(compactCommand.payload.reason, "context-threshold");
  assert.equal(compactionQueuedEventCount(session.id), 1);
});

test("turn completion rechecks high context usage that arrived while the turn was running", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "turn-finished-auto-compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "finish before compacting" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_turn_finished" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(startCommand.id, {
    ok: true,
    appThreadId: "thr_turn_finished",
    activeTurnId: "turn_finished",
    sessionStatus: "running"
  }, { agentId: agent.id });
  appendTestContextUsage(session.id, agent.id, {
    threadId: "thr_turn_finished",
    turnId: "turn_finished",
    totalTokens: 90000
  });
  assert.equal(compactCommandCount(session.id), 0);

  queue.appendCodexSessionEvents(session.id, [{
    type: "turn/completed",
    text: "Turn completed.",
    raw: { method: "turn/completed", params: { threadId: "thr_turn_finished", turn: { id: "turn_finished", status: "completed" } } }
  }], { agentId: agent.id });

  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");
  assert.equal(compactCommand.payload.automatic, true);
  assert.equal(compactCommandCount(session.id), 1);
});

test("failed automatic compaction leaves the conversation available for queued follow-ups", async () => {
  store.resetStoreForTest();

  const { agent, session } = await createActiveSessionForCompaction({
    agentId: "failed-auto-compact-agent",
    threadId: "thr_failed_auto",
    prompt: "keep the conversation recoverable",
    contextUsageTotalTokens: 90000
  });
  queue.compactCodexSession(session.id, { automatic: true, reason: "context-threshold" });
  queue.enqueueCodexSessionMessage(session.id, { text: "continue after failed compaction" });
  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");
  assert.equal(queue.completeCodexSessionCommand(compactCommand.id, {
    ok: false,
    error: "Codex thread can no longer be compacted because the local app-server thread was not found."
  }, { agentId: agent.id }), true);
  assert.equal(queue.getCodexSession(session.id).status, "active");

  const messageCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(messageCommand.type, "message");
});

test("automatic context compaction ignores usage already handled by compaction", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "auto-compact-stale-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "old high context" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_auto_stale" }], {
    agentId: agent.id
  });
  appendTestContextUsage(session.id, agent.id, {
    threadId: "thr_auto_stale",
    turnId: "turn_auto_stale",
    totalTokens: 92000
  });
  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "item/completed",
          text: "Context compaction completed.",
          raw: {
            method: "item/completed",
            params: { threadId: "thr_auto_stale", item: { type: "contextCompaction", id: "ctx_auto_stale" } }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );
  queue.completeCodexSessionCommand(startCommand.id, { ok: true, appThreadId: "thr_auto_stale", sessionStatus: "active" }, { agentId: agent.id });

  const unchanged = queue.compactCodexSession(session.id, { automatic: true, reason: "context-threshold" });
  assert.equal(unchanged.pendingCommandCount, 0);
  assert.equal(compactCommandCount(session.id), 0);
  assert.equal(compactionQueuedEventCount(session.id), 0);
});

test("automatic context compaction can queue again after fresh post-compaction usage", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "auto-compact-fresh-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "new high context" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_auto_fresh" }], {
    agentId: agent.id
  });
  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "item/completed",
          text: "Context compaction completed.",
          raw: {
            method: "item/completed",
            params: { threadId: "thr_auto_fresh", item: { type: "contextCompaction", id: "ctx_auto_fresh" } }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );
  appendTestContextUsage(session.id, agent.id, {
    threadId: "thr_auto_fresh",
    turnId: "turn_auto_fresh",
    totalTokens: 91000
  });
  queue.completeCodexSessionCommand(startCommand.id, { ok: true, appThreadId: "thr_auto_fresh", sessionStatus: "active" }, { agentId: agent.id });

  const queued = queue.compactCodexSession(session.id, { automatic: true, reason: "context-threshold" });
  assert.equal(queued.pendingCommandCount, 1);
  assert.equal(compactCommandCount(session.id), 1);
  assert.equal(compactionQueuedEventCount(session.id), 1);
});

test("manual context compaction does not require context usage threshold", async () => {
  store.resetStoreForTest();

  const { agent, session } = await createActiveSessionForCompaction({
    agentId: "manual-compact-low-agent",
    threadId: "thr_manual_low",
    prompt: "manual compact"
  });

  const queued = queue.compactCodexSession(session.id, { automatic: false, reason: "manual" });
  assert.equal(queued.pendingCommandCount, 1);
  assert.equal(compactCommandCount(session.id), 1);

  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");
  assert.equal(compactCommand.payload.automatic, false);
  assert.equal(compactCommand.payload.reason, "manual");
});

test("automatic context compaction inside a running turn does not interrupt the turn", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "auto-compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "长任务需要继续跑" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_auto_compact" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(
    startCommand.id,
    {
      ok: true,
      appThreadId: "thr_auto_compact",
      activeTurnId: "turn_auto_compact",
      sessionStatus: "running"
    },
    { agentId: agent.id }
  );

  const compactEventAccepted = queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "item/completed",
        text: "Context compaction completed.",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_auto_compact",
            turnId: "turn_auto_compact",
            item: { type: "contextCompaction", id: "ctx_auto" }
          }
        }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(compactEventAccepted, true);
  const stillRunning = queue.getCodexSession(session.id);
  assert.equal(stillRunning.status, "running");
  assert.equal(stillRunning.leasedBy, agent.id);
  assert.equal(stillRunning.activeTurnId, "turn_auto_compact");

  const finalEventsAccepted = queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "item/completed",
        text: "压缩后继续完成。",
        finalMessage: "压缩后继续完成。",
        raw: {
          method: "item/completed",
          params: {
            threadId: "thr_auto_compact",
            turnId: "turn_auto_compact",
            item: { type: "agentMessage", id: "msg_auto", text: "压缩后继续完成。" }
          }
        }
      },
      {
        type: "turn/completed",
        text: "Turn completed.",
        raw: {
          method: "turn/completed",
          params: { threadId: "thr_auto_compact", turn: { id: "turn_auto_compact", status: "completed" } }
        }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(finalEventsAccepted, true);
  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.leasedBy, null);
  assert.equal(completed.activeTurnId, null);
  assert.equal(completed.finalMessage, "压缩后继续完成。");
});

test("compact command completion releases after compaction events followed by git summary", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "启动后压缩" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_compact_race" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_compact_race", sessionStatus: "active" },
    { agentId: agent.id }
  );

  queue.compactCodexSession(session.id, { automatic: false, reason: "manual" });
  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");

  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "context.compaction.started",
        text: "Codex context compaction started.",
        appThreadId: "thr_compact_race",
        sessionStatus: "running",
        raw: { method: "thread/compact/start" }
      },
      {
        type: "item/completed",
        text: "Context compaction completed.",
        raw: {
          method: "item/completed",
          params: { threadId: "thr_compact_race", turnId: "turn_compact_race", item: { type: "contextCompaction", id: "ctx_race" } }
        }
      },
      {
        type: "turn/completed",
        text: "Turn completed.",
        raw: { method: "turn/completed", params: { threadId: "thr_compact_race", turn: { id: "turn_compact_race", status: "completed" } } }
      },
      {
        type: "git.summary",
        text: "No git changes.",
        raw: { source: "desktop-agent", gitSummary: { root: process.cwd(), branch: "main", commit: "abc123", changedFiles: [] } }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(
    queue.completeCodexSessionCommand(
      compactCommand.id,
      { ok: true, appThreadId: "thr_compact_race", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.leasedBy, null);
  assert.equal(completed.activeTurnId, null);
});

test("context compaction item completion releases compact sessions after command result", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "启动后压缩" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_compact_item" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_compact_item", sessionStatus: "active" },
    { agentId: agent.id }
  );

  queue.compactCodexSession(session.id, { automatic: false, reason: "manual" });
  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");
  queue.completeCodexSessionCommand(
    compactCommand.id,
    { ok: true, appThreadId: "thr_compact_item", sessionStatus: "running" },
    { agentId: agent.id }
  );

  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "item/completed",
        text: "Context compaction completed.",
        raw: {
          method: "item/completed",
          params: { threadId: "thr_compact_item", item: { type: "contextCompaction", id: "ctx_item" } }
        }
      }
    ],
    { agentId: agent.id }
  );

  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.leasedBy, null);
  assert.equal(completed.activeTurnId, null);
});

test("compact command completion treats prior context compaction item as terminal", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "启动后压缩" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_compact_item_race" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_compact_item_race", sessionStatus: "active" },
    { agentId: agent.id }
  );

  queue.compactCodexSession(session.id, { automatic: false, reason: "manual" });
  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(compactCommand.type, "compact");
  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "item/completed",
        text: "Context compaction completed.",
        raw: {
          method: "item/completed",
          params: { threadId: "thr_compact_item_race", item: { type: "contextCompaction", id: "ctx_item_race" } }
        }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(
    queue.completeCodexSessionCommand(
      compactCommand.id,
      { ok: true, appThreadId: "thr_compact_item_race", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.leasedBy, null);
  assert.equal(completed.activeTurnId, null);
});

test("thread compacted notifications complete compact sessions", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "compact-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "启动后压缩" });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_compacted_notice" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(
    startCommand.id,
    { ok: true, appThreadId: "thr_compacted_notice", sessionStatus: "active" },
    { agentId: agent.id }
  );

  queue.compactCodexSession(session.id, { automatic: false, reason: "manual" });
  const compactCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(
    session.id,
    [
      {
        type: "thread/compacted",
        text: "Context compaction completed.",
        raw: { method: "thread/compacted", params: { threadId: "thr_compacted_notice", turnId: "turn_compacted_notice" } }
      }
    ],
    { agentId: agent.id }
  );

  assert.equal(
    queue.completeCodexSessionCommand(
      compactCommand.id,
      { ok: true, appThreadId: "thr_compacted_notice", sessionStatus: "running" },
      { agentId: agent.id }
    ),
    true
  );

  const completed = queue.getCodexSession(session.id, { rawMode: "client" });
  assert.equal(completed.status, "active");
  assert.equal(completed.leasedBy, null);
  const compactedEvent = completed.events.find((event) => event.type === "thread/compacted");
  assert.equal(compactedEvent.raw.params.threadId, "thr_compacted_notice");
  assert.equal(compactedEvent.raw.params.turnId, "turn_compacted_notice");
});

test("interactive Codex sessions can queue mobile cancellation for the active turn", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "cancel-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };

  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "run a long task"
  });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_cancel" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_cancel", activeTurnId: "turn_cancel", sessionStatus: "running" }, { agentId: agent.id });

  const queuedFollowUp = queue.enqueueCodexSessionMessage(session.id, {
    text: "this queued message should not run before stop"
  });
  assert.equal(queuedFollowUp.pendingCommandCount, 1);

  const cancelled = queue.cancelCodexSession(session.id, { reason: "stop from test" });
  assert.equal(cancelled.pendingCommandCount, 1);
  assert.equal(cancelled.events.some((event) => event.type === "turn.cancel.requested"), true);

  const stopCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(stopCommand.type, "stop");
  assert.equal(stopCommand.appThreadId, "thr_cancel");
  assert.equal(stopCommand.activeTurnId, "turn_cancel");
  assert.equal(stopCommand.payload.reason, "stop from test");

  const nextCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(nextCommand, null);
});

test("mobile cancellation can interrupt a synchronously leased backend turn", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "sync-cancel-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: claudeRosterRuntime()
  };
  const otherAgent = {
    id: "other-sync-cancel-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: claudeRosterRuntime()
  };
  queue.updateCodexAgent(agent);
  queue.updateCodexAgent(otherAgent);

  const session = queue.createCodexSession({
    projectId: "demo",
    targetAgentId: agent.id,
    prompt: "run a long Claude task",
    runtime: { backendId: "claude-code", provider: "claude-code", backendName: "Claude Code" }
  });
  const startCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(startCommand.type, "start");
  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "turn.started",
          text: "Claude Code turn started.",
          appThreadId: "thr_sync_cancel",
          activeTurnId: "turn_sync_cancel",
          sessionStatus: "running",
          raw: {
            method: "turn/started",
            params: { threadId: "thr_sync_cancel", turn: { id: "turn_sync_cancel", status: "inProgress" } }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );

  const cancelled = queue.cancelCodexSession(session.id, { reason: "stop sync backend" });
  assert.equal(cancelled.pendingCommandCount, 2);
  assert.equal(cancelled.leasedCommandCount, 1);
  assert.equal(cancelled.queuedCommandCount, 1);

  const wrongAgentStop = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent: otherAgent,
    commandTypes: ["stop"]
  });
  assert.equal(wrongAgentStop, null);

  const normalPoll = await queue.waitForCodexSessionCommand({
    waitMs: 1000,
    agent,
    busySessionIds: [session.id],
    commandTypes: ["message"]
  });
  assert.equal(normalPoll, null);

  const stopCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent, commandTypes: ["stop"] });
  assert.equal(stopCommand.type, "stop");
  assert.equal(stopCommand.appThreadId, "thr_sync_cancel");
  assert.equal(stopCommand.activeTurnId, "turn_sync_cancel");
  assert.equal(stopCommand.payload.reason, "stop sync backend");

  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "turn.interrupted",
          text: "Claude Code turn interrupted from mobile.",
          appThreadId: "thr_sync_cancel",
          activeTurnId: "turn_sync_cancel",
          clearActiveTurnId: true,
          sessionStatus: "active",
          raw: { method: "turn/interrupt", threadId: "thr_sync_cancel", turnId: "turn_sync_cancel" }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );
  assert.equal(
    queue.completeCodexSessionCommand(stopCommand.id, { ok: true, appThreadId: "thr_sync_cancel", sessionStatus: "active" }, { agentId: agent.id }),
    true
  );

  const completed = queue.getCodexSession(session.id);
  assert.equal(completed.status, "active");
  assert.equal(completed.activeTurnId, null);
  assert.equal(completed.pendingCommandCount, 0);
  assert.equal(completed.leasedCommandCount, 0);
  assert.equal(completed.queuedCommandCount, 0);

  const interrupted = db.prepare("SELECT status, error FROM codex_session_commands WHERE id = ?").get(startCommand.id);
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /stop sync backend/);
  assert.equal(
    queue.completeCodexSessionCommand(startCommand.id, { ok: true, appThreadId: "thr_sync_cancel", sessionStatus: "active" }, { agentId: agent.id }),
    false
  );
});

test("plan mode keeps the visible and queued user message clean", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "plan-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const created = queue.createCodexSession({
    projectId: "demo",
    prompt: "分析一下怎么改这个功能",
    mode: "plan"
  });

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.type, "start");
  assert.equal(command.payload.mode, "plan");
  assert.equal(command.payload.displayText, "分析一下怎么改这个功能");
  assert.equal(command.payload.prompt, "分析一下怎么改这个功能");

  const detail = queue.getCodexSession(created.id);
  assert.equal(detail.composerMode, "plan");
  assert.equal(detail.messages[0].text, "分析一下怎么改这个功能");

  queue.enqueueCodexSessionMessage(created.id, {
    projectId: "demo",
    text: "现在退出计划模式并执行",
    mode: "execute"
  });

  const updated = queue.getCodexSession(created.id);
  assert.equal(updated.composerMode, "execute");

  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_plan", sessionStatus: "active" }, { agentId: agent.id });
  const followUpCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(followUpCommand.type, "message");
  assert.equal(followUpCommand.payload.mode, "execute");
  assert.equal(followUpCommand.payload.previousComposerMode, "plan");
  assert.equal(followUpCommand.payload.hasPriorPlanMode, true);
});

test("mobile workspace commands create and advertise managed workspaces", async () => {
  store.resetStoreForTest();

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-workspace-root-"));
  process.env.ECHO_CODEX_WORKSPACE_ROOT = workspaceRoot;
  const manager = await import("../src/lib/codexWorkspaceManager.js");
  const runner = await import("../src/lib/codexRunner.js");

  const created = queue.createCodexWorkspace({ name: "移动端新工程" });
  assert.equal(created.status, "queued");
  assert.equal(created.payload.name, "移动端新工程");

  const command = await queue.waitForCodexWorkspaceCommand({
    waitMs: 1000,
    agent: {
      id: "workspace-agent",
      workspaces: [],
      runtime: { command: "codex" }
    }
  });
  assert.equal(command.id, created.id);
  assert.equal(command.type, "create");

  const workspace = manager.createManagedWorkspace(command.payload);
  assert.equal(fs.existsSync(workspace.path), true);
  assert.equal(path.dirname(workspace.path), workspaceRoot);

  assert.equal(
    queue.completeCodexWorkspaceCommand(
      command.id,
      { ok: true, workspace },
      {
        agent: {
          id: "workspace-agent",
          workspaces: [workspace],
          runtime: { command: "codex" }
        }
      }
    ),
    true
  );

  const completed = queue.getCodexWorkspaceCommand(command.id);
  assert.equal(completed.status, "done");
  assert.equal(completed.result.workspace.id, workspace.id);
  assert.equal(queue.codexStatus().workspaces.some((item) => item.id === workspace.id), true);
  assert.equal(runner.publicWorkspaces().some((item) => item.id === workspace.id), true);
});

test("project visibility hides desktop-advertised workspaces per user without deleting sessions", () => {
  store.resetStoreForTest();

  const alice = { username: "alice", role: "owner" };
  queue.updateCodexAgent({
    id: "alice-mac",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "codex" }
  });
  const session = queue.createCodexSession({
    projectId: "echo",
    targetAgentId: "alice-mac",
    ownerUser: "alice",
    prompt: "keep history"
  });

  const visibleStatus = queue.codexStatus({ user: alice });
  assert.deepEqual(visibleStatus.workspaces.map((workspace) => workspace.key), ["alice-mac:echo"]);

  const visibility = queue.updateCodexWorkspaceVisibility({
    workspaceId: "echo",
    targetAgentId: "alice-mac",
    ownerUser: "alice",
    visible: false,
    user: alice
  });
  assert.equal(visibility.visibleInSidebar, false);

  const hiddenStatus = queue.codexStatus({ user: alice });
  assert.deepEqual(hiddenStatus.workspaces, []);
  assert.deepEqual(hiddenStatus.hiddenWorkspaceKeys, ["alice-mac:echo"]);
  assert.equal(queue.getCodexSession(session.id, { user: alice })?.id, session.id);
});

test("workspace register commands carry only root id and bounded relative path", async () => {
  store.resetStoreForTest();

  const alice = { username: "alice", role: "owner" };
  queue.updateCodexAgent({
    id: "alice-mac",
    ownerUser: "alice",
    workspaces: [{ id: "echo", label: "Echo", path: "/workspace/echo" }],
    runtime: { command: "codex" }
  });

  assert.throws(
    () =>
      queue.createCodexWorkspaceRegister({
        rootId: "root-a",
        path: "../escape",
        targetAgentId: "alice-mac",
        ownerUser: "alice",
        user: alice
      }),
    /stay inside/
  );

  const command = queue.createCodexWorkspaceRegister({
    rootId: "root-a",
    path: "team/echo",
    targetAgentId: "alice-mac",
    ownerUser: "alice",
    user: alice
  });
  assert.equal(command.type, "register");
  assert.deepEqual(command.payload, {
    rootId: "root-a",
    path: "team/echo",
    requestedBy: "mobile"
  });

  const leased = await queue.waitForCodexWorkspaceCommand({
    waitMs: 1000,
    agent: { id: "alice-mac", workspaces: [{ id: "echo", path: "/workspace/echo" }] }
  });
  assert.equal(leased.id, command.id);
  assert.equal(leased.type, "register");
});

test("MCP apply commands request desktop agent restart by default", () => {
  store.resetStoreForTest();

  const restartCommand = queue.createCodexMcpApply({ profileId: "memory", targetClients: ["codex"], requestedBy: "mobile" });
  assert.equal(restartCommand.payload.restartDesktopAgent, true);

  const noRestartCommand = queue.createCodexMcpApply({
    profileId: "memory",
    targetClients: ["codex"],
    requestedBy: "mobile",
    restartDesktopAgent: false
  });
  assert.equal(noRestartCommand.payload.restartDesktopAgent, false);
});

test("file browser requests are short-lived and scoped to advertised workspaces", async () => {
  store.resetStoreForTest();

  assert.throws(
    () => queue.createCodexFileRequest({ type: "list", projectId: "demo", path: "" }),
    /not online/
  );

  const agent = {
    id: "file-agent",
    workspaces: [{ id: "demo", label: "Demo", path: process.cwd() }],
    runtime: { command: "codex" }
  };
  queue.updateCodexAgent(agent);

  assert.throws(
    () => queue.createCodexFileRequest({ type: "read", projectId: "demo", path: "../package.json" }),
    /stay inside/
  );

  const created = queue.createCodexFileRequest({ type: "list", projectId: "demo", path: "src", maxEntries: 40 });
  assert.equal(created.status, "queued");
  assert.equal(created.type, "list");
  assert.equal(created.projectId, "demo");
  assert.equal(created.path, "src");
  assert.equal(created.payload.maxEntries, 40);

  const wrongAgent = await queue.waitForCodexFileRequest({
    waitMs: 20,
    agent: {
      id: "wrong-file-agent",
      workspaces: [{ id: "other", path: process.cwd() }],
      runtime: { command: "codex" }
    }
  });
  assert.equal(wrongAgent, null);

  const request = await queue.waitForCodexFileRequest({ waitMs: 1000, agent });
  assert.equal(request.id, created.id);
  assert.equal(request.status, "leased");
  assert.equal(request.leasedBy, agent.id);

  assert.equal(
    queue.completeCodexFileRequest(
      request.id,
      { ok: true, tree: { projectId: "demo", path: "src", entries: [] } },
      { agent }
    ),
    true
  );

  const completed = await queue.waitForCodexFileRequestResult(created.id, { waitMs: 1000 });
  assert.equal(completed.status, "done");
  assert.equal(completed.result.tree.path, "src");
});

test("interactive Codex sessions can be archived and restored", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "archive-agent",
    workspaces: [{ id: "demo", path: process.cwd() }]
  };
  const session = queue.createCodexSession({ projectId: "demo", prompt: "整理历史会话" });
  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  queue.appendCodexSessionEvents(session.id, [{ type: "thread.started", text: "started", appThreadId: "thr_archive" }], {
    agentId: agent.id
  });
  queue.completeCodexSessionCommand(command.id, { ok: true, appThreadId: "thr_archive", sessionStatus: "active" }, { agentId: agent.id });

  assert.equal(queue.listCodexSessions(10).some((item) => item.id === session.id), true);
  const archived = queue.archiveCodexSession(session.id, { archived: true });
  assert.equal(Boolean(archived.archivedAt), true);
  assert.equal(queue.listCodexSessions(10).some((item) => item.id === session.id), false);
  assert.equal(queue.listCodexSessions(10, { archived: true }).some((item) => item.id === session.id), true);

  const archiveCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(archiveCommand.type, "archive");
  assert.equal(archiveCommand.appThreadId, "thr_archive");
  assert.equal(archiveCommand.payload.archived, true);
  assert.throws(
    () => queue.archiveCodexSession(session.id, { archived: false }),
    /pending session command/
  );
  queue.completeCodexSessionCommand(
    archiveCommand.id,
    { ok: true, appThreadId: "thr_archive", sessionStatus: "active" },
    { agentId: agent.id }
  );

  const restored = queue.archiveCodexSession(session.id, { archived: false });
  assert.equal(restored.archivedAt, null);
  assert.equal(queue.listCodexSessions(10).some((item) => item.id === session.id), true);

  const restoreCommand = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(restoreCommand.type, "archive");
  assert.equal(restoreCommand.appThreadId, "thr_archive");
  assert.equal(restoreCommand.payload.archived, false);
  queue.completeCodexSessionCommand(
    restoreCommand.id,
    { ok: true, appThreadId: "thr_archive", sessionStatus: "active" },
    { agentId: agent.id }
  );
});

test("archived interactive Codex sessions can be deleted with stored files cleaned up", async () => {
  store.resetStoreForTest();

  const agent = {
    id: "delete-archive-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { command: "fake-codex" }
  };
  queue.updateCodexAgent(agent);

  const session = queue.createCodexSession({
    projectId: "demo",
    prompt: "删除这个归档会话",
    attachments: [{ type: "image", url: "data:image/png;base64,AAAA", name: "screen.png", mimeType: "image/png", sizeBytes: 4 }]
  });
  const attachmentId = queue.getCodexSession(session.id).messages[0].attachments[0].id;
  const attachmentPath = queue.getCodexSessionAttachmentContent(attachmentId).filePath;
  assert.equal(fs.existsSync(attachmentPath), true);

  assert.throws(
    () => queue.deleteCodexSession(session.id),
    /Archive this session before deleting it/
  );

  const command = await queue.waitForCodexSessionCommand({ waitMs: 1000, agent });
  assert.equal(command.sessionId, session.id);
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  assert.equal(
    queue.appendCodexSessionEvents(
      session.id,
      [
        {
          type: "item/completed",
          text: "stored image",
          raw: {
            method: "item/completed",
            params: {
              item: {
                id: "delete-archive-image",
                type: "agentMessage",
                content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } }]
              }
            }
          }
        }
      ],
      { agentId: agent.id }
    ),
    true
  );
  assert.equal(queue.completeCodexSessionCommand(command.id, { ok: true, sessionStatus: "active" }, { agentId: agent.id }), true);

  const artifactId = queue.getCodexSession(session.id).artifacts[0].id;
  const artifactPath = queue.getCodexSessionArtifactContent(artifactId).filePath;
  assert.equal(fs.existsSync(artifactPath), true);

  assert.equal(queue.archiveCodexSession(session.id, { archived: true }).archivedAt.length > 0, true);
  const deleted = queue.deleteCodexSession(session.id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.attachmentCount, 1);
  assert.equal(deleted.artifactCount, 1);
  assert.equal(queue.getCodexSession(session.id), null);
  assert.equal(queue.listCodexSessions(10, { archived: true }).some((item) => item.id === session.id), false);
  assert.equal(queue.getCodexSessionAttachmentContent(attachmentId), null);
  assert.equal(queue.getCodexSessionArtifactContent(artifactId), null);
  assert.equal(fs.existsSync(attachmentPath), false);
  assert.equal(fs.existsSync(artifactPath), false);
});

test("Workspace runtime preferences are isolated by user, desktop, and Workspace", () => {
  store.resetStoreForTest();
  for (const id of ["preference-agent-a", "preference-agent-b"]) {
    queue.updateCodexAgent({
      id,
      workspaces: [
        { id: "alpha", path: process.cwd() },
        { id: "beta", path: process.cwd() }
      ],
      runtime: {
        backendId: "codex",
        provider: "codex",
        worktreeMode: "optional",
        supportedModels: [{ id: "gpt-5.5", supportedReasoningEfforts: ["high"] }]
      }
    });
  }

  const created = queue.updateCodexWorkspaceRuntimePreference({
    ownerUser: "alice",
    targetAgentId: "preference-agent-a",
    workspaceId: "alpha",
    version: 0,
    preference: {
      backendId: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      permissionMode: "full",
      worktreeMode: "always"
    }
  }).preference;

  assert.equal(created.version, 1);
  assert.equal(created.permissionMode, "full");
  assert.equal(queue.getCodexWorkspaceRuntimePreference({ ownerUser: "alice", targetAgentId: "preference-agent-a", workspaceId: "alpha" }).version, 1);
  assert.equal(queue.getCodexWorkspaceRuntimePreference({ ownerUser: "bob", targetAgentId: "preference-agent-a", workspaceId: "alpha" }), null);
  assert.equal(queue.getCodexWorkspaceRuntimePreference({ ownerUser: "alice", targetAgentId: "preference-agent-b", workspaceId: "alpha" }), null);
  assert.equal(queue.getCodexWorkspaceRuntimePreference({ ownerUser: "alice", targetAgentId: "preference-agent-a", workspaceId: "beta" }), null);

  const session = queue.createCodexSession({
    ownerUser: "alice",
    targetAgentId: "preference-agent-a",
    projectId: "alpha",
    prompt: "use saved settings",
    runtime: {}
  });
  assert.equal(session.runtime.permissionMode, "full");
  assert.equal(session.runtime.sandbox, "danger-full-access");
  assert.equal(session.runtime.approvalPolicy, "never");
  assert.equal(session.runtime.worktreeMode, "always");

  const updated = queue.updateCodexWorkspaceRuntimePreference({
    ownerUser: "alice",
    targetAgentId: "preference-agent-a",
    workspaceId: "alpha",
    version: created.version,
    preference: { backendId: "codex", permissionMode: "strict", worktreeMode: "off" }
  }).preference;
  const continued = queue.enqueueCodexSessionMessage(session.id, {
    text: "continue with Workspace settings",
    runtime: { backendId: "codex", permissionMode: "full", worktreeMode: "always" }
  });
  assert.equal(updated.permissionMode, "strict");
  assert.equal(continued.runtime.permissionMode, "strict");
  assert.equal(continued.runtime.sandbox, "read-only");
  assert.equal(continued.runtime.worktreeMode, "off");
});

test("Workspace runtime preference updates reject stale versions and migration never overwrites Relay state", () => {
  store.resetStoreForTest();
  queue.updateCodexAgent({
    id: "preference-conflict-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: { backendId: "codex", provider: "codex", worktreeMode: "off" }
  });
  const scope = { ownerUser: "alice", targetAgentId: "preference-conflict-agent", workspaceId: "demo" };
  const first = queue.updateCodexWorkspaceRuntimePreference({
    ...scope,
    version: 0,
    preference: { backendId: "codex", permissionMode: "approve", worktreeMode: "off" }
  }).preference;
  const second = queue.updateCodexWorkspaceRuntimePreference({
    ...scope,
    version: first.version,
    preference: { backendId: "codex", permissionMode: "full", worktreeMode: "off" }
  }).preference;

  assert.throws(
    () => queue.updateCodexWorkspaceRuntimePreference({
      ...scope,
      version: first.version,
      preference: { backendId: "codex", permissionMode: "strict", worktreeMode: "off" }
    }),
    (error) => error.statusCode === 409 && error.code === "runtime.preference.version_conflict" && error.preference.version === second.version
  );

  const migration = queue.updateCodexWorkspaceRuntimePreference({
    ...scope,
    version: 0,
    migration: true,
    migrationCandidate: { backendId: "codex", permissionMode: "strict", worktreeMode: "off" }
  });
  assert.equal(migration.migrated, false);
  assert.equal(migration.preference.permissionMode, "full");
  assert.equal(migration.preference.version, second.version);
});

test("Relay rejects unsupported runtime selections instead of changing backend, model, or permission", () => {
  store.resetStoreForTest();
  queue.updateCodexAgent({
    id: "strict-runtime-agent",
    workspaces: [{ id: "demo", path: process.cwd() }],
    runtime: {
      backendId: "codex",
      provider: "codex",
      supportedModels: [{ id: "gpt-5.5", supportedReasoningEfforts: ["high"] }],
      backends: [
        {
          backendId: "codex",
          provider: "codex",
          supportedModels: [{ id: "gpt-5.5", supportedReasoningEfforts: ["high"] }]
        },
        {
          backendId: "limited",
          provider: "custom-runtime",
          supportedPermissionModes: ["strict"],
          supportedModels: [{ id: "limited-model" }]
        }
      ]
    }
  });
  const base = { ownerUser: "alice", targetAgentId: "strict-runtime-agent", workspaceId: "demo", version: 0 };

  assert.throws(
    () => queue.updateCodexWorkspaceRuntimePreference({ ...base, preference: { backendId: "missing", permissionMode: "full" } }),
    (error) => error.code === "runtime.backend.unsupported"
  );
  assert.throws(
    () => queue.updateCodexWorkspaceRuntimePreference({ ...base, preference: { backendId: "codex", model: "limited-model", permissionMode: "full" } }),
    (error) => error.code === "runtime.model.unsupported"
  );
  assert.throws(
    () => queue.updateCodexWorkspaceRuntimePreference({ ...base, preference: { backendId: "limited", model: "limited-model", permissionMode: "full" } }),
    (error) => error.code === "runtime.permission.unsupported"
  );
});
