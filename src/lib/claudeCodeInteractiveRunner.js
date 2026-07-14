import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.js";
import { formatGitSummary, gitWorkspaceSnapshot, summarizeGitWorkspace } from "./codexGitSummary.js";
import { prepareClaudeRunEnvironment } from "./claudeCodeRunner.js";
import { publicWorkspaces } from "./codexRunner.js";
import { isDeepSeekClaudeRuntime } from "./deepSeekClaude.js";

export class ClaudeCodeInteractiveRuntime {
  constructor(options = {}) {
    this.agentId = options.agentId || "default-agent";
    this.onEvents = options.onEvents || (async () => {});
    this.backendConfig = options.backendConfig || config.claude;
    this.sessions = new Map();
    this.activeTurns = new Map();
    this.pendingStopsByThread = new Map();
    this.pendingStopsBySession = new Map();
  }

  stop() {
    for (const turn of this.activeTurns.values()) {
      interruptClaudeTurn(turn);
    }
    this.activeTurns.clear();
    this.sessions.clear();
    this.pendingStopsByThread.clear();
    this.pendingStopsBySession.clear();
  }

  async handleCommand(command) {
    const workspace = this.#workspaceFor(command);
    if (command.type === "start") return this.#startSession(command, workspace);
    if (command.type === "message") return this.#sendMessage(command, workspace);
    if (command.type === "stop") return this.#stopTurn(command);
    if (command.type === "compact") return this.#compactThread(command);
    throw new Error(`Unsupported Claude Code session command: ${command.type}`);
  }

