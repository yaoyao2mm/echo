## Why

Echo's mobile sidebar has become the main place for project switching, project creation, session history, appearance controls, account state, and miscellaneous settings. That worked while the product surface was small, but it now creates three problems:

- Project management is incomplete: users can create a project, but they cannot remove a project from the mobile sidebar without deleting anything locally.
- Adding an existing local project from the phone is too difficult, even though Echo already has a desktop-mediated file browser that can safely browse local workspace contents.
- Project session history is noisy: a project with many past conversations renders every conversation inline, pushing the project list and primary controls out of the way.

Echo also needs room for future Skills, plugin management, and personalization. A small collapsible sidebar settings area cannot carry that product load. The sidebar should focus on projects and conversations; settings should become a dedicated mobile page similar in spirit to Codex settings.

## What Changes

- Add a mobile action to remove a project from the sidebar/project list without deleting the local directory or repository.
- Add a mobile flow to register an existing local directory as an Echo project by browsing desktop-advertised roots and letting the desktop agent validate the selected directory.
- Cap the number of conversations shown inline under each project, defaulting to five, with an explicit "show more" affordance for the full list.
- Move sidebar preference/settings controls into a dedicated second-level mobile settings page.
- Keep the sidebar focused on project switching, project-level actions, and recent conversations.
- Preserve Echo's safety model: mobile can only choose from desktop-advertised browsing roots and advertised capabilities; it cannot submit arbitrary filesystem paths, shell commands, or deletion requests.

## Capabilities

### Added Capabilities

- `mobile-project-navigation`: Mobile users can manage which desktop-advertised projects appear in the sidebar, add existing local projects through desktop-approved directory browsing, and review bounded conversation previews per project.
- `mobile-settings-page`: Mobile users can open a dedicated settings page for preferences and future management surfaces without overloading the project sidebar.

## Non-Goals

- Do not delete local files, repositories, Git worktrees, or desktop workspace directories from mobile.
- Do not add arbitrary path entry, shell execution, or remote filesystem APIs.
- Do not expose Codex app-server or any local desktop service directly to the public internet.
- Do not implement Skills or plugin management in this change; only provide the settings page structure that can host those surfaces later.
- Do not run e2e tests unless explicitly requested.

## Impact

- Mobile PWA: sidebar project actions, project import flow, conversation preview expansion, and new settings route/page.
- Relay/store: persisted per-user project visibility/pinning state and queued desktop workspace-registration request state.
- Desktop agent: capability advertisement for browsable import roots and validation/registration of selected directories.
- Tests: focused non-e2e tests for project removal semantics, desktop-approved import, conversation preview limits, and settings page navigation.
