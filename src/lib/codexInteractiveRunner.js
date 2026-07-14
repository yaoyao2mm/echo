import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { CodexAppServerClient, buildUserInputs } from "./codexAppServerClient.js";
import { formatGitSummary, gitWorkspaceSnapshot, summarizeGitWorkspace } from "./codexGitSummary.js";
import { publicWorkspaces, readCodexRuntimeConfig } from "./codexRunner.js";
import { codexCompatibleModel } from "./codexRuntime.js";
import { httpFetch } from "./http.js";

const maxDownloadedAttachmentBytes = 10 * 1024 * 1024;
const maxAssistantLocalImageArtifactBytes = 10 * 1024 * 1024;
const maxAssistantLocalImageArtifactsPerEvent = 4;
const streamDeltaFlushDelayMs = 80;
const streamDeltaFlushMaxChars = 1200;
const localImagePathPattern = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#][^\s"'<>()[\]]*)?$/i;
const attachmentStagingDirName = "codex-attachment-staging";

export class CodexInteractiveRuntime {
  constructor(options = {}) {
    this.agentId = options.agentId || "default-agent";
    this.onEvents = options.onEvents || (async () => {});
    this.requestApproval = options.requestApproval || defaultApprovalHandler;
    this.requestInteraction = options.requestInteraction || defaultInteractionHandler;
    this.client = null;
    this.sessions = new Map();
    this.threadToSession = new Map();
    this.activeTurns = new Map();
    this.attachmentDirs = new Map();
    this.eventFlushes = new Map();
    this.deltaBuffers = new Map();
    this.turnGitBaselines = new Map();
    this.threadCollaborationModes = new Map();
    this.completedTurns = new Map();
    this.explicitCompactionThreads = new Set();
    this.completedExplicitCompactionTurns = new Map();
    this.collaborationModePresets = null;
    this.collaborationModeUnavailable = false;
    this.expectedClientCloses = new WeakSet();
    this.codexConfigFingerprint = "";
    this.attachmentStagingRoot = path.join(config.dataDir, attachmentStagingDirName, sanitizePathSegment(this.agentId));
    this.attachmentStagingReady = prepareAttachmentStagingRoot(this.attachmentStagingRoot).catch((error) => {
      console.error(`[codex attachment recovery] ${error.message}`);
      throw error;
    });
  }

  async handleCommand(command) {
    await this.attachmentStagingReady;
    try {
      return await this.#handleCommandWithClient(command);
    } catch (error) {
      if (!isCodexAuthRefreshError(error)) throw error;
      this.#restartClientAfterAuthChange();
      return this.#handleCommandWithClient(command);
    }
  }

  async warmup() {
    await this.attachmentStagingReady;
    await this.#ensureClient();
  }