  async #startSession(command, workspace) {
    const runtime = this.#runtimeFor(command);
    const appThreadId = randomUUID();
    this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
    await this.#emit(command.sessionId, [
      {
        type: "thread.started",
        text: `Claude Code session started in ${workspace.path}.`,
        appThreadId,
        sessionStatus: "active",
        raw: {
          method: "thread/start",
          result: {
            thread: {
              id: appThreadId,
              provider: runtime.provider
            }
          }
        }
      }
    ]);

    const prompt = String(command.payload?.prompt || "").trim();
    const attachments = Array.isArray(command.payload?.attachments) ? command.payload.attachments : [];
    if (!prompt && attachments.length === 0) {
      return { ok: true, appThreadId, sessionStatus: "active" };
    }
    return this.#runTurn({
      sessionId: command.sessionId,
      appThreadId,
      text: prompt,
      attachments,
      workspace,
      runtime,
      mode: command.payload?.mode,
      resume: false
    });
  }

  async #sendMessage(command, workspace) {
    const runtime = this.#runtimeFor(command);
    const resetThread = Boolean(command.payload?.resetThread);
    const remembered = resetThread ? null : this.sessions.get(command.sessionId) || null;
    if (resetThread) {
      const rememberedThreadId = this.sessions.get(command.sessionId)?.appThreadId;
      if (rememberedThreadId) this.activeTurns.delete(rememberedThreadId);
      this.sessions.delete(command.sessionId);
    }
    const existingThreadId = resetThread ? "" : String(command.appThreadId || remembered?.appThreadId || "").trim();
    const prompt = String(command.payload?.text || "").trim();
    const attachments = Array.isArray(command.payload?.attachments) ? command.payload.attachments : [];
    if (!prompt && attachments.length === 0) throw new Error("Claude Code session message is empty.");

    if (existingThreadId) {
      try {
        this.#rememberSession(command.sessionId, existingThreadId, workspace, runtime);
        return await this.#runTurn({
          sessionId: command.sessionId,
          appThreadId: existingThreadId,
          text: prompt,
          attachments,
          workspace,
          runtime,
          mode: command.payload?.mode,
          resume: true
        });
      } catch (error) {
        const recoveredThreadId = randomUUID();
        const recoveryContext = normalizeRecoveryContext(command.payload?.recoveryContext, command.payload?.history);
        this.#rememberSession(command.sessionId, recoveredThreadId, workspace, runtime);
        await this.#emit(command.sessionId, [
          {
            type: "thread.recovered",
            text: recoveryEventText(recoveryContext),
            appThreadId: recoveredThreadId,
            sessionStatus: "active",
            raw: {
              method: "thread/recovered",
              previousThreadId: existingThreadId,
              nextThreadId: recoveredThreadId,
              recovery: recoveryEventMetadata(recoveryContext, error),
              error: error.message || ""
            }
          }
        ]);
        return this.#runTurn({
          sessionId: command.sessionId,
          appThreadId: recoveredThreadId,
          text: recoveredThreadPrompt({
            history: command.payload?.history,
            recoveryContext,
            currentText: prompt
          }),
          attachments,
          workspace,
          runtime,
          mode: command.payload?.mode,
          resume: false
        });
      }
    }

    const appThreadId = randomUUID();
    const recoveryContext = normalizeRecoveryContext(command.payload?.recoveryContext, command.payload?.history);
    this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
    await this.#emit(command.sessionId, [
      {
        type: "thread.started",
        text: `Claude Code session restarted in ${workspace.path}.`,
        appThreadId,
        sessionStatus: "active",
        raw: {
          method: "thread/start",
          result: {
            thread: {
              id: appThreadId,
              provider: runtime.provider
            }
          }
        }
      },
      {
        type: "thread.recovered",
        text: recoveryEventText(recoveryContext),
        appThreadId,
        sessionStatus: "active",
        raw: {
          method: "thread/recovered",
          previousThreadId: "",
          nextThreadId: appThreadId,
          recovery: recoveryEventMetadata(recoveryContext, "missing native Claude session id"),
          error: "missing native Claude session id"
        }
      }
    ]);
    return this.#runTurn({
      sessionId: command.sessionId,
      appThreadId,
      text: recoveredThreadPrompt({
        history: command.payload?.history,
        recoveryContext,
        currentText: prompt
      }),
      attachments,
      workspace,
      runtime,
      mode: command.payload?.mode,
      resume: false
    });
  }

  async #stopTurn(command) {
    const appThreadId = String(command.appThreadId || this.sessions.get(command.sessionId)?.appThreadId || "").trim();
    const activeTurn = appThreadId ? this.activeTurns.get(appThreadId) : null;
    if (!activeTurn) {
      this.#rememberPendingStop(command.sessionId, appThreadId, {
        expectedTurnId: command.activeTurnId,
        reason: command.payload?.reason
      });
      return { ok: true, appThreadId: appThreadId || undefined, sessionStatus: "active" };
    }

    interruptClaudeTurn(activeTurn);
    await this.#emitInterruptedTurn(command.sessionId, appThreadId, activeTurn.turnId);
    return { ok: true, appThreadId, sessionStatus: "active" };
  }

  async #compactThread(command) {
    const appThreadId = String(command.appThreadId || this.sessions.get(command.sessionId)?.appThreadId || "").trim();
    if (!appThreadId) return { ok: true, sessionStatus: "active" };
    await this.#emit(command.sessionId, [
      {
        type: "context.compaction.unavailable",
        text: "Claude Code backend does not support remote context compaction yet.",
        appThreadId,
        sessionStatus: "active",
        raw: {
          method: "thread/compact/unavailable",
          threadId: appThreadId
        }
      }
    ]);
    return { ok: true, appThreadId, sessionStatus: "active" };
  }

  async #runTurn({ sessionId, appThreadId, text, attachments, workspace, runtime, mode, resume }) {
    if (attachments.length > 0) {
      throw new Error("Claude Code backend does not support Echo file attachments yet.");
    }
    if (this.activeTurns.has(appThreadId)) {
      throw new Error("Claude Code is already handling a turn for this session.");
    }
    if (!runtime.command) {
      throw new Error("Claude Code command is not available. Check ECHO_CLAUDE_COMMAND.");
    }

    const turnId = randomUUID();
    if (this.#consumePendingStop(sessionId, appThreadId, turnId)) {
      await this.#emitInterruptedTurn(sessionId, appThreadId, turnId, "Claude Code turn interrupted before it started.");
      return { ok: true, appThreadId, sessionStatus: "active" };
    }

    const gitBaseline = await gitWorkspaceSnapshot(workspace.path).catch(() => null);
    await this.#emit(sessionId, [
      {
        type: "turn.started",
        text: "Claude Code turn started.",
        appThreadId,
        activeTurnId: turnId,
        sessionStatus: "running",
        raw: {
          method: "turn/started",
          params: {
            threadId: appThreadId,
            turn: {
              id: turnId,
              status: "inProgress"
            }
          }
        }
      }
    ]);

    const turnBackendConfig = buildTurnBackendConfig(this.backendConfig, runtime);
    const child = spawn(runtime.command, buildClaudeArgs({ appThreadId, text, runtime, mode, resume }), {
      cwd: workspace.path,
      env: { ...prepareClaudeRunEnvironment(turnBackendConfig, { configScopeId: appThreadId }), ...(runtime.worktreeCacheEnv || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });

    const state = {
      child,
      interrupted: false,
      turnId,
      killTimer: null
    };
    this.activeTurns.set(appThreadId, state);
    if (this.#consumePendingStop(sessionId, appThreadId, turnId)) {
      interruptClaudeTurn(state);
      await this.#emitInterruptedTurn(sessionId, appThreadId, turnId);
    }

    try {
      const result = await this.#consumeTurnOutput({
        sessionId,
        appThreadId,
        turnId,
        child,
        workspacePath: workspace.path,
        gitBaseline,
        state
      });
      if (result.interrupted) {
        return { ok: true, appThreadId, sessionStatus: "active" };
      }
      return { ok: true, appThreadId, sessionStatus: "active" };
    } finally {
      if (state.killTimer) clearTimeout(state.killTimer);
      this.activeTurns.delete(appThreadId);
    }
  }

  async #consumeTurnOutput({ sessionId, appThreadId, turnId, child, workspacePath, gitBaseline, state }) {
    const stdout = readline.createInterface({ input: child.stdout });
    const stderr = readline.createInterface({ input: child.stderr });
    let emitQueue = Promise.resolve();
    let deltaText = "";
    let finalText = "";
    let errorText = "";
    let latestUsage = null;

    const queueEvents = (events = []) => {
      if (!events.length) return;
      emitQueue = emitQueue.then(() => this.#emit(sessionId, events));
    };

    stdout.on("line", (line) => {
      const message = safeJsonParse(line);
      if (!message) return;

      const usage = extractClaudeUsage(message);
      if (usage) latestUsage = usage;

      const delta = extractClaudeDelta(message);
      if (delta) {
        deltaText += delta;
        queueEvents([
          {
            type: "item/agentMessage/delta",
            text: delta,
            appThreadId,
            activeTurnId: turnId,
            sessionStatus: "running",
            raw: {
              method: "item/agentMessage/delta",
              params: {
                threadId: appThreadId,
                turnId,
                delta
              }
            }
          }
        ]);
      }

      const assistantText = extractClaudeAssistantText(message);
      if (assistantText) finalText = assistantText;

      const resultText = extractClaudeResultText(message);
      if (resultText) finalText = resultText;

      if (message.type === "error") {
        errorText = String(message.message || message.error || "").trim();
      }
    });

    stderr.on("line", (line) => {
      const text = String(line || "").trim();
      if (!text) return;
      errorText = errorText ? `${errorText}\n${text}` : text;
    });

    const exit = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    await emitQueue;

    if (state.interrupted) {
      return { interrupted: true };
    }

    if (exit.code !== 0) {
      const message = errorText || `Claude Code exited with ${exit.signal || exit.code}.`;
      await this.#emit(sessionId, [
        {
          type: "turn.failed",
          text: message,
          error: message,
          appThreadId,
          activeTurnId: turnId,
          clearActiveTurnId: true,
          sessionStatus: "failed",
          raw: {
            method: "turn/completed",
            params: {
              threadId: appThreadId,
              turn: {
                id: turnId,
                status: "failed",
                error: {
                  message
                }
              }
            }
          }
        }
      ]);
      throw new Error(message);
    }

    const messageText = finalText || deltaText.trim();
    const completionEvents = [];
    if (latestUsage) {
      completionEvents.push({
        type: "context.usage.updated",
        text: "Claude Code context usage updated.",
        appThreadId,
        activeTurnId: turnId,
        raw: {
          source: "claude-code",
          method: "context/usage/updated",
          params: {
            threadId: appThreadId,
            turnId,
            source: "claude-code",
            usage: latestUsage
          }
        }
      });
    }
    if (messageText) {
      completionEvents.push({
        type: "item.completed",
        text: messageText,
        finalMessage: messageText,
        appThreadId,
        activeTurnId: turnId,
        raw: {
          method: "item/completed",
          params: {
            threadId: appThreadId,
            turnId,
            item: {
              type: "agentMessage",
              text: messageText
            }
          }
        }
      });
    }
    const gitSummary = await summarizeGitWorkspace(workspacePath, { baseline: gitBaseline }).catch(() => null);
    if (gitSummary) {
      completionEvents.push({
        type: "git.summary",
        text: formatGitSummary(gitSummary),
        appThreadId,
        activeTurnId: turnId,
        raw: {
          source: "desktop-agent",
          gitSummary
        }
      });
    }
    completionEvents.push({
      type: "turn.completed",
      text: "Claude Code turn completed.",
      appThreadId,
      activeTurnId: turnId,
      clearActiveTurnId: true,
      sessionStatus: "active",
      raw: {
        method: "turn/completed",
        params: {
          threadId: appThreadId,
          turn: {
            id: turnId,
            status: "completed"
          }
        }
      }
    });
    await this.#emit(sessionId, completionEvents);
    return { interrupted: false };
  }

  #rememberSession(sessionId, appThreadId, workspace, runtime) {
    this.sessions.set(sessionId, { appThreadId, workspace, runtime });
    const pending = this.pendingStopsBySession.get(sessionId);
    if (pending) this.pendingStopsByThread.set(appThreadId, pending);
  }

  #workspaceFor(command = {}) {
    const projectId = String(command.projectId || "").trim();
    const workspace = publicWorkspaces().find((item) => item.id === projectId);
    if (!workspace) throw new Error("Workspace is not advertised by this desktop agent.");
    const execution = command.execution && typeof command.execution === "object" ? command.execution : null;
    const executionPath = String(execution?.path || "").trim();
    if (!executionPath) return workspace;

    const resolvedExecutionPath = path.resolve(executionPath);
    const resolvedWorktreeRoot = path.resolve(config.codex.worktreeRoot || path.join(config.dataDir, "worktrees"));
    if (!isPathInside(resolvedExecutionPath, resolvedWorktreeRoot)) {
      throw new Error("Claude Code execution path is outside the desktop-controlled worktree root.");
    }
    return {
      ...workspace,
      path: resolvedExecutionPath,
      basePath: workspace.path,
      execution
    };
  }

  #runtimeFor(command = {}) {
    const backendConfig = this.backendConfig || config.claude;
    const remembered = this.sessions.get(command.sessionId)?.runtime || {};
    const runtime = command.runtime && typeof command.runtime === "object" ? command.runtime : remembered;
    return {
      backendId: String(runtime.backendId || backendConfig.backendId || "claude-code").trim() || "claude-code",
      provider: String(runtime.provider || backendConfig.provider || "claude-code").trim() || "claude-code",
      backendName: String(runtime.backendName || backendConfig.backendName || "Claude Code").trim() || "Claude Code",
      command: String(runtime.command || backendConfig.command || "claude").trim(),
      model: String(runtime.model || backendConfig.model || "").trim(),
      reasoningEffort: String(runtime.reasoningEffort || runtime.effort || backendConfig.reasoningEffort || "").trim().toLowerCase(),
      permissionMode: String(runtime.permissionMode || runtime.profile || backendConfig.permissionMode || "").trim().toLowerCase(),
      sandbox: String(runtime.sandbox || "read-only").trim(),
      approvalPolicy: String(runtime.approvalPolicy || "on-request").trim()
    };
  }

  async #emit(sessionId, events = []) {
    if (!events.length) return;
    await this.onEvents(sessionId, events);
  }

  async #emitInterruptedTurn(sessionId, appThreadId, turnId, text = "Claude Code turn interrupted from mobile.") {
    await this.#emit(sessionId, [
      {
        type: "turn.interrupted",
        text,
        appThreadId,
        activeTurnId: turnId,
        clearActiveTurnId: true,
        sessionStatus: "active",
        raw: {
          method: "turn/interrupt",
          threadId: appThreadId,
          turnId
        }
      }
    ]);
  }

  #rememberPendingStop(sessionId, appThreadId, options = {}) {
    const stop = {
      expectedTurnId: String(options.expectedTurnId || "").trim(),
      reason: String(options.reason || "").trim(),
      createdAt: Date.now()
    };
    if (sessionId) this.pendingStopsBySession.set(sessionId, stop);
    if (appThreadId) this.pendingStopsByThread.set(appThreadId, stop);
  }

  #consumePendingStop(sessionId, appThreadId, turnId) {
    const now = Date.now();
    const candidates = [
      appThreadId ? ["thread", appThreadId, this.pendingStopsByThread.get(appThreadId)] : null,
      sessionId ? ["session", sessionId, this.pendingStopsBySession.get(sessionId)] : null
    ].filter(Boolean);

    for (const [, , pending] of candidates) {
      if (!pending) continue;
      const stale = now - Number(pending.createdAt || 0) > 120000;
      const turnMismatch = pending.expectedTurnId && pending.expectedTurnId !== turnId;
      if (stale || turnMismatch) {
        this.#forgetPendingStop(sessionId, appThreadId);
        continue;
      }
      this.#forgetPendingStop(sessionId, appThreadId);
      return pending;
    }
    return null;
  }

  #forgetPendingStop(sessionId, appThreadId) {
    if (sessionId) this.pendingStopsBySession.delete(sessionId);
    if (appThreadId) this.pendingStopsByThread.delete(appThreadId);
  }
}

