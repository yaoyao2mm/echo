import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(path.join(config.dataDir, "echo.sqlite"));
const managedTokenBytes = 32;

migrateAuthStore();

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().slice(0, 120);
}

export function listAuthUsers(configUsers = []) {
  const managed = new Map(listManagedUserRows().map((row) => [row.username, row]));
  const merged = [];
  const seen = new Set();

  for (const user of configUsers || []) {
    const username = normalizeUsername(user.username);
    if (!username || seen.has(username)) continue;
    const override = managed.get(username);
    merged.push(normalizeMergedUser(user, override, "config"));
    seen.add(username);
  }

  for (const row of managed.values()) {
    if (seen.has(row.username)) continue;
    merged.push(normalizeMergedUser({}, row, "db"));
    seen.add(row.username);
  }

  return merged.filter((user) => user.username);
}

export function findAuthUser(username, configUsers = []) {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const user = listAuthUsers(configUsers).find((item) => item.username === normalized) || null;
  if (!user || user.disabledAt) return null;
  return user;
}

export function listAdminUsers(configUsers = []) {
  return listAuthUsers(configUsers).map((user) => ({
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "user",
    disabledAt: user.disabledAt || "",
    sessionRevokedBefore: user.sessionRevokedBefore || "",
    source: user.source || "db",
    quotaBytes: getStorageQuotaBytes(user.username)
  }));
}

export function upsertManagedUser(input = {}) {
  const username = normalizeUsername(input.username);
  if (!username) return badRequest("Username is required.");
  const role = normalizeRole(input.role);
  const passwordSha256 = normalizePasswordHash(input.passwordSha256 || input.password_hash_sha256) || (input.password ? sha256(input.password) : "");
  const existing = getManagedUserRow(username);
  if (!existing && !passwordSha256) return badRequest("Password hash is required for new users.");
  const now = nowIso();

  db.prepare(`
    INSERT INTO auth_users (
      username, display_name, role, password_sha256, disabled_at, session_revoked_before, created_at, updated_at
    ) VALUES (
      @username, @displayName, @role, @passwordSha256, '', '', @now, @now
    )
    ON CONFLICT(username) DO UPDATE SET
      display_name = excluded.display_name,
      role = excluded.role,
      password_sha256 = CASE WHEN excluded.password_sha256 <> '' THEN excluded.password_sha256 ELSE auth_users.password_sha256 END,
      updated_at = excluded.updated_at
  `).run({
    username,
    displayName: String(input.displayName || input.display_name || username).trim().slice(0, 120) || username,
    role,
    passwordSha256,
    now
  });

  if (input.quotaBytes !== undefined) setStorageQuota(username, input.quotaBytes);
  return getAdminUser(username);
}

export function updateManagedUser(username, input = {}) {
  const normalized = normalizeUsername(username);
  if (!normalized) return badRequest("Username is required.");
  let existing = getManagedUserRow(normalized);
  const passwordSha256 = normalizePasswordHash(input.passwordSha256 || input.password_hash_sha256) || (input.password ? sha256(input.password) : "");
  if (!existing && input.allowPasswordlessShell && !passwordSha256) {
    ensureManagedUserShell(normalized);
    existing = getManagedUserRow(normalized);
  }
  if (!existing) {
    return upsertManagedUser({ ...input, username: normalized });
  }

  const now = nowIso();
  db.prepare(`
    UPDATE auth_users
    SET display_name = @displayName,
        role = @role,
        password_sha256 = CASE WHEN @passwordSha256 <> '' THEN @passwordSha256 ELSE password_sha256 END,
        updated_at = @now
    WHERE username = @username
  `).run({
    username: normalized,
    displayName: String(input.displayName ?? input.display_name ?? existing.displayName ?? normalized).trim().slice(0, 120) || normalized,
    role: normalizeRole(input.role ?? existing.role),
    passwordSha256,
    now
  });
  if (input.quotaBytes !== undefined) setStorageQuota(normalized, input.quotaBytes);
  return getAdminUser(normalized);
}