  stop() {
    const cleanup = this.attachmentStagingReady.then(() => this.#cleanupAllAttachmentDirs()).catch((error) => {
      console.error(`[codex attachment cleanup] ${error.message}`);
    });
    if (this.client) this.expectedClientCloses.add(this.client);
    this.client?.stop();
    this.client = null;
    this.sessions.clear();
    this.threadToSession.clear();
    this.activeTurns.clear();
    this.turnGitBaselines.clear();
    this.threadCollaborationModes.clear();
    this.#clearCompletedTurns();
    this.explicitCompactionThreads.clear();
    this.#clearCompletedExplicitCompactionTurns();
    this.eventFlushes.clear();
    for (const buffer of this.deltaBuffers.values()) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }
    this.deltaBuffers.clear();
    return cleanup;
  }

  async #startSession(command, workspace) {
    const runtime = this.#runtimeFor(command);
    const threadResult = await this.client.request("thread/start", this.#threadConfig(workspace, runtime), 120000);
    const appThreadId = threadResult?.thread?.id;
    if (!appThreadId) throw new Error("Codex app-server did not return a thread id.");

    this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
    await this.#emit(command.sessionId, [
      {
        type: "thread.started",
        text: `Interactive Codex thread started in ${workspace.path}.`,
        appThreadId,
        sessionStatus: "active",
        raw: { method: "thread/start", result: threadResult }
      }
    ]);

    const prompt = String(command.payload?.prompt || "").trim();
    const attachments = Array.isArray(command.payload?.attachments) ? command.payload.attachments : [];
    if (!prompt && attachments.length === 0) {
      return { ok: true, appThreadId, sessionStatus: "active" };
    }

    const turn = await this.#startOrSteerTurn({
      sessionId: command.sessionId,
      threadId: appThreadId,
      text: prompt,
      attachments,
      workspace,
      runtime,
      mode: command.payload?.mode,
      hadPlanMode: commandPayloadHadPlanMode(command.payload),
      commandId: command.id
    });
    return this.#turnCommandResult(appThreadId, turn);
  }

  async #handleCommandWithClient(command) {
    this.#refreshCodexConfig();
    const workspace = this.#workspaceFor(command);
    this.#rememberCommand(command);
    if (command.type === "archive") return this.#archiveThread(command, workspace);

    await this.#ensureClient();

    if (command.type === "start") return this.#startSession(command, workspace);
    if (command.type === "message") return this.#sendMessage(command, workspace);
    if (command.type === "stop") return this.#stopTurn(command);
    if (command.type === "compact") return this.#compactThread(command, workspace);
    throw new Error(`Unsupported Codex session command: ${command.type}`);
  }

  #restartClientAfterAuthChange() {
    this.#cleanupAllAttachmentDirs().catch((error) => {
      console.error(`[codex attachment cleanup] ${error.message}`);
    });
    if (this.client) this.expectedClientCloses.add(this.client);
    this.client?.stop();
    this.client = null;
    this.sessions.clear();
    this.threadToSession.clear();
    this.activeTurns.clear();
    this.turnGitBaselines.clear();
    this.threadCollaborationModes.clear();
    this.#clearCompletedTurns();
    this.explicitCompactionThreads.clear();
    this.#clearCompletedExplicitCompactionTurns();
  }

  #refreshCodexConfig() {
    const codexConfig = readCodexRuntimeConfig();
    if (!this.codexConfigFingerprint) {
      this.codexConfigFingerprint = codexConfig.fingerprint;
      return codexConfig;
    }
    if (codexConfig.fingerprint !== this.codexConfigFingerprint) {
      this.#restartClientAfterAuthChange();
      this.collaborationModePresets = null;
      this.collaborationModeUnavailable = false;
      this.codexConfigFingerprint = codexConfig.fingerprint;
    }
    return codexConfig;
  }

  async #sendMessage(command, workspace) {
    const runtime = this.#runtimeFor(command);
    let thread = await this.#ensureThread(command, workspace, runtime);
    const rawText = String(command.payload?.text || "").trim();
    const attachments = Array.isArray(command.payload?.attachments) ? command.payload.attachments : [];
    if (!rawText && attachments.length === 0) throw new Error("Codex session message is empty.");

    try {
      const turn = await this.#startOrSteerTurn({
        sessionId: command.sessionId,
        threadId: thread.appThreadId,
        text: thread.recovered ? recoveredThreadPrompt(command.payload?.history, rawText) : rawText,
        attachments,
        workspace,
        runtime,
        mode: command.payload?.mode,
        hadPlanMode: commandPayloadHadPlanMode(command.payload),
        commandId: command.id
      });
      return this.#turnCommandResult(thread.appThreadId, turn);
    } catch (error) {
      if (!isThreadNotFoundError(error) || thread.recovered) throw error;
      thread = await this.#startReplacementThread(command, workspace, runtime, error);
      const turn = await this.#startOrSteerTurn({
        sessionId: command.sessionId,
        threadId: thread.appThreadId,
        text: recoveredThreadPrompt(command.payload?.history, rawText),
        attachments,
        workspace,
        runtime,
        mode: command.payload?.mode,
        hadPlanMode: commandPayloadHadPlanMode(command.payload),
        commandId: command.id
      });
      return this.#turnCommandResult(thread.appThreadId, turn);
    }
  }

  async #stopTurn(command) {
    const appThreadId = command.appThreadId || this.sessions.get(command.sessionId)?.appThreadId;
    const activeTurnId = command.activeTurnId || (appThreadId ? this.activeTurns.get(appThreadId) : "");
    if (!appThreadId || !activeTurnId) {
      if (appThreadId) await this.#cleanupAttachmentDir(appThreadId);
      return { ok: true, sessionStatus: "active" };
    }
    try {
      await this.client.request("turn/interrupt", { threadId: appThreadId, turnId: activeTurnId }, 30000);
    } finally {
      this.activeTurns.delete(appThreadId);
      await this.#cleanupAttachmentDir(appThreadId);
    }
    await this.#emit(command.sessionId, [
      {
        type: "turn.interrupted",
        text: "Codex turn interrupted from mobile.",
        appThreadId,
        clearActiveTurnId: true,
        sessionStatus: "active",
        raw: { method: "turn/interrupt", threadId: appThreadId, turnId: activeTurnId }
      }
    ]);
    return { ok: true, appThreadId, sessionStatus: "active" };
  }

  async #compactThread(command, workspace) {
    const runtime = this.#runtimeFor(command);
    const thread = await this.#ensureThreadForCompaction(command, workspace, runtime);
    await this.#emit(command.sessionId, [
      {
        type: "context.compaction.started",
        text: "Codex context compaction started.",
        appThreadId: thread.appThreadId,
        sessionStatus: "running",
        raw: { method: "thread/compact/start" }
      }
    ]);
    this.explicitCompactionThreads.add(thread.appThreadId);
    try {
      await this.client.request("thread/compact/start", { threadId: thread.appThreadId }, 60000);
    } catch (error) {
      this.explicitCompactionThreads.delete(thread.appThreadId);
      throw error;
    }
    return { ok: true, appThreadId: thread.appThreadId, sessionStatus: "running" };
  }

  async #archiveThread(command, workspace) {
    const runtime = this.#runtimeFor(command);
    const remembered = this.sessions.get(command.sessionId);
    const appThreadId = String(command.appThreadId || remembered?.appThreadId || "").trim();
    const archived = command.payload?.archived !== false;
    const method = archived ? "thread/archive" : "thread/unarchive";
    if (!appThreadId) {
      await this.#emit(command.sessionId, [
        {
          type: "thread.archive.skipped",
          text: "Codex native archive sync skipped because this Echo session has no local thread id.",
          sessionStatus: "active",
          raw: { method, skipped: true, reason: "missing thread id" }
        }
      ]);
      return { ok: true, sessionStatus: "active" };
    }

    try {
      await this.#ensureClient();
      const result = await this.client.request(method, { threadId: appThreadId }, 30000);
      this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
      await this.#emit(command.sessionId, [
        {
          type: archived ? "thread.archived" : "thread.unarchived",
          text: archived ? "Local Codex thread archived." : "Local Codex thread restored.",
          appThreadId,
          sessionStatus: "active",
          raw: { method, result }
        }
      ]);
    } catch (error) {
      await this.#emit(command.sessionId, [
        {
          type: "thread.archive.sync.failed",
          text: archived ? "Local Codex thread archive sync failed." : "Local Codex thread restore sync failed.",
          appThreadId,
          sessionStatus: "active",
          raw: { method, error: error.message || String(error) }
        }
      ]);
    }

    return { ok: true, appThreadId, sessionStatus: "active" };
  }

  #turnCommandResult(appThreadId, turn = {}) {
    const completed = Boolean(turn.completed);
    return {
      ok: true,
      appThreadId,
      activeTurnId: completed ? null : turn.id,
      sessionStatus: turn.sessionStatus || (completed ? "active" : "running"),
      error: turn.error || ""
    };
  }

  async #startOrSteerTurn({ sessionId, threadId, text, attachments, workspace, runtime, mode, hadPlanMode = false, commandId = "" }) {
    const materialized = await this.#materializeAttachments({ sessionId, threadId, commandId, attachments });
    const preparedAttachments = materialized.items;
    const requestedMode = normalizeSessionMode(mode);
    const inputText = attachmentReferenceText(String(text || "").trim(), preparedAttachments);
    const input = buildUserInputs(inputText, []);
    if (input.length === 0) {
      await this.#cleanupAttachmentPaths(threadId, materialized.stagingDirs);
      throw new Error("Codex turn input is empty.");
    }
    const activeTurnId = this.activeTurns.get(threadId);
    try {
      if (activeTurnId) {
        try {
          const result = await this.client.request(
            "turn/steer",
            {
              threadId,
              input,
              expectedTurnId: activeTurnId
            },
            60000
          );
          const completedTurn = this.#takeCompletedTurn(threadId, activeTurnId);
          await this.#emit(sessionId, [
            {
              type: "turn.steered",
              text: "Message added to the active Codex turn.",
              appThreadId: threadId,
              activeTurnId,
              clearActiveTurnId: Boolean(completedTurn),
              sessionStatus: completedTurn?.sessionStatus || "running",
              raw: { method: "turn/steer", result }
            }
          ]);
          return completedTurn
            ? { id: result?.turnId || activeTurnId, completed: true, sessionStatus: completedTurn.sessionStatus, error: completedTurn.error }
            : { id: result?.turnId || activeTurnId };
        } catch (error) {
          if (!isRecoverableTurnSteerError(error)) throw error;
          this.activeTurns.delete(threadId);
          await this.#emit(sessionId, [
            {
              type: "turn.stale",
              text: "Cleared a stale Codex turn and started a new turn for the follow-up.",
              appThreadId: threadId,
              activeTurnId,
              clearActiveTurnId: true,
              sessionStatus: "active",
              raw: { method: "turn/steer", stale: true, error: error.message || "" }
            }
          ]);
        }
      }

      const turnStartParams = await this.#turnStartParams({
        threadId,
        input,
        cwd: workspace.path,
        runtime,
        mode: requestedMode,
        resetCollaborationMode: hadPlanMode || this.threadCollaborationModes.get(threadId) === "plan"
      });
      const gitBaseline = await gitWorkspaceSnapshot(workspace.path).catch(() => null);
      let result;
      let recordedTurnStartParams = turnStartParams;
      try {
        result = await this.client.request("turn/start", turnStartParams.params, 60000);
      } catch (error) {
        if (turnStartParams.collaborationMode === "execute") {
          throw error;
        }
        if (!turnStartParams.nativePlan) throw error;
        this.collaborationModeUnavailable = true;
        const fallbackInput = buildUserInputs(promptForSessionMode(inputText, requestedMode), []);
        result = await this.client.request(
          "turn/start",
          this.#baseTurnStartParams({
            threadId,
            input: fallbackInput,
            cwd: workspace.path,
            runtime
          }),
          60000
        );
        await this.#emit(sessionId, [
          {
            type: "plan.mode.fallback",
            text: `Native Codex plan mode was unavailable; Echo used planning instructions instead. ${error.message || ""}`.trim(),
            appThreadId: threadId,
            raw: { method: "turn/start", mode: "plan", fallback: true, error: error.message || "" }
          }
        ]);
        recordedTurnStartParams = { ...turnStartParams, collaborationMode: "" };
      }
      const turnId = result?.turn?.id;
      if (!turnId) throw new Error("Codex app-server did not return a turn id.");
      const completedTurn = this.#takeCompletedTurn(threadId, turnId);
      if (completedTurn) {
        await this.#waitForCompletedTurnEvents(completedTurn);
        this.#recordThreadCollaborationMode(threadId, recordedTurnStartParams);
        return { id: turnId, completed: true, sessionStatus: completedTurn.sessionStatus, error: completedTurn.error };
      }
      this.activeTurns.set(threadId, turnId);
      if (gitBaseline) this.turnGitBaselines.set(turnGitBaselineKey(threadId, turnId), gitBaseline);
      this.#recordThreadCollaborationMode(threadId, recordedTurnStartParams);
      return { id: turnId };
    } catch (error) {
      await this.#cleanupAttachmentPaths(threadId, materialized.stagingDirs);
      throw error;
    }
  }

  async #turnStartParams({ threadId, input, cwd, runtime, mode, resetCollaborationMode = false }) {
    const params = this.#baseTurnStartParams({ threadId, input, cwd, runtime });
    if (mode !== "plan") {
      if (resetCollaborationMode) {
        const collaborationMode = await this.#defaultCollaborationMode(runtime);
        if (collaborationMode) {
          return {
            params: {
              ...params,
              collaborationMode
            },
            nativePlan: false,
            collaborationMode: "execute"
          };
        }
      }
      return { params, nativePlan: false, collaborationMode: "execute" };
    }

    const collaborationMode = await this.#planCollaborationMode(runtime);
    if (!collaborationMode) {
      return {
        params: {
          ...params,
          input: planFallbackInputs(input)
        },
        nativePlan: false,
        collaborationMode: ""
      };
    }

    return {
      params: {
        ...params,
        collaborationMode
      },
      nativePlan: true,
      collaborationMode: "plan"
    };
  }

  #recordThreadCollaborationMode(threadId, turnStartParams = {}) {
    if (!threadId) return;
    if (turnStartParams.collaborationMode === "plan") {
      this.threadCollaborationModes.set(threadId, "plan");
      return;
    }
    if (turnStartParams.collaborationMode === "execute") {
      this.threadCollaborationModes.delete(threadId);
    }
  }

  #baseTurnStartParams({ threadId, input, cwd, runtime }) {
    const request = {
      threadId,
      input,
      cwd,
      approvalPolicy: runtime.approvalPolicy
    };
    if (runtime.model) request.model = runtime.model;
    if (runtime.reasoningEffort) request.effort = runtime.reasoningEffort;
    return request;
  }

  async #planCollaborationMode(runtime) {
    const model = String(runtime?.model || "").trim();
    if (!model || this.collaborationModeUnavailable) return null;

    const preset = await this.#collaborationModePreset("plan");
    if (!preset) return null;
    const effort = normalizeReasoningEffortForCollaboration(
      preset.reasoning_effort ?? preset.reasoningEffort ?? runtime.reasoningEffort ?? "medium"
    );
    return {
      mode: "plan",
      settings: {
        model,
        reasoning_effort: effort || "medium",
        developer_instructions: null
      }
    };
  }

  async #defaultCollaborationMode(runtime) {
    const model = String(runtime?.model || "").trim();
    if (!model || this.collaborationModeUnavailable) return null;

    const preset = await this.#collaborationModePreset("default");
    if (!preset) return null;
    const effort = normalizeReasoningEffortForCollaboration(
      runtime.reasoningEffort ?? runtime.effort ?? preset.reasoning_effort ?? preset.reasoningEffort
    );
    return {
      mode: "default",
      settings: {
        model,
        reasoning_effort: effort || null,
        developer_instructions: null
      }
    };
  }

  async #collaborationModePreset(mode) {
    const presets = await this.#collaborationModePresetMap();
    return presets?.[mode] || null;
  }

  async #collaborationModePresetMap() {
    if (this.collaborationModePresets) return this.collaborationModePresets;
    if (this.collaborationModeUnavailable) return null;
    try {
      const result = await this.client.request("collaborationMode/list", {}, 15000);
      const presets = Array.isArray(result?.data) ? result.data : [];
      const plan =
        presets.find((preset) => String(preset?.mode || "").toLowerCase() === "plan") ||
        presets.find((preset) => String(preset?.name || "").toLowerCase() === "plan") ||
        null;
      const defaultMode =
        presets.find((preset) => String(preset?.mode || "").toLowerCase() === "default") ||
        presets.find((preset) => String(preset?.name || "").toLowerCase() === "default") ||
        null;
      this.collaborationModePresets = { plan, default: defaultMode };
      return this.collaborationModePresets;
    } catch (error) {
      this.collaborationModeUnavailable = true;
      return null;
    }
  }

  async #ensureThread(command, workspace, runtime) {
    if (command.payload?.resetThread) {
      const rememberedThreadId = String(this.sessions.get(command.sessionId)?.appThreadId || "").trim();
      const previousAppThreadId = String(command.appThreadId || rememberedThreadId || "").trim();
      return this.#startReplacementThread(
        { ...command, appThreadId: previousAppThreadId },
        workspace,
        runtime,
        new Error(resetThreadReason(command))
      );
    }

    if (command.appThreadId) {
      if (!this.threadToSession.has(command.appThreadId)) {
        this.#rememberSession(command.sessionId, command.appThreadId, workspace, runtime);
        let resumeResult;
        try {
          resumeResult = await this.client.request(
            "thread/resume",
            {
              threadId: command.appThreadId,
              ...this.#resumeConfig(workspace, runtime)
            },
            120000
          );
        } catch (error) {
          this.#forgetThread(command.appThreadId);
          if (!isThreadNotFoundError(error)) throw error;
          return this.#startReplacementThread(command, workspace, runtime, error);
        }
        await this.#emit(command.sessionId, [
          {
            type: "thread.resumed",
            text: `Interactive Codex thread resumed in ${workspace.path}.`,
            appThreadId: command.appThreadId,
            sessionStatus: "active",
            raw: { method: "thread/resume", result: resumeResult }
          }
        ]);
      }
      this.#rememberSession(command.sessionId, command.appThreadId, workspace, runtime);
      if (command.activeTurnId) this.activeTurns.set(command.appThreadId, command.activeTurnId);
      return { appThreadId: command.appThreadId, recovered: false };
    }

    const remembered = this.sessions.get(command.sessionId);
    if (remembered?.appThreadId) return { appThreadId: remembered.appThreadId, recovered: false };
    if (command.type === "message") {
      return this.#startReplacementThread(command, workspace, runtime, new Error("Codex session has no app-server thread id yet."));
    }

    throw new Error("Codex session has no app-server thread id yet.");
  }

  async #ensureThreadForCompaction(command, workspace, runtime) {
    const remembered = this.sessions.get(command.sessionId);
    const appThreadId = command.appThreadId || remembered?.appThreadId || "";
    if (!appThreadId) throw new Error("Codex session has no app-server thread id yet.");
    if (!this.threadToSession.has(appThreadId)) {
      this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
      try {
        const resumeResult = await this.client.request(
          "thread/resume",
          {
            threadId: appThreadId,
            ...this.#resumeConfig(workspace, runtime)
          },
          120000
        );
        await this.#emit(command.sessionId, [
          {
            type: "thread.resumed",
            text: `Interactive Codex thread resumed in ${workspace.path}.`,
            appThreadId,
            sessionStatus: "active",
            raw: { method: "thread/resume", result: resumeResult }
          }
        ]);
      } catch (error) {
        this.#forgetThread(appThreadId);
        if (!isThreadNotFoundError(error)) throw error;
        throw new Error("Codex thread can no longer be compacted because the local app-server thread was not found.");
      }
    }
    this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
    return { appThreadId };
  }

  async #startReplacementThread(command, workspace, runtime, reason) {
    const previousAppThreadId = String(command.appThreadId || "").trim();
    const recoveredFromSavedHistory = !previousAppThreadId;
    if (previousAppThreadId) {
      this.activeTurns.delete(previousAppThreadId);
      this.threadToSession.delete(previousAppThreadId);
      this.threadCollaborationModes.delete(previousAppThreadId);
      this.#cleanupAttachmentDir(previousAppThreadId).catch((error) => {
        console.error(`[codex attachment cleanup] ${error.message}`);
      });
    }
    const threadResult = await this.client.request("thread/start", this.#threadConfig(workspace, runtime), 120000);
    const appThreadId = threadResult?.thread?.id;
    if (!appThreadId) throw new Error("Codex app-server did not return a replacement thread id.");

    this.#rememberSession(command.sessionId, appThreadId, workspace, runtime);
    await this.#emit(command.sessionId, [
      {
        type: "thread.restarted",
        text: recoveredFromSavedHistory
          ? "This Codex session had no usable local thread; a fresh thread was started from saved history."
          : `Previous Codex thread ${previousAppThreadId} could not be resumed; a fresh thread was started.`,
        appThreadId,
        sessionStatus: "active",
        raw: {
          method: "thread/start",
          reason: reason?.message || "",
          previousAppThreadId,
          recoveredFromSavedHistory,
          result: threadResult
        }
      }
    ]);
    return { appThreadId, recovered: true };
  }

  async #ensureClient() {
    if (this.client?.initialized) return;
    if (this.client) {
      await this.client.start();
      return;
    }

    const client = new CodexAppServerClient();
    this.client = client;
    client.on("notification", (message) => this.#handleNotification(message));
    client.on("serverRequest", (message) => this.#handleServerRequest(message));
    client.on("stderr", (line) => this.#handleStderr(line));
    client.on("close", () => {
      const expectedClose = this.expectedClientCloses.has(client);
      this.expectedClientCloses.delete(client);
      if (!expectedClose) {
        this.#emitAppServerClosed().catch((error) => {
          console.error(`[codex app-server close] ${error.message}`);
        });
      }
      this.#cleanupAllAttachmentDirs().catch((error) => {
        console.error(`[codex attachment cleanup] ${error.message}`);
      });
      this.sessions.clear();
      this.threadToSession.clear();
      this.activeTurns.clear();
      this.turnGitBaselines.clear();
      this.threadCollaborationModes.clear();
      this.#clearCompletedTurns();
      this.explicitCompactionThreads.clear();
      this.#clearCompletedExplicitCompactionTurns();
      for (const buffer of this.deltaBuffers.values()) {
        if (buffer.timer) clearTimeout(buffer.timer);
      }
      this.deltaBuffers.clear();
    });
    client.on("error", (error) => {
      console.error(`[codex app-server] ${error.message}`);
    });
    await client.start();
  }

  async #emitAppServerClosed() {
    const eventsBySession = new Map();
    for (const [threadId, activeTurnId] of this.activeTurns.entries()) {
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) continue;
      const events = eventsBySession.get(sessionId) || [];
      events.push({
        type: "runtime.closed",
        text: "Codex app-server exited while a turn was running.",
        appThreadId: threadId,
        activeTurnId,
        clearActiveTurnId: true,
        sessionStatus: "active",
        error: "Codex app-server exited while a turn was running.",
        raw: { method: "codex/app-server/closed", threadId, turnId: activeTurnId }
      });
      eventsBySession.set(sessionId, events);
    }
    for (const [sessionId, events] of eventsBySession) {
      await this.#emitAfterPendingDeltas(sessionId, events);
    }
  }

  #threadConfig(workspace, runtime) {
    const request = {
      cwd: workspace.path,
      approvalPolicy: runtime.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: normalizeSandboxMode(runtime.sandbox),
      serviceName: "echo-codex",
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };
    if (runtime.model) request.model = runtime.model;
    return request;
  }

  #resumeConfig(workspace, runtime) {
    const request = {
      cwd: workspace.path,
      approvalPolicy: runtime.approvalPolicy,
      approvalsReviewer: "user",
      sandbox: normalizeSandboxMode(runtime.sandbox),
      persistExtendedHistory: false
    };
    if (runtime.model) request.model = runtime.model;
    return request;
  }

  #workspaceFor(commandOrProjectId) {
    const projectId =
      typeof commandOrProjectId === "object" ? String(commandOrProjectId.projectId || "").trim() : String(commandOrProjectId || "").trim();
    const workspace = publicWorkspaces().find((item) => item.id === projectId);
    if (!workspace) {
      throw new Error(`Project is not allowed on this desktop agent: ${projectId}`);
    }
    const execution = typeof commandOrProjectId === "object" && commandOrProjectId.execution ? commandOrProjectId.execution : null;
    const executionPath = String(execution?.path || "").trim();
    if (!executionPath) return workspace;
    const resolvedExecutionPath = path.resolve(executionPath);
    const resolvedWorktreeRoot = path.resolve(config.codex.worktreeRoot || path.join(config.dataDir, "worktrees"));
    if (!isPathInside(resolvedExecutionPath, resolvedWorktreeRoot)) {
      throw new Error("Codex execution path is outside the desktop-controlled worktree root.");
    }
    return {
      ...workspace,
      path: resolvedExecutionPath,
      basePath: workspace.path,
      execution
    };
  }

  #rememberCommand(command) {
    if (!command.appThreadId || !this.threadToSession.has(command.appThreadId)) return;
    this.#rememberSession(command.sessionId, command.appThreadId, this.#workspaceFor(command), this.#runtimeFor(command));
    if (command.activeTurnId) this.activeTurns.set(command.appThreadId, command.activeTurnId);
  }

  #rememberSession(sessionId, appThreadId, workspace, runtime) {
    this.sessions.set(sessionId, { appThreadId, projectId: workspace.id, workspace, runtime });
    this.threadToSession.set(appThreadId, sessionId);
  }

  #forgetThread(appThreadId) {
    const sessionId = this.threadToSession.get(appThreadId);
    this.threadToSession.delete(appThreadId);
    this.activeTurns.delete(appThreadId);
    this.threadCollaborationModes.delete(appThreadId);
    this.#cleanupAttachmentDir(appThreadId).catch((error) => {
      console.error(`[codex attachment cleanup] ${error.message}`);
    });
    if (sessionId && this.sessions.get(sessionId)?.appThreadId === appThreadId) {
      this.sessions.delete(sessionId);
    }
  }

  #rememberCompletedTurn(threadId, turn = {}, eventFlush = null) {
    const key = turnGitBaselineKey(threadId, turn?.id);
    if (!key) return;
    const previous = this.completedTurns.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      this.completedTurns.delete(key);
    }, 30000);
    timer.unref?.();
    this.completedTurns.set(key, {
      sessionStatus: turn?.status === "failed" ? "failed" : "active",
      error: turn?.error?.message || "",
      eventFlush,
      timer
    });
  }

  #takeCompletedTurn(threadId, turnId) {
    const key = turnGitBaselineKey(threadId, turnId);
    if (!key) return null;
    const completed = this.completedTurns.get(key);
    if (!completed) return null;
    if (completed.timer) clearTimeout(completed.timer);
    this.completedTurns.delete(key);
    return completed;
  }

  async #waitForCompletedTurnEvents(completedTurn = {}) {
    if (!completedTurn?.eventFlush) return;
    await completedTurn.eventFlush.catch(() => {});
  }

  #clearCompletedTurns() {
    for (const completed of this.completedTurns.values()) {
      if (completed.timer) clearTimeout(completed.timer);
    }
    this.completedTurns.clear();
  }

  #runtimeFor(command = {}) {
    const remembered = this.sessions.get(command.sessionId)?.runtime || {};
    const runtime = command.runtime && typeof command.runtime === "object" ? command.runtime : remembered;
    const retryOverride = runtime.retryOverride && typeof runtime.retryOverride === "object" ? runtime.retryOverride : {};
    const codexConfig = readCodexRuntimeConfig();
    const modelOverride = codexCompatibleModel(retryOverride.model);
    const reasoningOverride = normalizeReasoningEffortForCollaboration(retryOverride.reasoningEffort || retryOverride.effort);
    const sessionModel = codexCompatibleModel(runtime.model);
    const sessionReasoningEffort = normalizeReasoningEffortForCollaboration(runtime.reasoningEffort || runtime.effort);
    return {
      approvalPolicy: String(runtime.approvalPolicy || config.codex.approvalPolicy || "on-request").trim() || "on-request",
      sandbox: String(runtime.sandbox || config.codex.sandbox || "workspace-write").trim() || "workspace-write",
      model: modelOverride || sessionModel || codexCompatibleModel(codexConfig.model) || null,
      reasoningEffort:
        reasoningOverride || sessionReasoningEffort || String(codexConfig.reasoningEffort || "").trim().toLowerCase() || null
    };
  }

  #handleNotification(message) {
    const threadId = getThreadId(message);
    const sessionId = threadId ? this.threadToSession.get(threadId) : "";
    if (!sessionId) return;

    if (message.method === "turn/completed" && this.#takeCompletedExplicitCompactionTurn(threadId, message)) {
      this.activeTurns.delete(threadId);
      return;
    }

    const explicitCompaction = threadId ? this.explicitCompactionThreads.has(threadId) : false;
    const event = notificationToEvent(message, { explicitCompaction });
    if (!event) return;
    if (explicitCompaction && isCompactionCompletionNotification(message)) {
      this.#rememberCompletedExplicitCompactionTurn(threadId, message);
      this.explicitCompactionThreads.delete(threadId);
    }
    if (message.method === "turn/started") {
      this.activeTurns.set(threadId, message.params?.turn?.id || "");
    }
    if (message.method === "turn/completed") {
      this.activeTurns.delete(threadId);
      const eventFlush = this.#emitTurnCompleted(sessionId, threadId, event);
      this.#rememberCompletedTurn(threadId, message.params?.turn, eventFlush);
      eventFlush.catch((error) => {
        console.error(`[codex app-server event] ${error.message}`);
      });
      return;
    }
    if (bufferedDeltaKey(event)) {
      this.#bufferDeltaEvent(sessionId, event);
      return;
    }
    this.#emitAfterPendingDeltas(sessionId, [event]).catch((error) => {
      console.error(`[codex app-server event] ${error.message}`);
    });
  }

  #handleServerRequest(message) {
    this.#handleServerRequestAsync(message).catch((error) => {
      this.client.reject(message.id, -32603, error.message || "Echo approval handling failed.");
    });
  }

  #rememberCompletedExplicitCompactionTurn(threadId, message = {}) {
    const id = String(threadId || "").trim();
    if (!id) return;
    const turnId = compactionNotificationTurnId(message);
    if (turnId) {
      const key = turnGitBaselineKey(id, turnId);
      const previous = this.completedExplicitCompactionTurns.get(key);
      if (previous?.timer) clearTimeout(previous.timer);
      const timer = setTimeout(() => {
        this.completedExplicitCompactionTurns.delete(key);
      }, 30000);
      timer.unref?.();
      this.completedExplicitCompactionTurns.set(key, { timer });
    }
  }

  #takeCompletedExplicitCompactionTurn(threadId, message = {}) {
    const id = String(threadId || "").trim();
    if (!id) return false;
    const turnId = compactionNotificationTurnId(message);
    const key = turnId ? turnGitBaselineKey(id, turnId) : "";
    if (key && this.completedExplicitCompactionTurns.has(key)) {
      const completed = this.completedExplicitCompactionTurns.get(key);
      if (completed?.timer) clearTimeout(completed.timer);
      this.completedExplicitCompactionTurns.delete(key);
      return true;
    }
    return false;
  }

  #clearCompletedExplicitCompactionTurns() {
    for (const completed of this.completedExplicitCompactionTurns.values()) {
      if (completed?.timer) clearTimeout(completed.timer);
    }
    this.completedExplicitCompactionTurns.clear();
  }

  async #handleServerRequestAsync(message) {
    const threadId = getThreadId(message);
    const sessionId = threadId ? this.threadToSession.get(threadId) : "";
    const fallback = declineApprovalResponse(message.method);
    const userInputFallback = userInputResponseFallback(message.method);
    if (!sessionId || (!fallback && !userInputFallback)) {
      if (fallback) this.client.respond(message.id, fallback);
      else if (userInputFallback) this.client.respond(message.id, userInputFallback);
      else this.client.reject(message.id, -32603, "Echo does not support this interactive request yet.");
      return;
    }

    if (userInputFallback) {
      const interaction = {
        sessionId,
        appRequestId: String(message.id),
        method: message.method,
        kind: "user_input",
        prompt: userInputRequestText(message),
        payload: message.params || {}
      };
      const response = await this.requestInteraction(interaction);
      if (response) {
        this.client.respond(message.id, response);
      } else {
        this.client.respond(message.id, userInputFallback);
      }
      return;
    }

    const approval = {
      sessionId,
      appRequestId: String(message.id),
      method: message.method,
      prompt: approvalRequestText(message),
      payload: message.params || {}
    };
    const response = await this.requestApproval(approval);
    if (response) {
      this.client.respond(message.id, response);
    } else {
      this.client.respond(message.id, fallback);
    }
  }

  #handleStderr(line) {
    if (!/ERROR|WARN/i.test(line)) return;
    console.warn(`[codex app-server] ${line}`);
  }

  async #emit(sessionId, events) {
    return this.#enqueueEventTask(sessionId, () => this.#sendEvents(sessionId, events));
  }

  #enqueueEventTask(sessionId, task) {
    const previous = this.eventFlushes.get(sessionId) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.eventFlushes.set(sessionId, current);
    const cleanup = () => {
      if (this.eventFlushes.get(sessionId) === current) {
        this.eventFlushes.delete(sessionId);
      }
    };
    current.then(cleanup, cleanup);
    return current;
  }

  async #emitAfterPendingDeltas(sessionId, events) {
    const pendingDelta = this.#takePendingDelta(sessionId);
    return this.#enqueueEventTask(sessionId, async () => {
      if (pendingDelta) await this.#sendEvents(sessionId, [pendingDelta]);
      await this.#sendEvents(sessionId, events);
    });
  }

  #bufferDeltaEvent(sessionId, event) {
    const key = bufferedDeltaKey(event);
    if (!key) {
      this.#emitAfterPendingDeltas(sessionId, [event]).catch((error) => {
        console.error(`[codex app-server event] ${error.message}`);
      });
      return;
    }

    const existing = this.deltaBuffers.get(sessionId);
    if (existing && existing.key !== key) {
      this.#flushPendingDelta(sessionId)?.catch((error) => {
        console.error(`[codex app-server event] ${error.message}`);
      });
    }

    const buffer = this.deltaBuffers.get(sessionId);
    if (buffer && buffer.key === key) {
      appendDeltaEvent(buffer.event, event);
      if (String(buffer.event.text || "").length >= streamDeltaFlushMaxChars) {
        this.#flushPendingDelta(sessionId)?.catch((error) => {
          console.error(`[codex app-server event] ${error.message}`);
        });
      }
      return;
    }

    const nextBuffer = {
      key,
      event: cloneDeltaEvent(event),
      timer: setTimeout(() => {
        this.#flushPendingDelta(sessionId)?.catch((error) => {
          console.error(`[codex app-server event] ${error.message}`);
        });
      }, streamDeltaFlushDelayMs)
    };
    this.deltaBuffers.set(sessionId, nextBuffer);
  }

  #flushPendingDelta(sessionId) {
    const pendingDelta = this.#takePendingDelta(sessionId);
    if (!pendingDelta) return null;
    return this.#enqueueEventTask(sessionId, () => this.#sendEvents(sessionId, [pendingDelta]));
  }

  #takePendingDelta(sessionId) {
    const buffer = this.deltaBuffers.get(sessionId);
    if (!buffer) return null;
    this.deltaBuffers.delete(sessionId);
    if (buffer.timer) clearTimeout(buffer.timer);
    return buffer.event;
  }

  async #emitTurnCompleted(sessionId, threadId, event) {
    const pendingDelta = this.#takePendingDelta(sessionId);
    return this.#enqueueEventTask(sessionId, async () => {
      try {
        if (pendingDelta) await this.#sendEvents(sessionId, [pendingDelta]);
        const events = [event];
        try {
          const gitSummary = await this.#gitSummaryEvent(sessionId, threadId, event);
          if (gitSummary) events.push(gitSummary);
        } catch (error) {
          console.error(`[codex git summary] ${error.message}`);
        }
        await this.#sendEvents(sessionId, events);
      } finally {
        await this.#cleanupAttachmentDir(threadId);
      }
    });
  }

  async #sendEvents(sessionId, events) {
    const preparedEvents = await this.#prepareEventsForRelay(sessionId, events);
    if (preparedEvents.length > 0) await this.onEvents(sessionId, preparedEvents);
  }

  async #prepareEventsForRelay(sessionId, events) {
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) return [];
    const workspace = this.sessions.get(sessionId)?.workspace || null;
    const prepared = await Promise.all(list.map((event) => eventWithAssistantLocalImageArtifacts(event, workspace)));
    return prepared.map((event) => redactManagedAttachmentPaths(event, this.attachmentStagingRoot));
  }

  async #gitSummaryEvent(sessionId, threadId, event) {
    const workspacePath = this.sessions.get(sessionId)?.workspace?.path;
    const turnId = event?.raw?.params?.turn?.id || event?.raw?.params?.turnId || event?.activeTurnId || "";
    const baselineKey = turnGitBaselineKey(threadId, turnId);
    const baseline = this.turnGitBaselines.get(baselineKey) || null;
    if (baselineKey) this.turnGitBaselines.delete(baselineKey);
    const summary = await summarizeGitWorkspace(workspacePath, { baseline });
    if (!summary) return null;
    return {
      type: "git.summary",
      text: formatGitSummary(summary),
      appThreadId: threadId,
      raw: {
        source: "desktop-agent",
        gitSummary: summary
      }
    };
  }

  async #materializeAttachments({ sessionId, threadId, commandId, attachments }) {
    const materialized = Array.isArray(attachments)
      ? attachments
          .filter((attachment) => attachment?.type === "localImage" && String(attachment.path || "").trim())
          .map((attachment) => ({
            ...attachment,
            type: "imageReference",
            path: String(attachment.path || "").trim(),
            name: String(attachment.name || "").trim(),
            mimeType: String(attachment.mimeType || "").trim(),
            sizeBytes: Number(attachment.sizeBytes || 0) || 0,
            downloadPath: String(attachment.downloadPath || "").trim()
          }))
      : [];
    const relayAttachments = Array.isArray(attachments) ? attachments.filter((attachment) => ["image", "file"].includes(attachment?.type)) : [];
    if (relayAttachments.length === 0) return { items: materialized, stagingDirs: [] };

    const attachmentDir = await this.#ensureAttachmentDir(sessionId, threadId, commandId);
    try {
      for (const [index, attachment] of relayAttachments.entries()) {
        const content = await loadRelayAttachment(attachment);
        if (!content) continue;
        const filePath = path.join(attachmentDir, buildAttachmentFileName(attachment, index, content.extension));
        await fs.writeFile(filePath, content.buffer, { mode: 0o600 });
        materialized.push({
          type: attachment.type === "image" ? "imageReference" : "fileReference",
          path: filePath,
          name: String(attachment.name || "").trim(),
          mimeType: content.mimeType,
          sizeBytes: content.buffer.length,
          downloadPath: String(attachment.downloadPath || "").trim()
        });
      }
    } catch (error) {
      await this.#cleanupAttachmentPaths(threadId, [attachmentDir]);
      throw error;
    }
    return { items: materialized, stagingDirs: [attachmentDir] };
  }

  async #ensureAttachmentDir(sessionId, threadId, commandId) {
    await this.attachmentStagingReady;
    const commandSegment = `${sanitizePathSegment(commandId || "command")}-${randomUUID()}`;
    const dirPath = path.join(this.attachmentStagingRoot, sanitizePathSegment(sessionId), commandSegment);
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    await assertManagedAttachmentPath(this.attachmentStagingRoot, dirPath);
    const dirs = this.attachmentDirs.get(threadId) || new Set();
    dirs.add(dirPath);
    this.attachmentDirs.set(threadId, dirs);
    return dirPath;
  }

  async #cleanupAttachmentDir(threadId) {
    const dirs = this.attachmentDirs.get(threadId);
    if (!dirs) return;
    await this.#cleanupAttachmentPaths(threadId, Array.from(dirs));
  }

  async #cleanupAttachmentPaths(threadId, dirPaths = []) {
    const dirs = this.attachmentDirs.get(threadId);
    const targets = Array.from(new Set(dirPaths)).filter(Boolean);
    if (dirs) {
      for (const dirPath of targets) dirs.delete(dirPath);
      if (dirs.size === 0) this.attachmentDirs.delete(threadId);
    }
    await Promise.all(targets.map((dirPath) => removeManagedAttachmentStagingPath(this.attachmentStagingRoot, dirPath)));
  }

  async #cleanupAllAttachmentDirs() {
    const threadIds = Array.from(this.attachmentDirs.keys());
    await Promise.all(threadIds.map((threadId) => this.#cleanupAttachmentDir(threadId)));
  }
}

