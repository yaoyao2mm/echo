import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("CodexInteractiveRuntime uses the resolved desktop command on macOS", () => {
  if (process.platform !== "darwin") return;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-command-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeShellDir = path.join(tempRoot, "bin");
  const fakeAppPath = path.join(tempRoot, "fake-codex-app");
  const fakeShellPath = path.join(fakeShellDir, "codex");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(fakeShellDir, { recursive: true });

  fs.writeFileSync(
    fakeAppPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_fake", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1 } } });
    return;
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeAppPath, 0o755);

  fs.writeFileSync(fakeShellPath, "#!/usr/bin/env bash\necho shell-codex-invoked >&2\nexit 97\n", "utf8");
  fs.chmodSync(fakeShellPath, 0o755);

const script = `
import assert from "node:assert/strict";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = "codex";
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeAppPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-1",
    type: "start",
    projectId: "demo",
    payload: { prompt: "", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(runtime.client.command, ${JSON.stringify(fakeAppPath)});
} finally {
  await runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script,
    env: {
      ...process.env,
      PATH: `${fakeShellDir}:${process.env.PATH || ""}`
    }
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("CodexInteractiveRuntime archives and restores native Codex threads", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-archive-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "archive-methods.jsonl");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const recordPath = ${JSON.stringify(recordPath)};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/archive") {
    fs.appendFileSync(recordPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
    send({ id: message.id, result: {} });
    send({ method: "thread/archived", params: { threadId: message.params.threadId } });
    return;
  }
  if (message.method === "thread/unarchive") {
    fs.appendFileSync(recordPath, JSON.stringify({ method: message.method, params: message.params }) + "\\n");
    send({ id: message.id, result: { thread: { id: message.params.threadId, sessionId: "sess", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, updatedAt: 2, status: "idle", turns: [] } } });
    send({ method: "thread/unarchived", params: { threadId: message.params.threadId } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
fs.mkdirSync(${JSON.stringify(path.join(homePath, ".codex"))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(path.join(homePath, ".codex", "config.toml"))}, 'model = "gpt-5.4"\\nmodel_reasoning_effort = "low"\\n', "utf8");

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const events = [];
const runtime = new CodexInteractiveRuntime({ onEvents: async (sessionId, incoming) => events.push(...incoming.map((event) => ({ ...event, sessionId }))) });
try {
  const archived = await runtime.handleCommand({
    sessionId: "session-archive",
    type: "archive",
    projectId: "demo",
    appThreadId: "thr_archive",
    payload: { archived: true },
    runtime: {}
  });
  const restored = await runtime.handleCommand({
    sessionId: "session-archive",
    type: "archive",
    projectId: "demo",
    appThreadId: "thr_archive",
    payload: { archived: false },
    runtime: {}
  });
  assert.equal(archived.ok, true);
  assert.equal(restored.ok, true);
  const calls = fs.readFileSync(${JSON.stringify(recordPath)}, "utf8").trim().split("\\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.method), ["thread/archive", "thread/unarchive"]);
  assert.deepEqual(calls.map((call) => call.params.threadId), ["thr_archive", "thr_archive"]);
  assert.equal(events.some((event) => event.type === "thread.archived"), true);
  assert.equal(events.some((event) => event.type === "thread.unarchived"), true);
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

test("CodexInteractiveRuntime sends native collaboration plan mode when available", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-plan-mode-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "turn-start.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "collaborationMode/list") {
    send({ id: message.id, result: { data: [{ name: "Plan", mode: "plan", reasoning_effort: "medium" }] } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_plan", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(message.params), "utf8");
    const turn = { id: "turn_plan", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
fs.mkdirSync(${JSON.stringify(path.join(homePath, ".codex"))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(path.join(homePath, ".codex", "config.toml"))}, 'model = "gpt-5.4"\\nmodel_reasoning_effort = "low"\\n', "utf8");

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-plan",
    type: "start",
    projectId: "demo",
    payload: { prompt: "先设计移动端交互", attachments: [], mode: "plan" },
    runtime: { model: "gpt-5.4", reasoningEffort: "low" }
  });
  assert.equal(result.ok, true);
  const params = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(params.input[0].text, "先设计移动端交互");
  assert.equal(params.input[0].text.includes("请先进入计划模式"), false);
  assert.equal(params.collaborationMode.mode, "plan");
  assert.equal(params.collaborationMode.settings.model, "gpt-5.4");
  assert.equal(params.collaborationMode.settings.reasoning_effort, "medium");
  assert.equal(params.collaborationMode.settings.developer_instructions, null);
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

test("CodexInteractiveRuntime applies relay-controlled retry model and effort overrides", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-retry-override-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "turn-start.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_retry_override", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(message.params), "utf8");
    const turn = { id: "turn_retry_override", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
fs.mkdirSync(${JSON.stringify(path.join(homePath, ".codex"))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(path.join(homePath, ".codex", "config.toml"))}, 'model = "gpt-5.4"\\nmodel_reasoning_effort = "high"\\n', "utf8");

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-retry-override",
    type: "start",
    projectId: "demo",
    payload: { prompt: "重试这一次", attachments: [] },
    runtime: {
      retryOverride: {
        model: "gpt-5.4",
        reasoningEffort: "medium"
      }
    }
  });
  assert.equal(result.ok, true);
  const params = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(params.model, "gpt-5.4");
  assert.equal(params.effort, "medium");
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

test("CodexInteractiveRuntime sends default collaboration mode for execute follow-ups after plan mode", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-plan-exit-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "turn-starts.jsonl");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const recordPath = ${JSON.stringify(recordPath)};
let turnStartCount = 0;

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "collaborationMode/list") {
    send({
      id: message.id,
      result: {
        data: [
          { name: "Plan", mode: "plan", reasoning_effort: "medium" },
          { name: "Default", mode: "default", reasoning_effort: null }
        ]
      }
    });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_plan_exit", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    turnStartCount += 1;
    fs.appendFileSync(recordPath, JSON.stringify(message.params) + "\\n");
    const turnId = turnStartCount === 1 ? "turn_plan" : "turn_execute";
    const started = { id: turnId, items: [], status: "inProgress", error: null, startedAt: turnStartCount, completedAt: null, durationMs: null };
    const completed = { ...started, status: "completed", completedAt: turnStartCount + 1, durationMs: 1 };
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: started } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: completed } });
    send({ id: message.id, result: { turn: completed } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};
fs.mkdirSync(${JSON.stringify(path.join(homePath, ".codex"))}, { recursive: true });
fs.writeFileSync(${JSON.stringify(path.join(homePath, ".codex", "config.toml"))}, 'model = "gpt-5.4"\\nmodel_reasoning_effort = "low"\\n', "utf8");

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const started = await runtime.handleCommand({
    sessionId: "session-plan-exit",
    type: "start",
    projectId: "demo",
    payload: { prompt: "先做计划", attachments: [], mode: "plan" },
    runtime: { model: "gpt-5.4", reasoningEffort: "low" }
  });
  assert.equal(started.ok, true);
  assert.equal(started.sessionStatus, "active");

  const followed = await runtime.handleCommand({
    sessionId: "session-plan-exit",
    type: "message",
    projectId: "demo",
    appThreadId: started.appThreadId,
    payload: { text: "现在退出计划模式并执行", attachments: [], mode: "execute" },
    runtime: { model: "gpt-5.4", reasoningEffort: "low" }
  });
  assert.equal(followed.ok, true);

  const requests = fs.readFileSync(${JSON.stringify(recordPath)}, "utf8").trim().split("\\n").map((line) => JSON.parse(line));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].collaborationMode.mode, "plan");
  assert.equal(requests[1].collaborationMode.mode, "default");
  assert.equal(requests[1].collaborationMode.settings.model, "gpt-5.4");
  assert.equal(requests[1].collaborationMode.settings.reasoning_effort, "low");
  assert.equal(requests[1].collaborationMode.settings.developer_instructions, null);
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

test("CodexInteractiveRuntime forwards requestUserInput server requests", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-user-input-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const responsePath = path.join(tempRoot, "user-input-response.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const requestId = "request_user_input_1";

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === requestId && message.result) {
    fs.writeFileSync(${JSON.stringify(responsePath)}, JSON.stringify(message.result), "utf8");
    send({ method: "serverRequest/resolved", params: { threadId: "thr_input", requestId } });
    send({ method: "turn/completed", params: { threadId: "thr_input", turn: { id: "turn_input", status: "completed" } } });
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_input", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn_input", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    send({
      id: requestId,
      method: "item/tool/requestUserInput",
      params: {
        threadId: message.params.threadId,
        turnId: turn.id,
        itemId: "call1",
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
    });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

let capturedInteraction = null;
let resolveCompleted;
const completed = new Promise((resolve) => {
  resolveCompleted = resolve;
});
let resolveInteraction;
const interactionSeen = new Promise((resolve) => {
  resolveInteraction = resolve;
});
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, events) => {
    if (events.some((event) => event.type === "turn/completed")) resolveCompleted();
  },
  requestInteraction: async (interaction) => {
    capturedInteraction = interaction;
    resolveInteraction();
    return { answers: { model_choice: { answers: ["B"] } } };
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-input",
    type: "start",
    projectId: "demo",
    payload: { prompt: "ask", attachments: [] },
    runtime: { model: "gpt-5.4" }
  });
  assert.equal(result.ok, true);
  await Promise.race([
    interactionSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for interaction")), 2000))
  ]);
  await Promise.race([
    completed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for completion")), 2000))
  ]);
  assert.equal(capturedInteraction.method, "item/tool/requestUserInput");
  assert.equal(capturedInteraction.kind, "user_input");
  assert.equal(capturedInteraction.payload.questions[0].id, "model_choice");
  const response = JSON.parse(fs.readFileSync(${JSON.stringify(responsePath)}, "utf8"));
  assert.deepEqual(response, { answers: { model_choice: { answers: ["B"] } } });
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

test("CodexInteractiveRuntime accepts managed workspaces created by the desktop agent", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-managed-workspace-"));
  const homePath = path.join(tempRoot, "home");
  const workspaceRoot = path.join(tempRoot, "projects");
  const configuredWorkspacePath = path.join(tempRoot, "configured");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(configuredWorkspacePath, { recursive: true });

  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_managed", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import path from "node:path";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`configured=${configuredWorkspacePath}`)};
process.env.ECHO_CODEX_WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)};
process.env.ECHO_CODEX_MANAGED_WORKSPACES_FILE = ${JSON.stringify(path.join(tempRoot, "managed-workspaces.json"))};

const manager = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexWorkspaceManager.js"))});
const runner = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexRunner.js"))});
const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const workspace = manager.createManagedWorkspace({ name: "managed project" });
assert.equal(path.dirname(workspace.path), ${JSON.stringify(workspaceRoot)});
assert.equal(runner.publicWorkspaces().some((item) => item.id === workspace.id), true);

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-managed",
    type: "start",
    projectId: workspace.id,
    payload: { prompt: "", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_managed");
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

test("CodexInteractiveRuntime coalesces streaming assistant deltas", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-delta-buffer-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_stream", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn_stream", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    for (const delta of ["Hello", " ", "from", " ", "Echo"]) {
      send({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: turn.id, itemId: "msg_1", delta } });
    }
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "msg_1", text: "Hello from Echo" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", completedAt: 2 } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const batches = [];
let resolveCompleted;
const completed = new Promise((resolve) => {
  resolveCompleted = resolve;
});
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, events) => {
    batches.push(events);
    if (events.some((event) => event.type === "turn/completed")) resolveCompleted();
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-stream",
    type: "start",
    projectId: "demo",
    payload: { prompt: "stream", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  await Promise.race([
    completed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for completion")), 2000))
  ]);

  const events = batches.flat();
  const deltaEvents = events.filter((event) => event.type === "item/agentMessage/delta");
  assert.equal(deltaEvents.length, 1);
  assert.equal(deltaEvents[0].text, "Hello from Echo");
  assert.equal(deltaEvents[0].raw.params.delta, "Hello from Echo");
  assert.equal(events.findIndex((event) => event.type === "item/agentMessage/delta") < events.findIndex((event) => event.type === "item/completed"), true);
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

test("CodexInteractiveRuntime turns assistant workspace image paths into relay artifact payloads", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-local-image-artifact-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const screenshotPath = path.join(workspacePath, "output", "playwright", "latest.png");
  const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+KDvY8QAAAABJRU5ErkJggg==";

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(screenshotPath, Buffer.from(tinyPngBase64, "base64"));
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const screenshotPath = ${JSON.stringify(screenshotPath)};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_local_image", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn_local_image", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    const text = \`直接看这张：

![当前对话界面](\${screenshotPath})

文件位置：[latest.png](\${screenshotPath})\`;
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "msg_local_image", text } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", completedAt: 2 } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";

const screenshotPath = ${JSON.stringify(screenshotPath)};

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const events = [];
let resolveCompleted;
const completed = new Promise((resolve) => {
  resolveCompleted = resolve;
});
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, batch) => {
    events.push(...batch);
    if (batch.some((event) => event.type === "turn/completed")) resolveCompleted();
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-local-image",
    type: "start",
    projectId: "demo",
    payload: { prompt: "send me the screenshot", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  await Promise.race([
    completed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for completion")), 2000))
  ]);

  const event = events.find((item) => item.type === "item/completed");
  assert.ok(event);
  assert.match(event.text, /直接看这张/);
  assert.equal(event.text.includes(screenshotPath), false);
  assert.equal(event.raw.params.item.text.includes(screenshotPath), false);
  assert.equal(event.raw.echoLocalImageArtifacts.length, 1);
  assert.equal(event.raw.echoLocalImageArtifacts[0].label, "当前对话界面");
  assert.equal(event.raw.echoLocalImageArtifacts[0].mimeType, "image/png");
  assert.match(event.raw.echoLocalImageArtifacts[0].dataUrl, /^data:image\\/png;base64,/);
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

test("CodexInteractiveRuntime reports fast completed turns as active", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-fast-complete-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_fast_done", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn_fast_done", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", completedAt: 2 } } });
    send({ id: message.id, result: { turn } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

let resolveCompleted;
const completed = new Promise((resolve) => {
  resolveCompleted = resolve;
});
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, events) => {
    if (events.some((event) => event.type === "turn/completed")) resolveCompleted();
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-fast-done",
    type: "start",
    projectId: "demo",
    payload: { prompt: "finish now", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionStatus, "active");
  assert.equal(result.activeTurnId, null);
  await Promise.race([
    completed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for completion")), 2000))
  ]);
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

test("CodexInteractiveRuntime only marks explicit context compaction completions terminal", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-compact-terminal-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let threadStartCount = 0;

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    threadStartCount += 1;
    const threadId = threadStartCount === 1 ? "thr_explicit_compact" : "thr_auto_compact";
    send({ id: message.id, result: { thread: { id: threadId, preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "item/completed", params: { threadId: message.params.threadId, item: { type: "contextCompaction", id: "ctx_explicit" } } });
    return;
  }
  if (message.method === "turn/start") {
    const turn = { id: "turn_auto_compact", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: turn.id, item: { type: "contextCompaction", id: "ctx_auto" } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: turn.id, item: { type: "agentMessage", id: "msg_auto", text: "done after compaction" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", completedAt: 2 } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const events = [];
const runtime = new CodexInteractiveRuntime({
  onEvents: async (sessionId, batch) => {
    events.push(...batch.map((event) => ({ ...event, sessionId })));
  }
});

const waitForEvent = async (predicate) => {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for event");
};

try {
  await runtime.handleCommand({
    sessionId: "session-explicit-compact",
    type: "start",
    projectId: "demo",
    payload: { prompt: "", attachments: [] },
    runtime: {}
  });
  await runtime.handleCommand({
    sessionId: "session-explicit-compact",
    type: "compact",
    projectId: "demo",
    appThreadId: "thr_explicit_compact",
    payload: {},
    runtime: {}
  });
  const explicit = await waitForEvent((event) => event.raw?.params?.item?.id === "ctx_explicit");
  assert.equal(explicit.clearActiveTurnId, true);
  assert.equal(explicit.sessionStatus, "active");
  assert.equal(explicit.raw.echoExplicitCompactionCommand, true);

  await runtime.handleCommand({
    sessionId: "session-auto-compact",
    type: "start",
    projectId: "demo",
    payload: { prompt: "auto compact during turn", attachments: [] },
    runtime: {}
  });
  await waitForEvent((event) => event.sessionId === "session-auto-compact" && event.type === "turn/completed");
  const automatic = events.find((event) => event.raw?.params?.item?.id === "ctx_auto");
  assert.ok(automatic);
  assert.equal(Boolean(automatic.clearActiveTurnId), false);
  assert.equal(automatic.sessionStatus, undefined);
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

test("CodexInteractiveRuntime recovers stale active turns by starting a new turn", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-stale-turn-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "requests.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const requests = [];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (message) => {
  requests.push({ method: message.method, params: message.params || {} });
  fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(requests), "utf8");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    record(message);
    send({ id: message.id, result: { thread: { id: message.params.threadId, preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1 } } });
    return;
  }
  if (message.method === "turn/steer") {
    record(message);
    send({ id: message.id, error: { code: -32603, message: "no active turn to steer" } });
    return;
  }
  if (message.method === "turn/start") {
    record(message);
    const turn = { id: "turn_new", items: [], status: "inProgress", error: null, startedAt: 2, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const events = [];
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, batch) => {
    events.push(...batch);
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-stale-turn",
    type: "message",
    projectId: "demo",
    appThreadId: "thr_existing",
    activeTurnId: "turn_old",
    payload: { text: "结果呢", attachments: [] },
    runtime: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_existing");
  assert.equal(result.activeTurnId, "turn_new");
  assert.equal(result.sessionStatus, "running");

  const staleEvent = events.find((event) => event.type === "turn.stale");
  assert.ok(staleEvent);
  assert.equal(staleEvent.clearActiveTurnId, true);
  assert.equal(staleEvent.activeTurnId, "turn_old");

  const requests = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/steer", "turn/start"]);
  assert.equal(requests[1].params.expectedTurnId, "turn_old");
  assert.equal(requests[2].params.input[0].text, "结果呢");
  assert.equal(Object.prototype.hasOwnProperty.call(requests[2].params, "collaborationMode"), false);
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

test("CodexInteractiveRuntime starts a new turn when a compact turn cannot be steered", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-compact-turn-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "requests.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const requests = [];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (message) => {
  requests.push({ method: message.method, params: message.params || {} });
  fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(requests), "utf8");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    record(message);
    send({ id: message.id, result: { thread: { id: message.params.threadId, preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1 } } });
    return;
  }
  if (message.method === "turn/steer") {
    record(message);
    send({ id: message.id, error: { code: -32603, message: "cannot steer a compact turn" } });
    return;
  }
  if (message.method === "turn/start") {
    record(message);
    const turn = { id: "turn_after_compact", items: [], status: "inProgress", error: null, startedAt: 2, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const events = [];
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, batch) => {
    events.push(...batch);
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-compact-turn",
    type: "message",
    projectId: "demo",
    appThreadId: "thr_existing",
    activeTurnId: "turn_compact",
    payload: { text: "压缩后继续", attachments: [] },
    runtime: {}
  });

  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_existing");
  assert.equal(result.activeTurnId, "turn_after_compact");
  assert.equal(result.sessionStatus, "running");

  const staleEvent = events.find((event) => event.type === "turn.stale");
  assert.ok(staleEvent);
  assert.equal(staleEvent.clearActiveTurnId, true);
  assert.equal(staleEvent.activeTurnId, "turn_compact");
  assert.match(staleEvent.raw.error, /compact turn/i);

  const requests = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/steer", "turn/start"]);
  assert.equal(requests[1].params.expectedTurnId, "turn_compact");
  assert.equal(requests[2].params.input[0].text, "压缩后继续");
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

test("CodexInteractiveRuntime keeps restored token usage notifications mapped to the session", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-token-usage-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tokenUsage = {
  total: { totalTokens: 64000, inputTokens: 60000, cachedInputTokens: 1000, outputTokens: 4000, reasoningOutputTokens: 500 },
  last: { totalTokens: 42000, inputTokens: 40000, cachedInputTokens: 800, outputTokens: 2000, reasoningOutputTokens: 300 },
  modelContextWindow: 128000
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    send({ method: "thread/tokenUsage/updated", params: { threadId: message.params.threadId, turnId: "turn_restored", tokenUsage } });
    send({ id: message.id, result: { thread: { id: message.params.threadId, preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_after_resume", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const events = [];
let resolveUsage;
const usageSeen = new Promise((resolve) => {
  resolveUsage = resolve;
});
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, batch) => {
    events.push(...batch);
    if (batch.some((event) => event.type === "thread/tokenUsage/updated")) resolveUsage();
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-resume",
    type: "message",
    projectId: "demo",
    appThreadId: "thr_resume",
    payload: { text: "continue", attachments: [], history: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  await Promise.race([
    usageSeen,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for token usage")), 2000))
  ]);

  const event = events.find((item) => item.type === "thread/tokenUsage/updated");
  assert.equal(event.appThreadId, "thr_resume");
  assert.equal(event.raw.params.tokenUsage.last.totalTokens, 42000);
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

test("CodexInteractiveRuntime starts a fresh thread for follow-ups when a failed session has no thread id", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-threadless-recovery-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "turn-start.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_recovered", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(message.params), "utf8");
    send({
      id: message.id,
      result: {
        turn: { id: "turn_recovered", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null }
      }
    });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const events = [];
const runtime = new CodexInteractiveRuntime({
  onEvents: async (_id, batch) => {
    events.push(...batch);
  }
});

try {
  const result = await runtime.handleCommand({
    sessionId: "session-threadless",
    type: "message",
    projectId: "demo",
    appThreadId: "",
    payload: {
      text: "恢复后继续这条上下文",
      attachments: [],
      history: [{ role: "user", text: "先看看这个限流问题" }]
    },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_recovered");

  const params = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(params.threadId, "thr_recovered");
  assert.equal(params.input[0].type, "text");
  assert.match(params.input[0].text, /恢复的 Codex 会话/);
  assert.match(params.input[0].text, /先看看这个限流问题/);
  assert.match(params.input[0].text, /恢复后继续这条上下文/);
  assert.equal(events.some((event) => event.type === "thread.restarted"), true);
  assert.equal(events.some((event) => event.raw?.recoveredFromSavedHistory === true), true);
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

test("CodexInteractiveRuntime skips native resume when Echo resets the backend thread", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-backend-switch-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "requests.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const requests = [];
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (message) => {
  requests.push({ method: message.method, params: message.params || {} });
  fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(requests), "utf8");
};

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    record(message);
    send({ id: message.id, error: { code: -32603, message: "thread/resume should not be called during backend switch" } });
    return;
  }
  if (message.method === "thread/start") {
    record(message);
    send({ id: message.id, result: { thread: { id: "thr_codex_switch", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    record(message);
    const turn = { id: "turn_codex_switch", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-backend-switch",
    type: "message",
    projectId: "demo",
    appThreadId: "claude-thread-1",
    payload: {
      text: "切到 Codex 继续修复",
      attachments: [],
      resetThread: true,
      resetReason: "backend-switch",
      history: [
        { role: "user", text: "先用 Claude Code 分析问题" },
        { role: "assistant", text: "Claude Code 已定位到会话恢复问题。" }
      ]
    },
    runtime: { model: "gpt-5.6-sol", reasoningEffort: "max" }
  });

  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_codex_switch");
  assert.equal(result.activeTurnId, "turn_codex_switch");

  const requests = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.deepEqual(requests.map((request) => request.method), ["thread/start", "turn/start"]);
  assert.equal(requests[0].params.model, "gpt-5.6-sol");
  assert.equal(requests[1].params.model, "gpt-5.6-sol");
  assert.equal(requests[1].params.effort, "max");
  assert.match(requests[1].params.input[0].text, /恢复的 Codex 会话/);
  assert.match(requests[1].params.input[0].text, /先用 Claude Code 分析问题/);
  assert.match(requests[1].params.input[0].text, /Claude Code 已定位到会话恢复问题/);
  assert.match(requests[1].params.input[0].text, /切到 Codex 继续修复/);
  assert.equal(Object.prototype.hasOwnProperty.call(requests[1].params, "collaborationMode"), false);
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

test("CodexInteractiveRuntime restarts app-server once after stale Codex auth", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-auth-retry-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const attemptsPath = path.join(tempRoot, "attempts.txt");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(attemptsPath, "0", "utf8");
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    const attempts = Number(fs.readFileSync(attemptsPath, "utf8")) + 1;
    fs.writeFileSync(attemptsPath, String(attempts), "utf8");
    if (attempts === 1) {
      send({ id: message.id, error: { code: -32603, message: "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again." } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "thr_after_auth_retry", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-auth-retry",
    type: "start",
    projectId: "demo",
    payload: { prompt: "", attachments: [] },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.appThreadId, "thr_after_auth_retry");
  assert.equal(fs.readFileSync(${JSON.stringify(attemptsPath)}, "utf8"), "2");
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

test("CodexInteractiveRuntime downloads relay attachments with the agent token", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-agent-attachment-token-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "turn-start.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, "README.md"), "# attachment workspace\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: workspacePath });
  execFileSync("git", ["add", "README.md"], { cwd: workspacePath });
  execFileSync("git", ["-c", "user.name=Echo Test", "-c", "user.email=echo@example.test", "commit", "-qm", "initial"], { cwd: workspacePath });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_agent_attachment_token", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(message.params, null, 2), "utf8");
    const turn = { id: "turn_agent_attachment_token", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    setTimeout(() => send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { ...turn, status: "completed", completedAt: 2 } } }), 50);
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const script = `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const attachmentBody = Buffer.from("alpha\\nbeta\\n", "utf8");
let seenHeaders = null;
const relayServer = http.createServer((req, res) => {
  seenHeaders = req.headers;
  if (req.url !== "/api/agent/codex/attachments/att-file") {
    if (req.url === "/api/agent/codex/attachments/att-fail") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "download failed" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (req.headers["x-echo-agent-token"] !== "profile-agent-token") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Attachment not found." }));
    return;
  }
  res.writeHead(200, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "text/plain",
    "Content-Length": String(attachmentBody.length)
  });
  res.end(attachmentBody);
});
await new Promise((resolve) => relayServer.listen(0, "127.0.0.1", resolve));

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "legacy-owner-token";
process.env.ECHO_AGENT_TOKEN = "profile-agent-token";
process.env.ECHO_RELAY_URL = "http://127.0.0.1:" + relayServer.address().port;
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-agent-attachment-token",
    type: "start",
    projectId: "demo",
    payload: {
      prompt: "read this",
      attachments: [{
        type: "file",
        id: "att-file",
        name: "test.txt",
        mimeType: "text/plain",
        sizeBytes: attachmentBody.length,
        downloadPath: "/api/agent/codex/attachments/att-file"
      }]
    },
    runtime: {}
  });
  assert.equal(result.ok, true);
  assert.equal(seenHeaders["x-echo-agent-token"], "profile-agent-token");
  assert.equal(seenHeaders["x-echo-token"], "legacy-owner-token");
  const params = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  const text = params.input[0].text;
  assert.match(text, /\\[Echo attachments\\]/);
  const match = /local file: (.+)/.exec(text);
  assert.ok(match);
  const filePath = match[1].trim();
  const stagingRoot = path.join(${JSON.stringify(homePath)}, ".echo-voice", "codex-attachment-staging", "default-agent");
  assert.equal(filePath.startsWith(stagingRoot), true);
  assert.equal(filePath.startsWith(${JSON.stringify(workspacePath)}), false);
  assert.equal(fs.readFileSync(filePath, "utf8"), "alpha\\nbeta\\n");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ${JSON.stringify(workspacePath)}, encoding: "utf8" }), "");
  const worktreePath = path.join(${JSON.stringify(tempRoot)}, "attachment-worktree");
  execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: ${JSON.stringify(workspacePath)} });
  assert.equal(fs.existsSync(path.join(worktreePath, "README.md")), true);
  const deadline = Date.now() + 2000;
  while (fs.existsSync(filePath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(filePath), false);

  await assert.rejects(
    runtime.handleCommand({
      id: "command-failed-attachment",
      sessionId: "session-agent-attachment-token",
      appThreadId: "thr_agent_attachment_token",
      type: "message",
      projectId: "demo",
      payload: {
        text: "read the failing attachment",
        attachments: [{ type: "file", id: "att-fail", name: "fail.txt", downloadPath: "/api/agent/codex/attachments/att-fail" }]
      },
      runtime: {}
    }),
    /HTTP 500/
  );
  const stagedEntries = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot, { recursive: true }) : [];
  assert.equal(stagedEntries.length, 0);
} finally {
  await runtime.stop();
  await new Promise((resolve) => relayServer.close(resolve));
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("CodexInteractiveRuntime passes mobile images as cached references instead of localImage inputs", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-image-ref-"));
  const homePath = path.join(tempRoot, "home");
  const workspacePath = path.join(tempRoot, "workspace");
  const fakeCodexPath = path.join(tempRoot, "fake-codex-app");
  const recordPath = path.join(tempRoot, "turn-start.json");

  fs.mkdirSync(homePath, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_image_ref", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, cwd: message.params.cwd } } });
    return;
  }
  if (message.method === "turn/start") {
    fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(message.params, null, 2), "utf8");
    const turn = { id: "turn_image_ref", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null };
    send({ id: message.id, result: { turn } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
  }
});
`,
    "utf8"
  );
  fs.chmodSync(fakeCodexPath, 0o755);

  const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+KDvY8QAAAABJRU5ErkJggg==";
  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

process.env.HOME = ${JSON.stringify(homePath)};
process.env.CODEX_HOME = ${JSON.stringify(path.join(homePath, ".codex"))};
process.env.ECHO_MODE = "relay";
process.env.ECHO_TOKEN = "test-token";
process.env.ECHO_RELAY_URL = "https://example.test";
process.env.ECHO_CODEX_COMMAND = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_APP_PATH = ${JSON.stringify(fakeCodexPath)};
process.env.ECHO_CODEX_WORKSPACES = ${JSON.stringify(`demo=${workspacePath}`)};

const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});

const runtime = new CodexInteractiveRuntime();
try {
  const result = await runtime.handleCommand({
    sessionId: "session-image-ref",
    type: "start",
    projectId: "demo",
    payload: {
      prompt: "看一下这张图",
      attachments: [{ type: "image", url: ${JSON.stringify(`data:image/png;base64,${tinyPngBase64}`)}, name: "screen.png", mimeType: "image/png", sizeBytes: 70 }]
    },
    runtime: {}
  });
  assert.equal(result.ok, true);
  const params = JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)}, "utf8"));
  assert.equal(params.input.some((item) => item.type === "localImage"), false);
  assert.equal(params.input.length, 1);
  assert.equal(params.input[0].type, "text");
  assert.match(params.input[0].text, /\\[Echo image attachments]/);
  assert.match(params.input[0].text, /Do not inline or echo image bytes\\/base64/);
  assert.doesNotMatch(params.input[0].text, /data:image\\/png;base64/);
  const match = /local file: (.+)/.exec(params.input[0].text);
  assert.ok(match);
  const imagePath = match[1].trim();
  assert.equal(fs.existsSync(imagePath), true);
  assert.equal(imagePath.startsWith(path.join(${JSON.stringify(homePath)}, ".echo-voice", "codex-attachment-staging", "default-agent")), true);
  assert.equal(imagePath.startsWith(${JSON.stringify(workspacePath)}), false);
  await runtime.handleCommand({
    id: "command-cancel-image",
    sessionId: "session-image-ref",
    appThreadId: "thr_image_ref",
    activeTurnId: "turn_image_ref",
    type: "stop",
    projectId: "demo",
    payload: {},
    runtime: {}
  });
  assert.equal(fs.existsSync(imagePath), false);
} finally {
  await runtime.stop();
}
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });

  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});

test("managed attachment cleanup removes stale staging but rejects paths outside the real root", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-attachment-cleanup-"));
  const managedRoot = path.join(tempRoot, "managed");
  const outsideRoot = path.join(tempRoot, "outside");
  const managedFile = path.join(managedRoot, "session", "command", "attachment.txt");
  const outsideFile = path.join(outsideRoot, "keep.txt");
  fs.mkdirSync(path.dirname(managedFile), { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(managedFile, "stale", "utf8");
  fs.writeFileSync(outsideFile, "keep", "utf8");

  const { removeManagedAttachmentStagingPath } = await import("../src/lib/codexInteractiveRunner.js");
  assert.equal(await removeManagedAttachmentStagingPath(managedRoot, path.join(managedRoot, "session")), true);
  assert.equal(fs.existsSync(managedFile), false);

  await assert.rejects(removeManagedAttachmentStagingPath(managedRoot, outsideRoot), /outside the managed staging root/);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "keep");

  const symlinkPath = path.join(managedRoot, "outside-link");
  fs.symlinkSync(outsideRoot, symlinkPath, "dir");
  await assert.rejects(removeManagedAttachmentStagingPath(managedRoot, symlinkPath), /realpath outside the managed staging root/);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "keep");
});

test("CodexInteractiveRuntime removes stale attachment staging during startup", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "echo-runtime-attachment-recovery-"));
  const homePath = path.join(tempRoot, "home");
  const staleFile = path.join(homePath, ".echo-voice", "codex-attachment-staging", "recovery-agent", "stale-session", "stale-command", "stale.txt");
  fs.mkdirSync(path.dirname(staleFile), { recursive: true });
  fs.writeFileSync(staleFile, "stale", "utf8");

  const script = `
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.HOME = ${JSON.stringify(homePath)};
const { CodexInteractiveRuntime } = await import(${JSON.stringify(path.join(process.cwd(), "src/lib/codexInteractiveRunner.js"))});
const runtime = new CodexInteractiveRuntime({ agentId: "recovery-agent" });
await runtime.stop();
assert.equal(fs.existsSync(${JSON.stringify(staleFile)}), false);
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: script
  });
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
});
