import { installAuth } from "./auth.js?v=140";
import { installAgentSkills } from "./agent-skills.js?v=140";
import { installCodex } from "./codex.js?v=140";
import { createAppContext, installCore } from "./core.js?v=140";
import { installDesktopPlugins } from "./desktop-plugins.js?v=140";
import { installFiles } from "./files.js?v=140";
import { installMcp } from "./mcp.js?v=140";
import { installOpenSpec } from "./open-spec.js?v=142";
import { installSessions } from "./sessions.js?v=142";

export function createApp(windowRef = window, documentRef = document) {
  const app = createAppContext(windowRef, documentRef);

  installCore(app);
  installAuth(app);
  installSessions(app);
  installCodex(app);
  installAgentSkills(app);
  installDesktopPlugins(app);
  installFiles(app);
  installOpenSpec(app);
  installMcp(app);

  app.bindEventListeners = function bindEventListeners() {
    const { elements } = app;

    elements.loginForm.addEventListener("submit", app.login);
    elements.logoutButton.addEventListener("click", app.logout);
    elements.openPairingButton.addEventListener("click", () => app.showPairingPanel({ focus: true }));
    elements.refreshStatus.addEventListener("click", app.refreshStatus);
    elements.sidebarPreferencesToggle?.addEventListener("click", app.toggleSidebarPreferences);
    elements.mobileSettingsButton?.addEventListener("click", app.openMobileSettingsPage);
    elements.mobileSettingsCloseButton?.addEventListener("click", () => app.closeMobileSettingsPage({ restoreFocus: true }));
    elements.accountButton?.addEventListener("click", app.toggleAccountPanel);
    elements.accountCloseButton?.addEventListener("click", () => app.closeAccountPanel({ returnToSettings: true }));
    elements.adminButton?.addEventListener("click", app.toggleAdminPanel);
    elements.adminCloseButton?.addEventListener("click", () => app.closeAdminPanel({ returnToSettings: true }));
    elements.adminRefreshButton?.addEventListener("click", app.loadAdmin);
    elements.adminApproveButton?.addEventListener("click", app.approveSelectedAdminUser);
    elements.adminPanel?.addEventListener("click", app.handleAdminClick);
    elements.themeModeToggle?.addEventListener("change", app.toggleThemeMode);
    elements.worktreeModeToggle?.addEventListener("change", app.toggleWorktreeModePreference);
    elements.scanPairingButton.addEventListener("click", app.startPairingScanner);
    elements.stopScanButton.addEventListener("click", app.stopPairingScanner);
    elements.savePairingButton.addEventListener("click", app.pairFromInput);
    elements.refreshCodex?.addEventListener("click", app.refreshCodex);
    elements.newCodexSessionButton.addEventListener("click", app.startNewCodexSession);
    elements.sendCodexButton.addEventListener("click", app.sendToCodex);
    elements.stopCodexTurnButton?.addEventListener("click", app.cancelSelectedCodexTurn);
    elements.contextUsageIndicator?.addEventListener("click", app.toggleContextUsageDetails);
    elements.quickSkillsButton?.addEventListener("click", app.toggleQuickSkillsPanel);
    elements.quickSkillNewGlobalButton?.addEventListener("click", () => app.startNewQuickSkill("global"));
    elements.quickSkillNewProjectButton?.addEventListener("click", () => app.startNewQuickSkill("project"));
    elements.quickSkillForm?.addEventListener("submit", app.saveQuickSkill);
    elements.quickSkillCancelButton?.addEventListener("click", app.resetQuickSkillForm);
    elements.quickSkillDeleteButton?.addEventListener("click", app.deleteEditingQuickSkill);
    elements.quickSkillTitle?.addEventListener("input", app.updateQuickSkillFormControls);
    elements.quickSkillPrompt?.addEventListener("input", app.updateQuickSkillFormControls);
    elements.composerPlanModeButton?.addEventListener("click", app.toggleComposerPlanMode);
    elements.agentSkillsButton?.addEventListener("click", app.toggleAgentSkillsPanel);
    elements.agentSkillButton?.addEventListener("click", app.toggleAgentSkillPanel);
    elements.agentSkillCloseButton?.addEventListener("click", () => app.closeAgentSkillPanel({ returnToSettings: true }));
    elements.agentSkillRefreshButton?.addEventListener("click", app.refreshAgentSkillRegistry);
    elements.agentSkillImportButton?.addEventListener("click", app.toggleAgentSkillImportForm);
    elements.agentSkillImportCancelButton?.addEventListener("click", app.closeAgentSkillImportForm);
    elements.agentSkillImportForm?.addEventListener("submit", app.importAgentSkillFromForm);
    elements.agentSkillImportUrl?.addEventListener("input", app.updateAgentSkillControls);
    elements.desktopPluginButton?.addEventListener("click", app.toggleDesktopPluginPanel);
    elements.desktopPluginCloseButton?.addEventListener("click", () => app.closeDesktopPluginPanel({ returnToSettings: true }));
    elements.desktopPluginRefreshButton?.addEventListener("click", app.refreshDesktopPluginRegistry);
    elements.mcpButton?.addEventListener("click", app.toggleMcpPanel);
    elements.mcpCloseButton?.addEventListener("click", () => app.closeMcpPanel({ returnToSettings: true }));
    elements.mcpRefreshButton?.addEventListener("click", () => app.refreshCodex({ forceMcp: true }));
    elements.mcpApplyButton?.addEventListener("click", app.applySelectedMcpProfile);
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
    elements.openExistingProjectButton?.addEventListener("click", app.openProjectImportPanel);
    elements.projectCreateForm?.addEventListener("submit", app.createProjectFromMobile);
    elements.projectImportCloseButton?.addEventListener("click", () => app.closeProjectImportPanel({ restoreFocus: true }));
    elements.projectImportRefreshButton?.addEventListener("click", () => app.refreshProjectImportDirectory());
    elements.projectImportSelectButton?.addEventListener("click", app.registerProjectImportSelection);
    elements.showActiveSessionsButton.addEventListener("click", () => app.setSessionArchiveView(false));
    elements.showArchivedSessionsButton.addEventListener("click", () => app.setSessionArchiveView(true));
    elements.codexRunSummary.addEventListener("click", app.handleConversationAction);
    elements.sessionStatusRail?.addEventListener("click", app.handleSessionStatusRailAction);
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
    elements.codexMcpProfile?.addEventListener("change", app.handleMcpProfileControlChange);
    elements.codexPrompt.addEventListener("input", () => {
      app.syncComposerInputHeight();
      app.updateComposerAvailability();
    });
    elements.composerAttachmentButton.addEventListener("click", app.openComposerAttachmentPicker);
    elements.composerFileAttachmentButton?.addEventListener("click", app.openComposerFileAttachmentPicker);
    elements.composerAttachmentInput.addEventListener("change", app.handleComposerAttachmentInput);
    elements.composerFileAttachmentInput?.addEventListener("change", app.handleComposerFileAttachmentInput);
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
    if (app.canUseWorkbench()) {
      await app.bootAuthenticated();
    }
  };

  return app;
}