function buildAttachmentFileName(attachment, index, extension) {
  const originalName = String(attachment?.name || "").trim();
  const fallbackKind = attachment?.type === "image" || attachment?.type === "localImage" ? "image" : "attachment";
  const parsed = originalName ? path.parse(originalName).name : `${fallbackKind}-${index + 1}`;
  const baseName = sanitizePathSegment(parsed || `${fallbackKind}-${index + 1}`);
  const safeExtension = String(extension || "bin").replace(/[^a-z0-9]+/gi, "").toLowerCase() || "bin";
  return `${baseName}-${randomUUID()}.${safeExtension}`;
}

function attachmentReferenceText(text, attachments = []) {
  const references = Array.isArray(attachments)
    ? attachments.filter((attachment) => ["imageReference", "fileReference"].includes(attachment?.type) && String(attachment.path || "").trim())
    : [];
  if (references.length === 0) return text;

  const lines = [];
  const normalizedText = String(text || "").trim();
  if (normalizedText) lines.push(normalizedText, "");
  const imageOnly = references.every((attachment) => attachment.type === "imageReference");
  lines.push(imageOnly ? "[Echo image attachments]" : "[Echo attachments]");
  lines.push(
    imageOnly
      ? "Echo cached these images as files/relay references. Do not inline or echo image bytes/base64 in the conversation."
      : "Echo cached these attachments as local files/relay references. Use the local file paths when you need to inspect them."
  );
  if (!imageOnly) lines.push("Do not inline or echo attachment bytes/base64 in the conversation.");
  references.forEach((attachment, index) => {
    const kind = attachment.type === "imageReference" ? "image" : "file";
    const label = oneLine(attachment.name) || `${kind}-${index + 1}`;
    const details = [oneLine(attachment.mimeType), attachment.sizeBytes ? `${attachment.sizeBytes} bytes` : ""].filter(Boolean).join(", ");
    lines.push(`- ${kind}: ${label}${details ? ` (${details})` : ""}`);
    lines.push(`  local file: ${oneLine(attachment.path)}`);
    const downloadPath = oneLine(attachment.downloadPath);
    if (downloadPath) lines.push(`  relay path: ${downloadPath}`);
  });
  return lines.join("\n").trim();
}

