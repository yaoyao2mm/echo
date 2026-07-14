import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("codex store migration adds multi-user columns before creating dependent indexes", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-migration-compat-"));
  process.env.HOME = tempHome;
  process.env.ECHO_MODE = "relay";
  process.env.ECHO_TOKEN = "migration-token";
  const dataDir = path.join(tempHome, ".echo-voice");
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "echo.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE echo_schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO echo_schema_meta (key, value, updated_at)
    VALUES ('schema_version', '8', '2026-01-01T00:00:00.000Z');

    CREATE TABLE workspace_runtime_preferences (
      owner_user TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      preference_json TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL CHECK (version >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(owner_user, target_agent_id, workspace_id)
    );
    INSERT INTO workspace_runtime_preferences (
      owner_user, target_agent_id, workspace_id, preference_json, version, created_at, updated_at
    ) VALUES (
      'alice', 'desktop-a', 'metio', '{"backendId":"claude-code","permissionMode":"approve","worktreeMode":"off"}',
      3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    CREATE TABLE codex_agents (
      id TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL,
      workspaces_json TEXT NOT NULL DEFAULT '[]',
      runtime_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE codex_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      app_thread_id TEXT,
      active_turn_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      final_message TEXT NOT NULL DEFAULT '',
      leased_by TEXT,
      lease_expires_at TEXT,
      archived_at TEXT,
      runtime_json TEXT NOT NULL DEFAULT '{}',
      execution_json TEXT NOT NULL DEFAULT '{}',
      memory_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE codex_workspace_commands (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE codex_file_requests (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_id TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT '',
      requested_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE codex_session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      text TEXT NOT NULL DEFAULT '',
      command_id TEXT,
      external_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, external_key)
    );

    CREATE TABLE codex_session_attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES codex_session_messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('image')),
      original_name TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(storage_key)
    );

    CREATE TABLE codex_session_commands (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES codex_sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      leased_by TEXT,
      lease_expires_at TEXT,
      error TEXT NOT NULL DEFAULT ''
    );
  `);
  db.close();

  const store = await import("../src/lib/codexStore.js");
  assert.equal(typeof store.statusSnapshot, "function");
  const command = store.createMcpApplyCommand({ profileId: "memory", targetClients: ["codex"], requestedBy: "mobile" });
  assert.equal(command.type, "mcp.apply");
  assert.equal(command.payload.restartDesktopAgent, true);

  const migrated = new Database(dbPath);
  try {
    for (const [table, column] of [
      ["codex_agents", "owner_user"],
      ["codex_agents", "snapshot_updated_at"],
      ["codex_agents", "workspaces_updated_at"],
      ["codex_agents", "runtime_updated_at"],
      ["codex_sessions", "owner_user"],
      ["codex_sessions", "target_agent_id"],
      ["codex_session_commands", "available_at"],
      ["codex_workspace_commands", "owner_user"],
      ["codex_workspace_commands", "target_agent_id"],
      ["codex_workspace_visibility", "visible_in_sidebar"],
      ["codex_file_requests", "owner_user"],
      ["codex_file_requests", "target_agent_id"],
      ["codex_quick_skills", "target_agent_id"]
    ]) {
      assert.equal(migrated.prepare(`PRAGMA table_info(${table})`).all().some((info) => info.name === column), true);
    }
    assert.equal(
      migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_runtime_preferences'").get()?.name,
      "workspace_runtime_preferences"
    );
    const metioPreference = migrated.prepare(`
      SELECT preference_json AS preferenceJson, version
      FROM workspace_runtime_preferences
      WHERE owner_user = 'alice' AND target_agent_id = 'desktop-a' AND workspace_id = 'metio'
    `).get();
    assert.equal(JSON.parse(metioPreference.preferenceJson).permissionMode, "full");
    assert.equal(metioPreference.version, 4);
    assert.equal(
      migrated.prepare("SELECT value FROM echo_schema_meta WHERE key = 'schema_version'").get()?.value,
      "10"
    );
    assert.equal(
      migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_agent_restart_operations'").get()?.name,
      "codex_agent_restart_operations"
    );
    assert.equal(
      migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_codex_sessions_owner_target_updated'").get()?.name,
      "idx_codex_sessions_owner_target_updated"
    );
    assert.match(
      migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_session_attachments'").get()?.sql || "",
      /'file'/
    );
    assert.match(
      migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_file_requests'").get()?.sql || "",
      /'open-spec-summary'/
    );
    assert.match(
      migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_file_requests'").get()?.sql || "",
      /'orchestration-plan'/
    );
    assert.match(
      migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_workspace_commands'").get()?.sql || "",
      /'register'/
    );
    assert.match(
      migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_workspace_commands'").get()?.sql || "",
      /'agent-skill.update'/
    );
    assert.match(
      migrated.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_workspace_commands'").get()?.sql || "",
      /'plugin.update'/
    );
  } finally {
    migrated.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});
