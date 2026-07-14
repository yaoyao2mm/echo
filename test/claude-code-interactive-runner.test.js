import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deepSeekClaudeDefaultModel, deepSeekClaudeFastModel } from "../src/lib/deepSeekClaude.js";

test("ClaudeCodeInteractiveRuntime streams assistant output and records a resumable session id", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-claude-runtime-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeClaudePath = path.join(tempRoot, "fake-claude");
  const recordPath = path.join(tempRoot, "claude-args.json");

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeClaudePath,
    `#!/usr/bin/env node
import fs from "node:fs";

	const args = process.argv.slice(2);
	const sessionIndex = args.indexOf("--session-id");
	const resumeIndex = args.indexOf("--resume");
	const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : resumeIndex >= 0 ? args[resumeIndex + 1] : "missing";
	fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, sessionId, cwd: process.cwd() }), "utf8");
	process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
	process.stdout.write(JSON.stringify({ type: "stream_event", delta: { text: "Hello " } }) + "\\n");
	process.stdout.write(JSON.stringify({
	  type: "result",
	  result: "Hello Claude",
	  usage: {
	    input_tokens: 11,
	    cache_read_input_tokens: 2,
	    output_tokens: 5,
	    model_context_window: 200000
	  }
	}) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeClaudePath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
process.env.ECHO_CLAUDE_ENABLED = "true";
process.env.ECHO_CLAUDE_COMMAND = ${JSON.stringify(fakeClaudePath)};

const { ClaudeCodeInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/claudeCodeInteractiveRunner.js"))});

const events = [];
const runtime = new ClaudeCodeInteractiveRuntime({
  onEvents: async (_sessionId, nextEvents) => {
    events.push(...nextEvents);
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-1",
    type: "start",
    projectId: "demo",
    payload: { prompt: "Summarize the current backend.", attachments: [] },
    runtime: {
      backendId: "claude-code",
      provider: "deepseek-via-claude",
      backendName: "Claude Code",
      command: ${JSON.stringify(fakeClaudePath)},
      permissionMode: "strict",
      model: "deepseek-v4-flash"
    }
  });
  const recorded = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, recorded.sessionId);
  assert.equal(recorded.args.includes("--session-id"), true);
  assert.equal(recorded.args.includes("--verbose"), true);
  assert.equal(recorded.args.includes("--permission-mode"), true);
  assert.equal(recorded.args.includes("plan"), true);
  assert.equal(events.some((event) => event.raw?.method === "item/agentMessage/delta" && event.text === "Hello "), true);
  const usageEvent = events.find((event) => event.type === "context.usage.updated");
  assert.ok(usageEvent);
  assert.equal(usageEvent.raw?.source, "claude-code");
  assert.equal(usageEvent.raw?.params?.source, "claude-code");
  assert.equal(usageEvent.raw?.params?.usage?.inputTokens, 11);
  assert.equal(usageEvent.raw?.params?.usage?.cachedInputTokens, 2);
  assert.equal(usageEvent.raw?.params?.usage?.outputTokens, 5);
  assert.equal(usageEvent.raw?.params?.usage?.totalTokens, 18);
  assert.equal(usageEvent.raw?.params?.usage?.modelContextWindow, 200000);
  assert.equal(events.some((event) => event.raw?.method === "item/completed" && event.finalMessage === "Hello Claude"), true);
  assert.equal(events.some((event) => event.raw?.method === "turn/completed"), true);
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("ClaudeCodeInteractiveRuntime honors stop requests that arrive before a turn is registered", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-claude-early-stop-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeClaudePath = path.join(tempRoot, "fake-claude");
  const recordPath = path.join(tempRoot, "fake-claude-started.json");

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeClaudePath,
    `#!/usr/bin/env node
import fs from "node:fs";

fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }), "utf8");
process.stdout.write(JSON.stringify({ type: "result", result: "This turn should not start." }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeClaudePath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
process.env.ECHO_CLAUDE_ENABLED = "true";
process.env.ECHO_CLAUDE_COMMAND = ${JSON.stringify(fakeClaudePath)};

const { ClaudeCodeInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/claudeCodeInteractiveRunner.js"))});

const events = [];
let stopResult = null;
const runtime = new ClaudeCodeInteractiveRuntime({
  onEvents: async (_sessionId, nextEvents) => {
    events.push(...nextEvents);
    const started = nextEvents.find((event) => event.type === "thread.started");
    if (started && !stopResult) {
      stopResult = await runtime.handleCommand({
        sessionId: "session-early-stop",
        type: "stop",
        projectId: "demo",
        appThreadId: started.appThreadId,
        payload: { reason: "Stopped immediately from mobile." },
        runtime: {
          backendId: "claude-code",
          provider: "claude-code",
          backendName: "Claude Code",
          command: ${JSON.stringify(fakeClaudePath)},
          permissionMode: "approve"
        }
      });
    }
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-early-stop",
    type: "start",
    projectId: "demo",
    payload: { prompt: "Start and then stop immediately.", attachments: [] },
    runtime: {
      backendId: "claude-code",
      provider: "claude-code",
      backendName: "Claude Code",
      command: ${JSON.stringify(fakeClaudePath)},
      permissionMode: "approve"
    }
  });

  assert.equal(stopResult?.ok, true);
  assert.equal(result.ok, true);
  assert.equal(result.sessionStatus, "active");
  assert.equal(fs.existsSync(${JSON.stringify(recordPath)}), false);
  assert.equal(events.some((event) => event.type === "turn.interrupted"), true);
  assert.equal(events.some((event) => event.raw?.method === "turn/completed"), false);
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script,
    timeout: 5000
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("ClaudeCodeInteractiveRuntime rebuilds context from Echo memory when native resume fails", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-claude-recovery-runtime-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeClaudePath = path.join(tempRoot, "fake-claude");
  const recordPath = path.join(tempRoot, "claude-recovery-records.json");

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeClaudePath,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session-id");
const resumeIndex = args.indexOf("--resume");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : resumeIndex >= 0 ? args[resumeIndex + 1] : "missing";
const records = fs.existsSync(${JSON.stringify(recordPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8")) : [];
records.push({
  args,
  sessionId,
  resume: resumeIndex >= 0,
  prompt: args.at(-1) || "",
  cwd: process.cwd()
});
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(records), "utf8");

if (resumeIndex >= 0) {
  process.stderr.write("native session not found\\n");
  process.exit(2);
}

process.stdout.write(JSON.stringify({ type: "result", result: "Recovered OK" }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeClaudePath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
process.env.ECHO_CLAUDE_ENABLED = "true";
process.env.ECHO_CLAUDE_COMMAND = ${JSON.stringify(fakeClaudePath)};

const { ClaudeCodeInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/claudeCodeInteractiveRunner.js"))});

const events = [];
const runtime = new ClaudeCodeInteractiveRuntime({
  onEvents: async (_sessionId, nextEvents) => {
    events.push(...nextEvents);
  }
});

try {
  const started = await runtime.handleCommand({
    sessionId: "session-recovery",
    type: "start",
    projectId: "demo",
    payload: { prompt: "Start the session.", attachments: [] },
    runtime: {
      backendId: "claude-code",
      provider: "claude-code",
      backendName: "Claude Code",
      command: ${JSON.stringify(fakeClaudePath)},
      permissionMode: "approve"
    }
  });

  await runtime.handleCommand({
    sessionId: "session-recovery",
    type: "message",
    projectId: "demo",
    appThreadId: started.appThreadId,
    payload: {
      text: "Continue with the recovery fix.",
      attachments: [],
      history: [
        { role: "user", text: "把 Claude Code 适配做完" },
        { role: "assistant", text: "已完成上下文用量和压缩能力 gating。" }
      ],
      recoveryContext: {
        source: "echo-session-memory",
        summary: "Goal: 把 Claude Code 适配做完\\nLatest agent result: 已完成上下文用量和压缩能力 gating。",
        sourceSessionId: "session-recovery",
        memoryUpdatedAt: "2026-05-08T00:00:00.000Z",
        historyMessageCount: 2
      }
    },
    runtime: {
      backendId: "claude-code",
      provider: "claude-code",
      backendName: "Claude Code",
      command: ${JSON.stringify(fakeClaudePath)},
      permissionMode: "approve"
    }
  });

  const records = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(records.length, 3);
  assert.equal(records[1].resume, true);
  assert.equal(records[2].resume, false);
  assert.match(records[2].prompt, /Echo session summary/);
  assert.match(records[2].prompt, /把 Claude Code 适配做完/);
  assert.match(records[2].prompt, /上下文用量和压缩能力 gating/);
  assert.match(records[2].prompt, /Current user message:\\nContinue with the recovery fix/);

  const recovered = events.find((event) => event.type === "thread.recovered");
  assert.ok(recovered);
  assert.equal(recovered.raw?.recovery?.strategy, "echo-memory-rebuild");
  assert.equal(recovered.raw?.recovery?.source, "echo-session-memory");
  assert.equal(recovered.raw?.recovery?.summaryIncluded, true);
  assert.equal(recovered.raw?.recovery?.historyMessageCount, 2);
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("ClaudeCodeInteractiveRuntime writes an isolated Claude config for configured providers", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-claude-provider-runtime-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeClaudePath = path.join(tempRoot, "fake-claude");
  const recordPath = path.join(tempRoot, "claude-env.json");

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeClaudePath,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  args,
  cwd: process.cwd(),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || "",
  baseUrl: process.env.ANTHROPIC_BASE_URL || "",
  model: process.env.ANTHROPIC_MODEL || "",
  authTokenPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
  apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY)
}), "utf8");
process.stdout.write(JSON.stringify({ type: "result", result: "OK" }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeClaudePath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.HOME = ${JSON.stringify(homePath)};
fs.mkdirSync(path.join(process.env.HOME, ".claude"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.HOME, ".claude", "settings.json"),
  JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_MODEL: "deepseek-v4-flash" } }),
  "utf8"
);
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
process.env.ECHO_CLAUDE_COMMAND = "";
process.env.ECHO_CLAUDE_BASE_URL = "";
process.env.ECHO_CLAUDE_AUTH_TOKEN = "";
process.env.ECHO_CLAUDE_MODEL = "";
process.env.ECHO_CLAUDE_SUPPORTED_MODELS = "";
process.env.ECHO_CLAUDE_PERMISSION_MODE = "";
process.env.ECHO_CLAUDE_PROFILE = "";
process.env.ECHO_CLAUDE_ALLOWED_PERMISSION_MODES = "";
process.env.ECHO_CLAUDE_REASONING_EFFORT = "";
process.env.ECHO_CLAUDE_APPROVAL_TIMEOUT_MS = "";
process.env.ECHO_CLAUDE_TIMEOUT_MS = "";
process.env.ECHO_CLAUDE_WORKTREE_MODE = "";
process.env.ECHO_CLAUDE_SUBAGENT_MODEL = "";
process.env.ECHO_CLAUDE_AGENT_TEAMS_ENABLED = "";
process.env.ANTHROPIC_BASE_URL = "";
process.env.ANTHROPIC_AUTH_TOKEN = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.CLAUDE_CONFIG_DIR = path.join(process.env.HOME, ".claude");
process.env.ECHO_VOLCENGINE_CODING_ENABLED = "true";
process.env.ECHO_VOLCENGINE_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding";
process.env.ECHO_VOLCENGINE_CODING_API_KEY = "test-token";
process.env.ECHO_VOLCENGINE_CODING_MODEL = "ark-code-latest";
process.env.ECHO_VOLCENGINE_CODING_SUBAGENT_MODEL = "doubao-seed-2.0-pro";
process.env.ECHO_VOLCENGINE_CODING_COMMAND = ${JSON.stringify(fakeClaudePath)};

const { ClaudeCodeInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/claudeCodeInteractiveRunner.js"))});

const runtime = new ClaudeCodeInteractiveRuntime({
  onEvents: async () => {}
});

try {
  await runtime.handleCommand({
    sessionId: "session-provider",
    type: "start",
    projectId: "demo",
    payload: { prompt: "Say OK.", attachments: [] },
    runtime: {
      backendId: "claude-code",
      provider: "volcengine-coding-plan",
      backendName: "Claude Code",
      command: ${JSON.stringify(fakeClaudePath)},
      permissionMode: "strict",
      model: "doubao-seed-2.0-code"
    }
  });

  const recorded = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(recorded.baseUrl, "https://ark.cn-beijing.volces.com/api/coding");
  assert.equal(recorded.model, "doubao-seed-2.0-code");
  assert.equal(recorded.authTokenPresent, true);
  assert.equal(recorded.apiKeyPresent, true);
  assert.notEqual(recorded.claudeConfigDir, path.join(process.env.HOME, ".claude"));
  assert.match(recorded.claudeConfigDir, /\\.echo-voice\\/claude-configs\\//);

  const settingsPath = path.join(recorded.claudeConfigDir, "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://ark.cn-beijing.volces.com/api/coding");
  assert.equal(settings.env.ANTHROPIC_MODEL, "doubao-seed-2.0-code");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "doubao-seed-2.0-code");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(Boolean(settings.env.ANTHROPIC_AUTH_TOKEN), true);
  assert.equal(Boolean(settings.env.ANTHROPIC_API_KEY), true);
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "doubao-seed-2.0-pro");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(recorded.claudeConfigDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  }
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("ClaudeCodeInteractiveRuntime writes DeepSeek Claude Code provider defaults", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-claude-deepseek-runtime-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeClaudePath = path.join(tempRoot, "fake-claude");
  const recordPath = path.join(tempRoot, "claude-deepseek-env.json");

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeClaudePath,
    `#!/usr/bin/env node
import fs from "node:fs";

const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  args,
  baseUrl: process.env.ANTHROPIC_BASE_URL || "",
  model: process.env.ANTHROPIC_MODEL || "",
  sonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || "",
  opusModel: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL || "",
  haikuModel: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "",
  subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL || "",
  effortLevel: process.env.CLAUDE_CODE_EFFORT_LEVEL || "",
  disableFallback: process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK || "",
  sonnetCapabilities: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES || ""
}), "utf8");
process.stdout.write(JSON.stringify({ type: "result", result: "OK" }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeClaudePath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
process.env.ECHO_CLAUDE_ENABLED = "true";
process.env.ECHO_CLAUDE_COMMAND = ${JSON.stringify(fakeClaudePath)};
process.env.ECHO_CLAUDE_BASE_URL = "https://api.deepseek.com/anthropic";
process.env.ECHO_CLAUDE_AUTH_TOKEN = "deepseek-token";
process.env.ECHO_CLAUDE_MODEL = "";
process.env.ECHO_CLAUDE_REASONING_EFFORT = "";

const { ClaudeCodeInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/claudeCodeInteractiveRunner.js"))});

const runtime = new ClaudeCodeInteractiveRuntime({
  onEvents: async () => {}
});

try {
  await runtime.handleCommand({
    sessionId: "session-deepseek-provider",
    type: "start",
    projectId: "demo",
    payload: { prompt: "Say OK.", attachments: [] },
    runtime: {
      backendId: "claude-code",
      provider: "deepseek-via-claude",
      backendName: "Claude Code",
      command: ${JSON.stringify(fakeClaudePath)},
      permissionMode: "full",
      reasoningEffort: "xhigh"
    }
  });

  const recorded = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(recorded.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(recorded.model, ${JSON.stringify(deepSeekClaudeDefaultModel)});
  assert.equal(recorded.sonnetModel, ${JSON.stringify(deepSeekClaudeDefaultModel)});
  assert.equal(recorded.opusModel, ${JSON.stringify(deepSeekClaudeDefaultModel)});
  assert.equal(recorded.haikuModel, ${JSON.stringify(deepSeekClaudeFastModel)});
  assert.equal(recorded.subagentModel, ${JSON.stringify(deepSeekClaudeFastModel)});
  assert.equal(recorded.effortLevel, "max");
  assert.equal(recorded.disableFallback, "1");
  assert.equal(recorded.sonnetCapabilities.includes("max_effort"), true);
  assert.equal(recorded.args.includes("--model"), true);
  assert.equal(recorded.args.includes(${JSON.stringify(deepSeekClaudeDefaultModel)}), true);
  assert.equal(recorded.args.includes("--effort"), false);
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("ClaudeCodeInteractiveRuntime runs turns inside the prepared worktree execution path", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-claude-worktree-runtime-"));
  const workspacePath = path.join(tempRoot, "workspace");
  const worktreeRoot = path.join(tempRoot, "worktrees");
  const worktreePath = path.join(worktreeRoot, "demo", "session-worktree");
  const fakeClaudePath = path.join(tempRoot, "fake-claude");
  const recordPath = path.join(tempRoot, "claude-worktree-args.json");

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  initRepo(worktreePath);
  fs.writeFileSync(
    fakeClaudePath,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session-id");
const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : "missing";
fs.writeFileSync(path.join(process.cwd(), "CLAUDE.md"), "changed in worktree\\n", "utf8");
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, sessionId, cwd: process.cwd() }), "utf8");
process.stdout.write(JSON.stringify({ type: "result", result: "Updated from worktree" }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeClaudePath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.HOME = ${JSON.stringify(path.join(tempRoot, "home"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
process.env.ECHO_CODEX_WORKTREE_ROOT = ${JSON.stringify(worktreeRoot)};
process.env.ECHO_CLAUDE_ENABLED = "true";
process.env.ECHO_CLAUDE_COMMAND = ${JSON.stringify(fakeClaudePath)};

const { ClaudeCodeInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/claudeCodeInteractiveRunner.js"))});

const events = [];
const runtime = new ClaudeCodeInteractiveRuntime({
  onEvents: async (_sessionId, nextEvents) => {
    events.push(...nextEvents);
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-worktree",
    type: "start",
    projectId: "demo",
    execution: {
      mode: "worktree",
      path: ${JSON.stringify(worktreePath)},
      baseWorkspaceId: "demo",
      basePath: ${JSON.stringify(workspacePath)}
    },
    payload: { prompt: "Change files in the isolated worktree.", attachments: [] },
    runtime: {
      backendId: "claude-code",
      provider: "deepseek-via-claude",
      backendName: "Claude Code",
      command: ${JSON.stringify(fakeClaudePath)},
      permissionMode: "strict",
      model: "deepseek-v4-flash"
    }
  });
  const recorded = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(result.ok, true);
  assert.equal(recorded.cwd, fs.realpathSync(${JSON.stringify(worktreePath)}));
  assert.equal(fs.existsSync(path.join(${JSON.stringify(workspacePath)}, "CLAUDE.md")), false);
  assert.equal(fs.existsSync(path.join(${JSON.stringify(worktreePath)}, "CLAUDE.md")), true);
  assert.equal(
    events.some((event) =>
      event.type === "git.summary" &&
      event.raw?.gitSummary?.changedDuringTurn?.changedFiles?.includes("CLAUDE.md")
    ),
    true
  );
} finally {
  runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("Claude runtime can advertise full permission mode for bypass permissions", () => {
  const script = `
import assert from "node:assert/strict";

process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CLAUDE_ENABLED = "true";
process.env.ECHO_CLAUDE_COMMAND = "claude";
process.env.ECHO_CLAUDE_ALLOWED_PERMISSION_MODES = "strict,approve,full";
process.env.ECHO_CLAUDE_PERMISSION_MODE = "full";
process.env.ECHO_VOLCENGINE_CODING_ENABLED = "false";

const { publicClaudeRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/claudeCodeRunner.js"))});

const runtime = publicClaudeRuntime();
assert.equal(runtime.permissionMode, "full");
assert.equal(runtime.profile, "full");
assert.equal(runtime.sandbox, "danger-full-access");
assert.equal(runtime.approvalPolicy, "never");
assert.deepEqual(runtime.allowedPermissionModes, ["strict", "approve", "full"]);
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

function initRepo(repoPath) {
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# demo\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Echo Test", "-c", "user.email=echo@example.test", "commit", "-m", "init"], {
    cwd: repoPath,
    stdio: "ignore"
  });
}