function oneLine(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function sanitizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "attachment";
}

async function prepareAttachmentStagingRoot(agentRoot) {
  const dataRoot = path.resolve(config.dataDir);
  const stagingRoot = path.join(dataRoot, attachmentStagingDirName);
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const realDataRoot = await fs.realpath(dataRoot);
  const realStagingRoot = await fs.realpath(stagingRoot);
  if (!isPathInside(realStagingRoot, realDataRoot) || realStagingRoot === realDataRoot) {
    throw new Error("Codex attachment staging root is outside the Echo data directory.");
  }

  await fs.mkdir(agentRoot, { recursive: true, mode: 0o700 });
  await assertManagedAttachmentPath(stagingRoot, agentRoot);
  const entries = await fs.readdir(agentRoot);
  for (const entry of entries) {
    const stalePath = path.join(agentRoot, entry);
    try {
      await removeManagedAttachmentStagingPath(agentRoot, stalePath);
    } catch (error) {
      console.error(`[codex attachment recovery] skipped ${stalePath}: ${error.message}`);
    }
  }
  return agentRoot;
}

async function assertManagedAttachmentPath(rootPath, candidatePath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedCandidate === resolvedRoot || !isPathInside(resolvedCandidate, resolvedRoot)) {
    throw new Error("Refusing to access a Codex attachment path outside the managed staging root.");
  }
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(resolvedRoot), fs.realpath(resolvedCandidate)]);
  if (realCandidate === realRoot || !isPathInside(realCandidate, realRoot)) {
    throw new Error("Refusing to access a Codex attachment realpath outside the managed staging root.");
  }
  return realCandidate;
}

