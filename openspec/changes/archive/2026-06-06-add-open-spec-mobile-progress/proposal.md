## Why

Echo can already start and monitor Codex sessions from mobile, but project planning artifacts are only visible if the user manually browses files or asks Codex to inspect them. When a workspace uses OpenSpec, the phone should expose the current spec progress directly so the user can review the project story before sending follow-ups or approvals.

## What Changes

- Add a top-right mobile toolbar entry for Open Spec that is visible only when the selected workspace contains an OpenSpec directory.
- Add a read-only mobile Open Spec progress surface that summarizes changes, task completion, proposal context, affected specs, and recent activity in a Linear-style story timeline.
- Add relay and desktop-agent request handling for an Open Spec summary that is generated locally by the desktop agent from the selected allowlisted workspace.
- Parse progress from `tasks.md` Markdown checkboxes and treat proposal/design/spec files as supporting context.
- Preserve the existing Echo safety model: mobile cannot submit arbitrary filesystem paths and cannot edit OpenSpec files in this change.

## Capabilities

### New Capabilities
- `mobile-open-spec-progress`: Mobile users can discover and review OpenSpec progress for the currently selected workspace.

### Modified Capabilities
None.

## Impact

- Frontend: `public/index.html`, `public/app/index.js`, a new PWA module for Open Spec state/rendering, and mobile/workbench styles.
- Relay and desktop agent: new queued request type/API for Open Spec summaries, implemented with the same target-agent/workspace ownership constraints as file browsing.
- Libraries: a new OpenSpec summary parser/reader module with focused unit tests.
- Tests: Node tests for parser behavior, workspace safety, relay/desktop request routing, and PWA rendering/caching. E2E tests remain out of scope unless explicitly requested.
