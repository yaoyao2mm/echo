## Context

Echo is a remote control surface for local Codex. The phone should be able to choose, review, and approve work, but the desktop agent remains the only process that can touch local repositories or resolve local filesystem paths.

The current mobile sidebar mixes project navigation with settings and account controls. It also renders all conversations for the active project inline. As Echo grows toward Skills, plugins, personalization, and richer workspace policy, sidebar density will become a product and usability bottleneck.

## Goals / Non-Goals

**Goals:**

- Let users remove a project from the mobile sidebar without deleting the local project.
- Let users add an existing local directory as an Echo project from mobile through a desktop-mediated browsing and validation flow.
- Keep project conversation previews compact by default, while preserving access to the full conversation list.
- Move settings and personalization controls out of the sidebar into a dedicated mobile settings page.
- Preserve existing workspace allowlist and desktop ownership boundaries.

**Non-Goals:**

- Deleting local directories, repositories, sessions, or worktrees.
- Letting mobile users type arbitrary absolute paths.
- Letting mobile users send arbitrary setup commands, shell commands, or path mutation requests.
- Designing the final Skills or plugin management features.
- Changing the default worktree execution mode.

## Decisions

1. "Remove project" means hide or unpin from Echo mobile, not delete locally.
   - The action SHOULD be labelled so the user does not mistake it for filesystem deletion.
   - Removing the active project MUST select another visible project when available, or enter the empty-project state.
   - Existing sessions and server-side history remain intact and MAY reappear if the project is added or shown again.
   - If the desktop agent continues advertising the same workspace, the relay/mobile visibility preference determines whether it appears in the sidebar.

2. Existing-project import is desktop-mediated.
   - The desktop agent advertises one or more browse roots or import roots that are safe to present on mobile.
   - The mobile client requests directory listings by opaque root id and relative path, not by arbitrary absolute path.
   - The desktop agent validates the chosen directory with realpath checks, workspace policy, and optional project-shape detection before registering it.
   - The relay stores request state and resulting workspace metadata; it does not become the authority on local paths.

3. Directory registration is separate from project creation.
   - "New project" keeps creating a new directory under the desktop-controlled default project location.
   - "Open existing project" or equivalent copy registers a directory that already exists.
   - Both flows result in a workspace entry only after the desktop agent confirms the operation.

4. Conversation previews are bounded by default.
   - The mobile project tree shows at most five conversations per project by default.
   - The user can expand a project to show the full conversation list for that project.
   - The expanded/collapsed state is UI state and should not change session archival or persistence semantics.
   - Counts or affordance copy should make hidden conversations discoverable without rendering all rows upfront.

5. Settings becomes a dedicated second-level page.
   - The sidebar keeps a settings entry point, but detailed controls move into a full-page or route-level settings surface.
   - Existing appearance, account, sync, backend, and preference controls migrate first.
   - Future Skills and plugin management can be added as sections of the settings page without expanding the sidebar.
   - The settings page must preserve mobile ergonomics: reachable from the sidebar, back navigation returns to the workbench, and active sessions remain intact.

## State Model

Add or formalize per-user/project visibility metadata:

- `projectKey` or `{ targetAgentId, workspaceId }`
- `visibleInSidebar`: boolean
- `removedAt` or `hiddenAt`
- `lastSelectedAt`
- optional `source`: `desktop-advertised`, `created`, `registered`

Add workspace-registration command metadata compatible with existing queued desktop command patterns:

- `commandId`, `ownerUser`, `targetAgentId`
- `rootId`, desktop-owned relative `browserPath`
- `status`: queued, leased, succeeded, failed, cancelled
- result workspace metadata returned by desktop after validation
- bounded error message for mobile display

The desktop agent remains authoritative for real local paths.

## Mobile UX

Sidebar structure after this change:

- Project list and project switcher.
- Project actions such as new project, open existing project, remove from sidebar.
- Recent conversations per project, capped to five by default.
- A compact settings entry point that navigates to the dedicated settings page.

Project removal:

- Available from a project row action menu or detail action.
- Requires confirmation that states the local folder will not be deleted.
- Hides the project from the sidebar immediately after success and refreshes the workspace list.

Open existing project:

- Starts from the sidebar project actions.
- Opens a directory browser rooted in desktop-advertised import roots.
- Allows navigation into directories and selecting the current directory.
- Shows validation errors from desktop without exposing raw path internals beyond labels the desktop already advertised.
- Switches to the registered project after success.

Conversation preview:

- Shows the most recent five conversations by default.
- Shows a "more" action when more conversations exist.
- After expansion, renders the full list for that project and provides a way to collapse back to the preview.

Settings page:

- Uses route or page-level navigation rather than an inline sidebar accordion.
- Groups settings into clear sections, starting with current sidebar preferences and account/status controls.
- Leaves visual room for later Skills and plugin management.

## Safety

- Keep `ECHO_CODEX_WORKSPACES` and desktop-advertised workspace policy as the trusted boundary.
- The phone MUST NOT submit raw absolute paths. It can only send opaque root ids and desktop-bounded relative paths from prior directory listings.
- The desktop agent MUST reject symlink/path traversal escapes before registering a selected directory.
- Remove-from-sidebar MUST NOT call filesystem deletion, Git cleanup, or worktree discard APIs.
- Directory listings and validation errors should be bounded and avoid unbounded secret-heavy storage.

## Migration Plan

- Add project visibility defaults so all currently advertised workspaces remain visible.
- Introduce remove-from-sidebar as a reversible visibility preference before adding any destructive project operations.
- Add desktop import-root advertisement and directory registration behind capability checks.
- Move existing sidebar preference UI to the settings page while keeping a sidebar entry point.
- Add conversation preview limiting after project/session grouping is stable.

## Verification

- Run `pnpm run check:js` after touching server, desktop agent, or browser JavaScript.
- Run focused Node/PWA tests for state and rendering behavior.
- Run `pnpm test` for the Node test suite when implementation spans relay, desktop agent, and mobile code.
- Do not run e2e tests unless explicitly requested.