export async function removeManagedAttachmentStagingPath(rootPath, candidatePath) {
  const resolvedCandidate = path.resolve(candidatePath);
  try {
    await fs.lstat(resolvedCandidate);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await assertManagedAttachmentPath(rootPath, resolvedCandidate);
  await fs.rm(resolvedCandidate, { recursive: true, force: true });
  await removeEmptyManagedAttachmentParent(rootPath, path.dirname(resolvedCandidate));
  return true;
}

async function removeEmptyManagedAttachmentParent(rootPath, candidatePath) {
  if (path.resolve(candidatePath) === path.resolve(rootPath)) return;
  try {
    await assertManagedAttachmentPath(rootPath, candidatePath);
    await fs.rmdir(candidatePath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
  }
}

function redactManagedAttachmentPaths(value, rootPath) {
  const root = String(rootPath || "").trim();
  if (!root) return value;
  if (typeof value === "string") {
    return value.split(root).join("[Echo attachment staging]");
  }
  if (Array.isArray(value)) return value.map((item) => redactManagedAttachmentPaths(item, root));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) next[key] = redactManagedAttachmentPaths(child, root);
  return next;
}

function isPathInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function eventWithAssistantLocalImageArtifacts(event = {}, workspace = null) {
  if (!shouldAttachAssistantLocalImages(event)) return event;

  const refs = assistantLocalImageReferences(event);
  if (refs.length === 0) return event;

  const roots = await localImageArtifactRoots(workspace);
  if (roots.length === 0) return event;

  const materialized = await materializeLocalImageReferences(refs, roots);
  if (materialized.artifacts.length === 0) return event;

  const next = {
    ...event,
    raw: cloneJson(event.raw || {})
  };
  const fallbackText = "图片已生成。";
  next.text = cleanLocalImageReferences(next.text, materialized.cleanupRefs, fallbackText);
  if (next.finalMessage) {
    next.finalMessage = cleanLocalImageReferences(next.finalMessage, materialized.cleanupRefs, fallbackText);
  }

  const item = next.raw?.params?.item;
  if (item && typeof item === "object") {
    if (typeof item.text === "string") item.text = cleanLocalImageReferences(item.text, materialized.cleanupRefs, fallbackText);
    if (typeof item.result === "string") item.result = cleanLocalImageReferences(item.result, materialized.cleanupRefs, fallbackText);
  }

  const localArtifacts = materialized.artifacts.map((artifact) => ({
    source: "assistant-local-image",
    label: artifact.label,
    mimeType: artifact.mimeType,
    dataUrl: artifact.dataUrl
  }));
  next.raw.echoLocalImageArtifacts = [
    ...(Array.isArray(next.raw.echoLocalImageArtifacts) ? next.raw.echoLocalImageArtifacts : []),
    ...localArtifacts
  ];
  return next;
}

function shouldAttachAssistantLocalImages(event = {}) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
  const item = raw.params?.item;
  if ((raw.method || event.type) !== "item/completed" || item?.type !== "agentMessage") return false;
  return assistantLocalImageTexts(event).some(maybeContainsLocalImageReference);
}

