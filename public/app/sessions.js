const RUNNING_ACTIVITY_QUIET_MS = 90 * 1000;
const RUNNING_ACTIVITY_STALE_MS = 5 * 60 * 1000;

const SESSION_ARCHIVE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M4 7.5h16M6 7.5v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-10M8 4.5h8a2 2 0 0 1 2 2v1H6v-1a2 2 0 0 1 2-2Z"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.7"
    />
    <path d="M9.5 12h5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.7" />
  </svg>
`;

const SESSION_RESTORE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M4 7.5h16M6 7.5v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-10M8 4.5h8a2 2 0 0 1 2 2v1H6v-1a2 2 0 0 1 2-2Z"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.7"
    />
    <path
      d="M12 16v-5.5m0 0-2.4 2.4m2.4-2.4 2.4 2.4"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.7"
    />
  </svg>
`;

const SESSION_DELETE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7M7 7l.7 12a2 2 0 0 0 2 1.9h4.6a2 2 0 0 0 2-1.9L17 7"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.7"
    />
    <path
      d="M10.5 11v5M14.5 11v5"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-width="1.7"
    />
  </svg>
`;

function sessionArchiveActionIcon(archived) {
  return archived ? SESSION_RESTORE_ICON : SESSION_ARCHIVE_ICON;
}

function compactAssistantBackendName(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (/claude/i.test(normalized)) return "Claude";
  if (/codex/i.test(normalized)) return "Codex";
  return normalized;
}

export function previewProjectSessions(jobs = [], options = {}) {
  const allJobs = Array.isArray(jobs) ? jobs : [];
  const limit = Math.max(1, Number(options.limit || 5) || 5);
  if (options.expanded || allJobs.length <= limit) return allJobs;

  const preview = allJobs.slice(0, limit);
  const selectedSessionId = String(options.selectedSessionId || "").trim();
  if (selectedSessionId && !preview.some((job) => job.id === selectedSessionId)) {
    const selected = allJobs.find((job) => job.id === selectedSessionId);
    if (selected) preview[limit - 1] = selected;
  }
  return preview;
}

export function installSessions(app) {
  const { document, elements, navigator, state, window: windowRef } = app;
  state.conversationRawMessages = state.conversationRawMessages || new Map();

  app.isCodexDownloadPath = function isCodexDownloadPath(value) {
    return /^\/api\/codex\/(?:attachments|artifacts)\//.test(String(value || ""));
  };

  app.authenticatedResourcePath = function authenticatedResourcePath(value) {
    const rawPath = String(value || "").trim();
    if (!rawPath) return "";

    const origin = String(windowRef?.location?.origin || "http://localhost");
    let url;
    try {
      url = new URL(rawPath, origin);
    } catch {
      return rawPath;
    }

    const absoluteInput = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath);
    if (absoluteInput && url.origin !== origin) return rawPath;
    if (!app.isCodexDownloadPath(url.pathname)) return rawPath;

    if (state.token) url.searchParams.set("token", state.token);
    if (state.authEnabled !== false && state.sessionToken) url.searchParams.set("session", state.sessionToken);
    return `${url.pathname}${url.search}${url.hash}`;
  };

  app.conversationAssistantRoleLabel = function conversationAssistantRoleLabel(job = {}) {
    const runtime = job?.runtime && typeof job.runtime === "object" ? job.runtime : {};
    const backendValue = runtime.backendId || runtime.provider || runtime.backendName || runtime.name || "";
    const label = app.backendDisplayName ? app.backendDisplayName(backendValue) : compactAssistantBackendName(backendValue);
    return label || app.activeAgentLabel?.(job) || "agent";
  };

  app.renderAgentMarkdown = function renderAgentMarkdown(text, options = {}) {
    const raw = String(text || "");
    if (!raw) return { html: "", degraded: false, warnings: [] };

    const renderer = app.agentMarkdownRenderer || app.createAgentMarkdownRenderer();
    if (!renderer) {
      return {
        html: app.escapeHtml(raw),
        degraded: true,
        warnings: ["renderer-unavailable"]
      };
    }

    try {
      const source = options.draft ? app.normalizeAgentMarkdownDraft(raw) : raw;
      const parsed = renderer.markdown.render(source, options);
      return {
        html: renderer.sanitizer.sanitize(parsed, app.agentMarkdownSanitizeConfig()),
        degraded: false,
        warnings: []
      };
    } catch {
      return {
        html: app.escapeHtml(raw),
        degraded: true,
        warnings: ["renderer-failed"]
      };
    }
  };

  app.createAgentMarkdownRenderer = function createAgentMarkdownRenderer() {
    if (app.agentMarkdownRendererAttempted) return app.agentMarkdownRenderer || null;
    app.agentMarkdownRendererAttempted = true;

    const markdownItFactory = app.agentMarkdownIt || windowRef.markdownit;
    const sanitizer = app.agentMarkdownSanitizer || windowRef.DOMPurify;
    if (typeof markdownItFactory !== "function" || !sanitizer || typeof sanitizer.sanitize !== "function") {
      app.agentMarkdownRenderer = null;
      return null;
    }

    try {
      const markdown = markdownItFactory({
        html: false,
        linkify: false,
        typographer: false,
        breaks: false
      });
      markdown.validateLink = app.isSafeAgentMarkdownHref;
      app.installAgentMarkdownRules(markdown);
      app.agentMarkdownRenderer = { markdown, sanitizer };
      return app.agentMarkdownRenderer;
    } catch {
      app.agentMarkdownRenderer = null;
      return null;
    }
  };

  app.installAgentMarkdownRules = function installAgentMarkdownRules(markdown) {
    if (!markdown?.renderer?.rules) return;

    const defaultLinkOpen =
      markdown.renderer.rules.link_open ||
      ((tokens, index, options, env, self) => self.renderToken(tokens, index, options));
    markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const href = token.attrGet("href");
      const classified = app.classifyAgentMarkdownLink(href, env);
      if (classified.kind === "workspace-file") {
        token.attrSet("href", `#echo-workspace-file=${encodeURIComponent(classified.reference)}`);
        token.attrJoin("class", "workspace-file-link");
        token.attrSet("title", classified.reference);
      } else if (classified.kind === "external" || classified.kind === "echo-resource") {
        token.attrSet("href", classified.href);
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noreferrer noopener");
      } else if (classified.kind === "fragment") {
        token.attrSet("href", classified.href);
      } else {
        token.attrSet("href", "");
      }
      return defaultLinkOpen(tokens, index, options, env, self);
    };

    markdown.renderer.rules.image = (tokens, index) => {
      const token = tokens[index];
      return app.escapeHtml(token.content || token.attrGet("alt") || "");
    };

    markdown.renderer.rules.fence = (tokens, index) => {
      const token = tokens[index];
      const language = app.safeAgentMarkdownLanguage(token.info || "");
      const languageAttr = language ? ` data-language="${app.escapeHtml(language)}"` : "";
      const classAttr = language ? ` class="language-${app.escapeHtml(language)}"` : "";
      return `<pre class="rich-code-block"${languageAttr}><code${classAttr}>${app.escapeHtml(token.content)}</code></pre>\n`;
    };

    markdown.core.ruler.after("inline", "echo_task_lists", (parserState) => {
      const tokens = parserState.tokens || [];
      for (let index = 2; index < tokens.length; index += 1) {
        const inlineToken = tokens[index];
        if (inlineToken.type !== "inline") continue;
        if (tokens[index - 1]?.type !== "paragraph_open" || tokens[index - 2]?.type !== "list_item_open") continue;
        const match = /^\[([ xX])\]\s+/.exec(inlineToken.content || "");
        if (!match) continue;
        const listItem = tokens[index - 2];
        listItem.attrJoin("class", "rich-task-list-item");
        if (match[1].toLowerCase() === "x") listItem.attrJoin("class", "rich-task-list-item-checked");
        app.stripTaskListMarker(inlineToken, match[0].length);
      }
    });
  };

  app.agentMarkdownSanitizeConfig = function agentMarkdownSanitizeConfig() {
    return {
      ALLOWED_TAGS: [
        "a",
        "blockquote",
        "br",
        "code",
        "del",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "li",
        "ol",
        "p",
        "pre",
        "strong",
        "table",
        "tbody",
        "td",
        "th",
        "thead",
        "tr",
        "ul"
      ],
      ALLOWED_ATTR: ["class", "data-language", "href", "rel", "target", "title"],
      ALLOW_DATA_ATTR: false,
      FORBID_ATTR: ["style"],
      FORBID_TAGS: ["audio", "embed", "iframe", "img", "math", "object", "script", "style", "svg", "video"]
    };
  };

  app.isSafeAgentMarkdownHref = function isSafeAgentMarkdownHref(value) {
    return app.classifyAgentMarkdownLink(value).kind !== "invalid";
  };

  app.classifyAgentMarkdownLink = function classifyAgentMarkdownLink(value, context = {}) {
    const href = String(value || "").trim();
    if (!href) return { kind: "invalid", href: "" };
    if (app.isCodexDownloadPath(href)) return { kind: "echo-resource", href: app.authenticatedResourcePath(href) };
    if (href.startsWith("#")) {
      const fragmentId = href.slice(1);
      return /^[A-Za-z][\w:.-]*$/.test(fragmentId) && document?.getElementById?.(fragmentId)
        ? { kind: "fragment", href }
        : { kind: "invalid", href: "" };
    }
    try {
      const url = new URL(href);
      if (["http:", "https:", "mailto:"].includes(url.protocol)) return { kind: "external", href };
    } catch {
      // Relative values may be workspace references.
    }

    const reference = app.normalizeTranscriptFileLink(href, context);
    return reference ? { kind: "workspace-file", href, reference } : { kind: "invalid", href: "" };
  };

  app.normalizeTranscriptFileLink = function normalizeTranscriptFileLink(value, context = {}) {
    let href = String(value || "").trim();
    if (!href || href.includes("\0") || href.startsWith("//") || href.startsWith("~")) return "";
    try {
      href = decodeURIComponent(href);
    } catch {
      return "";
    }
    const hashLine = /#L(\d+)(?:C\d+)?$/i.exec(href);
    const colonLine = /:(\d+)(?::\d+)?$/.exec(href);
    const suffix = hashLine || colonLine;
    if (suffix) href = href.slice(0, suffix.index);
    href = href.replaceAll("\\", "/");
    if (href.startsWith("/")) {
      const workspacePath = String(context.workspacePath || app.currentWorkspace?.()?.path || "").replaceAll("\\", "/").replace(/\/$/, "");
      if (!workspacePath || (href !== workspacePath && !href.startsWith(`${workspacePath}/`))) return "";
      href = href.slice(workspacePath.length).replace(/^\/+/, "");
    }
    href = href.replace(/^\.\//, "");
    href = href.replace(/\/+$/, "");
    const parts = href.split("/");
    if (!href || parts.some((part) => !part || part === "." || part === "..")) return "";
    const line = suffix ? Number(suffix[1]) : 0;
    return `${parts.join("/")}${line > 0 ? `#L${line}` : ""}`;
  };

  app.safeAgentMarkdownLanguage = function safeAgentMarkdownLanguage(value) {
    const language = String(value || "").trim().split(/\s+/)[0] || "";
    return /^[A-Za-z0-9_+.#-]{1,32}$/.test(language) ? language : "";
  };

  app.stripTaskListMarker = function stripTaskListMarker(inlineToken, markerLength) {
    let remaining = markerLength;
    inlineToken.content = String(inlineToken.content || "").slice(markerLength);
    for (const child of inlineToken.children || []) {
      if (remaining <= 0) break;
      if (child.type !== "text") continue;
      const content = String(child.content || "");
      if (content.length <= remaining) {
        child.content = "";
        remaining -= content.length;
      } else {
        child.content = content.slice(remaining);
        remaining = 0;
      }
    }
  };

  app.normalizeAgentMarkdownDraft = function normalizeAgentMarkdownDraft(text) {
    const source = String(text || "");
    const fenceMatches = source.match(/(^|\n)```/g) || [];
    if (fenceMatches.length % 2 === 1) return `${source}\n\`\`\``;
    return source;
  };

  app.loadCodexJobs = async function loadCodexJobs(options = {}) {
    const projectId = app.currentProjectId();
    if (!projectId) {
      await app.renderProjectSessionList([]);
      state.selectedCodexSession = null;
      state.selectedCodexJobId = "";
      app.closeCodexSessionStream();
      app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
      app.renderEmptySessionDetail({ title: "选择工程", body: "先选择工程，再开始或继续会话。" });
      app.restoreComposerMode?.({ includeSession: false });
      return;
    }

    const params = new URLSearchParams({
      archived: state.showArchivedSessions ? "true" : "false",
      projectId
    });
    const targetAgentId = app.currentTargetAgentId?.() || "";
    if (targetAgentId) params.set("targetAgentId", targetAgentId);
    const data = await app.apiGet(`/api/codex/sessions?${params.toString()}`);
    const jobs = data.items.slice(0, 30);
    await app.renderProjectSessionList(jobs, options);
  };

  app.renderProjectSessionList = async function renderProjectSessionList(jobs, options = {}) {
    app.lastRenderedProjectSessions = Array.isArray(jobs) ? jobs : [];
    elements.codexJobs.innerHTML = "";
    if (jobs.length === 0) {
      const emptyCopy = state.showArchivedSessions ? "还没有归档会话" : "还没有 agent 会话";
      elements.codexJobs.innerHTML = `<div class="empty-state">${app.escapeHtml(emptyCopy)}</div>`;
      state.selectedCodexSession = null;
      if (!state.composingNewSession) {
        state.selectedCodexJobId = "";
        app.closeCodexSessionStream();
        app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
        app.renderEmptySessionDetail({
          title: state.showArchivedSessions ? "归档" : "新会话",
          body: state.showArchivedSessions ? "这里暂时没有归档会话。" : "直接发送，开始新的 agent 会话。"
        });
      }
      return;
    }

    const selectedSessionMatchesProject =
      state.selectedCodexSession?.id === state.selectedCodexJobId &&
      app.sessionBelongsToCurrentProject(state.selectedCodexSession);
    if (state.selectedCodexJobId && !selectedSessionMatchesProject && !jobs.some((job) => job.id === state.selectedCodexJobId)) {
      state.selectedCodexJobId = "";
      state.selectedCodexSession = null;
      app.closeCodexSessionStream();
    }

    if (!state.selectedCodexJobId && !state.composingNewSession && !state.showArchivedSessions) {
      state.selectedCodexJobId = app.preferredSession(jobs)?.id || jobs[0].id;
    } else if (state.selectedCodexJobId && !jobs.some((job) => job.id === state.selectedCodexJobId)) {
      state.selectedCodexJobId =
        state.composingNewSession || state.showArchivedSessions ? "" : app.preferredSession(jobs)?.id || jobs[0].id;
    }

    const projectKey = app.currentWorkspace?.()?.key || app.currentProjectId();
    const expanded = app.projectConversationsExpanded?.(projectKey) || false;
    const visibleJobs = previewProjectSessions(jobs, {
      limit: 5,
      expanded,
      selectedSessionId: state.selectedCodexJobId
    });

    for (const job of visibleJobs) {
      elements.codexJobs.append(app.renderSessionButton(job));
    }
    if (jobs.length > visibleJobs.length || expanded) {
      elements.codexJobs.append(app.renderProjectSessionToggle(jobs.length, visibleJobs.length, expanded, projectKey));
    }

    if (state.selectedCodexJobId) {
      if (options.skipSelectedDetailLoad && state.selectedCodexSession?.id === state.selectedCodexJobId) {
        const selectedSummary = jobs.find((job) => job.id === state.selectedCodexJobId);
        if (selectedSummary) {
          state.selectedCodexSession = app.mergeCodexSessionSummary(state.selectedCodexSession, selectedSummary);
          app.renderSessionStatusRail?.(state.selectedCodexSession);
        }
        app.refreshActiveSessionHeader();
        app.updateComposerAvailability();
        app.updateStopButton();
        return;
      }
      await app.showCodexJob(state.selectedCodexJobId, { keepSelection: true });
      return;
    }

    state.selectedCodexSession = null;
    app.closeCodexSessionStream();
    app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
    app.renderEmptySessionDetail(
      state.showArchivedSessions
        ? { title: "归档", body: "选择一条归档会话查看详情。" }
        : { title: "新会话", body: "直接发送，开始新的 agent 会话。" }
    );
  };

  app.mergeCodexSessionSummary = function mergeCodexSessionSummary(current, summary) {
    if (!current || current.id !== summary?.id) return current || summary;
    const next = {
      ...current,
      ...summary
    };
    for (const key of ["messages", "events", "approvals", "interactions", "attachments", "artifacts"]) {
      if (!Array.isArray(summary[key]) && Array.isArray(current[key])) next[key] = current[key];
    }
    return next;
  };

  app.renderSessionButton = function renderSessionButton(job) {
    const item = document.createElement("div");
    item.dataset.jobId = job.id;
    item.className = "conversation-item";
    item.classList.toggle("active", job.id === state.selectedCodexJobId);
    const archived = Boolean(job.archivedAt);
    item.classList.toggle("archived", archived);
    const pendingInteractionCount = Number(job.pendingInteractionCount || 0);
    const pendingApprovalCount = Number(job.pendingApprovalCount || 0);
    const canArchive =
      !["queued", "starting", "running"].includes(job.status) &&
      !pendingApprovalCount &&
      !pendingInteractionCount &&
      !job.pendingCommandCount;
    const alertText = app.sessionPendingDecisionText(job);
    const archiveActionLabel = archived ? "恢复会话" : "归档会话";
    const canDelete =
      archived &&
      !["queued", "starting", "running"].includes(job.status) &&
      !pendingApprovalCount &&
      !pendingInteractionCount &&
      !job.pendingCommandCount;
    item.innerHTML = `
      <button class="conversation-item-open" type="button">
        <div class="conversation-item-head">
          <strong>${app.escapeHtml(app.jobTitle(job))}</strong>
          <span class="conversation-item-time">${app.escapeHtml(app.formatRelativeTime(app.sessionTime(job)))}</span>
        </div>
        <div class="conversation-item-meta">
          <span class="conversation-item-status ${app.escapeHtml(job.status)}">${app.escapeHtml(app.statusLabel(job.status))}</span>
          <span>${app.escapeHtml(app.sessionProjectLabel(job.projectId, job.targetAgentId))}</span>
        </div>
        <span class="conversation-item-preview">${app.escapeHtml(app.jobPreview(job))}</span>
        ${alertText ? `<span class="conversation-item-alert">${app.escapeHtml(alertText)}</span>` : ""}
      </button>
      <div class="conversation-item-actions">
        <button
          class="conversation-item-action conversation-item-archive"
          type="button"
          aria-label="${archiveActionLabel}"
          title="${archiveActionLabel}"
          ${canArchive ? "" : "disabled"}
        >
          ${sessionArchiveActionIcon(archived)}
        </button>
        ${
          archived
            ? `<button
                class="conversation-item-action conversation-item-delete"
                type="button"
                aria-label="删除归档会话"
                title="删除归档会话"
                ${canDelete ? "" : "disabled"}
              >
                ${SESSION_DELETE_ICON}
              </button>`
            : ""
        }
      </div>
    `;
    item.querySelector(".conversation-item-open").addEventListener("click", () => {
      state.composingNewSession = false;
      app.showCodexJob(job.id);
      app.closeSessionSidebar({ restoreFocus: false });
    });
    item.querySelector(".conversation-item-archive").addEventListener("click", () => app.archiveSession(job.id, !archived));
    item.querySelector(".conversation-item-delete")?.addEventListener("click", () => app.deleteArchivedSession(job));
    return item;
  };

  app.projectConversationsExpanded = function projectConversationsExpanded(projectKey) {
    const key = String(projectKey || "").trim();
    return Boolean(key && state.expandedProjectConversationKeys?.has?.(key));
  };

  app.setProjectConversationsExpanded = function setProjectConversationsExpanded(projectKey, expanded) {
    const key = String(projectKey || "").trim();
    if (!key) return;
    if (!state.expandedProjectConversationKeys) state.expandedProjectConversationKeys = new Set();
    if (expanded) state.expandedProjectConversationKeys.add(key);
    else state.expandedProjectConversationKeys.delete(key);
    app.renderProjectSessionList(app.lastRenderedProjectSessions || [], { skipSelectedDetailLoad: true });
  };

  app.renderProjectSessionToggle = function renderProjectSessionToggle(total, visible, expanded, projectKey) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-session-more";
    button.textContent = expanded ? "收起" : `显示全部 ${total}`;
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    button.addEventListener("click", () => app.setProjectConversationsExpanded(projectKey, !expanded));
    return button;
  };

  app.archiveSession = async function archiveSession(sessionId, archived) {
    try {
      await app.apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/archive`, { archived });
      app.toast(archived ? "已归档" : "已恢复");
      if (sessionId === state.selectedCodexJobId) {
        state.selectedCodexJobId = "";
        state.selectedCodexSession = null;
        app.renderEmptySessionDetail(
          archived ? { title: "已归档", body: "这个会话已移到归档。" } : { title: "已恢复", body: "这个会话已经回到最近列表。" }
        );
      }
      await app.loadCodexJobs();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    }
  };

  app.deleteArchivedSession = async function deleteArchivedSession(session) {
    if (!session?.id || !session.archivedAt) return;
    const confirmed = await app.confirm({
      title: "删除归档会话",
      body: `“${app.jobTitle(session)}”会从归档中永久删除，附件和生成文件也会一起清理。`,
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger"
    });
    if (!confirmed) return;

    try {
      await app.apiPost(`/api/codex/sessions/${encodeURIComponent(session.id)}/delete`, {});
      app.toast("已删除");
      if (session.id === state.selectedCodexJobId) {
        state.selectedCodexJobId = "";
        state.selectedCodexSession = null;
        app.closeCodexSessionStream();
        app.applyRuntimeDraft(state.runtimePreferences, { persist: false, dirty: false });
        app.renderEmptySessionDetail({ title: "归档", body: "这个归档会话已删除。" });
      }
      await app.loadCodexJobs();
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    }
  };

  app.cancelSelectedCodexTurn = async function cancelSelectedCodexTurn() {
    const session = state.selectedCodexSession;
    if (!session?.id || !app.canCancelSession(session)) return;

    elements.stopCodexTurnButton.disabled = true;
    try {
      const data = await app.apiPost(`/api/codex/sessions/${encodeURIComponent(session.id)}/cancel`, {
        reason: "Cancelled from mobile."
      });
      state.selectedCodexSession = data.session || session;
      app.toast("已请求中断");
      app.renderCodexJob(state.selectedCodexSession, { keepSelection: true });
      app.scheduleSessionListRefresh({ delayMs: 250 });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    } finally {
      app.updateStopButton();
    }
  };

  app.canCancelSession = function canCancelSession(session) {
    if (!session || session.archivedAt) return false;
    if (session.status === "queued") return true;
    if (session.status === "starting" || session.status === "running") return true;
    if (Number(session.pendingCommandCount || 0) > 0 && !["cancelled", "closed", "failed", "stale"].includes(session.status)) return true;
    return Boolean(session.activeTurnId);
  };

  app.updateStopButton = function updateStopButton() {
    if (!elements.stopCodexTurnButton) return;
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const canCancel = app.canCancelSession(session);
    const cancelRequested = app.sessionCancelRequested(session);
    elements.stopCodexTurnButton.hidden = !canCancel;
    elements.stopCodexTurnButton.disabled = state.composerBusy || !canCancel || cancelRequested;
    const label = cancelRequested ? `正在中断当前 ${app.conversationAssistantRoleLabel(session)} turn` : "中断当前 turn";
    elements.stopCodexTurnButton.setAttribute("aria-label", label);
    elements.stopCodexTurnButton.setAttribute("title", label);
  };

  app.sessionCancelRequested = function sessionCancelRequested(session) {
    if (!session) return false;
    const events = session.events || [];
    const latestCancel = [...events].reverse().find((event) => event.type === "turn.cancel.requested");
    if (!latestCancel) return false;
    const latestDone = [...events].reverse().find((event) =>
      ["turn.interrupted", "turn/completed", "session.cancelled", "command.failed", "command.completed"].includes(event.type)
    );
    if (!latestDone) return true;
    return Number(latestCancel.id || 0) > Number(latestDone.id || 0);
  };

  app.preferredSession = function preferredSession(jobs) {
    return (
      jobs.find((job) => Number(job.pendingInteractionCount || 0) > 0) ||
      jobs.find((job) => job.pendingApprovalCount > 0) ||
      jobs.find((job) => ["queued", "starting", "running"].includes(job.status)) ||
      jobs.find((job) => job.status === "active") ||
      jobs[0]
    );
  };

  app.sessionPendingDecisionText = function sessionPendingDecisionText(session) {
    const interactionCount = Number(session?.pendingInteractionCount || 0);
    if (interactionCount > 0) return `${interactionCount} 个待选择`;
    const approvalCount = Number(session?.pendingApprovalCount || 0);
    if (approvalCount > 0) return `${approvalCount} 个待审批`;
    return "";
  };

  app.statusLabel = function statusLabel(status) {
    return {
      queued: "等待桌面",
      starting: "启动中",
      active: "可继续",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      closed: "已关闭",
      stale: "已过期"
    }[status] || status || "未知";
  };

  app.showCodexJob = async function showCodexJob(id, options = {}) {
    const previousSessionId = state.selectedCodexSession?.id || state.selectedCodexJobId;
    const switchingSession = Boolean(previousSessionId && previousSessionId !== id);
    state.selectedCodexJobId = id;
    if (options.resetComposerAttachments || switchingSession) {
      app.clearComposerAttachments({ silent: true });
    }
    if (!options.keepSelection) {
      for (const button of elements.codexJobs.querySelectorAll(".conversation-item")) {
        button.classList.toggle("active", button.dataset.jobId === id);
      }
    }
    const data = await app.apiGet(`/api/codex/sessions/${encodeURIComponent(id)}`);
    if (!app.sessionBelongsToCurrentProject(data.session)) {
      state.selectedCodexJobId = "";
      state.selectedCodexSession = null;
      app.closeCodexSessionStream();
      app.renderEmptySessionDetail({ title: "新会话", body: "这个工程还没有打开的会话。" });
      app.updateComposerAvailability();
      return;
    }
    app.openCodexSessionStream(id);
    app.renderCodexJob(data.session, { ...options, previousSessionId, switchingSession });
  };

  app.renderCodexJob = function renderCodexJob(job, options = {}) {
    if (!job?.id) return;
    const previousSessionId = options.previousSessionId || state.selectedCodexSession?.id || state.selectedCodexJobId;
    const switchingSession = options.switchingSession ?? Boolean(previousSessionId && previousSessionId !== job.id);
    const shouldScrollToBottom = options.scrollToBottom !== false && (!state.selectedCodexSession || switchingSession || !options.keepSelection);
    const scrollSnapshot = options.keepSelection ? app.conversationScrollSnapshot() : null;
    const preserveCurrentView = Boolean(options.keepSelection && !switchingSession);
    const forceTopbarVisible = !preserveCurrentView;
    state.selectedCodexJobId = job.id;
    state.selectedCodexSession = job;
    if (Number(job.lastEventId || 0) > 0) state.sessionLastEventIds.set(job.id, Number(job.lastEventId));
    if (!(options.keepSelection && state.runtimeDirty)) {
      app.applyRuntimeDraft(app.runtimeChoiceWithFallback(job.runtime, state.runtimePreferences), {
        persist: false,
        dirty: false
      });
    }
    app.restoreComposerMode?.({ includeSession: true });
    const errorText = app.conversationErrorText(job);
    const timeline = app.buildConversationTimeline(job, errorText);
    const renderSignature = app.sessionRenderSignature(job, errorText, timeline);
    const canSkipDetailRender =
      preserveCurrentView &&
      state.renderedCodexSessionId === job.id &&
      state.renderedCodexSessionSignature === renderSignature;

    if (canSkipDetailRender) {
      app.renderCodexLog(job, errorText);
      app.renderSessionStatusRail(job);
      app.refreshActiveSessionHeader();
      app.updateComposerAvailability();
      app.updateStopButton();
      return;
    }

    elements.codexJobDetail.hidden = false;
    elements.runLog.hidden = false;
    elements.activeSessionTitle.textContent = app.jobTitle(job);
    app.resetConversationRawMessages();
    elements.codexRunSummary.innerHTML = `
      <div class="conversation-thread">
        ${timeline.map((entry) => app.renderConversationEntry(entry)).join("")}
      </div>
    `;
    state.renderedCodexSessionId = job.id;
    state.renderedCodexSessionSignature = renderSignature;
    app.renderSessionStatusRail(job);
    app.renderApprovals(job);
    app.renderCodexLog(job, errorText);
    app.refreshActiveSessionHeader();
    app.updateComposerAvailability();
    app.updateStopButton();
    if (shouldScrollToBottom || app.wasConversationNearBottom(scrollSnapshot)) {
      app.scrollConversationToBottom({ forceTopbarVisible });
    } else if (scrollSnapshot) {
      app.restoreConversationScroll(scrollSnapshot, { forceTopbarVisible });
    } else if (forceTopbarVisible) {
      app.resetTopbarScrollTracking({ forceVisible: true });
    }
  };

  app.openCodexSessionStream = async function openCodexSessionStream(sessionId, options = {}) {
    if (!windowRef.EventSource || !sessionId || state.sessionEventSourceId === sessionId) return;
    app.closeCodexSessionStream({ keepLastEventId: true });

    let ticket = "";
    try {
      const data = await app.apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/events-ticket`, {});
      ticket = String(data.ticket || "");
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.scheduleSessionListRefresh({ delayMs: 0 });
      return;
    }
    if (!ticket || state.selectedCodexJobId !== sessionId) return;

    const lastEventId = options.reconnect ? app.lastKnownSessionEventId(sessionId) : 0;
    const params = new URLSearchParams({ ticket });
    if (lastEventId > 0) params.set("after", String(lastEventId));
    const source = new EventSource(`/api/codex/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`);
    state.sessionEventSource = source;
    state.sessionEventSourceId = sessionId;

    source.addEventListener("open", () => {
      if (state.sessionEventSource !== source) return;
      state.sessionEventReconnectAttempts = 0;
      if (state.codexConnectionState === "error") {
        state.codexConnectionState = state.codexAgentOnline ? "online" : state.codexAgentAvailable ? "syncing" : "waiting";
        app.setTopbarStatus(
          state.codexAgentOnline ? "本机 agent 在线" : state.codexAgentAvailable ? "桌面状态同步中" : "等待桌面 agent",
          state.codexAgentOnline ? "online" : "idle"
        );
        app.updateComposerAvailability();
      }
    });

    source.addEventListener("session", (event) => {
      let data = null;
      try {
        data = JSON.parse(event.data || "{}");
      } catch {
        return;
      }
      const session = data?.session;
      if (!session?.id || session.id !== state.selectedCodexJobId) return;
      const eventId = Number(event.lastEventId || data.lastEventId || session.lastEventId || 0);
      if (Number.isFinite(eventId) && eventId > 0) state.sessionLastEventIds.set(session.id, eventId);
      app.queueCodexSessionStreamRender(session, { partial: Boolean(data.partial) });
    });

    source.onerror = () => {
      if (state.sessionEventSource !== source) return;
      source.close();
      state.sessionEventSource = null;
      state.sessionEventSourceId = "";
      app.scheduleCodexSessionStreamReconnect(sessionId);
      app.scheduleSessionListRefresh({ delayMs: 0 });
    };
  };

  app.scheduleCodexSessionStreamReconnect = function scheduleCodexSessionStreamReconnect(sessionId) {
    if (!sessionId || state.sessionEventReconnectTimer) return;
    const attempts = Math.min(Number(state.sessionEventReconnectAttempts || 0) + 1, 6);
    state.sessionEventReconnectAttempts = attempts;
    const delay = Math.min(30000, 1200 * attempts);
    state.sessionEventReconnectTimer = windowRef.setTimeout(() => {
      state.sessionEventReconnectTimer = null;
      if (state.selectedCodexJobId !== sessionId) return;
      app.openCodexSessionStream(sessionId, { reconnect: true }).catch(() => {
        app.scheduleCodexSessionStreamReconnect(sessionId);
      });
    }, delay);
  };

  app.closeCodexSessionStream = function closeCodexSessionStream(options = {}) {
    if (state.sessionEventSource) {
      state.sessionEventSource.close();
      state.sessionEventSource = null;
    }
    if (state.sessionEventReconnectTimer) {
      windowRef.clearTimeout(state.sessionEventReconnectTimer);
      state.sessionEventReconnectTimer = null;
    }
    if (state.sessionListRefreshTimer) {
      windowRef.clearTimeout(state.sessionListRefreshTimer);
      state.sessionListRefreshTimer = null;
    }
    state.sessionEventSourceId = "";
    if (!options.keepLastEventId && state.selectedCodexJobId) {
      state.sessionLastEventIds.delete(state.selectedCodexJobId);
    }
    if (state.sessionStreamRenderFrame) {
      windowRef.cancelAnimationFrame?.(state.sessionStreamRenderFrame);
      state.sessionStreamRenderFrame = 0;
    }
    state.pendingSessionStreamRender = null;
  };

  app.queueCodexSessionStreamRender = function queueCodexSessionStreamRender(session, options = {}) {
    if (!session?.id) return;
    const pending = state.pendingSessionStreamRender;
    const pendingBase = pending?.session?.id === session.id ? pending.session : null;
    const selectedBase = state.selectedCodexSession?.id === session.id ? state.selectedCodexSession : null;
    const nextSession = options.partial ? app.mergeCodexSessionStreamUpdate(pendingBase || selectedBase, session) : session;
    state.pendingSessionStreamRender = {
      session: nextSession,
      partial: false
    };
    if (state.sessionStreamRenderFrame) return;

    const render = () => {
      state.sessionStreamRenderFrame = 0;
      const pending = state.pendingSessionStreamRender;
      state.pendingSessionStreamRender = null;
      const nextSession = pending?.session;
      if (!nextSession?.id || nextSession.id !== state.selectedCodexJobId) return;
      app.renderCodexJob(nextSession, { keepSelection: true, scrollToBottom: false });
      if (!app.sessionHasPendingWork(nextSession)) app.scheduleSessionListRefresh();
    };

    if (windowRef.requestAnimationFrame) {
      state.sessionStreamRenderFrame = windowRef.requestAnimationFrame(render);
    } else {
      render();
    }
  };

  app.mergeCodexSessionStreamUpdate = function mergeCodexSessionStreamUpdate(current, incoming) {
    if (!current || current.id !== incoming?.id) return incoming;
    return {
      ...current,
      ...incoming,
      messages: Array.isArray(incoming.messages) ? incoming.messages : current.messages || [],
      approvals: Array.isArray(incoming.approvals) ? incoming.approvals : current.approvals || [],
      interactions: Array.isArray(incoming.interactions) ? incoming.interactions : current.interactions || [],
      events: app.mergeCodexSessionEvents(current.events || [], incoming.events || [])
    };
  };

  app.mergeCodexSessionEvents = function mergeCodexSessionEvents(currentEvents, incomingEvents) {
    const merged = [];
    const seen = new Set();
    for (const event of [...currentEvents, ...incomingEvents]) {
      const key = app.sessionEventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(event);
    }
    return app.sortSessionEvents(merged).slice(-160);
  };

  app.sortSessionEvents = function sortSessionEvents(events) {
    return [...(events || [])].sort((a, b) => {
      const leftId = Number(a?.id || 0);
      const rightId = Number(b?.id || 0);
      if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId > 0 && rightId > 0 && leftId !== rightId) {
        return leftId - rightId;
      }
      const leftAt = Date.parse(a?.at || "");
      const rightAt = Date.parse(b?.at || "");
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
      if (Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return -1;
      if (!Number.isFinite(leftAt) && Number.isFinite(rightAt)) return 1;
      return 0;
    });
  };

  app.sessionEventKey = function sessionEventKey(event) {
    if (event?.id) return `id:${event.id}`;
    const raw = event?.raw || {};
    const params = raw.params || {};
    const item = params.item || {};
    return [
      event?.at || "",
      event?.type || "",
      raw.method || "",
      params.threadId || "",
      params.turnId || params.turn?.id || "",
      params.itemId || item.id || "",
      String(event?.text || "").slice(0, 160)
    ].join("\u001f");
  };

  app.lastKnownSessionEventId = function lastKnownSessionEventId(sessionId) {
    const stored = Number(state.sessionLastEventIds.get(sessionId) || 0);
    const session = state.selectedCodexSession?.id === sessionId ? state.selectedCodexSession : null;
    const fromSession = Number(session?.lastEventId || 0);
    const fromEvents = Math.max(0, ...(session?.events || []).map((event) => Number(event.id || 0)).filter(Number.isFinite));
    return Math.max(stored, fromSession, fromEvents);
  };

  app.scheduleSessionListRefresh = function scheduleSessionListRefresh(options = {}) {
    if (state.sessionListRefreshTimer) return;
    const delayMs = Math.max(0, Number(options.delayMs ?? 1200) || 0);
    state.sessionListRefreshTimer = windowRef.setTimeout(() => {
      state.sessionListRefreshTimer = null;
      if (app.canUseWorkbench?.()) {
        app.loadCodexJobs({ skipSelectedDetailLoad: Boolean(state.sessionEventSourceId || state.sessionEventReconnectTimer) }).catch((error) => {
          if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
            app.markCodexConnectionProblem?.("连接中断，当前会话已保留。");
          }
        });
      }
    }, delayMs);
  };

  app.renderCodexLog = function renderCodexLog(job, errorText = "") {
    const lines = [
      `# ${job.status} · ${job.projectId}`,
      errorText ? `ERROR: ${errorText}` : "",
      job.finalMessage ? `\nFinal:\n${job.finalMessage}` : "",
      "\nEvents:",
      ...(job.events || []).slice(-80).map((event) => `${event.at || ""} ${event.type || ""}\n${event.text || ""}`)
    ].filter(Boolean);
    elements.codexLog.textContent = lines.join("\n\n");
  };

  app.conversationScrollTarget = function conversationScrollTarget() {
    return app.usesCompactTopbarMode() ? elements.codexJobDetail : elements.codexRunSummary;
  };

  app.conversationScrollSnapshot = function conversationScrollSnapshot() {
    const target = app.conversationScrollTarget();
    if (!target) return null;
    return {
      scrollTop: target.scrollTop,
      distanceToBottom: Math.max(0, target.scrollHeight - target.clientHeight - target.scrollTop)
    };
  };

  app.wasConversationNearBottom = function wasConversationNearBottom(snapshot) {
    return Boolean(snapshot) && snapshot.distanceToBottom <= 48;
  };

  app.restoreConversationScroll = function restoreConversationScroll(snapshot, options = {}) {
    const forceTopbarVisible = options.forceTopbarVisible !== false;
    const restore = () => {
      const target = app.conversationScrollTarget();
      if (!target) return;
      target.scrollTop = snapshot.scrollTop;
      app.resetTopbarScrollTracking({ forceVisible: forceTopbarVisible });
    };

    windowRef.requestAnimationFrame(() => {
      restore();
      windowRef.requestAnimationFrame(restore);
    });
  };

  app.scrollConversationToBottom = function scrollConversationToBottom(options = {}) {
    const forceTopbarVisible = options.forceTopbarVisible !== false;
    const targets = [elements.codexRunSummary, elements.codexJobDetail].filter(Boolean);
    const scroll = () => {
      for (const target of targets) {
        if (target.hidden) continue;
        target.scrollTop = target.scrollHeight;
      }
      app.resetTopbarScrollTracking({ forceVisible: forceTopbarVisible });
    };

    windowRef.requestAnimationFrame(() => {
      scroll();
      windowRef.requestAnimationFrame(scroll);
    });
  };

  app.renderEmptySessionDetail = function renderEmptySessionDetail({ title, body }) {
    elements.codexJobDetail.hidden = false;
    elements.activeSessionTitle.textContent = title;
    state.renderedCodexSessionId = "";
    state.renderedCodexSessionSignature = "";
    elements.codexApprovals.hidden = true;
    elements.codexApprovals.innerHTML = "";
    state.contextUsageDetailsOpen = false;
    app.renderSessionStatusRail(null);
    app.refreshContextUsageIndicator?.();
    app.restoreComposerMode?.({ includeSession: false });
    app.updateComposerAvailability?.();
    elements.runLog.hidden = true;
    elements.codexLog.textContent = "";
    elements.codexRunSummary.innerHTML = `
      <div class="conversation-thread conversation-thread-empty">
        <div class="thread-welcome">
          <strong>${app.escapeHtml(title)}</strong>
          <p>${app.escapeHtml(body)}</p>
        </div>
      </div>
    `;
    app.refreshActiveSessionHeader();
    app.updateStopButton();
    app.resetTopbarScrollTracking({ forceVisible: true });
  };

  app.renderApprovals = function renderApprovals(session) {
    const approvals = session.approvals || [];
    const interactions = session.interactions || [];
    elements.codexApprovals.hidden = true;
    elements.codexApprovals.innerHTML = "";
    for (const approval of approvals) {
      const node = document.createElement("div");
      node.className = "approval-inline-card thread-decision-card";
      const detail = app.approvalDetail(approval);
      node.innerHTML = `
        <div class="approval-inline-copy">
          <span class="thread-status-pill warn">${app.escapeHtml(app.approvalTitle(session, approval))}</span>
          <p>${app.escapeHtml(approval.prompt || approval.method || `${app.conversationAssistantRoleLabel(session)} 请求审批`)}</p>
          ${
            detail
              ? `<details class="decision-detail">
                  <summary>查看详情</summary>
                  <pre>${app.escapeHtml(detail)}</pre>
                </details>`
              : ""
          }
        </div>
        <div class="approval-actions">
          <button class="secondary" type="button" data-decision="denied">拒绝</button>
          <button class="primary" type="button" data-decision="approved">批准</button>
        </div>
      `;
      for (const button of node.querySelectorAll("button")) {
        button.addEventListener("click", () => app.decideApproval(session.id, approval.id, button.dataset.decision));
      }
      app.appendTranscriptDecisionNode("approval", approval.id, node);
    }
    for (const interaction of interactions) {
      app.appendTranscriptDecisionNode("interaction", interaction.id, app.renderInteractionCard(session, interaction));
    }
  };

  app.appendTranscriptDecisionNode = function appendTranscriptDecisionNode(type, id, node) {
    const targets = elements.codexRunSummary?.querySelectorAll?.(`[data-transcript-decision="${type}"]`) || [];
    const target = [...targets].find((candidate) => String(candidate.dataset?.decisionId || "") === String(id || ""));
    if (target) {
      target.append(node);
      return;
    }
    elements.codexApprovals.hidden = false;
    elements.codexApprovals.append(node);
  };

  app.decideApproval = async function decideApproval(sessionId, approvalId, decision) {
    try {
      await app.apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`, {
        decision
      });
      app.toast(decision === "approved" ? "已批准" : "已拒绝");
      await app.showCodexJob(sessionId, { keepSelection: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    }
  };

  app.approvalTitle = function approvalTitle(session, approval) {
    if (!approval && session?.method) {
      approval = session;
      session = state.selectedCodexSession;
    }
    if (approval.method === "item/commandExecution/requestApproval" || approval.method === "execCommandApproval") {
      return "命令审批";
    }
    if (approval.method === "item/fileChange/requestApproval" || approval.method === "applyPatchApproval") {
      return "文件修改审批";
    }
    return `${app.conversationAssistantRoleLabel(session)} 审批`;
  };

  app.approvalDetail = function approvalDetail(approval) {
    const payload = approval.payload || {};
    if (payload.command) return Array.isArray(payload.command) ? payload.command.join(" ") : String(payload.command);
    if (payload.cwd || payload.reason) return [payload.cwd, payload.reason].filter(Boolean).join("\n");
    if (payload.grantRoot) return String(payload.grantRoot);
    if (payload.changes) return payload.changes.map((change) => change.path || change.kind || "").filter(Boolean).join("\n");
    return JSON.stringify(payload, null, 2).slice(0, 1600);
  };

  app.renderInteractionCard = function renderInteractionCard(session, interaction) {
    const node = document.createElement("div");
    node.className = "approval-inline-card thread-decision-card interaction-inline-card";
    const questions = app.interactionQuestions(interaction);
    const hasStructuredQuestions = Array.isArray(interaction.payload?.questions) && interaction.payload.questions.length > 0;
    node.innerHTML = `
      <div class="approval-inline-copy">
        <span class="thread-status-pill warn">${app.escapeHtml(app.interactionTitle(session, interaction))}</span>
        ${hasStructuredQuestions ? "" : `<p>${app.escapeHtml(interaction.prompt || `${app.conversationAssistantRoleLabel(session)} 需要你的输入`)}</p>`}
      </div>
      <form class="interaction-form">
        <div class="interaction-questions">
          ${questions.map((question) => app.renderInteractionQuestion(question)).join("")}
        </div>
        <div class="approval-actions">
          <button class="secondary" type="button" data-interaction-cancel>取消</button>
          <button class="primary" type="submit">提交</button>
        </div>
      </form>
    `;
    const form = node.querySelector(".interaction-form");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      app.submitInteractionAnswer(session.id, interaction, form);
    });
    form.addEventListener("change", () => app.updateInteractionOtherInputs(form));
    app.updateInteractionOtherInputs(form);
    node.querySelector("[data-interaction-cancel]")?.addEventListener("click", () => {
      app.decideInteraction(session.id, interaction.id, { decision: "cancel" });
    });
    return node;
  };

  app.interactionTitle = function interactionTitle(session, interaction) {
    if (!interaction && session?.method) {
      interaction = session;
      session = state.selectedCodexSession;
    }
    if (interaction.kind === "user_input" || /requestUserInput/i.test(interaction.method || "")) return "需要选择";
    return `${app.conversationAssistantRoleLabel(session)} 请求`;
  };

  app.interactionQuestions = function interactionQuestions(interaction) {
    const payload = interaction.payload || {};
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    return questions.length > 0
      ? questions.slice(0, 3)
      : [
          {
            id: "answer",
            header: "输入",
            question: interaction.prompt || `${app.conversationAssistantRoleLabel(state.selectedCodexSession)} 需要你的输入`,
            options: null
          }
        ];
  };

  app.renderInteractionQuestion = function renderInteractionQuestion(question) {
    const id = app.safeInteractionFieldId(question.id);
    const header = String(question.header || "").trim();
    const prompt = String(question.question || "").trim();
    const options = Array.isArray(question.options) ? question.options : [];
    const secret = Boolean(question.isSecret || question.is_secret);
    const other = Boolean(question.isOther || question.is_other);
    const labelHtml = `
      <div class="interaction-question-copy">
        ${header ? `<strong>${app.escapeHtml(header)}</strong>` : ""}
        ${prompt ? `<span>${app.escapeHtml(prompt)}</span>` : ""}
      </div>
    `;
    if (options.length > 0) {
      const optionHtml = options
        .map((option, index) => {
          const value = String(option.label || "").trim();
          const description = String(option.description || "").trim();
          return `
            <label class="interaction-option">
              <input type="radio" name="${app.escapeHtml(id)}" value="${app.escapeHtml(value)}" ${index === 0 ? "checked" : ""}>
              <span>${app.escapeHtml(value)}</span>
              ${description ? `<small>${app.escapeHtml(description)}</small>` : ""}
            </label>
          `;
        })
        .join("");
      const otherHtml = other
        ? `
          <label class="interaction-option interaction-option-other">
            <input type="radio" name="${app.escapeHtml(id)}" value="__other__">
            <span>其他</span>
          </label>
          <div class="interaction-other-field" data-other-field-for="${app.escapeHtml(id)}" hidden>
            <input class="interaction-other-input" type="${secret ? "password" : "text"}" data-other-for="${app.escapeHtml(id)}" autocomplete="off" disabled>
          </div>
        `
        : "";
      return `
        <div class="interaction-question" data-question-id="${app.escapeHtml(id)}">
          ${labelHtml}
          <div class="interaction-options">${optionHtml}${otherHtml}</div>
        </div>
      `;
    }

    return `
      <label class="interaction-question" data-question-id="${app.escapeHtml(id)}">
        ${labelHtml}
        <input class="interaction-text-input" name="${app.escapeHtml(id)}" type="${secret ? "password" : "text"}" autocomplete="off">
      </label>
    `;
  };

  app.updateInteractionOtherInputs = function updateInteractionOtherInputs(form) {
    for (const input of form.querySelectorAll(".interaction-other-input")) {
      const fieldId = input.dataset.otherFor || "";
      const escapedFieldId = app.cssEscape(fieldId);
      const selected = form.querySelector(`input[type="radio"][name="${escapedFieldId}"]:checked`);
      const active = selected?.value === "__other__";
      input.disabled = !active;
      const field = form.querySelector(`[data-other-field-for="${escapedFieldId}"]`);
      if (field) field.hidden = !active;
    }
  };

  app.submitInteractionAnswer = async function submitInteractionAnswer(sessionId, interaction, form) {
    const answers = app.collectInteractionAnswers(interaction, form);
    if (!answers) return;
    await app.decideInteraction(sessionId, interaction.id, { answers });
  };

  app.collectInteractionAnswers = function collectInteractionAnswers(interaction, form) {
    const answers = {};
    for (const question of app.interactionQuestions(interaction)) {
      const originalId = String(question.id || "answer").trim() || "answer";
      const fieldId = app.safeInteractionFieldId(originalId);
      const escapedFieldId = app.cssEscape(fieldId);
      const selected = form.querySelector(`input[type="radio"][name="${escapedFieldId}"]:checked`);
      let values = [];
      if (selected) {
        if (selected.value === "__other__") {
          const otherValue = form.querySelector(`[data-other-for="${escapedFieldId}"]`)?.value || "";
          values = [otherValue.trim()];
        } else {
          values = [selected.value];
        }
      } else {
        const input = form.querySelector(`[name="${escapedFieldId}"]`);
        values = [String(input?.value || "").trim()];
      }
      values = values.filter(Boolean);
      if (values.length === 0) {
        app.toast("请先完成 agent 的选择");
        return null;
      }
      answers[originalId] = { answers: values };
    }
    return answers;
  };

  app.safeInteractionFieldId = function safeInteractionFieldId(value) {
    return String(value || "answer").trim().replace(/[^A-Za-z0-9_-]/g, "_") || "answer";
  };

  app.cssEscape = function cssEscape(value) {
    if (windowRef.CSS?.escape) return windowRef.CSS.escape(value);
    return String(value || "").replace(/["\\]/g, "\\$&");
  };

  app.decideInteraction = async function decideInteraction(sessionId, interactionId, payload) {
    try {
      await app.apiPost(`/api/codex/sessions/${encodeURIComponent(sessionId)}/interactions/${encodeURIComponent(interactionId)}`, payload);
      app.toast(payload.decision === "cancel" ? "已取消" : "已提交");
      await app.showCodexJob(sessionId, { keepSelection: true });
    } catch (error) {
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
        app.toast(error.message);
      }
    }
  };

  app.runningSessionStatusText = function runningSessionStatusText(session) {
    const agent = app.conversationAssistantRoleLabel(session);
    const quietInfo = app.runningSessionQuietInfo(session);
    if (!quietInfo) return `${agent} 正在处理`;
    if (quietInfo.leaseExpired) return "运行状态待刷新";
    if (quietInfo.stale) return `${agent} 运行中 · ${app.formatDurationShort(quietInfo.elapsedMs)}无新日志`;
    if (quietInfo.quiet) return `${agent} 运行中 · 暂无新日志`;
    return `${agent} 正在处理`;
  };

  app.runningSessionQuietInfo = function runningSessionQuietInfo(session) {
    if (!session || session.status !== "running") return null;
    const lastLogAtMs = app.sessionLastLoggedEventMs(session);
    if (!lastLogAtMs) return null;
    const now = Date.now();
    const elapsedMs = Math.max(0, now - lastLogAtMs);
    const leaseExpiresAtMs = app.timestampMs(session.leaseExpiresAt);
    return {
      elapsedMs,
      quiet: elapsedMs >= RUNNING_ACTIVITY_QUIET_MS,
      stale: elapsedMs >= RUNNING_ACTIVITY_STALE_MS,
      leaseExpired: Boolean(leaseExpiresAtMs && leaseExpiresAtMs < now)
    };
  };

  app.sessionLastLoggedEventMs = function sessionLastLoggedEventMs(session) {
    const candidates = [];
    if (session?.lastEvent?.at) candidates.push(session.lastEvent.at);
    if (session?.contextUsage?.at) candidates.push(session.contextUsage.at);
    for (const event of session?.events || []) {
      if (event?.at) candidates.push(event.at);
    }
    return candidates.reduce((latest, value) => Math.max(latest, app.timestampMs(value)), 0);
  };

  app.timestampMs = function timestampMs(value) {
    const time = new Date(value || "").getTime();
    return Number.isFinite(time) ? time : 0;
  };

  app.formatDurationShort = function formatDurationShort(ms) {
    const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
    if (seconds < 60) return "不到 1 分钟";
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.max(1, Math.round(minutes / 60));
    return `${hours} 小时`;
  };

  app.turnActivityAvailable = function turnActivityAvailable(session) {
    const commandCounts = app.sessionCommandCounts(session);
    return Boolean(
      session &&
        (["queued", "starting", "running"].includes(session.status) ||
          commandCounts.pending > 0 ||
          Number(session.pendingApprovalCount || 0) > 0 ||
          Number(session.pendingInteractionCount || 0) > 0)
    );
  };

  app.turnActivityForSession = function turnActivityForSession(session) {
    if (!session) return null;
    if (!app.turnActivityAvailable(session)) return null;
    const agent = app.conversationAssistantRoleLabel(session);
    const commandCounts = app.sessionCommandCounts(session);
    if (app.sessionCancelRequested(session)) {
      return { state: "queued", text: "正在中断", title: "取消请求已发送到桌面端" };
    }

    const quietInfo = app.runningSessionQuietInfo(session);
    if (Number(session.pendingInteractionCount || 0) > 0) {
      return { state: "approval", text: "等待选择", title: `等待你回答 ${agent} 的结构化问题` };
    }
    if (Number(session.pendingApprovalCount || 0) > 0) {
      return { state: "approval", text: "等待审批", title: `等待你在手机上批准 ${agent} 请求` };
    }
    const queueBlockerActivity = app.queueBlockerActivity(session);
    if (queueBlockerActivity) return queueBlockerActivity;
    if (commandCounts.queued > 0 || session.status === "queued") {
      return { state: "queued", text: "等待桌面接收任务", title: "任务已进入桌面端队列" };
    }
    if (session.status === "starting") {
      return { state: "running", text: `桌面已接收，正在启动 ${agent}`, title: `桌面端已接收任务，正在启动 ${agent}` };
    }
    if (commandCounts.leased > 0 && session.status === "running" && !quietInfo?.quiet) {
      return {
        state: "running",
        text: `桌面已接收，${agent} 正在处理`,
        title: `桌面端已接收任务，正在等待 ${agent} 输出`
      };
    }
    if (session.status === "running") {
      if (quietInfo?.leaseExpired) {
        return {
          state: "queued",
          text: "运行状态待刷新",
          title: "relay 上的运行租约已经过期，正在等待状态刷新"
        };
      }
      if (quietInfo?.stale) {
        const age = app.formatDurationShort(quietInfo.elapsedMs);
        return {
          state: "queued",
          text: `${agent} 运行中 · ${age}无新日志`,
          title: `最近一次 ${agent} 事件是 ${age}前。可能只是模型在思考，也可能需要中断后重试。`
        };
      }
      if (quietInfo?.quiet) {
        return {
          state: "queued",
          text: `${agent} 运行中 · 暂无新日志`,
          title: `${agent} 仍在运行，但最近没有新的日志事件。`
        };
      }
      return { state: "running", text: `${agent} 正在处理这一轮`, title: `${agent} 正在执行当前 turn` };
    }
    return null;
  };

  app.sessionCommandCounts = function sessionCommandCounts(session) {
    if (!session) return { pending: 0, queued: 0, leased: 0 };
    const pending = Number(session.pendingCommandCount || 0) || 0;
    const hasSplitCounts = session.queuedCommandCount !== undefined || session.leasedCommandCount !== undefined;
    if (hasSplitCounts) {
      const queued = Number(session.queuedCommandCount || 0) || 0;
      const leased = Number(session.leasedCommandCount || 0) || 0;
      return { pending: queued + leased || pending, queued, leased };
    }
    if (session.status === "starting" || session.status === "running") {
      return { pending, queued: 0, leased: pending };
    }
    return { pending, queued: pending, leased: 0 };
  };

  app.queueBlockerActivity = function queueBlockerActivity(session) {
    const blocker = session?.queueBlocker && typeof session.queueBlocker === "object" ? session.queueBlocker : null;
    if (!blocker || blocker.type !== "project_busy") return null;

    const title = String(blocker.blockedByTitle || "").trim();
    return {
      state: "queued",
      text: "等待同工程任务完成",
      title: title
        ? `同一工程的主工作目录正在处理「${title}」，当前任务会在它结束后继续。`
        : "同一工程的主工作目录正在处理另一条任务，当前任务会在它结束后继续。"
    };
  };

  app.commandDisplayText = function commandDisplayText(command) {
    const text = Array.isArray(command) ? command.join(" ") : String(command || "后台命令");
    return app.compactActivityText(text.replace(/\s+/g, " ").trim() || "后台命令", 96);
  };

  app.redactActivityText = function redactActivityText(value) {
    return String(value || "").replace(/\b(token|secret|password|api[_-]?key)\b\s*[:=]\s*[^,\s]+/gi, "$1=***");
  };

  app.compactActivityText = function compactActivityText(value, limit = 140) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : text;
  };

  app.renderConversationThread = function renderConversationThread(job, errorText = "") {
    const timeline = app.buildConversationTimeline(job, errorText);
    app.resetConversationRawMessages();
    return timeline.map(app.renderConversationEntry).join("");
  };

  app.sessionRenderSignature = function sessionRenderSignature(job, errorText = "", timeline = null) {
    const entries = timeline || app.buildConversationTimeline(job, errorText);
    return JSON.stringify({
      id: job.id || "",
      status: job.status || "",
      projectId: job.projectId || "",
      archivedAt: job.archivedAt || "",
      pendingApprovalCount: job.pendingApprovalCount || 0,
      pendingInteractionCount: job.pendingInteractionCount || 0,
      pendingUserInputCount: job.pendingUserInputCount || 0,
      pendingCommandCount: job.pendingCommandCount || 0,
      title: app.jobTitle(job),
      errorText,
      timeline: entries.map((entry) => ({
        kind: entry.kind || "",
        role: entry.role || "",
        roleLabel: entry.roleLabel || "",
        text: entry.text || "",
        title: entry.title || "",
        body: entry.body || "",
        at: entry.at || "",
        draft: Boolean(entry.draft),
        parts: (entry.parts || []).map((part) => ({ ...part })),
        attachments: (entry.attachments || []).map((attachment) => ({
          type: attachment?.type || "",
          name: attachment?.name || "",
          id: attachment?.id || "",
          downloadPath: attachment?.downloadPath || ""
        }))
      })),
      approvals: (job.approvals || []).map((approval) => ({
        id: approval.id || "",
        method: approval.method || "",
        prompt: approval.prompt || "",
        title: app.approvalTitle(approval),
        detail: app.approvalDetail(approval)
      })),
      interactions: (job.interactions || []).map((interaction) => ({
        id: interaction.id || "",
        method: interaction.method || "",
        kind: interaction.kind || "",
        prompt: interaction.prompt || "",
        status: interaction.status || "",
        questions: app.interactionQuestions(interaction).map((question) => ({
          id: question.id || "",
          header: question.header || "",
          question: question.question || "",
          isOther: Boolean(question.isOther || question.is_other),
          isSecret: Boolean(question.isSecret || question.is_secret),
          options: (question.options || []).map((option) => ({
            label: option.label || "",
            description: option.description || ""
          }))
        }))
      }))
    });
  };

  app.buildConversationTimeline = function buildConversationTimeline(job, errorText = "") {
    const timeline = [];
    const messages = Array.isArray(job.messages) ? job.messages : [];
    const assistantRoleLabel = app.conversationAssistantRoleLabel(job);

    if (messages.length > 0) {
      const renderedUserKeys = new Set();
      const renderedUserTexts = new Set();
      const renderedAssistantKeys = new Set();
      const renderedAssistantTexts = new Set();
      for (const message of messages) {
        const attachments = app.messageAttachments(message);
        const partText = Array.isArray(message.parts)
          ? message.parts
              .filter((part) => part?.type === "text")
              .map((part) => String(part.text || ""))
              .filter(Boolean)
              .join("\n\n")
          : "";
        const text = app.conversationDisplayText(message.text || partText, { role: message.role, attachments });
        if (!text && attachments.length === 0) continue;
        if (message.role !== "assistant") {
          if (message.externalKey) renderedUserKeys.add(message.externalKey);
          if (text) renderedUserTexts.add(text);
        }
        if (message.role === "assistant") {
          if (message.externalKey) renderedAssistantKeys.add(message.externalKey);
          if (text) renderedAssistantTexts.add(text);
        }
        timeline.push({
          kind: "message",
          role: message.role === "assistant" ? "assistant" : "user",
          roleLabel: message.role === "assistant" ? assistantRoleLabel : "",
          text,
          parts: app.normalizeTranscriptParts(message.parts, { text, role: message.role }),
          attachments,
          at: message.createdAt || job.updatedAt || job.createdAt || "",
          externalKey: message.externalKey || ""
        });
      }

      for (const event of job.events || []) {
        const userEntry = app.userMessageEntryFromEvent(event);
        if (userEntry?.text || userEntry?.attachments?.length) {
          if (userEntry.externalKey && renderedUserKeys.has(userEntry.externalKey)) continue;
          if (!userEntry.externalKey && userEntry.text && renderedUserTexts.has(userEntry.text)) continue;
          if (userEntry.externalKey) renderedUserKeys.add(userEntry.externalKey);
          if (userEntry.text) renderedUserTexts.add(userEntry.text);
          timeline.push(userEntry);
          continue;
        }

        const assistantEntry = app.assistantMessageEntryFromEvent(event);
        if (!assistantEntry?.text && !assistantEntry?.attachments?.length) continue;
        assistantEntry.roleLabel = assistantRoleLabel;
        if (assistantEntry.externalKey && renderedAssistantKeys.has(assistantEntry.externalKey)) {
          app.mergeAssistantTimelineAttachments(timeline, assistantEntry);
          continue;
        }
        if (!assistantEntry.externalKey && renderedAssistantTexts.has(assistantEntry.text)) {
          app.mergeAssistantTimelineAttachments(timeline, assistantEntry);
          continue;
        }
        if (assistantEntry.text && app.lastTimelineMessageText(timeline, "assistant") === assistantEntry.text) {
          if (app.mergeAssistantTimelineAttachments(timeline, assistantEntry)) continue;
          if (!assistantEntry.attachments?.length) continue;
        }
        if (assistantEntry.externalKey) renderedAssistantKeys.add(assistantEntry.externalKey);
        if (assistantEntry.text) renderedAssistantTexts.add(assistantEntry.text);
        timeline.push(assistantEntry);
      }
    } else {
      const events = Array.isArray(job.events) ? job.events : [];

      for (const event of events) {
        const userText = event.type === "user.message" ? String(event.text || "").trim() : "";
        const userAttachments = event.type === "user.message" ? app.userMessageAttachments(event) : [];
        if (userText || userAttachments.length > 0) {
          timeline.push({
            kind: "message",
            role: "user",
            roleLabel: "",
            text: userText,
            attachments: userAttachments,
            at: event.at || job.createdAt || "",
            eventId: Number(event.id || 0) || 0,
            externalKey: app.userMessageExternalKey(event)
          });
          continue;
        }

        const assistantText = app.assistantMessageText(event);
        const assistantAttachments = app.assistantMessageAttachments(event);
        if (!assistantText && assistantAttachments.length === 0) continue;
        if (assistantText && app.lastTimelineMessageText(timeline, "assistant") === assistantText) {
          const assistantEntry = {
            kind: "message",
            role: "assistant",
            roleLabel: assistantRoleLabel,
            text: assistantText,
            attachments: assistantAttachments,
            at: event.at || job.updatedAt || "",
            eventId: Number(event.id || 0) || 0,
            externalKey: app.assistantMessageExternalKey(event)
          };
          if (app.mergeAssistantTimelineAttachments(timeline, assistantEntry)) continue;
          if (assistantAttachments.length === 0) continue;
        }
        timeline.push({
          kind: "message",
          role: "assistant",
          roleLabel: assistantRoleLabel,
          text: assistantText,
          attachments: assistantAttachments,
          at: event.at || job.updatedAt || "",
          eventId: Number(event.id || 0) || 0,
          externalKey: app.assistantMessageExternalKey(event)
        });
      }
    }

    app.appendOperationalTimelineEntries(timeline, job);
    app.sortTimelineEntries(timeline);

    const draftAssistantText = app.activeAssistantDraft(job, timeline);
    if (draftAssistantText) {
      timeline.push({
        kind: "message",
        role: "assistant",
        roleLabel: assistantRoleLabel,
        text: draftAssistantText,
        at: job.updatedAt || job.createdAt || "",
        draft: job.status === "starting" || job.status === "running"
      });
    }

    if (errorText && !timeline.some((entry) => entry.kind === "error" && entry.text === errorText)) {
      timeline.push({
        kind: "error",
        text: errorText,
        at: job.updatedAt || job.createdAt || ""
      });
    }

    if (timeline.length === 0) {
      timeline.push({
        kind: "empty",
        title: "还没有消息",
        body: "从下面发第一句话开始。"
      });
    }

    for (const entry of timeline) app.ensureTimelineEntryParts(entry);
    app.groupConsecutiveToolTimelineEntries(timeline);

    return timeline;
  };

  app.conversationErrorText = function conversationErrorText(job = {}) {
    const error = String(job.error || job.lastError || "").trim();
    if (!error || app.isRestartLifecycleDiagnostic(error)) return "";
    return app.humanizeCodexError(error);
  };

  app.isRestartLifecycleDiagnostic = function isRestartLifecycleDiagnostic(error = "") {
    return /^(Desktop agent did not reconnect within the restart timeout\.|Desktop agent did not finish draining before the restart timeout\.|Desktop agent restart request was not armed before the checkpoint timeout\.|Restarted desktop agent .*revision|Restarted desktop agent did not advertise a source revision\.)$/i.test(String(error).trim());
  };

  app.groupConsecutiveToolTimelineEntries = function groupConsecutiveToolTimelineEntries(timeline) {
    const entries = Array.isArray(timeline) ? timeline : [];
    const grouped = [];
    let pending = [];
    const flush = () => {
      if (pending.length === 1) grouped.push(pending[0]);
      if (pending.length > 1) {
        grouped.push({
          kind: "tool-group",
          parts: pending.flatMap((entry) => entry.parts || []),
          at: pending[0].at || "",
          endedAt: pending.at(-1)?.at || "",
          eventId: pending[0].eventId || 0
        });
      }
      pending = [];
    };
    for (const entry of entries) {
      const parts = Array.isArray(entry?.parts) ? entry.parts : [];
      const isToolEntry = parts.length > 0 && parts.every((part) => ["command", "file-change", "test-result"].includes(part.type));
      if (isToolEntry) {
        pending.push(entry);
        continue;
      }
      flush();
      grouped.push(entry);
    }
    flush();
    entries.splice(0, entries.length, ...grouped);
    return entries;
  };

  app.ensureTimelineEntryParts = function ensureTimelineEntryParts(entry) {
    if (!entry || (Array.isArray(entry.parts) && entry.parts.length > 0)) return entry;
    if (entry.kind === "message") {
      entry.parts = entry.text ? [{ type: "text", text: entry.text, draft: Boolean(entry.draft) }] : [];
    } else if (entry.kind === "plan") {
      entry.parts = [{ type: "status", label: "计划", detail: entry.text || "", status: "info" }];
    } else if (entry.kind === "system") {
      entry.parts = [{ type: "status", label: entry.text || "", status: "info" }];
    } else if (entry.kind === "test") {
      entry.parts = [{
        type: "test-result",
        level: entry.level,
        status: entry.status,
        command: entry.command,
        failures: entry.failures || [],
        outputArtifact: entry.outputArtifact || null
      }];
    }
    return entry;
  };

  app.normalizeTranscriptParts = function normalizeTranscriptParts(parts, options = {}) {
    if (!Array.isArray(parts) || parts.length === 0) return [];
    const normalized = parts
      .map((part) => app.normalizeTranscriptPart(part))
      .filter((part) => part && part.type !== "git-summary")
      .slice(0, 50);
    if (!normalized.some((part) => part.type === "text") && options.text) {
      normalized.unshift({ type: "text", text: String(options.text), draft: false });
    }
    return normalized;
  };

  app.normalizeTranscriptPart = function normalizeTranscriptPart(part) {
    if (!part || typeof part !== "object") return null;
    const type = String(part.type || "");
    if (type === "text") return { type, text: String(part.text || "").slice(0, 12000), draft: Boolean(part.draft) };
    if (type === "command") {
      return {
        type,
        command: app.compactActivityText(part.command, 1000),
        status: app.transcriptExecutionStatus(part.status),
        output: app.boundedTranscriptOutput(part.output),
        outputArtifact: app.normalizeTranscriptArtifact(part.outputArtifact)
      };
    }
    if (type === "file-change") {
      return {
        type,
        status: app.transcriptExecutionStatus(part.status),
        changes: app.normalizeTranscriptFileChanges(part.changes)
      };
    }
    if (type === "test-result") {
      return {
        type,
        level: String(part.level || "quick").slice(0, 80),
        status: String(part.status || "completed").slice(0, 80),
        command: app.compactActivityText(part.command, 1000),
        failures: (Array.isArray(part.failures) ? part.failures : []).map((failure) => String(failure).slice(0, 1000)).slice(0, 5),
        outputArtifact: app.normalizeTranscriptArtifact(part.outputArtifact)
      };
    }
    if (type === "git-summary") {
      return {
        type,
        branch: String(part.branch || "").slice(0, 300),
        commit: String(part.commit || "").slice(0, 80),
        changedFiles: (Array.isArray(part.changedFiles) ? part.changedFiles : []).map((path) => String(path).slice(0, 1000)).slice(0, 20),
        changedFileCount: Math.max(0, Number(part.changedFileCount || 0) || 0),
        commitChanged: Boolean(part.commitChanged),
        commitBefore: String(part.commitBefore || "").slice(0, 80),
        commitAfter: String(part.commitAfter || "").slice(0, 80)
      };
    }
    if (type === "approval" || type === "interaction") {
      return { type, id: String(part.id || "").slice(0, 200), status: String(part.status || "pending").slice(0, 80) };
    }
    if (type === "status") {
      return {
        type,
        label: String(part.label || "状态").slice(0, 300),
        detail: String(part.detail || "").slice(0, 2000),
        status: String(part.status || "info").slice(0, 80)
      };
    }
    return null;
  };

  app.normalizeTranscriptArtifact = function normalizeTranscriptArtifact(artifact) {
    if (!artifact || typeof artifact !== "object") return null;
    return {
      id: String(artifact.id || "").slice(0, 200),
      label: String(artifact.label || "").slice(0, 300),
      downloadPath: String(artifact.downloadPath || "").slice(0, 2000)
    };
  };

  app.mergeAssistantTimelineAttachments = function mergeAssistantTimelineAttachments(timeline, entry) {
    const incoming = app.dedupeConversationAttachments(entry?.attachments || []);
    if (!incoming.length) return false;
    const entries = Array.isArray(timeline) ? timeline : [];
    const externalKey = String(entry?.externalKey || "").trim();
    const text = String(entry?.text || "").trim();
    const target =
      (externalKey
        ? entries.find((item) => item?.kind === "message" && item.role === "assistant" && item.externalKey === externalKey)
        : null) ||
      [...entries]
        .reverse()
        .find((item) => item?.kind === "message" && item.role === "assistant" && text && String(item.text || "").trim() === text);
    if (!target) return false;
    target.attachments = app.dedupeConversationAttachments([...(target.attachments || []), ...incoming]);
    return true;
  };

  app.appendOperationalTimelineEntries = function appendOperationalTimelineEntries(timeline, job) {
    const seenPlans = new Set(timeline.filter((entry) => entry.kind === "plan").map((entry) => entry.text));
    const seenSystem = new Set();
    const seenTests = new Set();
    const latestItemParts = new Map();
    const latestPlanByTurn = new Map();

    for (const event of job.events || []) {
      const plan = app.planEntryFromEvent(event);
      if (plan?.text) latestPlanByTurn.set(plan.turnId || plan.text, plan);
    }


    for (const event of job.events || []) {
      const part = app.transcriptPartFromEvent(event);
      if (!part) continue;
      const key = part.itemId ? `${part.type}:${part.itemId}` : `${part.type}:${event.id || event.at || timeline.length}`;
      latestItemParts.set(key, {
        kind: "part",
        text: part.text || "",
        parts: [part],
        at: event.at || "",
        eventId: Number(event.id || 0) || 0
      });
    }

    timeline.push(...latestItemParts.values());

    for (const plan of latestPlanByTurn.values()) {
      if (seenPlans.has(plan.text)) continue;
      seenPlans.add(plan.text);
      timeline.push({
        kind: "plan",
        text: plan.text,
        at: plan.at
      });
    }

    for (const event of job.events || []) {
      const system = app.compactionEntryFromEvent(event) || app.recoveryEntryFromEvent(event);
      if (!system?.text || seenSystem.has(system.text)) continue;
      seenSystem.add(system.text);
      timeline.push(system);
    }

    for (const event of job.events || []) {
      const testSummary = app.testSummaryEntryFromEvent(event);
      if (!testSummary?.command) continue;
      const key = [testSummary.turnId, testSummary.command, testSummary.status, testSummary.at].join("\u001f");
      if (seenTests.has(key)) continue;
      seenTests.add(key);
      timeline.push(testSummary);
    }

    for (const approval of job.approvals || []) {
      timeline.push({
        kind: "part",
        parts: [{ type: "approval", id: approval.id, status: approval.status || "pending" }],
        at: approval.createdAt || job.updatedAt || ""
      });
    }

    for (const interaction of job.interactions || []) {
      timeline.push({
        kind: "part",
        parts: [{ type: "interaction", id: interaction.id, status: interaction.status || "pending" }],
        at: interaction.createdAt || job.updatedAt || ""
      });
    }
  };

  app.transcriptPartFromEvent = function transcriptPartFromEvent(event) {
    const raw = event?.raw || {};
    const method = raw.method || event?.type || "";
    const item = raw.params?.item || {};
    if ((method === "item/started" || method === "item/completed") && item.type === "commandExecution") {
      const status = app.transcriptExecutionStatus(item.status, method);
      return {
        type: "command",
        itemId: String(item.id || ""),
        command: app.commandDisplayText(item.command),
        status,
        output: app.boundedTranscriptOutput(item.aggregatedOutput || event.text || ""),
        outputArtifact: item.outputArtifact || null
      };
    }
    if ((method === "item/started" || method === "item/completed") && item.type === "fileChange") {
      return {
        type: "file-change",
        itemId: String(item.id || ""),
        status: app.transcriptExecutionStatus(item.status, method),
        changes: app.normalizeTranscriptFileChanges(item.changes || item.files || [])
      };
    }
    return null;
  };

  app.transcriptExecutionStatus = function transcriptExecutionStatus(value, method = "") {
    const status = String(value || "").toLowerCase();
    if (status.includes("fail") || status.includes("error")) return "failed";
    if (status.includes("cancel")) return "cancelled";
    if (status.includes("success") || status.includes("complete") || method === "item/completed") return "succeeded";
    return "running";
  };

  app.boundedTranscriptOutput = function boundedTranscriptOutput(value, limit = 1200) {
    const text = app.redactActivityText(String(value || "").trim());
    return text.length > limit ? `…${text.slice(-limit)}` : text;
  };

  app.normalizeTranscriptFileChanges = function normalizeTranscriptFileChanges(changes) {
    return (Array.isArray(changes) ? changes : [])
      .map((change) => {
        if (typeof change === "string") return { path: change, changeType: "modified" };
        return {
          path: String(change?.path || change?.file || ""),
          changeType: String(change?.changeType || change?.kind || change?.type || "modified")
        };
      })
      .filter((change) => change.path)
      .slice(0, 20);
  };

  app.sortTimelineEntries = function sortTimelineEntries(timeline) {
    timeline.forEach((entry, index) => {
      if (entry && entry.order === undefined) entry.order = index;
    });
    timeline.sort((a, b) => {
      const left = Date.parse(a.at || "");
      const right = Date.parse(b.at || "");
      if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
      if (!Number.isFinite(left)) return 1;
      if (!Number.isFinite(right)) return -1;
      const leftEventId = Number(a.eventId || 0);
      const rightEventId = Number(b.eventId || 0);
      if (
        Number.isFinite(leftEventId) &&
        Number.isFinite(rightEventId) &&
        leftEventId > 0 &&
        rightEventId > 0 &&
        leftEventId !== rightEventId
      ) {
        return leftEventId - rightEventId;
      }
      return Number(a.order || 0) - Number(b.order || 0);
    });
  };

  app.planEntryFromEvent = function planEntryFromEvent(event) {
    const raw = event.raw || {};
    const item = raw.params?.item;
    if (event.type === "item/completed" && item?.type === "plan") {
      return {
        text: String(item.text || event.text || "").trim(),
        turnId: String(raw.params?.turnId || raw.params?.turn?.id || item.id || "").trim(),
        at: event.at || ""
      };
    }
    if (event.type === "turn/plan/updated") {
      return {
        text: String(event.text || "").trim(),
        turnId: String(raw.params?.turnId || raw.params?.turn?.id || "").trim(),
        at: event.at || ""
      };
    }
    return null;
  };

  app.compactionEntryFromEvent = function compactionEntryFromEvent(event) {
    const itemType = event.raw?.params?.item?.type || "";
    if (event.type === "plan.mode.fallback") {
      return { kind: "system", text: "计划模式已降级为兼容指令", at: event.at || "" };
    }
    if (event.type === "context.compaction.queued") {
      return { kind: "system", text: "上下文压缩已排队", at: event.at || "" };
    }
    if (event.type === "context.compaction.started") {
      return { kind: "system", text: "上下文压缩中", at: event.at || "" };
    }
    if (event.type === "context.compaction.unavailable") {
      return { kind: "system", text: "当前后端暂不支持远程上下文压缩", at: event.at || "" };
    }
    if (event.type === "thread/compacted") {
      return { kind: "system", text: "上下文已压缩", at: event.at || "" };
    }
    if (itemType === "contextCompaction") {
      return { kind: "system", text: "上下文已压缩", at: event.at || "" };
    }
    return null;
  };

  app.recoveryEntryFromEvent = function recoveryEntryFromEvent(event) {
    if (event.type !== "thread.recovered" && event.raw?.method !== "thread/recovered") return null;
    const recovery = event.raw?.recovery && typeof event.raw.recovery === "object" ? event.raw.recovery : {};
    const source = String(recovery.source || "").trim();
    const text =
      source === "echo-session-memory"
        ? "已用 Echo 会话摘要重建上下文"
        : source === "visible-history"
          ? "已用最近可见历史重建上下文"
          : "已在新后端会话中继续";
    return { kind: "system", text, at: event.at || "" };
  };

  app.testSummaryEntryFromEvent = function testSummaryEntryFromEvent(event) {
    const raw = event.raw || {};
    const summary = raw.testSummary || {};
    if (event.type !== "test.summary" && raw.method !== "test.summary") return null;
    const command = String(summary.command || "").trim();
    if (!command) return null;
    const failures = Array.isArray(summary.failures) ? summary.failures.map((line) => String(line || "").trim()).filter(Boolean) : [];
    const status = String(summary.status || "").trim() || "completed";
    const level = String(summary.level || "").trim() || "quick";
    const outputArtifact = summary.outputArtifact && typeof summary.outputArtifact === "object" ? summary.outputArtifact : null;
    const lines = [`${app.testLevelLabel(level)} · ${app.testStatusLabel(status)}`, command, ...failures.slice(0, 5)];
    if (outputArtifact?.downloadPath) lines.push(outputArtifact.downloadPath);
    return {
      kind: "test",
      text: lines.filter(Boolean).join("\n"),
      level,
      status,
      command,
      failures,
      outputArtifact,
      turnId: String(summary.turnId || "").trim(),
      at: event.at || ""
    };
  };

  app.testLevelLabel = function testLevelLabel(level) {
    return {
      quick: "快速检查",
      integration: "集成检查",
      "browser-smoke": "浏览器冒烟",
      e2e: "E2E"
    }[level] || "检查";
  };

  app.testStatusLabel = function testStatusLabel(status) {
    const normalized = String(status || "").toLowerCase();
    if (normalized === "passed") return "通过";
    if (normalized === "failed") return "失败";
    if (normalized === "cancelled") return "已取消";
    return status || "完成";
  };

  app.toggleContextUsageDetails = function toggleContextUsageDetails() {
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    if (!session?.id) return;
    state.contextUsageDetailsOpen = !state.contextUsageDetailsOpen;
    app.refreshContextUsageIndicator?.();
  };

  app.refreshContextUsageDetails = function refreshContextUsageDetails() {
    const line = elements.contextUsageDetailsLine;
    if (!line) return;

    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const entry = app.contextUsageDetailsEntry(session);
    if (!state.contextUsageDetailsOpen || !entry) {
      if (line.hidden && !line.innerHTML && !line.dataset.state) return;
      line.hidden = true;
      line.innerHTML = "";
      line.dataset.state = "";
      line.removeAttribute("title");
      app.syncComposerMetrics?.();
      return;
    }

    line.hidden = false;
    line.dataset.state = entry.state || "normal";
    line.title = entry.title || entry.primary;
    line.innerHTML = `
      <span class="context-usage-details-primary">${app.escapeHtml(entry.primary)}</span>
      <span class="context-usage-details-secondary">
        ${entry.parts.map((part) => `<span class="context-usage-detail-pill">${app.escapeHtml(part)}</span>`).join("")}
      </span>
    `;
    app.syncComposerMetrics?.();
  };

  app.contextUsageDetailsEntry = function contextUsageDetailsEntry(session) {
    if (!session?.id) return null;

    const usage = app.normalizeContextUsage(session.contextUsage) || app.latestContextUsageFromEvents(session.events || []);
    const contextPercent = app.currentContextPercentForSession(session);
    const eventCount = app.sessionEventCount(session);
    const artifactBytes = app.sessionArtifactBytes(session);
    const risk = app.sessionRiskLevel({ contextPercent, eventCount, artifactBytes });
    const primary = app.contextUsagePrimaryLabel(usage, contextPercent, session);
    const parts = [];

    if (usage?.inputTokens) parts.push(`输入 ${app.formatTokenCount(usage.inputTokens)}`);
    if (usage?.cachedInputTokens) parts.push(`缓存 ${app.formatTokenCount(usage.cachedInputTokens)}`);
    if (usage?.outputTokens) parts.push(`输出 ${app.formatTokenCount(usage.outputTokens)}`);
    if (usage?.reasoningOutputTokens) parts.push(`推理 ${app.formatTokenCount(usage.reasoningOutputTokens)}`);
    if (Number.isFinite(eventCount)) parts.push(`${eventCount.toLocaleString("zh-CN")} 事件`);
    const streamLabel = app.sessionStreamStatusLabel(session);
    if (streamLabel) parts.push(`事件流 ${streamLabel}`);
    if (artifactBytes > 0) parts.push(`产物 ${app.formatBytes(artifactBytes)}`);
    const updatedAt = usage?.at || session.lastEvent?.at || "";
    if (updatedAt) parts.push(`更新 ${app.formatRelativeTime(updatedAt)}`);

    return {
      state: risk === "high" ? "risk" : risk === "warn" ? "warn" : "normal",
      primary,
      parts,
      title: [primary, ...parts].filter(Boolean).join("\n")
    };
  };

  app.contextUsagePrimaryLabel = function contextUsagePrimaryLabel(usage, contextPercent, session = null) {
    if (!usage) {
      return app.sessionBackendSupports(session, "contextUsage") ? "上下文暂未同步" : "当前后端暂未提供上下文用量";
    }
    const used = app.formatTokenCount(usage.usedTokens);
    if (usage.limitTokens > 0 && Number.isFinite(contextPercent)) {
      return `上下文 ${contextPercent}% · ${used} / ${app.formatTokenCount(usage.limitTokens)} tokens`;
    }
    return `上下文已同步 · ${used} tokens · 模型窗口未知`;
  };

  app.sessionEventCount = function sessionEventCount(session) {
    const count = Number(session?.metrics?.eventCount ?? session?.eventCount);
    if (Number.isFinite(count) && count >= 0) return count;
    return Array.isArray(session?.events) ? session.events.length : 0;
  };

  app.sessionArtifactBytes = function sessionArtifactBytes(session) {
    const bytes = Number(session?.metrics?.artifactBytes ?? session?.artifactBytes ?? 0);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  };

  app.sessionStreamStatusLabel = function sessionStreamStatusLabel(session) {
    if (!session?.id || session.id !== state.selectedCodexJobId) return "";
    if (!windowRef.EventSource) return "轮询回退";
    if (state.sessionEventSourceId === session.id && state.sessionEventSource) {
      const readyState = Number(state.sessionEventSource.readyState);
      if (readyState === 1) return "SSE 实时";
      if (readyState === 0) return "SSE 连接中";
      return "SSE 重连中";
    }
    if (state.sessionEventReconnectTimer) return "SSE 重连中";
    return "轮询回退";
  };

  app.formatTokenCount = function formatTokenCount(value) {
    const count = Number(value || 0);
    return Number.isFinite(count) ? count.toLocaleString("zh-CN") : "0";
  };

  app.renderSessionStatusRail = function renderSessionStatusRail(session) {
    const rail = elements.sessionStatusRail;
    if (!rail) return;

    const entry = app.sessionStatusRailEntry(session);
    const worktreeActions = app.renderWorktreeRailActions(session, entry);
    if (!entry && !worktreeActions) {
      rail.hidden = true;
      rail.innerHTML = "";
      rail.removeAttribute("title");
      rail.dataset.mode = "";
      rail.dataset.gitState = "";
      rail.dataset.hasCoreState = "";
      return;
    }

    rail.hidden = false;
    rail.dataset.mode = entry?.mode || "";
    rail.dataset.gitState = entry?.gitState || "";
    rail.dataset.hasCoreState = entry ? "true" : "false";
    rail.title = entry?.title || "";
    const gitDetailsOpen = Boolean(entry?.gitSummary && state.gitDetailsOpenSessionId === session?.id);
    rail.innerHTML = `
      <div class="session-status-primary">
        ${
          entry
            ? `
              <span class="session-status-dot" aria-hidden="true"></span>
              <span class="session-status-mode">${app.escapeHtml(entry.modeLabel)}</span>
              <button class="session-status-git" type="button" data-git-details-toggle aria-expanded="${gitDetailsOpen}"${
                entry.gitSummary ? "" : " disabled"
              }>
                <span>${app.escapeHtml(entry.gitLabel)}</span>
                ${entry.gitSummary ? '<span class="session-status-chevron" aria-hidden="true"></span>' : ""}
              </button>
              ${entry.healthLabel ? `<span class="session-status-health">${app.escapeHtml(entry.healthLabel)}</span>` : ""}
              ${entry.refText ? `<span class="session-status-ref">${app.escapeHtml(entry.refText)}</span>` : ""}
            `
            : ""
        }
        ${worktreeActions}
      </div>
      ${gitDetailsOpen ? app.renderSessionGitDetails(entry.gitSummary) : ""}
    `;
  };

  app.renderSessionGitDetails = function renderSessionGitDetails(summary = {}) {
    const turnChanges = summary.changedDuringTurn && typeof summary.changedDuringTurn === "object" ? summary.changedDuringTurn : {};
    const workspaceFiles = Array.isArray(summary.changedFiles) ? summary.changedFiles.map(String) : [];
    const turnFiles = Array.isArray(turnChanges.changedFiles) ? turnChanges.changedFiles.map(String) : [];
    const workspaceCount = Math.max(0, Number(summary.changedFileCount ?? workspaceFiles.length) || 0);
    const turnCount = Math.max(0, Number(turnChanges.changedFileCount ?? turnFiles.length) || 0);
    const files = turnFiles.length ? turnFiles : workspaceFiles;
    const shownFiles = files.slice(0, 12);
    const hiddenCount = Math.max(0, (turnFiles.length ? turnCount : workspaceCount) - shownFiles.length);
    const branch = String(summary.branch || "").trim();
    const commit = app.shortCommit(summary.commit || "");
    const ref = [branch, commit].filter(Boolean).join(" @ ");
    const turnLabel = turnCount > 0 ? `本轮改动 ${turnCount} 个文件` : "本轮未产生 Git 改动";
    return `
      <section class="session-git-details" aria-label="Git 详情">
        <div class="session-git-details-head">
          <strong>${app.escapeHtml(turnLabel)}</strong>
          ${ref ? `<span class="session-status-ref">${app.escapeHtml(ref)}</span>` : ""}
        </div>
        ${
          shownFiles.length
            ? `<ul class="session-git-files">${shownFiles.map((path) => `<li>${app.escapeHtml(path)}</li>`).join("")}</ul>`
            : '<p class="session-git-empty">工作区保持干净。</p>'
        }
        ${hiddenCount > 0 ? `<p class="session-git-more">另有 ${hiddenCount} 个文件</p>` : ""}
        <p class="session-git-workspace">工作区${workspaceCount > 0 ? `共有 ${workspaceCount} 个未提交文件` : "无未提交改动"}</p>
      </section>
    `;
  };

  app.renderWorktreeRailActions = function renderWorktreeRailActions(session, entry) {
    if (!entry || entry.mode !== "worktree" || session?.execution?.ownerType === "orchestration") return "";
    const stateName = String(session?.execution?.lifecycleState || session?.execution?.cleanupState || "").trim().toLowerCase();
    if (stateName === "unavailable") {
      return `
        <span class="session-status-worktree-actions">
          <button class="session-status-action" type="button" data-worktree-recovery="main">改用主工作区</button>
        </span>
      `;
    }
    if (stateName === "failed" && session?.execution?.setupStatus === "failed") {
      return `
        <span class="session-status-worktree-actions">
          <button class="session-status-action" type="button" data-worktree-action="setup">重试设置</button>
          <button class="session-status-action session-status-action-danger" type="button" data-worktree-action="discard">丢弃</button>
        </span>
      `;
    }
    if (!app.canChangeWorktreeSession(session)) return "";
    const disabled = app.sessionHasPendingWork(session) ? " disabled" : "";
    const applyLabel = stateName === "apply-blocked" ? "修复后重试" : "应用";
    return `
      <span class="session-status-worktree-actions">
        <button class="session-status-action" type="button" data-worktree-action="apply"${disabled}>${applyLabel}</button>
        <button class="session-status-action session-status-action-danger" type="button" data-worktree-action="discard"${disabled}>丢弃</button>
      </span>
    `;
  };

  app.handleSessionStatusRailAction = function handleSessionStatusRailAction(event) {
    const target = event.target instanceof Element ? event.target : null;
    const gitToggle = target?.closest("[data-git-details-toggle]");
    if (gitToggle && elements.sessionStatusRail.contains(gitToggle)) {
      event.stopPropagation();
      event.preventDefault();
      const session = state.selectedCodexSession;
      if (!session?.id) return;
      state.gitDetailsOpenSessionId = state.gitDetailsOpenSessionId === session.id ? "" : session.id;
      app.renderSessionStatusRail(session);
      return;
    }
    const recoveryButton = target?.closest("[data-worktree-recovery]");
    if (recoveryButton && elements.sessionStatusRail.contains(recoveryButton)) {
      event.stopPropagation();
      event.preventDefault();
      app.applyWorktreeModePreference(false);
      app.startNewCodexSession();
      app.toast("已新建主工作区任务，请确认内容后发送");
      return;
    }
    const worktreeButton = target?.closest("[data-worktree-action]");
    if (worktreeButton && elements.sessionStatusRail.contains(worktreeButton)) {
      event.stopPropagation();
      event.preventDefault();
      app.requestWorktreeAction(worktreeButton.dataset.worktreeAction).catch((error) => {
        if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
      });
      return;
    }
  };

  app.sessionStatusRailEntry = function sessionStatusRailEntry(session) {
    if (!session?.id) return null;

    const restart = session.restartOperation || {};
    if (["requested", "restarting", "resuming", "failed"].includes(restart.status)) {
      const labels = {
        requested: ["准备重启", "状态已保存"],
        restarting: ["正在重启", "等待新实例上线"],
        resuming: ["已重新连接", "正在恢复对话"],
        failed: ["重启未验证", "Agent 可能已恢复，请查看诊断"]
      };
      const [gitLabel, healthLabel] = labels[restart.status];
      const revision = app.shortCommit(restart.actualRevision || restart.expectedRevision || "");
      return {
        mode: "restart",
        gitState: restart.status === "failed" ? "failed" : "pending",
        modeLabel: "桌面 Agent",
        gitLabel,
        healthLabel,
        refText: revision,
        gitSummary: null,
        title: [gitLabel, healthLabel, restart.error, revision].filter(Boolean).join("\n")
      };
    }

    const execution = session.execution || {};
    const latestGitEvent = app.latestGitSummaryEvent(session.events || []);
    const summary = latestGitEvent?.raw?.gitSummary || {};
    const inWorktree = execution.mode === "worktree";
    if (!inWorktree && !latestGitEvent) return null;

    const changedFiles = Array.isArray(summary.changedFiles) ? summary.changedFiles : null;
    const changedFileCount = Number.isFinite(Number(summary.changedFileCount))
      ? Number(summary.changedFileCount)
      : changedFiles
        ? changedFiles.length
        : null;
    const branch = String(summary.branch || execution.branchName || "").trim();
    const commit = app.shortCommit(summary.commit || execution.baseCommit || "");
    const refText = [branch, commit].filter(Boolean).join(" @ ");
    const lifecycleLabel = app.worktreeLifecycleLabel(execution);
    const gitLabel = Number.isFinite(changedFileCount)
      ? changedFileCount > 0
        ? `Git 变更 ${changedFileCount}`
        : "Git 无变更"
      : app.sessionStatusGitPendingLabel(session);
    const modeLabel = inWorktree ? "隔离 worktree" : "主工作区";
    const errorSummary = String(execution.errorSummary || "").trim();
    const title = [modeLabel, lifecycleLabel, errorSummary, refText].filter(Boolean).join("\n");

    return {
      mode: inWorktree ? "worktree" : "workspace",
      gitState: Number.isFinite(changedFileCount) && changedFileCount > 0 ? "dirty" : Number.isFinite(changedFileCount) ? "clean" : "pending",
      modeLabel,
      gitLabel,
      healthLabel: lifecycleLabel,
      refText,
      gitSummary: latestGitEvent ? summary : null,
      title
    };
  };

  app.worktreeLifecycleLabel = function worktreeLifecycleLabel(execution = {}) {
    const state = String(execution.lifecycleState || execution.cleanupState || "").trim().toLowerCase();
    const labels = {
      creating: "创建中",
      "setting-up": "设置中",
      ready: execution.reused ? "复用中" : "已就绪",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      applied: "已应用",
      discarded: "已丢弃",
      "cleanup-pending": "待清理",
      unavailable: "不可用",
      "apply-blocked": "应用受阻",
      "cleanup-failed": "清理失败"
    };
    if (labels[state]) return labels[state];
    if (execution.discardedAt || execution.cleanupState === "discarded") return "已丢弃";
    if (execution.appliedAt || execution.cleanupState === "applied") return "已应用";
    return "";
  };

  app.canChangeWorktreeSession = function canChangeWorktreeSession(session) {
    const execution = session?.execution || {};
    return Boolean(
      session?.id &&
        execution.mode === "worktree" &&
        execution.ownerType !== "orchestration" &&
        !["applied", "discarded", "unavailable", "cleanup-failed", "cleanup-pending"].includes(String(execution.lifecycleState || "").trim().toLowerCase()) &&
        execution.cleanupState !== "applied" &&
        execution.cleanupState !== "discarded" &&
        !session.archivedAt &&
        !["queued", "starting", "running", "cancelled", "closed", "stale"].includes(session.status)
    );
  };

  app.requestWorktreeAction = async function requestWorktreeAction(action) {
    const session = state.selectedCodexSession;
    const normalized = String(action || "").trim().toLowerCase();
    if (!session?.id || !["setup", "apply", "discard"].includes(normalized) || !app.canChangeWorktreeSession(session)) return;
    const data = await app.apiPost(`/api/codex/sessions/${encodeURIComponent(session.id)}/worktree/${normalized}`, {});
    state.selectedCodexSession = data.session || session;
    app.toast(normalized === "apply" ? "已请求应用 worktree" : normalized === "setup" ? "已请求重新设置 worktree" : "已请求丢弃 worktree");
    app.renderCodexJob(state.selectedCodexSession, { keepSelection: true });
    app.scheduleSessionListRefresh?.({ delayMs: 250 });
  };

  app.sessionHealthEntry = function sessionHealthEntry(session) {
    const metrics = session?.metrics || {};
    const contextPercent = Number(metrics.contextPercent ?? app.currentContextPercentForSession(session));
    const eventCount = Number(metrics.eventCount ?? session?.eventCount ?? 0);
    const artifactBytes = Number(metrics.artifactBytes ?? session?.artifactBytes ?? 0);
    const risk = metrics.risk || app.sessionRiskLevel({ contextPercent, eventCount, artifactBytes });
    if (risk === "normal" && !Number.isFinite(contextPercent) && eventCount < 80 && artifactBytes < 512 * 1024) return null;
    const parts = [];
    if (Number.isFinite(contextPercent)) parts.push(`上下文 ${contextPercent}%`);
    if (eventCount >= 80) parts.push(`${eventCount} 事件`);
    if (artifactBytes > 0) parts.push(app.formatBytes(artifactBytes));
    const label = parts.slice(0, 2).join(" · ") || (risk === "high" ? "会话很长" : "会话偏长");
    return {
      state: risk === "high" ? "risk" : risk === "warn" ? "pending" : "",
      label,
      title: [`会话负载：${risk}`, ...parts].filter(Boolean).join("\n")
    };
  };

  app.currentContextPercentForSession = function currentContextPercentForSession(session) {
    const usage = app.normalizeContextUsage(session?.contextUsage) || app.latestContextUsageFromEvents(session?.events || []);
    if (!usage?.limitTokens || !usage.usedTokens) return null;
    return Math.max(0, Math.min(100, Math.round((usage.usedTokens / usage.limitTokens) * 100)));
  };

  app.sessionRiskLevel = function sessionRiskLevel({ contextPercent = null, eventCount = 0, artifactBytes = 0 } = {}) {
    if (Number(contextPercent) >= 85 || Number(eventCount) >= 160 || Number(artifactBytes) >= 2 * 1024 * 1024) return "high";
    if (Number(contextPercent) >= 70 || Number(eventCount) >= 100 || Number(artifactBytes) >= 768 * 1024) return "warn";
    return "normal";
  };

  app.formatBytes = function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  };

  app.latestGitSummaryEvent = function latestGitSummaryEvent(events) {
    return [...(events || [])].reverse().find((event) => event.type === "git.summary") || null;
  };

  app.sessionStatusGitPendingLabel = function sessionStatusGitPendingLabel(session) {
    if (["queued", "starting", "running"].includes(session.status)) return "运行中";
    return "Git 待更新";
  };

  app.shortCommit = function shortCommit(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.length > 12 ? text.slice(0, 7) : text;
  };

  app.renderConversationEntry = function renderConversationEntry(entry) {
    app.ensureTimelineEntryParts(entry);
    if (entry.kind === "error") {
      return `
        <article class="thread-message thread-message-system">
          <div class="thread-bubble thread-bubble-error">${app.escapeHtml(entry.text)}</div>
        </article>
      `;
    }

    if (entry.kind === "empty") {
      return `
        <div class="thread-welcome">
          <strong>${app.escapeHtml(entry.title)}</strong>
          <p>${app.escapeHtml(entry.body)}</p>
        </div>
      `;
    }

    if (entry.kind === "system") {
      return `
        <div class="thread-status-row">
          <span class="thread-status-pill">${app.escapeHtml(entry.text)}</span>
        </div>
      `;
    }

    if (entry.kind === "plan") {
      return `
        <article class="thread-message thread-message-system">
          <div class="thread-plan-card">
            <div class="thread-plan-card-head">
              <span class="thread-status-pill">计划</span>
              ${entry.at ? `<span class="thread-message-time">${app.escapeHtml(app.formatMessageTime(entry.at))}</span>` : ""}
            </div>
            <div class="thread-plan-card-body">${app.escapeHtml(entry.text)}</div>
          </div>
        </article>
      `;
    }

    if (entry.kind === "test") {
      return app.renderTranscriptPart(entry.parts[0], { at: entry.at });
    }

    if (entry.kind === "part") {
      return (entry.parts || [])
        .map((part) => app.renderTranscriptPart(part, { at: entry.at }))
        .filter(Boolean)
        .join("");
    }

    if (entry.kind === "tool-group") {
      return app.renderToolTranscriptGroup(entry.parts || [], { at: entry.endedAt || entry.at, disclosureAt: entry.at });
    }

    const roleLabel = entry.role === "user" ? "你" : entry.roleLabel || app.conversationAssistantRoleLabel(state.selectedCodexSession || {});
    const roleClass = entry.role === "user" ? "thread-message-user" : "thread-message-assistant";
    const bubbleClass = entry.role === "user" ? "thread-bubble-user" : "thread-bubble-assistant";
    const draftBadge = entry.draft ? '<span class="thread-draft-badge">回复中</span>' : "";
    const timeLabel = entry.at ? app.formatMessageTime(entry.at) : "";
    const attachmentsHtml = app.renderConversationAttachments(entry.attachments || [], { role: entry.role });
    const actionsHtml = entry.text ? app.renderConversationActions() : "";
    const rawMessageId = entry.text ? app.rememberConversationRawMessage(entry) : "";
    const textPart = (entry.parts || []).find((part) => part.type === "text" && part.text);
    const displayText = String(textPart?.text || entry.text || "");
    const renderedText = displayText
      ? app.renderConversationMessageText({ ...entry, text: displayText, draft: Boolean(textPart?.draft || entry.draft) })
      : { html: "", rich: false };
    const richClass = renderedText.rich ? " rich-transcript" : "";
    const rawMessageAttr = rawMessageId ? ` data-raw-message-id="${app.escapeHtml(rawMessageId)}"` : "";
    const structuredPartsHtml = (entry.parts || [])
      .filter((part) => part.type !== "text")
      .map((part) => app.renderTranscriptPart(part, { at: entry.at, role: entry.role }))
      .join("");

    return `
      <article class="thread-message ${roleClass}"${rawMessageAttr}>
        <div class="thread-message-meta">
          <span class="thread-message-role">${app.escapeHtml(roleLabel)}</span>
          ${draftBadge}
          ${timeLabel ? `<span class="thread-message-time">${app.escapeHtml(timeLabel)}</span>` : ""}
        </div>
        ${displayText ? `<div class="thread-bubble ${bubbleClass}${richClass}">${renderedText.html}</div>` : ""}
        ${attachmentsHtml}
        ${actionsHtml}
      </article>
      ${structuredPartsHtml}
    `;
  };

  app.renderConversationMessageText = function renderConversationMessageText(entry) {
    if (entry.role !== "assistant") {
      return { html: app.escapeHtml(entry.text), rich: false };
    }
    const rendered = app.renderAgentMarkdown(entry.text, { draft: entry.draft });
    return { html: rendered.html, rich: !rendered.degraded };
  };

  app.renderTranscriptPart = function renderTranscriptPart(part, options = {}) {
    if (!part || typeof part !== "object") return "";
    if (part.type === "text") {
      const rendered = app.renderConversationMessageText({
        role: options.role || "assistant",
        text: String(part.text || ""),
        draft: Boolean(part.draft)
      });
      return `<div class="thread-bubble thread-bubble-assistant${rendered.rich ? " rich-transcript" : ""}">${rendered.html}</div>`;
    }
    if (part.type === "status") {
      const detail = String(part.detail || "").trim();
      return `
        <div class="thread-status-row">
          <span class="thread-status-pill">${app.escapeHtml(part.label || "状态")}</span>
          ${detail ? `<span class="thread-part-status-detail">${app.escapeHtml(detail)}</span>` : ""}
        </div>
      `;
    }
    if (["command", "file-change", "test-result"].includes(part.type)) {
      return app.renderToolTranscriptGroup([part], options);
    }
    if (part.type === "approval" || part.type === "interaction") {
      return `
        <article class="thread-message thread-message-system thread-decision-entry">
          <div class="thread-decision-anchor" data-transcript-decision="${app.escapeHtml(part.type)}" data-decision-id="${app.escapeHtml(
            part.id || ""
          )}"></div>
        </article>
      `;
    }
    return "";
  };

  app.renderCommandTranscriptPart = function renderCommandTranscriptPart(part, options = {}) {
    return app.renderToolTranscriptGroup([{ ...part, type: "command" }], options);
  };

  app.renderToolTranscriptGroup = function renderToolTranscriptGroup(parts, options = {}) {
    const tools = (Array.isArray(parts) ? parts : []).filter((part) => ["command", "file-change", "test-result"].includes(part?.type));
    if (!tools.length) return "";
    const statuses = tools.map((part) => String(part.status || "succeeded").toLowerCase());
    const status = statuses.includes("failed")
      ? "failed"
      : statuses.some((value) => value === "pending" || value === "running")
        ? "running"
        : statuses.includes("cancelled")
          ? "cancelled"
          : "succeeded";
    const disclosureKey = app.toolDisclosureKey(tools, options);
    return app.renderTranscriptDisclosure({
      type: "tool-group",
      label: tools.length === 1 ? app.toolTranscriptLabel(tools[0]) : `工具活动 ${tools.length} 项`,
      status,
      disclosureKey,
      open: state.expandedToolDisclosureKeys?.has?.(disclosureKey),
      at: options.at,
      details: `<div class="thread-tool-group-list">${tools.map(app.renderToolTranscriptGroupItem).join("")}</div>`
    });
  };

  app.toolTranscriptLabel = function toolTranscriptLabel(part = {}) {
    if (part.type === "command") return "使用终端";
    if (part.type === "file-change") {
      const count = Array.isArray(part.changes) ? part.changes.length : 0;
      return count ? `修改了 ${count} 个文件` : "修改文件";
    }
    if (part.type === "test-result") return `运行${app.testLevelLabel(part.level)}`;
    return "工具活动";
  };

  app.toolDisclosureKey = function toolDisclosureKey(parts = [], options = {}) {
    const sessionId = state.selectedCodexSession?.id || "session";
    const identity = parts.slice(0, 1).map((part) => ({
      type: part.type || "",
      command: part.command || "",
      paths: Array.isArray(part.changes) ? part.changes.map((change) => change.path || "") : [],
      level: part.level || ""
    }));
    return `${sessionId}:${options.disclosureAt || options.at || ""}:${app.hashConversationText(JSON.stringify(identity))}`;
  };

  app.renderToolTranscriptGroupItem = function renderToolTranscriptGroupItem(part) {
    const status = String(part.status || "succeeded");
    let label = "工具活动";
    let details = "";
    let footer = "";
    if (part.type === "command") {
      label = "使用终端";
      const output = String(part.output || "").trim();
      details = `<code class="thread-part-command">${app.escapeHtml(part.command || "后台命令")}</code>${
        output ? `<pre class="thread-part-output">${app.escapeHtml(output)}</pre>` : ""
      }`;
    } else if (part.type === "file-change") {
      const changes = Array.isArray(part.changes) ? part.changes : [];
      label = changes.length ? `修改了 ${changes.length} 个文件` : "修改文件";
      details = changes.length
        ? `<ul class="thread-part-files">${changes.slice(0, 20).map((change) => `<li><span>${app.escapeHtml(change.path || "")}</span><small>${app.escapeHtml(app.fileChangeTypeLabel(change.changeType))}</small></li>`).join("")}</ul>`
        : `<span class="thread-part-empty">文件详情不可用</span>`;
    } else if (part.type === "test-result") {
      label = `运行${app.testLevelLabel(part.level)}`;
      const failures = Array.isArray(part.failures) ? part.failures : [];
      details = `<code class="thread-part-command">${app.escapeHtml(part.command || "检查")}</code>${
        failures.length ? `<div class="thread-test-failures">${failures.slice(0, 5).map((failure) => `<span>${app.escapeHtml(failure)}</span>`).join("")}</div>` : ""
      }`;
    }
    const artifact = part.outputArtifact || {};
    const artifactPath = app.authenticatedResourcePath(artifact.downloadPath || "");
    if (artifactPath) {
      footer = `<a class="thread-test-artifact" href="${app.escapeHtml(artifactPath)}" target="_blank" rel="noreferrer">${app.escapeHtml(artifact.label || "完整输出")}</a>`;
    }
    return `
      <section class="thread-tool-group-item" data-part-type="${app.escapeHtml(part.type)}">
        <header class="thread-tool-group-item-head">
          <span class="thread-part-label">${app.escapeHtml(label)}</span>
          <span class="thread-part-state" data-state="${app.escapeHtml(status)}">${app.escapeHtml(app.transcriptStatusLabel(status))}</span>
        </header>
        ${details}
        ${footer}
      </section>
    `;
  };

  app.renderFileChangeTranscriptPart = function renderFileChangeTranscriptPart(part, options = {}) {
    return app.renderToolTranscriptGroup([{ ...part, type: "file-change" }], options);
  };

  app.renderTestTranscriptPart = function renderTestTranscriptPart(part, options = {}) {
    return app.renderToolTranscriptGroup([{ ...part, type: "test-result" }], options);
  };

  app.renderTranscriptCard = function renderTranscriptCard({ type, label, status, statusLabel = "", at = "", body = "", details = "", footer = "" }) {
    const normalizedStatus = String(status || "idle");
    return `
      <article class="thread-message thread-message-system">
        <section class="thread-part-card thread-part-${app.escapeHtml(type || "status")}" data-part-type="${app.escapeHtml(type || "status")}">
          <header class="thread-part-head">
            <span class="thread-part-label">${app.escapeHtml(label || "状态")}</span>
            <span class="thread-part-state" data-state="${app.escapeHtml(normalizedStatus)}">${app.escapeHtml(
              statusLabel || app.transcriptStatusLabel(normalizedStatus)
            )}</span>
            ${at ? `<span class="thread-message-time">${app.escapeHtml(app.formatMessageTime(at))}</span>` : ""}
          </header>
          ${body ? `<div class="thread-part-body">${body}</div>` : ""}
          ${details ? `<div class="thread-part-details">${details}</div>` : ""}
          ${footer ? `<footer class="thread-part-footer">${footer}</footer>` : ""}
        </section>
      </article>
    `;
  };

  app.renderTranscriptDisclosure = function renderTranscriptDisclosure({ type, label, status, statusLabel = "", at = "", details = "", footer = "", open: requestedOpen, disclosureKey = "" }) {
    const normalizedStatus = String(status || "idle");
    const open = Boolean(requestedOpen);
    const disclosureKeyAttribute = disclosureKey
      ? ` data-tool-disclosure-key="${app.escapeHtml(disclosureKey)}"`
      : "";
    return `
      <article class="thread-message thread-message-system">
        <details class="thread-part-disclosure thread-part-type-${app.escapeHtml(type || "status")}" data-part-type="${app.escapeHtml(
          type || "status"
        )}"${disclosureKeyAttribute}${open ? " open" : ""}>
          <summary class="thread-part-disclosure-summary">
            <span class="thread-part-chevron" aria-hidden="true"></span>
            <span class="thread-part-label">${app.escapeHtml(label || "Agent 活动")}</span>
            <span class="thread-part-state" data-state="${app.escapeHtml(normalizedStatus)}">${app.escapeHtml(
              statusLabel || app.transcriptStatusLabel(normalizedStatus)
            )}</span>
            ${at ? `<span class="thread-message-time">${app.escapeHtml(app.formatMessageTime(at))}</span>` : ""}
          </summary>
          <div class="thread-part-disclosure-body">
            ${details || ""}
            ${footer ? `<footer class="thread-part-footer">${footer}</footer>` : ""}
          </div>
        </details>
      </article>
    `;
  };

  app.transcriptStatusLabel = function transcriptStatusLabel(status) {
    return {
      running: "运行中",
      succeeded: "已完成",
      passed: "通过",
      failed: "失败",
      cancelled: "已取消",
      pending: "等待处理",
      idle: "完成"
    }[String(status || "").toLowerCase()] || String(status || "完成");
  };

  app.fileChangeTypeLabel = function fileChangeTypeLabel(value) {
    const normalized = String(value || "").toLowerCase();
    if (normalized.includes("add") || normalized === "created") return "新增";
    if (normalized.includes("delete") || normalized === "removed") return "删除";
    if (normalized.includes("rename") || normalized === "moved") return "重命名";
    return "修改";
  };

  app.resetConversationRawMessages = function resetConversationRawMessages() {
    state.conversationRawMessages = new Map();
  };

  app.rememberConversationRawMessage = function rememberConversationRawMessage(entry) {
    const text = String(entry?.text || "");
    if (!text) return "";
    if (!state.conversationRawMessages || typeof state.conversationRawMessages.set !== "function") {
      state.conversationRawMessages = new Map();
    }
    const id = app.conversationRawMessageId(entry);
    state.conversationRawMessages.set(id, text);
    return id;
  };

  app.conversationRawMessageId = function conversationRawMessageId(entry) {
    const text = String(entry?.text || "");
    const key = [
      entry?.role || "",
      entry?.externalKey || "",
      entry?.eventId || "",
      entry?.at || "",
      text.length,
      app.hashConversationText(text)
    ].join(":");
    return `msg_${app.hashConversationText(key)}`;
  };

  app.hashConversationText = function hashConversationText(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };

  app.renderConversationActions = function renderConversationActions() {
    return `
      <div class="thread-message-actions" aria-label="消息操作">
        <button class="thread-message-action" type="button" data-thread-action="copy" aria-label="复制消息" title="复制">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 7.5A2.5 2.5 0 0 1 10.5 5h6A2.5 2.5 0 0 1 19 7.5v6A2.5 2.5 0 0 1 16.5 16h-6A2.5 2.5 0 0 1 8 13.5v-6Z" />
            <path d="M6 8.5v7A2.5 2.5 0 0 0 8.5 18h7" />
          </svg>
        </button>
        <button class="thread-message-action" type="button" data-thread-action="edit" aria-label="重新编辑消息" title="重新编辑">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 18.5 6.1 14l8.8-8.8a2.1 2.1 0 0 1 3 3L9.1 17 5 18.5Z" />
            <path d="m13.5 6.6 3 3" />
          </svg>
        </button>
      </div>
    `;
  };

  app.handleConversationAction = function handleConversationAction(event) {
    const target = event.target instanceof Element ? event.target : null;
    const disclosureSummary = target?.closest("details[data-tool-disclosure-key] > summary");
    if (disclosureSummary && elements.codexRunSummary.contains(disclosureSummary)) {
      const disclosure = disclosureSummary.parentElement;
      const key = disclosure?.dataset?.toolDisclosureKey || "";
      if (key) {
        if (disclosure.open) state.expandedToolDisclosureKeys.delete(key);
        else state.expandedToolDisclosureKeys.add(key);
      }
      return;
    }
    const fileLink = target?.closest('a[href^="#echo-workspace-file="]');
    if (fileLink && elements.codexRunSummary.contains(fileLink)) {
      event.preventDefault();
      const encoded = String(fileLink.getAttribute("href") || "").slice("#echo-workspace-file=".length);
      let reference = "";
      try {
        reference = decodeURIComponent(encoded);
      } catch {
        return;
      }
      app.openWorkspaceFileReference?.({
        workspaceId: state.selectedCodexSession?.projectId || app.currentProjectId?.() || "",
        sessionId: state.selectedCodexSession?.id || "",
        targetAgentId: state.selectedCodexSession?.targetAgentId || app.currentTargetAgentId?.() || "",
        executionTarget: state.selectedCodexSession?.execution?.mode === "worktree" ? "session-worktree" : "workspace",
        reference,
        returnFocus: fileLink
      });
      return;
    }
    const button = target?.closest("[data-thread-action]");
    if (!button || !elements.codexRunSummary.contains(button)) return;

    const message = button.closest(".thread-message");
    const rawMessageId = message?.dataset?.rawMessageId || "";
    const text = state.conversationRawMessages?.get(rawMessageId) || message?.querySelector(".thread-bubble")?.textContent || "";
    if (!text) return;

    event.preventDefault();
    const action = button.dataset.threadAction;
    if (action === "copy") {
      app
        .copyTextToClipboard(text)
        .then(() => app.toast("已复制"))
        .catch(() => app.toast("复制失败，请长按选择文本"));
      return;
    }
    if (action === "edit") {
      app.editConversationText(text);
    }
  };

  app.copyTextToClipboard = async function copyTextToClipboard(text) {
    const value = String(text || "");
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
    } catch {}
    if (!app.fallbackCopyText(value)) {
      throw new Error("Clipboard write failed.");
    }
  };

  app.fallbackCopyText = function fallbackCopyText(text) {
    const activeElement = document.activeElement;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    textarea.remove();
    activeElement?.focus?.({ preventScroll: true });
    return copied;
  };

  app.editConversationText = function editConversationText(text) {
    const value = String(text || "");
    elements.codexPrompt.value = value;
    app.syncComposerInputHeight();
    app.updateComposerAvailability();
    elements.codexPrompt.focus({ preventScroll: true });
    try {
      elements.codexPrompt.setSelectionRange(value.length, value.length);
    } catch {}
    app.toast("已放入输入框，可继续编辑");
  };

  app.assistantMessageText = function assistantMessageText(event) {
    const item = event.raw?.params?.item;
    if (event.type === "item/completed" && item?.type === "agentMessage") {
      return app.conversationDisplayText(item.text || event.text, { role: "assistant" });
    }
    if (event.type === "item/completed" && app.assistantMessageAttachments(event).length > 0) {
      return app.conversationDisplayText(event.text || item?.text || "", { role: "assistant" }) || "图片已生成。";
    }
    return "";
  };

  app.assistantMessageEntryFromEvent = function assistantMessageEntryFromEvent(event) {
    const text = app.assistantMessageText(event);
    const attachments = app.assistantMessageAttachments(event);
    if (!text && attachments.length === 0) return null;
    return {
      kind: "message",
      role: "assistant",
      text,
      attachments,
      at: event.at || "",
      eventId: Number(event.id || 0) || 0,
      externalKey: app.assistantMessageExternalKey(event)
    };
  };

  app.assistantMessageExternalKey = function assistantMessageExternalKey(event) {
    const raw = event?.raw || {};
    const params = raw.params || {};
    const item = params.item || {};
    if ((raw.method || event?.type) !== "item/completed") return "";
    const turnId = String(params.turnId || params.turn?.id || "").trim() || "turn";
    const itemId = String(item.id || "").trim();
    return itemId ? `assistant:${turnId}:${itemId}` : "";
  };

  app.userMessageEntryFromEvent = function userMessageEntryFromEvent(event) {
    if (event?.type !== "user.message") return null;
    const text = String(event.text || "").trim();
    const attachments = app.userMessageAttachments(event);
    if (!text && attachments.length === 0) return null;
    return {
      kind: "message",
      role: "user",
      text,
      attachments,
      at: event.at || "",
      eventId: Number(event.id || 0) || 0,
      externalKey: app.userMessageExternalKey(event)
    };
  };

  app.userMessageExternalKey = function userMessageExternalKey(event) {
    const raw = event?.raw || {};
    const commandId = String(raw.commandId || raw.params?.commandId || "").trim();
    if (commandId) return `user:${commandId}`;
    const messageId = String(raw.messageId || raw.params?.messageId || "").trim();
    return messageId ? `user-message:${messageId}` : "";
  };

  app.activeAssistantDraft = function activeAssistantDraft(job, timeline) {
    const streamedDraft = app.conversationDisplayText(app.activeAssistantDraftFromEvents(job.events || []), { role: "assistant" });
    const current = app.conversationDisplayText(job.finalMessage, { role: "assistant" });
    const lastAssistant = app.lastTimelineMessageText(timeline, "assistant");
    if (streamedDraft && current && current !== lastAssistant && current.endsWith(streamedDraft)) return current;
    if (streamedDraft && lastAssistant !== streamedDraft) return streamedDraft;
    if (!current) return "";
    if (lastAssistant === current) return "";
    return current;
  };

  app.activeAssistantDraftFromEvents = function activeAssistantDraftFromEvents(events) {
    const drafts = new Map();
    const completedItems = new Set();
    const completedTurns = new Set();

    for (const event of events || []) {
      const raw = event.raw || {};
      const method = raw.method || event.type || "";
      if (method === "item/completed" && raw.params?.item?.type === "agentMessage") {
        const key = app.assistantEventItemKey(event);
        const turnKey = app.assistantEventTurnKey(event);
        if (key) completedItems.add(key);
        if (turnKey) completedTurns.add(turnKey);
        app.deleteAssistantDraftsForCompletedEvent(drafts, event);
        continue;
      }
      if (method === "turn/completed") {
        const turnKey = app.assistantEventTurnKey(event);
        if (turnKey) completedTurns.add(turnKey);
        app.deleteAssistantDraftsForCompletedEvent(drafts, event);
        continue;
      }
      if (method !== "item/agentMessage/delta") continue;
      const key = app.assistantEventItemKey(event);
      const turnKey = app.assistantEventTurnKey(event);
      if (!key || completedItems.has(key) || (turnKey && completedTurns.has(turnKey))) continue;
      const delta = String(event.text || "");
      if (!delta) continue;
      drafts.set(key, `${drafts.get(key) || ""}${delta}`);
    }

    const latest = Array.from(drafts.values()).filter(Boolean).at(-1) || "";
    return latest.trim();
  };

  app.deleteAssistantDraftsForCompletedEvent = function deleteAssistantDraftsForCompletedEvent(drafts, event) {
    const key = app.assistantEventItemKey(event);
    if (key) drafts.delete(key);
    const turnKey = app.assistantEventTurnKey(event);
    if (!turnKey) return;
    for (const draftKey of Array.from(drafts.keys())) {
      if (app.assistantEventItemKeyMatchesTurn(draftKey, turnKey)) drafts.delete(draftKey);
    }
  };

  app.assistantEventItemKeyMatchesTurn = function assistantEventItemKeyMatchesTurn(itemKey, turnKey) {
    const key = String(itemKey || "");
    const turn = String(turnKey || "");
    return Boolean(key && turn && (key === turn || key.startsWith(`${turn}\u001f`)));
  };

  app.assistantEventItemKey = function assistantEventItemKey(event) {
    const params = event?.raw?.params || {};
    const item = params.item || {};
    const threadId = String(params.threadId || "").trim();
    const turnId = String(params.turnId || params.turn?.id || "").trim();
    const itemId = String(params.itemId || item.id || "").trim();
    if (!threadId && !turnId && !itemId) return "";
    return [threadId, turnId, itemId].join("\u001f");
  };

  app.assistantEventTurnKey = function assistantEventTurnKey(event) {
    const params = event?.raw?.params || {};
    const item = params.item || {};
    const threadId = String(params.threadId || params.thread?.id || item.threadId || "").trim();
    const turnId = String(params.turnId || params.turn?.id || item.turnId || "").trim();
    if (!threadId && !turnId) return "";
    return [threadId, turnId].join("\u001f");
  };

  app.lastTimelineMessageText = function lastTimelineMessageText(timeline, role) {
    const item = [...timeline].reverse().find((entry) => entry.kind === "message" && entry.role === role);
    return item?.text || "";
  };

  app.conversationDisplayText = function conversationDisplayText(value, options = {}) {
    const text = String(value || "").trim();
    if (!text || options.role !== "assistant") return text;
    if (!app.inlineImagePayloadInfo(text)) return text;
    return "图片已生成。";
  };

  app.inlineImagePayloadInfo = function inlineImagePayloadInfo(value) {
    const text = app.stripInlineImageCodeFence(String(value || "").trim());
    if (!text) return null;
    if (/data:image\/[a-z0-9.+_-]+;base64,/i.test(text)) return { kind: "data-url" };
    const payload = app.base64ImagePayloadFromText(text);
    if (!payload) return null;
    const mimeType = app.imageMimeTypeFromBase64Payload(payload.base64);
    return mimeType ? { kind: "base64", mimeType } : null;
  };

  app.stripInlineImageCodeFence = function stripInlineImageCodeFence(value) {
    const text = String(value || "").trim();
    const match = /^```(?:[a-z0-9_-]+)?\s*([\s\S]*?)\s*```$/i.exec(text);
    return match ? match[1].trim() : text;
  };

  app.base64ImagePayloadFromText = function base64ImagePayloadFromText(value) {
    const text = String(value || "").trim();
    const direct = text.replace(/\s+/g, "");
    if (app.isPlausibleBase64Payload(direct)) return { base64: direct };

    const lines = text.split(/\r?\n/);
    let best = null;
    let current = null;
    const finishBlock = () => {
      if (!current) return;
      const base64 = current.lines.join("");
      if (app.isPlausibleBase64Payload(base64) && (!best || base64.length > best.base64.length)) {
        best = { ...current, base64 };
      }
      current = null;
    };

    lines.forEach((line, index) => {
      const compact = line.trim().replace(/\s+/g, "");
      if (/^[a-z0-9+/=]{16,}$/i.test(compact)) {
        current ||= { start: index, end: index, lines: [] };
        current.end = index;
        current.lines.push(compact);
        return;
      }
      finishBlock();
    });
    finishBlock();

    return best;
  };

  app.isPlausibleBase64Payload = function isPlausibleBase64Payload(value) {
    const text = String(value || "");
    if (text.length < 64 || text.length % 4 === 1) return false;
    return /^[a-z0-9+/]+={0,2}$/i.test(text);
  };

  app.imageMimeTypeFromBase64Payload = function imageMimeTypeFromBase64Payload(value) {
    const compact = String(value || "").replace(/\s+/g, "");
    if (!app.isPlausibleBase64Payload(compact)) return "";
    const decoder = globalThis.atob;
    if (typeof decoder !== "function") return "";
    let sample = compact.slice(0, Math.min(compact.length, 160));
    if (sample.length % 4 === 1) sample = sample.slice(0, -1);
    sample += "=".repeat((4 - (sample.length % 4)) % 4);
    let binary = "";
    try {
      binary = decoder(sample);
    } catch {
      return "";
    }
    const bytes = Array.from(binary, (char) => char.charCodeAt(0));
    const ascii = String.fromCharCode(...bytes.slice(0, 64)).trimStart().toLowerCase();
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (ascii.startsWith("gif87a") || ascii.startsWith("gif89a")) return "image/gif";
    if (ascii.startsWith("riff") && ascii.slice(8, 12) === "webp") return "image/webp";
    if (ascii.slice(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii.slice(8, 12))) return "image/avif";
    if (ascii.startsWith("<svg")) return "image/svg+xml";
    return "";
  };

  app.userMessageAttachments = function userMessageAttachments(event) {
    const attachments = Array.isArray(event.raw?.attachments) ? event.raw.attachments : [];
    return app.normalizeConversationAttachments(attachments);
  };

  app.messageAttachments = function messageAttachments(message) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return app.normalizeConversationAttachments(attachments);
  };

  app.assistantMessageAttachments = function assistantMessageAttachments(event) {
    const raw = event?.raw || {};
    const item = raw.params?.item && typeof raw.params.item === "object" ? raw.params.item : {};
    const candidates = [
      ...(Array.isArray(raw.imageArtifacts) ? raw.imageArtifacts : []),
      ...(Array.isArray(item.imageArtifacts) ? item.imageArtifacts : []),
      item.imageArtifact,
      item.artifact,
      raw.imageArtifact,
      raw.artifact
    ];
    return app.dedupeConversationAttachments(candidates.map(app.normalizeConversationImageAttachment).filter(Boolean));
  };

  app.normalizeConversationAttachments = function normalizeConversationAttachments(attachments = []) {
    return app.dedupeConversationAttachments((Array.isArray(attachments) ? attachments : []).map(app.normalizeConversationAttachment).filter(Boolean));
  };

  app.normalizeConversationAttachment = function normalizeConversationAttachment(attachment) {
    if (!attachment || typeof attachment !== "object") return null;
    const mimeType = String(attachment.mimeType || attachment.mime_type || "").trim();
    const downloadPath = String(attachment.downloadPath || attachment.url || "").trim();
    const rawType = String(attachment.type || "").trim().toLowerCase();
    const type = rawType === "image" || mimeType.startsWith("image/") ? "image" : rawType === "file" ? "file" : "";
    if (!type) return null;
    return {
      id: String(attachment.id || "").trim(),
      type,
      name: String(attachment.name || attachment.label || "").trim(),
      mimeType,
      downloadPath,
      sha256: String(attachment.sha256 || "").trim(),
      sizeBytes: Number(attachment.sizeBytes || 0) || 0
    };
  };

  app.normalizeConversationImageAttachment = function normalizeConversationImageAttachment(attachment) {
    if (!attachment || typeof attachment !== "object") return null;
    const mimeType = String(attachment.mimeType || attachment.mime_type || "").trim();
    const kind = String(attachment.kind || "").trim();
    const downloadPath = String(attachment.downloadPath || attachment.url || "").trim();
    if (!downloadPath) return null;
    if (!mimeType.startsWith("image/") && kind !== "assistant_image") return null;
    return {
      id: String(attachment.id || "").trim(),
      type: "image",
      name: String(attachment.name || attachment.label || "图片").trim(),
      mimeType,
      downloadPath,
      sha256: String(attachment.sha256 || "").trim(),
      sizeBytes: Number(attachment.sizeBytes || 0) || 0
    };
  };

  app.dedupeConversationAttachments = function dedupeConversationAttachments(attachments = []) {
    const seen = new Set();
    const deduped = [];
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      if (!attachment || typeof attachment !== "object") continue;
      const id = String(attachment.id || "").trim();
      const downloadPath = String(attachment.downloadPath || attachment.url || "").trim();
      const sha256 = String(attachment.sha256 || "").trim();
      const key = id ? `id:${id}` : downloadPath ? `path:${downloadPath}` : sha256 ? `sha256:${sha256}` : "";
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      deduped.push(attachment);
    }
    return deduped;
  };

  app.dedupeConversationImageAttachments = app.dedupeConversationAttachments;

  app.renderConversationAttachments = function renderConversationAttachments(attachments = [], options = {}) {
    const visibleAttachments = app.dedupeConversationAttachments(attachments);
    if (!visibleAttachments.length) return "";
    const previewImages = options.previewImages ?? options.role !== "user";
    return `
      <div class="thread-attachments">
        ${visibleAttachments
          .map((attachment, index) => {
            const label = app.attachmentDisplayLabel(attachment, index);
            const resourcePath = app.authenticatedResourcePath(attachment?.downloadPath || "");
            const imagePath = attachment?.type === "image" && previewImages ? resourcePath : "";
            if (imagePath) {
              return `
                <a class="thread-attachment-image-link" href="${app.escapeHtml(imagePath)}" target="_blank" rel="noreferrer" aria-label="${app.escapeHtml(label)}">
                  <img class="thread-attachment-image" src="${app.escapeHtml(imagePath)}" alt="${app.escapeHtml(label)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
                  <span class="thread-attachment-image-label">${app.escapeHtml(label)}</span>
                </a>
              `;
            }
            if (resourcePath) {
              return `
                <a class="thread-attachment-pill" href="${app.escapeHtml(resourcePath)}" target="_blank" rel="noreferrer" aria-label="${app.escapeHtml(label)}">
                  <span class="thread-attachment-pill-label">${app.escapeHtml(label)}</span>
                </a>
              `;
            }
            return `
              <div class="thread-attachment-pill">
                <span class="thread-attachment-pill-label">${app.escapeHtml(label)}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  };

  app.attachmentDisplayLabel = function attachmentDisplayLabel(attachment, index = 0) {
    const name = String(attachment?.name || "").trim();
    if (name) return name;
    return attachment?.type === "image" ? `截图 ${index + 1}` : `附件 ${index + 1}`;
  };

  app.jobPreview = function jobPreview(job) {
    const error = job.error || job.lastError || "";
    if (error) return app.humanizeCodexError(error).split("\n")[0].slice(0, 140);
    if (job.finalMessage) return job.finalMessage.slice(0, 140);
    return app.sessionPrompt(job).slice(0, 140);
  };

  app.jobTitle = function jobTitle(job) {
    return app.compactSessionTitle(app.sessionPrompt(job) || job.title || "agent 会话");
  };

  app.sessionPrompt = function sessionPrompt(session) {
    const userMessage = (session.messages || []).find((message) => message.role === "user" && String(message.text || "").trim());
    if (userMessage) return userMessage.text;
    const userEvent = (session.events || []).find((event) => event.type === "user.message");
    return userEvent?.text || session.title || "";
  };

  app.compactSessionTitle = function compactSessionTitle(value) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .replace(/没有办法|没办法/g, "无法")
      .replace(/上下滑动/g, "上下滚动")
      .replace(/这个|那个/g, "")
      .trim();
    if (!normalized) return "agent 会话";

    const sentence =
      normalized
        .split(/[\r\n]+|[。！？!?；;]/)
        .map((part) => part.trim())
        .find(Boolean) || normalized;

    const clause = app.firstTitleClause(sentence) || sentence;
    const cleaned = clause.replace(/^(?:现在|目前|帮我|麻烦|请你|请|顺手|另外|还有|然后|再)\s*/u, "").trim();
    return app.truncateSessionTitle(cleaned || sentence || normalized);
  };

  app.firstTitleClause = function firstTitleClause(text) {
    const separators = [/但是|不过|然后|另外|还有|顺手|同时|并且|而且|以及/u, /[，,：:]/u];
    for (const separator of separators) {
      const match = text.match(separator);
      if (match?.index > 6) return text.slice(0, match.index).trim();
    }
    return text.trim();
  };

  app.truncateSessionTitle = function truncateSessionTitle(text) {
    const compact = String(text || "").trim();
    if (!compact) return "agent 会话";
    return compact.length > 28 ? `${compact.slice(0, 28).trimEnd()}…` : compact;
  };

  app.sessionTime = function sessionTime(session) {
    if (session?.status === "running") {
      const lastLoggedEventMs = app.sessionLastLoggedEventMs?.(session);
      if (lastLoggedEventMs) return new Date(lastLoggedEventMs).toISOString();
    }
    return session.updatedAt || session.completedAt || session.startedAt || session.createdAt;
  };

  app.refreshActiveSessionHeader = function refreshActiveSessionHeader() {
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    const runtime = app.currentRuntimeDraft();
    const parts = [];
    const runtimeLabel = app.sessionRuntimeLabel(runtime);
    if (runtimeLabel) parts.push(runtimeLabel);
    if (session) {
      parts.push(session.archivedAt ? "已归档" : app.statusLabel(session.status));
      parts.push(app.formatRelativeTime(app.sessionTime(session)));
    }
    elements.activeSessionMeta.textContent = parts.filter(Boolean).join(" · ") || "选择权限、模型和推理强度后直接发送。";
    app.refreshComposerMeta();
    app.refreshComposerStatusBar();
    app.updateStopButton?.();
  };

  app.refreshComposerMeta = function refreshComposerMeta() {
    if (!elements.composerActionsMeta) return;
    const session = state.composingNewSession ? null : state.selectedCodexSession;
    if (state.composerBusy) {
      elements.composerActionsMeta.textContent = `${app.activeAgentLabel(session)} 正在处理这一轮消息。`;
      return;
    }
    if (!elements.codexProject.value) {
      elements.composerActionsMeta.textContent = "先在左侧选择工程，再开始对话。";
      return;
    }
    const runtime = app.currentRuntimeDraft();
    const runtimeLabel = app.sessionRuntimeLabel(runtime) || "桌面默认";
    if (session && !app.sessionCanAcceptFollowUp(session)) {
      elements.composerActionsMeta.textContent = `当前会话不可继续，请先从左上角新建会话 · ${runtimeLabel}`;
      return;
    }
    if (app.sessionAwaitsPlanFollowUp?.(session) && !app.sessionHasPendingWork(session)) {
      elements.composerActionsMeta.textContent = `继续当前计划 · ${app.sessionProjectLabel(session?.projectId || elements.codexProject.value)} · ${runtimeLabel}`;
      return;
    }
    const health = app.sessionHealthEntry(session);
    if (health?.state === "risk") {
      const memoryHint = app.canCompactSelectedSession(session) ? "可先压缩上下文" : "可手动新建话题";
      elements.composerActionsMeta.textContent = `会话较长 · ${memoryHint} · ${app.sessionProjectLabel(session?.projectId || elements.codexProject.value, session?.targetAgentId)} · ${runtimeLabel}`;
      return;
    }
    const lead = session ? (app.sessionHasPendingWork(session) ? "继续当前话题，接在这一轮后面" : "继续当前话题") : "发送后创建新话题";
    elements.composerActionsMeta.textContent = `${lead} · ${app.sessionProjectLabel(session?.projectId || elements.codexProject.value, session?.targetAgentId)} · ${runtimeLabel}`;
  };
}
