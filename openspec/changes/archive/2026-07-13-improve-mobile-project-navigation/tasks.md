## 1. Project Visibility

- [x] 1.1 Add per-user project visibility state so a desktop-advertised workspace can be hidden from the mobile sidebar without deleting local files.
- [x] 1.2 Add a mobile remove-from-sidebar action with confirmation copy that clearly says the local folder is not deleted.
- [x] 1.3 Keep removed project sessions and history intact so they can reappear if the project is shown or registered again.
- [x] 1.4 Ensure removing the active project selects the next visible project or enters the empty-project state.

## 2. Open Existing Local Project

- [x] 2.1 Extend desktop capability advertisement with safe project import roots or browse roots.
- [x] 2.2 Add a mobile directory browser flow for selecting an existing directory from desktop-advertised roots.
- [x] 2.3 Add a queued workspace-registration command that sends only target agent id, opaque root id, and desktop-bounded relative path.
- [x] 2.4 Validate selected directories on the desktop with realpath, allowlist, symlink escape, duplicate workspace, and project-shape checks.
- [x] 2.5 Register the validated directory as an Echo workspace and switch mobile to it after success.
- [x] 2.6 Show bounded loading, empty, offline, duplicate, and validation-error states in the import flow.

## 3. Conversation Preview Limit

- [x] 3.1 Render at most five conversations per project by default in the mobile sidebar.
- [x] 3.2 Show a discoverable "show more" action when a project has more than five conversations.
- [x] 3.3 Expand to the full conversation list for that project after user action.
- [x] 3.4 Preserve existing session filters, active-session highlighting, and follow-up behavior when previews are collapsed or expanded.

## 4. Dedicated Settings Page

- [x] 4.1 Add a mobile settings page or route reachable from the sidebar.
- [x] 4.2 Move existing sidebar appearance/preference controls into the settings page.
- [x] 4.3 Move account/status and other non-project controls out of the sidebar where appropriate.
- [x] 4.4 Keep the sidebar focused on projects, project actions, and recent conversations.
- [x] 4.5 Leave section structure for future Skills and plugin management without implementing those managers in this change.

## 5. Verification

- [x] 5.1 Add focused tests for remove-from-sidebar persistence and non-destructive semantics.
- [x] 5.2 Add tests for desktop-mediated existing-project registration, including path escape and duplicate handling.
- [x] 5.3 Add focused mobile tests for conversation preview limit, show-more expansion, and collapse behavior.
- [x] 5.4 Add focused mobile tests for settings page navigation and migrated controls.
- [x] 5.5 Run `pnpm run check:js`.
- [x] 5.6 Run `pnpm test`.
- [x] 5.7 Do not run e2e tests unless explicitly requested.