function assistantLocalImageReferences(event = {}) {
  const refs = [];
  for (const text of assistantLocalImageTexts(event)) {
    refs.push(...localImageReferencesFromText(text));
  }
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.kind}\u001f${ref.target}\u001f${ref.matchText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assistantLocalImageTexts(event = {}) {
  const raw = event.raw && typeof event.raw === "object" ? event.raw : {};
  const item = raw.params?.item;
  return [item?.text, item?.result, event.finalMessage, event.text]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function maybeContainsLocalImageReference(value) {
  const text = String(value || "");
  return /\.(?:png|jpe?g|gif|webp|avif|svg)\b/i.test(text) && (text.includes("/") || /file:\/\//i.test(text) || text.includes("]("));
}

function localImageReferencesFromText(value) {
  const text = String(value || "");
  const refs = [];

  const addRef = (kind, match, label, target) => {
    const normalizedTarget = normalizeLocalImageTarget(target);
    if (!normalizedTarget) return;
    refs.push({
      kind,
      matchText: match[0],
      index: match.index,
      label: String(label || "").trim(),
      target: normalizedTarget
    });
  };

  const markdownImage = /!\[([^\]]*)]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of text.matchAll(markdownImage)) {
    addRef("markdownImage", match, match[1], match[2]);
  }

  const markdownLink = /\[([^\]]*)]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  for (const match of text.matchAll(markdownLink)) {
    if (text[Math.max(0, match.index - 1)] === "!") continue;
    addRef("markdownLink", match, match[1], match[2]);
  }

  const barePath = /(?:file:\/\/\/?|\/)[^\s"'<>()[\]]+\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#][^\s"'<>()[\]]*)?/gi;
  for (const match of text.matchAll(barePath)) {
    if (refs.some((ref) => rangesOverlap(ref.index, ref.matchText.length, match.index, match[0].length))) continue;
    addRef("barePath", match, "", match[0]);
  }

  return refs.sort((a, b) => a.index - b.index).slice(0, 16);
}

function rangesOverlap(leftStart, leftLength, rightStart, rightLength) {
  return leftStart < rightStart + rightLength && rightStart < leftStart + leftLength;
}

function normalizeLocalImageTarget(value) {
  let target = String(value || "").trim();
  if (!target) return "";
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
  if (/^(?:https?|data|blob):/i.test(target) || target.startsWith("/api/codex/")) return "";
  if (/^file:/i.test(target)) {
    try {
      target = fileURLToPath(target);
    } catch {
      return "";
    }
  }
  target = target.replace(/[?#].*$/, "");
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the original path if it was not URI encoded.
  }
  return target;
}

async function localImageArtifactRoots(workspace = {}) {
  const candidates = [workspace?.path, workspace?.basePath].map((item) => String(item || "").trim()).filter(Boolean);
  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const realPath = await fs.realpath(resolved).catch(() => "");
    if (realPath) roots.push({ path: resolved, realPath });
  }
  return roots;
}

async function materializeLocalImageReferences(refs = [], roots = []) {
  const artifacts = [];
  const cleanupRefs = [];
  const seenRealPaths = new Set();

  for (const ref of refs) {
    const image = await readAllowedLocalImageReference(ref, roots);
    if (!image) continue;
    if (seenRealPaths.has(image.realPath)) {
      cleanupRefs.push({ ...ref, label: image.label });
      continue;
    }
    if (artifacts.length >= maxAssistantLocalImageArtifactsPerEvent) continue;

    seenRealPaths.add(image.realPath);
    cleanupRefs.push({ ...ref, label: image.label });
    artifacts.push({
      label: image.label,
      mimeType: image.mimeType,
      dataUrl: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`
    });
  }

  return { artifacts, cleanupRefs };
}

async function readAllowedLocalImageReference(ref = {}, roots = []) {
  const rawPath = String(ref.target || "").trim();
  if (!rawPath || roots.length === 0 || !localImagePathPattern.test(rawPath)) return null;

  const resolvedPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(roots[0].path, rawPath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0 || stat.size > maxAssistantLocalImageArtifactBytes) return null;

  const realPath = await fs.realpath(resolvedPath).catch(() => "");
  if (!realPath || !roots.some((root) => isPathInside(realPath, root.realPath))) return null;

  const buffer = await fs.readFile(realPath).catch(() => null);
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0 || buffer.length > maxAssistantLocalImageArtifactBytes) return null;
  const mimeType = imageMimeTypeFromBuffer(buffer);
  if (!mimeType) return null;

  return {
    realPath,
    mimeType,
    buffer,
    label: localImageLabel(ref, resolvedPath)
  };
}

function localImageLabel(ref = {}, filePath = "") {
  const label = oneLine(ref.label);
  if (label && !label.includes("/") && !label.includes("\\") && label.length <= 120) return label;
  return path.basename(filePath) || "Assistant image";
}

function cleanLocalImageReferences(value, refs = [], fallback = "") {
  let text = String(value || "");
  if (!text) return text;

  for (const ref of [...refs].sort((a, b) => b.matchText.length - a.matchText.length)) {
    const replacement = ref.kind === "markdownImage" ? "" : ref.label || "图片";
    text = text.split(ref.matchText).join(replacement);
  }

  const cleaned = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => !/^\s*(?:文件位置|文件路径|路径|file(?: location)?|path)\s*[:：]?\s*$/i.test(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || fallback;
}

function imageMimeTypeFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  const header6 = buffer.subarray(0, 6).toString("ascii");
  if (header6 === "GIF87a" || header6 === "GIF89a") return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  const prefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString("utf8").trimStart().toLowerCase();
  if (prefix.startsWith("<svg") || (prefix.startsWith("<?xml") && prefix.includes("<svg"))) return "image/svg+xml";
  return "";
}

function cloneJson(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

function parseAttachmentDataUrl(url, attachment = {}) {
  const match = /^data:([^;,]*)(?:;[a-z0-9=.+_-]+)*;base64,([a-z0-9+/=\s]+)$/i.exec(String(url || "").trim());
  if (!match) return null;
  const mimeType = normalizeAttachmentMimeType(attachment.mimeType || match[1]);
  const base64 = match[2].replace(/\s+/g, "");
  if (!base64) return null;
  if (attachment?.type === "image" && !mimeType.startsWith("image/")) return null;
  return {
    mimeType,
    extension: extensionForAttachment(attachment, mimeType),
    buffer: Buffer.from(base64, "base64")
  };
}

async function loadRelayAttachment(attachment) {
  const dataUrl = String(attachment?.url || "").trim();
  if (dataUrl.startsWith("data:")) return parseAttachmentDataUrl(dataUrl, attachment);
  return downloadRelayAttachment(attachment);
}

async function downloadRelayAttachment(attachment) {
  const url = relayAttachmentUrl(attachment);
  if (!url) return null;

  const response = await httpFetch(url, {
    headers: relayAttachmentHeaders(),
    timeoutMs: config.network.timeoutMs
  });
  if (!response.ok) {
    throw new Error(`Could not download Codex attachment ${attachmentLabel(attachment)}: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxDownloadedAttachmentBytes) {
    throw new Error(`Codex attachment ${attachmentLabel(attachment)} is too large to download.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxDownloadedAttachmentBytes) {
    throw new Error(`Codex attachment ${attachmentLabel(attachment)} is too large to download.`);
  }

  const expectedSha = String(attachment?.sha256 || "").trim().toLowerCase();
  if (expectedSha) {
    const actualSha = createHash("sha256").update(buffer).digest("hex");
    if (actualSha !== expectedSha) {
      throw new Error(`Downloaded Codex attachment ${attachmentLabel(attachment)} did not match its checksum.`);
    }
  }

  let mimeType = normalizeAttachmentMimeType(response.headers.get("content-type") || attachment?.mimeType || "");
  if (attachment?.type === "image") {
    const detectedMimeType = imageMimeTypeFromBuffer(buffer);
    if (detectedMimeType) mimeType = detectedMimeType;
    if (!mimeType.startsWith("image/")) throw new Error(`Codex attachment is not an image: ${mimeType}`);
  }
  return {
    mimeType,
    extension: extensionForAttachment(attachment, mimeType),
    buffer
  };
}

function relayAttachmentHeaders() {
  const headers = {};
  const agentToken = String(config.agent?.token || "").trim();
  const legacyToken = String(config.token || "").trim();
  if (agentToken) headers["X-Echo-Agent-Token"] = agentToken;
  if (legacyToken) headers["X-Echo-Token"] = legacyToken;
  return headers;
}

function relayAttachmentUrl(attachment) {
  const explicitPath = String(attachment?.downloadPath || "").trim();
  const attachmentId = String(attachment?.attachmentId || attachment?.id || "").trim();
  const pathOrUrl = explicitPath || (attachmentId ? `/api/agent/codex/attachments/${encodeURIComponent(attachmentId)}` : "");
  if (!pathOrUrl) return "";
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  if (!config.relayUrl) throw new Error("Cannot download Codex attachment because ECHO_RELAY_URL is not configured.");
  return new URL(pathOrUrl, `${config.relayUrl}/`).toString();
}

function normalizeAttachmentMimeType(value) {
  const mimeType = String(value || "").split(";")[0].trim().toLowerCase();
  if (/^[a-z0-9.+_-]+\/[a-z0-9.+_-]+$/i.test(mimeType)) return mimeType;
  return "application/octet-stream";
}

function attachmentLabel(attachment) {
  return String(attachment?.name || attachment?.attachmentId || attachment?.id || "attachment").trim() || "attachment";
}

function extensionForAttachment(attachment, mimeType) {
  const fromName = path.extname(String(attachment?.name || "").trim()).replace(/^\./, "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
  if (fromName) return fromName.slice(0, 24);
  return extensionFromMimeType(mimeType);
}

function extensionFromMimeType(mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  if (mimeType === "text/plain") return "txt";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/json") return "json";
  if (mimeType === "text/csv") return "csv";
  if (mimeType === "application/zip") return "zip";
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
  if (mimeType === "application/msword") return "doc";
  if (mimeType === "application/vnd.ms-excel") return "xls";
  if (mimeType === "application/vnd.ms-powerpoint") return "ppt";
  return mimeType.split("/")[1]?.replace(/[^a-z0-9.+_-]+/gi, "").slice(0, 24) || "bin";
}

function isThreadNotFoundError(error) {
  return /thread not found|not found.*thread/i.test(String(error?.message || ""));
}

function resetThreadReason(command = {}) {
  const reason = String(command.payload?.resetReason || "").trim();
  if (reason === "backend-switch") return "Echo session switched backend; starting a fresh Codex thread from saved history.";
  if (reason === "assistant-image-artifact") {
    return "Echo session included a generated image; starting a fresh Codex thread from saved text history so image bytes do not stay in model context.";
  }
  return "Echo requested a fresh Codex thread from saved history.";
}

function recoveredThreadPrompt(history = [], currentText = "") {
  const current = String(currentText || "").trim();
  const visibleHistory = Array.isArray(history)
    ? history
        .map((message) => ({
          role: message?.role === "assistant" ? "Codex" : "User",
          text: String(message?.text || "").trim()
        }))
        .filter((message) => message.text)
        .slice(-12)
    : [];
  if (visibleHistory.length === 0) return current;

  const lines = [
    "这是一个从移动端恢复的 Codex 会话。之前的本地 Codex thread 已失效，下面是这次会话中可见的最近上下文，请在此基础上继续。",
    "",
    "最近上下文："
  ];
  for (const message of visibleHistory) {
    lines.push(`${message.role}: ${message.text}`);
  }
  lines.push("", "当前用户消息：", current || "（本条消息只有附件，请结合附件继续。）");
  return lines.join("\n");
}

function normalizeSandboxMode(value) {
  const text = String(value || "workspace-write").trim();
  if (text === "workspaceWrite") return "workspace-write";
  if (text === "dangerFullAccess") return "danger-full-access";
  if (text === "readOnly") return "read-only";
  return text;
}

function getThreadId(message) {
  return message.params?.threadId || message.params?.thread?.id || message.params?.item?.threadId || "";
}

function bufferedDeltaKey(event) {
  const method = event?.raw?.method || event?.type || "";
  if (!isBufferedDeltaMethod(method)) return "";
  const params = event.raw?.params || {};
  const threadId = params.threadId || params.thread?.id || params.item?.threadId || event.appThreadId || "";
  const turnId = params.turnId || params.turn?.id || event.activeTurnId || "";
  const itemId = params.itemId || params.item?.id || "";
  return [method, threadId, turnId, itemId].join("\u001f");
}

function turnGitBaselineKey(threadId, turnId) {
  const thread = String(threadId || "").trim();
  const turn = String(turnId || "").trim();
  return thread && turn ? `${thread}\u001f${turn}` : "";
}

function isRecoverableTurnSteerError(error) {
  return /no active turn to steer|cannot steer a compact turn/i.test(String(error?.message || ""));
}

function isBufferedDeltaMethod(method) {
  return (
    method === "item/agentMessage/delta" ||
    method === "item/plan/delta" ||
    method === "command/exec/outputDelta" ||
    method === "item/commandExecution/outputDelta"
  );
}

function cloneDeltaEvent(event) {
  return {
    ...event,
    raw: event.raw
      ? {
          ...event.raw,
          params: event.raw.params ? { ...event.raw.params } : event.raw.params
        }
      : event.raw
  };
}

function appendDeltaEvent(target, event) {
  const delta = String(event.text || event.raw?.params?.delta || "");
  const finalDelta = String(event.finalMessage || "");
  target.text = `${target.text || ""}${delta}`;
  if (finalDelta) target.finalMessage = `${target.finalMessage || ""}${finalDelta}`;
  if (target.raw?.params) {
    target.raw.params.delta = `${target.raw.params.delta || ""}${delta}`;
  }
}

function notificationToEvent(message, options = {}) {
  const type = message.method || "codex";
  const event = {
    type,
    text: notificationText(message),
    raw: message
  };

  const threadId = getThreadId(message);
  if (threadId) event.appThreadId = threadId;
  if (message.method === "turn/started") {
    event.activeTurnId = message.params?.turn?.id || "";
    event.sessionStatus = "running";
  }
  if (message.method === "turn/completed") {
    event.clearActiveTurnId = true;
    const failed = message.params?.turn?.status === "failed";
    event.sessionStatus = failed ? "failed" : "active";
    event.error = message.params?.turn?.error?.message || "";
  }
  if (message.method === "thread/archived" || message.method === "thread/unarchived") {
    event.sessionStatus = "active";
  }
  if (options.explicitCompaction && isCompactionCompletionNotification(message)) {
    event.explicitCompactionCommand = true;
    event.raw = { ...message, echoExplicitCompactionCommand: true };
    event.clearActiveTurnId = true;
    event.sessionStatus = "active";
  }
  if (message.method === "item/agentMessage/delta") {
    event.finalMessage = message.params?.delta || "";
  }
  if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
    event.finalMessage = message.params.item.text || "";
  }
  return event;
}

function isCompactionCompletionNotification(message = {}) {
  return message.method === "thread/compacted" || (message.method === "item/completed" && message.params?.item?.type === "contextCompaction");
}

function compactionNotificationTurnId(message = {}) {
  return String(message.params?.turn?.id || message.params?.turnId || message.params?.item?.turnId || "").trim();
}

function notificationText(message) {
  const params = message.params || {};
  if (message.method === "item/agentMessage/delta") return params.delta || "";
  if (message.method === "item/plan/delta") return params.delta || "";
  if (message.method === "command/exec/outputDelta") return params.delta || "";
  if (message.method === "item/commandExecution/outputDelta") return params.delta || "";
  if (message.method === "turn/plan/updated") {
    return (params.plan || []).map((item) => `${item.status || "pending"}: ${item.step || ""}`).join("\n");
  }
  if (message.method === "turn/diff/updated") return params.diff || "";
  if (message.method === "turn/completed") {
    const status = params.turn?.status || "completed";
    const error = params.turn?.error?.message;
    return error ? `Turn ${status}: ${error}` : `Turn ${status}.`;
  }
  if (message.method === "thread/compacted") return "Context compaction completed.";
  if (message.method === "thread/archived") return "Local Codex thread archived.";
  if (message.method === "thread/unarchived") return "Local Codex thread restored.";
  if (message.method === "thread/tokenUsage/updated") return tokenUsageText(params.tokenUsage);
  if (message.method === "turn/started") return "Codex turn started.";
  if (message.method === "thread/status/changed") return `Thread status changed: ${JSON.stringify(params.status || {})}`;
  if (message.method === "item/started") return itemLabel(params.item, "started");
  if (message.method === "item/completed") return itemLabel(params.item, "completed");
  return `[${message.method}]`;
}

function tokenUsageText(tokenUsage = {}) {
  const lastTotal = Number(tokenUsage?.last?.totalTokens);
  const contextWindow = Number(tokenUsage?.modelContextWindow);
  if (Number.isFinite(lastTotal) && Number.isFinite(contextWindow) && contextWindow > 0) {
    return `Context usage updated: ${Math.max(0, Math.round(lastTotal))} / ${Math.round(contextWindow)} tokens.`;
  }
  if (Number.isFinite(lastTotal)) return `Context usage updated: ${Math.max(0, Math.round(lastTotal))} tokens.`;
  return "Context usage updated.";
}

function itemLabel(item = {}, fallbackStatus = "") {
  if (item.type === "agentMessage") return item.text || "";
  if (item.type === "plan") return item.text || "";
  if (item.type === "contextCompaction") return "Context compaction completed.";
  if (item.type === "commandExecution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command || "command";
    const output = item.aggregatedOutput ? `\n${item.aggregatedOutput}` : "";
    return `${command} ${item.status || fallbackStatus}${output}`;
  }
  if (item.type === "fileChange") {
    const paths = (item.changes || []).map((change) => change.path).filter(Boolean).join(", ");
    return `File change ${item.status || fallbackStatus}${paths ? `: ${paths}` : ""}`;
  }
  if (item.type === "reasoning") return (item.summary || []).map((part) => part.text || "").filter(Boolean).join("\n");
  return `[${item.type || "item"}.${fallbackStatus}]`;
}

function approvalRequestText(message) {
  if (message.method === "item/commandExecution/requestApproval") {
    const command = Array.isArray(message.params?.command) ? message.params.command.join(" ") : message.params?.command || "command";
    return `Codex requested command approval: ${command}`;
  }
  if (message.method === "item/fileChange/requestApproval") {
    const target = message.params?.grantRoot ? ` for ${message.params.grantRoot}` : "";
    return `Codex requested file-change approval${target}.`;
  }
  return `Codex requested ${message.method}.`;
}

function userInputRequestText(message) {
  const questions = Array.isArray(message.params?.questions) ? message.params.questions : [];
  const first = questions[0] || {};
  const header = String(first.header || "").trim();
  const question = String(first.question || "").trim();
  if (header && question) return `${header}: ${question}`;
  if (question) return question;
  if (header) return header;
  return "Codex requested input.";
}

function declineApprovalResponse(method) {
  if (method === "item/commandExecution/requestApproval") return { decision: "decline" };
  if (method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (method === "execCommandApproval") return { decision: "denied" };
  if (method === "applyPatchApproval") return { decision: "denied" };
  return null;
}

function userInputResponseFallback(method) {
  if (method === "item/tool/requestUserInput" || method === "tool/requestUserInput") return { answers: {} };
  return null;
}

function normalizeSessionMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "plan" ? "plan" : "execute";
}

function commandPayloadHadPlanMode(payload = {}) {
  return (
    payload?.hasPriorPlanMode === true ||
    payload?.priorPlanMode === true ||
    normalizeSessionMode(payload?.previousMode) === "plan" ||
    normalizeSessionMode(payload?.previousComposerMode) === "plan"
  );
}

function promptForSessionMode(text, mode) {
  const normalized = String(text || "").trim();
  if (mode !== "plan" || !normalized) return normalized;
  return [
    "请先进入计划模式，只分析并给出可执行计划。",
    "不要修改文件，不要提交、推送、部署，也不要运行会改变仓库状态的命令。",
    "如果需要验证，请只说明建议运行哪些检查，等待我确认后再执行。",
    "",
    "用户请求：",
    normalized
  ].join("\n");
}

function inputTextFromInputs(input = []) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text || "")
    .filter(Boolean)
    .join("\n");
}

function planFallbackInputs(input = []) {
  const attachments = (Array.isArray(input) ? input : []).filter((item) => item?.type !== "text");
  const text = promptForSessionMode(inputTextFromInputs(input), "plan");
  return text ? [{ type: "text", text, text_elements: [] }, ...attachments] : attachments;
}

function normalizeReasoningEffortForCollaboration(value) {
  const effort = typeof value === "string" ? value : value === null ? "" : String(value || "");
  const normalized = effort.trim().toLowerCase();
  return ["low", "medium", "high", "xhigh", "max"].includes(normalized) ? normalized : "";
}

function isCodexAuthRefreshError(error) {
  const message = String(error?.message || error || "");
  return /access token could not be refreshed|logged out or signed in to another account|sign in again/i.test(message);
}

async function defaultApprovalHandler(approval) {
  return declineApprovalResponse(approval.method);
}

async function defaultInteractionHandler(interaction) {
  return userInputResponseFallback(interaction.method) || {};
}