function buildClaudeArgs({ appThreadId, text, runtime, mode, resume }) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (resume) args.push("--resume", appThreadId);
  else args.push("--session-id", appThreadId);

  const permissionMode = permissionModeForClaude(runtime, mode);
  if (permissionMode) args.push("--permission-mode", permissionMode);
  if (runtime.model) args.push("--model", runtime.model);
  if (runtime.reasoningEffort && !isDeepSeekClaudeRuntime(runtime)) args.push("--effort", runtime.reasoningEffort);
  args.push(text);
  return args;
}

function interruptClaudeTurn(turn) {
  if (!turn?.child) return;
  turn.interrupted = true;
  if (turn.child.exitCode === null && turn.child.signalCode === null) turn.child.kill("SIGTERM");
  if (!turn.killTimer) {
    turn.killTimer = setTimeout(() => {
      if (turn.child.exitCode === null && turn.child.signalCode === null) turn.child.kill("SIGKILL");
    }, 5000);
    turn.killTimer.unref?.();
  }
}

function buildTurnBackendConfig(backendConfig = {}, runtime = {}) {
  const base = backendConfig || {};
  const selected = runtime || {};
  return {
    ...base,
    backendId: selected.backendId || base.backendId,
    provider: selected.provider || base.provider,
    backendName: selected.backendName || base.backendName,
    command: selected.command || base.command,
    model: selected.model || base.model,
    reasoningEffort: selected.reasoningEffort || base.reasoningEffort,
    permissionMode: selected.permissionMode || base.permissionMode,
    subagentModel: selected.subagentModel || base.subagentModel,
    agentTeamsEnabled: base.agentTeamsEnabled || selected.agentTeamsEnabled,
    baseUrl: base.baseUrl || selected.baseUrl,
    authToken: base.authToken || selected.authToken
  };
}

