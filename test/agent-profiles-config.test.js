import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const configModuleUrl = pathToFileURL(path.resolve("src/config.js")).href;

test("worktree runtime config accepts fixed profiles and controlled cache paths", async () => {
  const { parseWorktreeRuntimeConfig } = await import(`${configModuleUrl}?worktree-runtime=parse`);
  const parsed = parseWorktreeRuntimeConfig(JSON.stringify({
    demo: {
      setupProfiles: [{ id: "install", label: "Install", command: "pnpm", args: ["install", "--frozen-lockfile"] }],
      cacheEnv: { npm_config_cache: "~/.cache/npm", "bad-key": "/tmp/no" },
      extraSetupKeyFiles: ["toolchain.json", "../secret"],
      warmPool: { maxCount: 9, ttlHours: 0, setupProfileId: "missing" }
    }
  }));

  assert.equal(parsed.demo.setupProfiles[0].id, "install");
  assert.deepEqual(parsed.demo.setupProfiles[0].args, ["install", "--frozen-lockfile"]);
  assert.deepEqual(parsed.demo.extraSetupKeyFiles, ["toolchain.json"]);
  assert.equal(parsed.demo.cacheEnv.npm_config_cache, path.join(os.homedir(), ".cache", "npm"));
  assert.equal(parsed.demo.cacheEnv["bad-key"], undefined);
  assert.equal(parsed.demo.warmPool.maxCount, 4);
  assert.equal(parsed.demo.warmPool.ttlHours, 1);
  assert.equal(parsed.demo.warmPool.setupProfileId, "install");
});

test("desktop agent profiles parse scoped owner, token, agent, workspace, and env overrides", async () => {
  const { parseAgentProfiles } = await import(`${configModuleUrl}?agent-profiles=parse`);
  process.env.HUAHUA_ECHO_AGENT_TOKEN = "eat_huahua";
  try {
    const profiles = parseAgentProfiles(
      JSON.stringify([
        {
          username: "huahua",
          agentId: "huahua-mac",
          tokenEnv: "HUAHUA_ECHO_AGENT_TOKEN",
          displayName: "Huahua Mac",
          workspaces: { garden: { path: "~/workspace/garden" } },
          env: {
            CODEX_HOME: "~/codex-huahua",
            "bad-key": "ignored"
          }
        }
      ])
    );

    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].username, "huahua");
    assert.equal(profiles[0].agentId, "huahua-mac");
    assert.equal(profiles[0].token, "eat_huahua");
    assert.equal(profiles[0].displayName, "Huahua Mac");
    assert.equal(profiles[0].workspacesText, "garden=~/workspace/garden");
    assert.deepEqual(profiles[0].workspaces, [
      {
        id: "garden",
        label: "garden",
        path: path.join(os.homedir(), "workspace", "garden")
      }
    ]);
    assert.deepEqual(profiles[0].env, { CODEX_HOME: "~/codex-huahua" });
  } finally {
    delete process.env.HUAHUA_ECHO_AGENT_TOKEN;
  }
});

test("desktop agent profiles reject incomplete entries and duplicate agent ids", async () => {
  const { parseAgentProfiles } = await import(`${configModuleUrl}?agent-profiles=reject`);
  const profiles = parseAgentProfiles(
    JSON.stringify([
      { username: "alice", agentId: "shared", token: "eat_a", workspaces: "a=/tmp/a" },
      { username: "bob", agentId: "shared", token: "eat_b", workspaces: "b=/tmp/b" },
      { username: "charlie", agentId: "missing-token", workspaces: "c=/tmp/c" },
      { username: "dana", agentId: "missing-workspaces", token: "eat_d" }
    ])
  );

  assert.deepEqual(
    profiles.map((profile) => profile.agentId),
    ["shared"]
  );
});

test("configured agent tokens reject incomplete entries and duplicate agent ids", async () => {
  const originalTokensJson = process.env.ECHO_AGENT_TOKENS_JSON;
  const originalAgentToken = process.env.ECHO_AGENT_TOKEN;
  const originalEchoToken = process.env.ECHO_TOKEN;
  const originalAgentId = process.env.ECHO_AGENT_ID;
  process.env.ECHO_AGENT_TOKENS_JSON = JSON.stringify([
    { token: "eat_a", ownerUsername: "alice", agentId: "shared" },
    { token: "eat_b", ownerUsername: "alice", agentId: "shared" },
    { token: "eat_missing", ownerUsername: "alice" }
  ]);
  process.env.ECHO_AGENT_TOKEN = "";
  process.env.ECHO_TOKEN = "";
  process.env.ECHO_AGENT_ID = "";
  try {
    const { config } = await import(`${configModuleUrl}?agent-tokens=reject-${Date.now()}`);
    assert.deepEqual(
      config.auth.agentTokens.map((token) => token.agentId),
      ["shared"]
    );
  } finally {
    if (originalTokensJson === undefined) delete process.env.ECHO_AGENT_TOKENS_JSON;
    else process.env.ECHO_AGENT_TOKENS_JSON = originalTokensJson;
    if (originalAgentToken === undefined) delete process.env.ECHO_AGENT_TOKEN;
    else process.env.ECHO_AGENT_TOKEN = originalAgentToken;
    if (originalEchoToken === undefined) delete process.env.ECHO_TOKEN;
    else process.env.ECHO_TOKEN = originalEchoToken;
    if (originalAgentId === undefined) delete process.env.ECHO_AGENT_ID;
    else process.env.ECHO_AGENT_ID = originalAgentId;
  }
});

test("legacy env agent token is scoped to the single configured user", async () => {
  const names = [
    "ECHO_USERS_JSON",
    "ECHO_AUTH_USERNAME",
    "ECHO_AUTH_PASSWORD",
    "ECHO_AUTH_PASSWORD_SHA256",
    "ECHO_AUTH_DISPLAY_NAME",
    "ECHO_AUTH_ROLE",
    "ECHO_AGENT_TOKENS_JSON",
    "ECHO_AGENT_TOKEN",
    "ECHO_AGENT_TOKEN_SHA256",
    "ECHO_AGENT_OWNER_USERNAME",
    "ECHO_AGENT_ID",
    "ECHO_AGENT_DISPLAY_NAME",
    "ECHO_TOKEN",
    "ECHO_TOKEN_SHA256"
  ];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  process.env.ECHO_USERS_JSON = JSON.stringify([{ username: "alice", password: "secret", role: "user" }]);
  process.env.ECHO_AUTH_USERNAME = "";
  process.env.ECHO_AUTH_PASSWORD = "";
  process.env.ECHO_AUTH_PASSWORD_SHA256 = "";
  process.env.ECHO_AUTH_DISPLAY_NAME = "";
  process.env.ECHO_AUTH_ROLE = "";
  process.env.ECHO_AGENT_TOKENS_JSON = "";
  process.env.ECHO_AGENT_TOKEN = "legacy-agent-token";
  process.env.ECHO_AGENT_TOKEN_SHA256 = "";
  process.env.ECHO_AGENT_OWNER_USERNAME = "";
  process.env.ECHO_AGENT_ID = "";
  process.env.ECHO_AGENT_DISPLAY_NAME = "";
  process.env.ECHO_TOKEN = "";
  process.env.ECHO_TOKEN_SHA256 = "";

  try {
    const { config } = await import(`${configModuleUrl}?agent-token-single-owner-${Date.now()}`);
    assert.equal(config.auth.agentTokens.length, 1);
    assert.equal(config.auth.agentTokens[0].ownerUsername, "alice");
    assert.equal(config.auth.agentTokens[0].agentId, "");
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
