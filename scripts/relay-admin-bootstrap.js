#!/usr/bin/env node
import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../src/config.js";
import { normalizeUsername, upsertManagedUser } from "../src/lib/authStore.js";

const rawConfig = String(process.env.ECHO_ADMIN_BOOTSTRAP_JSON || "").trim();
if (!rawConfig) process.exit(0);

let input = {};
try {
  input = JSON.parse(rawConfig);
} catch (error) {
  console.error(`Could not parse ECHO_ADMIN_BOOTSTRAP_JSON: ${error.message}`);
  process.exit(1);
}

const db = new Database(path.join(config.dataDir, "echo.sqlite"));

let userCount = 0;
let pairingTokenCount = 0;
let agentTokenCount = 0;

for (const user of asArray(input.users || input.user)) {
  const updated = upsertManagedUser({
    username: user.username,
    displayName: user.displayName || user.display_name,
    role: user.role || "user",
    password: user.password,
    passwordSha256: user.passwordSha256 || user.password_sha256,
    quotaBytes: user.quotaBytes
  });
  if (updated?.username) userCount += 1;
}

for (const token of asArray(input.pairingTokens || input.pairing_tokens || input.pairingToken)) {
  if (upsertPairingToken(token)) pairingTokenCount += 1;
}

for (const token of asArray(input.agentTokens || input.agent_tokens || input.agentToken)) {
  if (upsertAgentToken(token)) agentTokenCount += 1;
}

console.log(
  `Admin bootstrap applied: users=${userCount}, pairingTokens=${pairingTokenCount}, agentTokens=${agentTokenCount}`
);

function upsertPairingToken(inputToken = {}) {
  const ownerUser = normalizeUsername(inputToken.ownerUsername || inputToken.ownerUser || inputToken.username);
  const tokenHash = normalizeHash(inputToken.tokenSha256 || inputToken.token_hash || inputToken.tokenHash);
  if (!ownerUser || !tokenHash) return false;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO auth_pairing_tokens (
      id, owner_user, label, token_hash, created_by, created_at, updated_at
    ) VALUES (
      @id, @ownerUser, @label, @tokenHash, @createdBy, @now, @now
    )
    ON CONFLICT(token_hash) DO UPDATE SET
      owner_user = excluded.owner_user,
      label = excluded.label,
      created_by = CASE WHEN excluded.created_by <> '' THEN excluded.created_by ELSE auth_pairing_tokens.created_by END,
      disabled_at = '',
      revoked_at = '',
      updated_at = excluded.updated_at
  `).run({
    id: crypto.randomUUID(),
    ownerUser,
    label: String(inputToken.label || inputToken.displayName || inputToken.display_name || "Phone").trim().slice(0, 120) || "Phone",
    tokenHash,
    createdBy: normalizeUsername(inputToken.createdBy || inputToken.created_by),
    now
  });
  return true;
}

function upsertAgentToken(inputToken = {}) {
  const ownerUser = normalizeUsername(inputToken.ownerUsername || inputToken.ownerUser || inputToken.username);
  const tokenHash = normalizeHash(inputToken.tokenSha256 || inputToken.token_hash || inputToken.tokenHash);
  if (!ownerUser || !tokenHash) return false;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO auth_agent_tokens (
      id, owner_user, agent_id, display_name, label, token_hash, created_by, created_at, updated_at
    ) VALUES (
      @id, @ownerUser, @agentId, @displayName, @label, @tokenHash, @createdBy, @now, @now
    )
    ON CONFLICT(token_hash) DO UPDATE SET
      owner_user = excluded.owner_user,
      agent_id = excluded.agent_id,
      display_name = excluded.display_name,
      label = excluded.label,
      created_by = CASE WHEN excluded.created_by <> '' THEN excluded.created_by ELSE auth_agent_tokens.created_by END,
      disabled_at = '',
      revoked_at = '',
      updated_at = excluded.updated_at
  `).run({
    id: crypto.randomUUID(),
    ownerUser,
    agentId: String(inputToken.agentId || inputToken.agent_id || "").trim().slice(0, 120),
    displayName: String(inputToken.displayName || inputToken.display_name || inputToken.label || "").trim().slice(0, 120),
    label: String(inputToken.label || inputToken.displayName || inputToken.display_name || inputToken.agentId || "Desktop Agent").trim().slice(0, 120) || "Desktop Agent",
    tokenHash,
    createdBy: normalizeUsername(inputToken.createdBy || inputToken.created_by),
    now
  });
  return true;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}
