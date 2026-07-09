import { installAuth } from "./auth.js?v=132";
import { installCodex } from "./codex.js?v=132";
import { createAppContext, installCore } from "./core.js?v=132";
import { installFiles } from "./files.js?v=132";
import { installOpenSpec } from "./open-spec.js?v=132";
import { installSessions } from "./sessions.js?v=132";

export function createApp(windowRef = window, documentRef = document) {
  const app = createAppContext(windowRef, documentRef);

  installCore(app);
  installAuth(app);
  installSessions(app);
  installCodex(app);
  installFiles(app);
  installOpenSpec(app);

  app.bindEventListeners = function bindEventListeners() {
    const { elements } = app;

    elements.loginForm.addEventListener("submit", app.login);
    elements.logoutButton.addEventListener("click", app.logout);
    elements.openPairingButton.addEventListener("click", () => app.showPairingPanel({ focus: true }));
    elements.refreshStatus.addEventListener("click", app.refreshStatus);
    elements.themeModeToggle?.addEventListener("change", app.toggleThemeMode);
    elements.worktreeModeToggle?.addEventListener("change", app.toggleWorktreeModePreference);
    elements.scanPairingButton.addEventListener("click", app.startPairingScanner);
    elements.stopScanButton.addEventListener("click", app.stopPairingScanner);
    elements.savePairingButton.addEventListener("click", app.pairFromInput);
    elements.refreshCodex?.addEventListener("click", app.refreshCodex);
    elements.newCodexSessionButton.addEventListener("click", app.startNewCodexSession);
    elements.sendCodexButton.addEventListener("click", app.sendToCodex);
    elements.stopCodexTurnButton?.addEventListener("click", app.cancelSelectedCodexTurn);
    elements.composerStatusText?.addEventListener("click", app.toggleTurnActivityDetails);
    elements.contextUsageIndicator?.addEventListener("click", app.toggleContextUsageDetails);
    elements.quickSkillsButton?.addEventListener("click", app.toggleQuickSkillsPanel);
    elements.quickSkillNewButton?.addEventListener("click", app.startNewQuickSkill);
    elements.quickSkillForm?.addEventListener("submit", app.saveQuickSkill);
    elements.quickSkillCancelButton?.addEventListener("click", app.resetQuickSkillForm);
    elements.quickSkillDeleteButton?.addEventListener("click", app.deleteEditingQuickSkill);
    elements.quickSkillTitle?.addEventListener("input", app.updateQuickSkillFormControls);
    elements.quickSkillDescription?.addEventListener("input", app.updateQuickSkillFormControls);
    elements.quickSkillPrompt?.addEventListener("input", app.updateQuickSkillFormControls);
    elements.quickSkillScope?.addEventListener("change", app.updateQuickSkillFormControls);
    elements.quickSkillMode?.addEventListener("change", app.updateQuickSkillFormControls);
    elements.quickSkillRequiresSession?.addEventListener("change", app.updateQuickSkillFormControls);
    elements.composerPlanModeButton?.addEventListener("click", app.toggleComposerPlanMode);
    elements.compactContextButton?.addEventListener("click", () => app.requestContextCompaction({ automatic: false }));
    elements.toggleSessionsButton.addEventListener("click", app.toggleSessionSidebar);
    elements.sessionBackdrop.addEventListener("click", () => {
      if (elements.codexView.classList.contains("open-spec-open")) {
        app.closeOpenSpecPanel?.({ restoreFocus: false });
        return;
      }
      if (elements.codexView.classList.contains("files-open")) {
        app.closeFileBrowser?.({ restoreFocus: false });
        return;
      }
      app.closeSessionSidebar();
    });
    elements.newProjectButton?.addEventListener("click", app.toggleProjectCreateForm);
    elements.projectCreateForm?.addEventListener("submit", app.createProjectFromMobile);
    elements.showActiveSessionsButton.addEventListener("click", () => app.setSessionArchiveView(false));
    elements.showArchivedSessionsButton.addEventListener("click", () => app.setSessionArchiveView(true));
    elements.codexRunSummary.addEventListener("click", app.handleConversationAction);
    elements.sessionStatusRail?.addEventListener("click", app.handleSessionStatusRailAction);
    elements.sidebarUserToggle.addEventListener("click", app.toggleSidebarUserMenu);
    elements.codexProject.addEventListener("change", () => {
      app.selectProject(elements.codexProject.value).catch((error) => {
        if (!app.handleAuthError(error, "当前配对已失效，请重新扫描桌面端二维码。")) {
          app.toast(error.message);
        }
      });
    });
    elements.codexBackend.addEventListener("change", app.handleRuntimeControlChange);
    elements.codexPermissionMode.addEventListener("change", app.handleRuntimeControlChange);
    elements.codexModel.addEventListener("change", app.handleRuntimeControlChange);
    elements.codexReasoningEffort.addEventListener("change", app.handleRuntimeControlChange);
    elements.codexPrompt.addEventListener("input", () => {
      app.syncComposerInputHeight();
      app.updateComposerAvailability();
    });
    elements.composerAttachmentButton.addEventListener("click", app.openComposerAttachmentPicker);
    elements.composerAttachmentInput.addEventListener("change", app.handleComposerAttachmentInput);
    elements.codexPrompt.addEventListener("paste", app.handleComposerPaste);
    document.addEventListener("keydown", app.handleGlobalKeydown);
    document.addEventListener("click", app.handleDocumentClick);
  };

  app.init = async function init() {
    app.applyThemeMode(app.state.themeMode, { persist: false });
    app.bindViewportMetrics();
    app.bindTopbarScrollState();
    app.initRuntimeControls();
    app.bindEventListeners();

    if ("serviceWorker" in navigator) {
      const hadController = Boolean(navigator.serviceWorker.controller);
      let reloadingForUpdate = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || reloadingForUpdate) return;
        reloadingForUpdate = true;
        window.location.reload();
      });
      navigator.serviceWorker.register("/sw.js").then((registration) => registration.update?.()).catch(() => {});
    }

    app.renderComposerAttachments();
    app.updateComposerModeControls?.();
    app.resetQuickSkillForm?.();
    app.refreshWorktreeModeControls?.();
    app.syncComposerInputHeight();
    app.updateSessionSidebarToggle(false);

    await app.bootUserSession();
    app.updateAuthView();
    if (app.isLoggedIn() && app.state.token) {
      await app.bootAuthenticated();
    }
  };

  return app;
}