function permissionModeForClaude(runtime = {}, mode = "execute") {
  if (String(mode || "").trim().toLowerCase() === "plan") return "plan";
  const requested = String(runtime.permissionMode || "").trim().toLowerCase();
  if (requested === "full" || requested === "bypasspermissions" || requested === "dontask") return "bypassPermissions";
  if (requested === "approve" || requested === "acceptedits" || requested === "default" || requested === "auto") return "acceptEdits";
  if (requested === "strict" || requested === "plan") return "plan";
  return sandboxToClaudePermission(String(runtime.sandbox || "").trim()) || "acceptEdits";
}

function sandboxToClaudePermission(sandbox) {
  const normalized = String(sandbox || "").trim().toLowerCase();
  if (normalized === "danger-full-access") return "bypassPermissions";
  if (normalized === "workspace-write") return "acceptEdits";
  if (normalized === "read-only") return "plan";
  return "";
}

function extractClaudeUsage(message = {}) {
  const candidates = [
    message.usage,
    message.message?.usage,
    message.result?.usage,
    message.response?.usage,
    message.usage_metadata,
    message.message?.usage_metadata,
    message.result?.usage_metadata,
    message
  ].filter((item) => item && typeof item === "object");

  for (const candidate of candidates) {
    const usage = normalizeClaudeUsage(candidate);
    if (usage) return usage;
  }
  return null;
}