export function setUserDisabled(username, disabled = true) {
  const normalized = normalizeUsername(username);
  if (!normalized) return badRequest("Username is required.");
  ensureManagedUserShell(normalized);
  const now = nowIso();
  db.prepare(`
    UPDATE auth_users
    SET disabled_at = @disabledAt,
        updated_at = @now
    WHERE username = @username
  `).run({
    username: normalized,
    disabledAt: disabled ? now : "",
    now
  });
  return getAdminUser(normalized);
}

export function revokeUserSessions(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return badRequest("Username is required.");
  ensureManagedUserShell(normalized);
  const now = nowIso();
  db.prepare(`
    UPDATE auth_users
    SET session_revoked_before = @now,
        updated_at = @now
    WHERE username = @username
  `).run({ username: normalized, now });
  return getAdminUser(normalized);
}

export function getUserSessionNotBeforeMs(username) {
  const row = getManagedUserRow(username);
  const parsed = Date.parse(row?.sessionRevokedBefore || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createPairingToken(input = {}) {
  const ownerUser = normalizeUsername(input.ownerUsername || input.ownerUser || input.username);
  if (!ownerUser) return badRequest("Pairing token owner is required.");
  const token = generateToken("ept");
  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    ownerUser,
    label: String(input.label || input.displayName || "Phone").trim().slice(0, 120) || "Phone",
    tokenHash: sha256(token),
    createdBy: normalizeUsername(input.createdBy),
    now
  };
  db.prepare(`
    INSERT INTO auth_pairing_tokens (
      id, owner_user, label, token_hash, created_by, created_at, updated_at
    ) VALUES (
      @id, @ownerUser, @label, @tokenHash, @createdBy, @now, @now
    )
  `).run(row);
  return {
    token,
    item: getPairingToken(row.id)
  };
}

export function createAgentToken(input = {}) {
  const ownerUser = normalizeUsername(input.ownerUsername || input.ownerUser || input.username);
  if (!ownerUser) return badRequest("Agent token owner is required.");
  const agentId = normalizeAgentId(input.agentId || input.agent_id);
  if (!agentId) return badRequest("Agent ID is required.");
  const existing = findActiveAgentTokenForAgent(agentId);
  if (existing) return conflict(`Agent ID is already in use by ${existing.ownerUser || "another owner"}.`);
  const token = generateToken("eat");
  const now = nowIso();
  const row = {
    id: crypto.randomUUID(),
    ownerUser,
    agentId,
    displayName: String(input.displayName || input.display_name || input.label || "").trim().slice(0, 120),
    label: String(input.label || input.displayName || input.agentId || "Desktop Agent").trim().slice(0, 120) || "Desktop Agent",
    tokenHash: sha256(token),
    createdBy: normalizeUsername(input.createdBy),
    now
  };
  try {
    db.prepare(`
      INSERT INTO auth_agent_tokens (
        id, owner_user, agent_id, display_name, label, token_hash, created_by, created_at, updated_at
      ) VALUES (
        @id, @ownerUser, @agentId, @displayName, @label, @tokenHash, @createdBy, @now, @now
      )
    `).run(row);
  } catch (error) {
    if (isSqliteUniqueConstraintError(error)) {
      return conflict(`Agent ID is already in use by ${agentId}.`);
    }
    throw error;
  }
  return {
    token,
    item: getAgentToken(row.id)
  };
}

export function createAgentAccessGrant(input = {}) {
  const granteeUser = normalizeUsername(input.granteeUsername || input.granteeUser || input.username);
  const agentId = normalizeAgentId(input.agentId || input.agent_id);
  const ownerUser = normalizeUsername(input.ownerUsername || input.ownerUser || input.agentOwnerUsername || input.agentOwnerUser);
  if (!granteeUser) return badRequest("Grant user is required.");
  if (!agentId) return badRequest("Agent ID is required.");

  const now = nowIso();
  db.prepare(`
    INSERT INTO auth_agent_access_grants (
      id, agent_id, owner_user, grantee_user, created_by, created_at, updated_at
    ) VALUES (
      @id, @agentId, @ownerUser, @granteeUser, @createdBy, @now, @now
    )
    ON CONFLICT(agent_id, owner_user, grantee_user) DO UPDATE SET
      disabled_at = '',
      revoked_at = '',
      created_by = excluded.created_by,
      updated_at = excluded.updated_at
  `).run({
    id: crypto.randomUUID(),
    agentId,
    ownerUser,
    granteeUser,
    createdBy: normalizeUsername(input.createdBy),
    now
  });
  return getAgentAccessGrant({ agentId, ownerUser, granteeUser });
}

export function listPairingTokens() {
  return db.prepare(`
    SELECT id, owner_user AS ownerUser, label, created_by AS createdBy, created_at AS createdAt,
           updated_at AS updatedAt, last_used_at AS lastUsedAt, disabled_at AS disabledAt, revoked_at AS revokedAt
    FROM auth_pairing_tokens
    ORDER BY created_at DESC
    LIMIT 300
  `).all();
}

export function listAgentTokens() {
  return db.prepare(`
    SELECT id, owner_user AS ownerUser, agent_id AS agentId, display_name AS displayName, label,
           created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt,
           last_used_at AS lastUsedAt, disabled_at AS disabledAt, revoked_at AS revokedAt
    FROM auth_agent_tokens
    ORDER BY created_at DESC
    LIMIT 300
  `).all();
}

export function listAgentAccessGrants() {
  return db.prepare(`
    SELECT id, agent_id AS agentId, owner_user AS ownerUser, grantee_user AS granteeUser,
           created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt,
           disabled_at AS disabledAt, revoked_at AS revokedAt
    FROM auth_agent_access_grants
    ORDER BY created_at DESC
    LIMIT 500
  `).all();
}

export function canAccessAgentOwner(user = null, agent = {}) {
  if (!user) return true;
  if (String(user.role || "").toLowerCase() === "owner") return true;
  const username = normalizeUsername(user.username || user.displayName);
  const ownerUser = normalizeUsername(agent.ownerUser || agent.ownerUsername);
  if (!ownerUser) return false;
  if (username && username === ownerUser) return true;
  const agentId = normalizeAgentId(agent.agentId || agent.id);
  if (!username || !agentId) return false;
  const row = db.prepare(`
    SELECT 1
    FROM auth_agent_access_grants
    WHERE agent_id = @agentId
      AND owner_user = @ownerUser
      AND grantee_user = @username
      AND disabled_at = ''
      AND revoked_at = ''
    LIMIT 1
  `).get({ agentId, ownerUser, username });
  return Boolean(row);
}

export function setPairingTokenDisabled(id, disabled = true) {
  const now = nowIso();
  db.prepare(`
    UPDATE auth_pairing_tokens
    SET disabled_at = @disabledAt,
        updated_at = @now
    WHERE id = @id
  `).run({ id: String(id || ""), disabledAt: disabled ? now : "", now });
  return getPairingToken(id);
}

export function revokePairingToken(id) {
  const now = nowIso();
  db.prepare(`
    UPDATE auth_pairing_tokens
    SET revoked_at = @now,
        updated_at = @now
    WHERE id = @id
  `).run({ id: String(id || ""), now });
  return getPairingToken(id);
}

export function setAgentTokenDisabled(id, disabled = true) {
  const now = nowIso();
  db.prepare(`
    UPDATE auth_agent_tokens
    SET disabled_at = @disabledAt,
        updated_at = @now
    WHERE id = @id
  `).run({ id: String(id || ""), disabledAt: disabled ? now : "", now });
  return getAgentToken(id);
}

export function revokeAgentToken(id) {
  const now = nowIso();
  db.prepare(`
    UPDATE auth_agent_tokens
    SET revoked_at = @now,
        updated_at = @now
    WHERE id = @id
  `).run({ id: String(id || ""), now });
  return getAgentToken(id);
}

export function verifyPairingToken({ token, user = null, configTokens = [] } = {}) {
  const tokenHash = sha256(token);
  if (!String(token || "").trim()) return null;
  for (const entry of configTokens || []) {
    if (entry.disabled || entry.revoked) continue;
    if (!safeEqual(tokenHash, tokenHashForConfigEntry(entry))) continue;
    const ownerUser = normalizeUsername(entry.ownerUsername || entry.ownerUser || entry.username);
    if (!tokenAllowedForUser(ownerUser, user)) return null;
    return {
      id: entry.id || "config",
      source: entry.legacy ? "legacy-env" : "config",
      ownerUser,
      label: entry.label || entry.displayName || "Configured pairing token"
    };
  }

  const row = db.prepare(`
    SELECT id, owner_user AS ownerUser, label
    FROM auth_pairing_tokens
    WHERE token_hash = ?
      AND disabled_at = ''
      AND revoked_at = ''
    LIMIT 1
  `).get(tokenHash);
  if (!row || !tokenAllowedForUser(row.ownerUser, user)) return null;
  touchToken("auth_pairing_tokens", row.id);
  return { ...row, source: "db" };
}

export function verifyAgentToken({ token, configTokens = [] } = {}) {
  const tokenHash = sha256(token);
  if (!String(token || "").trim()) return null;
  for (const entry of configTokens || []) {
    if (entry.disabled || entry.revoked) continue;
    if (!safeEqual(tokenHash, tokenHashForConfigEntry(entry))) continue;
    return {
      id: entry.id || "config",
      source: entry.legacy ? "legacy-env" : "config",
      ownerUsername: normalizeUsername(entry.ownerUsername || entry.ownerUser || entry.username),
      agentId: String(entry.agentId || "").trim(),
      displayName: String(entry.displayName || entry.label || "").trim(),
      legacy: Boolean(entry.legacy)
    };
  }

  const row = db.prepare(`
    SELECT id, owner_user AS ownerUsername, agent_id AS agentId, display_name AS displayName
    FROM auth_agent_tokens
    WHERE token_hash = ?
      AND disabled_at = ''
      AND revoked_at = ''
    LIMIT 1
  `).get(tokenHash);
  if (!row) return null;
  touchToken("auth_agent_tokens", row.id);
  return {
    ...row,
    source: "db",
    legacy: false
  };
}

export function setStorageQuota(username, quotaBytes) {
  const ownerUser = normalizeUsername(username);
  if (!ownerUser) return badRequest("Quota owner is required.");
  const bytes = Math.max(0, Math.floor(Number(quotaBytes) || 0));
  const now = nowIso();
  db.prepare(`
    INSERT INTO auth_user_quotas (owner_user, quota_bytes, created_at, updated_at)
    VALUES (@ownerUser, @bytes, @now, @now)
    ON CONFLICT(owner_user) DO UPDATE SET
      quota_bytes = excluded.quota_bytes,
      updated_at = excluded.updated_at
  `).run({ ownerUser, bytes, now });
  return { ownerUser, quotaBytes: bytes };
}

export function getStorageQuotaBytes(username) {
  const ownerUser = normalizeUsername(username);
  if (!ownerUser) return 0;
  const row = db.prepare("SELECT quota_bytes AS quotaBytes FROM auth_user_quotas WHERE owner_user = ?").get(ownerUser);
  if (row) return Math.max(0, Number(row.quotaBytes || 0) || 0);
  return Math.max(0, Number(config.auth.defaultStorageQuotaBytes || 0) || 0);
}

export function resetAuthStoreForTest() {
  db.prepare("DELETE FROM auth_pairing_tokens").run();
  db.prepare("DELETE FROM auth_agent_tokens").run();
  db.prepare("DELETE FROM auth_agent_access_grants").run();
  db.prepare("DELETE FROM auth_user_quotas").run();
  db.prepare("DELETE FROM auth_users").run();
}

function migrateAuthStore() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      username TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      password_sha256 TEXT NOT NULL DEFAULT '',
      disabled_at TEXT NOT NULL DEFAULT '',
      session_revoked_before TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_pairing_tokens (
      id TEXT PRIMARY KEY,
      owner_user TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT '',
      disabled_at TEXT NOT NULL DEFAULT '',
      revoked_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS auth_agent_tokens (
      id TEXT PRIMARY KEY,
      owner_user TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT '',
      disabled_at TEXT NOT NULL DEFAULT '',
      revoked_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS auth_agent_access_grants (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      owner_user TEXT NOT NULL DEFAULT '',
      grantee_user TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT NOT NULL DEFAULT '',
      revoked_at TEXT NOT NULL DEFAULT '',
      UNIQUE(agent_id, owner_user, grantee_user)
    );

    CREATE TABLE IF NOT EXISTS auth_user_quotas (
      owner_user TEXT PRIMARY KEY,
      quota_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_pairing_tokens_owner
      ON auth_pairing_tokens(owner_user, disabled_at, revoked_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_auth_agent_tokens_owner_agent
      ON auth_agent_tokens(owner_user, agent_id, disabled_at, revoked_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_auth_agent_access_grants_grantee
      ON auth_agent_access_grants(grantee_user, disabled_at, revoked_at, agent_id);
  `);
  ensureUniqueActiveAgentTokenIndex();
}

function ensureUniqueActiveAgentTokenIndex() {
  const duplicate = db.prepare(`
    SELECT agent_id AS agentId, COUNT(*) AS count
    FROM auth_agent_tokens
    WHERE agent_id <> ''
      AND disabled_at = ''
      AND revoked_at = ''
    GROUP BY agent_id
    HAVING COUNT(*) > 1
    LIMIT 1
  `).get();
  if (duplicate) {
    console.warn(`Skipping active agent token uniqueness index because ${duplicate.agentId} has duplicate active tokens.`);
    return;
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_agent_tokens_active_agent_unique
      ON auth_agent_tokens(agent_id)
      WHERE agent_id <> '' AND disabled_at = '' AND revoked_at = '';
  `);
}

function listManagedUserRows() {
  return db.prepare(`
    SELECT username, display_name AS displayName, role, password_sha256 AS passwordSha256,
           disabled_at AS disabledAt, session_revoked_before AS sessionRevokedBefore,
           created_at AS createdAt, updated_at AS updatedAt
    FROM auth_users
    ORDER BY username ASC
  `).all().map((row) => ({ ...row, username: normalizeUsername(row.username) }));
}

function getManagedUserRow(username) {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT username, display_name AS displayName, role, password_sha256 AS passwordSha256,
           disabled_at AS disabledAt, session_revoked_before AS sessionRevokedBefore,
           created_at AS createdAt, updated_at AS updatedAt
    FROM auth_users
    WHERE username = ?
  `).get(normalized);
  return row ? { ...row, username: normalized } : null;
}

function getAdminUser(username) {
  const row = getManagedUserRow(username);
  if (!row) return null;
  return {
    username: row.username,
    displayName: row.displayName || row.username,
    role: row.role || "user",
    disabledAt: row.disabledAt || "",
    sessionRevokedBefore: row.sessionRevokedBefore || "",
    source: "db",
    quotaBytes: getStorageQuotaBytes(row.username)
  };
}

function ensureManagedUserShell(username) {
  const normalized = normalizeUsername(username);
  if (getManagedUserRow(normalized)) return;
  const now = nowIso();
  db.prepare(`
    INSERT INTO auth_users (username, display_name, role, password_sha256, created_at, updated_at)
    VALUES (@username, @displayName, 'user', '', @now, @now)
  `).run({ username: normalized, displayName: normalized, now });
}

function normalizeMergedUser(configUser = {}, managedRow = null, source = "db") {
  const username = normalizeUsername(managedRow?.username || configUser.username);
  const configPasswordSha256 = normalizePasswordHash(configUser.passwordSha256);
  return {
    username,
    password: String(configUser.password || ""),
    passwordSha256: managedRow?.passwordSha256 || configPasswordSha256,
    displayName: managedRow?.displayName || configUser.displayName || username,
    role: normalizeRole(managedRow?.role || configUser.role || "user"),
    disabledAt: managedRow?.disabledAt || "",
    sessionRevokedBefore: managedRow?.sessionRevokedBefore || "",
    source: managedRow ? (source === "config" ? "config+db" : "db") : "config"
  };
}

function getPairingToken(id) {
  return listPairingTokens().find((item) => item.id === String(id || "")) || null;
}

function getAgentToken(id) {
  return listAgentTokens().find((item) => item.id === String(id || "")) || null;
}

function findActiveAgentTokenForAgent(agentId) {
  const normalized = normalizeAgentId(agentId);
  if (!normalized) return null;
  return db.prepare(`
    SELECT id, owner_user AS ownerUser, agent_id AS agentId
    FROM auth_agent_tokens
    WHERE agent_id = @agentId
      AND disabled_at = ''
      AND revoked_at = ''
    ORDER BY created_at ASC
    LIMIT 1
  `).get({ agentId: normalized }) || null;
}

function getAgentAccessGrant({ agentId, ownerUser, granteeUser } = {}) {
  return db.prepare(`
    SELECT id, agent_id AS agentId, owner_user AS ownerUser, grantee_user AS granteeUser,
           created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt,
           disabled_at AS disabledAt, revoked_at AS revokedAt
    FROM auth_agent_access_grants
    WHERE agent_id = @agentId
      AND owner_user = @ownerUser
      AND grantee_user = @granteeUser
    LIMIT 1
  `).get({
    agentId: normalizeAgentId(agentId),
    ownerUser: normalizeUsername(ownerUser),
    granteeUser: normalizeUsername(granteeUser)
  }) || null;
}

function tokenHashForConfigEntry(entry = {}) {
  return normalizePasswordHash(entry.tokenSha256 || entry.token_hash || entry.tokenHash) || sha256(entry.token || "");
}

function tokenAllowedForUser(ownerUser, user = null) {
  const owner = normalizeUsername(ownerUser);
  if (!owner) return true;
  if (!user) return false;
  if (String(user.role || "").toLowerCase() === "owner") return true;
  return owner === normalizeUsername(user.username || user.displayName);
}

function touchToken(table, id) {
  db.prepare(`
    UPDATE ${table}
    SET last_used_at = @now,
        updated_at = @now
    WHERE id = @id
  `).run({ id, now: nowIso() });
}

function generateToken(prefix) {
  return `${prefix}_${crypto.randomBytes(managedTokenBytes).toString("base64url")}`;
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase() === "owner" ? "owner" : "user";
}

function normalizeAgentId(value) {
  return String(value || "").trim().slice(0, 120);
}

function normalizePasswordHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  const length = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const leftPadded = Buffer.alloc(length);
  const rightPadded = Buffer.alloc(length);
  leftBuffer.copy(leftPadded);
  rightBuffer.copy(rightPadded);
  return crypto.timingSafeEqual(leftPadded, rightPadded) && leftBuffer.length === rightBuffer.length;
}

function badRequest(message) {
  throwHttpError(400, message);
}

function conflict(message) {
  throwHttpError(409, message);
}

function isSqliteUniqueConstraintError(error) {
  return error?.code === "SQLITE_CONSTRAINT_UNIQUE" || String(error?.message || "").includes("UNIQUE constraint failed");
}

function throwHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function nowIso() {
  return new Date().toISOString();
}
