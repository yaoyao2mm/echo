import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "echo-auth-store-test-"));
process.env.HOME = tempHome;
process.env.ECHO_TOKEN = "auth-store-bootstrap";
process.env.ECHO_USER_STORAGE_QUOTA_BYTES = "4096";

const authStore = await import("../src/lib/authStore.js");
const db = new Database(path.join(tempHome, ".echo-voice", "echo.sqlite"));

test.after(() => {
  db.close();
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test("pairing tokens are hash-only and scoped to owner users", () => {
  authStore.resetAuthStoreForTest();

  const created = authStore.createPairingToken({
    ownerUsername: "alice",
    label: "Alice iPhone",
    createdBy: "owner"
  });

  assert.match(created.token, /^ept_/);
  assert.equal(created.item.ownerUser, "alice");
  assert.equal(Object.hasOwn(created.item, "token"), false);

  const row = db.prepare("SELECT token_hash AS tokenHash FROM auth_pairing_tokens WHERE id = ?").get(created.item.id);
  assert.equal(row.tokenHash.length, 64);
  assert.notEqual(row.tokenHash, created.token);

  assert.equal(authStore.verifyPairingToken({ token: created.token, user: { username: "alice", role: "user" } })?.ownerUser, "alice");
  assert.equal(authStore.verifyPairingToken({ token: created.token, user: { username: "bob", role: "user" } }), null);
  assert.equal(authStore.verifyPairingToken({ token: created.token, user: { username: "owner", role: "owner" } })?.ownerUser, "alice");

  authStore.revokePairingToken(created.item.id);
  assert.equal(authStore.verifyPairingToken({ token: created.token, user: { username: "alice", role: "user" } }), null);
});

test("agent tokens are stored hashed and can be disabled independently", () => {
  authStore.resetAuthStoreForTest();

  const created = authStore.createAgentToken({
    ownerUsername: "alice",
    agentId: "alice-mac",
    displayName: "Alice Mac",
    createdBy: "owner"
  });

  assert.match(created.token, /^eat_/);
  assert.equal(Object.hasOwn(created.item, "token"), false);
  assert.equal(authStore.verifyAgentToken({ token: created.token })?.agentId, "alice-mac");

  authStore.setAgentTokenDisabled(created.item.id, true);
  assert.equal(authStore.verifyAgentToken({ token: created.token }), null);
  authStore.setAgentTokenDisabled(created.item.id, false);
  assert.equal(authStore.verifyAgentToken({ token: created.token })?.ownerUsername, "alice");
});

test("managed agent tokens require a unique desktop environment id", () => {
  authStore.resetAuthStoreForTest();

  assert.throws(
    () =>
      authStore.createAgentToken({
        ownerUsername: "alice",
        displayName: "Alice Mac",
        createdBy: "owner"
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Agent ID is required/);
      return true;
    }
  );

  authStore.createAgentToken({
    ownerUsername: "alice",
    agentId: "shared-mac",
    displayName: "Alice Mac",
    createdBy: "owner"
  });

  assert.throws(
    () =>
      authStore.createAgentToken({
        ownerUsername: "alice",
        agentId: "shared-mac",
        displayName: "Alice second token",
        createdBy: "owner"
      }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Agent ID is already in use/);
      return true;
    }
  );
});

test("managed users, session revocation, and quotas merge with config users", () => {
  authStore.resetAuthStoreForTest();

  const user = authStore.upsertManagedUser({
    username: "friend",
    displayName: "Friend",
    password: "secret",
    role: "user",
    quotaBytes: 2048
  });
  assert.equal(user.username, "friend");
  assert.equal(authStore.findAuthUser("friend", [])?.displayName, "Friend");
  assert.equal(authStore.getStorageQuotaBytes("friend"), 2048);

  authStore.revokeUserSessions("friend");
  assert.equal(authStore.getUserSessionNotBeforeMs("friend") > 0, true);

  authStore.setUserDisabled("friend", true);
  assert.equal(authStore.findAuthUser("friend", []), null);

  const configUsers = [{ username: "owner", passwordSha256: "a".repeat(64), role: "owner", displayName: "Owner" }];
  authStore.setStorageQuota("owner", 1024);
  assert.equal(authStore.listAdminUsers(configUsers).find((item) => item.username === "owner")?.quotaBytes, 1024);
});