function normalizeClaudeUsage(input = {}) {
  const usage = input && typeof input === "object" ? input : {};
  const inputTokens = tokenCount(usage.inputTokens ?? usage.input_tokens);
  const cacheCreationTokens = tokenCount(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens);
  const cacheReadTokens = tokenCount(usage.cacheReadInputTokens ?? usage.cache_read_input_tokens);
  const cachedInputTokens = tokenCount(usage.cachedInputTokens ?? usage.cached_input_tokens) || cacheCreationTokens + cacheReadTokens;
  const outputTokens = tokenCount(usage.outputTokens ?? usage.output_tokens);
  const reasoningOutputTokens = tokenCount(
    usage.reasoningOutputTokens ?? usage.reasoning_output_tokens ?? usage.thinkingOutputTokens ?? usage.thinking_output_tokens
  );
  const explicitTotal = tokenCount(usage.totalTokens ?? usage.total_tokens);
  const totalTokens = explicitTotal || inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
  if (!totalTokens) return null;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    modelContextWindow: tokenCount(usage.modelContextWindow ?? usage.model_context_window ?? usage.contextWindowTokens) || null
  };
}

function extractClaudeDelta(message = {}) {
  const delta = message?.delta || message?.message?.delta || message?.event?.delta || {};
  if (typeof delta?.text === "string" && delta.text) return delta.text;
  if (message?.type === "assistant" && typeof message?.text === "string") return "";
  return "";
}

