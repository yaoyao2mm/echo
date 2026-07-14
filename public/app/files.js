export function installFiles(app) {
  const { document, elements, state, window: windowRef } = app;

  app.toggleFileBrowser = async function toggleFileBrowser(event) {
    event?.stopPropagation();
    if (!elements.fileBrowserPanel) return;
    if (elements.fileBrowserPanel.hidden) {
      await app.openFileBrowser();
      return;
    }
    app.closeFileBrowser({ restoreFocus: true });
  };

  app.openFileBrowser = async function openFileBrowser(options = {}) {
    if (!elements.fileBrowserPanel) return;
    if (elements.codexView?.classList.contains("sessions-open")) app.closeSessionSidebar?.({ restoreFocus: false });
    if (elements.codexView?.classList.contains("open-spec-open")) app.closeOpenSpecPanel?.({ restoreFocus: false });
    app.closeProjectSwitcher?.();
    app.closeQuickSkillsPanel?.();
    app.closeAgentSkillsPanel?.();
    app.closeMcpPanel?.();
    app.closeDesktopPluginPanel?.();
    app.setTopbarCollapsed(false);
    if (state.fileBrowserCloseTimer) {
      windowRef.clearTimeout(state.fileBrowserCloseTimer);
      state.fileBrowserCloseTimer = null;
    }
    elements.fileBrowserPanel.hidden = false;
    elements.fileBrowserButton?.setAttribute("aria-expanded", "true");
    elements.sessionBackdrop.hidden = false;
    elements.sessionBackdrop.dataset.layer = "files";
    elements.sessionBackdrop.setAttribute("aria-label", "关闭代码浏览");
    elements.fileBrowserPanel.getBoundingClientRect();
    elements.codexView?.classList.add("files-open");
    app.syncBodySheetState?.();

    if (!options.preserveContext) state.fileBrowserContext = null;
    const projectKey = app.fileBrowserContextKey();
    const projectChanged = state.fileBrowserProjectId !== projectKey;
    if (!state.fileBrowserTree || projectChanged) {
      state.fileBrowserProjectId = projectKey;
      const cachedTree = app.cachedFileBrowserTree(projectKey, "");
      state.fileBrowserTree = cachedTree;
      state.fileBrowserPath = cachedTree?.path || "";
      state.fileBrowserStale = Boolean(cachedTree);
      state.filePreview = null;
      await app.loadFileBrowserPath("", { silent: true });
    } else {
      app.renderFileBrowser();
    }
  };

  app.closeFileBrowser = function closeFileBrowser({ restoreFocus = false } = {}) {
    if (!elements.fileBrowserPanel || elements.fileBrowserPanel.hidden) return;
    elements.fileBrowserButton?.setAttribute("aria-expanded", "false");
    elements.codexView?.classList.remove("files-open");
    app.syncBodySheetState?.();
    elements.sessionBackdrop.hidden = true;
    delete elements.sessionBackdrop.dataset.layer;
    elements.sessionBackdrop.setAttribute("aria-label", "关闭会话列表");
    if (state.fileBrowserCloseTimer) windowRef.clearTimeout(state.fileBrowserCloseTimer);
    state.fileBrowserCloseTimer = windowRef.setTimeout(() => {
      state.fileBrowserCloseTimer = null;
      if (!elements.codexView?.classList.contains("files-open")) elements.fileBrowserPanel.hidden = true;
    }, 220);
    if (restoreFocus && state.fileBrowserReturnPoint) {
      const returnPoint = state.fileBrowserReturnPoint;
      state.fileBrowserReturnPoint = null;
      windowRef.scrollTo?.({ top: returnPoint.scrollY, behavior: "instant" });
      returnPoint.element?.focus?.({ preventScroll: true });
    } else if (restoreFocus) {
      elements.fileBrowserButton?.focus({ preventScroll: true });
    }
  };

  app.openWorkspaceFileReference = async function openWorkspaceFileReference(input = {}) {
    const parsed = app.parseWorkspaceFileReference(input.reference || input.relativePath || "");
    state.fileBrowserContext = {
      workspaceId: String(input.workspaceId || app.currentProjectId() || ""),
      sessionId: String(input.sessionId || ""),
      targetAgentId: String(input.targetAgentId || app.currentTargetAgentId?.() || ""),
      executionTarget: input.executionTarget === "session-worktree" ? "session-worktree" : "workspace"
    };
    state.fileBrowserReturnPoint = {
      element: input.returnFocus || app.document?.activeElement || null,
      scrollY: Number(windowRef.scrollY || 0)
    };
    state.filePreviewLine = parsed.line;
    state.filePreviewLineNotice = "";
    await app.openFileBrowser({ preserveContext: true });
    if (!parsed.path) return;
    const parentPath = parsed.path.split("/").slice(0, -1).join("/");
    await app.loadFileBrowserPath(parentPath, { force: true, context: state.fileBrowserContext });
    const entry = state.fileBrowserTree?.entries?.find((item) => item.path === parsed.path);
    if (entry?.type === "directory") {
      state.filePreviewLine = 0;
      await app.loadFileBrowserPath(parsed.path, { force: true, context: state.fileBrowserContext });
      return;
    }
    await app.readFilePreview(parsed.path, { context: state.fileBrowserContext, line: parsed.line });
  };

  app.parseWorkspaceFileReference = function parseWorkspaceFileReference(value = "") {
    const raw = String(value || "").trim();
    const match = /#L(\d+)$/i.exec(raw);
    return {
      path: app.normalizeClientBrowserPath(match ? raw.slice(0, match.index) : raw),
      line: match ? Math.max(1, Number(match[1]) || 1) : 0
    };
  };

  app.refreshFileBrowser = async function refreshFileBrowser() {
    await app.loadFileBrowserPath(state.fileBrowserPath || "", { force: true });
  };

  app.loadFileBrowserPath = async function loadFileBrowserPath(browserPath = "", options = {}) {
    const context = options.context || state.fileBrowserContext;
    const projectId = context?.workspaceId || app.currentProjectId();
    const targetAgentId = context?.targetAgentId || app.currentTargetAgentId?.() || "";
    const projectKey = app.fileBrowserContextKey(context);
    const normalizedPath = app.normalizeClientBrowserPath(browserPath);
    if (!projectId) {
      app.toast("先选择工程");
      return;
    }
    if (!app.codexCommandsAvailable()) {
      const restored = app.restoreCachedFileBrowserTree(projectKey, normalizedPath);
      if (!restored) {
        if (!options.silent) app.toast(state.codexConnectionState === "error" ? "连接恢复后再浏览" : "桌面 agent 在线后再浏览");
        state.fileBrowserError = state.codexConnectionState === "error" ? "连接中断" : "等待桌面 agent";
      }
      app.renderFileBrowser();
      return;
    }

    const requestSeq = Number(state.fileBrowserRequestSeq || 0) + 1;
    state.fileBrowserRequestSeq = requestSeq;
    state.fileBrowserBusy = true;
    state.fileBrowserError = "";
    state.fileBrowserProjectId = projectKey;
    app.renderFileBrowser();
    try {
      const data = await app.apiPost(
        "/api/codex/files/list",
        {
          projectId,
          targetAgentId,
          sessionId: context?.sessionId || "",
          executionTarget: context?.executionTarget || "workspace",
          path: normalizedPath,
          maxEntries: 240
        },
        { timeoutMs: 42000 }
      );
      if (requestSeq !== state.fileBrowserRequestSeq || projectKey !== app.fileBrowserContextKey()) return;
      state.fileBrowserTree = app.normalizeFileTree(data.tree);
      state.fileBrowserPath = state.fileBrowserTree?.path || "";
      state.fileBrowserStale = false;
      state.filePreview = null;
      app.rememberFileBrowserTree(projectKey, state.fileBrowserTree);
    } catch (error) {
      if (requestSeq !== state.fileBrowserRequestSeq) return;
      const restored = app.restoreCachedFileBrowserTree(projectKey, normalizedPath, { preserveCurrent: true });
      state.fileBrowserError = restored ? "" : error.message;
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。") && !options.silent && !restored) {
        app.toast(error.message);
      }
    } finally {
      if (requestSeq === state.fileBrowserRequestSeq) {
        state.fileBrowserBusy = false;
        app.renderFileBrowser();
      }
    }
  };

  app.readFilePreview = async function readFilePreview(browserPath = "", options = {}) {
    const context = options.context || state.fileBrowserContext;
    const projectId = context?.workspaceId || app.currentProjectId();
    const targetAgentId = context?.targetAgentId || app.currentTargetAgentId?.() || "";
    const projectKey = app.fileBrowserContextKey(context);
    if (!projectId || state.fileBrowserBusy) return;
    if (!app.codexCommandsAvailable()) {
      state.fileBrowserError = state.codexConnectionState === "error" ? "连接中断，恢复后可重试" : "等待桌面 agent，可在线后重试";
      app.renderFileBrowser();
      return;
    }

    const requestSeq = Number(state.fileBrowserRequestSeq || 0) + 1;
    state.fileBrowserRequestSeq = requestSeq;
    state.fileBrowserBusy = true;
    state.fileBrowserError = "";
    state.filePreview = null;
    app.renderFileBrowser();
    try {
      const data = await app.apiPost(
        "/api/codex/files/read",
        {
          projectId,
          targetAgentId,
          sessionId: context?.sessionId || "",
          executionTarget: context?.executionTarget || "workspace",
          path: browserPath,
          maxBytes: 160 * 1024
        },
        { timeoutMs: 42000 }
      );
      if (requestSeq !== state.fileBrowserRequestSeq || projectKey !== app.fileBrowserContextKey()) return;
      state.filePreview = app.normalizeFilePreview(data.file);
      state.filePreviewLine = Math.max(0, Number(options.line ?? state.filePreviewLine) || 0);
    } catch (error) {
      if (requestSeq !== state.fileBrowserRequestSeq) return;
      state.fileBrowserError = error.message;
      if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) app.toast(error.message);
    } finally {
      if (requestSeq === state.fileBrowserRequestSeq) {
        state.fileBrowserBusy = false;
        app.renderFileBrowser();
      }
    }
  };

  app.normalizeFileTree = function normalizeFileTree(tree = {}) {
    if (!tree || typeof tree !== "object") return null;
    return {
      projectId: String(tree.projectId || ""),
      workspace: tree.workspace || {},
      path: app.normalizeClientBrowserPath(tree.path || ""),
      parentPath: app.normalizeClientBrowserPath(tree.parentPath || ""),
      entries: Array.isArray(tree.entries) ? tree.entries.map(app.normalizeFileEntry).filter(Boolean) : [],
      truncated: Boolean(tree.truncated),
      totalEntries: Number(tree.totalEntries || 0) || 0,
      maxEntries: Number(tree.maxEntries || 0) || 0
    };
  };

  app.normalizeFileEntry = function normalizeFileEntry(entry = {}) {
    const name = String(entry.name || "").trim();
    const browserPath = app.normalizeClientBrowserPath(entry.path || name);
    if (!name || !browserPath) return null;
    const type = ["directory", "file", "symlink", "other"].includes(entry.type) ? entry.type : "other";
    return {
      name,
      path: browserPath,
      type,
      size: Number(entry.size || 0) || 0,
      mtime: String(entry.mtime || ""),
      isSymlink: Boolean(entry.isSymlink),
      outsideWorkspace: Boolean(entry.outsideWorkspace),
      previewable: Boolean(entry.previewable)
    };
  };

  app.normalizeFilePreview = function normalizeFilePreview(file = {}) {
    if (!file || typeof file !== "object") return null;
    return {
      projectId: String(file.projectId || ""),
      workspace: file.workspace || {},
      path: app.normalizeClientBrowserPath(file.path || ""),
      name: String(file.name || "").trim(),
      size: Number(file.size || 0) || 0,
      mtime: String(file.mtime || ""),
      content: String(file.content || ""),
      truncated: Boolean(file.truncated),
      bytesRead: Number(file.bytesRead || 0) || 0,
      maxBytes: Number(file.maxBytes || 0) || 0
    };
  };

  app.normalizeClientBrowserPath = function normalizeClientBrowserPath(value = "") {
    return String(value || "")
      .replaceAll("\\", "/")
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part && part !== "." && part !== "..")
      .join("/");
  };

  app.fileBrowserContextKey = function fileBrowserContextKey(context = state.fileBrowserContext) {
    if (context?.workspaceId) return `${context.workspaceId}:${context.sessionId || "workspace"}:${context.executionTarget || "workspace"}`;
    return app.currentWorkspace?.()?.key || app.currentProjectId();
  };

  app.fileBrowserProjectCache = function fileBrowserProjectCache(projectKey) {
    const key = String(projectKey || "").trim();
    if (!key) return null;
    if (!state.fileBrowserTreesByProject || typeof state.fileBrowserTreesByProject !== "object") {
      state.fileBrowserTreesByProject = {};
    }
    if (!state.fileBrowserTreesByProject[key]) state.fileBrowserTreesByProject[key] = {};
    return state.fileBrowserTreesByProject[key];
  };

  app.cachedFileBrowserTree = function cachedFileBrowserTree(projectKey, browserPath = "") {
    const cache = app.fileBrowserProjectCache(projectKey);
    if (!cache) return null;
    return cache[app.normalizeClientBrowserPath(browserPath)] || null;
  };

  app.rememberFileBrowserTree = function rememberFileBrowserTree(projectKey, tree) {
    if (!tree) return;
    const cache = app.fileBrowserProjectCache(projectKey);
    if (!cache) return;
    cache[app.normalizeClientBrowserPath(tree.path || "")] = tree;
  };

  app.restoreCachedFileBrowserTree = function restoreCachedFileBrowserTree(projectKey, browserPath = "", options = {}) {
    const cachedTree = app.cachedFileBrowserTree(projectKey, browserPath);
    if (!cachedTree && !(options.preserveCurrent && state.fileBrowserTree)) return false;
    if (cachedTree) {
      state.fileBrowserTree = cachedTree;
      state.fileBrowserPath = cachedTree.path || "";
      state.filePreview = null;
    }
    state.fileBrowserProjectId = projectKey;
    state.fileBrowserStale = true;
    state.fileBrowserError = "";
    return true;
  };

  app.renderFileBrowser = function renderFileBrowser() {
    if (!elements.fileBrowserPanel) return;

    const workspace =
      app.currentWorkspace?.() ||
      app.workspaceForProjectAndAgent?.(app.currentProjectId(), app.currentTargetAgentId?.() || "") ||
      null;
    const tree = state.fileBrowserTree;
    const title = workspace ? app.workspaceDirectoryName(workspace) : "文件";
    elements.fileBrowserPanel.classList.toggle("has-preview", Boolean(state.filePreview));
    elements.fileBrowserPanel.classList.toggle("is-busy", Boolean(state.fileBrowserBusy));
    elements.fileBrowserPanel.classList.toggle("is-stale", Boolean(state.fileBrowserStale));
    elements.fileBrowserTitle.textContent = title;
    elements.fileBrowserMeta.textContent = workspace ? app.workspaceLabel(workspace) : "等待桌面 agent";
    elements.fileBrowserRefreshButton.disabled = state.fileBrowserBusy || !app.codexCommandsAvailable();

    app.renderFileBrowserBreadcrumbs(tree?.path || state.fileBrowserPath || "");
    app.renderFileBrowserStatus();
    app.renderFileBrowserList();
    app.renderFilePreview();
  };

  app.renderFileBrowserBreadcrumbs = function renderFileBrowserBreadcrumbs(browserPath = "") {
    elements.fileBrowserBreadcrumbs.innerHTML = "";
    const rootButton = app.renderFileBreadcrumbButton("根目录", "");
    elements.fileBrowserBreadcrumbs.append(rootButton);

    const parts = app.normalizeClientBrowserPath(browserPath).split("/").filter(Boolean);
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const separator = document.createElement("span");
      separator.className = "file-browser-separator";
      separator.textContent = "/";
      elements.fileBrowserBreadcrumbs.append(separator, app.renderFileBreadcrumbButton(part, currentPath));
    }
  };

  app.renderFileBreadcrumbButton = function renderFileBreadcrumbButton(label, browserPath) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-browser-crumb";
    button.textContent = label;
    button.title = browserPath || "/";
    button.disabled = state.fileBrowserBusy;
    button.addEventListener("click", () => app.loadFileBrowserPath(browserPath));
    return button;
  };

  app.renderFileBrowserStatus = function renderFileBrowserStatus() {
    if (state.fileBrowserBusy) {
      elements.fileBrowserStatus.textContent = "读取中...";
      return;
    }
    if (state.fileBrowserError) {
      elements.fileBrowserStatus.textContent = state.fileBrowserError;
      return;
    }
    const tree = state.fileBrowserTree;
    if (!tree) {
      elements.fileBrowserStatus.textContent = app.codexCommandsAvailable() ? "打开目录" : "等待桌面 agent";
      return;
    }
    const visible = tree.entries.length;
    const total = tree.totalEntries || visible;
    elements.fileBrowserStatus.textContent = tree.truncated ? `${visible} / ${total} 项` : `${visible} 项`;
  };

  app.renderFileBrowserList = function renderFileBrowserList() {
    elements.fileBrowserList.innerHTML = "";
    const tree = state.fileBrowserTree;
    if (!tree) {
      elements.fileBrowserList.innerHTML = '<div class="file-browser-empty">暂无目录内容。</div>';
      return;
    }
    if (tree.entries.length === 0) {
      elements.fileBrowserList.innerHTML = '<div class="file-browser-empty">这个目录是空的。</div>';
      return;
    }

    for (const entry of tree.entries) {
      elements.fileBrowserList.append(app.renderFileEntryButton(entry));
    }
  };

  app.renderFileEntryButton = function renderFileEntryButton(entry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `file-entry file-entry-${entry.type}`;
    button.dataset.path = entry.path;
    button.disabled = state.fileBrowserBusy || entry.type === "other" || entry.outsideWorkspace;
    button.title = entry.outsideWorkspace ? "指向 workspace 外部，不能打开" : entry.path;
    const meta = entry.type === "directory" ? "目录" : app.fileSizeLabel(entry.size);
    const icon = entry.type === "directory" ? ">" : entry.type === "file" ? "-" : entry.type === "symlink" ? "@" : "?";
    button.innerHTML = `
      <span class="file-entry-icon" aria-hidden="true">${icon}</span>
      <span class="file-entry-copy">
        <strong>${app.escapeHtml(entry.name)}</strong>
        <span>${app.escapeHtml([meta, entry.isSymlink ? "链接" : "", entry.previewable ? "可预览" : ""].filter(Boolean).join(" · "))}</span>
      </span>
    `;
    button.addEventListener("click", () => {
      if (entry.type === "directory") {
        app.loadFileBrowserPath(entry.path);
        return;
      }
      if (entry.type === "file") {
        app.readFilePreview(entry.path);
      }
    });
    return button;
  };

  app.renderFilePreview = function renderFilePreview() {
    const preview = state.filePreview;
    elements.filePreview.hidden = !preview;
    if (!preview) return;
    elements.filePreviewTitle.textContent = preview.name || preview.path;
    const lines = preview.content.split("\n");
    const targetLine = Number(state.filePreviewLine || 0);
    const lineAvailable = targetLine > 0 && targetLine <= lines.length;
    state.filePreviewLineNotice = targetLine > 0 && !lineAvailable ? ` · 无法定位第 ${targetLine} 行` : "";
    elements.filePreviewMeta.textContent = `${app.fileSizeLabel(preview.size)}${preview.truncated ? " · 已截断" : ""}${state.filePreviewLineNotice}`;
    elements.filePreviewContent.innerHTML = "";
    lines.forEach((content, index) => {
      const line = document.createElement("span");
      line.className = `file-preview-line${lineAvailable && index + 1 === targetLine ? " is-target" : ""}`;
      line.dataset.line = String(index + 1);
      line.textContent = content || " ";
      elements.filePreviewContent.append(line);
    });
    if (lineAvailable) {
      windowRef.requestAnimationFrame?.(() => elements.filePreviewContent.querySelector?.(".is-target")?.scrollIntoView?.({ block: "center" }));
    }
    elements.filePreviewInsertButton.disabled = !preview.path;
  };

  app.closeFilePreview = function closeFilePreview() {
    state.filePreview = null;
    app.renderFilePreview();
  };

  app.insertFilePreviewPath = function insertFilePreviewPath() {
    const preview = state.filePreview;
    if (!preview?.path) return;
    app.insertTextAtComposer(`\`${preview.path}\``);
    app.closeFileBrowser({ restoreFocus: false });
    elements.codexPrompt.focus({ preventScroll: true });
  };

  app.insertTextAtComposer = function insertTextAtComposer(text) {
    const input = elements.codexPrompt;
    const insert = String(text || "");
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : input.value.length;
    const prefix = input.value.slice(0, start);
    const suffix = input.value.slice(end);
    const needsLeadingSpace = prefix && !/\s$/.test(prefix);
    const needsTrailingSpace = suffix && !/^\s/.test(suffix);
    input.value = `${prefix}${needsLeadingSpace ? " " : ""}${insert}${needsTrailingSpace ? " " : ""}${suffix}`;
    const cursor = prefix.length + (needsLeadingSpace ? 1 : 0) + insert.length;
    input.setSelectionRange(cursor, cursor);
    app.syncComposerInputHeight();
    app.updateComposerAvailability();
  };

  app.fileSizeLabel = function fileSizeLabel(size) {
    const bytes = Number(size || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  };

  app.updateFileBrowserAvailability = function updateFileBrowserAvailability() {
    if (!elements.fileBrowserButton) return;
    elements.fileBrowserButton.disabled = state.composerBusy || !app.currentProjectId();
    if (!elements.fileBrowserPanel.hidden) app.renderFileBrowser();
  };

  const previousUpdateComposerAvailability = app.updateComposerAvailability;
  app.updateComposerAvailability = function updateComposerAvailabilityWithFiles() {
    previousUpdateComposerAvailability();
    app.updateFileBrowserAvailability();
  };

  const previousHandleDocumentClick = app.handleDocumentClick;
  app.handleDocumentClick = function handleDocumentClickWithFiles(event) {
    previousHandleDocumentClick?.(event);
  };

  const previousHandleGlobalKeydown = app.handleGlobalKeydown;
  app.handleGlobalKeydown = function handleGlobalKeydownWithFiles(event) {
    if (event.key === "Escape" && elements.fileBrowserPanel && !elements.fileBrowserPanel.hidden) {
      event.preventDefault();
      app.closeFileBrowser({ restoreFocus: true });
      return;
    }
    previousHandleGlobalKeydown?.(event);
  };

  const previousSelectProject = app.selectProject;
  app.selectProject = async function selectProjectWithFiles(projectId) {
    const previousProjectId = app.currentWorkspace?.()?.key || app.currentProjectId();
    await previousSelectProject(projectId);
    const nextProjectId = app.currentWorkspace?.()?.key || app.currentProjectId();
    if (previousProjectId !== nextProjectId) {
      state.fileBrowserRequestSeq = Number(state.fileBrowserRequestSeq || 0) + 1;
      state.fileBrowserProjectId = nextProjectId;
      const cachedTree = app.cachedFileBrowserTree(nextProjectId, "");
      state.fileBrowserPath = cachedTree?.path || "";
      state.fileBrowserTree = cachedTree;
      state.fileBrowserStale = Boolean(cachedTree);
      state.filePreview = null;
      state.fileBrowserBusy = false;
      if (elements.fileBrowserPanel && !elements.fileBrowserPanel.hidden) {
        await app.loadFileBrowserPath("", { silent: true });
      }
    }
  };

  elements.fileBrowserButton?.addEventListener("click", app.toggleFileBrowser);
  elements.fileBrowserRefreshButton?.addEventListener("click", app.refreshFileBrowser);
  elements.fileBrowserCloseButton?.addEventListener("click", () => app.closeFileBrowser({ restoreFocus: true }));
  elements.filePreviewCloseButton?.addEventListener("click", app.closeFilePreview);
  elements.filePreviewInsertButton?.addEventListener("click", app.insertFilePreviewPath);

  windowRef.addEventListener("resize", () => {
    if (!elements.fileBrowserPanel?.hidden) app.renderFileBrowser();
  });
}