function extractClaudeAssistantText(message = {}) {
  if (typeof message?.message?.content === "string" && message.message.content.trim()) {
    return message.message.content.trim();
  }
  if (Array.isArray(message?.message?.content)) {
    const text = message.message.content
      .filter((item) => item?.type === "text" && typeof item?.text === "string")
      .map((item) => item.text)
      .join("");
    if (text.trim()) return text.trim();
  }
  if (typeof message?.text === "string" && message.text.trim()) return message.text.trim();
  return "";
}

function extractClaudeResultText(message = {}) {
  if (message?.type !== "result") return "";
  if (typeof message?.result === "string" && message.result.trim()) return message.result.trim();
  if (typeof message?.message === "string" && message.message.trim()) return message.message.trim();
  return "";
}

function recoveredThreadPrompt(input = [], currentText = "") {
  const options = Array.isArray(input) ? { history: input, currentText } : input && typeof input === "object" ? input : {};
  const current = String(options.currentText || currentText || "").trim();
  const history = Array.isArray(options.history) ? options.history : [];
  const recoveryContext = normalizeRecoveryContext(options.recoveryContext, options.history);
  const visibleHistory = Array.isArray(history)
    ? history
        .map((message) => ({
          role: message?.role === "assistant" ? "Claude" : "User",
          text: String(message?.text || "").trim()
        }))
        .filter((message) => message.text)
        .slice(-12)
    : [];
  const summary = String(recoveryContext.summary || "").trim();
  if (!summary && visibleHistory.length === 0) return current;

  const lines = [
    "This Echo session is continuing in a fresh Claude Code backend session because native Claude resume was unavailable.",
    "Use the recovered Echo context below to continue the work. Do not ask the user to repeat context unless the recovered context is insufficient for safe execution.",
    "",
    "Recovered Echo context source:",
    recoveryContext.source || "unknown"
  ];
  if (summary) {
    lines.push("", "Echo session summary:", summary);
  }
  if (visibleHistory.length > 0) {
    lines.push("", summary ? "Recent visible messages, as supplemental detail:" : "Recent visible messages:");
    for (const message of visibleHistory) {
      lines.push(`${message.role}: ${message.text}`);
    }
  }
  lines.push("", "Current user message:", current || "(This message only had attachments in the original session.)");
  return lines.join("\n");
}

function normalizeRecoveryContext(input = {}, history = []) {
  const context = input && typeof input === "object" ? input : {};
  const summary = String(context.summary || "").trim().slice(0, 8000);
  const historyMessageCount = Number.isFinite(Number(context.historyMessageCount))
    ? Math.max(0, Number(context.historyMessageCount))
    : Array.isArray(history)
      ? history.length
      : 0;
  const source = String(context.source || "").trim() || (summary ? "echo-session-memory" : historyMessageCount > 0 ? "visible-history" : "current-message-only");
  return {
    source,
    summary,
    sourceSessionId: String(context.sourceSessionId || "").trim(),
    memoryUpdatedAt: String(context.memoryUpdatedAt || "").trim(),
    historyMessageCount
  };
}

function recoveryEventText(context = {}) {
  const source = context.source === "echo-session-memory" ? "Echo session memory" : context.source === "visible-history" ? "visible Echo history" : "the current message";
  return `Claude Code native resume was unavailable; Echo rebuilt context from ${source}.`;
}

function recoveryEventMetadata(context = {}, error = null) {
  return {
    strategy: "echo-memory-rebuild",
    source: context.source || "current-message-only",
    summaryIncluded: Boolean(context.summary),
    historyMessageCount: Number(context.historyMessageCount || 0) || 0,
    sourceSessionId: context.sourceSessionId || "",
    memoryUpdatedAt: context.memoryUpdatedAt || "",
    resumeError: String(error?.message || error || "").slice(0, 1000)
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
